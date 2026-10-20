import type { MiddlewareHandler } from "hono"

import { requestContext } from "~/lib/request-context"
import { presentedKey } from "~/users/api-keys"
import type { ManagedAuthenticator } from "~/users/managed-auth"

/**
 * managed-auth middleware — replaces the fork's static `auth.apiKeys` check.
 *
 * Rejection semantics are deliberate and distinct:
 *   401 — no key presented, or the key does not exist.
 *   403 — the key exists but was revoked or disabled by an operator.
 *   503 — the gateway database could not be reached. This is NOT a credential
 *         failure: returning 401 here would tell every client its key is bad and
 *         send operators hunting for the wrong problem.
 *
 * On success the identity is attached to the request context so the usage
 * emitter can attribute the request without every handler passing it down.
 */
export function createManagedAuthMiddleware(
  authenticator: ManagedAuthenticator | null,
  options: { allowUnauthenticatedPaths?: string[] } = {},
): MiddlewareHandler {
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]

  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return next()
    }

    if (allowUnauthenticatedPaths.includes(c.req.path)) {
      return next()
    }

    // No gateway configured: standalone/local mode. The listen guard in
    // start.ts already refuses a non-loopback bind without keys, so this can
    // only be reached on loopback.
    if (!authenticator) {
      return next()
    }

    const key = presentedKey(c.req.raw)
    if (!key) {
      c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
      return c.json(
        { error: { message: "Unauthorized", type: "authentication_error" } },
        401,
      )
    }

    const outcome = await authenticator.authenticate(key)
    if (!outcome.ok) {
      if (outcome.status === 403) {
        return c.json(
          { error: { message: outcome.message, type: "permission_error" } },
          403,
        )
      }
      if (outcome.status === 503) {
        return c.json(
          { error: { message: outcome.message, type: "api_error" } },
          503,
        )
      }
      c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
      return c.json(
        { error: { message: outcome.message, type: "authentication_error" } },
        401,
      )
    }

    const store = requestContext.getStore()
    if (store) {
      store.gatewayKeyHash = outcome.identity.keyHash
      store.gatewayUserId = outcome.identity.userId
      store.gatewayAccountId = outcome.identity.preferredAccountId
    }

    return next()
  }
}
