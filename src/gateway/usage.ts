/**
 * gateway/usage.ts — the usage write path: usage_events / usage_daily /
 * client_sessions written in ONE transaction, plus a best-effort liveness
 * heartbeat on provider_accounts.last_proxy_use_at.
 *
 * Statement set only. Retry, requeue, FK-dropping and queue control live in
 * users/usage-emitter.ts — this file owns "one flush = one unit of work", and
 * the SQL text is deliberately byte-for-byte the kiro-api shape so both proxies
 * write the same rows the same way.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import type { GatewayConnection, GatewayPool } from "./db"
import { selectClientKeysByHash } from "./keys"

/** One usage_events row. Column order is fixed by the INSERT below. */
export type UsageEventRow = {
  requestId: string
  occurredAt: Date
  keyHash: string
  userId: string | null
  providerType: string
  accountId: string | null
  sessionId: string | null
  model: string | null
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  durationMs: number | null
  statusCode: number | null
  networkRegion: string | null
  /** mig 120. null when the request was served by the requested model as-is. */
  servedModel: string | null
  /** mig 052. 'anthropic' for /v1/messages, 'openai' for the other faces. */
  downstreamProtocol: "anthropic" | "openai" | null
}

/** usage_daily row: [user_id, provider_type, date_key, requests, in, cacheRead, cacheCreate, out, reasoning] */
export type DailyRow = (string | number)[]

export type SessionRow = {
  keyHash: string
  sessionId: string
  userId: string | null
  providerType: string
  boundAccountId: string | null
  model: string | null
  requestCount: number
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  lastActiveAt: Date
}

export type UsageUnit = {
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
  existingRequestIds(ids: string[]): Promise<Set<string>>
  userIdsByKeyHash(hashes: string[]): Promise<Map<string, string>>
  /** Legal provider_accounts.id values, for FK pre-validation before insert. */
  allAccountIds(): Promise<string[]>
  insertEvents(rows: UsageEventRow[]): Promise<void>
  upsertDaily(rows: DailyRow[]): Promise<void>
  upsertSessions(rows: SessionRow[]): Promise<void>
  touchLastProxyUse(accountId: string): Promise<void>
}

export type UsageGateway = {
  openUnit(): Promise<UsageUnit>
}

function unitOn(conn: GatewayConnection): UsageUnit {
  return {
    begin: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    release: () => conn.release(),

    async existingRequestIds(ids) {
      if (ids.length === 0) return new Set()
      const [rows] = await conn.query<
        (RowDataPacket & { request_id: string })[]
      >(`SELECT request_id FROM usage_events WHERE request_id IN (?)`, [ids])
      return new Set(rows.map((r) => r.request_id))
    },

    async userIdsByKeyHash(hashes) {
      const out = new Map<string, string>()
      for (const row of await selectClientKeysByHash(conn, hashes)) {
        if (row.user_id) out.set(row.key_hash, row.user_id)
      }
      return out
    },

    async allAccountIds() {
      const [rows] = await conn.query<(RowDataPacket & { id: string })[]>(
        // Versioned view (mig 166), not the base table: the FK we pre-validate
        // lives on provider_accounts, but a proxy's read surface is the view.
        `SELECT id FROM v_proxy_accounts_v1`,
      )
      return rows.map((r) => r.id)
    },

    async insertEvents(batch) {
      if (batch.length === 0) return
      // INSERT IGNORE is the belt to UNIQUE(request_id)'s braces: a concurrent
      // flush can commit between our SELECT and our INSERT.
      const rows = batch.map((e) => [
        e.requestId,
        e.occurredAt,
        e.keyHash,
        e.userId,
        e.providerType,
        e.accountId,
        e.sessionId,
        e.model,
        e.servedModel,
        e.downstreamProtocol,
        e.inputTokens,
        e.cacheReadTokens,
        e.cacheCreationTokens,
        e.outputTokens,
        e.reasoningTokens,
        e.durationMs,
        e.statusCode,
        e.networkRegion,
      ])
      await conn.query(
        `INSERT IGNORE INTO usage_events (
           request_id, occurred_at, key_hash, user_id, provider_type, account_id,
           session_id, model, served_model, downstream_protocol,
           input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens,
           reasoning_tokens, duration_ms, status_code, network_region
         ) VALUES ?`,
        [rows],
      )
    },

    async upsertDaily(rows) {
      if (rows.length === 0) return
      await conn.query(
        `INSERT INTO usage_daily (
           user_id, provider_type, date_key, request_count, input_tokens,
           cache_read_tokens, cache_creation_tokens, output_tokens, reasoning_tokens
         ) VALUES ?
         ON DUPLICATE KEY UPDATE
           request_count = request_count + VALUES(request_count),
           input_tokens = input_tokens + VALUES(input_tokens),
           cache_read_tokens = cache_read_tokens + VALUES(cache_read_tokens),
           cache_creation_tokens = cache_creation_tokens + VALUES(cache_creation_tokens),
           output_tokens = output_tokens + VALUES(output_tokens),
           reasoning_tokens = reasoning_tokens + VALUES(reasoning_tokens)`,
        [rows],
      )
    },

    async upsertSessions(sessions) {
      if (sessions.length === 0) return
      const rows = sessions.map((r) => [
        r.keyHash,
        r.sessionId,
        r.userId,
        r.providerType,
        r.boundAccountId,
        r.model,
        r.requestCount,
        r.inputTokens,
        r.cacheReadTokens,
        r.cacheCreationTokens,
        r.outputTokens,
        r.reasoningTokens,
        r.lastActiveAt,
      ])
      await conn.query(
        `INSERT INTO client_sessions (
           key_hash, session_id, user_id, provider_type, bound_account_id, model,
           request_count, input_tokens, cache_read_tokens, cache_creation_tokens,
           output_tokens, reasoning_tokens, last_active_at
         ) VALUES ?
         ON DUPLICATE KEY UPDATE
           user_id = COALESCE(VALUES(user_id), user_id),
           bound_account_id = COALESCE(VALUES(bound_account_id), bound_account_id),
           model = COALESCE(VALUES(model), model),
           request_count = request_count + VALUES(request_count),
           input_tokens = input_tokens + VALUES(input_tokens),
           cache_read_tokens = cache_read_tokens + VALUES(cache_read_tokens),
           cache_creation_tokens = cache_creation_tokens + VALUES(cache_creation_tokens),
           output_tokens = output_tokens + VALUES(output_tokens),
           reasoning_tokens = reasoning_tokens + VALUES(reasoning_tokens),
           last_active_at = GREATEST(last_active_at, VALUES(last_active_at)),
           ended_at = NULL`,
        [rows],
      )
    },

    async touchLastProxyUse(accountId) {
      // Server-side WHERE guard caps the write rate at ~1/min/account, so a
      // hot account does not turn into a write storm.
      await conn.query(
        `UPDATE provider_accounts
            SET last_proxy_use_at = NOW(3)
          WHERE id = ?
            AND (last_proxy_use_at IS NULL
                 OR last_proxy_use_at < NOW(3) - INTERVAL 55 SECOND)`,
        [accountId],
      )
    },
  }
}

export function createUsageGateway(pool: GatewayPool): UsageGateway {
  return {
    async openUnit() {
      return unitOn(await pool.getConnection())
    },
  }
}

export type { ResultSetHeader }
