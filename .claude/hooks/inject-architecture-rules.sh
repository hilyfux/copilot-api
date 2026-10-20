#!/usr/bin/env bash
# inject-architecture-rules.sh — UserPromptSubmit hook
#
# Injects the INVIOLABLE iron-rule sections (一–六: 架构铁律 / 多系统交互准则 /
# 防需求漂移纪律 / 可复现测试纪律 / UI-UX 修改纪律 / 输出通俗易懂纪律) into every turn, extracted LIVE from
# ~/.claude/CLAUDE.md so the hook can never drift from the canonical source.
# (No hardcoded copy of the rules — 单一数据源; edit CLAUDE.md and every repo's
# hook picks it up on the next prompt.)
#
# Output contract: a single JSON object on stdout with
# hookSpecificOutput.additionalContext (a string). The harness appends that
# string to the model's turn context as a system reminder.
#
# Failure policy: never block the user. If CLAUDE.md is missing/unreadable or
# extraction comes up empty, fall back to a minimal static copy of the six
# architecture rules. Exit 0 unconditionally.

# Discard hook stdin (static injection; we don't read prompt content).
cat >/dev/null 2>&1 || true

SRC="$HOME/.claude/CLAUDE.md"
RULES=""
if [ -r "$SRC" ]; then
  # Sections 一 through 六 are the INVIOLABLE block (五 = UI/UX 修改纪律 2026-07-09;
  # 六 = 输出通俗易懂纪律 2026-07-15); 七 onwards is tooling policy.
  RULES=$(awk '/^## 一、/{f=1} /^## 七、/{f=0} f' "$SRC" 2>/dev/null)
fi

if [ -z "$RULES" ]; then
  RULES='## 架构铁律（INVIOLABLE — fallback：无法读取 ~/.claude/CLAUDE.md，以下为最小静态副本）

1. 极高内聚 — 一个模块只做一件事；同一职责的代码必须落在同一处。
2. 极低耦合 — 模块之间靠显式接口（port）联通，禁止隐式全局状态泄漏。
3. 极高稳定性 — 失败必有兜底；任何外部依赖故障不得致进程崩溃；重启零数据丢失。
4. 极高并发能力 — 不允许阻塞式 IO；不允许串行处理本可并发的请求；连接池 / async / 批操作是默认。
5. 极强鲁棒性 — 输入边界全部显式校验；异常路径与正常路径同等覆盖；不留"理论上不会发生"的空白。
6. 极强扩展能力 — 加新 provider / entity / store 后端时，只增量加文件；不允许改动既有模块的内部实现。
7. 极高可用 — 系统可用性目标 99.99%（月不可用预算 ≤ 4.4 分钟）：发布零停机 + 秒级回退，单点故障必有兜底，计划内变更不得引入用户可见不可用窗口。

UI/UX 修改纪律：任何 UI 和 UX 的修改必须使用 skill fronted_design 与 taste-skill 执行；未经这两个 skill 的 UI/UX 改动视同未评审。

输出通俗易懂纪律：面向用户的话通俗易懂、直给结论；能一句话讲明白的绝不长篇大论；不复述已知、不列不走的选项。

违反任意一条 = 不可接受。'
fi

HEADER='【铁律 · 每个 prompt 注入 · INVIOLABLE · 提方案/写代码/生成 spec 前必须逐条对齐】'

OUT=$(RULES="$RULES" HEADER="$HEADER" python3 - 2>/dev/null <<'PY'
import json, os
ctx = os.environ["HEADER"] + "\n\n" + os.environ["RULES"]
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": ctx,
    }
}, ensure_ascii=False))
PY
)

if [ -n "$OUT" ]; then
  printf '%s\n' "$OUT"
else
  # python3 unavailable — point at the source instead of injecting raw text.
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[iron-rules hook] python3 unavailable; read ~/.claude/CLAUDE.md sections 一–六 before any design/code change."}}\n'
fi
exit 0
