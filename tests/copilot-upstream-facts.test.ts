/**
 * Scope 8 — upstream facts from the operator's Copilot measurement report
 * (2026-08, ~480 calls on an enterprise seat). Fakes only (fake fetch / fake
 * sleep / fake exchange); no network.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import { copilotBaseUrl, getPinnedCopilotApiUrl } from "~/lib/api-config"
import {
  createCopilotCredentialRefresher,
  FORBIDDEN_BAD_MARK_MS,
} from "~/lib/copilot-credential-refresher"
import {
  forwardError,
  HTTPError,
  SYNTHETIC_RETRY_AFTER_SECONDS,
} from "~/lib/error"
import { toCopilotUpstreamModelId } from "~/lib/models"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import { applyCopilotTokenResponse, getRefreshDeadlineMs } from "~/lib/token"
import {
  configureCopilotTokenExpiryRefresh,
  ensureCopilotToken,
} from "~/lib/token-reload"
import { isUpstreamRefusal, noteUpstreamRefusal } from "~/lib/upstream-refusal"
import {
  readHostFailoverOrder,
  upstreamRecoveryDependencies,
  withCopilotHostFailover,
  withForbiddenBurstRetry,
} from "~/services/copilot/upstream-recovery"

const saved = {
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  staleAt: state.copilotTokenStaleAt,
  env: upstreamRecoveryDependencies.env,
  sleep: upstreamRecoveryDependencies.sleep,
}

beforeEach(() => {
  upstreamRecoveryDependencies.env = {}
  upstreamRecoveryDependencies.sleep = () => Promise.resolve()
})

afterEach(() => {
  state.copilotApiUrl = saved.copilotApiUrl
  state.copilotToken = saved.copilotToken
  state.copilotTokenStaleAt = saved.staleAt
  upstreamRecoveryDependencies.env = saved.env
  upstreamRecoveryDependencies.sleep = saved.sleep
  configureCopilotTokenExpiryRefresh(null)
  delete process.env.COPILOT_API_BASE_URL
})

describe("#2 Claude upstream ids must be dotted", () => {
  test.each([
    ["claude-sonnet-4-6", "claude-sonnet-4.6"],
    ["claude-opus-4-8-20260101", "claude-opus-4.8"],
    ["claude-haiku-4.5", "claude-haiku-4.5"],
    ["claude-opus-5", "claude-opus-5"],
    ["gpt-6-sol", "gpt-6-sol"],
  ])("%s → %s", (input, expected) => {
    expect(toCopilotUpstreamModelId(input)).toBe(expected)
  })
})

describe("#3 stop_reason=refusal is detected and flagged", () => {
  test("detector + one warn line with ids/tokens only", () => {
    expect(isUpstreamRefusal("refusal")).toBe(true)
    expect(isUpstreamRefusal("end_turn")).toBe(false)
    const lines: string[] = []
    requestContext.run(
      {
        traceId: "tr-1",
        startTime: 0,
        userAgent: "",
        sessionAffinity: undefined,
        parentSessionId: undefined,
        gatewayUserId: "u1",
      },
      () =>
        noteUpstreamRefusal({
          model: "claude-opus-5",
          inputTokens: 360_000,
          outputTokens: 1,
          logger: { warn: (m) => void lines.push(m) },
        }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("stop_reason=refusal")
    expect(lines[0]).toContain("traceId=tr-1")
    expect(lines[0]).toContain("flagged upstream_outcome=refusal")
  })

  test("native Messages flow flags a non-stream refusal", async () => {
    const { messagesApiFlowDependencies, handleWithMessagesApi } = await import(
      "~/routes/messages/api-flows"
    )
    const original = messagesApiFlowDependencies.createMessages
    const warn = spyOn(consola, "warn")
    messagesApiFlowDependencies.createMessages = (() =>
      Promise.resolve({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        usage: { input_tokens: 360_000, output_tokens: 1 },
      })) as unknown as typeof original
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithMessagesApi(
          c,
          {
            model: "claude-opus-5",
            max_tokens: 10,
            messages: [{ role: "user", content: "x" }],
          },
          { logger: consola, requestId: "r" },
        ),
      )
      const res = await app.request("/", { method: "POST" })
      expect(res.status).toBe(200)
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("[upstream-refusal]"),
        ),
      ).toBe(true)
    } finally {
      messagesApiFlowDependencies.createMessages = original
      warn.mockRestore()
    }
  })
})

describe("#4 421 → retry once on the alternate host; host pinnable", () => {
  test("default failover order enterprise,business,individual; configurable", () => {
    expect(readHostFailoverOrder({})).toEqual([
      "https://api.enterprise.githubcopilot.com",
      "https://api.business.githubcopilot.com",
      "https://api.githubcopilot.com",
    ])
    expect(
      readHostFailoverOrder({
        COPILOT_API_HOST_FAILOVER_ORDER: "business, individual",
      }),
    ).toEqual([
      "https://api.business.githubcopilot.com",
      "https://api.githubcopilot.com",
    ])
  })

  test("421 on api.individual → one retry on enterprise, which becomes current", async () => {
    state.copilotApiUrl = "https://api.individual.githubcopilot.com"
    const hosts: string[] = []
    const res = await withCopilotHostFailover(() => {
      hosts.push(copilotBaseUrl(state))
      return Promise.resolve(
        new Response("", { status: hosts.length === 1 ? 421 : 200 }),
      )
    })
    expect(res.status).toBe(200)
    expect(hosts).toEqual([
      "https://api.individual.githubcopilot.com",
      "https://api.enterprise.githubcopilot.com",
    ])
    expect(state.copilotApiUrl).toBe("https://api.enterprise.githubcopilot.com")
  })

  test("alternate also 421 → previous host restored, 421 returned (no loop)", async () => {
    state.copilotApiUrl = "https://api.business.githubcopilot.com"
    let sends = 0
    const res = await withCopilotHostFailover(() => {
      sends++
      return Promise.resolve(new Response("", { status: 421 }))
    })
    expect(res.status).toBe(421)
    expect(sends).toBe(2)
    expect(state.copilotApiUrl).toBe("https://api.business.githubcopilot.com")
  })

  test("pinned host (COPILOT_API_BASE_URL) wins and is never failed over", async () => {
    process.env.COPILOT_API_BASE_URL = "https://api.business.githubcopilot.com/"
    upstreamRecoveryDependencies.env = process.env
    state.copilotApiUrl = "https://api.individual.githubcopilot.com"
    expect(getPinnedCopilotApiUrl()).toBe(
      "https://api.business.githubcopilot.com",
    )
    expect(copilotBaseUrl(state)).toBe("https://api.business.githubcopilot.com")
    let sends = 0
    const res = await withCopilotHostFailover(() => {
      sends++
      return Promise.resolve(new Response("", { status: 421 }))
    })
    expect(res.status).toBe(421)
    expect(sends).toBe(1)
  })

  test("pin must be https", () => {
    expect(
      getPinnedCopilotApiUrl({ COPILOT_API_BASE_URL: "http://evil" }),
    ).toBeUndefined()
  })
})

describe("#5 429 plain text → JSON + synthesized Retry-After; 403 forbidden bursts transient", () => {
  async function render(response: Response) {
    const app = new Hono()
    app.get("/", (c) => forwardError(c, new HTTPError("x", response)))
    return app.request("/")
  }

  test("plain-text 429 without headers → rate_limit_error JSON + Retry-After", async () => {
    const res = await render(
      new Response("Too many requests, slow down", { status: 429 }),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe(
      String(SYNTHETIC_RETRY_AFTER_SECONDS),
    )
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Too many requests, slow down",
      },
    })
  })

  test("upstream Retry-After is preserved", async () => {
    const res = await render(
      new Response('{"error":{"message":"rl"}}', {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    )
    expect(res.headers.get("retry-after")).toBe("7")
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toBe("rl")
  })

  test("403 forbidden burst → back off once and retry", async () => {
    const sleeps: number[] = []
    upstreamRecoveryDependencies.sleep = (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    }
    let sends = 0
    const res = await withForbiddenBurstRetry(() => {
      sends++
      return Promise.resolve(
        sends === 1 ?
          new Response("forbidden", { status: 403 })
        : new Response("ok"),
      )
    })
    expect(res.status).toBe(200)
    expect(sends).toBe(2)
    expect(sleeps).toEqual([1_000])
  })

  test("a 403 that is not a forbidden burst is returned as-is", async () => {
    let sends = 0
    const res = await withForbiddenBurstRetry(() => {
      sends++
      return Promise.resolve(
        new Response('{"error":"model not enabled"}', { status: 403 }),
      )
    })
    expect(res.status).toBe(403)
    expect(sends).toBe(1)
  })

  test("token-exchange 403 marks the account bad only for a cooldown (not dead)", async () => {
    let clock = 0
    let reject = true
    const installs: string[] = []
    const r = createCopilotCredentialRefresher(
      {
        list: () => Promise.resolve([{ accountId: "a", githubToken: "t-a" }]),
        install: (c) => {
          if (reject)
            return Promise.reject(
              new HTTPError("x", new Response("", { status: 403 })),
            )
          installs.push(c.accountId)
          return Promise.resolve()
        },
        clear: () => {},
        now: () => clock,
        setInterval: () => 0,
        clearInterval: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      { kind: "gateway", accountId: "a", githubToken: "t-a" },
    )
    await r.reportAuthFailure()
    expect(r.currentAccountId()).toBeNull()
    reject = false
    clock += FORBIDDEN_BAD_MARK_MS - 1
    await r.tick()
    expect(installs).toEqual([]) // still cooling down
    clock += 2
    await r.tick()
    expect(installs).toEqual(["a"]) // recovered, not dead
  })
})

describe("#8 Copilot token: stale 5 min early, single-flight refresh, pre-refresh ~10 min early", () => {
  test("background pre-refresh lands 5 min before refresh_in", () => {
    expect(getRefreshDeadlineMs(1_500, 0)).toBe(1_200_000) // ≈ 10 min before a 30 min expiry
  })

  test("stale token → 20 concurrent requests share ONE exchange (double-checked lock)", async () => {
    applyCopilotTokenResponse(
      { token: "eph-1", refresh_in: 1_500, expires_at: 0 },
      Date.now() - 1_600_000,
    )
    let exchanges = 0
    configureCopilotTokenExpiryRefresh(async () => {
      exchanges++
      await Promise.resolve()
      applyCopilotTokenResponse({
        token: "eph-2",
        refresh_in: 1_500,
        expires_at: 0,
      })
    })
    await Promise.all(Array.from({ length: 20 }, () => ensureCopilotToken()))
    expect(exchanges).toBe(1)
    expect(state.copilotToken).toBe("eph-2")
  })

  test("fresh token → no exchange on the hot path", async () => {
    applyCopilotTokenResponse({
      token: "eph-1",
      refresh_in: 1_500,
      expires_at: 0,
    })
    let exchanges = 0
    configureCopilotTokenExpiryRefresh(() => {
      exchanges++
      return Promise.resolve()
    })
    await ensureCopilotToken()
    expect(exchanges).toBe(0)
  })

  test("a failed stale refresh keeps the current token (no outage)", async () => {
    applyCopilotTokenResponse(
      { token: "eph-1", refresh_in: 1, expires_at: 0 },
      Date.now() - 10_000,
    )
    configureCopilotTokenExpiryRefresh(() =>
      Promise.reject(new Error("ECONNRESET")),
    )
    await ensureCopilotToken()
    expect(state.copilotToken).toBe("eph-1")
  })
})

describe("#6 gpt max_tokens → max_completion_tokens (verified existing)", () => {
  test("chat handler rewrites for gpt models on the native chat path", async () => {
    const { completionRoutes } = await import("~/routes/chat-completions/route")
    const originalFetch = globalThis.fetch
    let sent: Record<string, unknown> = {}
    globalThis.fetch = ((_u: string, init?: RequestInit) => {
      sent = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>
      return Promise.resolve(
        Response.json({
          id: "c",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o",
          choices: [],
        }),
      )
    }) as typeof fetch
    const savedModels = state.models
    state.copilotToken = "t"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-4.1",
          supported_endpoints: ["/chat/completions"],
          capabilities: { limits: {}, supports: {} },
        },
      ],
    } as unknown as typeof state.models
    try {
      const app = new Hono()
      app.route("/", completionRoutes)
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1",
          max_tokens: 99,
          messages: [{ role: "user", content: "x" }],
        }),
      })
      expect(sent.max_completion_tokens).toBe(99)
      expect(sent.max_tokens).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      state.models = savedModels
    }
  })
})
