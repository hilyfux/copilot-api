/**
 * Importing a Copilot account must take effect WITHOUT restarting the proxy.
 *
 * Live finding: the container started at 15:47 and the operator imported the
 * account at 16:12. Startup decided "idle" once and never looked again, so every
 * request kept failing with "Copilot token not found" until the container was
 * restarted by hand. A gateway-managed proxy exists to be configured from the
 * gateway; requiring a restart after the documented import step contradicts that.
 *
 * The fix is a lazy reload on the request path, and these behaviours are what
 * keep it safe:
 *   - it only fires when the token is actually missing (zero cost when healthy),
 *   - concurrent requests collapse into ONE credential read (single-flight),
 *   - a failed attempt is not retried on every request (throttled), so a bad
 *     credential cannot turn traffic into a database hammer,
 *   - with no reloader configured (standalone mode) the original error stands.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import {
  configureTokenReloader,
  ensureCopilotToken,
  resetTokenReloadStateForTest,
} from "~/lib/token-reload"

beforeEach(() => {
  state.copilotToken = undefined
  configureTokenReloader(null)
  resetTokenReloadStateForTest()
})

describe("ensureCopilotToken — lazy reload from the gateway", () => {
  test("does nothing when a token is already present", async () => {
    state.copilotToken = "already-there"
    const reloader = mock(() => Promise.resolve(true))
    configureTokenReloader(reloader)

    await ensureCopilotToken()

    expect(reloader).not.toHaveBeenCalled()
  })

  test("reloads once and then succeeds", async () => {
    const reloader = mock(() => {
      state.copilotToken = "reloaded"
      return Promise.resolve(true)
    })
    configureTokenReloader(reloader)

    await ensureCopilotToken()

    expect(reloader).toHaveBeenCalledTimes(1)
    expect(state.copilotToken).toBe("reloaded")
  })

  test("throws the original error when no reloader is configured", async () => {
    const error = await ensureCopilotToken().catch(
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Copilot token not found")
  })

  test("throws when the reloader finds no account", async () => {
    configureTokenReloader(() => Promise.resolve(false))

    const error = await ensureCopilotToken().catch(
      (failure: unknown) => failure,
    )
    expect((error as Error).message).toBe("Copilot token not found")
  })

  test("concurrent requests collapse into one credential read", async () => {
    let resolveReload: ((ok: boolean) => void) | undefined
    const reloader = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReload = resolve
        }),
    )
    configureTokenReloader(reloader)

    const first = ensureCopilotToken()
    const second = ensureCopilotToken()
    await Bun.sleep(1)
    state.copilotToken = "from-flight"
    resolveReload?.(true)
    await Promise.all([first, second])

    expect(reloader).toHaveBeenCalledTimes(1)
  })

  test("a failed attempt is throttled instead of hitting the gateway per request", async () => {
    const reloader = mock(() => Promise.resolve(false))
    configureTokenReloader(reloader)

    const failures = await Promise.all([
      ensureCopilotToken().catch((failure: unknown) => failure),
      ensureCopilotToken().catch((failure: unknown) => failure),
      ensureCopilotToken().catch((failure: unknown) => failure),
    ])
    for (const failure of failures) {
      expect((failure as Error).message).toBe("Copilot token not found")
    }

    // Three requests, one credential read: the import is a human action that
    // happens at most once per retry window, not a per-request probe.
    expect(reloader).toHaveBeenCalledTimes(1)
  })

  test("after the throttle window a new attempt is allowed", async () => {
    const reloader = mock(() => Promise.resolve(false))
    configureTokenReloader(reloader)

    await ensureCopilotToken().catch((failure: unknown) => failure)
    // Simulate the window elapsing rather than sleeping in a unit test.
    resetTokenReloadStateForTest({ keepThrottle: false })
    await ensureCopilotToken().catch((failure: unknown) => failure)

    expect(reloader).toHaveBeenCalledTimes(2)
  })
})
