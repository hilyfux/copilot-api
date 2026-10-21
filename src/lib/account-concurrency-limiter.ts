/**
 * account-concurrency-limiter.ts — per-upstream-ACCOUNT concurrency limiter.
 *
 * Why (operator measurement 2026-10): one GitHub Copilot account is safe at 40
 * concurrent upstream requests; at 60 it starts answering 429 (no rate-limit
 * headers at all) and at 100 every request fails; claude-opus-5 tolerates
 * only 20. Protecting the account means bounding how many requests are in
 * flight ON IT — not how many a client sends.
 *
 * Hard operator rule (2026-08-19, "请求并发绝不能限制"): a client key's
 * in-flight count is NEVER capped or rejected on arrival — clients fan out
 * sub-agents in parallel. So this limiter does not reject: over the cap a
 * request WAITS in a FIFO queue for a free slot, and only after a bounded wait
 * (default 120 s) does it fail with an overloaded answer + Retry-After. 120 s
 * follows the fleet's overload spirit ("upstream overloaded is not passed
 * straight through"): codex-api absorbs overload with ~10×30 s retries on
 * /v1/messages; 120 s is long enough for a sub-agent burst to drain through a
 * 40-slot account, short enough to stay inside client/ingress timeouts.
 *
 * Model:
 *   · one state per account key: in-flight total, in-flight per model, FIFO
 *     queue of waiters.
 *   · a request fits when account in-flight < accountMax AND its model's
 *     in-flight < modelMax(model) (models count against both).
 *   · dispatch walks the queue in arrival order and grants every waiter that
 *     fits — FIFO among waiters that fit, and a waiter blocked only by its own
 *     model cap does not head-of-line-block other models.
 *   · a lease belongs to the account it was acquired on (captured at grant);
 *     release() is idempotent, so a credential swap mid-flight can neither
 *     leak nor double-release.
 *   · safety net: a lease still held after maxHoldMs (default 30 min) is
 *     reclaimed with a warning — a bug elsewhere can never permanently eat an
 *     account's capacity.
 *
 * Pure module: clock/timers and logger are injected (tests use a fake clock).
 * Logs carry account keys (provider_accounts ids) and counts only — never
 * credentials.
 */

export const DEFAULT_ACCOUNT_MAX_CONCURRENCY = 40
export const DEFAULT_MODEL_MAX_CONCURRENCY: ReadonlyArray<
  readonly [string, number]
> = [["claude-opus-5", 20]]
export const DEFAULT_QUEUE_MAX_WAIT_MS = 120_000
export const DEFAULT_SLOT_MAX_HOLD_MS = 30 * 60_000
/** Fleet value: codex-api's final overload answer carries Retry-After: 10. */
export const OVERLOAD_RETRY_AFTER_SECONDS = 10

const MAX_CONCURRENCY_VALUE = 100_000
const MAX_DURATION_MS = 24 * 60 * 60_000
const DEFAULT_LOG_INTERVAL_MS = 10_000

export interface ConcurrencyLimits {
  /** 0 = no account cap. */
  accountMax: number
  /** lower-cased model id → cap; 0 = no cap for that model. */
  modelMax: ReadonlyMap<string, number>
  maxWaitMs: number
  /** 0 = never reclaim. */
  maxHoldMs: number
  retryAfterSeconds: number
}

export interface LimiterClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface LimiterLogger {
  info: (message: string) => void
  warn: (message: string) => void
}

export interface SlotLease {
  readonly accountKey: string
  readonly model: string
  readonly released: boolean
  release: () => void
}

export interface AccountConcurrencySnapshot {
  account: string
  inFlight: number
  queued: number
  models: Record<string, number>
}

export interface AccountConcurrencyLimiter {
  readonly limits: ConcurrencyLimits
  acquire: (
    accountKey: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<SlotLease>
  /**
   * Synchronous fast path: a lease when nobody waits ahead and it fits, else
   * null (then call `acquire` to queue). Lets callers skip a microtask hop on
   * the uncontended path.
   */
  tryAcquire: (accountKey: string, model: string) => SlotLease | null
  snapshot: () => Array<AccountConcurrencySnapshot>
}

export class AccountConcurrencyOverloadedError extends Error {
  readonly accountKey: string
  readonly model: string
  readonly waitedMs: number
  readonly retryAfterSeconds: number

  constructor(input: {
    accountKey: string
    model: string
    waitedMs: number
    retryAfterSeconds: number
    accountMax: number
  }) {
    const seconds = Math.round(input.waitedMs / 1000)
    super(
      `The upstream Copilot account is at its concurrency limit${input.accountMax > 0 ? ` (${input.accountMax} requests in flight)` : ""}; this request waited ${seconds}s in queue without a free slot. Please retry in ${input.retryAfterSeconds}s.`,
    )
    this.name = "AccountConcurrencyOverloadedError"
    this.accountKey = input.accountKey
    this.model = input.model
    this.waitedMs = input.waitedMs
    this.retryAfterSeconds = input.retryAfterSeconds
  }
}

// ── env parsing ──────────────────────────────────────────────────────────────

function parseNonNegativeInt(raw: string, max: number): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/u.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value <= max ? value : null
}

function parseModelMap(raw: string): Map<string, number> | null {
  const map = new Map<string, number>()
  for (const part of raw.split(",")) {
    if (!part.trim()) continue
    const eq = part.indexOf("=")
    if (eq <= 0) return null
    const model = part.slice(0, eq).trim().toLowerCase()
    const cap = parseNonNegativeInt(part.slice(eq + 1), MAX_CONCURRENCY_VALUE)
    if (!model || cap === null) return null
    map.set(model, cap)
  }
  return map
}

/**
 * Env knobs (all optional; a bad value logs a warning and uses the default —
 * never a crash):
 *   COPILOT_ACCOUNT_MAX_CONCURRENCY   integer ≥0, default 40, 0 = no cap
 *   COPILOT_MODEL_MAX_CONCURRENCY     "model=n,model=n", default
 *                                     "claude-opus-5=20"; set-but-empty = no
 *                                     per-model caps; n=0 = no cap for it
 *   COPILOT_ACCOUNT_QUEUE_MAX_WAIT_MS integer ≥1, default 120000
 *   COPILOT_ACCOUNT_SLOT_MAX_HOLD_MS  integer ≥0, default 1800000, 0 = never
 */
export function readConcurrencyLimits(
  env: NodeJS.ProcessEnv,
  logger: LimiterLogger,
): ConcurrencyLimits {
  const intKnob = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = env[name]
    if (raw === undefined) return fallback
    const value = parseNonNegativeInt(raw, max)
    if (value === null || value < min) {
      logger.warn(
        `[copilot-concurrency] ${name}=${JSON.stringify(raw)} is invalid (integer ${min}..${max}); using default ${fallback}`,
      )
      return fallback
    }
    return value
  }

  let modelMax = new Map(DEFAULT_MODEL_MAX_CONCURRENCY)
  const rawModels = env.COPILOT_MODEL_MAX_CONCURRENCY
  if (rawModels !== undefined) {
    const parsed = parseModelMap(rawModels)
    if (parsed) {
      modelMax = parsed
    } else {
      logger.warn(
        `[copilot-concurrency] COPILOT_MODEL_MAX_CONCURRENCY=${JSON.stringify(rawModels)} is invalid (expected "model=n,model=n"); using default ${DEFAULT_MODEL_MAX_CONCURRENCY.map(([m, n]) => `${m}=${n}`).join(",")}`,
      )
    }
  }

  return {
    accountMax: intKnob(
      "COPILOT_ACCOUNT_MAX_CONCURRENCY",
      DEFAULT_ACCOUNT_MAX_CONCURRENCY,
      0,
      MAX_CONCURRENCY_VALUE,
    ),
    modelMax,
    maxWaitMs: intKnob(
      "COPILOT_ACCOUNT_QUEUE_MAX_WAIT_MS",
      DEFAULT_QUEUE_MAX_WAIT_MS,
      1,
      MAX_DURATION_MS,
    ),
    maxHoldMs: intKnob(
      "COPILOT_ACCOUNT_SLOT_MAX_HOLD_MS",
      DEFAULT_SLOT_MAX_HOLD_MS,
      0,
      MAX_DURATION_MS,
    ),
    retryAfterSeconds: OVERLOAD_RETRY_AFTER_SECONDS,
  }
}

// ── limiter ──────────────────────────────────────────────────────────────────

interface Waiter {
  model: string
  enqueuedAt: number
  grant: () => void
  cancel: () => void
}

interface AccountState {
  inFlight: number
  models: Map<string, number>
  queue: Array<Waiter>
  /** Rate-limit bookkeeping for the three log kinds. */
  lastLogAt: { queue: number; dequeue: number; timeout: number }
  suppressed: { dequeue: number; timeout: number }
}

const realClock: LimiterClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // Never keep the process alive just for a queue/hold timer.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function abortError(): Error {
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

export function createAccountConcurrencyLimiter(
  limits: ConcurrencyLimits,
  deps: {
    clock?: LimiterClock
    logger?: LimiterLogger
    logIntervalMs?: number
  } = {},
): AccountConcurrencyLimiter {
  const clock = deps.clock ?? realClock
  const logger = deps.logger ?? { info: () => {}, warn: () => {} }
  const logIntervalMs = deps.logIntervalMs ?? DEFAULT_LOG_INTERVAL_MS
  const accounts = new Map<string, AccountState>()

  const modelCap = (model: string): number => limits.modelMax.get(model) ?? 0

  const fits = (account: AccountState, model: string): boolean => {
    if (limits.accountMax > 0 && account.inFlight >= limits.accountMax) {
      return false
    }
    const cap = modelCap(model)
    return cap <= 0 || (account.models.get(model) ?? 0) < cap
  }

  const stateFor = (key: string): AccountState => {
    let account = accounts.get(key)
    if (!account) {
      account = {
        inFlight: 0,
        models: new Map(),
        queue: [],
        lastLogAt: {
          queue: Number.NEGATIVE_INFINITY,
          dequeue: Number.NEGATIVE_INFINITY,
          timeout: Number.NEGATIVE_INFINITY,
        },
        suppressed: { dequeue: 0, timeout: 0 },
      }
      accounts.set(key, account)
    }
    return account
  }

  const gc = (key: string, account: AccountState) => {
    if (account.inFlight === 0 && account.queue.length === 0) {
      accounts.delete(key)
    }
  }

  const describe = (key: string, account: AccountState, model: string) => {
    const cap = modelCap(model)
    const accountPart = `in-flight ${account.inFlight}/${limits.accountMax > 0 ? limits.accountMax : "∞"}`
    const modelPart =
      cap > 0 ? `, ${model} ${account.models.get(model) ?? 0}/${cap}` : ""
    return `copilot account #${key}: ${accountPart}${modelPart}`
  }

  const due = (
    account: AccountState,
    kind: "queue" | "dequeue" | "timeout",
  ) => {
    const now = clock.now()
    if (now - account.lastLogAt[kind] < logIntervalMs) return false
    account.lastLogAt[kind] = now
    return true
  }

  const take = (
    key: string,
    account: AccountState,
    model: string,
  ): SlotLease => {
    account.inFlight += 1
    account.models.set(model, (account.models.get(model) ?? 0) + 1)
    let released = false
    let holdTimer: unknown = null

    const release = () => {
      if (released) return
      released = true
      if (holdTimer !== null) clock.clearTimeout(holdTimer)
      account.inFlight -= 1
      const left = (account.models.get(model) ?? 1) - 1
      if (left > 0) account.models.set(model, left)
      else account.models.delete(model)
      dispatch(account)
      gc(key, account)
    }

    if (limits.maxHoldMs > 0) {
      holdTimer = clock.setTimeout(() => {
        holdTimer = null
        if (released) return
        logger.warn(
          `[copilot-concurrency] copilot account #${key}: reclaimed a ${model} slot still held after ${limits.maxHoldMs}ms (a stream was never closed)`,
        )
        release()
      }, limits.maxHoldMs)
    }

    return {
      accountKey: key,
      model,
      get released() {
        return released
      },
      release,
    }
  }

  function dispatch(account: AccountState): void {
    for (let i = 0; i < account.queue.length; ) {
      if (limits.accountMax > 0 && account.inFlight >= limits.accountMax) return
      const waiter = account.queue[i]
      if (waiter && fits(account, waiter.model)) {
        account.queue.splice(i, 1)
        waiter.grant()
        continue
      }
      i += 1
    }
  }

  const normalize = (model: string) => model.trim().toLowerCase()

  const tryAcquire = (key: string, rawModel: string): SlotLease | null => {
    const model = normalize(rawModel)
    const existing = accounts.get(key)
    if (existing && (existing.queue.length > 0 || !fits(existing, model))) {
      return null
    }
    return take(key, existing ?? stateFor(key), model)
  }

  const acquire = (
    key: string,
    rawModel: string,
    signal?: AbortSignal,
  ): Promise<SlotLease> => {
    const model = normalize(rawModel)
    if (signal?.aborted) return Promise.reject(abortError())
    const fast = tryAcquire(key, model)
    if (fast) return Promise.resolve(fast)
    const account = stateFor(key)

    return new Promise<SlotLease>((resolve, reject) => {
      const enqueuedAt = clock.now()
      let waitTimer: unknown = null
      let onAbort: (() => void) | null = null

      const cleanup = () => {
        if (waitTimer !== null) clock.clearTimeout(waitTimer)
        waitTimer = null
        if (onAbort) signal?.removeEventListener("abort", onAbort)
        onAbort = null
      }

      const leave = () => {
        const index = account.queue.indexOf(waiter)
        if (index >= 0) account.queue.splice(index, 1)
      }

      const waiter: Waiter = {
        model,
        enqueuedAt,
        grant: () => {
          cleanup()
          const waitedMs = clock.now() - enqueuedAt
          const lease = take(key, account, model)
          if (due(account, "dequeue")) {
            const extra =
              account.suppressed.dequeue > 0 ?
                ` (+${account.suppressed.dequeue} more dequeued since last log)`
              : ""
            account.suppressed.dequeue = 0
            logger.info(
              `[copilot-concurrency] ${describe(key, account, model)}: dequeued after ${waitedMs}ms wait; queue depth ${account.queue.length}${extra}`,
            )
          } else {
            account.suppressed.dequeue += 1
          }
          resolve(lease)
        },
        cancel: () => {
          cleanup()
          leave()
          gc(key, account)
          reject(abortError())
        },
      }

      waitTimer = clock.setTimeout(() => {
        waitTimer = null
        cleanup()
        leave()
        const waitedMs = clock.now() - enqueuedAt
        if (due(account, "timeout")) {
          const extra =
            account.suppressed.timeout > 0 ?
              ` (+${account.suppressed.timeout} more since last log)`
            : ""
          account.suppressed.timeout = 0
          logger.warn(
            `[copilot-concurrency] ${describe(key, account, model)}: gave up after ${waitedMs}ms in queue → overloaded; queue depth ${account.queue.length}${extra}`,
          )
        } else {
          account.suppressed.timeout += 1
        }
        gc(key, account)
        reject(
          new AccountConcurrencyOverloadedError({
            accountKey: key,
            model,
            waitedMs,
            retryAfterSeconds: limits.retryAfterSeconds,
            accountMax: limits.accountMax,
          }),
        )
      }, limits.maxWaitMs)

      if (signal) {
        onAbort = () => waiter.cancel()
        signal.addEventListener("abort", onAbort, { once: true })
      }

      account.queue.push(waiter)
      dispatch(account)
      if (account.queue.includes(waiter) && due(account, "queue")) {
        logger.info(
          `[copilot-concurrency] ${describe(key, account, model)}: full — queueing; queue depth ${account.queue.length}`,
        )
      }
    })
  }

  const snapshot = (): Array<AccountConcurrencySnapshot> =>
    [...accounts].map(([account, s]) => ({
      account,
      inFlight: s.inFlight,
      queued: s.queue.length,
      models: Object.fromEntries(s.models),
    }))

  return { limits, acquire, tryAcquire, snapshot }
}
