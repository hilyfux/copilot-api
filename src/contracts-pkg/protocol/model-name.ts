/**
 * 模型名归一化 —— 契约包（P4，2026-10-16）。
 *
 * 正文逐字取自 codex-api `src/protocol/routing.ts`（2026-10-16）开头的归一化函数段
 * （sanitizeModelName → normalizeModelBase）。routing.ts 其余部分依赖 `anthropic-types`，
 * 不是契约，不进包。所有权：契约包（gateway 仓），codex 会话是维护者（设计 §7.1）。
 *
 * 用途：分类器、策略规则匹配（strategy/resolve.ts）、窗口画像共用同一个「这是不是同一个
 * 模型」口径。改正文 = 契约包升 CONTRACT_VERSION + 各仓 sync。
 */

// Strip ANSI CSI escape sequences (e.g. \x1b[1m bold codes that Claude Code
// accidentally appends to model names when reading from styled terminal output).
export function sanitizeModelName(name: string): string {
  return name
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // ANSI CSI with ESC byte (e.g. \x1b[1m)
    .replace(/\[[0-9;]+[A-Za-z]\]?/g, '')   // bare bracket remnant after ESC stripped (e.g. [1m] or [1m)
    .trim()
}

// Like sanitizeModelName but PRESERVES the `[1m]` context-window suffix. The base
// sanitizer's second regex is meant for bare ANSI CSI remnants, but it also eats
// the model suffix `[1m]` — so sanitizeModelName MUST NOT be used for the model id
// echoed back to the client (message_start.model). Claude Code is F5-gated behind
// a proxy and only grants a 1M window for a model id matching /\[1m\]/; echoing a
// base id (suffix stripped) made CC drop to 200K mid-session (2026-06-23). Use this
// keep-suffix variant for any model id surfaced back to the downstream client.
export function sanitizeModelNameKeepSuffix(name: string): string {
  return name
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // ANSI CSI with ESC byte only — NOT the [1m] suffix
    .trim()
}

/**
 * Canonicalize a "display label" style model id into the dashed form the tier
 * rules understand. Clients that let users pick a model from a list sometimes
 * send the LABEL, not the id (2026-09-04 azure: `[Opus 5.1]` from a Vercel edge
 * app → 403 "not a Claude model"). Handled here, in the ONE normalizer every
 * classifier/mapper shares, so `[Opus 5.1]`, `Claude Opus 5.1`, `"opus 5"` all
 * reach the opus tier like `claude-opus-5-1` does. Pure string work:
 *   - strip wrapping brackets / parens / quotes
 *   - collapse whitespace runs to `-`
 * The `[1m]` context suffix never reaches here: sanitizeModelName strips it first.
 */
export function canonicalizeModelAlias(name: string): string {
  return name
    .trim()
    .replace(/^[\[\("'`\s]+|[\]\)"'`\s]+$/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
}

function normalizeModelName(name: string): string {
  return canonicalizeModelAlias(sanitizeModelName(name))
}

/**
 * Does this Claude-side id name a SPECIFIC version (`claude-opus-5-1`,
 * `[Opus 5.1]`, `claude-sonnet-9`) rather than a bare family alias (`opus`,
 * `sonnet[1m]`, `Claude Opus`, `default`)?
 *
 * Operator rule (2026-09-05): an unversioned alias may be allocated the tier
 * default; a versioned id MUST exist (catalog / strategy rule) — a made-up
 * version must never be served silently on some other model, or the user
 * believes they are talking to a model that does not exist. Dated snapshots of
 * a known base are handled by the classifier before this question matters.
 */
export function isVersionedClaudeAlias(name: string | null | undefined): boolean {
  const n = name ? normalizeModelName(name) : ''
  if (!n) return false
  // a dash-separated token that starts with a digit = a version component
  return /(^|-)\d/.test(n)
}

/** Canonical base id of a (possibly dated) Claude model: sanitize + lowercase + strip a
 *  trailing `-YYYYMMDD` snapshot suffix. The ONE home for the "dated snapshot = same base
 *  model" rule — classification (below) and window-profile's 1M-capability lookup both use
 *  it, so a new suffix convention is learned in one place. */
export function normalizeModelBase(name: string): string {
  // `claude-<family>-<N>-0` is the same base as `claude-<family>-<N>` (Anthropic's own
  // `claude-sonnet-4-0` alias convention; 2026-09-09 azure client sent `claude-opus-5-0`
  // and the versioned gate 404'd it). Only a literal point-zero minor collapses;
  // `-4-8` stays a distinct version. Locked by tests/point-zero-model-alias.test.ts.
  return normalizeModelName(name).replace(/-\d{8}$/, '').replace(/^(claude-[a-z]+-\d+)-0$/, '$1')
}
