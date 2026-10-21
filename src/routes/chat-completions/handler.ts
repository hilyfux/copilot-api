import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { resolveMappedModel } from "~/lib/config"
import {
  chatNeedsResponses,
  isUnsupportedApiForModel,
} from "~/lib/copilot-upstream-path"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel, toCopilotUpstreamModelId } from "~/lib/models"
import { writeSSEIfConnected } from "~/lib/sse"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import { admitCopilotModel } from "~/policy/model-admission"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import { handleChatViaResponses } from "./via-responses"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  // Same contract as the Messages route: model is required, and model mapping
  // assumes a string, so an absent one must be answered rather than thrown.
  if (typeof payload.model !== "string" || payload.model.trim() === "") {
    return c.json(
      {
        error: {
          type: "invalid_request_error",
          message: "model is required",
        },
      },
      400,
    )
  }
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  // Gateway model catalog + routing strategy (agent-gateway mig 171): a
  // model that is not enabled is refused here, with no upstream round trip.
  const admission = admitCopilotModel(requestedModel)
  if (!admission.ok) return c.json(admission.body, admission.status)
  if (admission.model !== requestedModel) payload.model = admission.model

  debugJson(logger, "Request payload:", payload)

  const selectedModel = findEndpointModel(payload.model)
  payload.model = selectedModel?.id ?? toCopilotUpstreamModelId(payload.model)

  if (
    isNullish(payload.max_tokens)
    && isNullish(payload.max_completion_tokens)
  ) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  if (payload.model.includes("gpt")) {
    if (isNullish(payload.max_completion_tokens)) {
      payload.max_completion_tokens = payload.max_tokens
    }
    delete payload.max_tokens
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  const viaResponses = () =>
    handleChatViaResponses(c, payload, { requestId, sessionId, recordUsage })

  // GitHub serves gpt-5.x / gpt-6 / grok-4.5 only on /responses and answers
  // /chat/completions with 400 unsupported_api_for_model. Decided from the
  // upstream model metadata first (lib/copilot-upstream-path.ts).
  if (chatNeedsResponses(payload.model, selectedModel)) {
    return await viaResponses()
  }

  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(payload, {
      clientSignal: c.req.raw.signal,
      requestId,
      sessionId,
    })
  } catch (error) {
    // Stale/missing metadata safety net: retry ONCE through Responses.
    if (await isUnsupportedApiError(error)) {
      logger.warn(
        `chat/completions rejected ${payload.model} as unsupported_api_for_model; retrying once via /responses`,
      )
      return await viaResponses()
    }
    throw error
  }

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    for await (const chunk of response) {
      debugJson(logger, "Streaming chunk:", chunk)
      const parsedChunk = parseChatCompletionChunk(chunk)
      if (parsedChunk?.usage || parsedChunk?.copilot_usage) {
        usage = {
          ...normalizeOpenAIUsage(parsedChunk.usage),
          total_nano_aiu: normalizeOptionalToken(
            parsedChunk.copilot_usage?.total_nano_aiu,
          ),
        }
      }
      await writeSSEIfConnected(stream, chunk as SSEMessage)
    }

    recordUsage(usage)
  })
}

async function isUnsupportedApiError(error: unknown): Promise<boolean> {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }
  try {
    return isUnsupportedApiForModel(await error.response.clone().text())
  } catch {
    return false
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
