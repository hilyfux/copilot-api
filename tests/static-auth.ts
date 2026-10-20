/**
 * staticAuthenticator — a stand-in for the gateway-backed authenticator in tests.
 *
 * Production auth reads `agent_gateway.client_keys`, which a unit test has no
 * business spinning up a MySQL for. This returns the same `AuthOutcome` shape
 * with a fixed key list so server-level tests can keep asserting on routing and
 * protocol behaviour instead of on auth.
 */
import type { ManagedAuthenticator } from "~/users/managed-auth"

export function staticAuthenticator(keys: string[]): ManagedAuthenticator {
  return {
    // Not `async`: this fake does no real I/O. It returns the Promise the
    // ManagedAuthenticator port requires via Promise.resolve, which keeps the
    // interface without an await that will never happen.
    authenticate(presented: string) {
      if (!keys.includes(presented)) {
        return Promise.resolve({
          ok: false as const,
          status: 401,
          message: "invalid api key",
        })
      }
      return Promise.resolve({
        ok: true as const,
        identity: {
          keyHash: `test-${presented}`,
          userId: null,
          preferredAccountId: null,
          providerType: "copilot",
        },
      })
    },
  }
}
