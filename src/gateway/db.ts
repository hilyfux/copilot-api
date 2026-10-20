/**
 * gateway/db.ts — the ONLY place this service opens a connection to the
 * agent-gateway MySQL database.
 *
 * Boundary rule (高内聚 / 低耦合): every SQL string, every table name and every
 * column name that belongs to agent-gateway lives under `src/gateway/`. Business
 * modules depend on the port types exported from here, never on mysql2 itself.
 * Table/column authority = agent-gateway `docs/data-contract.md`.
 *
 * Degradation rule (铁律 3 稳定性): when the gateway database is not configured
 * the pool is `null` and every caller must fall back to its documented no-op
 * behaviour. An unreachable gateway must never take the proxy down.
 */
import mysql from "mysql2/promise"

/** A handle that can run one statement: either the pool or a transaction connection. */
export type Queryable =
  | Pick<mysql.Pool, "query">
  | Pick<mysql.PoolConnection, "query">

export type GatewayPool = mysql.Pool

/** A leased connection; the type every unit-of-work is built on. */
export type GatewayConnection = mysql.PoolConnection

export interface GatewayDbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  connectionLimit: number
}

const DEFAULT_PORT = 3306
const DEFAULT_DATABASE = "agent_gateway"
const DEFAULT_CONNECTION_LIMIT = 4

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Read the gateway connection settings from the environment.
 *
 * Returns `null` unless the four required values are present: a half-configured
 * gateway is treated as "not configured" so a typo cannot silently produce a
 * pool that fails every auth check (which would look like a credential outage
 * instead of a configuration mistake).
 */
export function readGatewayDbConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayDbConfig | null {
  const host = env.GATEWAY_MYSQL_HOST?.trim()
  const user = env.GATEWAY_MYSQL_USER?.trim()
  const password = env.GATEWAY_MYSQL_PASSWORD
  const database = env.GATEWAY_MYSQL_DATABASE?.trim() || DEFAULT_DATABASE

  if (!host || !user || password === undefined || password === "") {
    return null
  }

  return {
    host,
    port: readInt(env.GATEWAY_MYSQL_PORT, DEFAULT_PORT),
    user,
    password,
    database,
    connectionLimit: readInt(
      env.GATEWAY_MYSQL_CONNECTION_LIMIT,
      DEFAULT_CONNECTION_LIMIT,
    ),
  }
}

export function createGatewayPool(config: GatewayDbConfig): GatewayPool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    waitForConnections: true,
    // Proxy requests must never queue behind a busy pool for long: the auth
    // path needs an answer now, and usage writes are allowed to be dropped.
    queueLimit: 200,
    connectTimeout: 5_000,
    enableKeepAlive: true,
  })
}
