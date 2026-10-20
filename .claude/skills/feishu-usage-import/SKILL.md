---
name: feishu-usage-import
description: 每月把飞书「产品研发中心 Token 用量统计」里的独立 Anthropic 订阅用量补录进 lan 数据库（供应商 anthropic）。触发：「把 X 月份的用量插入 lan」「飞书用量导入」「和往常一样补录用量」、贴出 feishu.cn/base/GB8wbaHyAa2QFdsULCvciofXnPb 链接并要求写库。只动 lan，不动 azure。
---

# 飞书月度 Anthropic 用量补录（lan）

团队成员用自己的 Anthropic 订阅产生的用量记在飞书多维表里，每月补录进 lan 库，让管理台用量 / 账单历史看到完整的量。
**只补记，不扣钱**：计费记录写入时就标「已结算」，任何人的余额、信用点都不动。

格式以 2026-08 / 2026-09 两次为准（7 月是早期做法：差额 + `recon202607_` 前缀 + 按 opus 价重算，已废弃，不要照抄）。

## 步骤

1. **读飞书**（Playwright，连用户已登录的浏览器，按全局 Playwright 规范开关标签页）
   - `browser_tabs list` → `browser_tabs new` 打开
     `https://uz4xxtwmgh.feishu.cn/base/GB8wbaHyAa2QFdsULCvciofXnPb?table=tblfUk9xYbZ3uuf9&view=vewQx1y7JR`
   - `browser_evaluate`：`function` 参数原样粘贴本目录 `extract.js` 整段，`filename` 设为 `.playwright/feishu-usage.json`
   - 关掉自己开的标签页 + `browser_close`
   - 表格是画布渲染，页面元素里读不到数据——必须用 extract.js 调接口，别去点格子。

2. **预演**（不写库）
   ```bash
   python3 .claude/skills/feishu-usage-import/import.py --input .playwright/feishu-usage.json --month 2026-10
   ```
   打印每人：飞书条数、推算请求数、总 token、lan 同月实测、飞书/lan 倍数、费用；以及「不补」名单和为 0 的列。

3. **给用户看预演表，确认后再写**（这是写生产库）。要特别指出：
   - 默认不补的人（见下）这个月是否照旧不补；
   - 飞书/lan 倍数 ≤ 约 1.2 的新面孔——可能是走我们系统的量，问一句补不补；
   - 有为 0 的列——7 月 operator 说过「不能有 0」，先让用户在飞书补数或明确说可以。

4. **写入**：同一命令加 `--apply`（按需 `--include 姓名` / `--exclude 姓名` / `--allow-zero`）。
   脚本自己做：先备份当月 `usage_daily` 到 lan `/root/pricing-backup/usage_daily-YYYYMM-before-import.sql` → 单事务写入 → 校验（条数、未结算数为 0、无 0 值行），并打印撤销语句。
   同月已导入过会拒绝重复写入。

5. **汇报**：一张表（姓名 / 请求数 / 总 tokens / 费用）+ 合计 + 不补名单及原因 + 备份路径。

## 写入格式（脚本已固化，供核对）

| 表 | 内容 |
|---|---|
| `usage_daily` | 每人一行，`provider_type='anthropic'`，`date_key` = 当月最后一天；四类 token = 飞书原值（同人多条合并，**不是**减 lan 的差额）；`request_count` = 总 token ÷ 此人上次补录行的每请求 token × 0.9–1.1 随机（没有就用他 lan 实测比例，再没有用 63,311） |
| `usage_events` | 每人一条：`request_id = manual-<mon><yyyy>-<邮箱前缀>`（如 `manual-oct2026-linqing.wang`），`key_hash = manual-backfill-YYYY-MM`，`model = manual-monthly-backfill`，token 全 0，`charge_micros` = 飞书「费用(元)」数值 × 1e6，`charged_at = NOW()`（预结算），`occurred_at` = 当月最后一天 23:59:59 |

## 取舍规则
- **默认不补**：徐新旺、徐伟淦、陈聪、陈超（2026-08 operator 定：他们飞书量 ≈ 或 < lan 实测，用量本来就走我们系统，不是独立订阅）。脚本的 `DEFAULT_EXCLUDE`。
- **名字对不上**：飞书「杨东奇」= lan「杨东齐」，「徐新望」= 「徐新旺」，「徐炜淦」= 「徐伟淦」。新的对不上的名字加进脚本 `ALIASES`。
- 供应商一律 `anthropic`；只写 lan，azure 不涉及。

## 历史
| 月份 | 人数 | 合计 |
|---|---|---|
| 2026-08 | 9 | — |
| 2026-09 | 7 | 18,044.47（2026-10-12 写入） |
