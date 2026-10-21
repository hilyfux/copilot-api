/**
 * github-token-precedence.test.ts — locks the GitHub-token source precedence
 * and the gateway-managed idle-start contract.
 *
 * Precedence (start.ts resolveGitHubToken): an explicit --github-token wins
 * first; otherwise the gateway DB is the source of truth whenever it yields a
 * copilot account with a non-empty token; the local env / file (COPILOT_API_HOME)
 * are the documented fallback for loopback / no-gateway mode only. A gateway
 * read that FAILS must fall through to the local source, never crash, and never
 * leak the token into a log.
 *
 * Idle start (start.ts planProviderStartup): with a gateway configured, a
 * missing copilot credential is NOT fatal and never triggers interactive setup.
 *
 * All sources are injected — no filesystem, env or MySQL.
 */
import { describe, expect, test } from "bun:test"
import consola from "consola"

import {
  resolveGitHubToken,
  planProviderStartup,
  type GitHubTokenSources,
} from "~/start"
import type { CredentialsGateway } from "~/gateway"

const gatewayWith = (
  value: Awaited<ReturnType<CredentialsGateway["readCopilotGitHubToken"]>>,
): CredentialsGateway => ({
  readCopilotGitHubToken: () => Promise.resolve(value),
  listCopilotGitHubTokens: () => Promise.resolve(value ? [value] : []),
})

const gatewayThatThrows = (error: Error): CredentialsGateway => ({
  readCopilotGitHubToken: () => Promise.reject(error),
  listCopilotGitHubTokens: () => Promise.reject(error),
})

// Loud defaults: if a test does not expect the env/file path, these prove it
// was never consulted by making a wrong precedence visible in the result.
const sources = (over: Partial<GitHubTokenSources>): GitHubTokenSources => ({
  cliToken: undefined,
  credentials: null,
  readEnvToken: () => undefined,
  readFileToken: () => Promise.resolve(null),
  ...over,
})

describe("resolveGitHubToken precedence", () => {
  test("gateway DB wins over env and file when a copilot account exists", async () => {
    const resolved = await resolveGitHubToken(
      sources({
        credentials: gatewayWith({
          accountId: "acc-7",
          githubToken: "gho_from_db",
        }),
        readEnvToken: () => "gho_from_env",
        readFileToken: () => Promise.resolve("gho_from_file"),
      }),
    )
    expect(resolved).toEqual({
      token: "gho_from_db",
      source: "gateway",
      accountId: "acc-7",
    })
  })

  test("explicit --github-token wins even over the gateway DB", async () => {
    const resolved = await resolveGitHubToken(
      sources({
        cliToken: "gho_from_cli",
        credentials: gatewayWith({ accountId: "acc-7", githubToken: "gho_db" }),
      }),
    )
    expect(resolved).toEqual({ token: "gho_from_cli", source: "cli" })
  })

  test("no gateway configured → falls back to env, then file", async () => {
    const envHit = await resolveGitHubToken(
      sources({ credentials: null, readEnvToken: () => "gho_env" }),
    )
    expect(envHit).toEqual({ token: "gho_env", source: "env" })

    const fileHit = await resolveGitHubToken(
      sources({
        credentials: null,
        readFileToken: () => Promise.resolve("gho_file"),
      }),
    )
    expect(fileHit).toEqual({ token: "gho_file", source: "file" })
  })

  test("gateway present but empty (no copilot account) → clean fallback to file", async () => {
    const resolved = await resolveGitHubToken(
      sources({
        credentials: gatewayWith(null),
        readFileToken: () => Promise.resolve("gho_file"),
      }),
    )
    expect(resolved).toEqual({ token: "gho_file", source: "file" })
  })

  test("gateway read failure → falls back to file, never throws, no token leak", async () => {
    const warnings: unknown[] = []
    const originalWarn = consola.warn
    consola.warn = ((...args: unknown[]) => {
      warnings.push(...args)
      return undefined
    }) as typeof consola.warn
    let resolved: Awaited<ReturnType<typeof resolveGitHubToken>>
    try {
      resolved = await resolveGitHubToken(
        sources({
          credentials: gatewayThatThrows(
            new Error("ECONNREFUSED 10.0.0.1:3306"),
          ),
          readFileToken: () => Promise.resolve("gho_file"),
        }),
      )
    } finally {
      consola.warn = originalWarn
    }
    expect(resolved).toEqual({ token: "gho_file", source: "file" })
    // The failure was observed (铁律: observable boundary)...
    expect(warnings.length).toBeGreaterThan(0)
    // ...and no token value ended up in the warning.
    expect(JSON.stringify(warnings).includes("gho_file")).toBe(false)
  })

  test("nothing anywhere → null (drives idle start)", async () => {
    expect(await resolveGitHubToken(sources({}))).toBeNull()
  })
})

describe("planProviderStartup — idle start", () => {
  test("gateway-managed + copilot enabled + no credential → idle, NOT interactive", () => {
    const plan = planProviderStartup({
      enabledProviders: [],
      copilotEnabled: true,
      gatewayManaged: true,
    })
    expect(plan.kind).toBe("idle")
  })

  test("gateway-managed + no providers + copilot disabled → idle, not an error", () => {
    const plan = planProviderStartup({
      enabledProviders: [],
      copilotEnabled: false,
      gatewayManaged: true,
    })
    expect(plan.kind).toBe("idle")
  })

  test("standalone + copilot enabled + no credential → interactive setup (unchanged)", () => {
    const plan = planProviderStartup({
      enabledProviders: [],
      copilotEnabled: true,
      gatewayManaged: false,
    })
    expect(plan.kind).toBe("interactive-setup")
  })

  test("standalone + nothing enabled + copilot disabled → hard error (unchanged)", () => {
    const plan = planProviderStartup({
      enabledProviders: [],
      copilotEnabled: false,
      gatewayManaged: false,
    })
    expect(plan.kind).toBe("no-providers-error")
  })

  test("any enabled provider short-circuits to use-enabled", () => {
    const plan = planProviderStartup({
      enabledProviders: ["codex"],
      copilotEnabled: true,
      gatewayManaged: true,
    })
    expect(plan).toEqual({ kind: "use-enabled", providers: ["codex"] })
  })
})
