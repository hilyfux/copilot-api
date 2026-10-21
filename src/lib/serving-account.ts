/**
 * serving-account.ts — which agent-gateway `provider_accounts` row is serving
 * GitHub Copilot traffic right now.
 *
 * The usage recorder must attribute every copilot `usage_events` row to the
 * account whose GitHub token served it (`account_id`). That id is known only
 * where the credential is installed (`start.ts` → gateway credential loader /
 * credential refresher), so it is recorded here, next to the token source, and
 * read back by the recorder at request start.
 *
 * Only a gateway-sourced credential has an account id. A CLI / env / file token
 * is not a provider_accounts row, so the id is cleared — usage then carries
 * NULL rather than a stale id from a previous gateway credential.
 */
import { state } from "~/lib/state"

export type CopilotTokenSource = NonNullable<typeof state.githubTokenSource>

export function applyServingCopilotAccount(
  source: CopilotTokenSource | undefined,
  accountId: string | undefined,
): void {
  state.githubTokenSource = source
  state.copilotGatewayAccountId =
    source === "gateway" && accountId ? accountId : undefined
}

/** The serving provider_accounts id, or null when the token is not gateway-owned. */
export function getServingCopilotAccountId(): string | null {
  return state.copilotGatewayAccountId ?? null
}
