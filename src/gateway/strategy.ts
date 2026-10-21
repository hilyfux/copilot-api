/**
 * gateway/strategy.ts — proxy-strategy read path, mirroring kiro-api
 * `src/gateway/strategy.ts` with target_backend = 'copilot_api'.
 *
 * Reads:
 *   · v_proxy_strategy_users_v1 (user_id, strategy_id) — wraps the gateway's
 *     v_user_effective_strategy (user ?? org ?? default resolved gateway-side,
 *     so this proxy never sees org tables). Because the wrapper is SQL
 *     SECURITY INVOKER, copilot_api needs SELECT on v_user_effective_strategy
 *     too (mig 171).
 *   · v_proxy_strategy_rules_v1 (strategy_id, match_kind, match_value,
 *     upstream_model) WHERE target_backend = 'copilot_api'.
 *
 * Both queries run as one snapshot; if EITHER view is missing (1146/1142) the
 * whole snapshot is empty → identity routing (copilot_api has no base-table
 * grant to fall back to). 1356 / other faults reject → the cache keeps its
 * last-good snapshot.
 */
import type { RowDataPacket } from "mysql2/promise"

import type { GatewayPool, Queryable } from "./db"
import { viewOrFallback } from "./view-fallback"

/** proxy_strategy_rules.target_backend value owned by this proxy. */
export const COPILOT_STRATEGY_BACKEND = "copilot_api"

export type UserStrategyRow = { user_id: string; strategy_id: string | null }
export type StrategyRuleRow = {
  strategy_id: string
  match_kind: string
  match_value: string
  upstream_model: string | null
}

export type StrategySnapshot = {
  users: UserStrategyRow[]
  rules: StrategyRuleRow[]
}

const SELECT_USERS = `SELECT user_id, strategy_id FROM v_proxy_strategy_users_v1`
const SELECT_RULES = `
  SELECT strategy_id, match_kind, match_value, upstream_model
    FROM v_proxy_strategy_rules_v1
   WHERE target_backend = ?`

export async function selectStrategySnapshot(
  db: Queryable,
): Promise<StrategySnapshot> {
  return viewOrFallback(
    "v_proxy_strategy_*_v1",
    async () => {
      const [users] =
        await db.query<(RowDataPacket & UserStrategyRow)[]>(SELECT_USERS)
      const [rules] = await db.query<(RowDataPacket & StrategyRuleRow)[]>(
        SELECT_RULES,
        [COPILOT_STRATEGY_BACKEND],
      )
      return { users, rules }
    },
    () => ({ users: [], rules: [] }),
  )
}

export type StrategyGateway = {
  readSnapshot(): Promise<StrategySnapshot>
}

export function createStrategyGateway(pool: GatewayPool): StrategyGateway {
  return { readSnapshot: () => selectStrategySnapshot(pool) }
}
