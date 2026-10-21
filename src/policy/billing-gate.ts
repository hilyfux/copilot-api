/**
 * billing-gate.ts — per-key billing / quota admission gate. A line-for-line
 * mirror of kiro-api `src/policy/billing-gate.ts` (operator decision
 * 2026-10-21: copilot is billed at official prices like kiro), reading the
 * SAME gateway view (`v_proxy_billing_v1`) and deciding with the SAME contract
 * package functions:
 *
 *   · token quotas 1d / 30d — universal plan knobs, every mode, checked first;
 *   · credits_seat — token quotas only;
 *   · pay_per_token — token_pack / balance lanes (no plan window lane);
 *   · subscription — 5h / 7d TOKEN windows, then the D-GATE lane decision
 *     (`blockReason` from contracts-pkg/billing/charge-preference: plan /
 *     token_pack / balance, allow_balance_overflow, credit-equivalent money).
 *
 * Cache: 5s for an allow, 1s for a deny (kiro's TTLs). A DB fault fails OPEN
 * and is logged — an accounting outage must not take inference down
 * (铁律 3); the gateway charge worker still prices the usage afterwards.
 */
import {
  blockReason,
  effectivePreference,
  readChargePreference,
} from "~/contracts-pkg/billing/charge-preference"
import type { BillingDecision } from "~/contracts-pkg/billing/billing-decision"
import { TOKEN_WINDOW_MS, WINDOW_MS } from "~/contracts-pkg/billing/windows"
import type { BillingGateway, BillingRow } from "~/gateway/billing"

export type { BillingDecision }

export const CACHE_TTL_OK_MS = 5_000
export const CACHE_TTL_DENY_MS = 1_000

function resetInstant(
  started: Date | string | null,
  durationMs: number,
): string | undefined {
  if (started == null) return undefined
  const t =
    started instanceof Date ? started.getTime() : new Date(started).getTime()
  if (!Number.isFinite(t)) return undefined
  return new Date(t + durationMs).toISOString()
}

type CacheEntry = { decision: BillingDecision; expires: number }
const cache = new Map<string, CacheEntry>()

export type BillingGate = {
  check(keyHash: string): Promise<BillingDecision>
}

export function createBillingGate(opts: {
  billing: BillingGateway | null
  now?: () => number
  logger?: { warn: (m: string) => void }
}): BillingGate {
  const billing = opts.billing
  const now = opts.now ?? (() => Date.now())
  const logger = opts.logger ?? {
    warn: (m: string) => console.warn(`[billing-gate] ${m}`),
  }

  return {
    async check(keyHash: string): Promise<BillingDecision> {
      if (!keyHash) return { allowed: true }
      if (!billing) return { allowed: true }

      const cached = cache.get(keyHash)
      if (cached && cached.expires > now()) return cached.decision

      let decision: BillingDecision
      try {
        decision = decide(await billing.lookupByKeyHash(keyHash))
      } catch (err) {
        logger.warn(
          `lookup failed, fail-open: ${err instanceof Error ? err.message : String(err)}`,
        )
        return { allowed: true }
      }

      cache.set(keyHash, {
        decision,
        expires:
          now() + (decision.allowed ? CACHE_TTL_OK_MS : CACHE_TTL_DENY_MS),
      })
      return decision
    },
  }
}

/** Configured and at/over quota. NULL / ≤0 quota = unmetered, never exhausted. */
function atOrOverQuota(
  quota: number | null | undefined,
  used: number | null | undefined,
): boolean {
  if (quota == null) return false
  const q = Number(quota)
  return q > 0 && Number(used ?? 0) >= q
}

export function decide(row: BillingRow | undefined): BillingDecision {
  if (!row || !row.user_id || !row.mode) return { allowed: true }
  if (Number(row.is_system) === 1) return { allowed: true }
  const userId = row.user_id
  const mode = row.mode

  const pref = readChargePreference(row)
  const lanes = (windowExhausted: boolean) => ({
    windowExhausted,
    tokenPackBalance: Number(row.token_pack_balance ?? 0),
    balanceMicros: Number(row.balance_micros ?? 0),
    creditEquivalentMicros: Number(row.credit_equivalent_micros ?? 0),
  })
  const laneIgnoresWindows =
    mode === "subscription" && pref.preference !== "plan"

  if (!laneIgnoresWindows) {
    const tokenPairs: Array<
      ["1d" | "30d", number | null, number | null, Date | string | null]
    > = [
      ["1d", row.daily_token_quota, row.used_tokens_1d, row.started_1d_at],
      [
        "30d",
        row.monthly_token_quota,
        row.used_tokens_30d,
        row.started_tokens_30d_at,
      ],
    ]
    for (const [slug, quota, used, started] of tokenPairs) {
      if (!atOrOverQuota(quota, used)) continue
      const resetAt = resetInstant(started, TOKEN_WINDOW_MS[slug])
      if (mode === "subscription") {
        const why = blockReason(pref, lanes(true))
        if (why === null) continue
        if (why === "plan_exhausted_overflow_off") {
          return {
            allowed: false,
            reason: "plan_exhausted_overflow_off",
            userId,
            mode: "subscription",
            ...(resetAt ? { resetAt } : {}),
          }
        }
      }
      return {
        allowed: false,
        reason: "token_quota_exceeded",
        userId,
        mode,
        ...(resetAt ? { resetAt } : {}),
      }
    }
  }

  if (mode === "credits_seat") return { allowed: true }

  if (mode === "pay_per_token") {
    const why = blockReason(
      {
        preference: effectivePreference(mode, pref.preference),
        allowBalanceOverflow: pref.allowBalanceOverflow,
      },
      lanes(false),
    )
    if (why === "token_pack_exhausted_overflow_off") {
      return {
        allowed: false,
        reason: "token_pack_exhausted_overflow_off",
        userId,
        mode: "pay_per_token",
      }
    }
    if (why === "insufficient_balance") {
      return {
        allowed: false,
        reason: "insufficient_balance",
        userId,
        mode: "pay_per_token",
      }
    }
    return { allowed: true }
  }

  if (!row.plan_id) return { allowed: true }

  if (!laneIgnoresWindows) {
    const pairs: Array<
      [
        "5h" | "7d",
        number | null | undefined,
        number | null | undefined,
        Date | string | null,
      ]
    > = [
      ["5h", row.quota_5h_tokens, row.used_5h_tokens, row.started_5h_at],
      ["7d", row.quota_7d_tokens, row.used_7d_tokens, row.started_7d_at],
    ]
    for (const [slug, quota, used, started] of pairs) {
      if (!atOrOverQuota(quota, used)) continue
      const why = blockReason(pref, lanes(true))
      if (why === null) return { allowed: true }
      const resetAt = resetInstant(started, WINDOW_MS[slug])
      if (why === "plan_exhausted_overflow_off") {
        return {
          allowed: false,
          reason: "plan_exhausted_overflow_off",
          userId,
          mode: "subscription",
          ...(resetAt ? { resetAt } : {}),
        }
      }
      return {
        allowed: false,
        reason: "quota_exceeded",
        userId,
        mode: "subscription",
        window: slug,
        ...(resetAt ? { resetAt } : {}),
      }
    }
  }

  const why = blockReason(pref, lanes(false))
  if (why === "token_pack_exhausted_overflow_off") {
    return {
      allowed: false,
      reason: "token_pack_exhausted_overflow_off",
      userId,
      mode: "subscription",
    }
  }
  if (why === "insufficient_balance") {
    return {
      allowed: false,
      reason: "insufficient_balance",
      userId,
      mode: "subscription",
    }
  }
  return { allowed: true }
}

export function __resetBillingCache(): void {
  cache.clear()
}
