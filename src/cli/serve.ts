#!/usr/bin/env bun
/**
 * src/cli/serve.ts — container build entry.
 *
 * WHY THIS FILE EXISTS: agent-stack's canonical `Dockerfile.proxy` bundles
 * `src/cli/serve.ts` and runs `bun dist/serve.js` with no arguments. That is the
 * ONE shared build recipe for every proxy (codex-api, kiro-api, and now
 * copilot-api), and forking it per service would mean two recipes drifting
 * apart — exactly what "单一数据源" forbids. So this proxy CONFORMS to the
 * template instead of the template learning about this proxy.
 *
 * The result is a thin, logic-free adapter: it resolves the listen address from
 * the environment the container already provides and delegates to `runServer`,
 * which stays the single owner of startup behaviour (gateway auth wiring, usage
 * emitter, provider setup). Nothing about running a Copilot request lives here.
 *
 * Port resolution order (first non-empty wins):
 *   1. HEALTH_PORT      — `Dockerfile.proxy` sets this from its SVC_PORT build
 *                         arg, and cutover-overlap.sh overrides it in lockstep
 *                         with the port it actually publishes
 *   2. COPILOT_API_PORT — agent-stack's per-service override (`<PREFIX>_PORT`)
 *                         in cutover.sh; the live container's real port
 *   3. PORT             — the conventional name an operator expects
 *   4. SVC_PORT         — the build arg, if passed through at runtime
 *   5. 39526            — this proxy's registered port (agent-stack/services.json)
 *
 * Host resolution order: COPILOT_API_HOST (cutover.sh pins it to 127.0.0.1)
 * before the conventional HOST.
 *
 * Host defaults to 0.0.0.0 because a container has to listen on its external
 * interface to be reachable; `resolveServerBinding` still refuses a non-loopback
 * bind when no gateway is configured, so this default cannot silently expose an
 * unauthenticated proxy.
 */

import { runServer } from "../start"

const DEFAULT_PORT = 39526
const DEFAULT_HOST = "0.0.0.0"

/** First parseable positive integer among the candidates, else the fallback. */
export function resolveListenPort(
  candidates: ReadonlyArray<string | undefined>,
  fallback: number = DEFAULT_PORT,
): number {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) continue
    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65_535) return parsed
  }
  return fallback
}

export function resolveListenHost(
  candidates: ReadonlyArray<string | undefined>,
  fallback: string = DEFAULT_HOST,
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed
  }
  return fallback
}

export async function serveFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runServer({
    host: resolveListenHost([env.COPILOT_API_HOST, env.HOST]),
    port: resolveListenPort([
      env.HEALTH_PORT,
      env.COPILOT_API_PORT,
      env.PORT,
      env.SVC_PORT,
    ]),
    verbose: env.COPILOT_API_VERBOSE === "1",
    showToken: false,
    proxyEnv: true,
  })
}

// Only start when executed as the entry point; importing this module (tests)
// must not bind a socket.
if (import.meta.main) {
  await serveFromEnv()
}
