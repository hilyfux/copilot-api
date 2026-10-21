/**
 * Cross-process UsageEvent contract.
 *
 * Authoritative copy lives here in agent-gateway. The ACTIVE proxies —
 * codex-api and kiro-api — each carry a byte-identical mirror at
 * `<repo>/src/contracts/usage-event.ts`. ANY change to this file MUST
 * be mirrored to both active proxy repos in the same commit window per
 * CLAUDE.md "Auto cross-repo sync". (claude-api is FROZEN again since
 * 2026-07-30 and receives nothing; byok-api carries no mirror — its
 * emitter binds the row columns directly, see docs/data-contract.md.)
 *
 * Drift guard (2026-10-16): the body below the header is sha256-pinned in
 * `tests/usage-event-contract.test.ts`; the proxies pin the same value.
 * Changing the body = update all pins in the same window. This closed the
 * 2026-10-16 audit finding where both proxies had grown optional fields
 * (`downstreamProtocol`, `servedModel`) the authoritative copy lacked.
 *
 * The proxies' usage-emitter consumes this type as its canonical event
 * shape; agent-gateway's usage-store reads the corresponding row layout
 * from `usage_events`.
 *
 * The type intentionally maps 1:1 to the columns in
 * `agent-gateway/src/db/migrations/006_usage.sql` (+ later additions
 * via 015 region, 019 charge, 052 downstream_protocol, 120 served_model).
 * Columns NOT in this type:
 *   - `id`, `charge_micros`, `charged_at`, `settlement_lane` (mig 099) —
 *     gateway-side; never produced by a proxy emitter. `settlement_lane`
 *     is written by charge-worker AFTER settlement, so a proxy cannot know
 *     it at emit time: at that moment nothing has been charged yet.
 *
 * Field naming is camelCase (TS convention); the emitter does the
 * snake_case translation when binding to INSERT placeholders. See
 * `agent-gateway/docs/data-contract.md` § usage_events for the row form.
 */
export type UsageEvent = {
  /** Idempotency key. UNIQUE in MySQL — INSERT IGNORE absorbs replays. */
  requestId: string
  /** Request completion time (ms precision; stored in TIMESTAMP(3)). */
  occurredAt: Date
  /** sha256(rawKey) hex; matches `client_keys.key_hash`. */
  keyHash: string
  /** Denormalised from `client_keys.user_id`. May be null on legacy keys. */
  userId: string | null
  /**
   * Vocabulary differs by proxy: claude-api emits `'anthropic'`,
   * codex-api emits `'openai'` (NOT `'codex'` — that's the OAuth-side
   * value in `provider_accounts.provider_type`). See
   * `agent-gateway/src/providers/catalog.ts` for the dual mapping
   * and `displayLabelFor()` for canonical UI labelling.
   */
  providerType: string
  /** FK → `provider_accounts.id`; null when no account was bound. */
  accountId: string | null
  /**
   * Downstream conversation/session ID. Either UUIDv4 (forwarded from
   * `X-Claude-Code-Session-Id`) or sha256-of-body fingerprint when no
   * client-supplied header is present. Anything else is a proxy-side bug
   * — the emitter must drop / null-out internal selector slugs at the
   * queue boundary.
   */
  sessionId: string | null
  /** Downstream wire protocol the client spoke (mig 052). Selects the gateway
   *  charge-worker's billing price family: 'anthropic' → Claude rates,
   *  'openai' → GPT rates. Omit / null on single-protocol proxies. Only
   *  codex-api sets it (multiplexed: /v1/messages='anthropic',
   *  /v1/responses + /v1/chat/completions='openai'). */
  downstreamProtocol?: 'anthropic' | 'openai' | null
  /** Model id as seen by the upstream. */
  model: string | null
  /** Per-class token counts. All non-negative. */
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  /** End-to-end latency in ms; null for streaming/cancelled. */
  durationMs: number | null
  /** Upstream HTTP status code; null when the proxy synthesised the response. */
  statusCode: number | null
  /** Model that ACTUALLY served the request after alias / degrade / tail-borrow
   *  (= requests.jsonl `upstreamModel`; equals `model` when nothing rerouted).
   *  agent-gateway mig 120 `usage_events.served_model` (nullable). The charge-
   *  worker prices `(billingProvider, model)` first and falls back to
   *  `(billingProvider, servedModel)` — closes the 2026-09-15 hole where any
   *  client-invented name (claude-4-8-opus, gpt-4o …) was served but billed $0.
   *  Optional: the emitter omits the column on hosts not yet migrated.
   *  kiro-api writes the Kiro upstream id (requests.jsonl `kiroModel`). */
  servedModel?: string | null
  /**
   * Account's `network_region` slug at emit time. Persisted on
   * `usage_events.network_region` for post-hoc audits. null when:
   *   - the proxy didn't know the region (legacy / direct-egress path), OR
   *   - the account has no region binding and ALLOW_DIRECT_EGRESS is set.
   * Added in migration 015.
   */
  networkRegion?: string | null
  /**
   * Optional verbatim snapshot of upstream rate-limit headers
   * (e.g. `anthropic-ratelimit-*` / OpenAI equivalents). When present,
   * the emitter UPDATEs `provider_accounts.ratelimit_headers` for
   * `accountId` on flush. Empty object means "no headers seen" — UPDATE
   * is skipped. claude-api populates inline; codex-api uses an emitter
   * `getRateLimitSnapshot(accountId)` callback at flush time and may
   * leave this field undefined.
   */
  ratelimitHeaders?: Record<string, string>
}
