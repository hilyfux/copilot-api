/**
 * gateway/credentials.ts — the upstream-credential read path.
 *
 * A GitHub Copilot account is a `provider_accounts` row with
 * `provider_type='copilot'`. The long-lived GitHub OAuth token the gateway
 * obtained for it (via a browser device-code flow the gateway runs) is stored
 * on that row's `access_token` column and exposed through the versioned read
 * view `v_proxy_accounts_v1` (agent-gateway mig 166; the `access_token` /
 * `provider_type` column grants for the `copilot_api` MySQL user land in mig
 * 169). copilot-api READS that GitHub token and performs its OWN
 * GitHub→Copilot ephemeral-token exchange at runtime — the gateway owns every
 * write to `access_token`, this proxy never writes it.
 *
 * Boundary rule (铁律 1 高内聚 / 铁律 2 低耦合): this file owns the single SQL
 * string and the single secret column that carries the credential. The rest of
 * the proxy depends on the `CredentialsGateway` port, never on mysql2 or on the
 * table/column names. Responsibility is deliberately narrow: read the GitHub
 * token for a copilot-family account — nothing else.
 *
 * Selection (铁律 4 并发 / 铁律 6 扩展): only NON-disabled copilot accounts are
 * eligible — the WHERE adds `disabled_at IS NULL` (readable via mig 169's
 * column grant), so a disabled account's token is never exchanged. When more
 * than one eligible copilot account carries a usable token the
 * least-recently-used one is chosen
 * (`last_proxy_use_at` ascending, a never-used account first), with `id` as the
 * deterministic tiebreak. That is the same least-loaded convention the fleet
 * uses to spread upstream load, and it is stable for any given row set, so the
 * pick is reproducible under test.
 *
 * Degradation rule (铁律 3 稳定性 / 铁律 5 鲁棒性): the view may not be promoted
 * on a host yet — a missing-view error (errno 1146 / 1142) falls back to the
 * base table exactly once, mirroring `keys.ts` / `settings.ts`. Any OTHER error
 * is a real fault and is rethrown so the caller can log it and fall back to its
 * documented local source rather than silently masking an outage.
 *
 * Secret rule (NON-NEGOTIABLE #4): the token value is NEVER logged here. This
 * module never calls a logger; callers log only the chosen account id.
 */
import type { RowDataPacket } from "mysql2/promise"

import type { GatewayPool, Queryable } from "./db"

/** The resolved credential for one copilot account. `githubToken` is secret. */
export type CopilotCredential = {
  accountId: string
  githubToken: string
}

/** The copilot-family filter this proxy keys on (matches the deploy keyFilter). */
export const COPILOT_PROVIDER_TYPE = "copilot"

type AccountRow = {
  id: string
  access_token: string | null
  last_proxy_use_at: Date | string | null
  disabled_at: Date | string | null
}

const SELECT_COPILOT_ACCOUNTS = `
  SELECT id, access_token, last_proxy_use_at, disabled_at
    FROM v_proxy_accounts_v1
   WHERE provider_type = ?
     AND access_token IS NOT NULL
     AND access_token <> ''
     AND disabled_at IS NULL`

const SELECT_COPILOT_ACCOUNTS_LEGACY = `
  SELECT id, access_token, last_proxy_use_at, disabled_at
    FROM provider_accounts
   WHERE provider_type = ?
     AND access_token IS NOT NULL
     AND access_token <> ''
     AND disabled_at IS NULL`

/** MySQL error codes that mean "this view does not exist / is not granted here". */
const MISSING_VIEW_ERRNOS = new Set([1146, 1142])

function isMissingViewError(error: unknown): boolean {
  const errno = (error as { errno?: number } | null)?.errno
  return typeof errno === "number" && MISSING_VIEW_ERRNOS.has(errno)
}

/** Milliseconds since epoch of the account's last proxy use; never-used = -∞. */
function lastUseMs(row: AccountRow): number {
  const value = row.last_proxy_use_at
  if (value === null || value === undefined) {
    return Number.NEGATIVE_INFINITY
  }
  const time =
    value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/** Deterministic least-loaded pick: least-recently-used first, id as tiebreak. */
function isLessLoaded(candidate: AccountRow, incumbent: AccountRow): boolean {
  const candidateUse = lastUseMs(candidate)
  const incumbentUse = lastUseMs(incumbent)
  if (candidateUse !== incumbentUse) {
    return candidateUse < incumbentUse
  }
  return candidate.id < incumbent.id
}

function pickLeastRecentlyUsed(rows: readonly AccountRow[]): AccountRow | null {
  let chosen: AccountRow | null = null
  for (const row of rows) {
    // The SQL already filters empty tokens, but a legacy base-table row or a
    // view that drops the filter must never yield an empty credential.
    if (!row.access_token || row.access_token.trim() === "") {
      continue
    }
    // Same defensive posture for the disabled filter: the SQL already drops
    // `disabled_at IS NOT NULL` rows, but a disabled account's token must never
    // be selected even if a legacy/looser query path were to return one.
    if (row.disabled_at !== null && row.disabled_at !== undefined) {
      continue
    }
    if (chosen === null || isLessLoaded(row, chosen)) {
      chosen = row
    }
  }
  return chosen
}

async function queryCopilotAccounts(db: Queryable): Promise<AccountRow[]> {
  try {
    const [rows] = await db.query<(RowDataPacket & AccountRow)[]>(
      SELECT_COPILOT_ACCOUNTS,
      [COPILOT_PROVIDER_TYPE],
    )
    return rows
  } catch (error) {
    // Only a missing/ungranted view justifies the base-table retry. Any other
    // failure is a real fault and must reach the caller.
    if (!isMissingViewError(error)) {
      throw error
    }
    const [rows] = await db.query<(RowDataPacket & AccountRow)[]>(
      SELECT_COPILOT_ACCOUNTS_LEGACY,
      [COPILOT_PROVIDER_TYPE],
    )
    return rows
  }
}

/**
 * Read the GitHub token for the chosen copilot account, or `null` when the
 * gateway holds no copilot account with a non-empty `access_token` (the idle
 * state before the operator imports one). `db` may be the pool or a
 * transaction connection.
 */
export async function selectCopilotGitHubToken(
  db: Queryable,
): Promise<CopilotCredential | null> {
  const rows = await queryCopilotAccounts(db)
  const chosen = pickLeastRecentlyUsed(rows)
  if (!chosen || !chosen.access_token) {
    return null
  }
  return { accountId: chosen.id, githubToken: chosen.access_token }
}

export type CredentialsGateway = {
  /**
   * The GitHub token of the least-loaded copilot account, or `null` when none
   * carries a usable token. Never throws for the "no account" case; a real DB
   * fault rejects so the caller can fall back to its local source.
   */
  readCopilotGitHubToken(): Promise<CopilotCredential | null>
}

export function createCredentialsGateway(
  pool: GatewayPool,
): CredentialsGateway {
  return { readCopilotGitHubToken: () => selectCopilotGitHubToken(pool) }
}
