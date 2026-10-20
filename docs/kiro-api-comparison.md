# kiro-api 对照检查与自托管决策记录

> 目的：这个 fork 用来做什么、和同类项目 kiro-api 差在哪、哪些照搬、哪些**故意不照搬**。
> 结论先行：**不照搬 kiro-api 的网关层**。自用场景下那些层是纯负债。
> 状态：2026-10-20 决策，实现见 `selfhost/azure` 分支。

---

## 一、为什么是 fork，不是从零写

调研阶段的方案是把 kiro-api 当骨架重写一个新服务。实际比对后放弃：

| 维度 | 从零按 kiro-api 重写 | fork caozhiyuan/copilot-api |
|---|---|---|
| 协议覆盖面 | 需要自己写 Anthropic↔OpenAI 双向翻译、SSE、工具调用、thinking | 已经有三套客户端协议，35958 行现成实现 |
| Copilot 上游适配 | 需要自己摸 token 交换、host 发现、模型目录、配额、429 | 已经处理，且是唯一完整处理 Enterprise Cloud host 的开源实现 |
| 测试基础 | 0 | 109 个测试文件 |
| 时间成本 | 数周 | 数小时到上线 |

铁律「极高扩展性：加新 provider 只增量加文件」在 fork 语境下的等价做法是：**不重写已能工作的层**。

## 二、结构对照

| 维度 | kiro-api | copilot-api（本 fork） |
|---|---|---|
| src 代码量 | 18,462 行 | 35,958 行 |
| 测试文件 | 108 | 109 |
| 依赖数 | 6 | 15 |
| 存储 | MySQL + Redis | 内置 SQLite（`node:sqlite` / Bun） |
| 部署资产 | `deploy.json`（agent-stack 契约） | `Dockerfile` + `docker-compose.yaml` |
| 监听端口 | 39521 | 4141（本部署改为 39525） |
| 客户端协议 | Anthropic + Codex Responses | Anthropic + OpenAI Chat + OpenAI Responses |
| 上游 | Kiro / CodeWhisperer 单一 | Copilot / codex / xai / 第三方可插拔 |
| 网关层 | `gateway/` 15 文件：计费、契约包、钥匙、用户 | **无** |
| 多租户 | 是（网关发钥匙、按 token 计费） | 否（静态 `auth.apiKeys` 数组） |

## 三、照搬 kiro-api 的部分（工程纪律，与业务无关）

1. **`.claude` 工具链**：已迁移。hooks 读全局 `~/.claude/CLAUDE.md`，架构铁律单一数据源，不在本仓复制一份。
2. **`.gitignore` 策略**：白名单式跟踪 `.claude`，忽略 worktrees / settings.local.json / 本地 MCP 路径 / knowledge-graph 运行时数据。
3. **`.mcp.json` 的 knowledge-graph 服务**：照 kiro 的形态建，但把机器绝对路径改成本仓路径（kiro 那份还指着失效的 `/Users/wanglinqing/...`）。
4. **可复跑的验证脚本**：铁律四要求结论来自测试。见 `scripts/smoke-dual-protocol.sh`。
5. **健康检查语义**：`GET /` 返回 `Server running`，可直接做容器 healthcheck，等价 kiro 的 `/health`。

## 四、故意不照搬的部分（本仓的核心决策）

| kiro-api 的层 | 为什么不要 |
|---|---|
| `gateway/`（计费、钥匙、用户） | 自用。没有第二个用户，没有需要收费的调用。引进来的是一整套 DB schema、迁移、对账和补算。 |
| `contracts-pkg/`（版本化契约包） | 契约包存在的理由是「网关 ↔ 多个代理」跨进程版本协商。只有一台机器一个实例时没有协商对象。 |
| MySQL + Redis | 单人实例用 SQLite 就够，少两个故障点。Redis 在 kiro 里承担跨实例锁；单实例不需要。 |
| `deploy.json` | 会让服务进入 agent-stack 的发布编排（含 lan）。本次发布范围只有 azure，用上游自带 Dockerfile 更直接。 |

**判断依据**：这些层的价值全部来自「多租户 + 多实例 + 跨仓契约」。三者都不成立时，照搬等于把别人的复杂度买进来。

## 五、copilot-api 有而 kiro-api 没有的

- 三协议客户端面（Chat Completions / Responses / Messages），一套账号池；
- 上游供应商多路复用（Copilot + codex + xai + 任意 openai-compatible），支持 provider 限定模型 id（`provider/model`）；
- token 用量与成本统计（含峰谷价窗口 `peak-windows.ts`）；
- Electron 桌面端（本部署不用）。

## 六、部署决策（azure only）

- 镜像：上游 `Dockerfile`，`oven/bun:1.4.2-alpine`，多阶段构建。
- 端口：容器内 4141，宿主仅绑 `127.0.0.1:39525`，不直接对外。
- 数据：`/data`（容器内 `COPILOT_API_HOME`）挂宿主持久目录，含凭证与用量库。
- 鉴权：`auth.apiKeys` 至少一把强钥匙；`--host 127.0.0.1` 时无钥匙会拒绝非回环绑定（`resolveServerBinding` 会抛错），这是上游的安全设计。
- 对外：nginx 反代 + TLS，与现有 agent-on 入口同一套 Cloudflare 链路。
- lan：**本次全程不动**。

## 七、验证记录

`bash scripts/smoke-dual-protocol.sh`（stub 上游，无需 Copilot 凭证）：

```
PASS  GET / is alive
PASS  unauthenticated request is rejected with 401
PASS  GET /v1/models lists the provider-qualified model
PASS  OpenAI /v1/chat/completions returns the upstream answer
PASS  Anthropic /v1/messages returns an Anthropic message
PASS  Anthropic /v1/messages carries the translated text
PASS  Anthropic /v1/messages reports usage tokens
PASS  Anthropic stream emits message_start / content_block_start / content_block_delta / message_stop
PASS  OpenAI stream emits chunk frames
PASS  OpenAI stream terminates with [DONE]
RESULT: all checks passed
```

另：`bun run typecheck` 通过。
