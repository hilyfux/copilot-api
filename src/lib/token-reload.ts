/**
 * Lazy credential reload for the gateway-managed mode.
 *
 * The gateway owns Copilot credentials (provider_accounts.access_token) and the
 * operator imports them through the admin UI at any time. Startup can therefore
 * legitimately find no account and decide "idle" — but that decision must not be
 * permanent, or the documented import step appears to do nothing until someone
 * restarts the container by hand.
 *
 * This module makes the request path self-healing: the first request that finds
 * no Copilot token asks the gateway once, and every later request is served from
 * the token that attempt installed.
 *
 * Deliberate properties:
 *   - Free when healthy: a configured proxy never touches this code path.
 *   - Single-flight: concurrent cold requests share ONE credential read, so a
 *     burst cannot open a connection storm against the control-plane database.
 *   - Throttled failures: the import is a human action, not a per-request probe,
 *     so a rejected attempt is not repeated for `RETRY_INTERVAL_MS`.
 *   - Honest error: with no reloader (standalone/file-token mode) the caller's
 *     original "Copilot token not found" stands unchanged.
 */

import {
  isTokenExchangeAuthRejection,
  reportCopilotAuthFailure,
} from "~/lib/copilot-auth-failure"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/** Installs a token into `state`; resolves false when the gateway has none. */
export type TokenReloader = () => Promise<boolean>

/** How long a failed attempt suppresses the next one. */
const RETRY_INTERVAL_MS = 5_000

let reloader: TokenReloader | null = null
let inFlight: Promise<void> | null = null
let lastFailureAt = 0

/**
 * Register the reload strategy. `null` restores standalone behaviour, which is
 * what a process without a gateway connection must keep.
 */
export function configureTokenReloader(next: TokenReloader | null): void {
  reloader = next
  inFlight = null
  lastFailureAt = 0
}

/**
 * Test seam: clear single-flight/throttle state. `keepThrottle: false` also
 * clears the failure timestamp, which lets a test simulate the window elapsing
 * without actually sleeping.
 */
export function resetTokenReloadStateForTest(
  options: { keepThrottle?: boolean } = {},
): void {
  inFlight = null
  if (options.keepThrottle !== true) {
    lastFailureAt = 0
  }
}

function missingTokenError(): Error {
  return new Error("Copilot token not found")
}

async function reloadOnce(): Promise<void> {
  if (state.copilotToken) return
  if (!reloader) throw missingTokenError()

  const createdAt = Date.now()
  if (lastFailureAt !== 0 && createdAt - lastFailureAt < RETRY_INTERVAL_MS) {
    throw missingTokenError()
  }

  if (!inFlight) {
    inFlight = (async () => {
      const installed = await reloader?.().catch(() => false)
      if (!installed || !state.copilotToken) {
        lastFailureAt = Date.now()
        throw missingTokenError()
      }
      lastFailureAt = 0
    })().finally(() => {
      inFlight = null
    })
  }

  await inFlight
}

// ── Stale ephemeral token (scope: "treat as expired 5 min early") ──────────
let expiryRefresher: (() => Promise<void>) | null = null
let expiryInFlight: Promise<void> | null = null

/** Installed by setupCopilotToken: re-exchange the GitHub token now. */
export function configureCopilotTokenExpiryRefresh(
  next: (() => Promise<void>) | null,
): void {
  expiryRefresher = next
  expiryInFlight = null
}

function isStale(nowMs: number): boolean {
  const staleAt = state.copilotTokenStaleAt
  return typeof staleAt === "number" && nowMs >= staleAt
}

/**
 * Single-flight, double-checked refresh of a stale token: concurrent requests
 * share one exchange; a failed refresh keeps the current token (it may still
 * be inside its real lifetime) and the 401 path recovers if it is not.
 */
async function refreshStaleToken(): Promise<void> {
  if (!expiryRefresher || !isStale(Date.now())) return
  if (!expiryInFlight) {
    const refresh = expiryRefresher
    expiryInFlight = (async () => {
      if (!isStale(Date.now())) return // double-check inside the lock
      await refresh()
    })().finally(() => {
      expiryInFlight = null
    })
  }
  try {
    await expiryInFlight
  } catch (error) {
    // Keep the current token (see above). A refused exchange means the GitHub
    // credential itself is bad: let the credential refresher re-read.
    if (
      error instanceof HTTPError
      && isTokenExchangeAuthRejection(error.response.status)
    ) {
      await reportCopilotAuthFailure()
    }
  }
}

/**
 * Guarantee `state.copilotToken` is set (and not stale), reloading it from the
 * gateway once when it is missing. Call this immediately before an upstream
 * Copilot request needs the token; it is a no-op on the hot path once a fresh
 * token exists.
 */
export async function ensureCopilotToken(): Promise<void> {
  if (state.copilotToken) {
    if (isStale(Date.now())) await refreshStaleToken()
    if (state.copilotToken) return
  }
  await reloadOnce()
}
