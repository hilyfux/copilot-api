/**
 * usage-emitter.test.ts — locks the buffered gateway usage writer's behaviour
 * with an in-memory UsageGateway/UsageUnit fake (no live MySQL).
 *
 * Contract under test (users/usage-emitter.ts):
 *   - a duplicate requestId is filtered out before the usage_daily upsert;
 *   - an event whose user_id cannot be resolved is still written to
 *     usage_events but is skipped by usage_daily (whose PK forbids NULL user);
 *   - a dangling accountId (not in provider_accounts) is nulled, not allowed to
 *     poison the batch;
 *   - a transient flush failure requeues the batch at the FRONT (order kept);
 *   - a foreign-key error DROPS the batch instead of retrying forever;
 *   - the last_proxy_use_at heartbeat runs only AFTER a successful commit.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

import {
  __resetAccountIdCacheForTests,
  __resetUserIdCacheForTests,
  createUsageEmitter,
} from "~/users/usage-emitter"
import type { UsageEventRow, UsageGateway, UsageUnit } from "~/gateway"

interface UnitBehavior {
  existing?: Set<string>
  users?: Map<string, string>
  accountIds?: string[]
  onInsertEvents?: (rows: UsageEventRow[]) => void
}

interface FakeUnit {
  unit: UsageUnit
  log: string[]
  captured: {
    events: UsageEventRow[]
    daily: (string | number)[][]
    sessions: unknown[]
    touched: string[]
  }
}

function makeUnit(behavior: UnitBehavior = {}): FakeUnit {
  const log: string[] = []
  const captured: FakeUnit["captured"] = {
    events: [],
    daily: [],
    sessions: [],
    touched: [],
  }
  // These fakes do no real I/O, so they are NOT `async`: each returns the
  // Promise its UsageUnit port method requires via Promise.resolve. A behaviour
  // hook (onInsertEvents) that throws still surfaces synchronously, which the
  // emitter's try/catch handles exactly as a rejected write would.
  const unit: UsageUnit = {
    begin: () => {
      log.push("begin")
      return Promise.resolve()
    },
    commit: () => {
      log.push("commit")
      return Promise.resolve()
    },
    rollback: () => {
      log.push("rollback")
      return Promise.resolve()
    },
    release: () => void log.push("release"),
    existingRequestIds: () => {
      log.push("existingRequestIds")
      return Promise.resolve(behavior.existing ?? new Set<string>())
    },
    userIdsByKeyHash: () => {
      log.push("userIdsByKeyHash")
      return Promise.resolve(behavior.users ?? new Map<string, string>())
    },
    allAccountIds: () => {
      log.push("allAccountIds")
      return Promise.resolve(behavior.accountIds ?? [])
    },
    insertEvents: (rows) => {
      log.push("insertEvents")
      captured.events = rows
      behavior.onInsertEvents?.(rows)
      return Promise.resolve()
    },
    upsertDaily: (rows) => {
      log.push("upsertDaily")
      captured.daily = rows
      return Promise.resolve()
    },
    upsertSessions: (rows) => {
      log.push("upsertSessions")
      captured.sessions = rows
      return Promise.resolve()
    },
    touchLastProxyUse: (id) => {
      log.push("touchLastProxyUse")
      captured.touched.push(id)
      return Promise.resolve()
    },
  }
  return { unit, log, captured }
}

/** A gateway that hands out the given units in order (one per flush). */
function gatewayOf(...units: FakeUnit[]): UsageGateway {
  let i = 0
  return {
    openUnit: () => {
      const next = units[Math.min(i, units.length - 1)]
      i += 1
      return Promise.resolve(next.unit)
    },
  }
}

function event(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    requestId: "r1",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    keyHash: "kh1",
    userId: "u1",
    providerType: "copilot",
    accountId: null,
    sessionId: null,
    model: "gpt",
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    durationMs: 10,
    statusCode: 200,
    networkRegion: null,
    servedModel: null,
    downstreamProtocol: "openai",
    ...overrides,
  }
}

type Logger = { warn: (message: string) => void }
const silentLogger: Logger = { warn: () => {} }

function emitterFor(gateway: UsageGateway, logger: Logger = silentLogger) {
  return createUsageEmitter(gateway, { flushIntervalMs: 0, logger })
}

beforeEach(() => {
  __resetUserIdCacheForTests()
  __resetAccountIdCacheForTests()
})

describe("usage emitter", () => {
  test("filters a duplicate requestId before the daily upsert", async () => {
    const fake = makeUnit()
    const emitter = emitterFor(gatewayOf(fake))
    emitter.emit(event({ requestId: "dup" }))
    emitter.emit(event({ requestId: "dup" }))
    await emitter.flush()

    expect(fake.captured.events).toHaveLength(1)
    expect(fake.captured.daily).toHaveLength(1)
    // request_count is index 3 of a daily row; the duplicate was collapsed.
    expect(fake.captured.daily[0][3]).toBe(1)
  })

  test("writes an unresolvable-user event to usage_events but skips usage_daily", async () => {
    const fake = makeUnit({ users: new Map() })
    const emitter = emitterFor(gatewayOf(fake))
    emitter.emit(event({ userId: null, keyHash: "orphan" }))
    await emitter.flush()

    expect(fake.captured.events).toHaveLength(1)
    expect(fake.captured.events[0].userId).toBeNull()
    // usage_daily PK forbids a NULL user, so the row is kept out of the rollup.
    expect(fake.captured.daily).toHaveLength(0)
    expect(fake.log).toContain("commit")
  })

  test("nulls a dangling accountId instead of poisoning the batch", async () => {
    const fake = makeUnit({ accountIds: ["acc-real"] })
    const warn = mock((_: string) => {})
    const emitter = emitterFor(gatewayOf(fake), { warn })
    emitter.emit(event({ accountId: "acc-ghost" }))
    await emitter.flush()

    expect(fake.captured.events).toHaveLength(1)
    expect(fake.captured.events[0].accountId).toBeNull()
    expect(fake.log).toContain("commit")
    expect(warn).toHaveBeenCalled()
  })

  test("requeues a transient flush failure at the FRONT, preserving order", async () => {
    let attempt = 0
    const failing = makeUnit({
      onInsertEvents: () => {
        attempt += 1
        if (attempt === 1) throw new Error("deadlock, try again")
      },
    })
    const emitter = emitterFor(gatewayOf(failing))

    emitter.emit(event({ requestId: "e1" }))
    await emitter.flush() // fails → e1 requeued at the front
    expect(emitter.queueSize()).toBe(1)
    expect(failing.log).toContain("rollback")

    emitter.emit(event({ requestId: "e2" }))
    await emitter.flush() // succeeds with [e1, e2] in that order

    expect(emitter.queueSize()).toBe(0)
    expect(failing.captured.events.map((e) => e.requestId)).toEqual([
      "e1",
      "e2",
    ])
  })

  test("drops the batch on a foreign-key error instead of retrying forever", async () => {
    const fkUnit = makeUnit({
      onInsertEvents: () => {
        throw Object.assign(new Error("FK fails"), { errno: 1452 })
      },
    })
    const warn = mock((_: string) => {})
    const emitter = emitterFor(gatewayOf(fkUnit), { warn })

    emitter.emit(event({ requestId: "fk" }))
    await emitter.flush()

    // Dropped, not requeued: an FK violation is schema-level, not transient.
    expect(emitter.queueSize()).toBe(0)
    expect(fkUnit.log).toContain("rollback")
    expect(warn).toHaveBeenCalled()
  })

  test("runs the last_proxy_use_at heartbeat only after a successful commit", async () => {
    const fake = makeUnit({ accountIds: ["acc-1"] })
    const emitter = emitterFor(gatewayOf(fake))
    emitter.emit(event({ accountId: "acc-1" }))
    await emitter.flush()

    expect(fake.captured.touched).toEqual(["acc-1"])
    expect(fake.log.indexOf("touchLastProxyUse")).toBeGreaterThan(
      fake.log.indexOf("commit"),
    )
  })

  test("never heartbeats when the transaction fails", async () => {
    const fake = makeUnit({
      accountIds: ["acc-1"],
      onInsertEvents: () => {
        throw new Error("transient")
      },
    })
    const emitter = emitterFor(gatewayOf(fake))
    emitter.emit(event({ accountId: "acc-1" }))
    await emitter.flush()

    expect(fake.log).toContain("rollback")
    expect(fake.log).not.toContain("touchLastProxyUse")
  })
})
