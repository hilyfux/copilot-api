/**
 * gateway-credentials.test.ts — locks the upstream-credential read path.
 *
 * Contract under test (gateway/credentials.ts):
 *   - the GitHub token is read from the versioned view v_proxy_accounts_v1,
 *     scoped to provider_type='copilot' with a non-empty access_token;
 *   - more than one copilot account → a DETERMINISTIC least-loaded pick
 *     (least-recently-used first, id as the tiebreak), independent of row order;
 *   - a MISSING-view error (errno 1146 / 1142) falls back to the base table
 *     provider_accounts exactly once; any OTHER error is rethrown, never masked;
 *   - no copilot account / all-empty tokens → null (the idle state), never a throw;
 *   - the secret token value is never logged by this module.
 *
 * A fake queryable stands in for MySQL — no live database.
 */
import { describe, expect, test } from "bun:test"
import consola from "consola"

import {
  selectCopilotGitHubToken,
  createCredentialsGateway,
  COPILOT_PROVIDER_TYPE,
} from "~/gateway/credentials"
import type { GatewayPool, Queryable } from "~/gateway/db"

interface Call {
  sql: string
  params: unknown[]
}

function fakeDb(handler: (sql: string, params: unknown[]) => unknown[]): {
  db: Queryable
  calls: Call[]
} {
  const calls: Call[] = []
  const db = {
    query: (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return Promise.resolve([handler(sql, params), []])
    },
  } as unknown as Queryable
  return { db, calls }
}

const usesView = (sql: string) => sql.includes("v_proxy_accounts_v1")
const usesBaseTable = (sql: string) =>
  sql.includes("FROM provider_accounts") && !usesView(sql)

describe("credentials gateway", () => {
  test("reads the GitHub token from the view, filtered to the copilot family", async () => {
    const { db, calls } = fakeDb((sql) => {
      if (usesView(sql)) {
        return [
          { id: "acc-1", access_token: "gho_secret", last_proxy_use_at: null },
        ]
      }
      throw new Error("base table must not be queried")
    })

    const credential = await selectCopilotGitHubToken(db)

    expect(credential).toEqual({
      accountId: "acc-1",
      githubToken: "gho_secret",
    })
    expect(calls).toHaveLength(1)
    expect(usesView(calls[0].sql)).toBe(true)
    // The family filter is a bound param, not interpolated.
    expect(calls[0].params).toEqual([COPILOT_PROVIDER_TYPE])
  })

  test("multiple copilot accounts → deterministic least-recently-used pick", async () => {
    // Rows handed back in a deliberately non-sorted order; the oldest
    // last_proxy_use_at (acc-old) must win regardless.
    const rows = [
      {
        id: "acc-new",
        access_token: "tok-new",
        last_proxy_use_at: new Date("2026-10-20T10:00:00Z"),
      },
      {
        id: "acc-old",
        access_token: "tok-old",
        last_proxy_use_at: new Date("2026-10-18T10:00:00Z"),
      },
      {
        id: "acc-mid",
        access_token: "tok-mid",
        last_proxy_use_at: new Date("2026-10-19T10:00:00Z"),
      },
    ]
    const { db } = fakeDb(() => rows)

    const first = await selectCopilotGitHubToken(db)
    const second = await selectCopilotGitHubToken(db)

    expect(first).toEqual({ accountId: "acc-old", githubToken: "tok-old" })
    // Deterministic: same rows → same pick every time.
    expect(second).toEqual(first)
  })

  test("a never-used account (null last_proxy_use_at) is preferred, id breaks ties", async () => {
    const rows = [
      {
        id: "acc-b",
        access_token: "tok-b",
        last_proxy_use_at: new Date("2026-10-20T10:00:00Z"),
      },
      { id: "acc-z", access_token: "tok-z", last_proxy_use_at: null },
      { id: "acc-a", access_token: "tok-a", last_proxy_use_at: null },
    ]
    const { db } = fakeDb(() => rows)

    const credential = await selectCopilotGitHubToken(db)
    // Both acc-a and acc-z are never-used; the lower id (acc-a) wins.
    expect(credential).toEqual({ accountId: "acc-a", githubToken: "tok-a" })
  })

  test("falls back to the base table on a missing-view error, exactly once", async () => {
    for (const errno of [1146, 1142]) {
      const { db, calls } = fakeDb((sql) => {
        if (usesView(sql)) {
          throw Object.assign(new Error("missing view"), { errno })
        }
        return [{ id: "acc-9", access_token: "tok-9", last_proxy_use_at: null }]
      })

      const credential = await selectCopilotGitHubToken(db)

      expect(credential).toEqual({ accountId: "acc-9", githubToken: "tok-9" })
      expect(calls).toHaveLength(2)
      expect(usesView(calls[0].sql)).toBe(true)
      expect(usesBaseTable(calls[1].sql)).toBe(true)
    }
  })

  test("rethrows a non-missing-view error instead of masking it", async () => {
    const { db, calls } = fakeDb((sql) => {
      if (usesView(sql)) {
        throw Object.assign(new Error("access denied to column"), {
          errno: 1356,
        })
      }
      throw new Error("base table must not be queried after a real fault")
    })

    const failure = await selectCopilotGitHubToken(db).catch(
      (error: unknown) => error,
    )

    expect(failure).toHaveProperty("errno", 1356)
    expect(calls).toHaveLength(1)
  })

  test("no copilot account → null (idle), never a throw", async () => {
    const { db } = fakeDb(() => [])
    expect(await selectCopilotGitHubToken(db)).toBeNull()
  })

  test("all rows have empty tokens → null (defensive, never an empty credential)", async () => {
    const { db } = fakeDb(() => [
      { id: "acc-1", access_token: "", last_proxy_use_at: null },
      { id: "acc-2", access_token: "   ", last_proxy_use_at: null },
    ])
    expect(await selectCopilotGitHubToken(db)).toBeNull()
  })

  test("the WHERE filters disabled accounts (disabled_at IS NULL) on view and base table", async () => {
    const { db, calls } = fakeDb((sql) => {
      if (usesView(sql)) {
        throw Object.assign(new Error("missing view"), { errno: 1146 })
      }
      return [{ id: "acc-9", access_token: "tok-9", last_proxy_use_at: null }]
    })

    await selectCopilotGitHubToken(db)

    // Both the versioned view and the base-table fallback must carry the clause,
    // so a disabled account's token is dropped DB-side (mig 169 grants the column).
    expect(usesView(calls[0].sql)).toBe(true)
    expect(calls[0].sql).toContain("disabled_at IS NULL")
    expect(usesBaseTable(calls[1].sql)).toBe(true)
    expect(calls[1].sql).toContain("disabled_at IS NULL")
  })

  test("a disabled account's token is never selected; the non-disabled one wins", async () => {
    // acc-disabled has the OLDEST last_proxy_use_at, so it would win the LRU pick
    // if it were eligible — but disabled_at is set, so it must be skipped and the
    // non-disabled acc-live chosen. (Defends the DB-side filter in JS too.)
    const rows = [
      {
        id: "acc-disabled",
        access_token: "tok-disabled",
        last_proxy_use_at: new Date("2026-10-10T10:00:00Z"),
        disabled_at: new Date("2026-10-15T10:00:00Z"),
      },
      {
        id: "acc-live",
        access_token: "tok-live",
        last_proxy_use_at: new Date("2026-10-19T10:00:00Z"),
        disabled_at: null,
      },
    ]
    const { db } = fakeDb(() => rows)

    const credential = await selectCopilotGitHubToken(db)

    expect(credential).toEqual({
      accountId: "acc-live",
      githubToken: "tok-live",
    })
  })

  test("all copilot accounts disabled → null (idle), never a throw", async () => {
    const rows = [
      {
        id: "acc-a",
        access_token: "tok-a",
        last_proxy_use_at: null,
        disabled_at: new Date("2026-10-18T10:00:00Z"),
      },
      {
        id: "acc-b",
        access_token: "tok-b",
        last_proxy_use_at: new Date("2026-10-19T10:00:00Z"),
        disabled_at: new Date("2026-10-19T12:00:00Z"),
      },
    ]
    const { db } = fakeDb(() => rows)

    // null is the idle signal the caller turns into a clean file/env fallback.
    expect(await selectCopilotGitHubToken(db)).toBeNull()
  })

  test("the port wrapper delegates to the reader over the pool", async () => {
    const { db } = fakeDb(() => [
      { id: "acc-1", access_token: "tok", last_proxy_use_at: null },
    ])
    const gateway = createCredentialsGateway(db as unknown as GatewayPool)
    expect(await gateway.readCopilotGitHubToken()).toEqual({
      accountId: "acc-1",
      githubToken: "tok",
    })
  })

  test("never logs the secret token value", async () => {
    const secret = "gho_top_secret_value"
    const logged: unknown[] = []
    const originals = {
      info: consola.info,
      warn: consola.warn,
      error: consola.error,
      debug: consola.debug,
      log: consola.log,
    }
    const capture =
      (original: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        logged.push(...args)
        return original(...args)
      }
    consola.info = capture(originals.info) as typeof consola.info
    consola.warn = capture(originals.warn) as typeof consola.warn
    consola.error = capture(originals.error) as typeof consola.error
    consola.debug = capture(originals.debug) as typeof consola.debug
    consola.log = capture(originals.log) as typeof consola.log
    try {
      const { db } = fakeDb(() => [
        { id: "acc-1", access_token: secret, last_proxy_use_at: null },
      ])
      await selectCopilotGitHubToken(db)
    } finally {
      consola.info = originals.info
      consola.warn = originals.warn
      consola.error = originals.error
      consola.debug = originals.debug
      consola.log = originals.log
    }
    const serialized = JSON.stringify(logged)
    expect(serialized.includes(secret)).toBe(false)
  })
})
