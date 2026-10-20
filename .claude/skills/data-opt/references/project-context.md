# Project context — agent-gateway / codex-api / kiro-api / claude-api（claude-api 已于 2026-07-30 再次冻结）

Required reading at the start of every `data-opt` Plan phase. Without it, the skill re-discovers known issues and proposes already-rejected patterns.

Last updated: 2026-07-30 (claude-api **再次冻结 2026-07-30**——停止开发/部署/镜像，线上容器照跑；kiro-api 活跃；cloud-222 退役)。

---

## 1. Repo topology

| Repo | Path | Role | Owns (writes) | Reads |
|---|---|---|---|---|
| **agent-gateway** | `~/Desktop/workspace-desktop/agent-gateway` | Admin UI + portal + OAuth + schema owner + nginx routing decider | `users`, `client_keys`, `provider_accounts`, `audit_events`, `model_pricing`, `billing_plans`, `user_billing_state`, `app_settings`, `provider_brands`, `orders`, `prompt_reports`, `prompt_capture_windows` — full CRUD | `usage_events`, `usage_daily`, `client_sessions` (read-only reporting + charge-worker stamps charge_micros/charged_at) |
| **codex-api** | `~/Desktop/workspace-desktop/codex-api` | OpenAI Codex proxy | INSERT `usage_events`, `usage_daily`, `client_sessions`; UPDATE narrow set on `provider_accounts` (`last_429_at`, `ratelimit_headers`, `ratelimit_observed_at`, `last_proxy_use_at`, refresh tokens), scoped to `provider_type IN ('codex','openai')` | `client_keys`, `users`, `provider_accounts` — mirrored into local SQLite via 60s key-mirror + session-mirror |
| **kiro-api** | `~/Desktop/workspace-desktop/kiro-api` | Anthropic ↔ AWS Kiro/CodeWhisperer proxy | Same narrow set as codex-api, scoped to `provider_type='kiro'`. Tokens estimated locally (Kiro returns no usage). | Same. Gateway-mode reads agent_gateway MySQL; kiro accounts are import-only (paste Kiro IDE credential), token refresh + write-back owned by kiro-api at runtime |
| **claude-api** | `~/Desktop/workspace-desktop/claude-api` | Anthropic proxy — **❄️ 再次冻结 2026-07-30（容器照跑）** | INSERT `usage_*` + `prompt_captures`（运行时继续写入） | `client_keys`/`users`/`provider_accounts` 运行时镜像继续跑；代码不再随 schema 演进 |

Cross-repo contract: `agent-gateway/docs/data-contract.md`. Treat as canonical. Any deviation → fix the doc in the same PR.

The `cross-repo-sync` agent applies matching edits to **active** siblings (codex-api + kiro-api) automatically when triggers in `agent-gateway/CLAUDE.md` fire.

---

## 2. Stack inventory

### MySQL

- LAN: `192.168.1.186:3306` (docker `mysql-v8_ai-coding-platform-relay`, MySQL 8.0.44)
- Azure: `20.198.233.74:3306` (independent MySQL 8.0, **not replicated** to LAN)
- DB name: `agent_gateway` on both
- Driver: `mysql2/promise` on Bun
- Pool: `connectionLimit ≥ 10`; never `pool.getConnection()` in hot paths — use `pool.query()` / `pool.execute()`
- Migration: forward-only files at `src/db/migrations/0NN_<name>.sql`, recorded in `schema_migrations`. Runner: `src/cli/migrate.ts`. systemd `ExecStartPre=` invokes migrate before every restart on both hosts. Idempotent.

> cloud-222（114.66.38.222）已退役 2026-06-10；活跃部署端 = LAN(186) + Azure(20.198.233.74)。

### Redis

- LAN: `192.168.1.186:6379` (docker `redis-stack-v7.4_ai-coding-platform-relay`, Redis 7.4)
- Azure: own local Redis (verify per session)
- Driver: `ioredis`
- Namespace per repo: `codex-api:` / `kiro-api:` / `agent_gateway:` / `claude-api:`（claude-api 已于 2026-07-30 再次冻结）

### Proxy local stores (Tier 2)

- codex-api: managed SQLite at `~/.codex-api/managed/managed.sqlite` + per-account token files at `~/.codex-api/managed/tokens/codex/<id>/oauth.json`
- kiro-api: credential + refreshed token under `~/.kiro-api/`; discovery also reads Kiro IDE / kiro-cli caches (`~/.aws/sso/cache/`, `~/.local/share/kiro-cli/data.sqlite3`)
- Both fully regenerable from MySQL (gateway mode) / re-importable on 60s tick / service restart

### What we DO NOT have

| Pattern | Status |
|---|---|
| MySQL read replicas | none |
| MySQL sharding | none |
| Redis Cluster / Sentinel | single node, no failover |
| MQ (Kafka / RabbitMQ / NATS) | none |
| Canal / Debezium / Binlog consumer | none |
| Outbox / Saga / Event Sourcing | none |
| Service mesh | none — nginx is ingress |
| CQRS | none — same model serves reads + writes |
| Multi-tenant isolation | none — single operator |

This is **intentional**. Sized for one operator + ~10 employees. Proposals to add any of these are rejected unless promote thresholds in `checklists.md` § "Promotion gates" trip.

---

## 3. The 3-tier data model (canonical mental model)

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: MySQL  (source of truth)                               │
│  Tables owned by agent-gateway; active proxies write a narrow set│
└─────────────────────────────────────────────────────────────────┘
         │   60s poll-mirror (key-mirror + session-mirror)
         ↓     [proxies own this; agent-gateway is the read-side]
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2: Proxy local read-mirror (regenerable)                  │
│  - codex-api       ~/.codex-api/managed/managed.sqlite + tokens │
│  - kiro-api        ~/.kiro-api/ credential + refreshed token    │
└─────────────────────────────────────────────────────────────────┘
         │   in-process
         ↓
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3: Redis (ephemeral; loss = recoverable degradation)      │
│  - agent_gateway:oauth_flow:<state>            TTL ~5min        │
│  - agent_gateway:user_session:<token>          TTL 7d sliding   │
│  - codex-api:<lock> / kiro-api:<lock>          short locks       │
│  - agent_gateway:provider_accounts:region_changed   pub/sub     │
└─────────────────────────────────────────────────────────────────┘
```

**Tier 1 ↔ Tier 2 eventual consistency is ALREADY SOLVED** by the 60s mirrors (`src/store/key-mirror.ts` + `src/store/session-mirror.ts` in each proxy). Any "we need Canal / MQ" proposal must explain why 60s is too slow for that specific column.

---

## 4. Cross-system write contract — column ownership

| Column | Writer | Pattern | Notes |
|---|---|---|---|
| `provider_accounts.access_token` / `refresh_token` / `expires_at` | gateway (initial OAuth) + proxy (post-refresh) | single-statement UPDATE | Refresh races handled by Redis single-flight lock; both use `WHERE id = ?` (no RMW) |
| `provider_accounts.last_429_at` | proxy | monotonic-guarded UPDATE | `WHERE last_429_at IS NULL OR last_429_at < ?` |
| `provider_accounts.ratelimit_headers` / `ratelimit_observed_at` | proxy | per-flush UPDATE | verbatim mirror |
| `provider_accounts.last_proxy_use_at` | proxy | ≤1/min throttled | drives admin "心跳 X 前" |
| `provider_accounts.network_region` / `fingerprint_seed` / `base_url` | agent-gateway | admin edits + lazy backfill | proxies read; region pub/sub propagates |
| `client_keys.*` (id / user_id / label / pin / raw_key) | agent-gateway | INSERT / UPDATE / soft-delete | mirrored to proxy SQLite |
| `client_keys.last_used_at` | proxy | per-auth, ≤1/min throttled | mirror doesn't overwrite |
| `usage_events.*` (except charge) | proxy | INSERT IGNORE on `request_id` | idempotent |
| `usage_events.charge_micros` / `charged_at` | gateway charge-worker | async post-hoc | proxy MUST NOT write |
| `usage_daily.*` | proxy | ON DUPLICATE KEY UPDATE | cumulative |
| `client_sessions.*` | proxy | ON DUPLICATE KEY UPDATE | session rollup |
| `audit_events.*` | gateway | INSERT-only via `audit-event-store.ts` (fire-and-forget) | proxies do NOT write |
| `users.*` | gateway | full CRUD | proxies don't write |

Bootstrap UPDATES (system admin reconcile, orphan-key adoption) now write `audit_events` rows with `actor_type='system'` (since 2026-05-12). Don't add new silent boot mutations.

---

## 5. Eventual-consistency budgets

| Source → consumer | Mechanism | Worst-case lag | When unacceptable |
|---|---|---|---|
| `provider_accounts` → proxy token/session files | 60s session-mirror poll | ~60s | OAuth just completed → user request immediately → 503 ≤60s. Mitigation: restart triggers immediate refresh |
| `client_keys` → proxy SQLite | 60s key-mirror poll | ~60s | New key + immediate downstream call → 401 ≤60s. Mitigation: planned `agent_gateway:client_keys:invalidate` pub/sub (not yet wired) |
| `provider_accounts.network_region` → proxy region cache | Redis pub/sub + 60s poll | push: ms / poll: 60s | already low |
| `usage_events` → `charge_micros` stamp | gateway charge-worker scan 30s | ~30s | OK — sole writer |
| `client_keys.last_used_at` → admin display | per-auth, 1/min throttled | ~1min | OK — display only |

---

## 6. Filesystem state convention (don't migrate to MySQL/Redis)

| State | Location | Why filesystem |
|---|---|---|
| codex-api per-account `oauth.json` | `~/.codex-api/managed/tokens/codex/<id>/` | hot path read every request |
| kiro-api credential + refreshed token | `~/.kiro-api/` (discovery also reads `~/.aws/sso/cache/`, kiro-cli SQLite) | hot path read every request; Kiro IDE-compatible |
| audit logs jsonl | `~/.codex-api/logs/` 等 proxy-local | append-only history |
| systemd unit + EnvironmentFile | `/etc/systemd/system/*.service` + `/etc/agent-gateway.env` / `/etc/kiro-api.env` | standard ops surface |

These are part of Tier 2. Don't propose moving them into MySQL or Redis without an explicit pain point.

---

## 7. Existing pipes — re-use before reinventing

| Pipe | What it does |
|---|---|
| `agent-gateway/src/cli/migrate.ts` | Idempotent forward-only migrations; ExecStartPre on both hosts |
| `agent-gateway/src/cli/charge-drain.ts` | 30s loop UPDATE-ing `usage_events.charge_micros` for unscored rows |
| `agent-gateway/src/audit/anomaly-detector.ts` | 5min scan emitting `usage_anomaly_*` events |
| `agent-gateway/src/services/user-onboarder.ts` | Server-side `provisionStarterKeys` on user-create — writes raw_key in same INSERT (mig 032) |
| `agent-gateway/src/server/bootstrap.ts` | Idempotent system-admin reconcile + orphan-key adoption with audit emission |
| `<proxy>/src/store/key-mirror.ts` | 60s pull of `client_keys` → local SQLite |
| `<proxy>/src/store/session-mirror.ts` | 60s pull of `provider_accounts` tokens → per-account files |
| `agent_gateway:provider_accounts:region_changed` Redis channel | Push-invalidates region cache; 60s poll is fallback |

Check this list before proposing new infrastructure.

---

## 8. Recently fixed (2026-05-12 — DO NOT re-introduce)

| Anti-pattern | Where | How it failed | Counter-rule |
|---|---|---|---|
| Hardcoded `cap_` prefix in key preview | view layer | `ck_…` keys rendered as `cap_•••XYZ` | `src/views/layout.ts::previewClientKey` derives prefix from rawKey |
| `CLAUDE_API_DEPLOYMENT=loopback` aliased to `local` | profile.ts | wrong flags for loopback hosts | `loopback` is now a first-class Profile |
| Combined "刷新+复制" button | admin keys | UX coupling | Copy is copy; refresh is refresh — separate affordances |
| Bulk-rotate raw_key=NULL keys | LAN admin | would invalidate 22 active downstream keys | per-row 刷新 + operator confirm |
| bfcache desync between admin pages | admin auth middleware | back-nav showed stale data | `Cache-Control: no-store, must-revalidate` on every admin response |
| `navigator.clipboard.writeText` on HTTP origin | admin views | silently failed | `src/views/layout.ts::clipboardCopyScript` with textarea-execCommand fallback |
| Same-semantics field divergence | `email` vs `email_address`, `display_name` vs `label` | divergent fallback chains across pages | `src/views/_display.ts::accountDisplayName` single source |
| `usage_events.account_id` / `client_sessions.bound_account_id` FK missing | schema | orphan history possible | mig `033_provider_account_fks.sql` |
| Portal disable/enable without audit | `routes/portal.ts` | untraceable | `portal_key_disable` / `portal_key_enable` events |
| Bootstrap silent reconciliation | `server/bootstrap.ts` | meta drift invisible | `system_admin_reconcile` + `orphan_keys_adopted` events when affectedRows > 0 |

When auditing, **check these stay fixed**. Don't propose changes that re-introduce them.

---

## 9. Open backlog (`agent-gateway/docs/audit-backlog-2026-05-12.md`)

Don't re-discover. Pick from here:

- **M1.** `prompt_captures.request_id → usage_events.request_id` FK (CASCADE)
- **M2.** `client_keys.created_account_id → provider_accounts.id` FK (SET NULL)
- **M3.** provider-account label validation gap on OAuth create path
- **M4.** `provider_accounts.access_token` / `refresh_token` max-length sanity
- **M5.** Add "Read pattern" column to `data-contract.md` per-table tables
- **L1.** `users.email` vs `provider_accounts.email_address` rename (cross-repo, defer)
- **L2.** `label` vs `display_name` triple-table unification (cross-repo, defer)
- **L3.** `audit_events.actor_id` VARCHAR(128) → VARCHAR(64)
- **L4.** `user_billing_state.created_at` add
- **L5.** `usage_events` partition plan (only when > 100M rows)
- **L6.** `provider_accounts.vendor` enum constraint (only if 2nd vendor adds)
- **L7.** Audit-store health probe / metric
- **L8.** Quarterly cross-walk of data-contract.md vs code

---

## 10. Deployment topology + `/r4` chain

| | LAN | Azure |
|---|---|---|
| Admin UI | `http://192.168.1.186:39520/admin` | `http://20.6.92.121:39520/admin` (LB VIP) |
| Portal | `/portal/login` on same host | same |
| nginx ingress | `:39517` LAN-exposed | `:39517` |
| agent-gateway | `:39520` | `:39520` |
| codex-api | loopback `:39516` | loopback `:39516` |
| kiro-api | loopback `:39521` | loopback `:39521` |
| claude-api | loopback `:39518`（❄️ 2026-07-30 再次冻结；容器照常运行、不再发布） | loopback `:39518`（同左） |
| OAuth callbacks | `:39519` (anthropic) + `:1455` (codex) — loopback; operator SSH `-L`. kiro = import-only, 无浏览器 OAuth | same |
| systemd services | `agent-gateway` + `codex-api` + `kiro-api` `.service` | same |
| ExecStartPre auto-migrate | YES (agent-gateway) | YES |

**Every data-layer change ships via `/r4` (或各仓 `bun release` 链)**:

1. **Local** — commit + `bun run typecheck` + `bun test` all green
2. **GitHub** — `git push origin main`
3. **LAN** — `bash scripts/deploy-lan.sh`（rsync + bun install + restart + `/health` gate；agent-gateway 的 ExecStartPre 跑 migrate）
4. **Azure** — `bash scripts/deploy-azure.sh`（同形 + nopasswd sudo）

> 无 root-level `./deploy.sh`；canonical = `scripts/deploy-{lan,azure}.sh`（带 assert-release-identity 条例门）。cloud-222 已退役 2026-06-10。

Skipping = the change is not in production.

---

## 11. Subagent dispatch triggers (from `CLAUDE.md`)

`cross-repo-sync` subagent applies matching edits to sibling repos in parallel when any of these fire:

| Trigger | Mirror |
|---|---|
| `src/db/migrations/*.sql` adds/drops/renames a column | active proxies' (codex-api + kiro-api) SELECT / INSERT / UPDATE call sites |
| `docs/data-contract.md` row touched | active proxies' read+write for that column |
| `src/oauth/adapters/*.ts` constants (CLIENT_ID, scopes, URLs); `adapters/kiro.ts` refresh URLs / model map | matching proxy's OAuth/auth client byte-for-byte (`kiro.ts` ↔ `kiro-api/src/auth/kiro-constants.ts`) |
| `scripts/setup-{codex,kiro}-api-mysql-user.sh` GRANT change | matching proxy's required SQL set |
| `usage_events` / `usage_daily` / `client_sessions` schema | active proxies' emitter flush SQL |

Always dispatch in parallel (single `Agent` block, multiple tool uses). Wait + restate merged diff before continuing.

---

## 12. Promotion gates (rejected-by-default patterns)

| Pattern | Trip wire to flip "needed" |
|---|---|
| Sharding | `usage_events > 100M rows` OR sustained write > 5k QPS |
| Read replica | Read QPS > 10× write sustained OR analytics on prod |
| Redis Cluster | dataset > 64GB OR keys > 200M |
| Canal / Binlog | downstream ≥ 2 services AND lag tolerance < 5s for shared columns |
| MQ | eventual sync window > 60s tolerable BUT consumer ≥ 2 unrelated services |
| Outbox | external side-effect (payment / email) must be atomic with state |
| Saga | tx spans ≥ 2 services with independent rollback |
| CQRS | read model materially different OR scale-different |
| Event Sourcing | full append-only audit + rebuildable projections |
| Hot-key isolation | top-1 Redis key > 10% of total traffic |
| New distributed lock | measured contention; default is single-statement UPDATE |

Default for everything else: "current pattern is fine; don't add complexity."
