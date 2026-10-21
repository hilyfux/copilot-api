/**
 * upstream-recovery.ts — the bounded recoveries every Copilot upstream POST
 * gets, measured on a real seat (operator report 2026-08, ~480 calls):
 *
 *   · 421 Misdirected Request — `endpoints.api` from the token exchange flips
 *     between hosts and one of them (api.individual…) answered 421 for ALL
 *     POSTs. Retry ONCE on the next host in COPILOT_API_HOST_FAILOVER_ORDER
 *     (default enterprise,business,individual); a success makes that host
 *     current until the next token refresh re-applies endpoints.api. Skipped
 *     when the host is pinned (COPILOT_API_BASE_URL) or an enterprise domain
 *     is configured — the operator chose the host explicitly.
 *   · 403 `forbidden` bursts — short-lived (~10/min, recover in tens of
 *     seconds), transient: back off once and retry, never treated as a dead
 *     credential.
 *   · 401 — credential refresher re-read / re-exchange, then one retry
 *     (auth-retry.ts).
 *
 * Each recovery fires at most once per request, so the worst case is a small
 * constant number of upstream calls, never a loop.
 */
import { setTimeout as delay } from "node:timers/promises"

import consola from "consola"

import {
  copilotBaseUrl,
  getEnterpriseDomain,
  getPinnedCopilotApiUrl,
} from "~/lib/api-config"
import { state } from "~/lib/state"

import { withCopilotAuthRetry } from "./auth-retry"

export const COPILOT_API_HOSTS = {
  enterprise: "https://api.enterprise.githubcopilot.com",
  business: "https://api.business.githubcopilot.com",
  individual: "https://api.githubcopilot.com",
} as const

type HostKind = keyof typeof COPILOT_API_HOSTS

export function readHostFailoverOrder(
  env: NodeJS.ProcessEnv = process.env,
): Array<string> {
  const raw = env.COPILOT_API_HOST_FAILOVER_ORDER?.trim()
  const kinds = (
    raw ?
      raw.split(",")
    : ["enterprise", "business", "individual"])
    .map((k) => k.trim().toLowerCase())
    .filter((k): k is HostKind => k in COPILOT_API_HOSTS)
  return kinds.map((k) => COPILOT_API_HOSTS[k])
}

export const upstreamRecoveryDependencies = {
  forbiddenBackoffMs: 1_000,
  sleep: (ms: number) => delay(ms),
  env: process.env,
}

const discard = async (response: Response) => {
  await response.body?.cancel().catch(() => {})
}

export async function withCopilotHostFailover(
  send: () => Promise<Response>,
): Promise<Response> {
  const first = await send()
  if (first.status !== 421) return first
  if (
    getPinnedCopilotApiUrl(upstreamRecoveryDependencies.env)
    || getEnterpriseDomain()
  ) {
    return first
  }
  const current = copilotBaseUrl(state).replace(/\/+$/, "")
  const alternate = readHostFailoverOrder(
    upstreamRecoveryDependencies.env,
  ).find((url) => url !== current)
  if (!alternate) return first

  consola.warn(
    `Copilot host ${current} answered 421 Misdirected Request; retrying once on ${alternate}`,
  )
  await discard(first)
  const previous = state.copilotApiUrl
  state.copilotApiUrl = alternate
  const second = await send()
  if (second.status === 421) state.copilotApiUrl = previous
  return second
}

export async function withForbiddenBurstRetry(
  send: () => Promise<Response>,
): Promise<Response> {
  const first = await send()
  if (first.status !== 403) return first
  const text = await first
    .clone()
    .text()
    .catch(() => "")
  if (!/forbidden/i.test(text)) return first
  consola.warn(
    `Copilot answered a transient 403 forbidden burst; backing off ${upstreamRecoveryDependencies.forbiddenBackoffMs}ms and retrying once`,
  )
  await discard(first)
  await upstreamRecoveryDependencies.sleep(
    upstreamRecoveryDependencies.forbiddenBackoffMs,
  )
  return send()
}

/** auth(401) ∘ host(421) ∘ forbidden(403) around one upstream POST. */
export function sendCopilotUpstream(
  headers: Record<string, string>,
  send: () => Promise<Response>,
): Promise<Response> {
  return withCopilotAuthRetry(headers, () =>
    withCopilotHostFailover(() => withForbiddenBurstRetry(send)),
  )
}
