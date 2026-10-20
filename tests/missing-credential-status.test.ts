/**
 * A proxy with no Copilot credential is NOT broken — it is not configured yet,
 * and the operator fixes that by importing an account. Reporting it as 500 says
 * "server bug, retry", which is wrong twice over:
 *
 *   1. It tells the caller to retry something that will fail identically until a
 *      human acts.
 *   2. Deploy gates compare against a 5xx baseline, so a misconfigured proxy
 *      reads as "the same as live" instead of as a fault (observed on the first
 *      go-live: the real-request gate passed on 5xx parity while every request
 *      was failing).
 *
 * 503 service_unavailable is the honest answer: the route exists, the proxy is
 * running, a prerequisite is missing.
 */
import { describe, expect, test } from "bun:test"

import { forwardError } from "~/lib/error"
import { createServer } from "~/server"
import { staticAuthenticator } from "./static-auth"

const key = "test-key"

function app() {
  return createServer({ authenticator: staticAuthenticator([key]) })
}

const auth = {
  Authorization: `Bearer ${key}`,
  "content-type": "application/json",
}

describe("missing Copilot credential is a configuration state, not a server fault", () => {
  test("POST /v1/messages without a credential → 503 service_unavailable", async () => {
    const response = await app().request("/v1/messages", {
      method: "POST",
      headers: { ...auth, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(503)
    const body = (await response.json()) as {
      error: { type: string; message: string }
    }
    expect(body.error.type).toBe("service_unavailable")
    // The message must say what a human has to do, not just what is absent.
    expect(body.error.message).toContain("Copilot")
  })

  test("POST /v1/chat/completions without a credential → 503", async () => {
    const response = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(503)
  })

  test("forwardError maps the credential error regardless of route", async () => {
    // The mapping lives in the shared error funnel, so a route added later gets
    // it without remembering to special-case this string.
    const fakeContext = {
      req: { raw: { signal: new AbortController().signal } },
      json: (payload: unknown, status: number) =>
        Response.json(payload as object, { status }),
      header: () => undefined,
    } as unknown as Parameters<typeof forwardError>[0]

    const response = await forwardError(
      fakeContext,
      new Error("Copilot token not found"),
    )

    expect(response.status).toBe(503)
  })
})
