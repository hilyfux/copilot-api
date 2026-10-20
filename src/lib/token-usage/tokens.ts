/**
 * tokens.ts — the pure token vocabulary shared by every protocol face.
 *
 * Everything here is arithmetic on numbers: no storage, no I/O. It was split out
 * of the fork's SQLite-backed `store.ts` when local usage persistence was removed
 * in favour of writing to agent-gateway, so the normalizers keep their exact
 * behaviour without dragging a database along.
 */

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "provider_messages"
  | "responses"

export interface UsageTokens {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cost?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_nano_aiu?: number | null
  total_tokens?: number | null
}

export function normalizeToken(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

export function normalizeOptionalToken(
  value: number | null | undefined,
): number | undefined {
  return value === null || value === undefined ?
      undefined
    : normalizeToken(value)
}

export function hasAnyToken(tokens: UsageTokens): boolean {
  return (
    normalizeToken(tokens.input_tokens) > 0
    || normalizeToken(tokens.output_tokens) > 0
    || normalizeToken(tokens.cache_read_input_tokens) > 0
    || normalizeToken(tokens.cache_creation_input_tokens) > 0
    || normalizeToken(tokens.total_tokens) > 0
    || normalizeToken(tokens.total_nano_aiu) > 0
  )
}

export function resolveTotalTokens(input: UsageTokens): number {
  const explicitTotal = normalizeOptionalToken(input.total_tokens)
  if (explicitTotal !== undefined) {
    return explicitTotal
  }
  return (
    normalizeToken(input.input_tokens)
    + normalizeToken(input.output_tokens)
    + normalizeToken(input.cache_read_input_tokens)
    + normalizeToken(input.cache_creation_input_tokens)
  )
}
