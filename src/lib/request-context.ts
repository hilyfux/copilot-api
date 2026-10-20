import { AsyncLocalStorage } from "node:async_hooks"

export interface RequestContext {
  traceId: string
  startTime: number
  userAgent: string
  sessionAffinity: string | undefined
  rootSessionId?: string
  parentSessionId: string | undefined
  /** sha256 hex of the presented client key; set by the managed auth middleware. */
  gatewayKeyHash?: string
  /** agent_gateway client_keys.user_id for that key. */
  gatewayUserId?: string | null
  /** Upstream account that served the request, when one was bound. */
  gatewayAccountId?: string | null
}

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

export const requestContext = {
  getStore: () => asyncLocalStorage.getStore(),
  run: <T>(context: RequestContext, callback: () => T) =>
    asyncLocalStorage.run(context, callback),
}

export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

export function resolveTraceId(traceId: string | null | undefined): string {
  const candidate = traceId?.trim()

  if (
    !candidate
    || candidate.length > TRACE_ID_MAX_LENGTH
    || !TRACE_ID_PATTERN.test(candidate)
  ) {
    return generateTraceId()
  }

  return candidate
}
