import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/lib/types/models"

export interface State {
  githubToken?: string
  githubTokenSource?: "cli" | "gateway" | "env" | "file"
  /**
   * agent-gateway provider_accounts.id whose GitHub token is installed; set
   * only for a gateway-sourced credential (see lib/serving-account.ts).
   */
  copilotGatewayAccountId?: string
  userName?: string
  copilotToken?: string
  /** Local ms after which the ephemeral Copilot token is refreshed before use. */
  copilotTokenStaleAt?: number
  codexAccessToken?: string
  codexRefreshToken?: string
  codexExpiresAt?: number
  codexAccountId?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  showToken: boolean

  verbose: boolean

  copilotApiUrl?: string
  tokenBasedBilling?: boolean
}

export const state: State = {
  accountType: "individual",
  showToken: false,
  verbose: false,
  vsCodeDeviceId: randomUUID(),
}
