/**
 * managed-auth.ts — authenticate a downstream client key against
 * `agent_gateway.client_keys`, replacing the fork's static `auth.apiKeys` list.
 *
 * Why this exists: key issuance, revocation and per-key concurrency limits are
 * owned by agent-gateway's admin UI. A local config array can express none of
 * that — it cannot be revoked, cannot carry a user, cannot be pinned to an
 * account, and would let anyone with the config file mint free access.
 *
 * Hot path (铁律 4): a short-TTL cache keyed by the hex digest keeps the common
 * case off MySQL. Failed lookups are NOT cached, so a revocation takes effect on
 * the next request after the TTL and a transient DB blip recovers immediately.
 */
import type { KeysGateway } from "~/gateway/keys"

import { hashClientKeyBothEncodings } from "./api-keys"

export interface ManagedIdentity {
  /** Hex digest; goes onto usage events for the cross-service join. */
  keyHash: string
  userId: string | null
  preferredAccountId: string | null
  maxConcurrency?: number
  providerType: string | null
}

export type AuthOutcome =
  | { ok: true; identity: ManagedIdentity }
  | { ok: false; status: number; message: string }

export interface ManagedAuthenticator {
  authenticate: (presentedKey: string) => Promise<AuthOutcome>
}

const DEFAULT_CACHE_TTL_MS = 30_000

export function createManagedAuthenticator(
  keys: KeysGateway,
  options: { cacheTtlMs?: number } = {},
): ManagedAuthenticator {
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const cache = new Map<string, { outcome: AuthOutcome; expires: number }>()

  return {
    async authenticate(presented): Promise<AuthOutcome> {
      if (!presented) {
        return { ok: false, status: 401, message: "missing API key" }
      }

      const { hex, base64url } = hashClientKeyBothEncodings(presented)
      const now = Date.now()
      const hit = cache.get(hex)
      if (hit && hit.expires > now) {
        return hit.outcome
      }

      let outcome: AuthOutcome
      try {
        // Hex wins when both encodings match different rows: it is what new keys
        // are minted as, so a dual hit means the base64url row is the stale one.
        const rows = await keys.findByHashes([hex, base64url])
        const row = rows.find((r) => r.key_hash === hex) ?? rows[0]

        if (!row) {
          outcome = { ok: false, status: 401, message: "invalid api key" }
        } else if (row.revoked_at) {
          outcome = { ok: false, status: 403, message: "revoked api key" }
        } else if (row.disabled_at) {
          outcome = { ok: false, status: 403, message: "disabled api key" }
        } else {
          outcome = {
            ok: true,
            identity: {
              keyHash: row.key_hash,
              userId: row.user_id,
              // Pin comes ONLY from the admin-set preferred_account_id. A NULL pin
              // means "auto", never "the account this key was created against".
              preferredAccountId: row.preferred_account_id ?? null,
              ...((
                typeof row.max_concurrency === "number"
                && row.max_concurrency > 0
              ) ?
                { maxConcurrency: row.max_concurrency }
              : {}),
              providerType:
                row.provider_type ?? row.created_provider_type ?? null,
            },
          }
        }
      } catch (error) {
        // Backend hiccup: fail closed for this request (503, not 401 — the key may
        // well be valid), and do not cache, so recovery is immediate.
        return {
          ok: false,
          status: 503,
          message: `auth backend unavailable: ${(error as Error).message}`,
        }
      }

      // Only positive outcomes are cached. A negative (unknown / revoked /
      // disabled) is re-checked every request, so re-adding, un-revoking or
      // re-enabling a key takes effect on the very next request instead of
      // waiting out the TTL — the contract this module's header promises
      // ("Failed lookups are NOT cached"). Caching misses would barely spare
      // MySQL anyway: a flood of random invalid keys never repeats a hex digest.
      if (outcome.ok) {
        cache.set(hex, { outcome, expires: now + ttl })
      }
      return outcome
    },
  }
}
