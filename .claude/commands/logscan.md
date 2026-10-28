---
description: 一键拉取全 fleet 日志 + 错误/性能摘要 + 深挖定位 — 经 agent-stack/fetch-logs.sh（只读，不碰服务状态）
allowed-tools: Bash, Read, Grep, Glob
---

# 日志扫描与问题定位

拉取指定主机全部服务的三层日志（docker stdout/stderr + errors/requests/virtualize.jsonl），
自动产出错误分类、性能分位、噪声聚类摘要，并按摘要结果深挖到具体 reqId。

> 本命令 = 编排器：拉取/摘要都在 `agent-stack/scripts/fetch-logs.sh`（内建
> `summarize-errors.js` + `summarize-requests.js`），本命令**不重造**统计逻辑。
> 全程只读——不 restart、不改配置、不写主机任何文件。

## 输入
- 无参数 → 拉 **lan** 近 24h（只读操作，无需发布式确认；azure 2026-10-28 停服删机，`--host azure` 被拒、退出码 4）
- `--host <key>` → 只拉某台（key = hosts.json 顶层键；现役只有 lan）
- `--since <窗口>` → 覆盖默认 24h（如 `6h` / `90m` / `7d`）
- `--svc <name>` → 只拉某个服务

## 执行

### 1. 拉取（Bash run_in_background）
```bash
cd ../agent-stack && ./scripts/fetch-logs.sh --host lan --since 24h        # 服务层
cd ../agent-stack && ./scripts/scan-infra-logs.sh --host lan               # 基建层
```
服务层输出落 `agent-stack/logs-pull/<host>-<UTC时间戳>/`（自动保留每主机最近 5 份）；
基建层（nginx 入口 / systemd 定时任务 / mihomo·redis 宿主进程 / MySQL）直接打印，
「空=零」段无输出即健康。**外部子系统（email-svc / usage-aca 等容器应用）不在
扫描范围**（operator 2026-08-05 定）。单段失败只标注不中断——照常分析其余。

### 2. 读摘要，分诊
脚本已打印四段摘要，按此分诊（勿把 INFO 心跳当错误）：

| 摘要段 | 看什么 | 动作阈值 |
|---|---|---|
| errors.jsonl 按 type 计数 | 新出现的 type / 环比暴涨 | 任一 type 单日 >50 或首次出现 → 深挖 |
| 性能摘要（requests.jsonl） | outcome 恶化（error/truncated 占比）· p95 回归 | error+truncated >2% 或 p95 环比翻倍 → 深挖 |
| docker stderr 高频行 | pin-lookup reject 群 · dispatch error · refresh 失败 | unknown_key/revoked 群 → 查 key；dispatch error → 深挖 |
| ⚠ 截断预警 | tail 上限吃满 | 需要全窗口精确计数时用 `--since` 缩窗重拉 |

**已知噪声（不当问题报）**：`ws_retry`（WS 断线自动重试，成功兜底）、
`tick complete`（心跳，已被脚本过滤）、`context_trimmed`（kiro 正常裁剪）、
`missing_key` reject（探测流量/未带 key 的客户端）、nginx `ignore long locked
inactive cache entry`（auth_request 缓存例行告警）。

基建层分诊：nginx 5xx >0 → 按时间点到 requests.jsonl 里对 reqId；failed 单元 /
定时任务 err / 进程 NOT RUNNING → 立即当待办处理。

### 3. 深挖（只对越过阈值的项）
三层日志按 reqId 贯通：
```bash
# 从 errors.jsonl 取样本 reqId → 全目录横查
grep <reqId> logs-pull/<dir>/*.jsonl logs-pull/<dir>/*.docker.log
# 某 type 的时间分布（凌晨齐发 = 定时任务/上游窗口；全天均匀 = 常态）
grep '"type":"<type>"' logs-pull/<dir>/<svc>.errors.jsonl | bun -e '…按小时聚合 ts…'
# 某账号/某用户维度聚合
grep '<accountId>' logs-pull/<dir>/<svc>.errors.jsonl | wc -l
```
需要事故现场更多上下文时：`ssh <host> 'docker logs <svc> --since 1h'`；
worker timer 用 `journalctl -u agent-gateway-<worker>`。

## 汇报（必打印）
> 输出通俗易懂纪律（§六）：先一句话总体结论（健康 / 有 N 个待办），再给下表；
> 不复述原始日志，不列没越过阈值的流水账。

| 主机 | 服务 | 发现 | 级别 | 建议动作 |
|---|---|---|---|---|
| lan | codex-api | （示例）ws_final_failure 7 次/24h，集中 admin 账号 | 观察 | 环比看趋势 |

级别：**事故**（用户可见失败在发生）/ **待办**（需修复但有兜底）/ **观察**（记录趋势）。
每个「事故/待办」给出样本 reqId + 涉及账号/用户，可直接开修。

## 边界
- 修复动作**不在本命令内**——发现问题后按正常流程（复现测试 red → 修 → green →
  `/syncx` 发布）另行处理；本命令只负责「看清楚」。
- 摘要统计逻辑的契约锁在 `agent-stack/test/fetch_logs_summary.test.sh` +
  `fetch_logs_requests_summary.test.sh`——改 summarize 脚本先跑这两个。
