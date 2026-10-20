/**
 * usage-emitter.ts — buffered gateway usage writer.
 *
 * Replaces the fork's SQLite `token-usage` store. The shape is deliberately the
 * same as kiro-api's emitter so both proxies write the same rows the same way
 * and a cross-repo log grep works for either:
 *
 *   1. filterAlreadyInserted — a requeued batch may contain events whose
 *      usage_events row already committed (UNIQUE request_id). Those are
 *      excluded so the daily / sessions upserts are not double-applied.
 *   2. resolveUserIds — events with a null userId get a flush-time
 *      key_hash → user_id lookup. Still-null events keep NULL in usage_events
 *      (contract-legal) but MUST be skipped by upsertDaily, whose primary key
 *      forbids a NULL user_id.
 *   3. refreshAccountIdSet — FK pre-validation: an accountId not present in
 *      provider_accounts is nulled instead of poisoning the whole batch.
 *   4. insertEvents + upsertDaily + upsertSessions in ONE transaction. On
 *      failure the transaction rolls back and the batch is requeued at the
 *      front — except FK violations, which are schema-level, not transient, and
 *      are dropped with a warning rather than retried forever.
 *   5. touchLastProxyUse AFTER the commit — best-effort liveness heartbeat.
 *
 * Iron rule 3: the HTTP path never blocks on accounting. When the queue is full
 * the oldest event is dropped.
 */
import type { UsageEventRow, UsageGateway, UsageUnit } from "~/gateway"

export interface UsageEmitter {
  emit: (event: UsageEventRow) => void
  flush: () => Promise<void>
  shutdown: () => Promise<void>
  queueSize: () => number
}

const DEFAULTS = { flushIntervalMs: 10_000, queueCap: 5_000, flushBatch: 500 }

const USER_ID_CACHE = new Map<string, string>()

/** Test-only: clear the process-wide key_hash → user_id cache. */
export function __resetUserIdCacheForTests(): void {
  USER_ID_CACHE.clear()
}

let ACCOUNT_ID_SET: Set<string> | null = null
let ACCOUNT_ID_SET_REFRESHED_AT = 0
const ACCOUNT_ID_CACHE_TTL_MS = 60_000

/** Test-only: clear the process-wide account-id cache. */
export function __resetAccountIdCacheForTests(): void {
  ACCOUNT_ID_SET = null
  ACCOUNT_ID_SET_REFRESHED_AT = 0
}

export function nullUsageEmitter(): UsageEmitter {
  return {
    emit: () => {},
    flush: async () => {},
    shutdown: async () => {},
    queueSize: () => 0,
  }
}

function dateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function isForeignKeyError(error: unknown): boolean {
  const errno = (error as { errno?: number } | null)?.errno
  return errno === 1216 || errno === 1217 || errno === 1451 || errno === 1452
}

async function refreshAccountIdSet(unit: UsageUnit): Promise<Set<string>> {
  const now = Date.now()
  if (
    ACCOUNT_ID_SET
    && now - ACCOUNT_ID_SET_REFRESHED_AT < ACCOUNT_ID_CACHE_TTL_MS
  ) {
    return ACCOUNT_ID_SET
  }
  ACCOUNT_ID_SET = new Set(await unit.allAccountIds())
  ACCOUNT_ID_SET_REFRESHED_AT = now
  return ACCOUNT_ID_SET
}

async function filterAlreadyInserted(
  unit: UsageUnit,
  batch: readonly UsageEventRow[],
): Promise<UsageEventRow[]> {
  if (batch.length === 0) return []

  const seen = new Set<string>()
  const deduped: UsageEventRow[] = []
  for (const event of batch) {
    if (seen.has(event.requestId)) continue
    seen.add(event.requestId)
    deduped.push(event)
  }

  const present = await unit.existingRequestIds(deduped.map((e) => e.requestId))
  return present.size === 0 ?
      deduped
    : deduped.filter((e) => !present.has(e.requestId))
}

async function resolveUserIds(
  unit: UsageUnit,
  batch: UsageEventRow[],
): Promise<void> {
  const missing = [
    ...new Set(batch.filter((e) => !e.userId).map((e) => e.keyHash)),
  ]
  if (missing.length === 0) return

  const unknown = missing.filter((hash) => !USER_ID_CACHE.has(hash))
  if (unknown.length > 0) {
    const resolved = await unit.userIdsByKeyHash(unknown)
    for (const [hash, userId] of resolved) USER_ID_CACHE.set(hash, userId)
  }

  for (const event of batch) {
    if (!event.userId) event.userId = USER_ID_CACHE.get(event.keyHash) ?? null
  }
}

export function createUsageEmitter(
  usage: UsageGateway,
  options: {
    flushIntervalMs?: number
    queueCap?: number
    flushBatch?: number
    logger?: { warn: (message: string) => void }
  } = {},
): UsageEmitter {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs
  const queueCap = options.queueCap ?? DEFAULTS.queueCap
  const flushBatch = options.flushBatch ?? DEFAULTS.flushBatch
  const logger = options.logger ?? {
    warn: (message: string) => console.warn(`[usage-emitter] ${message}`),
  }

  const queue: UsageEventRow[] = []
  let flushing = false

  const timer =
    flushIntervalMs > 0 ?
      setInterval(() => void flushNow(), flushIntervalMs)
    : null
  if (timer && typeof timer.unref === "function") timer.unref()

  function enqueue(event: UsageEventRow): void {
    if (queue.length >= queueCap) queue.shift()
    queue.push(event)
  }

  async function flushNow(): Promise<void> {
    if (flushing || queue.length === 0) return
    flushing = true
    const batch = queue.splice(0, flushBatch)
    let unit: UsageUnit | null = null

    try {
      unit = await usage.openUnit()
      await unit.begin()

      const todo = await filterAlreadyInserted(unit, batch)
      if (todo.length === 0) {
        await unit.commit()
        return
      }

      await resolveUserIds(unit, todo)

      const validIds = await refreshAccountIdSet(unit)
      let nulled = 0
      for (const event of todo) {
        if (event.accountId && !validIds.has(event.accountId)) {
          logger.warn(
            `accountId='${event.accountId}' not in provider_accounts; persisting with NULL account_id (requestId=${event.requestId})`,
          )
          event.accountId = null
          nulled++
        }
      }
      if (nulled > 0) {
        logger.warn(
          `pre-flush nulled ${nulled}/${todo.length} dangling accountIds`,
        )
      }

      await unit.insertEvents(todo)

      // usage_daily's primary key forbids a NULL user_id, so an event whose user
      // could not be resolved is kept in usage_events (contract-legal) and kept
      // out of the daily rollup. One such row would otherwise fail the batch
      // forever.
      const withUser = todo.filter(
        (e): e is UsageEventRow & { userId: string } => e.userId !== null,
      )
      const daily = new Map<string, (string | number)[]>()
      for (const event of withUser) {
        const key = `${event.userId}|${event.providerType}|${dateKeyUtc(event.occurredAt)}`
        const row = daily.get(key)
        if (row) {
          row[3] = (row[3] as number) + 1
          row[4] = (row[4] as number) + event.inputTokens
          row[5] = (row[5] as number) + event.cacheReadTokens
          row[6] = (row[6] as number) + event.cacheCreationTokens
          row[7] = (row[7] as number) + event.outputTokens
          row[8] = (row[8] as number) + event.reasoningTokens
        } else {
          daily.set(key, [
            event.userId,
            event.providerType,
            dateKeyUtc(event.occurredAt),
            1,
            event.inputTokens,
            event.cacheReadTokens,
            event.cacheCreationTokens,
            event.outputTokens,
            event.reasoningTokens,
          ])
        }
      }
      await unit.upsertDaily([...daily.values()])

      const sessions = new Map<
        string,
        {
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
      >()
      for (const event of withUser) {
        if (!event.sessionId) continue
        const key = `${event.keyHash}|${event.sessionId}|${event.providerType}`
        const row = sessions.get(key)
        if (row) {
          row.requestCount += 1
          row.inputTokens += event.inputTokens
          row.cacheReadTokens += event.cacheReadTokens
          row.cacheCreationTokens += event.cacheCreationTokens
          row.outputTokens += event.outputTokens
          row.reasoningTokens += event.reasoningTokens
          if (event.occurredAt > row.lastActiveAt)
            row.lastActiveAt = event.occurredAt
          row.model = event.servedModel ?? event.model ?? row.model
        } else {
          sessions.set(key, {
            keyHash: event.keyHash,
            sessionId: event.sessionId,
            userId: event.userId,
            providerType: event.providerType,
            boundAccountId: event.accountId,
            model: event.servedModel ?? event.model,
            requestCount: 1,
            inputTokens: event.inputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            outputTokens: event.outputTokens,
            reasoningTokens: event.reasoningTokens,
            lastActiveAt: event.occurredAt,
          })
        }
      }
      await unit.upsertSessions([...sessions.values()])

      await unit.commit()

      // After the event transaction is durable: a heartbeat failure must never
      // poison rows that already committed.
      const accountIds = new Set(
        todo.map((e) => e.accountId).filter((id): id is string => Boolean(id)),
      )
      for (const accountId of accountIds) {
        try {
          await unit.touchLastProxyUse(accountId)
        } catch (error) {
          logger.warn(
            `last_proxy_use_at heartbeat failed (events still committed): ${
              (error as Error)?.message ?? String(error)
            }`,
          )
        }
      }
    } catch (error) {
      try {
        if (unit) await unit.rollback()
      } catch {
        // The connection may already be gone; the requeue below still applies.
      }

      if (isForeignKeyError(error)) {
        ACCOUNT_ID_SET = null
        ACCOUNT_ID_SET_REFRESHED_AT = 0
        logger.warn(
          `flush dropped ${batch.length} events: FK violation (errno=${
            (error as { errno?: number }).errno
          }) — ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }

      const room = queueCap - queue.length
      const requeue = batch.slice(0, Math.max(0, room))
      queue.unshift(...requeue)
      logger.warn(
        `flush failed, requeued ${requeue.length}/${batch.length} (will retry): ${
          (error as Error).message
        }`,
      )
    } finally {
      try {
        unit?.release()
      } catch {
        // Releasing a dead connection is a no-op.
      }
      flushing = false
    }
  }

  return {
    emit: enqueue,
    flush: flushNow,
    async shutdown() {
      if (timer) clearInterval(timer)
      const deadline = Date.now() + 10_000
      while (queue.length > 0 && Date.now() < deadline) await flushNow()
    },
    queueSize: () => queue.length,
  }
}
