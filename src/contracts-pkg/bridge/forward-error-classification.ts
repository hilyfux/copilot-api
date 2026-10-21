/**
 * 负载转发的**错误归类**（2026-09-18）—— 跨仓单一数据源。
 *
 * 把一次**上游终局失败**归到三个互斥的桶里（`on_failure` 口径取并集），供所有实现了
 * 负载转发的代理共用。**这是本仓（agent-gateway）拥有的跨仓契约**：codex-api /
 * kiro-api 侧是**逐字镜像**（去掉文件头后应 sha256 相同，像 vendor-openai-translate.ts
 * 那样）；改一边必须同 commit 改另一边（铁律 §二.5）。
 *
 * ## 为什么要抽出来
 *
 * 抽之前，codex-api 与 kiro-api **各自**判同一件事，结果对不上：同一个
 * `usage_limit_reached`（HTTP 429，配额耗尽），codex 判「三类都不占 → 永不转发」，
 * kiro 判 `exhausted`。同一套配置在两台代理上得到相反答案 —— 正是铁律 §二.3
 * 「单一数据源」要防的漂移。
 *
 * ## 输入边界：只收**归一后的三要素**
 *
 * 各仓的终局错误形状并不一样（codex 是 `AnthropicDispatchResult` 联合体、kiro 是路由
 * 判别式 + 一个 `Response` 的状态码）。**各仓自己抽这三要素**，本模块不认识任何仓的
 * 错误对象 —— 加一个新代理只加调用方，不改本文件（铁律 §一.6 扩展性）。
 *
 * ## 判定顺序：先排除客户端错，再认定上游错
 *
 * 顺序反了就会把「配置 bug」当成「上游故障」转发出去，**静默换个模型把 bug 藏起来**。
 * 所以 `CLIENT_FAULT_RE` 是硬豁免，命中即三类全 false，无论 status 是什么。
 */

/** 归一后的上游终局失败三要素。调用方负责从自家错误形状里抽出来。 */
export type UpstreamFailure = {
  /** HTTP 状态码。**无状态码的形态**（网络错 / WS 协议错 / 超时）填 0 —— 不要填 500 蒙混。 */
  readonly status: number
  /** 上游错误类型串（如 `overloaded_error` / `invalid_request_error`）。没有就填 ''。 */
  readonly type: string
  /** 错误文案。**分类的主要依据**：多数上游故障只体现在这里。 */
  readonly message: string
}

/** 归类结果。三个桶互斥（`failed` 不与另两个同时为真）；`on_failure` 口径取三者并集。 */
export type FailureKind = {
  /** 过载：上游明说自己在过载。 */
  readonly overloaded: boolean
  /** 耗尽：配额 / 额度耗尽（含「池子里没有可用账号」这一形态 —— 那时 overloaded 与 exhausted **同时**为真）。 */
  readonly exhausted: boolean
  /** 故障：上游不可服务，但不是过载、也不是配额（连不上 / 连接断 / 5xx / 认证刷新失败 / 刷新后仍 401）。 */
  readonly failed: boolean
  /** 归类依据（观测/诊断用）：命中的规则名，或 `client_fault` / `none`。 */
  readonly reason: string
}

const NONE: FailureKind = { overloaded: false, exhausted: false, failed: false, reason: 'none' }

/**
 * **客户端错的硬豁免**（先排除）。命中即三类全 false：
 *  · `invalid_request` / `model not found` / `not supported` / `unsupported service_tier`
 *    —— 请求侧或配置侧的问题。转发了会**静默换个后端把真实原因盖掉**，且计费跑到 vendor 头上。
 *  · `client signal` / `AbortError` / `aborted` —— 客户端自己断了，**没人收答案**。
 *    （`aborted before send` 是线上第二大终局形态：lan 2450 次 —— 全是客户端取消。）
 * 保守取向：宁可漏转（维持现状），不可错转（掩盖真故障）。
 */
const CLIENT_FAULT_RE = /client signal|AbortError|aborted|invalid_request|model not found|not supported|unsupported service_tier/i

/** 过载文案（上游明说自己过载）。 */
const OVERLOADED_RE = /overloaded/i
/**
 * 池子级别的「没有可用账号」——既算过载也算耗尽（保留 codex 既有语义）。
 *
 * `^service temporarily unavailable$`（2026-09-26 azure 事故补）：这是 codex-api / kiro-api
 * **路由器自己**在「零候选」（全池隔离 / 空池）时给的 503 文案（codex `managed-router.ts`、
 * kiro `account-router.ts` 同一句）。它语义上就是「池子里没有可用账号」，所以显式归
 * pool_drained，而不是落进泛化的 `status ≥ 500 → upstream_5xx`：否则只配了 on_overload /
 * on_exhaustion 的规则会在「全池被隔离」这一最该转发的时刻静默失效（kiro 的适配器此前已把
 * 这句转写成 `no usable upstream account` 才进来，这里让两仓不靠转写也同判）。
 * **整句锚定**（^…$）：只认路由器原文，不吞上游 nginx 之类「503 Service Temporarily Unavailable」
 * 页面（那种会被包成 `upstream returned 503` 或更长的文案，仍走 5xx → failed）。
 */
const POOL_DRAINED_RE = /no healthy|no .*candidate|no usable upstream account|^service temporarily unavailable$/i
/** 耗尽文案：配额 / 额度 / 余额 / 池子烧完。 */
const EXHAUSTED_RE = /usage[_ ]limit|usage limit has been reached|insufficient_quota|quota|insufficient_balance|exhaust|no healthy|no .*candidate|no usable upstream account/i
/**
 * 上游坏了的签名（再认定）。文案取自 codex-api 线上 errors.jsonl 的全量聚合
 * （2026-09-18 实测）：`ws_connect_failed` / `Connection ended` / `token refresh failed`
 * 是量最大的三种；`ttfe_timeout`（上游超时无响应）此前**落在缝里**，本次补上。
 */
const UPSTREAM_BROKEN_RE = /connect_failed|Connection ended|Unable to connect|token refresh failed|ttfe_timeout|no upstream response|upgrade timeout|session not connected|Protocol error/i

/**
 * 归类（纯函数、零 IO、无依赖）。
 *
 * 判定顺序：
 *   0. 客户端错（`CLIENT_FAULT_RE` 或 `invalid_request_error`）→ 三类全 false
 *   1. 过载：status 529 / type `overloaded_error` / 文案含 overloaded / 池子烧完
 *   2. 耗尽：status 402/429 / 文案含配额类词 / 池子烧完（**不是过载的子集** —— 这是本次修复的核心）
 *   3. 故障：status ≥ 500 / 文案命中上游坏的签名 / status 401（刷新后仍被拒；且不是上面两类）
 *   4. 其余 → 全 false（保守：不认识就不转）
 */
export function classifyUpstreamFailure(f: UpstreamFailure): FailureKind {
  const status = Number.isFinite(f.status) ? f.status : 0
  const type = typeof f.type === 'string' ? f.type : ''
  const message = typeof f.message === 'string' ? f.message : ''

  // 0. 硬豁免 —— 先排除，避免下面的 status>=500 之类的规则把客户端错也吞进来。
  if (type === 'invalid_request_error' || CLIENT_FAULT_RE.test(message)) {
    return { overloaded: false, exhausted: false, failed: false, reason: 'client_fault' }
  }

  // 1. 过载
  const poolDrained = POOL_DRAINED_RE.test(message)
  if (status === 529 || type === 'overloaded_error' || OVERLOADED_RE.test(message) || poolDrained) {
    // 池子烧完（no healthy / no usable upstream account）**既算过载也算耗尽** —— 这是 codex 的既有
    // 语义（`exhausted = overloaded && /no healthy/`），镜像时不能把它降成只算过载，
    // 否则配了 `on_exhaustion` 的规则会在该场景下静默失效。
    return { overloaded: true, exhausted: poolDrained, failed: false, reason: poolDrained ? 'pool_drained' : 'overloaded' }
  }

  // 2. 耗尽（**独立判定**，不再要求「先过载」—— 配额耗尽的上游并不自称过载）
  // 402 = 上游明说「要付费/额度用尽」；429 = too many requests —— kiro 既有口径把它归「额度类」
  // （`isUsageLimitClassStatus`），codex 的真实 429 也全是 `usage_limit_reached`。两者都算耗尽。
  if (status === 402 || status === 429 || EXHAUSTED_RE.test(message)) {
    return { overloaded: false, exhausted: true, failed: false, reason: 'exhausted' }
  }

  // 3. 故障
  if (status >= 500 || UPSTREAM_BROKEN_RE.test(message)) {
    return { overloaded: false, exhausted: false, failed: true, reason: status >= 500 ? 'upstream_5xx' : 'upstream_broken' }
  }
  // 401 = 上游不认我们的账号凭证（2026-09-26 azure 事故：OpenAI 侧故障令 Pro 账号全体
  // `401 invalid_api_key`，刷新 token 成功后仍 401，全池被隔离，零转发）。到这里的 401 已是
  // **终局**：各代理在上游 401 时都先强制刷新 token 重试一次（codex `server/upstream.ts`
  // 的 reactive refresh、kiro `server/dispatch.ts` 的 didForceRefresh），仍 401 才落到这里 ——
  // 它不是客户端错（下游鉴权由代理自己的中间件在更早处拒掉，不会走到上游），是上游不可服务。
  // 只认 401：403（地区封锁 / 组织停用 / 挑战页）形态多且各有专门处置，今晚证据不涉及，不扩。
  if (status === 401) {
    return { overloaded: false, exhausted: false, failed: true, reason: 'upstream_auth' }
  }

  return NONE
}

/**
 * 归类 → 触发口径是否命中。`on_failure` 是**最宽**的口径（三者并集）。
 * 与 `ForwardingTrigger` 的三值一一对应，避免调用方各写一份并集逻辑。
 */
export function triggerMatches(trigger: 'on_overload' | 'on_exhaustion' | 'on_failure', kind: FailureKind): boolean {
  if (trigger === 'on_overload') return kind.overloaded
  if (trigger === 'on_exhaustion') return kind.exhausted
  return kind.overloaded || kind.exhausted || kind.failed
}

/**
 * 各触发口径**覆盖什么**（中文说明）—— 后台 UI 直接渲染这一份，**别在视图里另抄一份**。
 *
 * 放在共用件里是有意的：这些说明描述的就是上面那几个正则的语义。文案与判定规则
 * 一旦分家，界面会开始骗人（UI 说「故障也切」而判定器其实不认某个形态）。
 */
export const TRIGGER_COVERAGE: Record<'on_overload' | 'on_exhaustion' | 'on_failure', string> = {
  on_overload: '上游自称过载：overloaded_error / 状态码 529 / 池子里没有可用账号',
  on_exhaustion: '配额或额度用尽：状态码 402/429 / usage limit / 余额不足',
  on_failure: '最宽：过载 ∪ 耗尽 ∪ 上游故障（5xx / 连不上 / 连接中断 / 上游超时无响应 / 刷新 token 后上游仍回 401 拒绝认证）。**不含**客户端错（模型不存在、客户端主动断开）',
}
