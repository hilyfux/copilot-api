/**
 * A request body without `model` is a client error and must be ANSWERED, not
 * crashed. Regression lock for the live 500:
 *
 *   POST /v1/messages {"messages":[]}
 *   → {"error":{"message":"undefined is not an object (evaluating 'u.endsWith')"}}
 *
 * handleCompletion normalised `model` (discovery-suffix stripping) before
 * anything validated it, so `undefined.endsWith` threw inside the handler and
 * surfaced as 500. Two consequences beyond the wrong status code:
 *
 *   1. Deploy gates probe with exactly this body (auth boundary = "key must NOT
 *      be 401"), so a crash counts as a pass — a broken handler looks healthy.
 *   2. A 500 tells the caller to retry; a 400 tells it to fix the request.
 */
import { describe, expect, test } from "bun:test"

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

describe("missing model is a client error, not a crash", () => {
  test("POST /v1/messages without model → 400 invalid_request_error", async () => {
    const response = await app().request("/v1/messages", {
      method: "POST",
      headers: { ...auth, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  })

  test("POST /v1/messages with an empty model string → 400, not a silent reroute", async () => {
    const response = await app().request("/v1/messages", {
      method: "POST",
      headers: { ...auth, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "", messages: [] }),
    })

    expect(response.status).toBe(400)
  })

  test("POST /v1/chat/completions without model → 400", async () => {
    const response = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  })
})
