/**
 * gateway read ports added for catalog / strategy / billing (agent-gateway
 * mig 171 contract). MySQL is a fake `query` — no live database.
 *
 * Locks: the exact views + columns read (so the grant side can be checked),
 * the copilot filters (provider_type='copilot', target_backend='copilot_api'),
 * and the errno policy — 1146/1142 → documented fallback, 1356 → loud error +
 * rethrow (never silently "empty").
 */
import { afterEach, describe, expect, test } from "bun:test"

import type { Queryable } from "~/gateway/db"
import { selectCopilotCatalog } from "~/gateway/catalog"
import { selectStrategySnapshot } from "~/gateway/strategy"
import { selectBillingRow, SELECT_BILLING_VIEW } from "~/gateway/billing"
import {
  __resetViewFallbackWarningsForTests,
  viewOrFallback,
} from "~/gateway/view-fallback"

type Call = { sql: string; params: unknown }

function fakeDb(respond: (sql: string, params: unknown) => unknown[] | Error): {
  db: Queryable
  calls: Call[]
} {
  const calls: Call[] = []
  const db = {
    query: (sql: string, params?: unknown) => {
      calls.push({ sql, params })
      const out = respond(sql, params)
      if (out instanceof Error) return Promise.reject(out)
      return Promise.resolve([out, []])
    },
  } as unknown as Queryable
  return { db, calls }
}

const mysqlError = (errno: number) =>
  Object.assign(new Error(`errno ${errno}`), { errno })

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim()

afterEach(() => __resetViewFallbackWarningsForTests())

describe("catalog port (v_proxy_catalog_v1)", () => {
  test("reads model_id,label,advertised,enabled for provider_type='copilot' in display order", async () => {
    const rows = [
      { model_id: "gpt-6-sol", label: "GPT-6 Sol", advertised: 1, enabled: 1 },
    ]
    const { db, calls } = fakeDb(() => rows)
    expect(await selectCopilotCatalog(db)).toEqual(rows)
    expect(squash(calls[0].sql)).toBe(
      "SELECT model_id, label, advertised, enabled FROM v_proxy_catalog_v1 WHERE provider_type = ? ORDER BY display_order, model_id",
    )
    expect(calls[0].params).toEqual(["copilot"])
  })

  test.each([1146, 1142])(
    "errno %d → null (catalog unavailable)",
    async (errno) => {
      const { db } = fakeDb(() => mysqlError(errno))
      expect(await selectCopilotCatalog(db)).toBeNull()
    },
  )

  test("errno 1356 → rethrown, never treated as empty", async () => {
    const { db } = fakeDb(() => mysqlError(1356))
    expect(
      await selectCopilotCatalog(db).catch((e: unknown) => e),
    ).toMatchObject({
      errno: 1356,
    })
  })
})

describe("strategy port (v_proxy_strategy_users_v1 + v_proxy_strategy_rules_v1)", () => {
  test("reads users + copilot_api rules", async () => {
    const { db, calls } = fakeDb((sql) =>
      sql.includes("users") ?
        [{ user_id: "u1", strategy_id: "strat_default" }]
      : [
          {
            strategy_id: "strat_default",
            match_kind: "exact",
            match_value: "gpt-6-sol",
            upstream_model: "gpt-6-sol",
          },
        ],
    )
    const snap = await selectStrategySnapshot(db)
    expect(snap.users).toHaveLength(1)
    expect(snap.rules).toHaveLength(1)
    expect(squash(calls[0].sql)).toBe(
      "SELECT user_id, strategy_id FROM v_proxy_strategy_users_v1",
    )
    expect(squash(calls[1].sql)).toBe(
      "SELECT strategy_id, match_kind, match_value, upstream_model FROM v_proxy_strategy_rules_v1 WHERE target_backend = ?",
    )
    expect(calls[1].params).toEqual(["copilot_api"])
  })

  test.each([1146, 1142])(
    "errno %d → empty snapshot (identity)",
    async (errno) => {
      const { db } = fakeDb(() => mysqlError(errno))
      expect(await selectStrategySnapshot(db)).toEqual({ users: [], rules: [] })
    },
  )

  test("errno 1356 → rethrown", async () => {
    const { db } = fakeDb(() => mysqlError(1356))
    expect(
      await selectStrategySnapshot(db).catch((e: unknown) => e),
    ).toMatchObject({
      errno: 1356,
    })
  })
})

describe("billing port (v_proxy_billing_v1)", () => {
  test("reads one row by key_hash with kiro's fixed SQL", async () => {
    const row = { user_id: "u1", mode: "pay_per_token" }
    const { db, calls } = fakeDb(() => [row])
    expect(await selectBillingRow(db, "kh")).toEqual(row as never)
    expect(calls[0].sql).toBe(SELECT_BILLING_VIEW)
    expect(calls[0].params).toEqual(["kh"])
    expect(squash(SELECT_BILLING_VIEW)).toBe(
      "SELECT user_id, is_system, plan_id, mode, balance_micros, used_5h_tokens, used_7d_tokens, started_5h_at, started_7d_at, quota_5h_tokens, quota_7d_tokens, used_tokens_1d, started_1d_at, daily_token_quota, used_tokens_30d, started_tokens_30d_at, monthly_token_quota, charge_preference, allow_balance_overflow, token_pack_balance, credit_equivalent_micros FROM v_proxy_billing_v1 WHERE key_hash = ? LIMIT 1",
    )
  })

  test("errno 1146 → undefined (no row → gate allows)", async () => {
    const { db } = fakeDb(() => mysqlError(1146))
    expect(await selectBillingRow(db, "kh")).toBeUndefined()
  })

  test("errno 1356 → rethrown", async () => {
    const { db } = fakeDb(() => mysqlError(1356))
    expect(
      await selectBillingRow(db, "kh").catch((e: unknown) => e),
    ).toMatchObject({
      errno: 1356,
    })
  })
})

describe("viewOrFallback logging", () => {
  test("missing view warns once; 1356 logs at error level", async () => {
    const warns: string[] = []
    const errors: string[] = []
    const logger = {
      warn: (m: string) => void warns.push(m),
      error: (m: string) => void errors.push(m),
    }
    const missing = () => Promise.reject(mysqlError(1146))
    await viewOrFallback("v_x", missing, () => 1, logger)
    await viewOrFallback("v_x", missing, () => 1, logger)
    expect(warns).toHaveLength(1)
    const rejected = await viewOrFallback(
      "v_y",
      () => Promise.reject(mysqlError(1356)),
      () => 1,
      logger,
    ).catch((e: unknown) => e)
    expect(rejected).toMatchObject({ errno: 1356 })
    expect(errors[0]).toContain("1356")
  })
})
