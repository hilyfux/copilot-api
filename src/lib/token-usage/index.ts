/**
 * index.ts — usage accounting facade.
 *
 * WHAT CHANGED AND WHY: this used to persist usage into a local SQLite database
 * owned by this proxy, with its own pricing table, its own read API and its own
 * usage-viewer page. That made this service a second, competing owner of billing
 * data — the exact thing agent-gateway exists to own. Usage now goes to
 * `usage_events` / `usage_daily` / `client_sessions` in the gateway database via
 * `src/gateway/`, so a key, its user and its usage live in one place.
 *
 * The recorder API is intentionally unchanged: every protocol face already calls
 * `recordUsage(usage)`, and that seam is the right one. Only the sink moved.
 */
import { requestContext, generateTraceId } from "~/lib/request-context"

import type { UsageEventRow } from "~/gateway"
import type { UsageEmitter } from "~/users/usage-emitter"

import { resolveTokenUsageCost, type TokenUsagePricingConfig } from "./pricing"
import {
  hasAnyToken,
  normalizeOptionalToken,
  normalizeToken,
  type TokenUsageEndpoint,
  type TokenUsageSource,
  type UsageTokens,
} from "./tokens"

export { normalizeOptionalToken, normalizeToken } from "./tokens"
export type {
  TokenUsageEndpoint,
  TokenUsageSource,
  UsageTokens,
} from "./tokens"

export interface TokenUsageEventInput extends UsageTokens {
  serviceTier?: string | null
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

interface TokenUsageRecorderOptions {
  serviceTier?: string | null
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

type CopilotTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "providerName" | "source"
>

type ProviderTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "source"
>

/**
 * The sink is injected at the composition root, so this module holds no opinion
 * about how usage reaches the gateway. Unset (tests, standalone runs) means
 * usage is not recorded — never a crash on the request path.
 */
let emitter: UsageEmitter | null = null

export function configureUsageEmitter(next: UsageEmitter | null): void {
  emitter = next
}

function resolveTraceId(traceId: string | null | undefined): string {
  return (
    traceId?.trim() || requestContext.getStore()?.traceId || generateTraceId()
  )
}

export function resolveTokenUsageSessionId(
  sessionId: string | null | undefined,
  fallbackSessionId?: string | null,
): string {
  return (
    requestContext.getStore()?.sessionAffinity?.trim()
    || sessionId?.trim()
    || fallbackSessionId?.trim()
    || ""
  )
}

/** `messages` / `provider_messages` are spoken Anthropic; the rest are OpenAI-shaped. */
function downstreamProtocolFor(
  endpoint: TokenUsageEndpoint,
): "anthropic" | "openai" {
  return endpoint === "messages" || endpoint === "provider_messages" ?
      "anthropic"
    : "openai"
}

function toUsageEventRow(input: TokenUsageEventInput): UsageEventRow | null {
  if (!hasAnyToken(input)) {
    return null
  }

  const context = requestContext.getStore()
  // No authenticated key means there is nothing to attribute usage to.
  // usage_events.key_hash is NOT NULL, so such a request is skipped rather than
  // written under a synthetic key.
  if (!context?.gatewayKeyHash) {
    return null
  }

  const model = input.model.trim() || "unknown"

  return {
    requestId: resolveTraceId(input.traceId ?? context.traceId),
    occurredAt: new Date(),
    keyHash: context.gatewayKeyHash,
    userId: context.gatewayUserId ?? null,
    providerType:
      input.source === "copilot" ?
        "copilot"
      : input.providerName?.trim() || "copilot",
    accountId: context.gatewayAccountId ?? null,
    sessionId:
      resolveTokenUsageSessionId(input.sessionId, input.fallbackSessionId)
      || null,
    model,
    // The fork translates between protocols, so the model the client asked for is
    // the model that served unless a mapping rewrote it; `model` is already the
    // resolved upstream id at every call site.
    servedModel: model,
    downstreamProtocol: downstreamProtocolFor(input.endpoint),
    inputTokens: normalizeToken(input.input_tokens),
    cacheReadTokens: normalizeToken(input.cache_read_input_tokens),
    cacheCreationTokens: normalizeToken(input.cache_creation_input_tokens),
    outputTokens: normalizeToken(input.output_tokens),
    reasoningTokens: 0,
    durationMs: Date.now() - context.startTime,
    statusCode: null,
    networkRegion: null,
  }
}

export function recordTokenUsageEvent(input: TokenUsageEventInput): void {
  const row = toUsageEventRow(input)
  if (!row) {
    return
  }

  // Cost is still resolved so the operator sees a per-request figure in the log;
  // agent-gateway's charge-worker remains the authority on money and re-prices
  // from usage_events.
  const cost = resolveTokenUsageCost({ ...input, at: new Date() })
  if (cost) {
    console.debug(
      `[usage] ${row.model} ${row.inputTokens}/${row.outputTokens} tokens ~ ${(
        cost.total_cost_nanos / 1e9
      ).toFixed(6)} ${cost.currency}`,
    )
  }

  emitter?.emit(row)
}

export function createTokenUsageRecorder(
  options: TokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return (usage) => {
    recordTokenUsageEvent({ ...usage, ...options })
  }
}

export function createCopilotTokenUsageRecorder(
  options: CopilotTokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return createTokenUsageRecorder({ ...options, source: "copilot" })
}

export function createProviderTokenUsageRecorder(
  options: ProviderTokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return createTokenUsageRecorder({ ...options, source: "provider" })
}

export function normalizeOpenAIUsage(
  usage:
    | {
        completion_tokens?: number
        prompt_tokens?: number
        total_tokens?: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
        prompt_tokens_details?: {
          cache_creation_input_tokens?: number
          cached_tokens?: number
        }
      }
    | null
    | undefined,
): UsageTokens {
  if (
    usage
    && (Object.hasOwn(usage, "prompt_cache_hit_tokens")
      || Object.hasOwn(usage, "prompt_cache_miss_tokens"))
  ) {
    return {
      cache_read_input_tokens: normalizeToken(usage.prompt_cache_hit_tokens),
      input_tokens: normalizeToken(usage.prompt_cache_miss_tokens),
      output_tokens: normalizeToken(usage.completion_tokens),
      total_tokens: normalizeOptionalToken(usage.total_tokens),
    }
  }

  const promptDetails = usage?.prompt_tokens_details
  const hasCacheCreationTokens = Boolean(
    promptDetails
      && Object.hasOwn(promptDetails, "cache_creation_input_tokens"),
  )
  const hasCachedTokens = Boolean(
    promptDetails && Object.hasOwn(promptDetails, "cached_tokens"),
  )
  const cachedTokens = normalizeToken(promptDetails?.cached_tokens)
  const cacheCreationTokens = normalizeToken(
    promptDetails?.cache_creation_input_tokens,
  )
  const promptTokens = normalizeToken(usage?.prompt_tokens)
  return {
    ...(hasCacheCreationTokens && {
      cache_creation_input_tokens: cacheCreationTokens,
    }),
    ...(hasCachedTokens && {
      cache_read_input_tokens: cachedTokens,
    }),
    input_tokens: Math.max(
      0,
      promptTokens - cachedTokens - cacheCreationTokens,
    ),
    output_tokens: normalizeToken(usage?.completion_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeResponsesUsage(
  usage:
    | {
        cost?: number
        input_tokens?: number
        input_tokens_details?: {
          cached_tokens?: number
          cache_write_tokens?: number
        }
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  const cachedTokens = normalizeToken(
    usage?.input_tokens_details?.cached_tokens,
  )
  const cacheWriteTokens = normalizeToken(
    usage?.input_tokens_details?.cache_write_tokens,
  )
  const inputTokens = normalizeToken(usage?.input_tokens)
  return {
    ...(cacheWriteTokens > 0 && {
      cache_creation_input_tokens: cacheWriteTokens,
    }),
    cache_read_input_tokens: cachedTokens,
    cost: normalizeOptionalCost(usage?.cost),
    input_tokens: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    output_tokens: normalizeToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeAnthropicUsage(
  usage:
    | {
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
        cost?: number
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  return {
    cache_creation_input_tokens: normalizeOptionalToken(
      usage?.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeOptionalToken(
      usage?.cache_read_input_tokens,
    ),
    cost: normalizeOptionalCost(usage?.cost),
    input_tokens: normalizeOptionalToken(usage?.input_tokens),
    output_tokens: normalizeOptionalToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function mergeAnthropicUsage(
  current: UsageTokens,
  next: UsageTokens,
): UsageTokens {
  return {
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens ?? current.cache_read_input_tokens,
    cost: next.cost ?? current.cost,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    total_nano_aiu: next.total_nano_aiu ?? current.total_nano_aiu,
    total_tokens: next.total_tokens ?? current.total_tokens,
  }
}

function normalizeOptionalCost(
  value: number | null | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : undefined
}
