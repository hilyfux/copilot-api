/**
 * gateway/billing.ts — billing-gate read: one row of v_proxy_billing_v1
 * (client_keys ⋈ users ⋈ user_billing_state ⋈ billing_plans, JOIN owned by the
 * gateway view) per key_hash. Same fixed SQL as kiro-api `src/gateway/billing.ts`.
 *
 * The admission DECISION lives in policy/billing-gate.ts; this file only
 * delivers the row. View missing (1146/1142) → `undefined` (no row) → the gate
 * allows (fail-open, same as kiro's posture when it cannot read billing).
 * 1356 / other faults reject → the gate logs and fails open.
 */
import type { RowDataPacket } from "mysql2/promise"

import type { GatewayPool, Queryable } from "./db"
import { viewOrFallback } from "./view-fallback"

export type BillingRow = {
  user_id: string | null
  is_system: number | null
  plan_id: string | null
  mode: "subscription" | "pay_per_token" | "credits_seat" | null
  balance_micros: number | null
  started_5h_at: Date | string | null
  started_7d_at: Date | string | null
  used_5h_tokens?: number | null
  used_7d_tokens?: number | null
  quota_5h_tokens?: number | null
  quota_7d_tokens?: number | null
  used_tokens_1d: number | null
  started_1d_at: Date | string | null
  daily_token_quota: number | null
  used_tokens_30d: number | null
  started_tokens_30d_at: Date | string | null
  monthly_token_quota: number | null
  charge_preference?: string | null
  allow_balance_overflow?: number | boolean | null
  token_pack_balance?: number | null
  credit_equivalent_micros?: number | null
}

/** Byte-for-byte the kiro-api view SQL (proxy-views-v1.md §4.2 ①). */
export const SELECT_BILLING_VIEW = `SELECT user_id, is_system, plan_id, mode, balance_micros, used_5h_tokens, used_7d_tokens, started_5h_at, started_7d_at,
       quota_5h_tokens, quota_7d_tokens, used_tokens_1d, started_1d_at, daily_token_quota, used_tokens_30d,
       started_tokens_30d_at, monthly_token_quota, charge_preference, allow_balance_overflow, token_pack_balance,
       credit_equivalent_micros
  FROM v_proxy_billing_v1
 WHERE key_hash = ? LIMIT 1`

export async function selectBillingRow(
  db: Queryable,
  keyHash: string,
): Promise<BillingRow | undefined> {
  return viewOrFallback(
    "v_proxy_billing_v1",
    async () => {
      const [rows] = await db.query<(RowDataPacket & BillingRow)[]>(
        SELECT_BILLING_VIEW,
        [keyHash],
      )
      return rows[0]
    },
    () => undefined,
  )
}

export type BillingGateway = {
  /** One billing row for the key (no row → undefined). Faults reject. */
  lookupByKeyHash(keyHash: string): Promise<BillingRow | undefined>
}

export function createBillingGateway(pool: GatewayPool): BillingGateway {
  return { lookupByKeyHash: (keyHash) => selectBillingRow(pool, keyHash) }
}
