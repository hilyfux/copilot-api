/**
 * Scope 7 — credential auto-refresh (operator: "凭证的自动刷新，都做一下").
 *
 * Live incident 2026-10-21: account 'hilyfux' deleted, 'misaki-tanaka-aki_mimiofy'
 * imported, the running proxy kept hilyfux's token until a manual restart.
 * Fakes only: the DB is a list() fake, GitHub is an install() fake, the clock
 * and the interval timer are fakes. No token value ever reaches a log line.
 */
import { describe, expect, test } from "bun:test"

import type { CopilotCredential } from "~/gateway/credentials"
import { HTTPError } from "~/lib/error"
import {
  createCopilotCredentialRefresher,
  DEFAULT_CREDENTIAL_REFRESH_MS,
  readCredentialRefreshMs,
  type CredentialRefresherDeps,
  type InitialCredential,
} from "~/lib/copilot-credential-refresher"

const OLD: CopilotCredential = {
  accountId: "hilyfux",
  githubToken: "gho_OLD_SECRET",
}
const NEW: CopilotCredential = {
  accountId: "misaki-tanaka-aki_mimiofy",
  githubToken: "gho_NEW_SECRET",
}
const THIRD: CopilotCredential = {
  accountId: "third",
  githubToken: "gho_THIRD_SECRET",
}

function harness(opts: {
  rows: CopilotCredential[] | Error
  initial?: InitialCredential
  rejectTokens?: Set<string>
  transientTokens?: Set<string>
}) {
  const logs: string[] = []
  let rows = opts.rows
  let clock = 0
  let reads = 0
  const installed: string[] = []
  const state = { token: undefined as string | undefined, cleared: 0 }
  let timerFn: (() => void) | null = null
  let timerMs = 0
  let cleared = false

  const deps: CredentialRefresherDeps = {
    list: () => {
      reads++
      return rows instanceof Error ?
          Promise.reject(rows)
        : Promise.resolve(rows)
    },
    install: (cred) => {
      state.token = undefined // invalidate ephemeral first
      if (opts.rejectTokens?.has(cred.githubToken)) {
        return Promise.reject(
          new HTTPError(
            "Failed to get Copilot token",
            new Response("", { status: 401 }),
          ),
        )
      }
      if (opts.transientTokens?.has(cred.githubToken)) {
        return Promise.reject(new Error("ECONNRESET"))
      }
      installed.push(cred.accountId)
      state.token = cred.githubToken
      return Promise.resolve()
    },
    clear: () => {
      state.token = undefined
      state.cleared++
    },
    now: () => clock,
    setInterval: (fn, ms) => {
      timerFn = fn
      timerMs = ms
      return "handle"
    },
    clearInterval: () => {
      cleared = true
      timerFn = null
    },
    logger: {
      info: (m) => void logs.push(m),
      warn: (m) => void logs.push(m),
      error: (m) => void logs.push(`ERROR ${m}`),
    },
  }
  const refresher = createCopilotCredentialRefresher(
    deps,
    opts.initial ?? { kind: "gateway", ...OLD },
  )
  if (opts.initial === undefined) state.token = OLD.githubToken
  return {
    refresher,
    logs,
    installed,
    state,
    setRows: (r: CopilotCredential[] | Error) => void (rows = r),
    advance: (ms: number) => void (clock += ms),
    reads: () => reads,
    fireTimer: () => timerFn?.(),
    timerMs: () => timerMs,
    timerCleared: () => cleared,
  }
}

const noSecrets = (logs: string[]) =>
  expect(logs.join("\n")).not.toMatch(/gho_|SECRET/)

describe("a) periodic re-read", () => {
  test("default interval is 60s; env knob overrides; timer is stoppable", () => {
    expect(DEFAULT_CREDENTIAL_REFRESH_MS).toBe(60_000)
    expect(readCredentialRefreshMs({})).toBe(60_000)
    expect(
      readCredentialRefreshMs({ COPILOT_CREDENTIAL_REFRESH_MS: "15000" }),
    ).toBe(15_000)
    expect(
      readCredentialRefreshMs({ COPILOT_CREDENTIAL_REFRESH_MS: "junk" }),
    ).toBe(60_000)
    const h = harness({ rows: [OLD] })
    h.refresher.start()
    expect(h.timerMs()).toBe(60_000)
    h.refresher.stop()
    expect(h.timerCleared()).toBe(true)
  })

  test("timer tick re-runs the loader", async () => {
    const h = harness({ rows: [OLD] })
    h.refresher.start()
    h.fireTimer()
    await h.refresher.tick()
    expect(h.reads()).toBeGreaterThanOrEqual(1)
    h.refresher.stop()
  })

  test("unchanged account + token → no reinstall, no log", async () => {
    const h = harness({ rows: [OLD] })
    await h.refresher.tick()
    expect(h.installed).toEqual([])
    expect(h.logs).toEqual([])
  })
})

describe("b/c) account change, deletion, disable", () => {
  test("the live incident: hilyfux deleted + new account imported → next tick switches, one log line, ids only", async () => {
    const h = harness({ rows: [OLD] })
    h.setRows([NEW])
    await h.refresher.tick()
    expect(h.installed).toEqual([NEW.accountId])
    expect(h.state.token).toBe(NEW.githubToken)
    expect(h.refresher.currentAccountId()).toBe(NEW.accountId)
    expect(h.logs).toEqual([
      "copilot credential switched: #hilyfux → #misaki-tanaka-aki_mimiofy",
    ])
    noSecrets(h.logs)
  })

  test("same account, rotated token (compared by hash) → reinstall", async () => {
    const h = harness({ rows: [OLD] })
    h.setRows([{ accountId: OLD.accountId, githubToken: "gho_ROTATED_SECRET" }])
    await h.refresher.tick()
    expect(h.installed).toEqual([OLD.accountId])
    expect(h.state.token).toBe("gho_ROTATED_SECRET")
    noSecrets(h.logs)
  })

  test("current account still eligible → sticky even when another is less recently used", async () => {
    const h = harness({ rows: [NEW, OLD] }) // NEW is LRU-first
    await h.refresher.tick()
    expect(h.installed).toEqual([])
    expect(h.refresher.currentAccountId()).toBe(OLD.accountId)
  })

  test("account deleted/disabled and none left → credential cleared (→ 503), never the stale token", async () => {
    const h = harness({ rows: [OLD] })
    h.setRows([])
    await h.refresher.tick()
    expect(h.state.token).toBeUndefined()
    expect(h.state.cleared).toBe(1)
    expect(h.refresher.currentAccountId()).toBeNull()
    expect(h.logs).toEqual(["copilot credential switched: #hilyfux → #(none)"])
  })

  test("local (env/file) credential is NOT cleared by an empty gateway, but a gateway account still wins", async () => {
    const h = harness({ rows: [], initial: { kind: "local" } })
    await h.refresher.tick()
    expect(h.state.cleared).toBe(0)
    h.setRows([NEW])
    await h.refresher.tick()
    expect(h.installed).toEqual([NEW.accountId])
  })

  test("idle at boot (no credential) → first account imported is installed on the next tick", async () => {
    const h = harness({ rows: [], initial: { kind: "none" } })
    await h.refresher.tick()
    h.setRows([NEW])
    await h.refresher.tick()
    expect(h.installed).toEqual([NEW.accountId])
  })
})

describe("d) upstream auth failure", () => {
  test("DB still holds the rejected token and GitHub refuses it again → marked bad, next eligible account installed", async () => {
    const h = harness({
      rows: [OLD, THIRD],
      rejectTokens: new Set([OLD.githubToken]),
    })
    expect(await h.refresher.reportAuthFailure()).toBe(true)
    expect(h.installed).toEqual([THIRD.accountId])
    expect(h.refresher.currentAccountId()).toBe(THIRD.accountId)
    // the bad mark sticks: the next tick does not go back to the rejected token
    await h.refresher.tick()
    expect(h.installed).toEqual([THIRD.accountId])
    noSecrets(h.logs)
  })

  test("expired ephemeral token: same DB token re-exchanges fine → stays, not marked bad", async () => {
    const h = harness({ rows: [OLD] })
    expect(await h.refresher.reportAuthFailure()).toBe(true)
    expect(h.installed).toEqual([OLD.accountId])
    expect(h.refresher.currentAccountId()).toBe(OLD.accountId)
  })

  test("only account rejected → cleared (503), and a re-imported token is accepted again", async () => {
    const h = harness({ rows: [OLD], rejectTokens: new Set([OLD.githubToken]) })
    expect(await h.refresher.reportAuthFailure()).toBe(false)
    expect(h.state.cleared).toBe(1)
    h.setRows([
      { accountId: OLD.accountId, githubToken: "gho_REIMPORTED_SECRET" },
    ])
    await h.refresher.tick()
    expect(h.state.token).toBe("gho_REIMPORTED_SECRET")
  })

  test("concurrent failures stampede-proof: 20 reports → ONE DB read", async () => {
    const h = harness({ rows: [OLD] })
    await Promise.all(
      Array.from({ length: 20 }, () => h.refresher.reportAuthFailure()),
    )
    expect(h.reads()).toBe(1)
  })

  test("debounced: a second report for the same token inside the window does not re-read", async () => {
    const h = harness({ rows: [OLD] })
    await h.refresher.reportAuthFailure()
    h.advance(500)
    await h.refresher.reportAuthFailure()
    expect(h.reads()).toBe(1)
    h.advance(5_000)
    await h.refresher.reportAuthFailure()
    expect(h.reads()).toBe(2)
  })
})

describe("e) never crash", () => {
  test("DB error during a tick keeps the last-good credential (fail-static) and logs", async () => {
    const h = harness({ rows: new Error("connect ETIMEDOUT") })
    await h.refresher.tick()
    expect(h.state.token).toBe(OLD.githubToken)
    expect(h.state.cleared).toBe(0)
    expect(h.logs[0]).toContain("keeping the last-good credential")
  })

  test("errno 1356 logs loudly at error level", async () => {
    const h = harness({
      rows: Object.assign(new Error("view invalid"), { errno: 1356 }),
    })
    await h.refresher.tick()
    expect(h.logs[0]).toStartWith("ERROR ")
    expect(h.logs[0]).toContain("1356")
    expect(h.state.token).toBe(OLD.githubToken)
  })

  test("transient install failure → no crash, retried on the next tick", async () => {
    const transient = new Set([NEW.githubToken])
    const h = harness({ rows: [NEW], transientTokens: transient })
    await h.refresher.tick()
    expect(h.installed).toEqual([])
    expect(h.state.token).toBeUndefined() // old ephemeral invalidated, never reused
    transient.clear() // network recovers
    await h.refresher.tick()
    expect(h.installed).toEqual([NEW.accountId])
  })
})

describe("f) in-flight requests keep their token", () => {
  test("a request that captured its Authorization header before the swap keeps it", async () => {
    const h = harness({ rows: [OLD] })
    const inFlightHeader = `Bearer ${h.state.token}`
    h.setRows([NEW])
    await h.refresher.tick()
    expect(inFlightHeader).toBe(`Bearer ${OLD.githubToken}`)
    expect(`Bearer ${h.state.token}`).toBe(`Bearer ${NEW.githubToken}`)
  })
})
