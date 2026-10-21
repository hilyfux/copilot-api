/**
 * billing-gate-middleware.ts — runs the billing / quota gate after managed
 * auth (needs the key hash) and before any handler touches the body or the
 * upstream, mirroring kiro-api server.ts step 2 ("billing / quota gate BEFORE
 * concurrency").
 *
 * Rejections are byte-for-byte kiro-api's `billingRejection` (fleet-wide ONE
 * shape, codex-api / byok-api / kiro-api share the wording):
 *   402 billing_error    — insufficient_balance, plan_exhausted_overflow_off,
 *                          token_pack_exhausted_overflow_off (a billing
 *                          decision; retrying will not help)
 *   429 rate_limit_error — quota_exceeded (5h/7d), token_quota_exceeded
 *                          (1d/30d), with `reset_at` when the window is known.
 *
 * Gated: every non-GET request except admin and token counting (free, no
 * upstream inference). No gate configured / no key on the request (loopback
 * standalone mode) → pass through.
 */
import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { requestContext } from "~/lib/request-context"

import type { BillingDecision, BillingGate } from "./billing-gate"

type Denial = Extract<BillingDecision, { allowed: false }>

export function billingRejectionBody(decision: Denial): {
  status: 402 | 429
  body: {
    type: "error"
    error: { type: string; message: string; reset_at?: string }
  }
} {
  const isBillingStop =
    decision.reason === "insufficient_balance"
    || decision.reason === "plan_exhausted_overflow_off"
    || decision.reason === "token_pack_exhausted_overflow_off"
  const status = isBillingStop ? 402 : 429
  let message: string
  if (decision.reason === "insufficient_balance") {
    message =
      "Your account has no remaining balance. Please contact your administrator to top up."
  } else if (decision.reason === "plan_exhausted_overflow_off") {
    message =
      "Your plan allowance is used up and spending from account balance is turned off. Wait for the window to reset, or ask your administrator to enable balance overflow."
  } else if (decision.reason === "token_pack_exhausted_overflow_off") {
    message =
      "Your token package is used up and spending from account balance is turned off. Please top up a token package, or enable spending from account balance."
  } else if (decision.reason === "token_quota_exceeded") {
    message =
      "Your account daily usage limit has been reached. Please wait for the daily reset or contact your administrator."
  } else {
    const winLabel =
      decision.window === "5h" ? "5-hour"
      : decision.window === "7d" ? "weekly"
      : "monthly"
    message = `Your account ${winLabel} usage limit has been reached. Please wait for the window to reset or contact your administrator.`
  }
  return {
    status,
    body: {
      type: "error",
      error: {
        type: isBillingStop ? "billing_error" : "rate_limit_error",
        message,
        ...("resetAt" in decision && decision.resetAt ?
          { reset_at: decision.resetAt }
        : {}),
      },
    },
  }
}

export function isBillingGatedRequest(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false
  }
  if (path === "/admin" || path.startsWith("/admin/")) return false
  if (path.endsWith("/count_tokens")) return false
  return true
}

export function createBillingGateMiddleware(
  gate: BillingGate | null,
  logger: { warn: (m: string) => void } = {
    warn: (m) => consola.warn(m),
  },
): MiddlewareHandler {
  return async (c: Context, next) => {
    if (!gate || !isBillingGatedRequest(c.req.method, c.req.path)) {
      return next()
    }
    const store = requestContext.getStore()
    const keyHash = store?.gatewayKeyHash
    if (!keyHash) return next()

    const decision = await gate.check(keyHash)
    if (decision.allowed) return next()

    // Observable boundary (多系统准则 4): one line per denial, no secrets.
    logger.warn(
      `[billing-gate] denied reason=${decision.reason} user=${decision.userId} path=${c.req.path} traceId=${store.traceId}`,
    )
    const { status, body } = billingRejectionBody(decision)
    return c.json(body, status)
  }
}
