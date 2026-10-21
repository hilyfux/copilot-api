/**
 * 决策表 D-GATE（spec §8.2）数据化 —— 契约包（P4，2026-10-16）。
 *
 * 之前这张八行表只活在注释里：网关 charge-preference.ts 的 blockReason 上方一份，三个代理
 * billing-gate 的注释各一份，没有可执行形态，四处是否真的一致只能靠人读。现在：
 *   - `D_GATE_TABLE` = 表本身（数据）；
 *   - `dGateBlockReason` = 按表求值；网关测试锁它在全部输入组合上 ≡ charge-preference.blockReason；
 *   - `vectors/d-gate.json` = 跨仓向量，各仓用自己的 billing-gate 跑同一组。
 * 请求路径仍调 charge-preference.blockReason（本文件不进热路径）；这里是规格与对照。
 *
 * 「档有余量」与「可花」的口径与 charge-preference.ts 相同（那边是私有函数，这里按同一定义写一遍，
 * 由全组合测试保证不分叉）：plan → !windowExhausted；token_pack → tokenPackBalance > 0；
 * balance → 可花 > 0。可花 = balanceMicros + creditEquivalentMicros（缺省 0）。
 * 因此余额档的「档有余量」就是「可花 > 0」—— 第 2 行被第 1 行先命中、实际不可达，保留是为了与
 * spec 原表逐行对得上。改这张表 = 改准入语义：契约包升 CONTRACT_VERSION，四仓 billing-gate 同步。
 */
import type { BlockReason, ChargePreference, ChargePreferenceState, LaneBalances } from './charge-preference.ts'

/** 一行的判定结果。`lane_exhausted_overflow_off` 按档位落成 plan_… / token_pack_… 两个具体原因。 */
export type DGateOutcome = 'serve' | 'insufficient_balance' | 'lane_exhausted_overflow_off'

/** 条件列：具体布尔值，或 `'any'`（表里的「任意」与「—」）。 */
export type DGateCond = boolean | 'any'

export type DGateRow = {
  readonly row: number
  readonly laneHasRoom: DGateCond
  readonly preference: 'any' | 'balance' | 'plan_or_token_pack'
  readonly overflow: DGateCond
  readonly creditPositive: DGateCond
  readonly spendablePositive: DGateCond
  readonly outcome: DGateOutcome
}

/**
 *   # 档有余量 偏好            超量开关 折算值>0 可花>0 → 结果
 *   1 是       任意            任意     任意     任意  → 放行
 *   2 否       balance         —        —        是    → 放行
 *   3 否       balance         —        —        否    → insufficient_balance
 *   4 否       plan/token_pack 关       是       —     → 放行（买的钱可超量，D4）
 *   5 否       plan/token_pack 关       否       是    → <lane>_exhausted_overflow_off
 *   6 否       plan/token_pack 关       否       否    → <lane>_exhausted_overflow_off
 *   7 否       plan/token_pack 开       任意     是    → 放行
 *   8 否       plan/token_pack 开       任意     否    → insufficient_balance
 */
export const D_GATE_TABLE: readonly DGateRow[] = [
  { row: 1, laneHasRoom: true,  preference: 'any',                overflow: 'any', creditPositive: 'any', spendablePositive: 'any', outcome: 'serve' },
  { row: 2, laneHasRoom: false, preference: 'balance',            overflow: 'any', creditPositive: 'any', spendablePositive: true,  outcome: 'serve' },
  { row: 3, laneHasRoom: false, preference: 'balance',            overflow: 'any', creditPositive: 'any', spendablePositive: false, outcome: 'insufficient_balance' },
  { row: 4, laneHasRoom: false, preference: 'plan_or_token_pack', overflow: false, creditPositive: true,  spendablePositive: 'any', outcome: 'serve' },
  { row: 5, laneHasRoom: false, preference: 'plan_or_token_pack', overflow: false, creditPositive: false, spendablePositive: true,  outcome: 'lane_exhausted_overflow_off' },
  { row: 6, laneHasRoom: false, preference: 'plan_or_token_pack', overflow: false, creditPositive: false, spendablePositive: false, outcome: 'lane_exhausted_overflow_off' },
  { row: 7, laneHasRoom: false, preference: 'plan_or_token_pack', overflow: true,  creditPositive: 'any', spendablePositive: true,  outcome: 'serve' },
  { row: 8, laneHasRoom: false, preference: 'plan_or_token_pack', overflow: true,  creditPositive: 'any', spendablePositive: false, outcome: 'insufficient_balance' },
]

/** 表的输入：由状态 + 余量快照算出的五个事实。 */
export type DGateFacts = {
  readonly laneHasRoom: boolean
  readonly preference: ChargePreference
  readonly overflow: boolean
  readonly creditPositive: boolean
  readonly spendablePositive: boolean
}

export function dGateFacts(state: ChargePreferenceState, balances: LaneBalances): DGateFacts {
  const credit = balances.creditEquivalentMicros ?? 0
  const spendablePositive = balances.balanceMicros + credit > 0
  const laneHasRoom =
    state.preference === 'plan' ? !balances.windowExhausted
      : state.preference === 'token_pack' ? balances.tokenPackBalance > 0
        : spendablePositive
  return {
    laneHasRoom,
    preference: state.preference,
    overflow: state.allowBalanceOverflow,
    creditPositive: credit > 0,
    spendablePositive,
  }
}

function condHolds(cond: DGateCond, value: boolean): boolean {
  return cond === 'any' || cond === value
}

/** 第一个命中的行；表不完备时返回 null（测试保证不会发生）。 */
export function matchDGateRow(f: DGateFacts): DGateRow | null {
  for (const r of D_GATE_TABLE) {
    const prefOk = r.preference === 'any'
      || (r.preference === 'balance' ? f.preference === 'balance' : f.preference !== 'balance')
    if (prefOk
      && condHolds(r.laneHasRoom, f.laneHasRoom)
      && condHolds(r.overflow, f.overflow)
      && condHolds(r.creditPositive, f.creditPositive)
      && condHolds(r.spendablePositive, f.spendablePositive)) return r
  }
  return null
}

/** 按表求值，返回值与 charge-preference.blockReason 同形（null = 放行）。 */
export function dGateBlockReason(state: ChargePreferenceState, balances: LaneBalances): BlockReason | null {
  const f = dGateFacts(state, balances)
  const r = matchDGateRow(f)
  if (!r || r.outcome === 'serve') return null
  if (r.outcome === 'insufficient_balance') return 'insufficient_balance'
  return f.preference === 'token_pack' ? 'token_pack_exhausted_overflow_off' : 'plan_exhausted_overflow_off'
}
