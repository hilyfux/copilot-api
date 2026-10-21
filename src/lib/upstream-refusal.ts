/**
 * upstream-refusal.ts — detect Copilot's billed-but-empty refusals.
 *
 * Measured (operator report 2026-08): claude-opus-5 with > ~350k input tokens
 * answers HTTP 200, `stop_reason: "refusal"`, empty content, output_tokens=1 —
 * and GitHub still bills it (~$2/call). The user got nothing, so the user must
 * not be charged for it.
 *
 * What this proxy does: flag it on the usage row as
 * `upstreamOutcome: 'refusal'` (contract v3 UsageEvent, agent-gateway mig 172
 * usage_events.upstream_outcome) so the gateway charge worker stamps it 0 and
 * never debits balance / quota; and log one warn line per refusal (trace id /
 * model / tokens, no content) so it is never silent.
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
    } output_tokens=${details.outputTokens ?? "?"} — billed upstream with empty content; flagged upstream_outcome=refusal, the gateway charge worker will not charge the user`,
  )
}
