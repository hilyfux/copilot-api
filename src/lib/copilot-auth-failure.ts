/**
 * copilot-auth-failure.ts — the seam through which "GitHub rejected our
 * credential" reaches the credential refresher, without the upstream service
 * modules depending on the gateway (铁律 2 低耦合).
 *
 * Reporters: the GitHub→Copilot token exchange (401/403) and Copilot upstream
 * requests (401). The handler (installed at the composition root) re-reads the
 * gateway credential single-flight / debounced and, when the DB still holds
 * the rejected token, re-exchanges it once and marks it bad if GitHub refuses
 * again (lib/copilot-credential-refresher.ts).
 *
 * No handler installed (standalone mode) → reports are no-ops.
 */

/** Resolves true when a (possibly different) credential is now installed. */
export type CopilotAuthFailureHandler = () => Promise<boolean>

let handler: CopilotAuthFailureHandler | null = null

export function setCopilotAuthFailureHandler(
  next: CopilotAuthFailureHandler | null,
): void {
  handler = next
}

/** Never throws: a failing handler must not mask the original upstream error. */
export async function reportCopilotAuthFailure(): Promise<boolean> {
  if (!handler) return false
  try {
    return await handler()
  } catch {
    return false
  }
}

/** Token exchange rejections: 401 (bad/revoked token) and 403 (no seat). */
export function isTokenExchangeAuthRejection(status: number): boolean {
  return status === 401 || status === 403
}

/** Copilot API rejections that mean "the bearer token is not valid". */
export function isUpstreamAuthRejection(status: number): boolean {
  return status === 401
}
