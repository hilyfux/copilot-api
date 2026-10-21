/**
 * Integration: the per-account limiter through the REAL route handlers
 * (createServer → /v1/chat/completions, /v1/messages, /v1/responses) with a
 * fake upstream that holds requests open. Proves the semaphore wraps the
 * actual upstream exchange — queueing instead of rejecting, holding through
 * streaming, releasing on error, and failing only after the bounded wait with
 * the fleet overloaded shape + Retry-After and no upstream call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  createAccountConcurrencyLimiter,
  type ConcurrencyLimits,
  type LimiterClock,
} from "~/lib/account-concurrency-limiter"
import { applyServingCopilotAccount } from "~/lib/serving-account"
import { state } from "~/lib/state"
import { createServer } from "~/server"
import {
  copilotConcurrencySnapshot,
  setCopilotConcurrencyLimiter,
} from "~/services/copilot/account-concurrency"
import { staticAuthenticator } from "./static-auth"

class FakeClock implements LimiterClock {
  private current = 0
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  now = () => this.current
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.current + ms, fn })
    return id
  }
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number)
  }
  advance(ms: number) {
    this.current += ms
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.current) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

const key = "test-key"
const auth = {
  Authorization: `Bearer ${key}`,
  "content-type": "application/json",
}

interface HeldCall {
  url: string
  body: Record<string, unknown>
  respond: (response: Response) => void
}

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  githubTokenSource: state.githubTokenSource,
  copilotGatewayAccountId: state.copilotGatewayAccountId,
}
let calls: Array<HeldCall> = []
let clock: FakeClock

function installLimiter(over: Partial<ConcurrencyLimits>) {
  clock = new FakeClock()
  setCopilotConcurrencyLimiter(
    createAccountConcurrencyLimiter(
      {
        accountMax: 40,
        modelMax: new Map([["claude-opus-5", 20]]),
        maxWaitMs: 120_000,
        maxHoldMs: 0,
        retryAfterSeconds: 10,
        ...over,
      },
      { clock },
    ),
  )
}

beforeEach(() => {
  calls = []
  state.copilotToken = "test-copilot-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  applyServingCopilotAccount("gateway", "77")
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    new Promise<Response>((resolve) => {
      calls.push({
        url:
          typeof input === "string" ? input
          : input instanceof URL ? input.href
          : input.url,
        body: JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>,
        respond: resolve,
      })
    })) as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  state.githubTokenSource = originalState.githubTokenSource
  state.copilotGatewayAccountId = originalState.copilotGatewayAccountId
  setCopilotConcurrencyLimiter(null)
})

const until = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for: ${label}`)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const chatJson = () =>
  Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "claude-sonnet-4.6",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

/** Answers whatever endpoint the handler picked with a valid minimal body. */
function okFor(url: string): Response {
  if (url.endsWith("/v1/messages")) {
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  if (url.endsWith("/responses")) {
    return Response.json({
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-x",
      status: "completed",
      output: [
        {
          type: "message",
          id: "m1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  }
  return chatJson()
}

function chat(app: ReturnType<typeof createServer>, extra: object = {}) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    }),
  })
}

describe("per-account limiter through the real route handlers", () => {
  test("chat/completions: over the cap the request QUEUES (no rejection) and proceeds when a slot frees", async () => {
    installLimiter({ accountMax: 2 })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const responses = [chat(app), chat(app), chat(app)]

    await until(() => calls.length === 2, "two upstream calls")
    await settle()
    expect(calls).toHaveLength(2)
    expect(copilotConcurrencySnapshot()).toEqual([
      {
        account: "77",
        inFlight: 2,
        queued: 1,
        models: { "claude-sonnet-4.6": 2 },
      },
    ])

    calls[0]?.respond(chatJson())
    await until(() => calls.length === 3, "third upstream call after a release")
    calls[1]?.respond(chatJson())
    calls[2]?.respond(chatJson())
    const statuses = await Promise.all(
      responses.map(async (r) => (await r).status),
    )
    expect(statuses).toEqual([200, 200, 200])
    expect(copilotConcurrencySnapshot()).toEqual([])
  })

  test("streaming: the slot is held until the stream ends", async () => {
    installLimiter({ accountMax: 1 })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const first = chat(app, { stream: true })
    await until(() => calls.length === 1, "first upstream call")

    let push: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller
      },
    })
    calls[0]?.respond(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    )
    const firstResponse = await first
    expect(firstResponse.status).toBe(200)

    const second = chat(app)
    await settle()
    // Headers are out and the stream is open: the slot is still held.
    expect(calls).toHaveLength(1)
    expect(copilotConcurrencySnapshot()[0]).toMatchObject({
      inFlight: 1,
      queued: 1,
    })

    const encoder = new TextEncoder()
    push?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      ),
    )
    push?.close()
    await firstResponse.text()

    await until(() => calls.length === 2, "second call after the stream ended")
    calls[1]?.respond(chatJson())
    expect((await second).status).toBe(200)
    expect(copilotConcurrencySnapshot()).toEqual([])
  })

  test("upstream error releases the slot", async () => {
    installLimiter({ accountMax: 1 })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const first = chat(app)
    const second = chat(app)
    await until(() => calls.length === 1, "first upstream call")
    calls[0]?.respond(new Response("boom", { status: 500 }))
    expect((await first).status).toBe(500)
    await until(() => calls.length === 2, "second call after the error")
    calls[1]?.respond(chatJson())
    expect((await second).status).toBe(200)
    expect(copilotConcurrencySnapshot()).toEqual([])
  })

  test("max wait → 503 overloaded_error + Retry-After, message says it waited, no upstream call", async () => {
    installLimiter({ accountMax: 1, maxWaitMs: 120_000 })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const holder = chat(app)
    await until(() => calls.length === 1, "holder upstream call")
    const waiter = chat(app)
    await settle()
    clock.advance(120_000)
    const response = await waiter
    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("10")
    const body = (await response.json()) as {
      type: string
      error: { type: string; code: string; message: string }
    }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("overloaded_error")
    expect(body.error.code).toBe("server_is_overloaded")
    expect(body.error.message).toContain("waited 120s")
    expect(calls).toHaveLength(1)

    calls[0]?.respond(chatJson())
    expect((await holder).status).toBe(200)
  })

  test("/v1/messages claude-opus-5 obeys its model cap inside the account cap", async () => {
    installLimiter({
      accountMax: 40,
      modelMax: new Map([["claude-opus-5", 1]]),
    })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const send = () =>
      app.request("/v1/messages", {
        method: "POST",
        headers: { ...auth, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    const first = send()
    const second = send()
    await until(() => calls.length === 1, "first opus call")
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.model).toBe("claude-opus-5")
    expect(copilotConcurrencySnapshot()[0]).toMatchObject({
      inFlight: 1,
      queued: 1,
    })
    calls[0]?.respond(okFor(calls[0].url))
    await until(() => calls.length === 2, "second opus call")
    calls[1]?.respond(okFor(calls[1].url))
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(copilotConcurrencySnapshot()).toEqual([])
  })

  test("/v1/responses is wrapped too", async () => {
    installLimiter({ accountMax: 1 })
    const originalModels = state.models
    state.models = {
      object: "list",
      data: [
        {
          capabilities: { limits: { max_prompt_tokens: 128000 } },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as unknown as typeof state.models
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const send = () =>
      app.request("/v1/responses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ model: "gpt-test", input: "hi" }),
      })
    try {
      const first = send()
      const second = send()
      await until(() => calls.length === 1, "first responses call")
      await settle()
      expect(calls).toHaveLength(1)
      calls[0]?.respond(okFor(calls[0].url))
      await until(() => calls.length === 2, "second responses call")
      calls[1]?.respond(okFor(calls[1].url))
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
      expect(copilotConcurrencySnapshot()).toEqual([])
    } finally {
      state.models = originalModels
    }
  })

  test("client abort while queued: removed from queue, no upstream call, nothing leaked", async () => {
    installLimiter({ accountMax: 1 })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const holder = chat(app)
    await until(() => calls.length === 1, "holder upstream call")
    const controller = new AbortController()
    const aborted = app.request("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    await settle()
    expect(copilotConcurrencySnapshot()[0]).toMatchObject({ queued: 1 })
    controller.abort()
    const abortedResponse = await Promise.resolve(aborted).catch(() => null)
    if (abortedResponse) expect(abortedResponse.status).toBe(499)
    expect(copilotConcurrencySnapshot()[0]).toMatchObject({
      inFlight: 1,
      queued: 0,
    })
    calls[0]?.respond(chatJson())
    expect((await holder).status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(copilotConcurrencySnapshot()).toEqual([])
  })

  test("/health exposes in-flight / queue per account (ids and counts only)", async () => {
    installLimiter({ accountMax: 1 })
    const app = createServer({ authenticator: staticAuthenticator([key]) })
    const holder = chat(app)
    await until(() => calls.length === 1, "holder upstream call")
    const health = (await (await app.request("/health")).json()) as {
      status: string
      copilotUpstreamConcurrency: unknown
    }
    expect(health.status).toBe("ok")
    expect(health.copilotUpstreamConcurrency).toEqual([
      {
        account: "77",
        inFlight: 1,
        queued: 0,
        models: { "claude-sonnet-4.6": 1 },
      },
    ])
    expect(JSON.stringify(health)).not.toContain("test-copilot-token")
    calls[0]?.respond(chatJson())
    await holder
  })
})
