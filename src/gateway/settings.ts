/**
 * gateway/settings.ts — app_settings read path.
 *
 * The full key set this proxy reads is registered here so the contract surface
 * is visible in one place. Values are returned raw; parsing and defaults belong
 * to the consuming module.
 */
import type { RowDataPacket } from "mysql2/promise"

import type { GatewayPool } from "./db"

export const SETTING_KEYS = {
  /** Max concurrent sessions a single client key may hold. */
  clientMaxConcurrentSessions: "client_max_concurrent_sessions",
  /** Max concurrent sessions one upstream account may serve. */
  providerAccountMaxSessions: "provider_account_max_sessions",
} as const

/**
 * Reads the versioned view (agent-gateway mig 166). The view is a WHITELIST —
 * app_settings also holds unsubscribe secrets, SMS config and alert webhooks
 * that a proxy must never be able to read. Going through the view is therefore
 * both the contract and a security boundary, not just indirection.
 */
const SELECT_SETTINGS = `
  SELECT setting_key, setting_value
    FROM v_proxy_settings_v1
   WHERE setting_key IN (?)`

const SELECT_SETTINGS_LEGACY = `
  SELECT setting_key, setting_value
    FROM app_settings
   WHERE setting_key IN (?)`

/** 1146 no-such-table / 1142 table-access-denied = view or its GRANT not live yet. */
const MISSING_VIEW_ERRNOS = new Set([1146, 1142])

export type SettingsGateway = {
  /** Keys with no row are absent from the returned map. */
  readValues(keys: readonly string[]): Promise<Map<string, string>>
}

export function createSettingsGateway(pool: GatewayPool): SettingsGateway {
  return {
    async readValues(keys) {
      if (keys.length === 0) {
        return new Map()
      }
      const read = async (sql: string) => {
        const [rows] = await pool.query<
          (RowDataPacket & { setting_key: string; setting_value: string })[]
        >(sql, [keys])
        return new Map(rows.map((r) => [r.setting_key, r.setting_value]))
      }

      try {
        return await read(SELECT_SETTINGS)
      } catch (error) {
        const errno = (error as { errno?: number } | null)?.errno
        if (typeof errno === "number" && MISSING_VIEW_ERRNOS.has(errno)) {
          return read(SELECT_SETTINGS_LEGACY)
        }
        throw error
      }
    },
  }
}
