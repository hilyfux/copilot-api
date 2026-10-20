/**
 * Locks the two behaviours that let copilot-api conform to agent-stack's shared
 * Dockerfile.proxy instead of forking it:
 *
 *   1. `src/cli/serve.ts` resolves the listen address from the env names the
 *      container actually provides, in a defined order.
 *   2. `GET /health` answers without a credential, because the template's
 *      HEALTHCHECK curls it with none.
 *
 * Both were real deployment blockers: the shared recipe bundles
 * `src/cli/serve.ts` (which did not exist) and probes `/health` (which returned
 * 401 through the managed-auth middleware).
 */
import { describe, expect, test } from "bun:test"

import { resolveListenHost, resolveListenPort } from "~/cli/serve"
import { createServer } from "~/server"

describe("serve entry — env-driven listen address", () => {
  test("HEALTH_PORT (what Dockerfile.proxy sets from SVC_PORT) wins", () => {
    expect(resolveListenPort(["39526", "9999", "8888"])).toBe(39526)
  })

  test("falls through to COPILOT_API_PORT (agent-stack's <PREFIX>_PORT override)", () => {
    // cutover.sh publishes this and does NOT set HEALTH_PORT, so a live
    // container must honour it or it would bind the build-arg port instead.
    expect(resolveListenPort([undefined, "40526", "39526"])).toBe(40526)
  })

  test("falls through to PORT, then SVC_PORT, when earlier names are empty", () => {
    expect(resolveListenPort([undefined, undefined, "8080", "39526"])).toBe(
      8080,
    )
    expect(resolveListenPort(["", "  ", "  ", "39526"])).toBe(39526)
  })

  test("falls back to the registered port when nothing is set or parseable", () => {
    expect(resolveListenPort([])).toBe(39526)
    expect(resolveListenPort([undefined, ""])).toBe(39526)
    expect(resolveListenPort(["not-a-port"])).toBe(39526)
    expect(resolveListenPort(["0"])).toBe(39526)
    expect(resolveListenPort(["70000"])).toBe(39526)
  })

  test("host prefers COPILOT_API_HOST (cutover pins 127.0.0.1) over HOST", () => {
    expect(resolveListenHost(["127.0.0.1", "0.0.0.0"])).toBe("127.0.0.1")
  })

  test("host defaults to 0.0.0.0 for a container, HOST overrides", () => {
    expect(resolveListenHost([])).toBe("0.0.0.0")
    expect(resolveListenHost(["127.0.0.1"])).toBe("127.0.0.1")
  })
})

describe("GET /health — unauthenticated liveness", () => {
  test("answers 200 without a credential even when an authenticator is configured", async () => {
    const app = createServer({
      // A strict authenticator that rejects everything: /health must not reach it.
      authenticator: {
        authenticate: () =>
          Promise.resolve({
            ok: false as const,
            status: 401,
            message: "invalid api key",
          }),
      },
    })

    const response = await app.request("/health")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "ok",
      service: "copilot-api",
    })
  })

  test("a protected path is still 401 with the same authenticator", async () => {
    const app = createServer({
      authenticator: {
        authenticate: () =>
          Promise.resolve({
            ok: false as const,
            status: 401,
            message: "invalid api key",
          }),
      },
    })

    const response = await app.request("/v1/models")

    expect(response.status).toBe(401)
  })
})
