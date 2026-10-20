# Checklists — scoped to this stack

Three columns per item: **Applies now** (run on every audit) / **Promote when** (only if condition trips) / **Not warranted** (don't propose).

Cycle's Plan picks the subset relevant to the target. Tag each finding with severity (critical / high / medium / low) + blast radius + file:line evidence.

---

## §1. MySQL schema audit

### Applies now

- Single responsibility per table; no "god table" (> 30 columns mixing unrelated domains)
- Column names reflect semantic, not source (`email` not `account_email_v2`)
- No two columns store the same logical value within a row
- Boolean columns named affirmatively (`is_enabled` not `not_disabled`)
- VARCHAR sized to actual max × 1.2 — not "always 255"
- Money / quotas / charges as BIGINT micros, not FLOAT
- No JSON column that should be a normal table
- No TEXT where VARCHAR fits
- DATETIME convention documented (we use UTC for `*_at` columns)
- Every nullable column has documented NULL semantics
- Every cross-table reference has an explicit FK with documented `ON DELETE` policy
- No orphan history rows after a delete
- Each index has a documented query that uses it
- No duplicate index (same leading columns)
- Composite index leading column = highest selectivity
- Covering indexes for hot queries (avoid back-table)
- No index on low-cardinality column alone
- Soft-delete columns consistent (`disabled_at` reversible, `revoked_at` terminal)
- `WHERE deleted_at IS NULL` filter baked into stores (no leak)
- Migration file is forward-only with rollback comment
- No `SELECT *` in hot path
- No `OFFSET N` pagination on tables > 100k rows — use keyset
- Every "reports on a table" query has a `created_at` index path
- No JOIN > 4 tables in hot path
- EXPLAIN sampled for top SQL by latency in last week

### Promote when

- **Partitioning** — only when `usage_events > 100M rows` projected within 12 months. Plan: `PARTITION BY RANGE (YEAR_MONTH(occurred_at))`
- **Online schema change tooling (gh-ost / pt-osc)** — only when table > 10M rows + migration ALTER would lock > 1s. Today migrate.ts runs inline ALTER on cold-ish hot tables; fine
- **Encrypted-at-rest column** — only when a regulated audit requires it

### Not warranted

- ❌ Sharding (`< 100M rows`, single operator)
- ❌ Read replica (`< 10× read:write ratio`)
- ❌ Cross-DB FK (we only have one DB per host)
- ❌ Stored procedures (ORM-less Bun stack reads from migration files directly)

---

## §2. Redis governance audit

### Applies now

- Redis is cache + ephemeral state only — MySQL is the truth
- Every read path has a MySQL fallback (Redis down ≠ outage)
- No write that requires both MySQL + Redis to succeed for correctness
- Every key has a TTL OR documented permanent intent
- Namespace prefix per repo (`agent_gateway:` / `codex-api:` / `kiro-api:` / `claude-api:`; claude-api 已于 2026-07-30 再次冻结)
- Session TTL ≥ business session lifetime (sliding TTL OK)
- ZSET / HASH / LIST < 5k members (else BigKey concern; rare here)
- Pub/sub channel names namespaced + subscribers handle replay
- No business logic depends on pub/sub delivery alone — must have a poll fallback (60s mirror covers it for our use cases)
- Cache-aside pattern for new reads; document if not

### Promote when

- **Stampede protection (single-flight / mutex)** — only when measurable thundering herd on a hot key. We already have it on OAuth refresh
- **Probabilistic early expiry** — only when one key drives a meaningful fraction of total reads
- **BigKey split** — only when STRING > 256KB or container > 5k members
- **Hot-key shard** — only when top-1 key > 10% of total Redis traffic

### Not warranted

- ❌ Redis Cluster (dataset < 64GB)
- ❌ Sentinel quorum (single Redis is acceptable; loss = portal re-login + abort in-flight OAuth)
- ❌ Cross-region Redis replication

---

## §3. Consistency audit

### Applies now

- Each row has ONE owner who writes it (per `data-contract.md`)
- Cross-system writes documented in `data-contract.md`
- No RMW without explicit lock OR single-statement UPDATE
- Transaction boundary minimised (no external I/O inside tx)
- Idempotency key on any write that can be retried externally (request_id, OAuth `state`, etc)
- Monotonic guards on "latest known" columns (`last_429_at`, `last_used_at`)
- Cache invalidation order: **DB write → Redis del** (never Redis-del-first)
- Delayed double-delete on write paths with concurrent reads from cache
- Read-your-writes: not a guarantee on Tier 2 mirror (60s lag) — document where it matters
- Cross-process invalidation: 60s mirror is the default; Redis pub/sub for low-latency hot signals
- Replay safety: every consumer idempotent on duplicate

### Promote when

- **2PC / XA** — never (rejected)
- **Saga** — only when tx spans 2+ services with independent rollback semantics
- **Outbox** — only when external side-effect (payment / email) must be atomic with state
- **CRDT** — never (we have a single source of truth)

### Not warranted

- ❌ Distributed transaction coordinator
- ❌ Cross-DB tx (single DB)

---

## §4. Field reference audit

### Applies now (trace each field end-to-end)

```
DB column → ORM model → Store method → Service / Route → API response → DTO → Client / View → Page label
         ↑                                                                                          ↓
         └────────── operator inline edit writes back through routes ←────────────────────────────┘
```

- Same logical field has same name end-to-end (or explicit mapping)
- Page label matches actual displayed field (no "用户名" label rendering `email`)
- No legacy alias still referenced
- No field updated by 2+ routes without coordination
- Fallback chains consistent across pages showing the same field — use `src/views/_display.ts` helpers
- Empty-state copy consistent (use `EMPTY_LABEL`)
- Length validations match VARCHAR sizes at every input boundary

### Stack-specific recurring bugs

- `email` (users) vs `email_address` (provider_accounts) — same semantic, two names. Don't rename in isolation (cross-repo)
- `display_name` (users) vs `label` (client_keys + provider_accounts) — three "operator-facing name" columns. Handled by `_display.ts`; don't add a fourth
- `id` (slug) vs `account_uuid` (provider-issued UUID) on `provider_accounts` — FK targets are always the slug `id`, never the UUID
- Status string consistency: `revoked_at NOT NULL` is terminal, `disabled_at NOT NULL` is reversible

---

## §5. Sync pipeline audit

For each pipe in `project-context.md §7`:

### Applies now

- Source → sink documented
- Latency budget defined (we use 60s as default)
- Dedup / idempotency guaranteed (mirror uses ON CONFLICT / INSERT IGNORE / atomic file write)
- Order guarantee documented (per-key for mirrors; not required globally)
- Failure replay: each tick re-tries from MySQL truth; partial-write resilience via tx
- Backfill: a fresh proxy host gets full state after one tick + restart
- Restart triggers immediate mirror sync (don't wait 60s)

### Stack-specific

- `key-mirror.ts`: filters by `provider_type` family (codex-api → codex+openai+NULL; kiro-api → kiro; claude-api → anthropic+NULL；claude-api 2026-07-30 再冻结，运行时镜像照跑、代码不再演进。注意 2026-07-28 起 codex/claude 的 key-mirror 家族过滤已移除——全量镜像)
- `session-mirror.ts`: writes per-account token files atomically via tmp+rename (codex-api `~/.codex-api/...`; kiro-api `~/.kiro-api/...`); skips overwrite when local `expiresAt > mysql.expires_at` (post-refresh write-back race protection)
- `charge-worker`: scans `WHERE charged_at IS NULL ORDER BY id LIMIT N` every 30s; stamps `charge_micros + charged_at` in single UPDATE
- `region-changed` pub/sub: lower-latency invalidate; 60s poll is fallback safety net

### Promote when

- **MQ-based sync** — consumer ≥ 2 unrelated services AND lag < 60s required
- **Binlog / Canal** — downstream ≥ 2 + business logic must run on every row change

### Not warranted

- ❌ CDC pipeline (we have ≤ 2 consumers + 60s budget is fine)

---

## §6. Concurrency audit

### Applies now

- All I/O async (no sync fs IO in request path per CLAUDE.md)
- No RMW pattern without explicit lock or single-statement UPDATE
- Idempotency key on every external-facing retry
- Distributed lock used ONLY where measured contention warrants (OAuth refresh)
- Deadlock retry policy: short-tx + low chance; document if it shifts
- No `for await` over a large MySQL result without LIMIT batching

### Stack-specific

- OAuth refresh: Redis single-flight via `WITH SET key value NX EX ttl`
- region-cache update: Redis pub/sub + 60s poll
- charge-worker: small batches with LIMIT 200 + sleep between

### Not warranted at current scale

- ❌ Per-row mutex on hot tables
- ❌ Optimistic concurrency (version columns) — single owner per column suffices

---

## §7. Cross-repo contract audit

### Applies now

- `data-contract.md` row matches actual code for every column
- Every column in the contract has a documented Writer + Reader
- Any new column in agent-gateway → updated in contract + grep both proxies for usage in same PR
- Rename = expand-then-contract; never rename across one PR
- `cross-repo-sync` subagent dispatched when triggers fire (see project-context.md §11)
- Both proxies' grant SQL updated in lockstep when narrow-SELECT/UPDATE rights change
- OAuth client constants (CLIENT_ID, scopes, redirect_uri, AUTHORIZE_URL, TOKEN_URL) byte-for-byte identical between gateway adapter and proxy refresh code

### Stack-specific

- `agent-gateway/src/oauth/adapters/codex.ts` + `codex-api/src/oauth/codex-client.ts` must agree
- `agent-gateway/src/oauth/adapters/kiro.ts` (social refresh URL / IdC / model map) + `kiro-api/src/auth/kiro-constants.ts` must agree byte-for-byte
- `agent-gateway/src/oauth/adapters/anthropic.ts` + `claude-api/src/oauth/constants.ts` — claude-api 已于 2026-07-30 再次冻结：此对 byte-equal 校验**暂停演进义务**（两边都不动即天然一致；gateway 侧若必须改 Anthropic 常量，登记为解冻欠账）
- Mirror filter SQL (proxy `key-mirror.ts` + `session-mirror.ts`) updated when `provider_type` enum widens
- `usage_events` / `usage_daily` / `client_sessions` schema changes go in active proxies' `usage-emitter.ts` (codex-api + kiro-api)

---

## §8. UI ↔ data audit

### Applies now (every page)

- Every read field on the page has a known producer
- Every write field has a known sink
- Inline edits PATCH the canonical column, not a denormalized cache
- Display fallback chains identical across pages — use `_display.ts`
- Empty-state copy consistent (`EMPTY_LABEL`)
- Loading / error / empty / success states all distinct
- `Cache-Control: no-store, must-revalidate` on every authenticated admin response (bfcache safety)

### Recent regressions to keep fixed

- Copy button HTTP-origin clipboard API — use `clipboardCopyScript()` (textarea fallback)
- Key preview prefix — derive from `rawKey`, never hardcode `cap_`
- Refresh / copy / pin — separate affordances, never combined

---

## §9. Audit-event coverage

### Applies now

- Every state-changing route emits `audit_events`
- Admin write: `actorType='admin'`, `actorId=adminActorIdFromContext(c)`, IP + UA captured
- Portal write: `actorType='user'`, `actorId=user.id`, IP + UA captured
- System write (cron / bootstrap / anomaly): `actorType='system'`, no actorId required
- Audit row includes target + sufficient details (no secrets)
- Audit insert failure does NOT roll back the business op (intentional; surface via console.warn for now)
- Audit table retention: unbounded for now (single-tenant, low write rate)

### Routes that must have audit (current contract)

- All `routes/admin-*.ts` POST/PATCH/DELETE endpoints
- All `routes/portal.ts` POST/PATCH endpoints (disable/enable added 2026-05-12)
- `oauth/flow.ts:complete()` — emits `oauth_flow_complete`
- `bootstrap.ts` reconciliation paths (added 2026-05-12)
- `audit/anomaly-detector.ts` — synthetic `usage_anomaly_*` events

### Promote when

- Audit health probe + metric — only when alarming-on-failure becomes business-critical (today we accept best-effort)

---

## §10. Migration governance

### Applies now (every migration)

- Filename `0NN_<name>.sql`, NN = next sequential after current latest
- Forward-only; rollback path documented as comment block in same file when feasible
- Recorded in `schema_migrations`; idempotent (skips if already applied)
- ALTER expected lock duration < 1s on the largest current row count of the target table; chunk if not
- Pre-flight queries committed if the migration depends on data shape (orphans, length distributions)
- Cross-repo proxy code updated in lockstep if columns are mirrored
- `data-contract.md` updated in same PR if schema visible to proxies
- Test on LAN before cloud (via `/r4`)

### Expand-then-contract trail for column rename

1. Migration N: `ADD COLUMN new_col`
2. App stage: dual-write (writers write both)
3. App stage: reader prefers `new_col`, falls back to `old_col`
4. Migration N+1: backfill cursor + verify
5. App stage: drop fallback (readers only `new_col`)
6. App stage: drop dual-write (writers only `new_col`)
7. Migration N+2: `DROP COLUMN old_col`

Stages 2-6 cross deploy boundaries. NEVER skip the gap.

---

## §11. Auto-fix bundle audit

For every fix proposal, verify it includes:

- [ ] Forward SQL (or N/A note)
- [ ] Rollback SQL (or N/A explanation)
- [ ] TS code diffs (proper Edit calls, not pseudo-code)
- [ ] Cross-repo dispatch if shared columns touched
- [ ] `bun run typecheck` pass evidence
- [ ] `bun test` pass evidence
- [ ] Affected file:line list
- [ ] `audit_events` coverage for any new write path
- [ ] Backfill / data repair script if existing rows need normalisation
- [ ] Monitoring named (what `/health` field or log line proves success)

Missing any of these = not industrial-grade.

---

## §12. Gray rollout audit

For every change, verify:

- [ ] Local commit + typecheck + test green
- [ ] `git push origin main`
- [ ] LAN deploy via `./deploy.sh` (or rsync + bun install + restart + health gate)
- [ ] LAN `/health` 200 for 30s
- [ ] LAN smoke test (one real-endpoint call returning 200 or 401)
- [ ] Cloud deploy
- [ ] Cloud `/health` 200 for 30s
- [ ] Cloud smoke test
- [ ] 30 min observation of `journalctl -u <svc>` — no new error pattern
- [ ] Rollback trigger documented + tested mentally

Skipping LAN-before-cloud = rejected.

---

## §13. Severity rubric (consistent across findings)

| Severity | Meaning |
|---|---|
| **critical** | Active data corruption OR auth bypass OR durable financial drift; ship same hour |
| **high** | Behaviour drift on user-visible path OR cross-system contract drift OR missing audit on financial path; ship same day |
| **medium** | Hygiene gap (missing FK, missing validation, missing index on warm path); ship same week |
| **low** | Naming inconsistency, doc drift, performance < 2× headroom; backlog |

Don't promote severity to make a finding feel urgent. Don't demote to avoid the work.
