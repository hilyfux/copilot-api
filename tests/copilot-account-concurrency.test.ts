/**
 * Per-upstream-ACCOUNT concurrency limiter (operator measurement 2026-10:
 * one Copilot account is safe at 40 concurrent upstream requests, 60 starts
 * answering 429 with no rate-limit headers, 100 all fail; claude-opus-5 only
 * 20). The limiter protects the ACCOUNT — it never caps or rejects a client
 * key on arrival (operator rule 2026-08-19 "请求并发绝不能限制"): over the cap
 * a request QUEUES (FIFO) and only fails after a bounded wait.
 *
 * Every test runs on a fake clock: no real timers, deterministic.
 */
import { describe, expect, test } from "bun:test"

import {
  AccountConcurrencyOverloadedError,
  createAccountConcurrencyLimiter,
  DEFAULT_ACCOUNT_MAX_CONCURRENCY,
  DEFAULT_QUEUE_MAX_WAIT_MS,
  DEFAULT_SLOT_MAX_HOLD_MS,
  readConcurrencyLimits,
  type ConcurrencyLimits,
  type LimiterClock,
  type SlotLease,
} from "~/lib/account-concurrency-limiter"
import { holdSlotUntilStreamEnds } from "~/services/copilot/account-concurrency"

class FakeClock implements LimiterClock {
  private current = 0
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.current + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry
        }
      }
      if (!next) break
      this.timers.delete(next[0])
      this.current = next[1].at
      next[1].fn()
    }
    this.current = target
  }

  pending(): number {
    return this.timers.size
  }
}

const silent = { info: () => {}, warn: () => {} }

function limits(over: Partial<ConcurrencyLimits> = {}): ConcurrencyLimits {
  return {
    accountMax: 40,
    modelMax: new Map([["claude-opus-5", 20]]),
    maxWaitMs: 120_000,
    maxHoldMs: 0,
    retryAfterSeconds: 10,
    ...over,
  }
}

function makeLimiter(over: Partial<ConcurrencyLimits> = {}) {
  const clock = new FakeClock()
  const logs: Array<string> = []
  const limiter = createAccountConcurrencyLimiter(limits(over), {
    clock,
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
    },
    logIntervalMs: 10_000,
  })
  return { clock, limiter, logs }
}

/** Resolve-state probe without awaiting forever. */
function track<T>(promise: Promise<T>) {
  const box: { value?: T; error?: unknown; settled: boolean } = {
    settled: false,
  }
  promise.then(
    (value) => {
      box.value = value
      box.settled = true
    },
    (error: unknown) => {
      box.error = error
      box.settled = true
    },
  )
  return box
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe("readConcurrencyLimits — env knobs", () => {
  test("defaults: account 40, claude-opus-5=20, wait 120s, hold 30min", () => {
    const parsed = readConcurrencyLimits({}, silent)
    expect(parsed.accountMax).toBe(DEFAULT_ACCOUNT_MAX_CONCURRENCY)
    expect(parsed.accountMax).toBe(40)
    expect([...parsed.modelMax]).toEqual([["claude-opus-5", 20]])
    expect(parsed.maxWaitMs).toBe(DEFAULT_QUEUE_MAX_WAIT_MS)
    expect(parsed.maxWaitMs).toBe(120_000)
    expect(parsed.maxHoldMs).toBe(DEFAULT_SLOT_MAX_HOLD_MS)
    expect(parsed.retryAfterSeconds).toBe(10)
  })

  test("valid overrides are honoured (model ids case-insensitive)", () => {
    const parsed = readConcurrencyLimits(
      {
        COPILOT_ACCOUNT_MAX_CONCURRENCY: "25",
        COPILOT_MODEL_MAX_CONCURRENCY: " Claude-Opus-5 = 8 , gpt-6=12 ",
        COPILOT_ACCOUNT_QUEUE_MAX_WAIT_MS: "5000",
        COPILOT_ACCOUNT_SLOT_MAX_HOLD_MS: "0",
      },
      silent,
    )
    expect(parsed.accountMax).toBe(25)
    expect([...parsed.modelMax]).toEqual([
      ["claude-opus-5", 8],
      ["gpt-6", 12],
    ])
    expect(parsed.maxWaitMs).toBe(5000)
    expect(parsed.maxHoldMs).toBe(0)
  })

  test("bad values → warning + default, never a throw", () => {
    const warnings: Array<string> = []
    const parsed = readConcurrencyLimits(
      {
        COPILOT_ACCOUNT_MAX_CONCURRENCY: "forty",
        COPILOT_MODEL_MAX_CONCURRENCY: "claude-opus-5=-3,=4",
        COPILOT_ACCOUNT_QUEUE_MAX_WAIT_MS: "0",
        COPILOT_ACCOUNT_SLOT_MAX_HOLD_MS: "1.5",
      },
      { info: () => {}, warn: (m) => warnings.push(m) },
    )
    expect(parsed.accountMax).toBe(40)
    expect([...parsed.modelMax]).toEqual([["claude-opus-5", 20]])
    expect(parsed.maxWaitMs).toBe(120_000)
    expect(parsed.maxHoldMs).toBe(DEFAULT_SLOT_MAX_HOLD_MS)
    expect(warnings).toHaveLength(4)
    for (const w of warnings) expect(w).toContain("default")
  })

  test("other bad shapes also fall back (negative / float / huge)", () => {
    for (const raw of ["-1", "2.5", "1e3", "999999999999", " "]) {
      const parsed = readConcurrencyLimits(
        { COPILOT_ACCOUNT_MAX_CONCURRENCY: raw },
        silent,
      )
      expect(parsed.accountMax).toBe(40)
    }
  })

  test("explicitly empty model map = no per-model caps; 0 = disabled", () => {
    const parsed = readConcurrencyLimits(
      {
        COPILOT_ACCOUNT_MAX_CONCURRENCY: "0",
        COPILOT_MODEL_MAX_CONCURRENCY: "",
      },
      silent,
    )
    expect(parsed.accountMax).toBe(0)
    expect(parsed.modelMax.size).toBe(0)
  })
})

describe("account cap", () => {
  test("cap respected under N concurrent: the 41st waits, proceeds when one finishes", async () => {
    const { limiter } = makeLimiter()
    const leases: Array<SlotLease> = []
    for (let i = 0; i < 40; i++) {
      leases.push(await limiter.acquire("acct-1", "gpt-4o"))
    }
    const forty1 = track(limiter.acquire("acct-1", "gpt-4o"))
    await flush()
    expect(forty1.settled).toBe(false)
    expect(limiter.snapshot()).toEqual([
      { account: "acct-1", inFlight: 40, queued: 1, models: { "gpt-4o": 40 } },
    ])

    leases[0]?.release()
    await flush()
    expect(forty1.settled).toBe(true)
    expect(forty1.value?.accountKey).toBe("acct-1")
    expect(limiter.snapshot()[0]?.inFlight).toBe(40)
    expect(limiter.snapshot()[0]?.queued).toBe(0)
  })

  test("accounts are independent: a full account does not block another", async () => {
    const { limiter } = makeLimiter({ accountMax: 2 })
    await limiter.acquire("a", "m")
    await limiter.acquire("a", "m")
    const other = track(limiter.acquire("b", "m"))
    await flush()
    expect(other.settled).toBe(true)
  })

  test("release is idempotent: a double release never frees two slots", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const first = await limiter.acquire("a", "m")
    const second = track(limiter.acquire("a", "m"))
    const third = track(limiter.acquire("a", "m"))
    first.release()
    first.release()
    await flush()
    expect(second.settled).toBe(true)
    expect(third.settled).toBe(false)
    expect(limiter.snapshot()[0]?.inFlight).toBe(1)
  })
})

describe("per-model cap inside the account cap", () => {
  test("claude-opus-5 is capped at 20 while the account still has room", async () => {
    const { limiter } = makeLimiter()
    for (let i = 0; i < 20; i++) await limiter.acquire("a", "claude-opus-5")
    const opus21 = track(limiter.acquire("a", "claude-opus-5"))
    // Other models keep flowing up to the account cap (40 total).
    const others: Array<SlotLease> = []
    for (let i = 0; i < 20; i++)
      others.push(await limiter.acquire("a", "gpt-4o"))
    const other41 = track(limiter.acquire("a", "gpt-4o"))
    await flush()
    expect(opus21.settled).toBe(false)
    expect(other41.settled).toBe(false)
    expect(limiter.snapshot()[0]).toEqual({
      account: "a",
      inFlight: 40,
      queued: 2,
      models: { "claude-opus-5": 20, "gpt-4o": 20 },
    })

    // A non-opus slot frees: opus is still at its own cap, so the slot goes to
    // the next waiter that FITS (the gpt-4o one), not blocked behind opus.
    others[0]?.release()
    await flush()
    expect(other41.settled).toBe(true)
    expect(opus21.settled).toBe(false)
  })

  test("model ids match case-insensitively", async () => {
    const { limiter } = makeLimiter({
      accountMax: 0,
      modelMax: new Map([["claude-opus-5", 1]]),
    })
    await limiter.acquire("a", "Claude-Opus-5")
    const second = track(limiter.acquire("a", "claude-opus-5"))
    await flush()
    expect(second.settled).toBe(false)
  })
})

describe("FIFO fairness", () => {
  test("waiters are served strictly in arrival order", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const holder = await limiter.acquire("a", "m")
    const order: Array<number> = []
    const waiters = [1, 2, 3, 4, 5].map((n) =>
      limiter.acquire("a", "m").then((lease) => {
        order.push(n)
        return lease
      }),
    )
    let current = holder
    for (let i = 0; i < 5; i++) {
      current.release()
      current = await waiters[i]
    }
    current.release()
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  test("a new arrival never jumps ahead of an earlier waiter that fits", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const holder = await limiter.acquire("a", "m")
    const early = track(limiter.acquire("a", "m"))
    holder.release()
    const late = track(limiter.acquire("a", "m"))
    await flush()
    expect(early.settled).toBe(true)
    expect(late.settled).toBe(false)
  })
})

describe("bounded wait", () => {
  test("max wait → overloaded error carrying Retry-After and the waited time", async () => {
    const { limiter, clock } = makeLimiter({
      accountMax: 1,
      maxWaitMs: 120_000,
    })
    await limiter.acquire("a", "m")
    const waiter = track(limiter.acquire("a", "m"))
    clock.advance(119_999)
    await flush()
    expect(waiter.settled).toBe(false)
    clock.advance(1)
    await flush()
    expect(waiter.error).toBeInstanceOf(AccountConcurrencyOverloadedError)
    const error = waiter.error as AccountConcurrencyOverloadedError
    expect(error.retryAfterSeconds).toBe(10)
    expect(error.waitedMs).toBe(120_000)
    expect(error.message).toContain("waited 120s")
    // The timed-out waiter left the queue; nothing was acquired for it.
    expect(limiter.snapshot()[0]).toMatchObject({ inFlight: 1, queued: 0 })
  })

  test("no timer stays armed once a waiter is granted", async () => {
    const { limiter, clock } = makeLimiter({ accountMax: 1 })
    const holder = await limiter.acquire("a", "m")
    const waiter = track(limiter.acquire("a", "m"))
    holder.release()
    await flush()
    expect(waiter.settled).toBe(true)
    ;(waiter.value as SlotLease).release()
    expect(clock.pending()).toBe(0)
  })
})

describe("client abort", () => {
  test("abort while queued removes the waiter and releases nothing", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const holder = await limiter.acquire("a", "m")
    const controller = new AbortController()
    const aborted = track(limiter.acquire("a", "m", controller.signal))
    const next = track(limiter.acquire("a", "m"))
    controller.abort()
    await flush()
    expect((aborted.error as Error).name).toBe("AbortError")
    expect(limiter.snapshot()[0]).toMatchObject({ inFlight: 1, queued: 1 })

    holder.release()
    await flush()
    expect(next.settled).toBe(true)
    expect(limiter.snapshot()[0]).toMatchObject({ inFlight: 1, queued: 0 })
  })

  test("an already-aborted signal is refused without taking a slot", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const controller = new AbortController()
    controller.abort()
    const result = track(limiter.acquire("a", "m", controller.signal))
    await flush()
    expect((result.error as Error).name).toBe("AbortError")
    expect(limiter.snapshot()).toEqual([])
  })
})

describe("disabled", () => {
  test("cap 0 and no model caps → 1000 concurrent all granted at once", async () => {
    const { limiter } = makeLimiter({ accountMax: 0, modelMax: new Map() })
    const leases = await Promise.all(
      Array.from({ length: 1000 }, () => limiter.acquire("a", "claude-opus-5")),
    )
    expect(leases).toHaveLength(1000)
    for (const lease of leases) lease.release()
    expect(limiter.snapshot()).toEqual([])
  })

  test("model cap 0 disables that model's cap only", async () => {
    const { limiter } = makeLimiter({
      accountMax: 2,
      modelMax: new Map([["claude-opus-5", 0]]),
    })
    await limiter.acquire("a", "claude-opus-5")
    await limiter.acquire("a", "claude-opus-5")
    const third = track(limiter.acquire("a", "claude-opus-5"))
    await flush()
    expect(third.settled).toBe(false)
  })
})

describe("leak protection", () => {
  test("1000 mixed calls (success / error / abort / stream-abort) leave zero in flight", async () => {
    const { limiter } = makeLimiter({ accountMax: 7 })
    const tasks: Array<Promise<unknown>> = []
    for (let i = 0; i < 1000; i++) {
      const model = i % 3 === 0 ? "claude-opus-5" : "gpt-4o"
      const kind = i % 4
      const controller = new AbortController()
      tasks.push(
        (async () => {
          if (kind === 2 && i % 8 === 2) controller.abort()
          let lease: SlotLease
          try {
            lease = await limiter.acquire("a", model, controller.signal)
          } catch {
            return
          }
          if (kind === 0) {
            try {
              await flush()
            } finally {
              lease.release()
            }
          } else if (kind === 1) {
            try {
              await flush()
              throw new Error("upstream boom")
            } catch {
              // expected
            } finally {
              lease.release()
            }
          } else {
            async function* source() {
              yield 1
              await flush()
              yield 2
              yield 3
            }
            const stream = holdSlotUntilStreamEnds(
              source(),
              lease,
              controller.signal,
            )
            for await (const value of stream) {
              if (kind === 3 && value === 1) break
              if (kind === 2 && value === 2) controller.abort()
            }
          }
        })(),
      )
    }
    await Promise.all(tasks)
    expect(limiter.snapshot()).toEqual([])
  })

  test("a lease nobody releases is reclaimed after the max hold time", async () => {
    const { limiter, clock, logs } = makeLimiter({
      accountMax: 1,
      maxHoldMs: 60_000,
    })
    await limiter.acquire("a", "m")
    const waiter = track(limiter.acquire("a", "m"))
    clock.advance(60_000)
    await flush()
    expect(waiter.settled).toBe(true)
    expect(
      logs.some((l) => l.startsWith("warn") && l.includes("reclaimed")),
    ).toBe(true)
  })

  test("a lease released after a credential swap releases on the account it was acquired on", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const lease = await limiter.acquire("acct-old", "m")
    await limiter.acquire("acct-new", "m")
    const oldWaiter = track(limiter.acquire("acct-old", "m"))
    const newWaiter = track(limiter.acquire("acct-new", "m"))
    lease.release()
    await flush()
    expect(oldWaiter.settled).toBe(true)
    expect(newWaiter.settled).toBe(false)
  })
})

describe("holdSlotUntilStreamEnds", () => {
  async function* threeChunks() {
    await flush()
    yield "a"
    yield "b"
    yield "c"
  }

  test("held while streaming, released on normal end", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const lease = await limiter.acquire("a", "m")
    const seen: Array<number> = []
    for await (const _ of holdSlotUntilStreamEnds(threeChunks(), lease)) {
      seen.push(limiter.snapshot()[0]?.inFlight ?? 0)
    }
    expect(seen).toEqual([1, 1, 1])
    expect(limiter.snapshot()).toEqual([])
  })

  test("released when the stream errors", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const lease = await limiter.acquire("a", "m")
    async function* failing() {
      await flush()
      yield 1
      throw new Error("stream lost")
    }
    let caught: unknown
    try {
      for await (const _ of holdSlotUntilStreamEnds(failing(), lease)) {
        // consume
      }
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe("stream lost")
    expect(limiter.snapshot()).toEqual([])
  })

  test("released when the client aborts and the stream is never iterated", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const lease = await limiter.acquire("a", "m")
    const controller = new AbortController()
    holdSlotUntilStreamEnds(threeChunks(), lease, controller.signal)
    expect(limiter.snapshot()[0]?.inFlight).toBe(1)
    controller.abort()
    expect(limiter.snapshot()).toEqual([])
  })

  test("released when a never-started stream is closed with return()", async () => {
    const { limiter } = makeLimiter({ accountMax: 1 })
    const lease = await limiter.acquire("a", "m")
    const stream = holdSlotUntilStreamEnds(threeChunks(), lease)
    await stream.return(undefined)
    expect(limiter.snapshot()).toEqual([])
  })
})

describe("observability", () => {
  test("queueing start, dequeue wait and timeout are logged, rate-limited, token-free", async () => {
    const { limiter, clock, logs } = makeLimiter({
      accountMax: 1,
      maxWaitMs: 5_000,
    })
    const holder = await limiter.acquire("acct-9", "m")
    for (let i = 0; i < 50; i++)
      void limiter.acquire("acct-9", "m").catch(() => {})
    const queueLogs = logs.filter((l) => l.includes("queueing"))
    expect(queueLogs).toHaveLength(1)
    expect(queueLogs[0]).toContain("acct-9")
    expect(queueLogs[0]).toContain("in-flight 1/1")

    clock.advance(2_000)
    holder.release()
    await flush()
    const dequeueLogs = logs.filter((l) => l.includes("dequeued"))
    expect(dequeueLogs).toHaveLength(1)
    expect(dequeueLogs[0]).toContain("2000ms")
    expect(dequeueLogs[0]).toContain("queue depth 49")

    clock.advance(5_000)
    await flush()
    const timeoutLogs = logs.filter((l) => l.includes("gave up"))
    expect(timeoutLogs).toHaveLength(1)
    for (const l of logs) expect(l.toLowerCase()).not.toContain("token")
  })
})
