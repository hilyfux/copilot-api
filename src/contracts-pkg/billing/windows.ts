/**
 * 配额窗口时长 —— 契约包（P4，2026-10-16）。
 *
 * 之前四份：网关 `src/billing/windows.ts`（权威）+ codex-api / kiro-api / byok-api 的
 * `billing-gate.ts` 各自一组私有常量（`WINDOW_MS` / `TOKEN_WINDOW_MS`）。现在只有这一份：
 * 网关 billing/windows.ts 从这里 re-export，代理 sync 本包后从这里 import。
 *
 * 语义（与网关历史定义逐字相同）：
 *   金额窗口  5h / 7d / 30d（30d 金额窗已废弃，保留供历史读）
 *   token 窗口 1d / 30d（30d = 固定 30 天，不是自然月）
 * 代理侧窗口时长只用来**显示** reset 时刻；拦截永远是 `used >= quota`，时长漂移不会削弱拦截。
 * 改时长 = 契约包升 CONTRACT_VERSION + 网关 period-reset 的 INTERVAL 同步改。
 */

export const WINDOW_LENGTH_MS = {
  '5h':   5 * 60 * 60 * 1000,
  '7d':   7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const

export type WindowSlug = keyof typeof WINDOW_LENGTH_MS

export const WINDOW_SLUGS: readonly WindowSlug[] = ['5h', '7d', '30d'] as const

export const TOKEN_WINDOW_LENGTH_MS = {
  '1d':  24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const

export type TokenWindowSlug = keyof typeof TOKEN_WINDOW_LENGTH_MS

export const TOKEN_WINDOW_SLUGS: readonly TokenWindowSlug[] = ['1d', '30d'] as const

/** 代理 billing-gate 历史上的名字（`WINDOW_MS['5h' | '7d']`）—— 同一张表，换个名字方便代理零改名接入。 */
export const WINDOW_MS = WINDOW_LENGTH_MS
/** 代理 billing-gate 历史上的名字（`TOKEN_WINDOW_MS['1d' | '30d']`）。 */
export const TOKEN_WINDOW_MS = TOKEN_WINDOW_LENGTH_MS
