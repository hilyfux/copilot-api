/**
 * gateway/health.ts — provider_account_health (agent-gateway mig 115) writer.
 *
 * Grant shape: copilot_api@% holds SELECT, INSERT, UPDATE and deliberately NOT
 * DELETE — rows are only ever cleared by the gateway. Only rows for
 * provider_type='copilot' are written.
 *
 * Failure policy (铁律 3): a health write is an observation, never a request
 * precondition. Callers treat a throw as "did not record it" and move on.
 */
import type { GatewayPool } from "./db"

export type HealthState = "healthy" | "cooldown" | "dead"

export interface HealthUpsert {
  accountId: string
  state: HealthState
  reason: string | null
  cooldownUntil: Date | null
  consecutiveErrors: number
  observedBy: string
}

const UPSERT_HEALTH_SQL = `
  INSERT INTO provider_account_health
    (account_id, health_state, reason, cooldown_until, consecutive_errors, observed_by, observed_at)
  VALUES (?, ?, ?, ?, ?, ?, NOW(3))
  ON DUPLICATE KEY UPDATE
    health_state = VALUES(health_state),
    reason = VALUES(reason),
    cooldown_until = VALUES(cooldown_until),
    consecutive_errors = VALUES(consecutive_errors),
    observed_by = VALUES(observed_by),
    observed_at = VALUES(observed_at)`

export type HealthGateway = {
  upsert(row: HealthUpsert): Promise<void>
}

export function createHealthGateway(pool: GatewayPool): HealthGateway {
  return {
    async upsert(row) {
      await pool.query(UPSERT_HEALTH_SQL, [
        row.accountId,
        row.state,
        row.reason,
        row.cooldownUntil,
        row.consecutiveErrors,
        row.observedBy,
      ])
    },
  }
}
