/**
 * fake-keys-gateway — an in-memory KeysGateway for unit tests.
 *
 * The production KeysGateway reads `agent_gateway.client_keys`; a unit test has
 * no business spinning up a MySQL for that. This fake keeps the exact
 * `findByHashes` contract (hashes in → ClientKeyRow[] out), counts calls so a
 * test can prove a lookup did / did not hit the backend, lets a test mutate the
 * key set to simulate an admin add / revoke / disable, and can be told to throw
 * to simulate a backend outage.
 *
 * It hashes stored raw keys the same way managed-auth does (hex + base64url) so
 * the authenticator's dual-encoding match is exercised faithfully.
 */
import { hashClientKeyBothEncodings } from "~/users/api-keys"
import type { ClientKeyRow, KeysGateway } from "~/gateway/keys"

export interface FakeKeyInput {
  key: string
  userId?: string | null
  preferredAccountId?: string | null
  /**
   * The account a key was originally created against. The real SELECT never
   * reads this column — it is here only so a test can prove the pin is NEVER
   * taken from it. It is attached to the returned row as an extra property.
   */
  createdAccountId?: string | null
  maxConcurrency?: number | null
  disabledAt?: Date | null
  revokedAt?: Date | null
  providerType?: string | null
  createdProviderType?: string | null
  /** Store the row under the base64url digest instead of hex (legacy keys). */
  base64url?: boolean
}

export interface FakeKeysGateway extends KeysGateway {
  /** How many times findByHashes was called — proves (no) caching. */
  calls: number
  setKeys(keys: FakeKeyInput[]): void
  failWith(error: unknown): void
  clearFailure(): void
}

type Row = ClientKeyRow & { created_account_id?: string | null }

export function createFakeKeysGateway(
  initial: FakeKeyInput[] = [],
): FakeKeysGateway {
  let rows = new Map<string, Row>()
  let failure: unknown = null

  const build = (keys: FakeKeyInput[]): void => {
    rows = new Map()
    for (const k of keys) {
      const { hex, base64url } = hashClientKeyBothEncodings(k.key)
      const storedHash = k.base64url ? base64url : hex
      rows.set(storedHash, {
        key_hash: storedHash,
        user_id: k.userId ?? null,
        preferred_account_id: k.preferredAccountId ?? null,
        created_account_id: k.createdAccountId ?? null,
        max_concurrency: k.maxConcurrency ?? null,
        disabled_at: k.disabledAt ?? null,
        revoked_at: k.revokedAt ?? null,
        provider_type: k.providerType ?? null,
        created_provider_type: k.createdProviderType ?? null,
      })
    }
  }
  build(initial)

  const gateway: FakeKeysGateway = {
    calls: 0,
    setKeys: build,
    failWith: (error) => {
      failure = error
    },
    clearFailure: () => {
      failure = null
    },
    // Not `async`: returns the Promise the KeysGateway port requires via
    // resolve/reject, so there is no await-less async and no bare throw. A
    // simulated backend failure rejects with a real Error object.
    findByHashes(hashes) {
      gateway.calls += 1
      if (failure) {
        return Promise.reject(
          failure instanceof Error ? failure : (
            new Error("fake keys gateway: non-Error failure injected")
          ),
        )
      }
      const out: Row[] = []
      for (const hash of hashes) {
        const row = rows.get(hash)
        if (row) out.push(row)
      }
      return Promise.resolve(out)
    },
  }
  return gateway
}
