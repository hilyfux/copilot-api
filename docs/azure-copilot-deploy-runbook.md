# Azure deploy runbook — copilot-api as an agent-gateway proxy

Status: **PREPARE-ONLY, not executed.** Written by W4 (ingress + deploy prep) of the
"Copilot as a first-class agent-gateway provider" task. Nothing in this file has been
run. Do not run any step here until W1 (catalog/routing) + W2 (migration 168) + W3
(proxy green) are merged — see "Merge order" in `agent-gateway/TASK-copilot-provider.md` §3.

**Scope discipline (§0 of the brief):** azure (`azure-sg-agent-on`) only. `lan`
(192.168.1.186) gets zero changes from this file. No billing/pricing step is included —
this is single-operator internal use, not a sold product.

## 0. Port correction — read this first

The task brief suggested loopback port **39525** for copilot-api ("taken by codex/kiro/
notion" — 39516/39521/39524). That reasoning missed `gemini-api`, which **already owns
39525** (`gemini-api/deploy.json`, `gemini-api/src/config.ts`, `gemini-api/CLAUDE.md`).
Reusing 39525 for copilot-api would be a real double-bind on azure the first time both
services are live.

**This runbook uses 39526 instead** — confirmed free (grepped across every repo in the
workspace: no `.json`/`.conf`/`.ts`/`.sh`/`.md` file references it), and already inside
the fleet's reserved listener band `39516-39535`
(`agent-stack/scripts/setup-fleet-reserved-ports.sh`), so no sysctl change is needed.

`agent-stack/services.json` and `agent-stack/nginx/hosts/azure/conf.d/agent-ingress.conf`
have already been updated (by this W4 pass) to use 39526. If any other workstream's
patch (W1's `src/providers/catalog.ts`, or a stray comment anywhere) hardcodes 39525 for
copilot, it needs to change to 39526 before merge — grep for `39525` near "copilot"
before shipping.

## 1. What this W4 pass already did (agent-stack repo, azure-scoped)

| File | Change | Touches lan? |
|---|---|---|
| `agent-stack/services.json` | added `copilot-api` service: `port:39526`, `role:proxy`, `family:copilot`, `probePath:/v1/messages`, `ingressBackend:true`, `hostOnly:["azure"]`, `logs:[]` | No — `hostOnly` excludes it everywhere else |
| `agent-stack/nginx/hosts/azure/conf.d/agent-ingress.conf` | added `include .../upstreams/agent_copilot_api.conf;` + `"copilot-api" agent_copilot_api;` map key, mirroring the notion-api lines byte-for-byte in structure | No — this file is under `nginx/hosts/azure/`, azure's manifest only |
| `agent-stack/test/services_registry.test.sh` | azure ingress-backend assertion extended to include `copilot-api` | No |
| `agent-stack/test/nginx_backend_coverage.test.sh` | added a real-`services.json` (not synthetic fixture) section proving `DEPLOY_HOST=azure` requires `copilot-api` in the map and `DEPLOY_HOST=lan` does not | No |
| `agent-stack/test/release_probe_key_families.test.sh` | azure default probe-family assertion extended to include `release-probe-copilot` | No |

Nothing under `nginx/hosts/lan/` or `nginx/live-snapshots/` was touched. `git status` in
`agent-stack` shows only the five files above as modified.

**Tests run (all local, no live host, no prod nginx touched):**

```sh
cd agent-stack
bash test/services_registry.test.sh          # 全部通过
bash test/nginx_backend_coverage.test.sh      # PASS nginx_backend_coverage gate
bash test/nginx_ensure_backend.test.sh        # ALL PASS (unaffected, pure-function test)
bash test/nginx_upstream_flip.test.sh         # PASS (unaffected, pure-function test)
bash test/release_probe_key_families.test.sh  # 全部通过
bash test/claude_api_retired.test.sh          # PASS (unaffected)
bash test/contract_gate.test.sh               # 全部通过 (unaffected)
bash test/nginx_template_gateway_upstream.test.sh  # all checks passed (unaffected)
bash test/probe_path_per_service.test.sh      # 全部通过 (unaffected)
bash test/retire_claude_api_host.test.sh      # PASS (unaffected)
bash test/rollback_restores_prev_env.test.sh  # 21/0 (unaffected)
bash test/build_context_excludes.test.sh      # 全部通过 (unaffected)
bash test/ctr_drop_parked_logs.test.sh        # 13/0 (unaffected)
bash test/cutover_gateway_overlap.test.sh     # 73/0 (unaffected)
bash test/cutover_gateway_slow_gates.test.sh  # 27/0 (unaffected)
```

## 2. What this W4 pass deliberately did NOT do

Per the task's hard scope line ("do not modify copilot-api — W3 owns it; only READ its
Dockerfile"), the following are **not created**, only specified below as copy-paste
proposals for whoever lands them (W3, or the merge step):

- `copilot-api/deploy.json` — §3 below has the proposed content.
- `copilot-api/deploy/container.env` and `copilot-api/deploy/host.env.example` —
  `agent-stack/scripts/assemble-env.sh` requires these to exist for the committed-config
  path; without them it falls back to the older `derive-env.sh` path, which still works
  but is the "transitional" mode, not the current house pattern (see sibling repos'
  `deploy/` directories for the shape, e.g. `kiro-api/deploy/`, `byok-api/deploy/`).
- Any nginx *apply* to the live host (only the repo template changed; see §0 in the
  constraint recap — `sync-nginx.sh` was never run with `--apply`).
- Any `docker run`, `release.sh`, or `setup-*.sh` invocation. Nothing here has touched
  azure.

## 3. Proposed `copilot-api/deploy.json` (not created — for whoever adds it)

Mirrors `kiro-api/deploy.json`'s shape (stateful, per-account credential on disk) more
than `notion-api/deploy.json`'s (gateway-MySQL-only, no local token). copilot-api needs
BOTH: gateway MySQL for keys/usage (via `src/gateway/`) AND a local credential file
(the GitHub Copilot device-flow token) that must survive a rebuild — exactly what the
task's §4 container plan asks for.

```json
{
  "$schema": "../agent-stack/docs/deploy.schema.md",
  "service": "copilot-api",
  "port": 39526,
  "healthPath": "/",
  "stateDir": "/root/.copilot-api",
  "mounts": [],
  "migrate": false,
  "stateful": true,
  "overlapSafe": false,
  "keyFilter": "created_provider_type='copilot' OR provider_type='copilot'",
  "requireEnvFlag": null,
  "notes": "Gateway-MySQL mode (client_keys/provider_accounts via src/gateway/, writes usage_events/usage_daily/client_sessions) PLUS a local GitHub Copilot device-flow credential file under COPILOT_API_HOME that must survive a container rebuild (identity-mounted, like kiro-api's oauth.json). overlapSafe=false until a concurrency audit proves two copilot-api instances can safely share/rotate the local credential file during an overlap cutover (same conservative default notion-api used pending its own audit). First deploy is a cold docker-run bootstrap (no prior container) AND requires the credential file to already exist at the state dir before the stateful-proxy cutover gate will start it — see §5/§6 below; this is intentional, not a bug: it is exactly how this stack enforces 'do not invent a token, stop at a documented TODO' at the tooling level."
}
```

`healthPath: "/"` because the Dockerfile's own `HEALTHCHECK` curls `/` (not `/health`):

```
HEALTHCHECK ... CMD ["wget", "--spider", "-q", "-T", "4", "-Y", "off", "http://127.0.0.1:4141/"]
```

(read from `copilot-api/Dockerfile`, not modified).

## 4. The non-root-user gotcha (read before the first `docker run`)

Unlike codex-api/kiro-api/byok-api (which run as root in their containers, so the fleet's
identity-mount convention is `-v /root/.<svc>:/root/.<svc> -e HOME=/root`),
**copilot-api's own Dockerfile runs as a non-root `bun` user**:

```
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown bun:bun /data && chmod 700 /data
USER bun
VOLUME ["/data"]
```

Mounting a root-owned `/root/.copilot-api` straight onto this image will fail the
entrypoint's own writability check:

```
if ! mkdir -p "$data_home" || [ ! -w "$data_home" ] || [ ! -x "$data_home" ]; then
  printf 'Cannot write API home: %s. Prepare the mounted directory for UID:GID %s:%s. Do not use chmod 777.\n' ...
```

**Before the first run**, discover the real UID:GID of `bun` inside the built image and
chown the host state dir to match — do not guess a UID:

```sh
# on azure, after the image is built (release.sh builds it as local/copilot-api:smoke)
docker run --rm local/copilot-api:smoke sh -c 'id bun'
# → use the printed uid:gid, e.g. chown 1000:1000 (DO NOT assume 1000:1000 without checking)
sudo mkdir -p /root/.copilot-api
sudo chown <uid>:<gid> /root/.copilot-api
sudo chmod 700 /root/.copilot-api
```

## 5. Credential import — explicit operator TODO, not done by this task

**TODO (operator, not automatable from this chat/session):** import a real GitHub
Copilot credential before copilot-api can serve any Copilot-backed request.

Per the task's constraint #7: never send the credential through chat or a CLI argument,
never invent one, never fall back to a static key. copilot-api's own fork already has
the right mechanism for this — `copilot-api auth login --provider copilot` is a **GitHub
device-code OAuth flow**, not a pasted static token: the operator visits
`github.com/login/device`, enters a short-lived public code, and the long-lived token is
written directly to a file inside `COPILOT_API_HOME` by the CLI process itself. The
secret never appears in this chat, in shell history, or as a command-line argument at
any point.

Run this ONE TIME, interactively, over SSH (TTY required for the device-code prompt),
AFTER §4's chown and BEFORE the first `release.sh copilot-api --host azure`:

```sh
ssh azure-sg-agent-on
sudo docker run --rm -it \
  -v /root/.copilot-api:/root/.copilot-api \
  -e COPILOT_API_HOME=/root/.copilot-api \
  local/copilot-api:smoke auth login --provider copilot
# follow the printed github.com/login/device URL + code on any browser
```

If this step has not been run, **stop here** — do not proceed to §6/§7. There is no
fallback token and none should be invented. `copilot-api auth login --provider codex`
(a *different* provider, OpenAI Codex via the same CLI) is already covered by the
sibling `codex-api` proxy and is out of scope for this credential.

## 6. Why the automated cutover will itself refuse a missing credential

This is a second, independent safety net (not something this task added — it already
exists in `agent-stack/scripts/cutover.sh`): a `stateful:true` service's state dir is
checked for being non-empty before the gate will start the new container —

```
[ -d "$HOST_STATE" ] && [ -n "$(ls -A "$HOST_STATE" 2>/dev/null)" ] \
  || { echo "✗ host state dir '$HOST_STATE' missing/empty — refusing cutover ..."; exit 1; }
```

So with `deploy.json.stateDir = /root/.copilot-api` and `stateful: true` (§3), a
`release.sh copilot-api --host azure` run BEFORE §5's device-flow login will fail closed
on its own, loudly, before touching anything. That is the intended behaviour — it is the
same mechanism that already protects kiro-api's per-account token import.

## 7. Full sequencing (per brief §3 — nothing below has been run)

Merge order first: **W2 (migration) → W1 (catalog/routing) → W3 (proxy code) → W4
(this file's deploy steps)**.

1. **Migration 168 first, on azure, before the proxy starts** (W2's
   `src/db/migrations/168_copilot_api_grants.sql`, applied via agent-gateway's own
   migrate path — e.g. `agent-stack/release.sh agent-gateway --host azure`, since
   migrations run inside the gateway's container cutover per
   `agent-gateway/CLAUDE.md` "迁移随发布自动执行"). Confirm with the gateway's own
   migration log / `/version` endpoint, not guesswork.
2. **W1's catalog + pin-lookup land** in agent-gateway (`copilot_api` in `ProxyId`,
   the `copilot` catalog row, `X-Backend: copilot-api` routing in
   `internal-pin-lookup.ts`) and redeploy agent-gateway so pin-lookup actually emits
   `X-Backend: copilot-api` for a copilot-pinned account / copilot-family key.
3. **W3's proxy code is green** (`bun run typecheck`, `bun test ./tests`, the
   dual-protocol smoke 13/13 with no gateway configured) and `copilot-api/deploy.json`
   + `copilot-api/deploy/{container.env,host.env.example}` exist (§3 above — not yet
   created by this task).
4. **On azure, §4's chown** of `/root/.copilot-api` to the image's `bun` UID:GID.
5. **On azure, §5's credential import** (`auth login --provider copilot`, interactive,
   never through this chat).
6. **Create the nginx upstream include file manually, before syncing the template** —
   this is the one genuinely sharp edge in this whole plan. `agent-stack`'s own manifest
   says upstream `conf.d/upstreams/*.conf` files are **blue-green runtime state, never
   synced by `sync-nginx.sh`**:
   ```
   # NOTE: /etc/nginx/conf.d/upstreams/*.conf are runtime state (blue-green port
   # flips by release.sh cutover) — intentionally NOT managed here.
   ```
   But the template `agent-ingress.conf` (which IS synced) now has
   `include /etc/nginx/conf.d/upstreams/agent_copilot_api.conf;`. If that template is
   pushed before the include target exists, `nginx -t` fails — this is the exact
   2026-10-16 notion incident class (see the comment this W4 pass left in
   `agent-stack/nginx/hosts/azure/conf.d/agent-ingress.conf`). So, in this order:
   ```sh
   ssh azure-sg-agent-on
   sudo tee /etc/nginx/conf.d/upstreams/agent_copilot_api.conf >/dev/null <<'EOF'
   upstream agent_copilot_api { server 127.0.0.1:39526; keepalive 32; }
   EOF
   exit
   ```
7. **Preview, then apply, the nginx template** from the operator machine (never
   `--apply` blind):
   ```sh
   cd agent-stack
   ./scripts/sync-nginx.sh azure --diff     # must show ONLY the copilot-api lines as drift
   ./scripts/sync-nginx.sh azure --apply    # backs up, installs, `nginx -t` gate, reload; auto-restores on any failure
   ```
8. **(Idempotent safety net, optional)** confirm the bootstrap script sees nothing left
   to do — it should print "already routed... idempotent skip" since steps 6-7 already
   did its job via the committed template:
   ```sh
   ssh azure-sg-agent-on 'cd agent-stack && sudo ./scripts/setup-nginx-ingress-backend.sh copilot-api 39526'
   ```
9. **Release-probe key for the `copilot` family** — this now happens automatically
   (services.json already declares `family: "copilot"` + `hostOnly: ["azure"]`, so the
   default family list for `--host azure` already includes it, no `--families` override
   needed):
   ```sh
   ./scripts/setup-release-probe-key.sh --host azure
   ```
10. **First deploy** (cold docker-run bootstrap — no prior container, per §3's note):
    ```sh
    cd agent-stack
    ./release.sh copilot-api --host azure
    ```
    This builds the image from `copilot-api`'s own `Dockerfile` (read, not modified, by
    this task), assembles the env file, and — because §5 already populated
    `/root/.copilot-api` — the stateful-proxy gate in `cutover.sh` will find a non-empty
    state dir and proceed.

## 8. Health checks (run AFTER step 10, not now)

Per the task's §4.5 ("paste the status code and the response shape — never the token"):

```sh
# 1. plain health — no auth, proves the process is up and bound correctly
ssh azure-sg-agent-on 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:39526/'
# expect: 200

# 2. ONE authenticated /v1/models — using the SAME non-printing pattern this fleet
#    already uses for every other proxy's release-probe key (lib/common.sh
#    fetch_keys/require_probe_keys): the raw key is read from client_keys ON THE HOST,
#    inside a single remote shell invocation, and is NEVER assigned to a variable
#    that gets echoed, logged, or returned to the operator's terminal.
ssh azure-sg-agent-on <<'REMOTE'
set -eu
PW=$(sudo docker exec agent-gateway sh -c 'printf %s "$AGENT_GATEWAY_MYSQL_PASSWORD"')
K=$(mysql -h127.0.0.1 -uroot -p"$PW" -N -e \
  "SELECT raw_key FROM agent_gateway.client_keys WHERE label='release-probe-copilot' AND revoked_at IS NULL AND disabled_at IS NULL LIMIT 1;")
[ -n "$K" ] || { echo "no release-probe-copilot key found — run setup-release-probe-key.sh first" >&2; exit 1; }
CODE=$(curl -s -o /tmp/copilot-models.json -w '%{http_code}' http://127.0.0.1:39526/v1/models -H "Authorization: Bearer $K")
echo "status=$CODE"
head -c 400 /tmp/copilot-models.json; echo
rm -f /tmp/copilot-models.json
unset K
REMOTE
# expect: status=200 and a {"object":"list","data":[...]} shape (OpenAI /v1/models
# convention — the same shape every other proxy on this fleet returns)
```

The key value never leaves that single SSH session, is never echoed by name, and the
`unset` + temp-file cleanup at the end mirror the house convention in
`scripts/setup-release-probe-key.sh` ("本脚本不打印任何密钥").

## 9. Rollback

- nginx: `./scripts/sync-nginx.sh azure --rollback` restores the previous
  `agent-ingress.conf` (and reloads) if step 7 needs undoing. The manually-created
  upstream include file from step 6 is harmless to leave in place (an unreferenced
  `conf.d/upstreams/agent_copilot_api.conf` file with no `include` pointing at it is a
  no-op for nginx).
- container: `docker rm -f copilot-api` removes the first-deploy container; the host
  state dir `/root/.copilot-api` (and its imported credential) is untouched, so re-running
  step 10 alone recovers without repeating §5.
- release-probe key / services.json / deploy.json are all additive and need no rollback
  of their own — removing the `copilot-api` service from `services.json` would simply
  stop requiring it in `REQUIRED_INGRESS_BACKENDS`.

## 10. Iron-rule trade-offs surfaced by this prepare pass

- **扩展性 (extensibility):** `copilot-api` is pure data — a `services.json` entry + a
  template include/map line, zero new `if` branches in any shared script. The nginx
  template comment explains the ONE exception that is NOT data-driven (the separate
  upstream include file itself, because `sync-nginx.sh` explicitly excludes
  `conf.d/upstreams/*.conf` as blue-green runtime state) — documented in §7 step 6, not
  hidden.
- **可用性 (availability):** `overlapSafe: false` proposed for copilot-api (§3) means its
  *first* cutover after this bootstrap will be stop-first (`cutover.sh`), not
  zero-downtime overlap — an explicit, named trade-off (mirroring notion-api's own
  stance) until a concurrency audit of the local credential file under two concurrent
  instances justifies promoting it. For a brand-new, single-operator, non-billed
  provider this is an acceptable and conservative default, not a shortcut.
- **低耦合 (low coupling):** this task deliberately did NOT write
  `copilot-api/deploy.json` — that is copilot-api's own file, owned by that repo (W3),
  per the task's explicit scope fence. §3 gives the proposed content so the dependency
  is explicit and reviewable rather than invented silently by crossing the fence.
