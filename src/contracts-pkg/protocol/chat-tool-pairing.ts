/**
 * chat/completions 工具调用配对归一化——负载转发（DeepSeek 兜底）两条翻译入口共用的最后一道整理。
 *
 * 厂商硬规则（DeepSeek 原文 400：`An assistant message with 'tool_calls' must be followed by tool
 * messages responding to each 'tool_call_id'`；以及 `Messages with role 'tool' must be a response
 * to a preceding message with 'tool_calls'`）：
 *   1. 带 tool_calls 的 assistant 后面紧跟每个 id 的 tool 消息，中间不夹别的角色、不缺；
 *   2. tool 消息必须属于前面某条 tool_calls；
 *   3. 思考型模型（deepseek-flash 等）带 tool_calls 的 assistant 必须带 reasoning_content（空串即可，实测 200）。
 *
 * 客户端历史经常不满足：并行调用被拆成多条、用户打断留下没结果的调用、压缩后只剩结果、tool_result 和
 * 文字在同一条消息里。这里一次性归位：
 *   - 同 id 的 tool 消息从后面提到 tool_calls 紧后（只在下一条 tool_calls 之前找）；
 *   - 找不到结果的补占位 `(no output)`；
 *   - 找不到主人的 tool 消息改成普通 user 文本（内容保留，模型仍看得到）；
 *   - 缺 reasoning_content 的补空串。
 * 2026-10-12 azure：/v1/responses 兜底 7 次 400 全是规则 1。移植自 byok-api chat-tool-pairing.ts
 * （2026-09-22 已在 byok 验证），本仓多了孤儿处理与 reasoning_content。纯函数，输入不变。
 */

type Rec = Record<string, unknown>

export const MISSING_TOOL_OUTPUT = '(no output)'

function toolCallIds(msg: Rec): string[] {
  if (msg['role'] !== 'assistant' || !Array.isArray(msg['tool_calls'])) return []
  const ids: string[] = []
  for (const tc of msg['tool_calls'] as unknown[]) {
    const id = tc && typeof tc === 'object' ? (tc as Rec)['id'] : undefined
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

export type PairingRepairs = { reordered: number; placeholders: number; orphans: number }

/** 归位 + 补占位 + 孤儿转文本；返回新数组与修补计数（计数用于可观测日志）。 */
export function normalizeToolCallPairing(messages: readonly Rec[]): { messages: Rec[]; repairs: PairingRepairs } {
  const repairs: PairingRepairs = { reordered: 0, placeholders: 0, orphans: 0 }
  const out: Rec[] = []
  const consumed = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue
    const msg = messages[i]!
    const ids = toolCallIds(msg)
    if (ids.length === 0) {
      if (msg['role'] === 'tool') {
        // 主人不在（或在它后面）：不能当 tool 发，改成普通文本保留内容。
        repairs.orphans++
        const id = typeof msg['tool_call_id'] === 'string' ? msg['tool_call_id'] : '?'
        out.push({ role: 'user', content: `[tool result ${id}]\n${typeof msg['content'] === 'string' ? msg['content'] : JSON.stringify(msg['content'] ?? '')}` })
      } else {
        out.push(msg)
      }
      continue
    }
    out.push(typeof msg['reasoning_content'] === 'string' ? msg : { ...msg, reasoning_content: '' })
    const found = new Map<string, Rec>()
    for (let j = i + 1; j < messages.length && found.size < ids.length; j++) {
      if (consumed.has(j)) continue
      const m = messages[j]!
      if (toolCallIds(m).length > 0) break
      const tid = m['tool_call_id']
      if (m['role'] === 'tool' && typeof tid === 'string' && ids.includes(tid) && !found.has(tid)) {
        found.set(tid, m)
        consumed.add(j)
        if (j !== i + found.size) repairs.reordered++
      }
    }
    for (const id of ids) {
      const hit = found.get(id)
      if (hit) out.push(hit)
      else { repairs.placeholders++; out.push({ role: 'tool', tool_call_id: id, content: MISSING_TOOL_OUTPUT }) }
    }
  }
  return { messages: out, repairs }
}
