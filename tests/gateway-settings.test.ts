/**
 * gateway-settings.test.ts — locks the app_settings read path.
 *
 * Contract under test (gateway/settings.ts):
 *   - normal case reads the versioned view `v_proxy_settings_v1`;
 *   - a MISSING-view error (errno 1146 no-such-table / 1142 access-denied)
 *     falls back to the base table `app_settings`, exactly once;
 *   - any OTHER error (e.g. 1356 view-references-invalid-tables) is rethrown and
 *     never silently downgraded to the base table;
 *   - an empty key list issues no SQL.
 *
 * A fake pool stands in for MySQL — no live database.
 */
import { describe, expect, test } from "bun:test"

import { createSettingsGateway } from "~/gateway/settings"
import type { GatewayPool } from "~/gateway/db"

interface Call {
  sql: string
}

function fakePool(handler: (sql: string, params: unknown[]) => unknown[]): {
  pool: GatewayPool
  calls: Call[]
} {
  const calls: Call[] = []
  const pool = {
    query: (sql: string, params: unknown[]) => {
      calls.push({ sql })
      const rows = handler(sql, params)
      return Promise.resolve([rows, []])
    },
  } as unknown as GatewayPool
  return { pool, calls }
}

const usesView = (sql: string) => sql.includes("v_proxy_settings_v1")
const usesBaseTable = (sql: string) => sql.includes("app_settings")

describe("settings gateway", () => {
  test("reads the versioned view and never touches the base table", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (usesView(sql)) {
        return [
          { setting_key: "client_max_concurrent_sessions", setting_value: "5" },
        ]
      }
      throw new Error("base table must not be queried")
    })
    const values = await createSettingsGateway(pool).readValues([
      "client_max_concurrent_sessions",
    ])
    expect(values.get("client_max_concurrent_sessions")).toBe("5")
    expect(calls).toHaveLength(1)
    expect(usesView(calls[0].sql)).toBe(true)
  })

  for (const errno of [1146, 1142]) {
    test(`falls back to the base table on errno ${errno}`, async () => {
      const { pool, calls } = fakePool((sql) => {
        if (usesView(sql)) {
          throw Object.assign(new Error("missing view"), { errno })
        }
        return [
          {
            setting_key: "provider_account_max_sessions",
            setting_value: "3",
          },
        ]
      })
      const values = await createSettingsGateway(pool).readValues([
        "provider_account_max_sessions",
      ])
      expect(values.get("provider_account_max_sessions")).toBe("3")
      expect(calls).toHaveLength(2)
      expect(usesView(calls[0].sql)).toBe(true)
      expect(usesBaseTable(calls[1].sql)).toBe(true)
    })
  }

  test("rethrows errno 1356 instead of falling back", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (usesView(sql)) {
        throw Object.assign(new Error("view invalid"), { errno: 1356 })
      }
      throw new Error(
        "base table must not be queried after a non-missing error",
      )
    })
    const failure = await createSettingsGateway(pool)
      .readValues(["client_max_concurrent_sessions"])
      .catch((error: unknown) => error)
    expect(failure).toHaveProperty("errno", 1356)
    expect(calls).toHaveLength(1)
  })

  test("issues no SQL for an empty key list", async () => {
    const { pool, calls } = fakePool(() => {
      throw new Error("must not query for an empty key list")
    })
    const values = await createSettingsGateway(pool).readValues([])
    expect(values.size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
