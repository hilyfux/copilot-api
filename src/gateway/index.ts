/**
 * gateway/ — this proxy's ONLY way in or out of the agent-gateway database.
 *
 * Mirrors kiro-api's `src/gateway/` boundary on purpose: one directory owns every
 * SQL string and every gateway-owned identifier, so the rest of the proxy depends
 * on port types instead of tables (铁律 1 高内聚 / 铁律 2 低耦合).
 *
 * Assembly happens once, at the composition root (`src/start.ts`). When the
 * gateway database is not configured the whole port bundle is `null` and every
 * caller takes its documented no-op path — an unavailable gateway must never
 * take the proxy down (铁律 3).
 */
import type { GatewayPool } from "./db"
import {
  createGatewayPool,
  readGatewayDbConfig,
  type GatewayDbConfig,
} from "./db"
import { createKeysGateway, type KeysGateway } from "./keys"
import { createUsageGateway, type UsageGateway } from "./usage"
import { createHealthGateway, type HealthGateway } from "./health"
import { createSettingsGateway, type SettingsGateway } from "./settings"

export type GatewayPorts = {
  keys: KeysGateway
  usage: UsageGateway
  health: HealthGateway
  settings: SettingsGateway
}

export type GatewayHandle = {
  pool: GatewayPool
  ports: GatewayPorts
  close(): Promise<void>
}

export function createGatewayPorts(pool: GatewayPool): GatewayPorts {
  return {
    keys: createKeysGateway(pool),
    usage: createUsageGateway(pool),
    health: createHealthGateway(pool),
    settings: createSettingsGateway(pool),
  }
}

/**
 * Open the gateway connection from the environment.
 *
 * Returns `null` when the four required settings are absent — callers then run
 * in standalone mode (no key auth, no usage accounting), which is exactly how a
 * developer runs this locally without a gateway.
 */
export function openGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayHandle | null {
  const config: GatewayDbConfig | null = readGatewayDbConfig(env)
  if (!config) {
    return null
  }

  const pool = createGatewayPool(config)
  return {
    pool,
    ports: createGatewayPorts(pool),
    close: () => pool.end(),
  }
}

export { readGatewayDbConfig, createGatewayPool }
export type { GatewayPool, GatewayDbConfig }
export type { KeysGateway, ClientKeyRow } from "./keys"
export type {
  UsageGateway,
  UsageUnit,
  UsageEventRow,
  DailyRow,
  SessionRow,
} from "./usage"
export type { HealthGateway, HealthState, HealthUpsert } from "./health"
export type { SettingsGateway } from "./settings"
