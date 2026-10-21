/**
 * Bug (verified live 2026-10-21): every copilot usage_events row had
 * account_id = NULL.
 *
 * Root cause: the recorder took `account_id` from the request context's
 * `gatewayAccountId`, which managed auth fills from the client key's
 * admin-set `preferred_account_id` pin. Copilot keys carry no pin, so it was
 * always null — while the provider_accounts id whose GitHub token actually
 * served the request (chosen by the gateway credential loader) was only
 * logged at startup and never kept anywhere the recorder could read.
 *
 * Contract locked here: a copilot usage row carries the SERVING account id,
 * captured when the request starts (so a credential swap mid-request does not
 * re-attribute it), and the emitter's dangling-account guard keeps it when the
 * id is a real provider_accounts row.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import {
  configureUsageEmitter,
  createCopilotTokenUsageRecorder,
  createProviderTokenUsageRecorder,
} from "~/lib/token-usage"
import { applyServingCopilotAccount } from "~/lib/serving-account"

import { createCapturingEmitter } from "./capture-usage"

const ACCOUNT = "misaki-tanaka-aki_mimiofy"

function inRequest<T>(fn: () => T, pin: string | null = null): T {
  return requestContext.run(
    {
      traceId: `t-${Math.random().toString(36).slice(2)}`,
      startTime: Date.now(),
      userAgent: "test",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      gatewayKeyHash: "kh",
      gatewayUserId: "u1",
      gatewayAccountId: pin,
    },
    fn,
  )
}

afterEach(() => {
  applyServingCopilotAccount("cli", undefined)
  configureUsageEmitter(null)
})

describe("copilot usage carries the serving provider_accounts id", () => {
  test("gateway-sourced credential → usage_events.account_id = that account (key has no pin)", () => {
    const capture = createCapturingEmitter()
    configureUsageEmitter(capture)
    applyServingCopilotAccount("gateway", ACCOUNT)

    inRequest(() => {
      createCopilotTokenUsageRecorder({
        endpoint: "responses",
        model: "gpt-6-sol",
      })({ input_tokens: 10, output_tokens: 2 })
    })

    expect(capture.rows).toHaveLength(1)
    expect(capture.rows[0]?.accountId).toBe(ACCOUNT)
  })

  test("account is captured at request start — a swap before the usage lands does not re-attribute", () => {
    const capture = createCapturingEmitter()
    configureUsageEmitter(capture)
    applyServingCopilotAccount("gateway", ACCOUNT)

    inRequest(() => {
      const record = createCopilotTokenUsageRecorder({
        endpoint: "chat_completions",
        model: "gpt-6-sol",
      })
      applyServingCopilotAccount("gateway", "other-account")
      record({ input_tokens: 1, output_tokens: 1 })
    })

    expect(capture.rows[0]?.accountId).toBe(ACCOUNT)
  })

  test("local (env/file/cli) credential → no gateway account → NULL, never a stale gateway id", () => {
    const capture = createCapturingEmitter()
    configureUsageEmitter(capture)
    applyServingCopilotAccount("gateway", ACCOUNT)
    applyServingCopilotAccount("env", undefined)

    inRequest(() => {
      createCopilotTokenUsageRecorder({
        endpoint: "messages",
        model: "gpt-6-sol",
      })({ input_tokens: 1, output_tokens: 1 })
    })

    expect(capture.rows[0]?.accountId).toBeNull()
    expect(state.githubTokenSource).toBe("env")
  })

  test("non-copilot provider rows keep the key-pin behaviour", () => {
    const capture = createCapturingEmitter()
    configureUsageEmitter(capture)
    applyServingCopilotAccount("gateway", ACCOUNT)

    inRequest(() => {
      createProviderTokenUsageRecorder({
        endpoint: "provider_messages",
        model: "x",
        providerName: "acme",
      })({ input_tokens: 1, output_tokens: 1 })
    }, "pinned-acct")

    expect(capture.rows[0]?.accountId).toBe("pinned-acct")
  })
})
