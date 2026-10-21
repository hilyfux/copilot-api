/**
 * Serve a /v1/chat/completions request through Copilot's Responses API, for
 * models GitHub exposes only on `/responses` (see lib/copilot-upstream-path).
 *
 * Non-stream: one Responses call → one `chat.completion`.
 * Stream: Responses SSE → `chat.completion.chunk` frames, ending `[DONE]`; an
 * upstream failure mid-stream becomes an `{"error":…}` frame before `[DONE]`
 * (the stream has already sent 200, so the status cannot change).
 *
 * Transport is HTTP on purpose: the chat face has no WebSocket session
 * semantics to preserve, and the translator keys tool calls by output_index
 * so it never depends on the WS id fix-ups the native /responses face needs.
 */
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { createHandlerLogger, debugJson } from "~/lib/logger"
import { writeSSEIfConnected } from "~/lib/sse"
import {
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { isAsyncIterable } from "~/lib/utils"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

import {
  createChatStreamState,
  translateChatToResponsesPayload,
  translateResponsesEventToChatChunks,
  translateResponsesResultToChatCompletion,
} from "./responses-translation"

const logger = createHandlerLogger("chat-completions-via-responses")

export const chatViaResponsesDependencies = {
  createResponses: createCopilotResponses,
}

function parseEvent(chunk: unknown): ResponseStreamEvent | null {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") return null
  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

export async function handleChatViaResponses(
  c: Context,
  payload: ChatCompletionsPayload,
  options: {
    requestId: string
    sessionId: string
    recordUsage: (usage: UsageTokens) => void
  },
): Promise<Response> {
  const responsesPayload = translateChatToResponsesPayload(payload)
  debugJson(logger, "Translated chat → responses payload:", responsesPayload)
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)

  const response = await chatViaResponsesDependencies.createResponses(
    responsesPayload,
    {
      vision,
      initiator,
      requestId: options.requestId,
      sessionId: options.sessionId,
      clientSignal: c.req.raw.signal,
      transport: "http",
    },
  )

  if (!payload.stream || !isAsyncIterable(response)) {
    const result = response as ResponsesResult
    options.recordUsage({
      ...normalizeResponsesUsage(result.usage),
      total_nano_aiu: normalizeOptionalToken(
        result.copilot_usage?.total_nano_aiu,
      ),
    })
    return c.json(
      translateResponsesResultToChatCompletion(result, payload.model),
    )
  }

  const state = createChatStreamState(payload.model, {
    includeUsage: payload.stream_options?.include_usage === true,
  })

  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const iterator = response[Symbol.asyncIterator]()
    try {
      for await (const raw of { [Symbol.asyncIterator]: () => iterator }) {
        const event = parseEvent(raw)
        if (!event) continue
        if (
          event.type === "response.completed"
          || event.type === "response.incomplete"
          || event.type === "response.failed"
        ) {
          usage = {
            ...normalizeResponsesUsage(event.response.usage),
            total_nano_aiu: normalizeOptionalToken(
              event.copilot_usage?.total_nano_aiu,
            ),
          }
        }
        for (const out of translateResponsesEventToChatChunks(event, state)) {
          if (
            !(await writeSSEIfConnected(stream, { data: JSON.stringify(out) }))
          ) {
            return
          }
        }
      }
      await writeSSEIfConnected(stream, { data: "[DONE]" })
    } finally {
      await iterator.return?.()
      options.recordUsage(usage)
    }
  })
}
