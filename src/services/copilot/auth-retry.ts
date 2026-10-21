/**
 * auth-retry.ts — one retry for a Copilot upstream request rejected with 401.
 *
 * A 401 from the Copilot API means the bearer (ephemeral Copilot token) is no
 * longer accepted: it expired early, or the GitHub token behind it was
 * revoked / replaced in the gateway. The failure is reported to the
 * credential refresher (lib/copilot-auth-failure.ts → single-flight,
 * debounced re-read + re-exchange, marking a GitHub-refused token bad and
 * moving to the next account). If that installs a DIFFERENT ephemeral token,
 * the request is retried exactly once with it; otherwise the original 401 is
 * returned untouched for the normal error path.
 *
 * `headers` is mutated in place: `send` must read it at call time.
 */
import {
  isUpstreamAuthRejection,
  reportCopilotAuthFailure,
} from "~/lib/copilot-auth-failure"
import { state } from "~/lib/state"

export async function withCopilotAuthRetry(
  headers: Record<string, string>,
  send: () => Promise<Response>,
): Promise<Response> {
  const first = await send()
  if (!isUpstreamAuthRejection(first.status)) return first

  const rejectedToken = state.copilotToken
  const recovered = await reportCopilotAuthFailure()
  const nextToken = state.copilotToken
  if (!recovered || !nextToken || nextToken === rejectedToken) return first

  await first.body?.cancel().catch(() => {})
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") {
      headers[key] = `Bearer ${nextToken}`
    }
  }
  return send()
}
