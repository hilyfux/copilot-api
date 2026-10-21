/**
 * 上游**配额快照契约**（2026-09-26）—— 跨仓单一数据源。
 *
 * 权威定义在本仓（agent-gateway）`src/bridge/quota-snapshot-contract.ts`。
 * codex-api / kiro-api / byok-api 各放一份**逐字镜像**（MIRRORED VERBATIM）：
 *
 *  · 镜像只允许**改文件头**（本注释块，第 1 行到第一个恰为 ` *\/` 的行）——头里写
 *    「xxx-api 侧镜像，MIRRORED VERBATIM from agent-gateway …」即可；**头部以下逐字相同**。
 *  · 校验：`sed '1,/^ \*\/$/d' <file> | shasum -a 256` —— 四个仓得到同一个值。
 *    本仓 `tests/quota-snapshot-contract.test.ts` 钉住了这个值；改正文 = 同一窗口改四个仓
 *    + 更新钉住值（铁律 §二.1/§二.5）。
 *  · 正文**零 import、零 IO、纯函数**：拷过去不依赖任何仓的模块。
 *
 * ## 为什么要有它（2026-09-26 配额审计）
 *
 * 同一类 bug 在四个仓各长一遍：① 429 被记成「5h 窗口 100%」而真正耗尽的是周窗口；
 * ② 旧数据被 JSON_MERGE_PATCH 合进来却盖上新的 observed_at（azure hilyfux-d：09-24 的
 * 数据挂着 09-26 的时间戳）；③ 冷却无视真实重置时刻（周封顶每 ≤6h 用真实用户请求去探）；
 * ④ 后台把「代理重试时刻」读成「额度重置时刻」、限速与额度耗尽不分。
 *
 * ## 契约要点
 *
 *  1. **快照 = 权威来源给出的完整窗口集合**，整体替换；每个窗口带自己的 capturedAt。
 *  2. **局部观测**（429 / 限速）不改窗口数字、不刷 observed_at，只记一个 cappedEvent
 *     （自带 resetAt 与 occurredAt）——`mergeObservation` 返回 `bumpObservedAt:false`。
 *  3. 封顶后冷却到耗尽窗口/事件里**最晚的** resetAt；只有不知道 reset 才走默认阶梯；
 *     冷却**只延长不缩短**，除非来了一份「封顶之后采集的、完整的、未封顶」快照。
 *  4. 唯一的 `isCapped`：路由、选号、展示、告警、「家族还有活账号」全用它。
 *  5. 限速（throttle）与额度耗尽（quota）是两种状态：**限速永不算封顶**。
 *
 * ## 存储形状（`provider_accounts.ratelimit_headers`，见 docs/data-contract.md）
 *
 * v2 = 本文件 `QuotaSnapshot` 的 JSON（camelCase，`version: 2`）。读方一律经
 * `parseQuotaSnapshot`，它同时认 v2 与所有存量旧形状（codex `codex.rate_limits` 帧 /
 * 内层对象 / 429 片段、chatgpt `/wham/usage` 响应体、kiro 与 byok 徽章、anthropic
 * unified 头）。先扩展后收缩：旧形状要等所有写方都改写 v2 之后才可移除。
 *
 * 时间一律 **epoch 秒**（整数）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 一个配额窗口。 */
export type QuotaWindow = {
  /** 窗口标识：codex `primary` / `secondary`（注意 pro 套餐的 primary 就是周窗口，别按 id 猜长度）、
   *  kiro `monthly`、anthropic `5h` / `7d` …；按模型的附加窗口为 `<model>/<id>`。 */
  id: string
  /** 窗口长度（秒）；上游没给就是 null —— **不要猜**。 */
  windowSeconds: number | null
  /** 已用百分比 0..100（可 >100）；上游没给就是 null。 */
  usedPercent: number | null
  /** 该窗口已封顶（usedPercent ≥ 100 或上游明说）。 */
  capped: boolean
  /** 该窗口重置时刻（epoch 秒）；未知为 null。 */
  resetAt: number | null
  /** 该窗口数字的**真实采集时刻**（epoch 秒）；0 = 未知（按最陈旧处理）。 */
  capturedAt: number
  /** 仅按模型计的附加窗口才有（如 codex `GPT-5.3-Codex-Spark`、anthropic `7d_sonnet`）。
   *  **不参与账号级封顶判定**：某个模型窗口用尽不代表整个账号不可用。 */
  model?: string
}

/** 局部观测留下的「封顶事件」（429 / 402 / 限速），不改窗口数字。 */
export type QuotaCappedEvent = {
  /** `quota` = 额度耗尽（要等重置）；`throttle` = 短时限速（**永不算封顶**）。 */
  kind: 'quota' | 'throttle'
  /** 上游暗示的是哪个窗口（`monthly` / `5h` / `secondary`…）；不知道就是 null —— 不要假装是 5h。 */
  windowHint: string | null
  /** 事件自带的重置时刻（epoch 秒）；未知为 null。 */
  resetAt: number | null
  /** 事件发生时刻（epoch 秒）。 */
  occurredAt: number
  /** 厂商原文重置时间（无时区，byok 旧写法）；仅展示用，判定只看 resetAt。 */
  resetAtRaw?: string
}

/** 一个账号的配额快照。 */
export type QuotaSnapshot = {
  version: 2
  /** 来源：`codex.rate_limits` / `codex.wham_usage` / `codex.usage_limit` / `kiro` / `byok` /
   *  `anthropic.unified` / 写方自报。 */
  source: string
  planType: string | null
  /** 快照信息的采集时刻（epoch 秒）：有窗口时 = 最旧窗口的 capturedAt；只有事件时 = 事件时刻。 */
  capturedAt: number
  /** true = windows 是权威来源给出的**完整**窗口集合（可整体替换、可据以解除冷却）；
   *  false = 只有局部观测（窗口集合不可信/缺失）。 */
  complete: boolean
  windows: QuotaWindow[]
  cappedEvent: QuotaCappedEvent | null
}

/** 解析选项。 */
export type ParseQuotaOptions = {
  /** 行的 `ratelimit_observed_at`（epoch 秒）。只作**兜底**：旧帧能从 reset_at − reset_after_seconds
   *  推出真实采集时刻时，不用它。 */
  observedAtSec?: number | null
  /** byok 厂商的 UTC 偏移（分钟，东八区 = 480）。给了才把无时区的 `reset_at_raw` 转成 epoch；
   *  不给就不猜（resetAt=null，原文留在 resetAtRaw）。 */
  vendorUtcOffsetMinutes?: number | null
}

export type CappedOptions = {
  /** 覆盖 `UNKNOWN_RESET_HORIZON_SEC`。 */
  unknownResetHorizonSec?: number
}

export type ExhaustedWindow = {
  id: string
  windowSeconds: number | null
  resetAt: number | null
  source: 'window' | 'event'
}

export type QuotaStaleness = {
  /** 任一窗口陈旧（无窗口时看快照 capturedAt）。 */
  stale: boolean
  oldestCapturedAt: number
  windows: { id: string; capturedAt: number; ageSec: number; stale: boolean }[]
}

export type CooldownInput = {
  snapshot: QuotaSnapshot | null
  /** 现有冷却截止（epoch 秒）；null = 无。 */
  existingUntil: number | null
  nowSec: number
  /** 不知道 reset 时的默认冷却长度（秒），即调用方阶梯的当前档。 */
  defaultLadderSec: number
  /** 本次封顶开始时刻（epoch 秒）。给了：只有**晚于它**采集的完整未封顶快照才能解除冷却；
   *  没给：只有 `LIFT_FRESHNESS_SEC` 内采集的完整未封顶快照才能解除。 */
  cappedAtSec?: number | null
}

export type MergeResult = {
  snapshot: QuotaSnapshot
  /** 写方是否应刷新 `ratelimit_observed_at`。局部观测一律 false（缺陷②/C7 的根因就是刷了它）。 */
  bumpObservedAt: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

export const QUOTA_SNAPSHOT_VERSION = 2 as const

/**
 * 「已封顶但不知道何时重置」时，从最后一次观测起**按封顶处理 24 小时**。
 *
 * 取 24h 的理由：短于它（旧的 1h..6h 阶梯）会让周/月封顶的账号被真实用户请求反复试探；
 * 长于它会让一次误判的 429 把账号关太久。24h 也正是审计里「>24h 转后台零成本重查」的分界。
 * 每次新的拒绝都会刷新 occurredAt，所以真封顶的账号会一直被续上；真正的 reset 一旦知道
 * （/wham/usage、kiro 用量接口），就用 reset，不再用这个视野。
 */
export const UNKNOWN_RESET_HORIZON_SEC = 24 * 3600

/** 未给封顶时刻时，能解除冷却的完整快照最多多旧（秒）。 */
export const LIFT_FRESHNESS_SEC = 300

/** 推出的 capturedAt 允许比行的 observed_at 晚多少（时钟偏差容忍，秒）。 */
const CAPTURE_SKEW_SEC = 300
/** reset_after_seconds 允许超过窗口长度多少（秒）。 */
const RESET_AFTER_SLACK_SEC = 60
/** 大于它的时间戳视为毫秒。 */
const MS_THRESHOLD = 1e12
const ANTHROPIC_PREFIX = 'anthropic-ratelimit-unified-'

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具（全部防御性，永不抛）
// ─────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 有限数（接受数字字符串）；否则 null。 */
function finite(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function nonNeg(v: unknown): number | null {
  const n = finite(v)
  return n != null && n >= 0 ? n : null
}

function positive(v: unknown): number | null {
  const n = finite(v)
  return n != null && n > 0 ? n : null
}

/** epoch 秒（>0，毫秒自动归一，取整）；否则 null。 */
function epochSec(v: unknown): number | null {
  const n = positive(v)
  if (n == null) return null
  return Math.floor(n > MS_THRESHOLD ? n / 1000 : n)
}

/** ISO 字符串 → epoch 秒；否则 null。 */
function isoSec(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function toObj(raw: unknown): Obj | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return isObj(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isObj(raw) ? raw : null
}

function observedFrom(opts: ParseQuotaOptions | undefined): number | null {
  return epochSec(opts?.observedAtSec)
}

function horizonOf(opts: CappedOptions | undefined): number {
  const h = nonNeg(opts?.unknownResetHorizonSec)
  return h ?? UNKNOWN_RESET_HORIZON_SEC
}

function minCaptured(windows: readonly QuotaWindow[], fallback: number): number {
  if (windows.length === 0) return fallback
  let min = windows[0]!.capturedAt
  for (const w of windows) if (w.capturedAt < min) min = w.capturedAt
  return min
}

function isAccountWide(w: QuotaWindow): boolean {
  return w.model === undefined
}

function windowExhausted(w: QuotaWindow): boolean {
  return w.capped || (w.usedPercent != null && w.usedPercent >= 100)
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 `ratelimit_headers` 的任何已知形状解析成 v2 快照。**永不抛**；认不出返回 null。
 * 接受对象或 JSON 字符串。
 */
export function parseQuotaSnapshot(raw: unknown, opts?: ParseQuotaOptions): QuotaSnapshot | null {
  try {
    const o = toObj(raw)
    if (!o) return null
    if (o['version'] === QUOTA_SNAPSHOT_VERSION && Array.isArray(o['windows'])) return parseV2(o, opts)
    if (Object.keys(o).some((k) => k.toLowerCase().startsWith(ANTHROPIC_PREFIX))) return parseAnthropic(o, opts)
    if (isObj(o['rate_limit']) && (isObj(o['rate_limit']['primary_window']) || isObj(o['rate_limit']['secondary_window']))) {
      return parseWham(o, opts)
    }
    if (o['provider'] === 'kiro' || o['provider'] === 'byok') return parseBadge(o, opts)
    return parseCodexFrame(o, opts)
  } catch {
    return null
  }
}

function parseV2(o: Obj, opts: ParseQuotaOptions | undefined): QuotaSnapshot {
  const capturedAt = epochSec(o['capturedAt']) ?? observedFrom(opts) ?? 0
  const windows: QuotaWindow[] = []
  for (const w of o['windows'] as unknown[]) {
    if (!isObj(w)) continue
    const id = str(w['id'])
    if (id == null) continue
    const win: QuotaWindow = {
      id,
      windowSeconds: positive(w['windowSeconds']),
      usedPercent: nonNeg(w['usedPercent']),
      capped: w['capped'] === true,
      resetAt: epochSec(w['resetAt']),
      capturedAt: epochSec(w['capturedAt']) ?? capturedAt,
    }
    const model = str(w['model'])
    if (model != null) win.model = model
    windows.push(win)
  }
  return {
    version: 2,
    source: str(o['source']) ?? 'unknown',
    planType: str(o['planType']),
    capturedAt,
    complete: o['complete'] === true,
    windows,
    cappedEvent: parseV2Event(o['cappedEvent'], capturedAt),
  }
}

function parseV2Event(v: unknown, fallbackAt: number): QuotaCappedEvent | null {
  if (!isObj(v)) return null
  const kind = v['kind']
  if (kind !== 'quota' && kind !== 'throttle') return null
  const ev: QuotaCappedEvent = {
    kind,
    windowHint: str(v['windowHint']),
    resetAt: epochSec(v['resetAt']),
    occurredAt: epochSec(v['occurredAt']) ?? fallbackAt,
  }
  const rawReset = str(v['resetAtRaw'])
  if (rawReset != null) ev.resetAtRaw = rawReset
  return ev
}

/**
 * codex 旧帧里的一个窗口（WS `primary`/`secondary` 用 window_minutes；/wham/usage 用
 * limit_window_seconds）。capturedAt = reset_at − reset_after_seconds（**这就是识破「旧数据
 * 新时间戳」的方法**），推导不可信时回落到行的 observed_at，再不行就是 0（最陈旧）。
 */
function codexWindow(w: Obj, id: string, observedAt: number | null, model: string | null): QuotaWindow {
  const minutes = positive(w['window_minutes'])
  const windowSeconds = minutes != null ? Math.round(minutes * 60) : positive(w['limit_window_seconds'])
  const usedPercent = nonNeg(w['used_percent'])
  const resetAt = epochSec(w['reset_at'])
  const resetAfter = nonNeg(w['reset_after_seconds'])
  let capturedAt: number | null = null
  if (resetAt != null && resetAfter != null) {
    const derived = Math.floor(resetAt - resetAfter)
    const fitsWindow = windowSeconds == null || resetAfter <= windowSeconds + RESET_AFTER_SLACK_SEC
    const notFuture = observedAt == null || derived <= observedAt + CAPTURE_SKEW_SEC
    if (derived > 0 && fitsWindow && notFuture) capturedAt = derived
  }
  const win: QuotaWindow = {
    id,
    windowSeconds,
    usedPercent,
    capped: (usedPercent != null && usedPercent >= 100) || w['limit_reached'] === true,
    resetAt,
    capturedAt: capturedAt ?? observedAt ?? 0,
  }
  if (model != null) win.model = model
  return win
}

/** 账号级 limit_reached / allowed:false 却没有任何耗尽窗口可解释 → 未知 reset 的 quota 事件。 */
function unexplainedCap(flagged: boolean, windows: readonly QuotaWindow[], at: number): QuotaCappedEvent | null {
  if (!flagged) return null
  if (windows.some((w) => isAccountWide(w) && windowExhausted(w))) return null
  return { kind: 'quota', windowHint: null, resetAt: null, occurredAt: at }
}

/** additional_rate_limits：WS 帧是 `{ <model>: { primary, secondary } }`；wham 可能是数组。 */
function additionalWindows(v: unknown, observedAt: number | null): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const push = (model: string, bucket: unknown): void => {
    if (!isObj(bucket)) return
    const inner = isObj(bucket['rate_limit']) ? bucket['rate_limit'] : bucket
    for (const [key, id] of [['primary', 'primary'], ['secondary', 'secondary'], ['primary_window', 'primary'], ['secondary_window', 'secondary']] as const) {
      const w = inner[key]
      if (isObj(w)) out.push(codexWindow(w, `${model}/${id}`, observedAt, model))
    }
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!isObj(item)) continue
      const model = str(item['limit_name']) ?? str(item['metered_feature']) ?? str(item['model'])
      if (model != null) push(model, item)
    }
  } else if (isObj(v)) {
    for (const [model, bucket] of Object.entries(v)) if (model !== '') push(model, bucket)
  }
  return out
}

function parseCodexFrame(o: Obj, opts: ParseQuotaOptions | undefined): QuotaSnapshot | null {
  const observedAt = observedFrom(opts)
  const envelope = isObj(o['rate_limits']) ? o['rate_limits'] : null
  const bucket = envelope && (isObj(envelope['primary']) || isObj(envelope['secondary']))
    ? envelope
    : (isObj(o['primary']) || isObj(o['secondary']) ? o : null)
  const planType = str(o['plan_type'])
  const flagged = envelope?.['limit_reached'] === true || o['limit_reached'] === true || envelope?.['allowed'] === false

  if (!bucket) {
    // 只有账号级标志、没有窗口的帧：记为事件（仍是局部观测）
    if (o['type'] === 'codex.rate_limits' && flagged) {
      const at = observedAt ?? 0
      return { version: 2, source: 'codex.rate_limits', planType, capturedAt: at, complete: false, windows: [], cappedEvent: unexplainedCap(true, [], at) }
    }
    return null
  }

  const rawWindows = (['primary', 'secondary'] as const)
    .map((id) => [id, bucket[id]] as const)
    .filter((pair): pair is readonly ['primary' | 'secondary', Obj] => isObj(pair[1]))

  // 429 片段（codex usageLimitSnapshot 旧写法）：无信封、窗口既无长度也无 reset_after —— 它**不是**
  // 窗口读数，只是「被拒了、何时恢复」。不假装是 primary/5h：记为局部 quota 事件。
  const isFragment = o['type'] === undefined && rawWindows.every(([, w]) =>
    w['window_minutes'] === undefined && w['limit_window_seconds'] === undefined && w['reset_after_seconds'] === undefined)
  if (isFragment) {
    let resetAt: number | null = null
    for (const [, w] of rawWindows) {
      const r = epochSec(w['reset_at'])
      if (r != null && (resetAt == null || r > resetAt)) resetAt = r
    }
    const at = observedAt ?? 0
    return {
      version: 2,
      source: 'codex.usage_limit',
      planType,
      capturedAt: at,
      complete: false,
      windows: [],
      cappedEvent: { kind: 'quota', windowHint: null, resetAt, occurredAt: at },
    }
  }

  const windows = rawWindows.map(([id, w]) => codexWindow(w, id, observedAt, null))
  windows.push(...additionalWindows(o['additional_rate_limits'] ?? envelope?.['additional_rate_limits'], observedAt))
  const capturedAt = minCaptured(windows, observedAt ?? 0)
  return {
    version: 2,
    source: 'codex.rate_limits',
    planType,
    capturedAt,
    complete: true,
    windows,
    cappedEvent: unexplainedCap(flagged, windows, capturedAt),
  }
}

function parseWham(o: Obj, opts: ParseQuotaOptions | undefined): QuotaSnapshot {
  const observedAt = observedFrom(opts)
  const rl = o['rate_limit'] as Obj
  const windows: QuotaWindow[] = []
  for (const [key, id] of [['primary_window', 'primary'], ['secondary_window', 'secondary']] as const) {
    const w = rl[key]
    if (isObj(w)) windows.push(codexWindow(w, id, observedAt, null))
  }
  windows.push(...additionalWindows(o['additional_rate_limits'], observedAt))
  const capturedAt = minCaptured(windows, observedAt ?? 0)
  const flagged = rl['limit_reached'] === true || rl['allowed'] === false
  return {
    version: 2,
    source: 'codex.wham_usage',
    planType: str(o['plan_type']),
    capturedAt,
    complete: true,
    windows,
    cappedEvent: unexplainedCap(flagged, windows, capturedAt),
  }
}

const VENDOR_TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

/** 无时区的厂商时间 + 已知 UTC 偏移 → epoch 秒；偏移未知/非法 → null（不猜）。 */
function vendorResetSec(raw: string, offsetMinutes: unknown): number | null {
  const off = finite(offsetMinutes)
  if (off == null || Math.abs(off) > 14 * 60) return null
  const m = VENDOR_TS_RE.exec(raw.trim())
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000 - off * 60)
}

/**
 * kiro / byok 徽章：`{provider, limit_reached, kind?, window?, reset_at_raw?, observed_at}`。
 * limit_reached:false = 恢复 → 完整的「无封顶」快照（这类厂商没有百分比遥测，完整窗口集合即空集）。
 * limit_reached:true  = 局部 quota 事件（旧写法不区分限速；陈旧的由 UNKNOWN_RESET_HORIZON_SEC 自清）。
 */
function parseBadge(o: Obj, opts: ParseQuotaOptions | undefined): QuotaSnapshot {
  const provider = o['provider'] as 'kiro' | 'byok'
  const at = isoSec(o['observed_at']) ?? observedFrom(opts) ?? 0
  if (o['limit_reached'] !== true) {
    return { version: 2, source: provider, planType: null, capturedAt: at, complete: true, windows: [], cappedEvent: null }
  }
  const windowLabel = str(o['window'])
  const rawReset = str(o['reset_at_raw'])
  const ev: QuotaCappedEvent = {
    kind: 'quota',
    windowHint: windowLabel != null && windowLabel !== 'window' ? windowLabel : null,
    resetAt: rawReset != null ? vendorResetSec(rawReset, opts?.vendorUtcOffsetMinutes) : null,
    occurredAt: at,
  }
  if (rawReset != null) ev.resetAtRaw = rawReset
  return { version: 2, source: provider, planType: null, capturedAt: at, complete: false, windows: [], cappedEvent: ev }
}

const ANTHROPIC_WINDOW_RE = /^(\d+)([hd])(?:_(.+))?$/

/** anthropic-ratelimit-unified-<w>-{utilization,reset,status}（claude-api 存量行）。 */
function parseAnthropic(o: Obj, opts: ParseQuotaOptions | undefined): QuotaSnapshot | null {
  const observedAt = observedFrom(opts) ?? 0
  const lower: Obj = {}
  for (const [k, v] of Object.entries(o)) lower[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  const ids = new Set<string>()
  for (const k of Object.keys(lower)) {
    const m = /^anthropic-ratelimit-unified-(.+)-(utilization|reset|status)$/.exec(k)
    if (m && ANTHROPIC_WINDOW_RE.test(m[1]!)) ids.add(m[1]!)
  }
  if (ids.size === 0) return null
  const windows: QuotaWindow[] = []
  for (const id of ids) {
    const m = ANTHROPIC_WINDOW_RE.exec(id)!
    const n = Number(m[1])
    const util = nonNeg(lower[`${ANTHROPIC_PREFIX}${id}-utilization`])
    const usedPercent = util != null ? Math.round(util * 10000) / 100 : null
    const status = lower[`${ANTHROPIC_PREFIX}${id}-status`]
    const win: QuotaWindow = {
      id,
      windowSeconds: n > 0 ? n * (m[2] === 'h' ? 3600 : 86400) : null,
      usedPercent,
      capped: status === 'rejected' || (usedPercent != null && usedPercent >= 100),
      resetAt: epochSec(lower[`${ANTHROPIC_PREFIX}${id}-reset`]),
      capturedAt: observedAt,
    }
    if (m[3] !== undefined) win.model = m[3]
    windows.push(win)
  }
  return { version: 2, source: 'anthropic.unified', planType: null, capturedAt: observedAt, complete: true, windows, cappedEvent: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────────

/** quota 事件在时刻 t 是否仍有效（throttle 永远 false）。 */
function quotaEventActive(ev: QuotaCappedEvent, t: number, horizon: number): boolean {
  if (ev.kind !== 'quota') return false
  return ev.resetAt != null ? ev.resetAt > t : t - ev.occurredAt < horizon
}

/** 当前生效的封顶：账号级耗尽窗口（reset 在未来，或 reset 未知但在视野内）+ 有效 quota 事件。 */
function activeCaps(s: QuotaSnapshot, now: number, horizon: number): ExhaustedWindow[] {
  const caps: ExhaustedWindow[] = []
  for (const w of s.windows) {
    if (!isAccountWide(w) || !windowExhausted(w)) continue
    const active = w.resetAt != null ? w.resetAt > now : now - w.capturedAt < horizon
    if (active) caps.push({ id: w.id, windowSeconds: w.windowSeconds, resetAt: w.resetAt, source: 'window' })
  }
  const ev = s.cappedEvent
  if (ev && quotaEventActive(ev, now, horizon)) {
    caps.push({ id: ev.windowHint ?? 'unknown', windowSeconds: null, resetAt: ev.resetAt, source: 'event' })
  }
  return caps
}

/**
 * 账号现在是否额度封顶。任一账号级窗口已耗尽且 reset 在未来，或有效的 quota 事件
 * （reset 在未来；reset 未知则 occurredAt 起 `UNKNOWN_RESET_HORIZON_SEC` 内）。
 * 限速事件永不算；按模型的附加窗口不算。
 */
export function isCapped(snapshot: QuotaSnapshot, nowSec: number, opts?: CappedOptions): boolean {
  return activeCaps(snapshot, nowSec, horizonOf(opts)).length > 0
}

/** 封顶到何时：生效封顶里**最晚**的已知 resetAt；都不知道（或没封顶）→ null。 */
export function cappedUntil(snapshot: QuotaSnapshot, nowSec: number, opts?: CappedOptions): number | null {
  let until: number | null = null
  for (const c of activeCaps(snapshot, nowSec, horizonOf(opts))) {
    if (c.resetAt != null && (until == null || c.resetAt > until)) until = c.resetAt
  }
  return until
}

/** 展示用：哪个窗口耗尽了（取 reset 最晚的；同 reset 优先真实窗口），没有则 null。 */
export function exhaustedWindow(snapshot: QuotaSnapshot, nowSec: number, opts?: CappedOptions): ExhaustedWindow | null {
  let best: ExhaustedWindow | null = null
  for (const c of activeCaps(snapshot, nowSec, horizonOf(opts))) {
    if (best == null) { best = c; continue }
    const cr = c.resetAt ?? -1
    const br = best.resetAt ?? -1
    if (cr > br) best = c
  }
  return best
}

/** 陈旧度：按每个窗口的 capturedAt（**不是**行的 observed_at）判。 */
export function staleness(snapshot: QuotaSnapshot, nowSec: number, thresholdSec: number): QuotaStaleness {
  const threshold = nonNeg(thresholdSec) ?? 0
  const windows = snapshot.windows.map((w) => {
    const ageSec = Math.max(0, nowSec - w.capturedAt)
    return { id: w.id, capturedAt: w.capturedAt, ageSec, stale: ageSec > threshold }
  })
  const oldestCapturedAt = minCaptured(snapshot.windows, snapshot.capturedAt)
  const stale = windows.length > 0 ? windows.some((w) => w.stale) : nowSec - snapshot.capturedAt > threshold
  return { stale, oldestCapturedAt, windows }
}

/**
 * 冷却截止（epoch 秒；null = 不冷却）。**单调**：永不早于仍有效的 existingUntil，
 * 唯一例外是「封顶之后采集的、完整的、未封顶」快照（见 CooldownInput.cappedAtSec）。
 * 封顶时：知道 reset 就冷却到 reset，不知道才用 now + defaultLadderSec。
 */
export function cooldownUntil(input: CooldownInput): number | null {
  const now = input.nowSec
  const ex = epochSec(input.existingUntil)
  const existing = ex != null && ex > now ? ex : null
  const snap = input.snapshot
  if (!snap) return existing
  if (isCapped(snap, now)) {
    const until = cappedUntil(snap, now) ?? now + (nonNeg(input.defaultLadderSec) ?? 0)
    return existing == null ? until : Math.max(existing, until)
  }
  if (existing == null) return null
  if (!snap.complete) return existing
  const captured = minCaptured(snap.windows, snap.capturedAt)
  const cappedAt = epochSec(input.cappedAtSec)
  const lift = cappedAt != null ? captured > cappedAt : captured >= now - LIFT_FRESHNESS_SEC
  return lift ? null : existing
}

// ─────────────────────────────────────────────────────────────────────────────
// 合并
// ─────────────────────────────────────────────────────────────────────────────

/** 两个事件取哪个：较晚发生的胜出；但限速不能顶掉在那一刻仍有效的 quota 事件。 */
function pickEvent(existing: QuotaCappedEvent | null, candidate: QuotaCappedEvent | null): QuotaCappedEvent | null {
  if (!existing) return candidate
  if (!candidate) return existing
  const t = Math.max(existing.occurredAt, candidate.occurredAt)
  if (candidate.kind === 'throttle' && quotaEventActive(existing, t, UNKNOWN_RESET_HORIZON_SEC)) return existing
  if (existing.kind === 'throttle' && quotaEventActive(candidate, t, UNKNOWN_RESET_HORIZON_SEC)) return candidate
  return candidate.occurredAt >= existing.occurredAt ? candidate : existing
}

/**
 * 写方合并：
 *  · 来件完整 → **整体替换**窗口集合（不做 JSON_MERGE_PATCH），刷 observed_at；存量事件只有
 *    晚于来件采集时刻（乱序到达）才保留。
 *  · 来件局部（429 / 限速）→ 存量窗口原样不动、只更新 cappedEvent，**不刷 observed_at**。
 */
export function mergeObservation(stored: QuotaSnapshot | null, incoming: QuotaSnapshot): MergeResult {
  if (incoming.complete) {
    const prior = stored?.cappedEvent ?? null
    const cappedEvent = prior && prior.occurredAt > incoming.capturedAt ? pickEvent(incoming.cappedEvent, prior) : incoming.cappedEvent
    return { snapshot: { ...incoming, cappedEvent }, bumpObservedAt: true }
  }
  const base: QuotaSnapshot = stored ?? {
    version: 2,
    source: incoming.source,
    planType: incoming.planType,
    capturedAt: incoming.capturedAt,
    complete: false,
    windows: [],
    cappedEvent: null,
  }
  return {
    snapshot: { ...base, planType: base.planType ?? incoming.planType, cappedEvent: pickEvent(base.cappedEvent, incoming.cappedEvent) },
    bumpObservedAt: false,
  }
}
