/**
 * gateway/view-fallback.ts — the one errno policy for the versioned read views
 * (agent-gateway mig 166 `v_proxy_*_v1`, granted to copilot_api by mig 168/171).
 *
 * Mirrors kiro-api `src/gateway/view-fallback.ts`:
 *   · 1146 ER_NO_SUCH_TABLE / 1142 ER_TABLEACCESS_DENIED_ERROR — the view, or
 *     its GRANT, is not live on this host yet (proxy deployed before the
 *     gateway migration). Take the caller's documented fallback, warn ONCE.
 *   · 1356 ER_VIEW_INVALID — the views are SQL SECURITY INVOKER, so a missing
 *     base-table COLUMN grant (or a dropped base column) surfaces here. That is
 *     a broken contract, not a rollout gap: log loudly at error level and
 *     rethrow, so the caller's fail policy runs AND an operator sees it. It is
 *     never silently treated as "empty".
 *   · anything else — rethrown untouched.
 *
 * Unlike kiro, copilot_api has no base-table SELECT on these tables, so the
 * fallback is never "the same SQL against the base table" — it is the
 * caller's fail-open default (identity strategy, upstream model list, allow).
 */

const FALLBACK_ERRNOS = new Set([1146, 1142])
export const VIEW_INVALID_ERRNO = 1356

const warned = new Set<string>()

/** @internal test hook */
export function __resetViewFallbackWarningsForTests(): void {
  warned.clear()
}

export function errnoOf(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno
  return typeof errno === "number" ? errno : undefined
}

export async function viewOrFallback<T>(
  view: string,
  viaView: () => Promise<T>,
  fallback: () => T | Promise<T>,
  logger: Pick<Console, "warn" | "error"> = console,
): Promise<T> {
  try {
    return await viaView()
  } catch (error) {
    const errno = errnoOf(error)
    if (errno !== undefined && FALLBACK_ERRNOS.has(errno)) {
      if (!warned.has(view)) {
        warned.add(view)
        logger.warn(
          `[gateway] ${view} unavailable (errno ${errno}) — using the documented fallback until agent-gateway grants it (mig 171)`,
        )
      }
      return fallback()
    }
    if (errno === VIEW_INVALID_ERRNO) {
      logger.error(
        `[gateway] ${view} is INVALID for copilot_api (errno 1356: a base-table column grant is missing or a base column was dropped) — contract broken, not falling back`,
      )
    }
    throw error
  }
}
