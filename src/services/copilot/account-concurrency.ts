/**
 * account-concurrency.ts — wires the per-account limiter
 * (lib/account-concurrency-limiter.ts) around every GitHub Copilot upstream
 * exchange (chat/completions, /v1/messages, /responses HTTP + websocket — and
 * therefore every translation path built on them: messages→chat/responses,
 * chat→responses, web-search fulfil, alpha-search).
 *
 * Account key = the provider_accounts id serving right now
 * (lib/serving-account.ts); a CLI/env/file token has no id and shares the key
 * "local". The key is read in the same synchronous step as the Authorization
 * header is built, so the slot and the token always belong to the same
 * account; a later credential swap does not move the lease.
 *
 * Holding: the slot is held for the WHOLE upstream exchange. Callers release
 * it in `finally` for non-streaming answers, and hand streaming answers to
 * `holdSlotUntilStreamEnds`, which releases on end / error / consumer
 * return() / client abort (the last also covers a stream nobody ever
 * iterates). The limiter's max-hold reclaim is the last-resort net.
 *
 * Only one Copilot credential is installed at a time today (the credential
 * refresher keeps a sticky single account), so "prefer an account with free
 * slots" has nothing to choose between yet; when multi-account serving lands,
 * the selection should consult `snapshot()` before queueing.
 */
import consola from "consola"

import {
  createAccountConcurrencyLimiter,
  readConcurrencyLimits,
  type AccountConcurrencyLimiter,
  type AccountConcurrencySnapshot,
  type SlotLease,
} from "~/lib/account-concurrency-limiter"
import { getServingCopilotAccountId } from "~/lib/serving-account"

const LOCAL_ACCOUNT_KEY = "local"

const logger = {
  info: (message: string) => consola.info(message),
  warn: (message: string) => consola.warn(message),
}

export const copilotConcurrencyDependencies: {
  env: NodeJS.ProcessEnv
  limiter: AccountConcurrencyLimiter | null
} = {
  env: process.env,
  limiter: null,
}

export function getCopilotConcurrencyLimiter(): AccountConcurrencyLimiter {
  if (!copilotConcurrencyDependencies.limiter) {
    const limits = readConcurrencyLimits(
      copilotConcurrencyDependencies.env,
      logger,
    )
    copilotConcurrencyDependencies.limiter = createAccountConcurrencyLimiter(
      limits,
      { logger },
    )
  }
  return copilotConcurrencyDependencies.limiter
}

/** Swap in a limiter (tests) or `null` to rebuild from env on next use. */
export function setCopilotConcurrencyLimiter(
  limiter: AccountConcurrencyLimiter | null,
): void {
  copilotConcurrencyDependencies.limiter = limiter
}

export function servingAccountKey(): string {
  return getServingCopilotAccountId() ?? LOCAL_ACCOUNT_KEY
}

/**
 * A slot on the account serving right now: the lease itself when one is free
 * (synchronous — the uncontended path adds no await, so request timing is
 * unchanged), otherwise a promise that waits FIFO, bounded by the max wait.
 * Callers: `const p = acquire…(); const lease = p instanceof Promise ? await p : p`.
 */
export function acquireCopilotUpstreamSlot(
  model: string,
  clientSignal?: AbortSignal,
): SlotLease | Promise<SlotLease> {
  const limiter = getCopilotConcurrencyLimiter()
  const key = servingAccountKey()
  return (
    limiter.tryAcquire(key, model) ?? limiter.acquire(key, model, clientSignal)
  )
}

/** Runtime view for /health — ids and counts only. */
export function copilotConcurrencySnapshot(): Array<AccountConcurrencySnapshot> {
  return copilotConcurrencyDependencies.limiter?.snapshot() ?? []
}

/**
 * Hold `lease` until the stream is finished with, however that happens. The
 * returned generator owns the lease: it is released exactly once on normal
 * end, on error, on the consumer's return() (break), or when `clientSignal`
 * aborts — including before the first next(), which a plain generator's
 * `finally` would never see.
 */
export function holdSlotUntilStreamEnds<T>(
  source: AsyncIterable<T>,
  lease: SlotLease,
  clientSignal?: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  const onAbort = () => lease.release()
  const release = () => {
    clientSignal?.removeEventListener("abort", onAbort)
    lease.release()
  }
  if (clientSignal?.aborted) {
    release()
  } else {
    clientSignal?.addEventListener("abort", onAbort, { once: true })
  }

  const inner = (async function* () {
    try {
      yield* source
    } finally {
      release()
    }
  })()

  // return() on a not-yet-started generator skips its `finally`; release
  // explicitly so `stream.return()` always frees the slot.
  const originalReturn = inner.return.bind(inner)
  inner.return = (value) => {
    release()
    return originalReturn(value)
  }
  return inner
}
