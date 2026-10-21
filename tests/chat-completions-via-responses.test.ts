/**
 * BUG (live 2026-10-21): GitHub answers /chat/completions with 400
 * `unsupported_api_for_model` ("model X is not accessible via the
 * /chat/completions endpoint") for all 7 GPT models; /v1/messages and
 * /v1/responses work. /v1/chat/completions must serve Responses-only models by
 * translating chat.completions ⇄ responses.
 *
 * Upstream is a fake `fetch` (routes by URL); no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { configureUsageEmitter } from "~/lib/token-usage"
import { requestContext } from "~/lib/request-context"
import { traceIdMiddleware } from "~/lib/trace"
import type { ResponsesResult } from "~/lib/types/responses"
import {
  createChatStreamState,
  translateChatToResponsesPayload,
  translateResponsesEventToChatChunks,
  translateResponsesResultToChatCompletion,
} from "~/routes/chat-completions/responses-translation"
import { completionRoutes } from "~/routes/chat-completions/route"
import {
  chatNeedsResponses,
  familyUpstreamPath,
  servablePaths,
} from "~/lib/copilot-upstream-path"

import { createCapturingEmitter } from "./capture-usage"

const originalFetch = globalThis.fetch
const capture = createCapturingEmitter()
let calls: Array<{ url: string; body: Record<string, unknown> }> = []

const UNSUPPORTED = JSON.stringify({
  error: {
    message:
      "model gpt-6-sol is not accessible via the /chat/completions endpoint",
    code: "unsupported_api_for_model",
  },
})

function responsesResult(over: Partial<ResponsesResult> = {}): ResponsesResult {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    model: "gpt-6-sol",
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ],
    output_text: "hello",
    status: "completed",
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 4 },
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    ...over,
  }
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("")
}

function installFetch(
  handler: (url: string, body: Record<string, unknown>) => Response,
) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    calls.push({ url, body })
    return Promise.resolve(handler(url, body))
  }) as typeof fetch
}

function app(): Hono {
  const a = new Hono()
  a.use(traceIdMiddleware)
  a.use(async (_c, next) => {
    const s = requestContext.getStore()
    if (s) {
      s.gatewayKeyHash = "kh"
      s.gatewayUserId = "u1"
    }
    await next()
  })
  a.route("/v1/chat/completions", completionRoutes)
  return a
}

const post = (body: Record<string, unknown>) =>
  app().request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  calls = []
  capture.reset()
  configureUsageEmitter(capture)
  state.copilotToken = "test-copilot-token"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-6-sol",
        supported_endpoints: ["/responses", "ws:/responses"],
        capabilities: { limits: { max_output_tokens: 64000 }, supports: {} },
      },
      {
        id: "gpt-4o",
        supported_endpoints: ["/chat/completions"],
        capabilities: { limits: {}, supports: {} },
      },
    ],
  } as unknown as typeof state.models
})

afterEach(() => {
  globalThis.fetch = originalFetch
  configureUsageEmitter(null)
})

describe("upstream path selection (metadata first, family table fallback)", () => {
  test("metadata ['/responses'] → chat needs responses", () => {
    expect(
      chatNeedsResponses("gpt-6-sol", { supported_endpoints: ["/responses"] }),
    ).toBe(true)
  })
  test("metadata with /chat/completions → native chat", () => {
    expect(
      chatNeedsResponses("gpt-4o", {
        supported_endpoints: ["/chat/completions"],
      }),
    ).toBe(false)
  })
  test("no metadata → family table", () => {
    expect(familyUpstreamPath("gpt-5.6-terra")).toBe("responses")
    expect(familyUpstreamPath("gpt-5.3-codex")).toBe("responses")
    expect(familyUpstreamPath("gpt-6.1-sol")).toBe("responses")
    expect(familyUpstreamPath("grok-4.5")).toBe("responses")
    expect(familyUpstreamPath("gpt-4o")).toBe("chat_completions")
    expect(familyUpstreamPath("gemini-2.5-pro")).toBe("chat_completions")
    expect(familyUpstreamPath("claude-sonnet-4.6")).toBe("messages")
    expect(chatNeedsResponses("gpt-5.4-mini", undefined)).toBe(true)
  })
  test("metadata wins over the family table", () => {
    expect([
      ...servablePaths("gpt-5.6-sol", {
        supported_endpoints: ["/chat/completions"],
      }),
    ]).toEqual(["chat_completions"])
  })
})

describe("translator: chat → responses request", () => {
  test("system prefix → instructions; tools/tool_choice/limits/effort mapped; history items in order", () => {
    const out = translateChatToResponsesPayload({
      model: "gpt-6-sol",
      stream: true,
      max_completion_tokens: 500,
      reasoning_effort: "high",
      temperature: 0.2,
      messages: [
        { role: "system", content: "be brief" },
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:x" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "f", arguments: '{"a":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "42" },
        { role: "system", content: "late note" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "f", parameters: { type: "object" } },
        },
      ],
      tool_choice: { type: "function", function: { name: "f" } },
      response_format: { type: "json_object" },
    })
    expect(out.instructions).toBe("be brief")
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "hi" },
          { type: "input_image", image_url: "data:x", detail: "auto" },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "f",
        arguments: '{"a":1}',
      },
      { type: "function_call_output", call_id: "call_1", output: "42" },
      { type: "message", role: "developer", content: "late note" },
    ])
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "f",
        strict: false,
        parameters: { type: "object" },
      },
    ])
    expect(out.tool_choice).toEqual({ type: "function", name: "f" })
    expect(out.max_output_tokens).toBe(500)
    expect(out.reasoning).toEqual({ effort: "high" })
    expect(out.temperature).toBe(0.2)
    expect(out.text).toEqual({ format: { type: "json_object" } })
    expect(out.stream).toBe(true)
    expect(out.store).toBe(false)
  })

  test("tool_choice is dropped when no tools (Copilot rejects it)", () => {
    const out = translateChatToResponsesPayload({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tool_choice: "auto",
    })
    expect(out.tool_choice).toBeUndefined()
  })
})

describe("translator: responses → chat result", () => {
  test("text + tool call + usage + finish_reason", () => {
    const r = translateResponsesResultToChatCompletion(
      responsesResult({
        output: [
          {
            id: "rs",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "thinking" }],
          },
          {
            id: "m",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
          {
            type: "function_call",
            call_id: "call_9",
            name: "g",
            arguments: "{}",
          },
        ],
      }),
      "gpt-6-sol",
    )
    expect(r.object).toBe("chat.completion")
    expect(r.choices[0].message).toEqual({
      role: "assistant",
      content: "ok",
      reasoning_text: "thinking",
      tool_calls: [
        {
          id: "call_9",
          type: "function",
          function: { name: "g", arguments: "{}" },
        },
      ],
    })
    expect(r.choices[0].finish_reason).toBe("tool_calls")
    expect(r.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 },
    })
  })

  // Live azure 2026-10-21: chat/completions with max_tokens=10 → upstream 400
  // "Invalid 'max_output_tokens': ... Expected a value >= 16". The Responses API
  // floor is 16; a client asking for fewer must still get an answer.
  test("max_tokens below the Responses floor (16) is raised to 16, larger values untouched", () => {
    const base = {
      model: "gpt-6-luna",
      messages: [{ role: "user" as const, content: "hi" }],
    }
    expect(
      translateChatToResponsesPayload({ ...base, max_tokens: 10 })
        .max_output_tokens,
    ).toBe(16)
    expect(
      translateChatToResponsesPayload({ ...base, max_completion_tokens: 1 })
        .max_output_tokens,
    ).toBe(16)
    expect(
      translateChatToResponsesPayload({ ...base, max_tokens: 16 })
        .max_output_tokens,
    ).toBe(16)
    expect(
      translateChatToResponsesPayload({ ...base, max_tokens: 500 })
        .max_output_tokens,
    ).toBe(500)
    expect(
      translateChatToResponsesPayload(base).max_output_tokens,
    ).toBeUndefined()
  })

  test("incomplete(max_output_tokens) → length", () => {
    const r = translateResponsesResultToChatCompletion(
      responsesResult({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
      "m",
    )
    expect(r.choices[0].finish_reason).toBe("length")
  })
})

describe("translator: responses SSE → chat.completion.chunk", () => {
  test("role, content, tool call (name then args), finish, usage chunk", () => {
    const st = createChatStreamState("gpt-6-sol", { includeUsage: true })
    const evts = [
      {
        type: "response.created",
        sequence_number: 0,
        response: responsesResult({ output: [] }),
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "he",
        item_id: "m",
        output_index: 0,
        content_index: 0,
      },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "c1",
          name: "f",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 3,
        output_index: 1,
        item_id: "x",
        delta: '{"a"',
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 4,
        output_index: 1,
        item_id: "x",
        delta: ":1}",
      },
      {
        type: "response.completed",
        sequence_number: 5,
        response: responsesResult(),
      },
    ]
    const out = evts.flatMap((e) =>
      translateResponsesEventToChatChunks(e as never, st),
    ) as unknown as Array<Record<string, unknown>>
    expect(
      out.every(
        (c) => (c as { object?: string }).object === "chat.completion.chunk",
      ),
    ).toBe(true)
    const deltas = out.map(
      (c) =>
        (c as { choices: Array<{ delta: unknown; finish_reason: unknown }> })
          .choices[0],
    )
    expect(deltas[0]).toMatchObject({
      delta: { role: "assistant", content: "" },
    })
    expect(deltas[1]).toMatchObject({ delta: { content: "he" } })
    expect(deltas[2]).toMatchObject({
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "c1",
            type: "function",
            function: { name: "f", arguments: "" },
          },
        ],
      },
    })
    expect(deltas[3]).toMatchObject({
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] },
    })
    expect(deltas[5]).toMatchObject({ delta: {}, finish_reason: "tool_calls" })
    expect((out[6] as { choices: unknown[]; usage: unknown }).choices).toEqual(
      [],
    )
    expect(
      (out[6] as { usage: { prompt_tokens: number } }).usage.prompt_tokens,
    ).toBe(12)
  })

  test("response.failed → error frame", () => {
    const st = createChatStreamState("m")
    const out = translateResponsesEventToChatChunks(
      {
        type: "response.failed",
        sequence_number: 1,
        response: responsesResult({
          status: "failed",
          error: { code: "x", message: "boom" },
        }),
      } as never,
      st,
    )
    expect(out).toEqual([
      { error: { message: "boom", type: "api_error", code: "x" } },
    ])
  })
})

describe("POST /v1/chat/completions for a Responses-only model", () => {
  test("non-stream: goes to /responses (never /chat/completions), returns chat.completion, records usage", async () => {
    installFetch((url) =>
      url.endsWith("/responses") ?
        Response.json(responsesResult())
      : new Response(UNSUPPORTED, { status: 400 }),
    )
    const res = await post({
      model: "gpt-6-sol",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      choices: Array<{ message: { content: string } }>
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0].message.content).toBe("hello")
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/responses"])
    expect(calls[0].body.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ])
    expect(capture.rows).toHaveLength(1)
    expect(capture.rows[0]).toMatchObject({
      inputTokens: 8,
      cacheReadTokens: 4,
      outputTokens: 3,
    })
  })

  test("stream: chat.completion.chunk frames ending [DONE]", async () => {
    installFetch((url) =>
      url.endsWith("/responses") ?
        new Response(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              response: responsesResult({ output: [] }),
            },
            {
              type: "response.output_text.delta",
              sequence_number: 1,
              delta: "hel",
              item_id: "m",
              output_index: 0,
              content_index: 0,
            },
            {
              type: "response.output_text.delta",
              sequence_number: 2,
              delta: "lo",
              item_id: "m",
              output_index: 0,
              content_index: 0,
            },
            {
              type: "response.completed",
              sequence_number: 3,
              response: responsesResult(),
            },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        )
      : new Response(UNSUPPORTED, { status: 400 }),
    )
    const res = await post({
      model: "gpt-6-sol",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const datas = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
    expect(datas.at(-1)).toBe("[DONE]")
    const chunks = datas.slice(0, -1).map(
      (d) =>
        JSON.parse(d) as {
          object: string
          choices: Array<{
            delta: { content?: string }
            finish_reason: string | null
          }>
        },
    )
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true)
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe(
      "hello",
    )
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("stop")
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/responses"])
    expect(capture.rows[0]).toMatchObject({ outputTokens: 3 })
  })

  test("stale metadata: chat upstream says unsupported_api_for_model → retried ONCE via /responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "mystery-model",
          supported_endpoints: ["/chat/completions"],
          capabilities: { limits: {}, supports: {} },
        },
      ],
    } as unknown as typeof state.models
    installFetch((url) =>
      url.endsWith("/responses") ?
        Response.json(responsesResult({ model: "mystery-model" }))
      : new Response(UNSUPPORTED, { status: 400 }),
    )
    const res = await post({
      model: "mystery-model",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/chat/completions",
      "/responses",
    ])
  })

  test("a chat-capable model still uses /chat/completions natively", async () => {
    installFetch(() =>
      Response.json({
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "x" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
    )
    const res = await post({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/chat/completions",
    ])
  })
})
