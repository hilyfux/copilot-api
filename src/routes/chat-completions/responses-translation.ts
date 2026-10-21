/**
 * chat.completions ⇄ responses translation for Copilot models that GitHub
 * serves ONLY on `/responses` (upstream answers `/chat/completions` with 400
 * `unsupported_api_for_model` — all gpt-5.x / gpt-6 / grok-4.5 models).
 *
 * The repo already translates Anthropic ⇄ Responses (routes/messages) and
 * Responses ⇄ Anthropic (routes/responses), but nothing spoke OpenAI Chat
 * Completions to the Responses API, so this file is new. It is a pure
 * protocol mapper — no I/O — and the handler decides when to use it (see
 * lib/copilot-upstream-path.ts).
 *
 * Request: system/developer prefix → `instructions` (later ones stay in order
 * as developer messages, so a mid-conversation system note does not rewrite
 * the cached prefix every turn), user parts → input_text / input_image /
 * input_file, assistant text → output_text message, assistant tool_calls →
 * function_call items, tool messages → function_call_output, function tools /
 * tool_choice / response_format / reasoning_effort / token limit mapped.
 * Unmappable chat knobs (n, stop, logprobs, penalties, seed) are dropped —
 * the Responses API has no equivalent and rejects unknown fields.
 *
 * Response: output_text → message.content, function_call → tool_calls,
 * reasoning summary → reasoning_text, status → finish_reason, usage →
 * prompt/completion tokens (cached tokens preserved).
 *
 * Stream: Responses SSE events → `chat.completion.chunk` frames; the handler
 * appends the terminal `[DONE]`.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Delta,
  Message,
} from "~/lib/types/chat-completions"
import type {
  FunctionTool,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseUsage,
  Reasoning,
  ResponsesTextFormat,
} from "~/lib/types/responses"

type FinishReason = ChatCompletionResponse["choices"][number]["finish_reason"]

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
}

function toInputContent(part: ContentPart): ResponseInputContent | null {
  switch (part.type) {
    case "text": {
      return { type: "input_text", text: part.text }
    }
    case "image_url": {
      return {
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail ?? "auto",
      }
    }
    case "file": {
      return {
        type: "input_file",
        file_data: part.file.file_data,
        ...(part.file.filename ? { filename: part.file.filename } : {}),
      }
    }
    default: {
      return null
    }
  }
}

function userContent(
  content: Message["content"],
): string | Array<ResponseInputContent> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map(toInputContent)
    .filter((part): part is ResponseInputContent => part !== null)
}

function translateMessages(messages: ReadonlyArray<Message>): {
  instructions: string | null
  input: Array<ResponseInputItem>
} {
  const instructionParts: Array<string> = []
  const input: Array<ResponseInputItem> = []
  let inPrefix = true

  for (const message of messages) {
    const isSystem = message.role === "system" || message.role === "developer"
    if (isSystem && inPrefix) {
      const text = textOf(message.content)
      if (text) instructionParts.push(text)
      continue
    }
    inPrefix = false

    switch (message.role) {
      case "system":
      case "developer": {
        input.push({
          type: "message",
          role: "developer",
          content: textOf(message.content),
        })
        break
      }
      case "user": {
        input.push({
          type: "message",
          role: "user",
          content: userContent(message.content),
        })
        break
      }
      case "assistant": {
        const text = textOf(message.content)
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          })
        }
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments || "{}",
          })
        }
        break
      }
      case "tool": {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id ?? "",
          output: textOf(message.content),
        })
        break
      }
      default: {
        break
      }
    }
  }

  return {
    instructions:
      instructionParts.length > 0 ? instructionParts.join("\n\n") : null,
    input,
  }
}

function translateTools(
  tools: ChatCompletionsPayload["tools"],
): Array<FunctionTool> | null {
  if (!Array.isArray(tools) || tools.length === 0) return null
  return tools
    .filter((tool) => tool.type === "function")
    .map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      // Chat tools are non-strict unless asked; Responses defaults strict to
      // true, which would reject ordinary (non-strict) JSON schemas.
      strict: tool.function.strict ?? false,
      parameters: tool.function.parameters,
      ...(tool.function.description ?
        { description: tool.function.description }
      : {}),
    }))
}

function translateToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] | undefined {
  if (!choice) return undefined
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

function translateResponseFormat(
  format: unknown,
): ResponsesTextFormat | undefined {
  if (!format || typeof format !== "object") return undefined
  const f = format as {
    type?: string
    json_schema?: {
      name?: string
      schema?: Record<string, unknown>
      strict?: boolean
      description?: string
    }
  }
  if (f.type === "json_object") return { type: "json_object" }
  if (f.type === "text") return { type: "text" }
  if (f.type === "json_schema" && f.json_schema?.schema) {
    return {
      type: "json_schema",
      name: f.json_schema.name ?? "response",
      schema: f.json_schema.schema,
      ...(f.json_schema.strict !== undefined ?
        { strict: f.json_schema.strict }
      : {}),
      ...(f.json_schema.description ?
        { description: f.json_schema.description }
      : {}),
    }
  }
  return undefined
}

/** Upstream Responses API floor for max_output_tokens. */
export const RESPONSES_MIN_OUTPUT_TOKENS = 16

export function translateChatToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const { instructions, input } = translateMessages(payload.messages)
  const tools = translateTools(payload.tools)
  const maxOutput = payload.max_completion_tokens ?? payload.max_tokens
  const effort = payload.reasoning_effort
  const format = translateResponseFormat(payload.response_format)

  const out: ResponsesPayload = {
    model: payload.model,
    input,
    instructions,
    stream: payload.stream ?? false,
    store: false,
  }
  if (typeof payload.temperature === "number") {
    out.temperature = payload.temperature
  }
  if (typeof payload.top_p === "number") out.top_p = payload.top_p
  if (typeof maxOutput === "number" && maxOutput > 0) {
    // Responses API rejects max_output_tokens < 16 (live 400 2026-10-21); a
    // chat client asking for fewer still gets an answer instead of an error.
    out.max_output_tokens = Math.max(RESPONSES_MIN_OUTPUT_TOKENS, maxOutput)
  }
  if (tools && tools.length > 0) {
    out.tools = tools
    // Copilot /responses rejects tool_choice when no tools are present.
    const toolChoice = translateToolChoice(payload.tool_choice)
    if (toolChoice) out.tool_choice = toolChoice
    if (typeof payload.parallel_tool_calls === "boolean") {
      out.parallel_tool_calls = payload.parallel_tool_calls
    }
  }
  if (typeof effort === "string" && REASONING_EFFORTS.has(effort)) {
    out.reasoning = { effort: effort as NonNullable<Reasoning["effort"]> }
  }
  if (format) out.text = { format }
  if (
    typeof payload.prompt_cache_key === "string"
    && payload.prompt_cache_key
  ) {
    out.prompt_cache_key = payload.prompt_cache_key
  }
  return out
}

// ── response (non-stream) ──────────────────────────────────────────────────

type ChatUsage = NonNullable<ChatCompletionResponse["usage"]>

export function translateResponsesUsageToChat(
  usage: ResponseUsage | null | undefined,
): ChatUsage | undefined {
  if (!usage) return undefined
  const prompt = usage.input_tokens
  const completion = usage.output_tokens ?? 0
  const cached = usage.input_tokens_details?.cached_tokens
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens || prompt + completion,
    ...(typeof cached === "number" ?
      { prompt_tokens_details: { cached_tokens: cached } }
    : {}),
  }
}

function messageText(item: ResponseOutputItem): string {
  if (item.type !== "message") return ""
  return (item.content ?? [])
    .map((block) => {
      if (block.type === "output_text" && typeof block.text === "string") {
        return block.text
      }
      if (block.type === "refusal" && typeof block.refusal === "string") {
        return block.refusal
      }
      return ""
    })
    .join("")
}

function reasoningText(item: ResponseOutputItem): string {
  if (item.type !== "reasoning") return ""
  return (item.summary ?? [])
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n")
}

function finishReasonFor(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): FinishReason {
  if (hasToolCalls) return "tool_calls"
  if (status === "incomplete") {
    return incompleteReason === "content_filter" ? "content_filter" : "length"
  }
  return "stop"
}

export function translateResponsesResultToChatCompletion(
  result: ResponsesResult,
  fallbackModel: string,
): ChatCompletionResponse {
  let content = ""
  let reasoning = ""
  const toolCalls: NonNullable<
    ChatCompletionResponse["choices"][number]["message"]["tool_calls"]
  > = []

  for (const item of result.output) {
    content += messageText(item)
    const r = reasoningText(item)
    if (r) reasoning = reasoning ? `${reasoning}\n${r}` : r
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      })
    }
  }

  const usage = translateResponsesUsageToChat(result.usage)
  return {
    id: `chatcmpl-${result.id}`,
    object: "chat.completion",
    created: result.created_at || Math.floor(Date.now() / 1000),
    model: result.model || fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || (toolCalls.length > 0 ? null : ""),
          ...(reasoning ? { reasoning_text: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReasonFor(
          result.status,
          result.incomplete_details?.reason,
          toolCalls.length > 0,
        ),
      },
    ],
    ...(usage ? { usage } : {}),
    ...(result.copilot_usage ? { copilot_usage: result.copilot_usage } : {}),
  }
}

// ── stream ─────────────────────────────────────────────────────────────────

export interface ChatStreamState {
  id: string
  created: number
  model: string
  includeUsage: boolean
  roleSent: boolean
  finished: boolean
  /** output_index → chat tool_call index */
  toolIndexByOutput: Map<number, number>
  /** output_index → whether any argument delta was streamed */
  argsStreamed: Set<number>
  nextToolIndex: number
}

export function createChatStreamState(
  model: string,
  options: { includeUsage?: boolean } = {},
): ChatStreamState {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    created: Math.floor(Date.now() / 1000),
    model,
    includeUsage: options.includeUsage ?? false,
    roleSent: false,
    finished: false,
    toolIndexByOutput: new Map(),
    argsStreamed: new Set(),
    nextToolIndex: 0,
  }
}

function chunk(
  state: ChatStreamState,
  delta: Delta,
  finishReason: FinishReason | null = null,
): ChatCompletionChunk {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  }
}

function withRole(state: ChatStreamState, delta: Delta): Delta {
  if (state.roleSent) return delta
  state.roleSent = true
  return { role: "assistant", ...delta }
}

/** An error the stream must surface to the client before `[DONE]`. */
export interface ChatStreamError {
  error: { message: string; type: string; code?: string | null }
}

export type ChatStreamOutput = ChatCompletionChunk | ChatStreamError

export function translateResponsesEventToChatChunks(
  event: ResponseStreamEvent,
  state: ChatStreamState,
): Array<ChatStreamOutput> {
  switch (event.type) {
    case "response.created": {
      state.id = `chatcmpl-${event.response.id}`
      state.created = event.response.created_at || state.created
      state.model = event.response.model || state.model
      return [chunk(state, withRole(state, { content: "" }))]
    }
    case "response.output_text.delta": {
      if (!event.delta) return []
      return [chunk(state, withRole(state, { content: event.delta }))]
    }
    case "response.reasoning_summary_text.delta": {
      if (!event.delta) return []
      return [chunk(state, withRole(state, { reasoning_text: event.delta }))]
    }
    case "response.output_item.added": {
      if (event.item.type !== "function_call") return []
      const index = state.nextToolIndex++
      state.toolIndexByOutput.set(event.output_index, index)
      return [
        chunk(
          state,
          withRole(state, {
            tool_calls: [
              {
                index,
                id: event.item.call_id,
                type: "function",
                function: { name: event.item.name, arguments: "" },
              },
            ],
          }),
        ),
      ]
    }
    case "response.function_call_arguments.delta": {
      const index = state.toolIndexByOutput.get(event.output_index)
      if (index === undefined || !event.delta) return []
      state.argsStreamed.add(event.output_index)
      return [
        chunk(state, {
          tool_calls: [{ index, function: { arguments: event.delta } }],
        }),
      ]
    }
    case "response.output_item.done": {
      // Some upstreams deliver the full arguments only on `done`.
      if (event.item.type !== "function_call") return []
      const index = state.toolIndexByOutput.get(event.output_index)
      if (
        index === undefined
        || state.argsStreamed.has(event.output_index)
        || !event.item.arguments
      ) {
        return []
      }
      state.argsStreamed.add(event.output_index)
      return [
        chunk(state, {
          tool_calls: [
            { index, function: { arguments: event.item.arguments } },
          ],
        }),
      ]
    }
    case "response.completed":
    case "response.incomplete": {
      if (state.finished) return []
      state.finished = true
      const out: Array<ChatStreamOutput> = [
        chunk(
          state,
          {},
          finishReasonFor(
            event.response.status,
            event.response.incomplete_details?.reason,
            state.nextToolIndex > 0,
          ),
        ),
      ]
      const usage = translateResponsesUsageToChat(event.response.usage)
      if (state.includeUsage && usage) {
        out.push({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: state.model,
          choices: [],
          usage,
        })
      }
      return out
    }
    case "response.failed": {
      state.finished = true
      return [
        {
          error: {
            message:
              event.response.error?.message ?? "Upstream response failed",
            type: "api_error",
            code: event.response.error?.code ?? null,
          },
        },
      ]
    }
    case "error": {
      state.finished = true
      return [
        {
          error: {
            message: event.error?.message ?? event.message,
            type: event.error?.type ?? "api_error",
            code: event.error?.code ?? event.code,
          },
        },
      ]
    }
    default: {
      return []
    }
  }
}
