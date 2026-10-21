/**
 * Cross-process Redis pub/sub channel names.
 *
 * Authoritative copy. Mirrored byte-identical at:
 *   claude-api/src/contracts/redis-channels.ts
 *   codex-api/src/contracts/redis-channels.ts
 *
 * Channel names live in the unprefixed `agent_gateway:` namespace so all
 * three processes can publish/subscribe to the same channel regardless of
 * their own ioredis `keyPrefix`. Subscribers MUST use a duplicated client
 * with `keyPrefix: ''` (override) — see each proxy's server.ts subscribe
 * site for the pattern.
 */

/**
 * Emitted by agent-gateway after a `provider_accounts` row is INSERTed
 * or its `network_region` column is UPDATEd. Causes proxies to refresh
 * their region cache immediately instead of waiting for the 60s poll
 * timer. Payload is informational (operator can grep for it in
 * events.jsonl); subscribers re-pull from SQL on receipt to ensure
 * consistency across multiple-edit races.
 */
export const REGION_CHANGED_CHANNEL = 'agent_gateway:provider_accounts:region_changed' as const

/**
 * Planned (not yet wired): push key revocation/disable to proxies for
 * sub-second invalidation. Proxies currently re-validate `client_keys`
 * on every request auth check; this channel would allow gateway to
 * short-circuit that.
 */
export const CLIENT_KEYS_INVALIDATE_CHANNEL = 'agent_gateway:client_keys:invalidate' as const

/**
 * Prompt-capture observation window flag key (v2, 2026-10-16 补缺).
 *
 * agent-gateway is the SOLE WRITER (src/stores/prompt-capture-window-store.ts
 * `start`/`stop`): SET on window start (value = ISO expiresAt, TTL-bounded),
 * DEL on window stop/expiry-cleanup. codex-api / kiro-api / byok-api are
 * read-only consumers — each already hardcodes this exact key shape
 * independently (no shared constant existed pre-v2); this just gives the
 * literal a single named, versioned home so future consumers import instead
 * of re-typing the template string. Byte-identical to what every consumer
 * already reads: `agent_gateway:prompt_capture:user:<user_id>`.
 */
export const PROMPT_CAPTURE_USER_KEY = (userId: string): string => `agent_gateway:prompt_capture:user:${userId}`
