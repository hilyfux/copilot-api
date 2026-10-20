#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"

import { runProviderSetup } from "./auth"
import { isGitHubCopilotEnabled } from "./lib/github-copilot-provider"
import { listEnabledProviders, mergeConfigWithDefaults } from "./lib/config"
import { setupCopilotRuntime } from "~/lib/copilot-runtime"
import {
  GITHUB_TOKEN_ENV,
  readGitHubToken,
  readGitHubTokenFromEnv,
} from "./lib/credential-store"
import { startModelsDevCache } from "./lib/models-dev-cache"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  resolveServerBinding,
} from "./lib/server-host"
import { state } from "./lib/state"
import { configureTokenReloader } from "./lib/token-reload"
import { configureUsageEmitter } from "./lib/token-usage"
import { openGatewayFromEnv, type CredentialsGateway } from "./gateway"
import { createManagedAuthenticator } from "./users/managed-auth"
import { createUsageEmitter, nullUsageEmitter } from "./users/usage-emitter"

interface RunServerOptions {
  host: string
  port: number
  verbose: boolean
  githubToken?: string
  showToken: boolean
  proxyEnv: boolean
}

type GitHubTokenSource = "cli" | "gateway" | "env" | "file"

export type ResolvedGitHubToken = {
  token: string
  source: GitHubTokenSource
  /** Set only for the gateway source: the provider_accounts id that won. */
  accountId?: string
}

/**
 * Sources the GitHub token resolver may draw from, injectable for tests so a
 * unit test never has to touch the real filesystem, environment or a MySQL.
 */
export interface GitHubTokenSources {
  cliToken?: string | undefined
  /**
   * The gateway credential reader, or `null` in loopback / no-gateway mode.
   * When present AND it yields a copilot account with a non-empty token, the
   * gateway DB is the source of truth.
   */
  credentials?: CredentialsGateway | null
  readEnvToken?: () => string | undefined
  readFileToken?: () => Promise<string | null>
}

/**
 * Precedence (NON-NEGOTIABLE #3): the gateway database is the source of truth
 * when a gateway is configured AND a copilot account with a non-empty
 * access_token exists. The local env / file (COPILOT_API_HOME) remain ONLY as a
 * documented fallback for loopback / no-gateway mode. An explicit
 * `--github-token` still wins first, because it is a deliberate operator
 * override.
 *
 * The switch is observable: every caller logs which source won (see
 * `setupCopilotMode`), and a gateway read that FAILS (a real DB fault, not the
 * clean "no copilot account" case which returns null) is logged and falls
 * through to env / file rather than crashing the startup (铁律 3 稳定性). The
 * token value itself is never logged (NON-NEGOTIABLE #4).
 */
export async function resolveGitHubToken(
  sources: GitHubTokenSources,
): Promise<ResolvedGitHubToken | null> {
  const readEnvToken = sources.readEnvToken ?? readGitHubTokenFromEnv
  const readFileToken = sources.readFileToken ?? readGitHubToken

  if (sources.cliToken) return { token: sources.cliToken, source: "cli" }

  if (sources.credentials) {
    try {
      const credential = await sources.credentials.readCopilotGitHubToken()
      if (credential) {
        return {
          token: credential.githubToken,
          source: "gateway",
          accountId: credential.accountId,
        }
      }
    } catch (error) {
      consola.warn(
        "Failed to read the GitHub Copilot credential from agent-gateway; falling back to the local token source.",
        error,
      )
    }
  }

  const envToken = readEnvToken()
  if (envToken) return { token: envToken, source: "env" }

  const fileToken = await readFileToken()
  if (fileToken) return { token: fileToken, source: "file" }

  return null
}

async function setupCopilotMode(
  githubToken: string,
  source: GitHubTokenSource,
  accountId?: string,
): Promise<void> {
  state.githubTokenSource = source
  consola.info(
    source === "cli" ? "Using provided GitHub token"
    : source === "gateway" ?
      `Using GitHub token from agent-gateway (provider_accounts #${accountId ?? "?"}, provider_type='copilot')`
    : source === "env" ?
      `Using GitHub token from the ${GITHUB_TOKEN_ENV} environment variable`
    : "Using GitHub token from local file",
  )

  await setupCopilotRuntime(githubToken)
}

/**
 * The startup decision once no GitHub token could be resolved. Pure and
 * exported so the idle-start contract can be locked by a unit test without
 * binding a server.
 *
 * `gatewayManaged` is true when a gateway connection is configured. In that
 * mode a missing copilot credential is NOT fatal and NEVER triggers the
 * interactive setup: the operator imports the Copilot account through the
 * gateway admin UI AFTER the system is live, so the proxy must come up healthy
 * and idle, failing only individual Copilot requests until a credential exists.
 */
export type ProviderStartupPlan =
  | { kind: "use-enabled"; providers: string[] }
  | { kind: "idle"; reason: string }
  | { kind: "interactive-setup" }
  | { kind: "no-providers-error" }

export function planProviderStartup(input: {
  enabledProviders: string[]
  copilotEnabled: boolean
  gatewayManaged: boolean
}): ProviderStartupPlan {
  if (input.enabledProviders.length > 0) {
    return { kind: "use-enabled", providers: input.enabledProviders }
  }

  if (!input.copilotEnabled) {
    return input.gatewayManaged ?
        {
          kind: "idle",
          reason: "no enabled providers and GitHub Copilot is disabled",
        }
      : { kind: "no-providers-error" }
  }

  // GitHub Copilot is enabled but no credential was loaded.
  return input.gatewayManaged ?
      {
        kind: "idle",
        reason:
          "GitHub Copilot is enabled but the gateway holds no copilot account with an access_token yet",
      }
    : { kind: "interactive-setup" }
}

async function setupProviderMode(options: {
  gatewayManaged: boolean
}): Promise<void> {
  const plan = planProviderStartup({
    enabledProviders: listEnabledProviders(),
    copilotEnabled: isGitHubCopilotEnabled(),
    gatewayManaged: options.gatewayManaged,
  })

  switch (plan.kind) {
    case "use-enabled": {
      consola.info(`Using enabled providers: ${plan.providers.join(", ")}`)
      return
    }
    case "idle": {
      consola.warn(
        `Starting idle (${plan.reason}). The server is healthy; Copilot requests fail gracefully until a credential is imported through the gateway.`,
      )
      return
    }
    case "no-providers-error": {
      throw new Error(
        "No enabled providers found. Enable GitHub Copilot with `copilot-api provider enable github-copilot`, or enable another configured provider.",
      )
    }
    case "interactive-setup": {
      break
    }
  }

  consola.info("No enabled providers found. Setting one up...")
  await runProviderSetup()

  if (state.githubToken && isGitHubCopilotEnabled()) {
    // The setup flow persisted the token with the credential store.
    await setupCopilotMode(state.githubToken, "file")
    return
  }

  const providersAfterSetup = listEnabledProviders()
  if (providersAfterSetup.length === 0) {
    throw new Error(
      "Failed to configure any provider. Run `copilot-api auth login` to set one up.",
    )
  }
  consola.info(`Configured providers: ${providersAfterSetup.join(", ")}`)
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  consola.options.throttle = 0

  mergeConfigWithDefaults()

  // Auth is owned by agent-gateway now: a non-loopback bind is only allowed once
  // a gateway connection is configured, because that is the only thing that can
  // tell a valid key from an invalid one. Without it, binding publicly would mean
  // serving an unauthenticated proxy to the network.
  const gateway = openGatewayFromEnv()

  const binding = resolveServerBinding(options.host, gateway !== null)

  if (gateway) {
    consola.info(
      "Gateway auth enabled: client keys are validated against agent_gateway.client_keys.",
    )
  } else if (binding.networkExposed) {
    consola.warn(
      "GATEWAY_MYSQL_* is not configured; running without key authentication.",
    )
  }

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  await startModelsDevCache()

  const serverUrl = formatServerUrl(binding.clientHostname, options.port)

  // A gateway-managed proxy can be configured at any time through the admin UI.
  // Register the reload strategy BEFORE the first token resolution so a request
  // that arrives while idle can install the credential without a restart.
  configureTokenReloader(
    gateway ?
      async () => {
        const resolved = await resolveGitHubToken({
          credentials: gateway.ports.credentials,
        })
        if (!resolved) return false
        await setupCopilotMode(
          resolved.token,
          resolved.source,
          resolved.accountId,
        )
        return true
      }
    : null,
  )

  const resolvedGitHubToken =
    isGitHubCopilotEnabled() ?
      await resolveGitHubToken({
        cliToken: options.githubToken,
        credentials: gateway?.ports.credentials ?? null,
      })
    : null
  if (resolvedGitHubToken) {
    await setupCopilotMode(
      resolvedGitHubToken.token,
      resolvedGitHubToken.source,
      resolvedGitHubToken.accountId,
    )
  } else {
    await setupProviderMode({ gatewayManaged: gateway !== null })
  }

  // One emitter for the process; the recorder facade emits into it.
  const usageEmitter =
    gateway ? createUsageEmitter(gateway.ports.usage) : nullUsageEmitter()
  configureUsageEmitter(usageEmitter)

  const authenticator =
    gateway ? createManagedAuthenticator(gateway.ports.keys) : null

  consola.box(
    gateway ?
      `🔐 Client keys: agent-gateway   ·   usage: agent_gateway.usage_events`
    : `⚠️  No gateway configured — requests are unauthenticated (loopback only)\n${serverUrl}`,
  )

  const { createServer } = await import("./server")
  const server = createServer({
    networkExposed: binding.networkExposed,
    authenticator,
  })

  serve({
    fetch: server.fetch as ServerHandler,
    hostname: binding.hostname,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    host: {
      type: "string",
      default: process.env.HOST?.trim() || DEFAULT_SERVER_HOST,
      description: "Host to listen on",
    },
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
  },
  run({ args }) {
    return runServer({
      host: args.host,
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      githubToken: args["github-token"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
    })
  },
})
