/**
 * usage_events.upstream_outcome (agent-gateway mig 172, contract v3) is written
 * only when the column exists. A host whose gateway has not applied mig 172 yet
 * must keep receiving usage rows — an INSERT naming a missing column would fail
 * the WHOLE batch (every request's usage lost), so the column is gated by the
 * contract package's column probe (true is remembered forever, false re-probed
 * after 60s).
 */
import { describe, expect, test } from "bun:test"

import type { UsageEventRow } from "~/gateway"
import type { GatewayPool } from "~/gateway/db"
import { createUsageGateway } from "~/gateway/usage"

type Call = { sql: string; values: unknown }

function fakePool(columnPresent: boolean): {
  pool: GatewayPool
  calls: Call[]
} {
  const calls: Call[] = []
  const query = (sql: string, values?: unknown) => {
    calls.push({ sql, values })
    if (sql.includes("information_schema.COLUMNS")) {
      return Promise.resolve([columnPresent ? [{ present: 1 }] : [], []])
    }
    return Promise.resolve([{ affectedRows: 1 }, []])
  }
  const conn = {
    query,
    beginTransaction: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    release: () => {},
  }
  const pool = { query, getConnection: () => Promise.resolve(conn) }
  return { pool: pool as unknown as GatewayPool, calls }
}

const row = (over: Partial<UsageEventRow> = {}): UsageEventRow => ({
  requestId: "r1",
  occurredAt: new Date(0),
  keyHash: "kh",
  userId: "u1",
  providerType: "copilot",
  accountId: "acct-1",
  sessionId: null,
  model: "claude-opus-5",
  servedModel: "claude-opus-5",
  downstreamProtocol: "anthropic",
  inputTokens: 360_000,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 1,
  reasoningTokens: 0,
  durationMs: 10,
  statusCode: null,
  networkRegion: null,
  ...over,
})

const insertOf = (calls: Call[]) =>
  calls.find((c) => c.sql.includes("INSERT IGNORE INTO usage_events"))

describe("usage_events.upstream_outcome write", () => {
  test("column present → INSERT names upstream_outcome and carries 'refusal' / null per row", async () => {
    const { pool, calls } = fakePool(true)
    const unit = await createUsageGateway(pool).openUnit()
    await unit.insertEvents([
      row({ upstreamOutcome: "refusal" }),
      row({ requestId: "r2" }),
    ])
    const ins = insertOf(calls)
    expect(ins?.sql).toContain("upstream_outcome")
    const values = (ins?.values as unknown[][][])[0]
    expect(values[0].at(-1)).toBe("refusal")
    expect(values[1].at(-1)).toBeNull()
  })

  test("column absent (gateway before mig 172) → INSERT does not name it, row still written", async () => {
    const { pool, calls } = fakePool(false)
    const unit = await createUsageGateway(pool).openUnit()
    await unit.insertEvents([row({ upstreamOutcome: "refusal" })])
    const ins = insertOf(calls)
    expect(ins).toBeDefined()
    expect(ins?.sql).not.toContain("upstream_outcome")
    expect((ins?.values as unknown[][][])[0][0]).toHaveLength(18)
  })

  test("probe runs once per gateway, not per batch", async () => {
    const { pool, calls } = fakePool(true)
    const gw = createUsageGateway(pool)
    for (let i = 0; i < 3; i++)
      await (await gw.openUnit()).insertEvents([row({ requestId: `r${i}` })])
    expect(
      calls.filter((c) => c.sql.includes("information_schema.COLUMNS")),
    ).toHaveLength(1)
  })
})
