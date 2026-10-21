/**
 * 套餐选择 — 订阅用户「这笔用量记到哪」的**唯一**判定处（mig 096 起，mig 099 扩三 lane）。
 *
 * 在此之前扣费去向是硬编码的 HYBRID（套餐优先、超量自动走余额），散落在
 * charge-worker 的 `subscriptionOverflow` 与 issue-gate 的两处 `balance > 0`
 * 分支里。三处各写一遍同一条规则 = 迟早分叉（2026-06-10 审计就吃过一次：
 * 发 Key 闸门与请求闸门给出相反答案）。本文件把规则收成几个纯函数，
 * 准入（gate / pin-lookup）与结算（charge-worker）各调一个，不再各自推导。
 *
 * ── 三条 lane（mig 099）─────────────────────────────────────────────────
 * 付费方式被抽象成三条并列的 lane，它们的差别只有两处：余量从哪来、有没有
 * 时间约束。除此之外一律同构 —— 都分别计数、都能各自配路由上游。
 *
 *   lane            列值           余量来源                  时间约束
 *   subscription    'plan'         套餐窗口（5h/7d/1d/30d）  有（窗口+周期+有效期）
 *   token_pack      'token_pack'   token_pack_balance        无（充多少用多少）
 *   balance         'balance'      balance_micros            无
 *
 * 「时间约束」是订阅独有的属性，不是三条 lane 的公共概念：token 包和余额
 * 充进去就一直在，不滚窗口、不到期、不需要周期锚点。把窗口判定塞进它们
 * 会凭空造出一个永远不会耗尽的空配额（等于免费用）——`laneHasTimeConstraint`
 * 存在就是为了让这件事在类型层面说得出口。
 *
 * ── 用户能选哪几档 ─────────────────────────────────────────────────────
 * 门户「套餐选择」卡片只暴露 `SWITCHABLE_LANES` 两档（订阅套餐 / token 套餐）。
 * 余额是第三条 lane，但**不是可选档**：它只在超量开关打开、当前档耗尽时被
 * 动用。列值 'balance' 仍然合法（历史行 + 管理员后台仍可设），所以判定函数
 * 三档全支持；少的只是用户那一侧的入口。
 *
 *   allowBalanceOverflow  当前档耗尽后是否准许继续花余额。
 *                         默认 false = Claude 的「额外用量」开关不开就停。
 *                         preference='balance' 时该位无意义（本就在花余额）。
 *
 * 适用 mode='subscription' 与 mode='pay_per_token'（2026-08-24 起：ppt 先经
 * `effectivePreference` 归一 —— 它没有套餐窗口 lane，windowExhausted 恒 false）。
 * credits_seat 只计 token 不碰钱，它的调用方不应走这里。
 *
 * 边界口径与既有政策保持一致：
 *  - 准入看 `balanceMicros > 0`（与 issue-gate / proxy billing-gate 同口径），
 *    不是 `>= 本次花费` —— 请求开始时还不知道会花多少。token 包同理看 `> 0`。
 *  - 结算侧的「拒绝」不代表退款：admit-then-meter 的漏网用量（nginx 30s
 *    auth 缓存窗口内已放行的请求）仍如实盖 charge_micros 审计，但**不扣余额**
 *    —— 开关没开就绝不动余额是本次需求的红线，宁可系统吸收这点量。
 */

/** 一条计费 lane —— 一种付费方式。三条并列，分别计数，各自可配上游。 */
export type BillingLane = 'subscription' | 'token_pack' | 'balance'

/**
 * `user_billing_state.charge_preference` 的列值。与 lane 一一对应。
 * 订阅那条沿用历史值 `'plan'`，纯粹是为了不迁移既有数据。
 */
export type ChargePreference = 'plan' | 'token_pack' | 'balance'

/** 门户「套餐选择」卡片暴露的档位。余额不在其中 —— 它靠超量开关被动用。 */
export const SWITCHABLE_LANES: readonly BillingLane[] = ['subscription', 'token_pack'] as const

const LANE_OF_PREFERENCE: Record<ChargePreference, BillingLane> = {
  plan: 'subscription',
  token_pack: 'token_pack',
  balance: 'balance',
}

const PREFERENCE_OF_LANE: Record<BillingLane, ChargePreference> = {
  subscription: 'plan',
  token_pack: 'token_pack',
  balance: 'balance',
}

export function laneOfPreference(preference: ChargePreference): BillingLane {
  return LANE_OF_PREFERENCE[preference]
}

export function preferenceOfLane(lane: BillingLane): ChargePreference {
  return PREFERENCE_OF_LANE[lane]
}

/**
 * 这条 lane 的余量有没有时间约束（滚动窗口 / 周期 / 有效期）。
 * 只有订阅套餐有。token 包与余额充进去就一直在，用完为止。
 */
export function laneHasTimeConstraint(lane: BillingLane): boolean {
  return lane === 'subscription'
}

export type ChargePreferenceState = {
  preference: ChargePreference
  allowBalanceOverflow: boolean
}

/** 三条 lane 各自的余量快照。判定函数只看这一个入参，不再自己查库。 */
export type LaneBalances = {
  /** 订阅：任一已配置窗口（5h/7d 金额 或 1d/30d token）已达配额。 */
  windowExhausted: boolean
  /** token 套餐：剩余 token 量。 */
  tokenPackBalance: number
  /** 余额：剩余 micros（赠送余额；按量模式透支后可为负）。 */
  balanceMicros: number
  /** 信用点按当前汇率折成的 USD 微元（`user_billing_state.credit_equivalent_micros`，派生缓存）。
   *  缺省 0 = 折算关闭 → 全部判定与支付上线前逐字相同（spec §8.2 / D-GATE）。
   *  这是"用户买的钱"：不受超量开关约束（D4）；赠送余额受。 */
  creditEquivalentMicros?: number
}

/** 可花的钱 = 赠送余额 + 已折算的储值。 */
function spendable(b: LaneBalances): number {
  return b.balanceMicros + (b.creditEquivalentMicros ?? 0)
}

/** 结算去向。'none' = 记账但不动任何余额/额度（开关未开的漏网用量）。
 *  'credits_only' = 超量开关关着、但用户有买来的储值（D4）：只从信用点扣，赠送余额一分不动。 */
export type SettlementTarget = 'plan_window' | 'token_pack' | 'balance' | 'credits_only' | 'none'

/** 当前档自己的余量还够不够。余额档恒 true —— 它自己就是兜底，没有"下一档"。 */
function laneHasRoom(state: ChargePreferenceState, balances: LaneBalances): boolean {
  switch (state.preference) {
    case 'plan': return !balances.windowExhausted
    case 'token_pack': return balances.tokenPackBalance > 0
    case 'balance': return spendable(balances) > 0
  }
}

/**
 * 结算路由（charge-worker 用）：这笔已发生的订阅用量记到哪。
 *
 * 三档同构：当前档还有量就记当前档；耗尽后由超量开关决定落余额还是就此打住。
 * 余额档没有"耗尽后"这一说 —— 它本身就是那个兜底，扣到 0 由准入侧挡。
 */
export function routeSettlement(
  state: ChargePreferenceState,
  balances: LaneBalances,
): SettlementTarget {
  // 强制走余额：套餐窗口与 token 包都冻结，计数器一概不累加。
  if (state.preference === 'balance') return 'balance'
  if (laneHasRoom(state, balances)) {
    return state.preference === 'token_pack' ? 'token_pack' : 'plan_window'
  }
  // 当前档耗尽：开关决定继续花赠送余额；买来的储值不受开关约束（D4）。
  if (state.allowBalanceOverflow) return 'balance'
  return (balances.creditEquivalentMicros ?? 0) > 0 ? 'credits_only' : 'none'
}

/**
 * 准入判定（issue-gate / pin-lookup 用）：当前状态还能不能服务。
 *
 * 返回 false 的成因由 `blockReason` 区分，便于给出不同文案与日志。
 */
export function canServeUnderPreference(
  state: ChargePreferenceState,
  balances: LaneBalances,
): boolean {
  return blockReason(state, balances) === null
}

/**
 * 被拒原因。`null` = 可服务。**决策表 D-GATE**（spec §8.2，八行穷举，T9 逐行锁；三个代理 billing-gate 逐字镜像）：
 *
 *   # 档有余量 偏好            超量开关 折算值>0 可花>0 → 结果
 *   1 是       任意            任意     任意     任意  → 放行
 *   2 否       balance         —        —        是    → 放行
 *   3 否       balance         —        —        否    → insufficient_balance
 *   4 否       plan/token_pack 关       是       —     → 放行（买的钱可超量，D4）
 *   5 否       plan/token_pack 关       否       是    → <lane>_exhausted_overflow_off（送的钱不能超量）
 *   6 否       plan/token_pack 关       否       否    → <lane>_exhausted_overflow_off
 *   7 否       plan/token_pack 开       任意     是    → 放行
 *   8 否       plan/token_pack 开       任意     否    → insufficient_balance
 *
 * 可花 = balanceMicros + creditEquivalentMicros。没有一行读汇率或信用点本身。
 *  - 'plan_exhausted_overflow_off'       套餐窗口耗尽且未开启额外用量 → 与余额无关
 *  - 'token_pack_exhausted_overflow_off' token 包用光且未开启额外用量 → 文案指向充值 token 包
 *  - 'insufficient_balance'              需要花余额但余额 ≤ 0
 */
export type BlockReason =
  | 'plan_exhausted_overflow_off'
  | 'token_pack_exhausted_overflow_off'
  | 'insufficient_balance'

export function blockReason(
  state: ChargePreferenceState,
  balances: LaneBalances,
): BlockReason | null {
  if (laneHasRoom(state, balances)) return null                                   // 1 / 2
  if (state.preference === 'balance') return 'insufficient_balance'               // 3
  if (!state.allowBalanceOverflow) {
    if ((balances.creditEquivalentMicros ?? 0) > 0) return null                    // 4
    return state.preference === 'token_pack'                                       // 5 / 6
      ? 'token_pack_exhausted_overflow_off'
      : 'plan_exhausted_overflow_off'
  }
  return spendable(balances) > 0 ? null : 'insufficient_balance'                  // 7 / 8
}

/**
 * 归一（2026-08-24，ppt 纳入套餐选择）：ppt 没有「套餐窗口」这条 lane，
 * 它的列默认 `'plan'` 在历史上就意味着「扣余额」（charge-worker 的 ppt 分支
 * 无条件 debitBalance）。把这个事实收成一个纯函数：
 *
 *   mode='pay_per_token' 且 preference='plan' → 'balance'（逐字节等价于今天）
 *   其余一律原样。
 *
 * 结算（charge-worker）、两个 gate（issue-gate / charge-preference-gate）、
 * 三处 surface（admin 卡 / portal 卡 / api）全部先过这一步再判定，
 * 禁止各写各的归一 —— 那就是 2026-06-10「两处给出相反答案」的事故形状。
 */
export function effectivePreference(mode: string, preference: ChargePreference): ChargePreference {
  if (mode === 'pay_per_token' && preference === 'plan') return 'balance'
  return preference
}

/**
 * 用户此刻可**主动选**的档（不含逃生方向，见 `showChargePreferenceSurface`）。
 *
 *   subscription   [hasPlan?'plan', 包>0?'token_pack']  余额仍不可选（沿旧设计：
 *                  靠「超量后使用余额」开关被动进入 —— 主动选花钱 ≠ 授权兜底花钱）
 *   pay_per_token  包>0 ? ['token_pack','balance'] : []  余额是 ppt 的一等可选项
 *                  （它本就是 ppt 用户一直在跑的默认档，只是显名）
 *   credits_seat   []（money-free 契约不变）
 *
 * 三处 surface 的放行集一律 = 本函数 ∪ 逃生方向（ppt 切回 balance 永远放行），
 * 禁止各自硬编码取值白名单。
 */
export function selectablePreferences(
  mode: string,
  opts: { hasPlan: boolean; tokenPackBalance: number },
): ChargePreference[] {
  if (mode === 'subscription') {
    return [
      ...(opts.hasPlan ? (['plan'] as const) : []),
      ...(opts.tokenPackBalance > 0 ? (['token_pack'] as const) : []),
    ]
  }
  if (mode === 'pay_per_token') {
    return opts.tokenPackBalance > 0 ? ['token_pack', 'balance'] : []
  }
  return []
}

/**
 * 「套餐选择」surface（admin 卡 / portal 卡 / api switchable）该不该开门。
 *
 *   subscription 恒开（现状不变）。
 *   ppt：包 > 0 开；或者已站在 token_pack 档上也开 —— **逃生不对称**：
 *   包耗尽后卡不能消失，否则用户被锁死在一个永远拒绝的档上，
 *   切**回** balance 的入口必须常在（与 api-charge-preference 既有原则同源）。
 */
export function showChargePreferenceSurface(
  mode: string,
  opts: { preference: ChargePreference; tokenPackBalance: number },
): boolean {
  if (mode === 'subscription') return true
  if (mode !== 'pay_per_token') return false
  return opts.tokenPackBalance > 0 || effectivePreference(mode, opts.preference) === 'token_pack'
}

/** 行 → 状态。列缺失（迁移未落 / 老行）或未知值一律回落默认档，热路径不得抛。 */
export function readChargePreference(row: {
  charge_preference?: string | null
  allow_balance_overflow?: number | boolean | null
}): ChargePreferenceState {
  const raw = row.charge_preference
  const preference: ChargePreference =
    raw === 'balance' || raw === 'token_pack' ? raw : 'plan'
  return {
    preference,
    allowBalanceOverflow: row.allow_balance_overflow === 1 || row.allow_balance_overflow === true,
  }
}
