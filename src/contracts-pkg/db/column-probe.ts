/**
 * 列存在探针 —— 热路径 SQL 读「代码里有、库里可能还没有」的新列时用。
 *
 * 为什么需要：release.sh 的 pin-lookup 奇偶预检在**迁移落库之前**就用新镜像起
 * shadow 容器。热路径 SQL 直接 SELECT 新列 → ER_BAD_FIELD → 该闸门 fail-open
 * 全放行（或 500 中止 cutover）。mig 094 / 113 都踩过。
 *
 * 语义：
 *   - 查到列 → 永久记住 true（列一旦存在不会消失；forward-only 迁移）
 *   - 没查到 → 记住 false 60 秒，之后再探（迁移落库后 ≤60s 自动开始读）
 *   - 探针自己报错 → 本次按 false，不缓存（下次再试），永不抛
 */

/**
 * 只要「能发一条带参数的 SQL、返回 [rows, …]」就行 —— 结构类型，零 npm 依赖（P4 契约包，2026-10-16）。
 * mysql2 的 `Pool` / `PoolConnection` 都满足；各仓的 `GatewayDb` 端口只要有同形的 query 也满足。
 * 之前写死 `mysql2/promise` 的 Pool：只放宽类型，行为不变。
 */
export type ColumnProbeQueryable = {
  query(sql: string, values: unknown[]): Promise<readonly [unknown, ...unknown[]]>
}

export type ColumnProbe = { has(): Promise<boolean> }

const NEGATIVE_TTL_MS = 60_000

export function createColumnProbe(
  pool: ColumnProbeQueryable,
  table: string,
  column: string,
  now: () => number = Date.now,
): ColumnProbe {
  let known = false
  let negativeUntil = 0
  return {
    async has() {
      if (known) return true
      if (now() < negativeUntil) return false
      try {
        const [rows] = await pool.query(
          `SELECT 1 AS present FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
          [table, column],
        )
        if (Array.isArray(rows) && rows.length > 0) { known = true; return true }
        negativeUntil = now() + NEGATIVE_TTL_MS
        return false
      } catch (err) {
        console.warn(`[column-probe] ${table}.${column} probe failed:`, err instanceof Error ? err.message : String(err))
        return false
      }
    },
  }
}
