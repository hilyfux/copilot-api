/**
 * managed-auth.test.ts — locks the authenticator contract that replaced the
 * fork's static `auth.apiKeys` list. Uses an in-memory KeysGateway fake; no
 * live MySQL.
 *
 * Contract under test:
 *   - missing key            → 401
 *   - unknown key            → 401
 *   - revoked key            → 403
 *   - disabled key           → 403
 *   - backend error          → 503, and NOT cached (recovers next request)
 *   - valid key              → identity { keyHash, userId, pin, providerType }
 *   - pin (preferredAccountId) comes ONLY from preferred_account_id, never from
 *     the account the key was created against.
 */
import { describe, expect, test } from "bun:test"

import { createManagedAuthenticator } from "~/users/managed-auth"
import { hashClientKeyBothEncodings } from "~/users/api-keys"
import { createFakeKeysGateway } from "./fake-keys-gateway"

describe("managed authenticator", () => {
  test("rejects a missing key with 401 before touching the backend", async () => {
    const keys = createFakeKeysGateway([])
    const auth = createManagedAuthenticator(keys)
    const outcome = await auth.authenticate("")
    expect(outcome).toEqual({
      ok: false,
      status: 401,
      message: "missing API key",
    })
    expect(keys.calls).toBe(0)
  })

  test("rejects an unknown key with 401", async () => {
    const auth = createManagedAuthenticator(createFakeKeysGateway([]))
    const outcome = await auth.authenticate("nope")
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? 0 : outcome.status).toBe(401)
  })

  test("rejects a revoked key with 403", async () => {
    const keys = createFakeKeysGateway([
      { key: "revoked", userId: "u1", revokedAt: new Date() },
    ])
    const outcome =
      await createManagedAuthenticator(keys).authenticate("revoked")
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? 0 : outcome.status).toBe(403)
  })

  test("rejects a disabled key with 403", async () => {
    const keys = createFakeKeysGateway([
      { key: "disabled", userId: "u1", disabledAt: new Date() },
    ])
    const outcome =
      await createManagedAuthenticator(keys).authenticate("disabled")
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? 0 : outcome.status).toBe(403)
  })

  test("returns 503 on a backend error and does NOT cache it", async () => {
    const keys = createFakeKeysGateway([{ key: "k", userId: "u1" }])
    const auth = createManagedAuthenticator(keys, { cacheTtlMs: 30_000 })

    keys.failWith(Object.assign(new Error("connect ECONNREFUSED"), {}))
    const down = await auth.authenticate("k")
    expect(down.ok).toBe(false)
    expect(down.ok ? 0 : down.status).toBe(503)
    expect(keys.calls).toBe(1)

    // Backend recovers: the next request must be re-checked, not served a cached
    // failure. A valid result comes straight back.
    keys.clearFailure()
    const up = await auth.authenticate("k")
    expect(up.ok).toBe(true)
    expect(keys.calls).toBe(2)
  })

  test("accepts a valid key and carries keyHash/userId/pin/providerType", async () => {
    const keys = createFakeKeysGateway([
      {
        key: "live",
        userId: "user-42",
        preferredAccountId: "acc-pinned",
        maxConcurrency: 5,
        providerType: "copilot",
      },
    ])
    const outcome = await createManagedAuthenticator(keys).authenticate("live")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("expected ok")
    const { hex } = hashClientKeyBothEncodings("live")
    expect(outcome.identity).toEqual({
      keyHash: hex,
      userId: "user-42",
      preferredAccountId: "acc-pinned",
      maxConcurrency: 5,
      providerType: "copilot",
    })
  })

  test("pin comes ONLY from preferred_account_id, never created_account_id", async () => {
    // A key created against an account but NOT pinned by an operator: the pin
    // must be null ("auto"), never the created account.
    const keys = createFakeKeysGateway([
      {
        key: "unpinned",
        userId: "u1",
        preferredAccountId: null,
        createdAccountId: "acc-created",
        providerType: "copilot",
      },
    ])
    const outcome =
      await createManagedAuthenticator(keys).authenticate("unpinned")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("expected ok")
    expect(outcome.identity.preferredAccountId).toBeNull()
  })

  test("caches a positive outcome within the TTL to keep MySQL off the hot path", async () => {
    const keys = createFakeKeysGateway([{ key: "live", userId: "u1" }])
    const auth = createManagedAuthenticator(keys, { cacheTtlMs: 30_000 })
    expect((await auth.authenticate("live")).ok).toBe(true)
    expect((await auth.authenticate("live")).ok).toBe(true)
    expect(keys.calls).toBe(1)
  })
})
