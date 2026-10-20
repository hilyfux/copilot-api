/**
 * createCapturingEmitter — an in-memory UsageEmitter for tests.
 *
 * Usage used to be asserted by reading back the fork's SQLite store. Now that
 * usage is written to agent-gateway, the assertion point is the emitter: this
 * captures exactly what would have been sent, so protocol-facing tests still
 * verify token accounting without standing up MySQL.
 */
import type { UsageEventRow } from "~/gateway"
import type { UsageEmitter } from "~/users/usage-emitter"

export interface CapturingEmitter extends UsageEmitter {
  rows: UsageEventRow[]
  reset: () => void
}

export function createCapturingEmitter(): CapturingEmitter {
  const rows: UsageEventRow[] = []
  return {
    rows,
    emit: (row) => void rows.push(row),
    flush: async () => {},
    shutdown: async () => {},
    queueSize: () => rows.length,
    reset: () => void rows.splice(0, rows.length),
  }
}
