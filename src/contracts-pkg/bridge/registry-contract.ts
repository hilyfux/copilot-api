/**
 * 桥服务 · 注册契约（Cluster Bridge, 2026-09-17）。
 *
 * operator：「做一个专门的桥服务模块放 agent-gateway（控制面），大家把自己的接口都
 * 注册进来，然后这边就可以做调度策略了。」+「各系统保持独立，agent-gateway 管配置」。
 *
 * 这是**跨系统稳定数据边界**（铁律二）：各代理（codex-api / kiro-api / byok-api）向 gateway 的 `/internal/bridge/register` 上报这份描述符 + 定期心跳；
 * gateway 据此 + 配置做**集群调度决策**（发布给代理，代理自执行——gateway 不进数据路径）。
 *
 * 演进规则：新增字段一律**可选**（先扩展后收缩）；已发布字段语义不得静默改。
 * 这份契约同时是 codex-api/kiro-api/... 侧注册客户端要镜像的形状（cross-repo）。
 */

/** 代理自报的健康/负载（调度输入；缺省 = gateway 视为未知，按保守处理）。 */
export type BridgeHealth = {
  readonly status: 'healthy' | 'degraded' | 'down'
  /** 0–100，聚合在飞+排队负载率；可选。 */
  readonly loadPct?: number
}

/** 代理暴露的一个可调度端点（loopback；gateway 只记录、不代理数据）。 */
export type BridgeEndpoint = {
  /** 逻辑名，如 'responses' / 'messages' / 'chat-completions'。 */
  readonly name: string
  /** 回环 URL，如 'http://127.0.0.1:39516/v1/responses'。 */
  readonly url: string
}

/**
 * 负载转发计数窗口（可选，2026-10-16 负载转发审计 T5）。代理在每次心跳里上报**最近一个窗口**
 * 内自己发起的转发结果：成功 / 失败次数 + 最近一次失败的原因。网关据此在「转发实况」面板
 * 展示失败率、并在失败率越线时告警（`load_forward_failing`）。
 *
 * 只加可选字段（先扩展后收缩）：老代理不带 = 网关显示「未上报」，什么都不坏。
 * 代理侧实现由 codex-api / kiro-api 随后跟进（建议：滑动窗口 10 分钟、`windowMs: 600000`）。
 */
export type BridgeLoadForward = {
  /** 窗口内转发成功次数（非负整数）。 */
  readonly ok: number
  /** 窗口内转发失败次数（非负整数；= errors.jsonl `load_forward_failed` 的条数）。 */
  readonly failed: number
  /** 计数窗口长度（ms，1s–24h）。缺省 = 网关按 10 分钟解读。 */
  readonly windowMs?: number
  /** 最近一次失败的原因（如 `vendor_status 402`）。网关截断到 200 字、去控制字符；**不得含密钥**。 */
  readonly lastError?: string
  /** 最近一次失败时刻（epoch ms）。 */
  readonly lastErrorAtMs?: number
  /**
   * 代理侧 env 总开关（codex `CODEX_API_LOAD_FORWARDING` / kiro `KIRO_API_LOAD_FORWARDING`）
   * 是否打开（可选，2026-10-16 审计 T7）。后台规则开了但代理 env 关 = 转发静默不发生；
   * 上报后后台按服务显示「代理侧开关：开 / 关」，不报 = 未知。
   */
  readonly enabledByEnv?: boolean
}

/** 网关侧对 `lastError` 的截断上限（字符）。 */
export const LOAD_FORWARD_LAST_ERROR_MAX = 200
/** 代理没给 `windowMs` 时网关的解读值（10 分钟，与告警口径一致）。 */
export const DEFAULT_LOAD_FORWARD_WINDOW_MS = 600_000

/** 一个代理实例的注册描述符（register + heartbeat 复用同一形状）。 */
export type BridgeRegistration = {
  /** 服务族：'codex-api' | 'kiro-api' | 'byok-api' | …（自由串，机械不枚举以便扩展）。 */
  readonly service: string
  /** 进程级唯一 id（host+pid 或 uuid）；同 service 多实例靠它区分。 */
  readonly instanceId: string
  /** fleet 主机键：'lan' | 'azure'（调度按主机隔离，跨主机不互转）。 */
  readonly host: string
  /** 可调度端点。 */
  readonly endpoints: readonly BridgeEndpoint[]
  /** 该实例可服务的下游模型 id 列表（调度候选面）。 */
  readonly servedModels: readonly string[]
  /** 能力标签（可选，如 'anthropic-shim' / 'openai-compat'）。 */
  readonly capabilities?: readonly string[]
  /** 最近一次自报健康/负载（可选）。 */
  readonly health?: BridgeHealth
  /** 最近窗口的转发成功 / 失败计数（可选，T5）。 */
  readonly loadForward?: BridgeLoadForward
  /** 代理侧上报时刻（epoch ms）——用于陈旧判定与观测。 */
  readonly reportedAtMs: number
}

/** register/heartbeat 入参校验结果。 */
export type RegistrationValidation =
  | { readonly ok: true; readonly value: BridgeRegistration }
  | { readonly ok: false; readonly error: string }

const NAME_RE = /^[A-Za-z0-9_.:@-]{1,64}$/
const LOOPBACK_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/[^\s]*)?$/

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 纯校验（铁律五：输入边界显式校验）。控制面接口收外部代理的 JSON，必须逐字段验；
 * 任一不合法 → 拒绝并给出可诊断原因，绝不把半截描述符塞进注册表。
 * endpoints URL 强制回环——桥是控制面，注册的必须是本机代理端点，杜绝被塞外网地址。
 */
export function validateRegistration(input: unknown): RegistrationValidation {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'body must be a JSON object' }
  const o = input as Record<string, unknown>

  if (!isNonEmptyString(o['service']) || !NAME_RE.test(o['service'])) return { ok: false, error: 'service: non-empty name (≤64, [A-Za-z0-9_.:@-])' }
  if (!isNonEmptyString(o['instanceId']) || !NAME_RE.test(o['instanceId'])) return { ok: false, error: 'instanceId: non-empty name (≤64)' }
  if (!isNonEmptyString(o['host']) || !NAME_RE.test(o['host'])) return { ok: false, error: 'host: non-empty name (≤64)' }

  const endpointsRaw = o['endpoints']
  if (!Array.isArray(endpointsRaw) || endpointsRaw.length === 0) return { ok: false, error: 'endpoints: non-empty array' }
  const endpoints: BridgeEndpoint[] = []
  for (const e of endpointsRaw) {
    if (typeof e !== 'object' || e === null) return { ok: false, error: 'endpoints[]: each must be an object' }
    const ep = e as Record<string, unknown>
    if (!isNonEmptyString(ep['name']) || !NAME_RE.test(ep['name'])) return { ok: false, error: 'endpoints[].name: non-empty name' }
    if (!isNonEmptyString(ep['url']) || !LOOPBACK_URL_RE.test(ep['url'])) return { ok: false, error: 'endpoints[].url: must be a loopback http(s) URL' }
    endpoints.push({ name: ep['name'], url: ep['url'] })
  }

  const modelsRaw = o['servedModels']
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0 || modelsRaw.some((m) => !isNonEmptyString(m))) return { ok: false, error: 'servedModels: non-empty array of non-empty strings' }
  const servedModels = modelsRaw as string[]

  let capabilities: string[] | undefined
  if (o['capabilities'] !== undefined) {
    if (!Array.isArray(o['capabilities']) || o['capabilities'].some((c) => !isNonEmptyString(c))) return { ok: false, error: 'capabilities: optional array of non-empty strings' }
    capabilities = o['capabilities'] as string[]
  }

  let health: BridgeHealth | undefined
  if (o['health'] !== undefined) {
    if (typeof o['health'] !== 'object' || o['health'] === null) return { ok: false, error: 'health: optional object' }
    const h = o['health'] as Record<string, unknown>
    if (h['status'] !== 'healthy' && h['status'] !== 'degraded' && h['status'] !== 'down') return { ok: false, error: "health.status: 'healthy'|'degraded'|'down'" }
    let loadPct: number | undefined
    if (h['loadPct'] !== undefined) {
      const n = Number(h['loadPct'])
      if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: 'health.loadPct: 0–100' }
      loadPct = n
    }
    health = { status: h['status'], ...(loadPct !== undefined ? { loadPct } : {}) }
  }

  let loadForward: BridgeLoadForward | undefined
  if (o['loadForward'] !== undefined) {
    const lf = validateLoadForward(o['loadForward'])
    if (!lf.ok) return { ok: false, error: lf.error }
    loadForward = lf.value
  }

  const reportedAtRaw = o['reportedAtMs']
  const reportedAtMs = reportedAtRaw === undefined ? Date.now() : Number(reportedAtRaw)
  if (!Number.isFinite(reportedAtMs) || reportedAtMs <= 0) return { ok: false, error: 'reportedAtMs: positive epoch ms' }

  return {
    ok: true,
    value: {
      service: o['service'], instanceId: o['instanceId'], host: o['host'],
      endpoints, servedModels,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(health !== undefined ? { health } : {}),
      ...(loadForward !== undefined ? { loadForward } : {}),
      reportedAtMs,
    },
  }
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000
}

/** `loadForward` 子对象校验：计数必须是非负整数；`lastError` 超长截断而非拒绝
 *  （一条长报错不该把整个实例踢出注册表）。 */
function validateLoadForward(input: unknown): { ok: true; value: BridgeLoadForward } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'loadForward: optional object' }
  const o = input as Record<string, unknown>
  if (!isCount(o['ok'])) return { ok: false, error: 'loadForward.ok: non-negative integer' }
  if (!isCount(o['failed'])) return { ok: false, error: 'loadForward.failed: non-negative integer' }
  let windowMs: number | undefined
  if (o['windowMs'] !== undefined) {
    const w = o['windowMs']
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1000 || w > 86_400_000) return { ok: false, error: 'loadForward.windowMs: integer 1000–86400000' }
    windowMs = w
  }
  let lastError: string | undefined
  if (o['lastError'] !== undefined) {
    if (typeof o['lastError'] !== 'string') return { ok: false, error: 'loadForward.lastError: optional string' }
    // 去控制字符（换行会破坏企业微信 markdown 与表格行），再截断。
    const cleaned = o['lastError'].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    if (cleaned.length > 0) lastError = cleaned.slice(0, LOAD_FORWARD_LAST_ERROR_MAX)
  }
  let lastErrorAtMs: number | undefined
  if (o['lastErrorAtMs'] !== undefined) {
    const t = o['lastErrorAtMs']
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return { ok: false, error: 'loadForward.lastErrorAtMs: positive epoch ms' }
    lastErrorAtMs = t
  }
  let enabledByEnv: boolean | undefined
  if (o['enabledByEnv'] !== undefined) {
    if (typeof o['enabledByEnv'] !== 'boolean') return { ok: false, error: 'loadForward.enabledByEnv: optional boolean' }
    enabledByEnv = o['enabledByEnv']
  }
  return {
    ok: true,
    value: {
      ok: o['ok'], failed: o['failed'],
      ...(windowMs !== undefined ? { windowMs } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(lastErrorAtMs !== undefined ? { lastErrorAtMs } : {}),
      ...(enabledByEnv !== undefined ? { enabledByEnv } : {}),
    },
  }
}
