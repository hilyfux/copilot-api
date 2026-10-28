---
description: 容器化发布 — GitHub + LAN，统一经 agent-stack/release.sh（env-parity 门 + 真实请求 200 门 + 秒回退）；azure 2026-10-28 起冻结（停服删机），不是发布目标
allowed-tools: Bash, Read
---

# 容器化全端发布

把**当前项目**的当前 HEAD 推 GitHub，并容器化重发到 LAN。（azure 2026-10-28 起冻结，见下文「⏸ azure 已冻结」。）

> 2026-07-06 收敛完成：**四服务**（codex-api / kiro-api / agent-gateway / byok-api）
> ×2 主机全部走同一套流程、同一版本的门、同一形态构建目录——不再有"某服务没走过
> 新流程"的特例。部署统一走 `agent-stack/release.sh <svc> --host <key>`（本地
> **预发布门**(typecheck+测试) → host 上 docker build（rsync 内容完整性门）→
> **env-parity 门（key+value 双重）** → cutover **真实请求门** → 失败秒回退）。旧的
> “rsync 源码 + systemctl restart” 流程已**废弃**（发布链旧脚本已删、旧源码目录已清；
> 主机上的服务 systemd 单元**保留为停用冷备**——cutover 失败且无上一容器时的兜底，见「回退现状」）。
> 本命令 = 编排器：push GitHub + 逐台调 release.sh；构建 / 健康门 / 回退都在 release.sh 内建，本命令**不重造**。
> claude-api **已于 2026-10-16 从系统移除（⛔ 退役）**：不是发布目标——从 claude-api 仓跑本命令应当**拒绝**并提示已退役；识别 regex 保留 claude-api 仅为给出明确报错而非误识别为其他服务。

## 产品线代号（2026-07-25 定稿；权威定义见 agent-gateway `docs/product-lines.md`）

`--host lan` = **lan**（局域网自家用，域名 Energy）。
azure = Agent On（对外服务）**2026-10-28 起冻结、不再是发布目标**——`--host azure` 被 release.sh 拒绝（退出码 4）；
（ailink 已于 2026-08-26 **退役**：产品终止、hosts.json 条目与 compose 栈已删除，`--host ailink` 不再是合法取值。）

## ⛔ ailink 已退役（2026-08-26，operator：「产品不做了」）

**这条线已终止**（此前 2026-08-05 冻结）：功能代码与交付机器已删除——`hosts.json`
条目、compose 栈、ops-bundle 管线、`src/brand.ts` 的 `ailinkus` 行。那台机器由其
自带的 `new-api` 自治，与本体系再无契约关系。`--host ailink` 不是合法取值；
历史脉络见 `docs/product-lines.md`「线的状态」retired 段。

## ⏸ azure 已冻结（2026-10-28，operator 停掉 Agent On）

azure 冻结，不再是发布目标：服务已停，Azure 主机（azure-sg-agent-on）和上面的全部数据已删除（用户 / 账号不保留）。
代码与配置保留在仓库里，以后在**新机器**上重新上线：agent-stack `profiles/agent-on/README.md`
（`./bootstrap-host.sh --profile agent-on --host <新键>`）。agent-stack `retired-hosts.json` 让 `release.sh --host azure`
直接拒绝（退出码 4），旧 IP 换了键名也会被拒。本命令遇到 `--host azure` **拒绝执行**并提示上面这段。

## 发布原则（2026-07-30，operator 定）

**只发布 lan。** azure 2026-10-28 起冻结（停服删机）：`--host azure` 被 release.sh 硬拒绝（退出码 4），
不存在「人工确认后发 azure」这条路径——没有机器可发，确认与否结果相同。下面几条是 azure 重新上线前的历史脉络，
仅说明「为什么以前即使通道都能发，默认动作也只动 lan」；重新上线后这条原则本身可能需要重新讨论。

- （历史）判断口诀：改了 `src/`，默认发 lan 验证；azure 等人工确认再同步。
- 「三台走同一条发布通道」（2026-07-27 收敛）说的是**通道能力**一致，不是默认动作——
  能力上任一台都可发，动作上默认只动 lan。
- （历史）AI 不得自行决定把改动同步到 azure；用户原话点名或回答确认后才执行。
- **「全端发布」现在 = lan**（azure 2026-10-28 冻结、ailink 已退役）。azure 重新上线后才恢复「lan + azure」。

## 铁律对照
- **高内聚**：命令只编排；构建 / 门 / 回退在 release.sh 一处
- **低耦合**：经 release.sh 显式接口 + gitignored `agent-stack/hosts.json` 数据契约联通；**发布路径零主机知识**（末尾凭据表仅人工调试参考，release.sh 不读）
- **稳定**：任一台门失败即停、原样回报、不重试
- **鲁棒**：入口显式校验（SVC 识别 / agent-stack 就位 / hosts.json 就位 / 工作树脏检查）
- **扩展**：加主机 = hosts.json 一行（`--host` 自然支持）；加服务 = 命令 auto-detect 通用

## 输入
- 无参数 → GitHub push + **只发 `lan`**
- `--host <key>` → 只发某台（key = hosts.json 顶层键）
- `--host azure` → **拒绝执行**：azure 2026-10-28 起冻结（停服删机），不再是发布目标
- `--host ailink` → **拒绝执行**并提示已退役（2026-08-26）
- `--no-lan` → 连 lan 也跳过（只 push）
- `--no-push` → 跳过 GitHub push（只重发容器）
- `--dry-run` → 只打印计划，不执行

## 前置校验（任一不过即停）
1. **识别服务**：`git remote get-url origin | grep -oE 'agent-gateway|codex-api|kiro-api|byok-api|claude-api' | head -1` → `$SVC`；失败即停报错。（2026-07-06 修：旧清单漏 byok-api → byok 仓跑本命令直接识别失败；2026-07-18 补 claude-api：解冻并容器化后从其仓跑本命令须能识别）
2. **agent-stack 就位**：`test -x ../agent-stack/release.sh`（部署工具仓须与服务仓同级 clone）。
3. **hosts.json 就位**：`test -f ../agent-stack/hosts.json`；缺则提示 `cd ../agent-stack && cp hosts.example.json hosts.json` 并填本机 fleet。
4. **工作树**：release.sh 从**工作树** rsync 构建。有未提交改动 → 提示（a 先 commit / b 就用工作树发 / c 取消）。要发布“某个提交 / 版本号”务必先 commit。

## 第 1 端 · GitHub（`--no-push` 跳过）
```bash
git push origin "$(git symbolic-ref --short HEAD)"
```
失败原样回报，**不强推**。

## 各主机 · 容器化发布
对 hosts.json 里每个主机 key（受 `--host` / `--no-*` 过滤）依次执行：
```bash
(cd ../agent-stack && ./release.sh "$SVC" --host "<key>")
```
release.sh 内建全套门（本命令不重造健康门；2026-07-06 现状）：
- **[0/3] 预发布门**：本地 typecheck + 单测，失败不触碰任何主机（逃生口 `RELEASE_SKIP_TESTS=1`）
- **[1/3] 源同步**：rsync 失败即停（禁止拿旧构建目录建"陈旧镜像"）+ **内容完整性 dry-run 门**（二次 rsync 必须零待传文件）；排除表含 `data/`/`memory/` 等研究目录（曾致构建目录 9GB）且 `--delete-excluded` 使既有主机自动收敛
- 描述符驱动 **bundled build**（minified dist，镜像无 .ts 源码）
- **preflight**：env-parity **key+value 双重**（committed `<svc>/deploy/container.env` 须覆盖 live 每个 `<PREFIX>_` key，且 base 值不得漂移——防"下次发布静默回滚线上手改"）；gateway 另加 pin-lookup 并行奇偶校验
- **cutover**：有状态代理（codex/kiro）唯一写者切换 + **真实请求门**；gateway pin-lookup + downstream e2e + OAuth 沙箱自检
- **失败秒回退**

**门判定语义（勿误读非 200 为失败）**：真实请求门是 **parity 判定**（serving_ok），不是"魔法 200"——新容器答复须与被替换实例一致：`402=402`（计费限额 key）✅、无路由 key 时 auth-boundary `≠401` 即 ✅（如 503/400）；只有 `401 / 5xx / 000` 是确定性 mis-serve。实例：2026-07-06 kiro azure `402=402` ✅、byok azure `503≠401` ✅。

任一台 release.sh 非 0 退出 → **停止本命令**，把它的输出原样给用户，**不重试**。

## 版本号（与本命令解耦）
release.sh **不 bump 版本**（镜像 tag = `package.json` 版本，只读）。要发新版本号：先手动改 `package.json` + `CHANGELOG` + commit，再跑本命令。/version 的诚实性靠 release.sh 按 `package.json` + 实时 `git commit` 现生成 build-info（不再依赖旧的 `.build-info.json`）。

## 回退现状（已变，重要）
容器化后，旧的 “systemctl 冷备回退” 已随 systemd 单元删除而移除：
- 容器 `--restart unless-stopped`：重启自恢复，不依赖 systemd（铁律3 重启零丢失）。
- 主动回退：`ssh <host> 'docker rm -f <svc>'` → 再 `release.sh <svc> --host <host>` 重发（上一版镜像 `local/<svc>:<版本>` 仍在 host docker）。
- **cutover 自动回退（2026-07-01 已修）**：任一门失败 → 自动删新容器 + 重启切换前正在跑的那个容器（rollback_container：捕获旧镜像、DRY 复用 start_ctr、state 挂载持久、唯一写者保持）；无上一容器才回落 systemd 兜底。

## 汇报（必打印）
> 输出通俗易懂纪律（INVIOLABLE §六）：汇报只给这张表 + 一句话结论；不复述每步日志、不长篇大论。失败才把对应 release.sh 输出附上。

| 端 | 动作 | 结果 |
|---|---|---|
| GitHub | push `<branch>` | ✓ / ✗ / skip |
| lan | `release.sh <svc> --host lan` | ✅ cutover OK / ✗ / skip |
| azure | ⏸ 冻结（2026-10-28 停服删机），不发 | skip |

（ailink 已退役，不再出现在本表。）

任一格 ✗ 不算成功，用 ⚠ 标注并把 release.sh 输出附上。
azure 冻结期间固定填 skip（不算失败，也不用再提醒「需要时说一声」——它没有机器可发）。

## 发布后收敛核对（2026-07-06 收敛经验，全绿后快速自检）
```bash
ssh <host> 'curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/health'   # 200
ssh <host> 'docker ps --format "{{.Names}}: {{.Status}}" | grep <svc>'                       # healthy
ssh <host> 'du -sh ~/<svc>-build'   # MB 量级；GB 量级 = 排除表漏了新的大目录（9GB data/ 教训）
```
端口：codex 39516 / claude 39518 / gateway 39520 / kiro 39521 / byok 39523。构建目录健康基线：
gateway ~136M（chrome 层）、codex ~4M、kiro ~1.2M、byok ~0.8M。

## 故障排查指针
- 下游 "Connection closed mid-response" / ECONNRESET + nginx 零记录 → 事故当下跑
  `agent-stack/test/probe-lb-vs-tunnel.sh` 三分定位（LB 数据面 / VM本机 / 用户侧网络）。
- （历史，azure 已于 2026-10-28 停服删机）azure 入口拓扑：`agent-stack/docs/azure-ingress-topology.md`（**Azure LB 是
  唯一公网进出口**——443→30443/80→39520/39517→39517，SSH 也在 LB 上；"没有 LB"是
  已被 IMDS 证伪的认知漂移）。
- 被杀请求可能在桥侧记 `outcome=ok`（客户端 abort + quiet close，27eca10 后已改记
  truncated）——排查用户投诉时按 ingress access log 的 `499 + body_bytes_sent=0 + rt`
  对齐桥的 requests.jsonl。

## 已废弃（不要再用）
- `scripts/deploy-lan.sh` / `deploy-azure.sh` / `release.ts` 及整套旧发布链（assert-release-identity / verify-remote-bundle / deploy-targets / setup-systemd* / quick-fix）：**已删除**（2026-07-01，容器化）。
- 主机身份在 `agent-stack/hosts.json`（gitignored），密钥在主机 `/etc/agent-stack/<svc>.env`（chmod 600，永不入 git）；末尾凭据表仅供人工 SSH/DB 调试，发布流程不读。

## 主机 & 凭据参考（运维调试用）
> 发布流程本身**不读本表** —— release.sh 从 gitignored `agent-stack/hosts.json` 取 ssh/dir/hostEnv，密钥在主机 `/etc/agent-stack/<svc>.env`。下表仅供人工 SSH / DB 调试。

| 别名 | 主机 | 用户 | 认证 |
|---|---|---|---|
| `lan-server` | 192.168.1.186 | root | ssh key + 备用密码 `wlq.1919` |
| ~~`azure-sg-agent-on`~~（2026-10-28 已删除） | ~~20.198.233.74:8022~~ | azureuser | 密钥 `~/.ssh/azure-sg-agent-on`（2026-09-23 起亦可密码登录，口令只记在 vms 仓库，不入本仓）+ sudo NOPASSWD |

| 资源 | LAN (186) | Azure（2026-10-28 已删除，仅存档） |
|---|---|---|
| MySQL 8 | `:3306` root/`dbPaSsre^186` db=`agent_gateway` | `:3306` root/`dbPaSsre^186` db=`agent_gateway` |
| Redis 7 | `:6379` | `:6379` |

> ssh key 优先；LAN 可回退 `sshpass -p '<pwd>' ssh …`，**Azure 不要用 sshpass**。密码不进标准输出。

## 经验法则
- 同一服务 **1 分钟内不重复发**（cutover 有短暂唯一写者窗口）。
- 网关与 codex/kiro/byok 均 `overlapSafe`，走零停机重叠切换（先等主机空闲、慢≠坏超时重试）；只有非 overlapSafe 服务或容器化 nginx 主机才退回“停旧起新”。发布不碰 Mihomo 内核。
- 只想 push 不部署：`--no-lan`。
