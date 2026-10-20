/**
 * gateway/keys.ts — client_keys read path: API key → user / concurrency limit.
 *
 * One query serves two callers: managed auth (is this key live and whose is it)
 * and the usage writer (backfill user_id when the emitter did not know it).
 *
 * Reads the versioned view `v_proxy_keys_v1` (agent-gateway mig 166) whose
 * columns are the physical column names, so swapping FROM does not change the
 * row shape. The view is absent on hosts that have not promoted mig 166 yet —
 * `viewOrLegacy` then falls back to the base table.
 */
import type { RowDataPacket } from "mysql2/promise"

import type { GatewayPool, Queryable } from "./db"

export type ClientKeyRow = {
  key_hash: string
  user_id: string | null
  preferred_account_id: string | null
  max_concurrency: number | null
  disabled_at: Date | null
  revoked_at: Date | null
  provider_type: string | null
  created_provider_type: string | null
}

const SELECT_CLIENT_KEYS_BY_HASH = `
  SELECT key_hash, user_id, preferred_account_id, max_concurrency,
         disabled_at, revoked_at, provider_type, created_provider_type
    FROM v_proxy_keys_v1
   WHERE key_hash IN (?)`

const SELECT_CLIENT_KEYS_BY_HASH_LEGACY = `
  SELECT key_hash, user_id, preferred_account_id, max_concurrency,
         disabled_at, revoked_at, provider_type, created_provider_type
    FROM client_keys
   WHERE key_hash IN (?)`

/** MySQL error codes that mean "this view does not exist on this host". */
const MISSING_VIEW_ERRNOS = new Set([1146, 1142])

function isMissingViewError(error: unknown): boolean {
  const errno = (error as { errno?: number } | null)?.errno
  return typeof errno === "number" && MISSING_VIEW_ERRNOS.has(errno)
}

/**
 * Batch-load key rows by hash. An empty hash list issues no SQL.
 * `db` may be the pool or a transaction connection.
 */
export async function selectClientKeysByHash(
  db: Queryable,
  hashes: readonly string[],
): Promise<ClientKeyRow[]> {
  if (hashes.length === 0) {
    return []
  }

  try {
    const [rows] = await db.query<(RowDataPacket & ClientKeyRow)[]>(
      SELECT_CLIENT_KEYS_BY_HASH,
      [hashes],
    )
    return rows
  } catch (error) {
    // Only a missing view justifies a second round trip. Any other failure is
    // real and must reach the caller so it can fail the request loudly.
    if (!isMissingViewError(error)) {
      throw error
    }
    const [rows] = await db.query<(RowDataPacket & ClientKeyRow)[]>(
      SELECT_CLIENT_KEYS_BY_HASH_LEGACY,
      [hashes],
    )
    return rows
  }
}

export type KeysGateway = {
  findByHashes(hashes: readonly string[]): Promise<ClientKeyRow[]>
}

export function createKeysGateway(pool: GatewayPool): KeysGateway {
  return { findByHashes: (hashes) => selectClientKeysByHash(pool, hashes) }
}
