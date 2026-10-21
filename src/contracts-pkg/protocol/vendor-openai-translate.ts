/**
 * Anthropic ⇄ OpenAI (chat/completions) translation — the load-forwarding shim
 * (2026-09-17, Phase 3b).
 *
 * Ported from byok-api `src/protocol/anthropic-openai.ts` (+ the SSE framing of
 * `anthropic-openai-stream.ts`), kept SELF-CONTAINED (no cross-repo imports) so
 * codex-api can, when its upstream account pool is overloaded/exhausted,
 * translate a downstream Anthropic `/v1/messages` request into an OpenAI
 * chat/completions call to a third-party vendor (DeepSeek), then translate the
 * response back to the Anthropic wire shape.
 *
 * v1 simplification (deliberately safer than incremental streaming translation,
 * see load-forward.ts): the vendor is called NON-streaming; the full OpenAI
 * completion is translated to a complete Anthropic Message, then — only if the
 * downstream client asked for `stream:true` — replayed as a well-formed Anthropic
 * SSE sequence (message_start → content_block_* → message_delta → message_stop).
 * No incremental deltas from the vendor; the fallback path does not chase them.
 *
 * Scope: text + images (request) + tools (both directions) + usage. Pure
 * functions, unit-tested. Model mapping is done by the caller (rule.vendorModel).
 *
 * TODO(responses/openai downstream): this module only covers the Anthropic
 * `/v1/messages` surface. A `/v1/responses` or `/v1/chat/completions` downstream
 * load-forward path would need its own request/response mapping — out of v1 scope.
 */
import { normalizeToolCallPairing } from './chat-tool-pairing.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

// ─────────────────────────── Request: Anthropic → OpenAI ───────────────────────────

/** Flatten an Anthropic content value (string | block[]) into OpenAI content. */
function anthropicContentToOpenAI(content: Json): Json {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: Json[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') parts.push({ type: 'text', text: String(block.text ?? '') })
    else if (block.type === 'image' && block.source?.type === 'base64') {
      parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } })
    }
  }
  // Collapse a single text part to a plain string (what most vendors expect).
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

/** Convert one Anthropic message into zero+ OpenAI messages (tool_result blocks
 *  become separate role:'tool' messages). */
function anthropicMessageToOpenAI(msg: Json): Json[] {
  const out: Json[] = []
  const content = msg?.content
  if (Array.isArray(content)) {
    const toolCalls: Json[] = []
    const textParts: Json[] = []
    const toolResults: Json[] = []
    /** thinking 文本单独收口 —— 不再混进 textParts 被下面的白名单丢掉（那正是
     *  让 `content` 变成空数组 [] 的原因）。见函数尾 reasoning_content 的说明。 */
    const thinkingParts: string[] = []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })
      } else if (block?.type === 'thinking' && msg.role === 'assistant' && typeof block.thinking === 'string') {
        thinkingParts.push(block.thinking)
      } else if (block?.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((b: Json) => (b?.type === 'text' ? b.text : '')).join('') : ''
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: resultText })
      } else {
        // text / everything else we can't map (thinking, images handled by
        // anthropicContentToOpenAI) → keep as a content block; unmappable blocks
        // degrade to '' rather than crashing.
        textParts.push(block)
      }
    }
    // thinking 也算「这一轮有内容」—— 只有 thinking 的 assistant 轮要**保留**，
    // 不能整轮丢掉（丢一轮会给 vendor 一段缺了上下文的对话）。
    const hasAssistantTurn = toolCalls.length > 0 || textParts.length > 0 || thinkingParts.length > 0
    if (msg.role === 'assistant' && hasAssistantTurn) {
      const m: Json = { role: 'assistant', content: textParts.length ? anthropicContentToOpenAI(textParts) : '' }
      if (toolCalls.length) m.tool_calls = toolCalls
      // thinking 模型（DeepSeek deepseek-flash 等）：带 tool_calls 的 assistant 消息
      // **必须回传 reasoning_content**，否则 HTTP 400
      //   "The `reasoning_content` in the thinking mode must be passed back to the API."
      // 真实 key 实测三种补法：不补 → 400；空串 → 200；真实文本 → 200。
      // 有 thinking 文本就用它（保真），没有就给空串（够用、且不制造假思维内容）。
      //
      // 刻意**不**在响应方向合成 thinking 块：空串已证明能让下一轮通过，而无签名的
      // thinking 块有破坏客户端解析的风险 —— 实测结论直接免掉了那一整块。
      // （生产走 native 直传路径时 thinking 本就是原生的，不受此处影响。）
      if (toolCalls.length > 0 || thinkingParts.length > 0) m.reasoning_content = thinkingParts.join('\n')
      out.push(m)
    } else if (textParts.length > 0) {
      out.push({ role: msg.role, content: anthropicContentToOpenAI(textParts) })
    }
    out.push(...toolResults)
  } else {
    out.push({ role: msg?.role ?? 'user', content: anthropicContentToOpenAI(content) })
  }
  return out
}

/** Anthropic tools[] → OpenAI tools[] (undefined when none / unusable). */
function anthropicToolsToOpenAI(tools: Json): Json {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object' } } }))
}

function translateToolChoice(tc: Json): Json {
  if (tc?.type === 'auto') return 'auto'
  if (tc?.type === 'any') return 'required'
  if (tc?.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } }
  return 'auto'
}

/**
 * Translate a full Anthropic `/v1/messages` request body → OpenAI chat body.
 * `vendorModel` OVERRIDES `body.model` (the operator maps the vendor's own
 * model id in the forwarding rule). The vendor is always called non-streaming in
 * v1, so `stream` is forced false regardless of what the downstream asked for.
 */
export function anthropicToOpenAIRequest(body: Json, vendorModel: string): Json {
  const messages: Json[] = []
  if (body?.system) {
    const sys = typeof body.system === 'string' ? body.system
      : Array.isArray(body.system) ? body.system.map((b: Json) => (b?.type === 'text' ? b.text : '')).join('\n') : ''
    if (sys) messages.push({ role: 'system', content: sys })
  }
  for (const m of (Array.isArray(body?.messages) ? body.messages : [])) messages.push(...anthropicMessageToOpenAI(m))

  // 每条 assistant.tool_calls 紧跟每个 id 的 tool 消息；缺的补占位、孤儿转文本（2026-10-12，见 chat-tool-pairing.ts）。
  // 典型触发：Claude Code 把 tool_result 和 <system-reminder> 文字放在同一条 user 消息里 → 上面会把文字排在 tool 前面。
  const out: Json = { model: vendorModel, messages: normalizeToolCallPairing(messages).messages, stream: false }
  if (typeof body?.max_tokens === 'number') out.max_tokens = body.max_tokens
  if (typeof body?.temperature === 'number') out.temperature = body.temperature
  if (typeof body?.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body?.stop_sequences)) out.stop = body.stop_sequences
  const tools = anthropicToolsToOpenAI(body?.tools)
  if (tools && tools.length > 0) out.tools = tools
  if (body?.tool_choice) out.tool_choice = translateToolChoice(body.tool_choice)
  return out
}

// ─────────────────────────── Response: OpenAI → Anthropic ───────────────────────────

function mapFinishReason(fr: string | null | undefined): string {
  switch (fr) {
    case 'length': return 'max_tokens'
    case 'tool_calls': return 'tool_use'
    case 'stop': return 'end_turn'
    default: return 'end_turn'
  }
}

export type ForwardUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** Pull token usage from an OpenAI (chat completion) payload. Zeros when absent.
 *  DeepSeek reports prompt-cache hits via `prompt_tokens_details.cached_tokens`
 *  (OpenAI-compatible); `prompt_cache_hit_tokens` is DeepSeek's older field. */
export function extractOpenAIUsage(oai: Json): ForwardUsage {
  const u = (oai && typeof oai === 'object' ? oai.usage : null) ?? {}
  const prompt = Number(u.prompt_tokens) || 0
  const completion = Number(u.completion_tokens) || 0
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0
  const cacheRead = Math.min(cached, prompt)
  return {
    inputTokens: prompt - cacheRead,
    outputTokens: completion,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
  }
}

export type AnthropicMessageResult = {
  message: Json
  usage: ForwardUsage
  stopReason: string
}

/** OpenAI chat-completion (non-stream) → Anthropic Messages response.
 *  `fallbackModel` is echoed as `message.model` when the vendor omits one — the
 *  caller passes the DOWNSTREAM requested model so the client never sees the
 *  vendor's internal id (operator: 「不要告诉用户降档了」). */
export function openAIToAnthropicResponse(oai: Json, fallbackModel: string): AnthropicMessageResult {
  const choice = oai?.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const content: Json[] = []
  if (typeof msg.content === 'string' && msg.content.length > 0) content.push({ type: 'text', text: msg.content })
  for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
    let input: Json = {}
    try { input = JSON.parse(tc.function?.arguments || '{}') } catch { input = {} }
    content.push({ type: 'tool_use', id: tc.id ?? `call_${content.length}`, name: tc.function?.name ?? 'tool', input })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  const usage = extractOpenAIUsage(oai)
  const stopReason = mapFinishReason(choice.finish_reason)
  return {
    message: {
      id: typeof oai?.id === 'string' && oai.id ? oai.id : 'msg_fwd',
      type: 'message',
      role: 'assistant',
      // Echo the downstream-requested model, NOT the vendor id.
      model: fallbackModel,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage.inputTokens + usage.cacheReadTokens,
        output_tokens: usage.outputTokens,
        ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
      },
    },
    usage,
    stopReason,
  }
}

// ─────────────────────────── Anthropic Message → SSE frames ───────────────────────────

function sse(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Replay a COMPLETE Anthropic Message as a well-formed Anthropic SSE sequence.
 * Used only when the downstream asked for `stream:true` — the vendor was called
 * non-streaming, so this emits the whole content in one delta per block (clients
 * accept the accumulated form). Order: message_start → per-block
 * (content_block_start → *_delta → content_block_stop) → message_delta
 * (stop_reason + usage) → message_stop.
 */
export function anthropicMessageToSSE(result: AnthropicMessageResult): string {
  const { message, usage, stopReason } = result
  const frames: string[] = []
  frames.push(sse('message_start', {
    type: 'message_start',
    message: {
      id: message.id, type: 'message', role: 'assistant', model: message.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.inputTokens + usage.cacheReadTokens, output_tokens: 0, ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}) },
    },
  }))
  const blocks: Json[] = Array.isArray(message.content) ? message.content : []
  blocks.forEach((block, index) => {
    if (block?.type === 'tool_use') {
      frames.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }))
      frames.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }))
      frames.push(sse('content_block_stop', { type: 'content_block_stop', index }))
    } else if (block?.type === 'thinking') {
      // 原生 Anthropic 端点回传的思考块（DeepSeek /anthropic）：按 Anthropic 扩展思考 SSE
      // 形状回放——thinking_delta 携思考文本，signature_delta 携签名，客户端才认。
      frames.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }))
      frames.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(block?.thinking ?? '') } }))
      if (typeof block?.signature === 'string' && block.signature) {
        frames.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }))
      }
      frames.push(sse('content_block_stop', { type: 'content_block_stop', index }))
    } else {
      frames.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      frames.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(block?.text ?? '') } }))
      frames.push(sse('content_block_stop', { type: 'content_block_stop', index }))
    }
  })
  frames.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.outputTokens } }))
  frames.push(sse('message_stop', { type: 'message_stop' }))
  return frames.join('')
}
