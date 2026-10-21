/**
 * Billing admission gate — mirror of kiro-api tests/billing-gate.test.ts
 * (decision cases) + the D-GATE cross-repo vectors from the contract package,
 * + the HTTP rejection shape (byte-for-byte kiro's billingRejection). Fakes only.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { BillingGateway, BillingRow } from "~/gateway/billing"
import { requestContext } from "~/lib/request-context"
import { traceIdMiddleware } from "~/lib/trace"
import {
  __resetBillingCache,
  CACHE_TTL_DENY_MS,
  CACHE_TTL_OK_MS,
  createBillingGate,
  decide,
} from "~/policy/billing-gate"
import {
  billingRejectionBody,
  createBillingGateMiddleware,
  isBillingGatedRequest,
} from "~/policy/billing-gate-middleware"

afterEach(() => __resetBillingCache())

const silent = { warn: () => {} }

function subRow(o: Partial<BillingRow> = {}): BillingRow {
  return {
    user_id: "u1",
    is_system: null,
    plan_id: "sub",
    mode: "subscription",
    balance_micros: 0,
    used_5h_tokens: 0,
    used_7d_tokens: 0,
    started_5h_at: null,
    started_7d_at: null,
    quota_5h_tokens: null,
    quota_7d_tokens: null,
    used_tokens_1d: 0,
    started_1d_at: null,
    daily_token_quota: null,
    used_tokens_30d: 0,
    started_tokens_30d_at: null,
    monthly_token_quota: null,
    charge_preference: "plan",
    allow_balance_overflow: 0,
    token_pack_balance: 0,
    ...o,
  }
}

function gatewayReturning(
  row: BillingRow | undefined | Error,
): BillingGateway & { calls: number } {
  const g = {
    calls: 0,
    lookupByKeyHash: () => {
      g.calls++
      return row instanceof Error ? Promise.reject(row) : Promise.resolve(row)
    },
  }
  return g
}

describe("decide (kiro parity)", () => {
  test("no billing row → allow", () => {
    expect(decide(undefined)).toEqual({ allowed: true })
  })
  test("ppt zero balance → insufficient_balance", () => {
    expect(
      decide(
        subRow({ mode: "pay_per_token", plan_id: null, balance_micros: 0 }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "insufficient_balance",
      mode: "pay_per_token",
    })
  })
  test("ppt positive balance → allow", () => {
    expect(
      decide(subRow({ mode: "pay_per_token", balance_micros: 5 })).allowed,
    ).toBe(true)
  })
  test("subscription 5h token window exhausted + overflow off → plan_exhausted_overflow_off + resetAt", () => {
    const started = "2026-10-21T00:00:00.000Z"
    expect(
      decide(
        subRow({
          quota_5h_tokens: 100,
          used_5h_tokens: 100,
          started_5h_at: started,
          balance_micros: 999,
        }),
      ),
    ).toEqual({
      allowed: false,
      reason: "plan_exhausted_overflow_off",
      userId: "u1",
      mode: "subscription",
      resetAt: "2026-10-21T05:00:00.000Z",
    })
  })
  test("subscription 7d exhausted + overflow on + balance 0 → quota_exceeded with window", () => {
    expect(
      decide(
        subRow({
          quota_7d_tokens: 1,
          used_7d_tokens: 2,
          allow_balance_overflow: 1,
          started_7d_at: "2026-10-01T00:00:00Z",
        }),
      ),
    ).toEqual({
      allowed: false,
      reason: "quota_exceeded",
      userId: "u1",
      mode: "subscription",
      window: "7d",
      resetAt: "2026-10-08T00:00:00.000Z",
    })
  })
  test("daily token quota exceeded (credits_seat) → token_quota_exceeded, hard cap", () => {
    expect(
      decide(
        subRow({
          mode: "credits_seat",
          daily_token_quota: 10,
          used_tokens_1d: 10,
          balance_micros: 99,
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "token_quota_exceeded",
      mode: "credits_seat",
    })
  })
  test("system user → always allow", () => {
    expect(
      decide(subRow({ is_system: 1, mode: "pay_per_token", balance_micros: 0 }))
        .allowed,
    ).toBe(true)
  })
  test("token_pack lane empty + overflow off → token_pack_exhausted_overflow_off (no resetAt)", () => {
    const d = decide(
      subRow({
        charge_preference: "token_pack",
        token_pack_balance: 0,
        balance_micros: 50,
      }),
    )
    expect(d).toEqual({
      allowed: false,
      reason: "token_pack_exhausted_overflow_off",
      userId: "u1",
      mode: "subscription",
    })
  })
  test("balance lane uses credit-equivalent money (mig 128)", () => {
    expect(
      decide(
        subRow({
          charge_preference: "balance",
          balance_micros: 0,
          credit_equivalent_micros: 1,
        }),
      ).allowed,
    ).toBe(true)
  })
})

describe("D-GATE vectors from the contract package", () => {
  type Vector = {
    name: string
    state: { preference: string; allowBalanceOverflow: boolean }
    balances: {
      windowExhausted: boolean
      tokenPackBalance: number
      balanceMicros: number
      creditEquivalentMicros?: number
    }
    expected: string | null
  }
  const vectors = (
    JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "src",
          "contracts-pkg",
          "vectors",
          "d-gate.json",
        ),
        "utf8",
      ),
    ) as { cases: Vector[] }
  ).cases

  // Drive each vector through the subscription gate: windowExhausted ↔ a 5h
  // token window at quota. The gate must admit exactly when blockReason is null.
  for (const v of vectors) {
    test(v.name, () => {
      const d = decide(
        subRow({
          charge_preference: v.state.preference,
          allow_balance_overflow: v.state.allowBalanceOverflow ? 1 : 0,
          token_pack_balance: v.balances.tokenPackBalance,
          balance_micros: v.balances.balanceMicros,
          credit_equivalent_micros: v.balances.creditEquivalentMicros ?? 0,
          quota_5h_tokens: 100,
          used_5h_tokens: v.balances.windowExhausted ? 100 : 0,
        }),
      )
      expect(d.allowed).toBe(v.expected === null)
    })
  }
})

describe("gate cache + fail-open", () => {
  test("allow cached 5s, deny cached 1s (kiro TTLs)", async () => {
    expect([CACHE_TTL_OK_MS, CACHE_TTL_DENY_MS]).toEqual([5_000, 1_000])
    let t = 0
    const g = gatewayReturning(
      subRow({ mode: "pay_per_token", balance_micros: 0 }),
    )
    const gate = createBillingGate({ billing: g, now: () => t, logger: silent })
    await gate.check("kh")
    t = 999
    await gate.check("kh")
    expect(g.calls).toBe(1)
    t = 1_001
    await gate.check("kh")
    expect(g.calls).toBe(2)
  })

  test("DB fault → fail-open and logged", async () => {
    const warns: string[] = []
    const gate = createBillingGate({
      billing: gatewayReturning(new Error("conn refused")),
      logger: { warn: (m) => void warns.push(m) },
    })
    expect(await gate.check("kh")).toEqual({ allowed: true })
    expect(warns[0]).toContain("fail-open")
  })

  test("no gateway → allow", async () => {
    expect(await createBillingGate({ billing: null }).check("kh")).toEqual({
      allowed: true,
    })
  })
})

describe("HTTP rejection (byte-for-byte kiro billingRejection)", () => {
  test("insufficient_balance → 402 billing_error", () => {
    expect(
      billingRejectionBody({
        allowed: false,
        reason: "insufficient_balance",
        userId: "u",
        mode: "pay_per_token",
      }),
    ).toEqual({
      status: 402,
      body: {
        type: "error",
        error: {
          type: "billing_error",
          message:
            "Your account has no remaining balance. Please contact your administrator to top up.",
        },
      },
    })
  })

  test("quota_exceeded 5h → 429 rate_limit_error with reset_at", () => {
    expect(
      billingRejectionBody({
        allowed: false,
        reason: "quota_exceeded",
        userId: "u",
        mode: "subscription",
        window: "5h",
        resetAt: "2026-10-21T05:00:00.000Z",
      }),
    ).toEqual({
      status: 429,
      body: {
        type: "error",
        error: {
          type: "rate_limit_error",
          message:
            "Your account 5-hour usage limit has been reached. Please wait for the window to reset or contact your administrator.",
          reset_at: "2026-10-21T05:00:00.000Z",
        },
      },
    })
  })

  test("token_quota_exceeded → 429 daily wording", () => {
    const r = billingRejectionBody({
      allowed: false,
      reason: "token_quota_exceeded",
      userId: "u",
      mode: "credits_seat",
    })
    expect(r.status).toBe(429)
    expect(r.body.error.message).toBe(
      "Your account daily usage limit has been reached. Please wait for the daily reset or contact your administrator.",
    )
  })

  test("gated paths: POST inference yes; GET, admin, count_tokens no", () => {
    expect(isBillingGatedRequest("POST", "/v1/chat/completions")).toBe(true)
    expect(isBillingGatedRequest("POST", "/v1/messages")).toBe(true)
    expect(isBillingGatedRequest("GET", "/v1/models")).toBe(false)
    expect(isBillingGatedRequest("POST", "/admin/config")).toBe(false)
    expect(isBillingGatedRequest("POST", "/v1/messages/count_tokens")).toBe(
      false,
    )
  })

  test("middleware returns the 402 before the handler runs", async () => {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use(async (_c, next) => {
      const s = requestContext.getStore()
      if (s) s.gatewayKeyHash = "kh"
      await next()
    })
    app.use(
      "*",
      createBillingGateMiddleware(
        createBillingGate({
          billing: gatewayReturning(
            subRow({ mode: "pay_per_token", balance_micros: 0 }),
          ),
          logger: silent,
        }),
        silent,
      ),
    )
    let handled = false
    app.post("/v1/responses", (c) => {
      handled = true
      return c.text("ok")
    })
    const res = await app.request("/v1/responses", {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "billing_error",
    )
    expect(handled).toBe(false)
  })
})
