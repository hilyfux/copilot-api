/**
 * upstream-refusal.ts — detect Copilot's billed-but-empty refusals.
 *
 * Measured (operator report 2026-08): claude-opus-5 with > ~350k input tokens
 * answers HTTP 200, `stop_reason: "refusal"`, empty content, output_tokens=1 —
 * and GitHub still bills it (~$2/call). The user got nothing, so the user must
 * not be charged for it.
 *
 * What this proxy can do today: detect it and make it loudly observable
 * (one warn line per refusal, with trace id / model / tokens, no content).
 *
 * TODO(contract: usage-event refusal flag) — the contract package's
 * `UsageEvent` (agent-gateway src/contracts-pkg/usage/usage-event.ts, v2) has
 * NO field that tells the gateway charge worker "do not charge this row"
 * (`statusCode` is the upstream HTTP status = 200 here). Per the cross-repo
 * rules this proxy must not invent one. Needed (expand-only, optional):
 *   UsageEvent.upstreamOutcome?: 'ok' | 'refusal' | null
 *     → usage_events.upstream_outcome VARCHAR(16) NULL (gateway migration),
 *     → charge worker: rows with upstream_outcome = 'refusal' are not charged.
 * Until that lands the usage row is still written (so upstream cost stays
 * visible) and the refusal is flagged in the log for manual adjustment.
 */
import consola from "consola"

import { requestContext } from "~/lib/request-context"

export function isUpstreamRefusal(stopReason: unknown): boolean {
  return stopReason === "refusal"
}

export function noteUpstreamRefusal(details: {
  model: string
  inputTokens?: number | null | undefined
  outputTokens?: number | null | undefined
  logger?: { warn: (message: string) => void }
}): void {
  const context = requestContext.getStore()
  const logger = details.logger ?? { warn: (m: string) => consola.warn(m) }
  logger.warn(
    `[upstream-refusal] stop_reason=refusal model=${details.model} traceId=${
      context?.traceId ?? "-"
    } user=${context?.gatewayUserId ?? "-"} input_tokens=${
      details.inputTokens ?? "?"
    } output_tokens=${details.outputTokens ?? "?"} — billed upstream with empty content; must NOT be charged to the user (no contract field yet, see TODO in lib/upstream-refusal.ts)`,
  )
}
