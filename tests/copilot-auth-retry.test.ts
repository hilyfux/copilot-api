/**
 * Scope 7 d) + scope 8 #8: a Copilot upstream 401 reports the auth failure to
 * the credential refresher and retries the request ONCE with the newly
 * installed token; no new token → the original 401 stands. Fakes only.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { setCopilotAuthFailureHandler } from "~/lib/copilot-auth-failure"
import { state } from "~/lib/state"
import { withCopilotAuthRetry } from "~/services/copilot/auth-retry"

afterEach(() => {
  setCopilotAuthFailureHandler(null)
  state.copilotToken = undefined
})

describe("withCopilotAuthRetry", () => {
  test("401 → refresher installs a new token → retried once with the new Authorization", async () => {
    state.copilotToken = "eph-old"
    let reports = 0
    setCopilotAuthFailureHandler(() => {
      reports++
      state.copilotToken = "eph-new"
      return Promise.resolve(true)
    })
    const headers: Record<string, string> = { Authorization: "Bearer eph-old" }
    const seen: string[] = []
    const res = await withCopilotAuthRetry(headers, () => {
      seen.push(headers.Authorization)
      return Promise.resolve(
        new Response("", { status: seen.length === 1 ? 401 : 200 }),
      )
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual(["Bearer eph-old", "Bearer eph-new"])
    expect(reports).toBe(1)
  })

  test("401 and no new token → original 401 returned, no retry", async () => {
    state.copilotToken = "eph-old"
    setCopilotAuthFailureHandler(() => Promise.resolve(false))
    let sends = 0
    const res = await withCopilotAuthRetry({ Authorization: "x" }, () => {
      sends++
      return Promise.resolve(new Response("", { status: 401 }))
    })
    expect(res.status).toBe(401)
    expect(sends).toBe(1)
  })

  test("non-401 never reports", async () => {
    let reports = 0
    setCopilotAuthFailureHandler(() => {
      reports++
      return Promise.resolve(true)
    })
    const res = await withCopilotAuthRetry({}, () =>
      Promise.resolve(new Response("", { status: 403 })),
    )
    expect(res.status).toBe(403)
    expect(reports).toBe(0)
  })

  test("standalone (no handler) → 401 passes through", async () => {
    const res = await withCopilotAuthRetry({}, () =>
      Promise.resolve(new Response("", { status: 401 })),
    )
    expect(res.status).toBe(401)
  })
})
