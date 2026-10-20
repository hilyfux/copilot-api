---
name: data-opt
version: "2.0.0"
description: Use when the user asks for data-layer optimisation / governance on the agent-gateway + codex-api + kiro-api + claude-api stack (claude-api re-frozen 2026-07-30, container still serving) — schema/field audit, cache coherency, sync-pipeline review, migration + gray rollout + rollback planning. Triggers on English (governance, schema audit, field reference audit, cache coherency, dual-write, consistency, binlog, canal, CDC, saga, outbox, delayed double delete, hot key, BigKey, sharding, CQRS, migration, gray rollout, rollback, eventual consistency, 60s mirror, idempotency, cross-repo, foreign key) and Chinese (数据治理、数据优化、数据一致性、字段一致性、引用审计、缓存一致性、缓存穿透/击穿/雪崩、双写、延迟双删、Canal、Binlog、Saga、Outbox、分库分表、灰度发布、回滚方案、迁移方案、强一致性、最终一致性、热点数据、BigKey、字段重命名、跨仓同步、外键、表结构审计). Not for one-line CRUD bugs, not for pure UI styling, not for general optimisation (use boost for that). Composes: brainstorming → data-opt → boost → writing-plans → r4. Knows this stack: single MySQL 8 per host + single Redis 7 + bun:sqlite read-mirror in proxies + filesystem OAuth sessions; no MQ / Canal / sharding / Saga warranted at current scale — proposals using them are rejected unless promote thresholds in references/checklists.md trip.
---

# Data governance — agent-gateway / codex-api / kiro-api / claude-api（claude-api 已于 2026-07-30 再次冻结）

## What this skill is

A **data-domain specialist** anchored to this specific 3-repo stack. Encodes:

1. The 9-section deliverable contract (system risk → field issues → MySQL → Redis → consistency → auto-fix → gray rollout → final architecture).
2. The audit checklists scoped to what actually applies here (no Saga deep-dive on a single-node stack).
3. Stack-specific playbooks using **Bun + Hono + mysql2/promise + bun:sqlite + ioredis** — not generic Java/Spring.
4. Project-specific anti-prescriptions ("don't propose Canal" — here's why and when it'd flip).

## When to invoke

- "全面审查数据一致性" / "schema 审计" / "缓存一致性" / "字段重命名"
- A new migration that touches cross-repo-shared columns
- After a data-shaped bug surfaces ("两个页面数据不同步")
- Before adding a new sync mechanism / cache path

## When NOT to invoke

- Single-row CRUD bug → regular debug
- UI fallback chain only → `impeccable`
- General "make it better" with no data angle → `boost`
- Re-running a previous audit on the same scope within the same week (results will be the same; act on findings instead)

## Composition

```
brainstorming     → if scope vague: nail down "what subsystem? what done-criteria?"
       ↓
data-opt          → THIS skill: domain knowledge + checklists + playbooks + 9-section contract
       ↓
boost             → PDCAA iteration spine (Stable Contract / cycles / AutoResearch / Log)
       ↓
writing-plans     → if migration spans ≥ 3 cycles or ≥ 2 services
       ↓
r4/sync4          → 全端 deploy (local → GitHub → LAN 192.168.1.186 → Azure 20.198.233.74)；cloud/222 已退役 2026-06-10
```

`cross-repo-sync` subagent dispatched automatically when a change touches files shared by both proxies (see CLAUDE.md trigger table).

## Required reading at the start of every Plan phase

Non-negotiable. Without these, this skill produces generic governance theater.

1. **`references/project-context.md`** — current schema ownership matrix, Redis namespace, 3-tier data model, "do NOT propose" rules, recently-fixed anti-patterns.
2. **`/Users/linqing.wang/Desktop/workspace-desktop/agent-gateway/docs/data-contract.md`** — the cross-repo contract: column owner + reader matrix.
3. **`/Users/linqing.wang/Desktop/workspace-desktop/agent-gateway/CLAUDE.md`** — 六铁律 + 多系统交互准则 + 跨仓 sync trigger table.
4. **`/Users/linqing.wang/Desktop/workspace-desktop/agent-gateway/docs/audit-backlog-2026-05-12.md`** — already-identified Medium/Low items; don't re-discover.

Skip this reading → re-discovers known issues, proposes already-rejected patterns. Failure mode.

## The 3-tier data model on this stack

This is the single most important mental model for this codebase. Memorise it.

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: MySQL  (source of truth)                               │
│  - One agent_gateway database per host (LAN, cloud, independent)│
│  - Schema owned by agent-gateway repo                           │
│  - Active proxies (codex-api + kiro-api) write a narrow column set│
│    (see data-contract.md); claude-api 再冻结（07-30），镜像暂停   │
└─────────────────────────────────────────────────────────────────┘
         │   (60s poll mirror — key-mirror + session-mirror)
         ↓
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2: Proxy local state  (read-side cache, on disk)          │
│  - bun:sqlite at ~/.codex-api/run/managed.sqlite (auth keys)    │
│  - Filesystem ~/.codex-api/sessions/<id>/session.json (tokens)  │
│  - kiro-api equivalent at ~/.kiro-api/ (credential + token)     │
│    (kiro accounts import-only; gateway-mode reads MySQL)        │
│  - REGENERATED from Tier 1 on the next 60s tick or restart      │
└─────────────────────────────────────────────────────────────────┘
         │   (in-process)
         ↓
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3: Redis  (ephemeral only)                                │
│  - OAuth flow state (TTL 5min)                                  │
│  - Portal user sessions (TTL 7d sliding)                        │
│  - Proxy OAuth refresh locks (TTL ~seconds)                     │
│  - Region-changed pub/sub channel                               │
│  - LOSING Redis: re-login + abort in-flight OAuth; nothing else │
└─────────────────────────────────────────────────────────────────┘
```

**Eventual consistency is ALREADY solved** by the 60s mirror loops. Any new "we need Canal / MQ / Binlog" proposal must explain why 60s is too slow for the specific path.

## Hard rules

1. **No theory-only output.** Every finding ships with concrete SQL / TS code / migration / gray plan / rollback. See `references/playbooks.md` for templates.
2. **MySQL is the single source of truth.** Redis + bun:sqlite + filesystem sessions are derived. Any proposal violating this is rejected.
3. **Forward-only migrations.** Files at `src/db/migrations/0NN_*.sql`, idempotent (recorded in `schema_migrations`). Rollback is documented as comment in the migration when feasible.
4. **Expand-then-contract for renames.** ADD new column → app dual-writes → mirror readers → app drops old reads → DROP old column. Each step crosses ≥ 1 deploy boundary.
5. **Cross-repo column changes go through `cross-repo-sync` agent.** Don't hand-write proxy mirror updates — let the subagent apply matching edits and validate with typecheck.
6. **Every state-changing write emits `audit_events`.** Agent-gateway is the sole audit writer; proxies don't write audit. Bootstrap reconciliations now also emit `system_admin_reconcile` + `orphan_keys_adopted` events.
7. **Gray rollout = `/r4` with LAN first.** Cloud deploy follows LAN smoke. `agent-gateway/deploy.sh` provides the health gate.
8. **Cite file:line.** No "I think X is wrong." If you can't cite, you haven't actually read the code.

## Anti-prescriptions ("don't propose these here")

| Pattern | Status | Promote when |
|---|---|---|
| Sharding | ❌ not warranted | `usage_events > 100M rows` or sustained write > 5k QPS |
| MySQL read replica | ❌ not warranted | Read QPS > 10× write QPS sustained, OR analytics workload steals from prod |
| Redis Cluster | ❌ not warranted | Dataset > 64GB or keys > 200M |
| Canal / Binlog consumer | ❌ not warranted | Downstream consumer ≥ 2 unrelated services AND mirror lag tolerance < 5s |
| Outbox | ❌ not warranted | Tx must atomically span MySQL write + external side-effect (e.g. payment, email) |
| Saga | ❌ not warranted | Business tx spans ≥ 2 services with independent rollback semantics |
| CQRS | ❌ not warranted | Read model materially different from write model AND read scale ≠ write scale |
| Event Sourcing | ❌ not warranted | Full append-only audit required AND projections rebuildable |
| Distributed lock (Redlock) | ⚠️ only for specific paths | Already used for OAuth refresh single-flight; don't bolt on elsewhere without measured contention |
| MQ (Kafka/Rabbit) | ❌ not warranted | Eventual sync window > 60s tolerable BUT consumer ≥ 2 unrelated; otherwise the 60s mirror is fine |
| Hot-key isolation | ❌ not warranted | Top-1 key > 10% of total Redis traffic |

If you propose any of the ❌ items, you MUST cite the specific evidence that flipped the promote condition. Otherwise reject the proposal yourself before showing it to the operator.

## Execution flow

This skill runs inside a `boost` PDCAA loop. Each cycle picks ONE target. Use boost's Stable Contract + 5-phase template; this skill provides the menu and the deliverable contract.

### Stable Contract defaults

| Field | Default |
|---|---|
| Goal | "Bring `<subsystem>` to industrial-grade data correctness AND ship the fix through `/r4`." |
| Constraints | MySQL = SoT • forward-only migration • expand-then-contract for renames • cross-repo via `cross-repo-sync` • LAN-first deploy • no dirty data • every write audited • respect `docs/data-contract.md`. |
| Done | All 9 deliverable sections emitted • critical/high fixes committed AND deployed via `/r4` • Medium/Low items written to `docs/audit-backlog-<date>.md`. |
| Checks | `bun run typecheck` clean • `bun test` clean • cross-repo grep for renamed/dropped fields shows 0 stale refs • LAN + cloud `/health` 200 post-deploy • schema_migrations row written for any migration. |

### Audit targets menu (pick one per cycle)

1. **Schema audit** — tables, columns, FKs, indexes, types, NULL discipline. See `references/checklists.md` §1.
2. **Field reference audit** — page ↔ API ↔ DTO ↔ ORM ↔ DB ↔ Redis trace. See §4.
3. **MySQL performance audit** — EXPLAIN, slow log, index coverage. See §1 perf.
4. **Redis governance audit** — keyspace, TTL, BigKey, hot-key. See §2.
5. **Sync pipeline audit** — key-mirror, session-mirror, region-changed pubsub, charge-worker, audit emission. See §5.
6. **Consistency audit** — 3-tier coherency, cache invalidation order, idempotency keys. See §3.
7. **Cross-repo contract audit** — `docs/data-contract.md` vs reality, both proxies. See §4 cross-repo subsection.
8. **Audit-event coverage audit** — every write should have a record. See §9.
9. **Migration governance** — expand-then-contract trail for any open rename; cleanup of completed migrations.
10. **Legacy data backfill** — orphan rows, NULL-where-not-null, encoding mojibake. See `references/playbooks.md` §11.

### Per-cycle minimum action template

```
Plan: choose one target → state ONE verifiable minimum action
      (read project-context.md first if this is the first Plan)
Do:   apply the action; emit concrete artefacts in the 9-section format
Check: boost 5-question gate + this skill's deliverable-coverage gate
Align: 5 drift dimensions from boost; re-anchor if any signal fires
Act:  continue / adjust / rollback / research / complete
```

## Required deliverables — the 9-section contract

When the cycle that decides `complete` fires, the conversation MUST surface all 9 sections. Partial delivery = not complete.

### 1. System risk overview
| Severity | Risk | Blast radius | Evidence |
|---|---|---|---|
| critical | … | which page / service / data path | file:line or query result |

### 2. Schema issue inventory
Per finding:
- **Problem** — one-line description
- **Root cause** — why it exists (history / oversight / contract drift)
- **Risk** — what breaks if not fixed
- **Fix** — migration SQL (forward + rollback comment)
- **Refactor plan** — if structural, the multi-stage rollout
- **Severity** — critical / high / medium / low
- **Affects production?** — yes / no / only on next schema change

### 3. Field reference issue inventory
Per finding:
- **Field name** — both logical (UI label) and physical (DB column)
- **Actual path** — `page → API → DTO → ORM → DB → Redis` with each layer's actual name
- **Expected path** — what's correct
- **Fix plan** — patch coordinates per layer

### 4. MySQL optimisation plan
Per item: before SQL → EXPLAIN snippet → after SQL → EXPLAIN snippet → why it's faster. Cover: index, SQL rewrite, schema, pagination (keyset over OFFSET), concurrency (single-statement UPDATE over RMW), lock budget.

### 5. Redis optimisation plan
Key structure (namespacing) • TTL (with jitter) • coherency strategy (cache-aside / delayed double delete / single-flight) • hot-key plan (split or accept) • BigKey plan (split or accept) • degradation plan (what happens when Redis is down).

### 6. Consistency plan
For each write path: pick a pattern from the table below. Cite the `references/playbooks.md` template.

| Pattern | When |
|---|---|
| Single-statement UPDATE | Default for in-process writes |
| Cache-aside | Default for reads |
| Delayed double delete | Write path with concurrent reads from cache |
| 60s poll mirror (existing) | Cross-process eventual consistency on shared MySQL |
| Redis pub/sub + 60s poll | Lower-latency invalidation with poll as safety net |
| Single-flight Redis lock | OAuth refresh (already used) |
| Idempotency key | Anything exposed externally that retries |
| Monotonic guard | last_429_at-style fields |

### 7. Auto-fix bundle
- Migration SQL (forward + rollback)
- Redis fix script (if any)
- Data repair script (if any)
- Code diffs as proper Edit tool calls (not pseudo-code)
- Cross-repo diffs dispatched via `cross-repo-sync` agent if shared columns touched

### 8. Gray rollout plan
| Stage | Action | Advance trigger | Rollback trigger | Owner |
|---|---|---|---|---|
| 0 | local commit, typecheck + test green | — | — | this skill |
| 1 | `git push origin main` | tests pass | revert commit | this skill |
| 2 | `./deploy.sh` (LAN) | `/health` 200 for 30s | `systemctl revert + restart` | this skill |
| 3 | rsync + restart cloud | `/health` 200 + e2e probe | revert + restart | this skill |
| 4 | observe 30 min in journalctl | no new error pattern | manual revert | operator |

This is the canonical `/r4` flow. Don't invent a new gray scheme.

### 9. Final architecture
ASCII diagram (data flow / cache flow / sync flow). One paragraph rationale per lane.

## Output format

Always Markdown. Use the section headings above verbatim. Each finding includes severity + affects-production tag.

```markdown
# Data governance report — <subsystem> — <YYYY-MM-DD>

## 1. System risk overview
…
## 2. Schema issue inventory
### S1. <one-line title>
- Problem / Root cause / Risk / Fix SQL / Refactor / Severity / Affects prod
…
## 9. Final architecture
\`\`\`
[ASCII]
\`\`\`
```

## Safety engine (every artefact MUST satisfy)

- **Gray-able** — `/r4` stages defined
- **Reversible** — rollback SQL/code provided OR explicit "expand-then-contract" trail named
- **Observable** — what log line / metric / `/health` field proves success
- **Auditable** — `audit_events` row stamped for every write
- **Non-blocking** — no long-lock migration on `client_keys` / `provider_accounts` / `usage_events`
- **Cross-repo aware** — proxies' mirror code updated in lockstep if columns they read changed
- **Zero-dirty-data** — every step verifies row count + checksum
- **No mirror desync** — 60s poll path tested by waiting one cycle + re-querying

Reject any deliverable that fails this gate.

## Stop conditions

- All 9 sections delivered with concrete artefacts + at least the Critical/High fixes deployed via `/r4`
- User says "先不要改" / "analyze only" → halt after current Check; do not touch code
- A required deliverable is blocked on info only the operator can provide → ask exactly one question and stop
- Same issue flagged 2 cycles in a row without progress → escalate to operator + write to backlog doc

Do NOT use this skill for explanation-only, brainstorming-only, or clerical tasks.

## Failure modes observed in past runs (avoid)

| Pattern | What goes wrong | Counter-rule |
|---|---|---|
| Propose Canal / Outbox / Saga | Operator rejects; cycle wasted | Read anti-prescription table BEFORE Plan |
| Skip `data-contract.md` | Re-discovers known column ownership | Required reading enforced |
| Bulk-rotate destructive ops | 22+ active keys invalidated at once | Always offer per-row affordance first |
| Combined "刷新+复制" button | Operator wanted clear separation | Copy is copy, refresh is refresh |
| Forget cross-repo grep after rename | Stale references in proxy code | Run cross-repo-sync; verify with typecheck |
| Skip LAN before cloud | Cloud breaks first; operator-visible | `/r4` enforces order |
