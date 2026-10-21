/**
 * Read-only proxy-strategy cache — mirror of kiro-api
 * `src/strategy/strategy-reader.ts`, for target_backend = 'copilot_api'.
 *
 * Polls agent-gateway every 60s (REFRESH_MS, kiro's convention):
 *   - v_proxy_strategy_users_v1 → Map<userId, strategyId>
 *   - v_proxy_strategy_rules_v1 (copilot_api) → Map<strategyId, rules>
 *
 * `upstreamModelFor(userId, model)` returns the rule's upstream model, or null.
 * EVERY failure path (no gateway, query error, no mapping, no rule, blank
 * upstream) → null → the caller keeps the requested model unchanged
 * (identity, fail-open). A refresh error keeps the last-good snapshot and is
 * logged. The timer is unref'd so the request path never waits on MySQL.
 *
 * Rule matching is the contract package's `resolveRule` (exact > base-name
 * exact > tier > default) — the same function kiro-api / codex-api run.
 */
import {
  resolveRule,
  type StrategyRule,
} from "~/contracts-pkg/strategy/resolve"
import type { StrategyGateway } from "~/gateway/strategy"

export const STRATEGY_REFRESH_MS = 60_000

export type StrategyCache = {
  upstreamModelFor(userId: string, model: string): string | null
  refresh(): Promise<void>
  stop(): void
}

export function createStrategyCache(
  source: StrategyGateway | null,
  opts: {
    logger?: { warn: (m: string) => void }
    refreshMs?: number
    autoStart?: boolean
  } = {},
): StrategyCache {
  let userToStrategy = new Map<string, string>()
  let rulesByStrategy = new Map<string, StrategyRule[]>()
  let timer: ReturnType<typeof setInterval> | null = null
  const logger = opts.logger ?? {
    warn: (m: string) => console.warn(`[strategy] ${m}`),
  }

  async function refresh(): Promise<void> {
    if (!source) return
    try {
      const { users, rules } = await source.readSnapshot()
      const nextUsers = new Map<string, string>()
      for (const r of users) {
        if (r.strategy_id) nextUsers.set(r.user_id, r.strategy_id)
      }
      const nextRules = new Map<string, StrategyRule[]>()
      for (const r of rules) {
        const list = nextRules.get(r.strategy_id) ?? []
        // Copilot consumes only upstreamModel (identity routing, operator
        // decision "各走各的"); the reasoning/fast/tier knobs are not read.
        list.push({
          strategyId: r.strategy_id,
          matchKind: r.match_kind,
          matchValue: r.match_value,
          upstreamModel: r.upstream_model,
          reasoningEffort: null,
          fastMode: null,
          serviceTier: null,
        })
        nextRules.set(r.strategy_id, list)
      }
      userToStrategy = nextUsers
      rulesByStrategy = nextRules
    } catch (err) {
      // Keep the last-good maps; a transient MySQL blip must not drop overrides.
      logger.warn(
        `refresh failed (keeping last-good snapshot): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (source && opts.autoStart !== false) {
    void refresh()
    timer = setInterval(
      () => void refresh(),
      opts.refreshMs ?? STRATEGY_REFRESH_MS,
    )
    if (typeof timer.unref === "function") timer.unref()
  }

  return {
    upstreamModelFor(userId, model) {
      const strategyId = userToStrategy.get(userId)
      if (!strategyId) return null
      const rules = rulesByStrategy.get(strategyId)
      if (!rules || rules.length === 0) return null
      const up = resolveRule(rules, model)?.upstreamModel
      return up && up.length > 0 ? up : null
    },
    refresh,
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

// ── Module singleton (installed at boot, read on the request path) ──────────
let installed: StrategyCache | null = null

export function initStrategyCache(cache: StrategyCache | null): void {
  installed?.stop()
  installed = cache
}

/** Strategy upstream-model override for this request, or null (→ identity). */
export function strategyUpstreamModelFor(
  userId: string | null | undefined,
  model: string,
): string | null {
  if (!installed || !userId) return null
  return installed.upstreamModelFor(userId, model)
}
