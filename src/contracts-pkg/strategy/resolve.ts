/**
 * Pure proxy-strategy rule resolution (Phase 2) —— 契约包（P4，2026-10-16）。
 *
 * 正文取自 codex-api `src/strategy/resolve.ts`（2026-10-16），唯一改动：import 从
 * `../protocol/routing.ts` 改为包内 `../protocol/model-name.ts`（同一个 normalizeModelBase）。
 * A downstream Claude model, for one backend's rule set, resolves to at most one rule —
 * exact > exact-by-normalized-base > tier > default. No IO; callers feed the rules they
 * polled from MySQL (the gateway filters by target_backend first, see
 * src/stores/proxy-strategy-store.ts). 所有权：契约包；codex 会话是维护者（设计 §7.1）。
 */
import { normalizeModelBase } from '../protocol/model-name.ts'

export type StrategyRule = {
  strategyId: string
  matchKind: string // 'exact' | 'tier' | 'default'
  matchValue: string
  upstreamModel: string | null
  reasoningEffort: string | null
  fastMode: string | null
  serviceTier: string | null
}

/** Claude-family tier from a downstream model name, or null. */
export function tierOf(model: string): 'opus' | 'sonnet' | 'haiku' | null {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return null
}

/** Most specific rule for a downstream model: exact > tier > default > null. */
export function resolveRule(rules: readonly StrategyRule[], model: string): StrategyRule | null {
  const exact = rules.find((r) => r.matchKind === 'exact' && r.matchValue === model)
  if (exact) return exact
  // 2026-09-09 azure「opus-5 无法使用」：客户端发 `claude-opus-5-0`，默认策略只有
  // `claude-opus-5` 的精确规则 → 无规则 + 版本化 id → 404。精确匹配不到时按归一化
  // 基名（去日期快照、去 point-zero 小版本）再匹配一次，与分类器共用同一归一化入口。
  const base = normalizeModelBase(model)
  if (base !== model) {
    const byBase = rules.find((r) => r.matchKind === 'exact' && r.matchValue === base)
    if (byBase) return byBase
  }
  const tier = tierOf(model)
  if (tier) {
    const tierRule = rules.find((r) => r.matchKind === 'tier' && r.matchValue === tier)
    if (tierRule) return tierRule
  }
  return rules.find((r) => r.matchKind === 'default') ?? null
}
