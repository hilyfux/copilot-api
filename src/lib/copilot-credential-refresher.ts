/**
 * copilot-credential-refresher.ts — keeps the installed GitHub Copilot
 * credential in step with agent-gateway's `provider_accounts`.
 *
 * Problem it fixes (live 2026-10-21): the credential was read ONCE at boot.
 * The operator deleted account `hilyfux` and imported another; the running
 * proxy kept serving with the deleted account's token until a manual restart.
 *
 * Behaviour:
 *   a) Every `intervalMs` (default 60s — the fleet's session-mirror tick;
 *      env COPILOT_CREDENTIAL_REFRESH_MS) re-run the gateway loader
 *      (v_proxy_accounts_v1, provider_type='copilot', non-empty access_token,
 *      disabled_at IS NULL, LRU order).
 *   b) Change = different account id OR different token (compared by sha256,
 *      never logged) → install it: the installer invalidates the cached
 *      ephemeral Copilot token first, so the next request re-exchanges. One
 *      log line: "copilot credential switched: #<old> → #<new>" (ids only).
 *      Sticky selection: while the current account stays eligible it is kept
 *      (LRU only picks when it is gone), so two healthy accounts do not
 *      flap the installed credential every tick as last_proxy_use_at moves.
 *   c) Current account deleted / disabled → next tick switches to another
 *      eligible account, or clears the credential (requests then get the
 *      existing clean 503 "no Copilot account", never the stale token).
 *      A local (env/file) credential is not cleared by an empty gateway — it
 *      is the documented fallback; a gateway account appearing still wins.
 *   d) Upstream auth failure → `reportAuthFailure()`: single-flight +
 *      debounced out-of-band re-read. If the DB still holds the rejected
 *      token it is re-exchanged once (an expired ephemeral token recovers
 *      here); if GitHub refuses that exchange (401/403) the token is marked
 *      bad IN MEMORY (by hash) and the next eligible account is tried. A bad
 *      mark disappears as soon as the DB carries a different token.
 *   e) Never crashes: a DB error keeps the last-good credential (fail-static)
 *      and is logged; errno 1356 (view/column grant broken) logs at error
 *      level. Timers are injectable and `stop()` clears them.
 *   f) In-flight requests keep the token they started with: they already
 *      built their Authorization header; only new requests see the swap.
 */
import { createHash } from "node:crypto"

import type { CopilotCredential } from "~/gateway/credentials"
import { HTTPError } from "~/lib/error"

export const DEFAULT_CREDENTIAL_REFRESH_MS = 60_000
export const DEFAULT_AUTH_FAILURE_DEBOUNCE_MS = 2_000
/**
 * A 403 on the token exchange is marked bad only for this long: Copilot also
 * emits short-lived `forbidden` bursts that recover in tens of seconds
 * (operator report 2026-08), which must not retire an account. A 401 stays
 * bad until the gateway holds a different token.
 */
export const FORBIDDEN_BAD_MARK_MS = 5 * 60_000

export function readCredentialRefreshMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number.parseInt(env.COPILOT_CREDENTIAL_REFRESH_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 1_000 ?
      parsed
    : DEFAULT_CREDENTIAL_REFRESH_MS
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

type Logger = {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
}

export type CredentialRefresherDeps = {
  /** All eligible gateway credentials, LRU first. Rejects on a DB fault. */
  list: () => Promise<CopilotCredential[]>
  /** Invalidate the ephemeral token and install this credential. Throws when GitHub refuses it. */
  install: (credential: CopilotCredential) => Promise<void>
  /** Drop the credential (→ requests answer 503 "no Copilot account"). */
  clear: () => void
  intervalMs?: number
  authFailureDebounceMs?: number
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  logger?: Logger
}

export type InitialCredential =
  | { kind: "gateway"; accountId: string; githubToken: string }
  | { kind: "local" }
  | { kind: "none" }

export type CopilotCredentialRefresher = {
  start(): void
  stop(): void
  /** One scheduled pass (also what the timer runs). */
  tick(): Promise<void>
  /** Re-read now (shares an in-flight pass). Used by the lazy token reloader. */
  refreshNow(): Promise<void>
  /** GitHub rejected the installed credential. Resolves true when a credential is installed afterwards. */
  reportAuthFailure(): Promise<boolean>
  currentAccountId(): string | null
}

function isAuthRejection(error: unknown): number | null {
  if (error instanceof HTTPError) {
    const status = error.response.status
    return status === 401 || status === 403 ? status : null
  }
  return null
}

function errnoOf(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno
  return typeof errno === "number" ? errno : undefined
}

export function createCopilotCredentialRefresher(
  deps: CredentialRefresherDeps,
  initial: InitialCredential = { kind: "none" },
): CopilotCredentialRefresher {
  const intervalMs = deps.intervalMs ?? DEFAULT_CREDENTIAL_REFRESH_MS
  const debounceMs =
    deps.authFailureDebounceMs ?? DEFAULT_AUTH_FAILURE_DEBOUNCE_MS
  const now = deps.now ?? (() => Date.now())
  const setTimer =
    deps.setInterval
    ?? ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      if (typeof handle.unref === "function") handle.unref()
      return handle
    })
  const clearTimer =
    deps.clearInterval
    ?? ((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>))
  const logger: Logger = deps.logger ?? {
    info: (m) => console.info(`[copilot-credential] ${m}`),
    warn: (m) => console.warn(`[copilot-credential] ${m}`),
    error: (m) => console.error(`[copilot-credential] ${m}`),
  }

  let current: { accountId: string; hash: string } | null =
    initial.kind === "gateway" ?
      { accountId: initial.accountId, hash: tokenHash(initial.githubToken) }
    : null
  // A local credential is the documented fallback: an empty gateway must not clear it.
  let localFallback = initial.kind === "local"
  /** token hash → bad-until (ms); +∞ for a 401. */
  const bad = new Map<string, number>()
  const isBad = (hash: string) => (bad.get(hash) ?? -1) > now()
  let inFlight: Promise<void> | null = null
  let timer: unknown = null
  let lastAuthAt = Number.NEGATIVE_INFINITY
  let lastAuthHash: string | null = null

  const label = (id: string | null | undefined) => `#${id ?? "(none)"}`

  function switched(from: string | null, to: string | null): void {
    logger.info(`copilot credential switched: ${label(from)} → ${label(to)}`)
  }

  async function pass(rejectedHash: string | null): Promise<void> {
    let rows: CopilotCredential[]
    try {
      rows = await deps.list()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (errnoOf(error) === 1356) {
        logger.error(
          `credential read FAILED with errno 1356 (v_proxy_accounts_v1 invalid for copilot_api — a column grant is missing); keeping the last-good credential: ${message}`,
        )
      } else {
        logger.warn(
          `credential read failed; keeping the last-good credential: ${message}`,
        )
      }
      return
    }

    // Forget bad marks for tokens the gateway no longer holds (bounded memory).
    const present = new Set(rows.map((r) => tokenHash(r.githubToken)))
    for (const hash of bad.keys()) {
      if (!present.has(hash) || !isBad(hash)) bad.delete(hash)
    }

    const eligible = rows.filter((r) => !isBad(tokenHash(r.githubToken)))
    const sticky =
      current ?
        eligible.find((r) => r.accountId === current?.accountId)
      : undefined
    const forceReinstall =
      rejectedHash !== null
      && sticky !== undefined
      && tokenHash(sticky.githubToken) === rejectedHash

    if (
      sticky
      && current
      && tokenHash(sticky.githubToken) === current.hash
      && !forceReinstall
    ) {
      return // unchanged
    }

    const candidates =
      sticky ? [sticky, ...eligible.filter((r) => r !== sticky)] : eligible

    if (candidates.length === 0) {
      if (current || !localFallback) {
        if (current) {
          switched(current.accountId, null)
          deps.clear()
        }
        current = null
      }
      return
    }

    const previous = current?.accountId ?? null
    for (const candidate of candidates) {
      const hash = tokenHash(candidate.githubToken)
      try {
        await deps.install(candidate)
      } catch (error) {
        const status = isAuthRejection(error)
        if (status !== null) {
          bad.set(
            hash,
            status === 401 ?
              Number.POSITIVE_INFINITY
            : now() + FORBIDDEN_BAD_MARK_MS,
          )
          logger.warn(
            `GitHub rejected the credential of ${label(candidate.accountId)} (HTTP ${status}); marked bad in memory, trying the next eligible account`,
          )
          continue
        }
        // Transient (network) failure: the installer already invalidated the
        // old ephemeral token; the lazy reloader / next tick retries.
        logger.warn(
          `installing ${label(candidate.accountId)} failed (will retry): ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        current = { accountId: candidate.accountId, hash: "" }
        localFallback = false
        return
      }
      current = { accountId: candidate.accountId, hash }
      localFallback = false
      if (previous !== candidate.accountId || !forceReinstall) {
        switched(previous, candidate.accountId)
      }
      return
    }

    // Every candidate was refused by GitHub.
    switched(previous, null)
    deps.clear()
    current = null
    localFallback = false
  }

  function run(rejectedHash: string | null): Promise<void> {
    if (!inFlight) {
      inFlight = pass(rejectedHash)
        .catch((error: unknown) => {
          logger.error(
            `credential refresh pass crashed (ignored): ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        })
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }

  return {
    start() {
      if (timer !== null) return
      timer = setTimer(() => void run(null), intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
    tick: () => run(null),
    refreshNow: () => run(null),
    async reportAuthFailure() {
      const rejected = current?.hash ?? null
      if (inFlight) await inFlight
      if (!rejected || current?.hash !== rejected) {
        return current !== null
      }
      if (lastAuthHash === rejected && now() - lastAuthAt < debounceMs) {
        return current !== null
      }
      lastAuthAt = now()
      lastAuthHash = rejected
      await run(rejected)
      return current !== null
    },
    currentAccountId: () => current?.accountId ?? null,
  }
}
