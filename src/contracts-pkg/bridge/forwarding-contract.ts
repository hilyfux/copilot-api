/**
 * 桥服务 · 负载转发配置契约（Cluster Load Forwarding, 2026-09-17）。
 *
 * gateway 拥有配置（app_settings key `bridge.load_forwarding`，单一数据源）；消费方
 * **本地缓存 + 本地决策 + 自执行转发**（gateway 不进请求路径，铁律7）。这份形状是
 * 跨系统契约——agent 侧解析客户端要镜像它。
 *
 * 实际取配置的路径（2026-10-16 负载转发审计 T4 核实）：**codex-api 与 kiro-api 都直读
 * MySQL app_settings**（两仓 `src/settings/app-settings.ts`，5s 轮询）；byok-api 不读
 * （claude-api 已移除）。gateway 侧另有 fail-safe 的
 * `GET /internal/bridge/forwarding`（`src/routes/internal-bridge.ts`）作为备用面，
 * **当前无任何代理轮询它**——描述取配置路径时不要引用它。
 *
 * 演进：新增字段一律可选（先扩展后收缩）；坏配置一律 fail-safe 解析为「关」，绝不因
 * 一条坏规则让代理请求路径抛错。
 */

export const LOAD_FORWARDING_KEY = 'bridge.load_forwarding'

/**
 * 触发口径（三选一）。
 *  · `on_overload`   一过载就分流（上游 529 / overloaded_error）
 *  · `on_exhaustion` 全池对该模型耗尽才切（no healthy / no candidate / exhausted）
 *  · `on_failure`    **最宽**的口径：上游不可服务即切 —— 过载 ∪ 耗尽 ∪ 故障
 *    （5xx / 连不上 / 连接中断 / token 刷新失败）。operator 2026-09-18：
 *    「不仅要过载转发，上游故障也转发」，补回 spec 首条原话「当出现故障的时候立刻切换」。
 *    **刻意不含客户端错**：invalid_request（model not found 等）与客户端主动 abort
 *    永不触发 —— 前者转发了会静默换个模型把配置 bug 藏起来，后者没人收答案。
 *
 * ⚠️ 发布顺序（expand-then-contract）：**先发各代理、再开本页的下拉选项**。
 * 代理侧的 `parseRule` 对不认识的 trigger 是 **fail-safe 丢弃整条规则** ——
 * 代理还没升级时选了它，会「保存成功、无任何异常、转发静默不发生」。
 */
export type ForwardingTrigger = 'on_overload' | 'on_exhaustion' | 'on_failure'

/** 一条转发规则：某代理的某下游模型，过载时按 sharePct 分流到某供应商模型。 */
export type ForwardingRule = {
  /** 适用代理族，如 'codex-api'；'*' = 所有代理。 */
  readonly service: string
  /** 下游模型 id，如 'claude-sonnet-4-6'；'*' = 该代理所有模型。 */
  readonly downstreamModel: string
  /** 兜底供应商凭据引用（provider_accounts.provider_type，如 'byok_deepseek'）。 */
  readonly vendorProviderType: string
  /** 转发到供应商的模型名，如 'deepseek-chat'。 */
  readonly vendorModel: string
  /** 触发口径。 */
  readonly trigger: ForwardingTrigger
  /** 过载时分流比例 0–100（100=全切）。 */
  readonly sharePct: number
  /** 单条开关。 */
  readonly enabled: boolean
}

/** 整体转发配置。 */
export type ForwardingConfig = {
  /** 总开关（关 = 所有规则不生效）。 */
  readonly enabled: boolean
  readonly rules: readonly ForwardingRule[]
}

/** 空配置（fail-safe 默认：什么都不转发）。 */
export const EMPTY_FORWARDING: ForwardingConfig = { enabled: false, rules: [] }

const NAME_RE = /^[A-Za-z0-9_.:@*-]{1,64}$/

function isStr(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0 }

/** 校验并归一一条规则；不合法 → null（调用方丢弃该条，不整体失败）。 */
export function parseRule(input: unknown): ForwardingRule | null {
  if (typeof input !== 'object' || input === null) return null
  const o = input as Record<string, unknown>
  if (!isStr(o['service']) || !NAME_RE.test(o['service'])) return null
  if (!isStr(o['downstreamModel']) || !NAME_RE.test(o['downstreamModel'])) return null
  if (!isStr(o['vendorProviderType']) || !NAME_RE.test(o['vendorProviderType'])) return null
  if (!isStr(o['vendorModel']) || !NAME_RE.test(o['vendorModel'])) return null
  if (o['trigger'] !== 'on_overload' && o['trigger'] !== 'on_exhaustion' && o['trigger'] !== 'on_failure') return null
  const share = Number(o['sharePct'])
  if (!Number.isFinite(share) || share < 0 || share > 100) return null
  const enabled = o['enabled'] !== false // 缺省视为开（规则存在即意图启用），显式 false 才关
  return {
    service: o['service'], downstreamModel: o['downstreamModel'],
    vendorProviderType: o['vendorProviderType'], vendorModel: o['vendorModel'],
    trigger: o['trigger'], sharePct: Math.floor(share), enabled,
  }
}

/**
 * 解析 app_settings 里的 JSON 字符串 → ForwardingConfig。fail-safe：null/空/坏 JSON/
 * 坏结构 → EMPTY（关）。坏的单条规则被丢弃，好的保留（局部坏不拖垮整体）。
 */
export function parseForwardingConfig(raw: string | null | undefined): ForwardingConfig {
  if (!isStr(raw)) return EMPTY_FORWARDING
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return EMPTY_FORWARDING }
  if (typeof obj !== 'object' || obj === null) return EMPTY_FORWARDING
  const o = obj as Record<string, unknown>
  const enabled = o['enabled'] === true
  const rulesRaw = Array.isArray(o['rules']) ? o['rules'] : []
  const rules = rulesRaw.map(parseRule).filter((r): r is ForwardingRule => r !== null)
  return { enabled, rules }
}

/**
 * 决策解析器（纯函数，代理本地调用）：给定 (service, model)，返回命中的启用规则；
 * 无则 null。精确模型优先于 '*'；精确 service 优先于 '*'。总开关关 → 恒 null。
 */
export function resolveForwarding(cfg: ForwardingConfig, sel: { service: string; model: string }): ForwardingRule | null {
  if (!cfg.enabled) return null
  const candidates = cfg.rules.filter((r) =>
    r.enabled
    && (r.service === sel.service || r.service === '*')
    && (r.downstreamModel === sel.model || r.downstreamModel === '*'))
  if (candidates.length === 0) return null
  // 最具体优先：service 精确 + model 精确 > 有一个 '*' > 全 '*'。
  const score = (r: ForwardingRule) => (r.service === sel.service ? 2 : 0) + (r.downstreamModel === sel.model ? 1 : 0)
  return candidates.reduce((best, r) => (score(r) > score(best) ? r : best))
}

/**
 * **终局转发决策应当用这个**（2026-09-26 azure 事故）：最具体那一档的全部启用规则（按配置顺序）。
 *
 * 后台允许在同一 (service, model) 下给不同 trigger 各配一条规则（azure 实配：同一
 * (codex-api, `*`) 下 on_overload / on_exhaustion / on_failure 三条），本意是三个口径**取并集**。
 * `resolveForwarding` 同分只返回第一条 → 其余两条永远不被看：上游 401（只算「故障」）即使
 * 归类正确也不会转发。代理的终局决策应在本函数返回的**同一档**里找第一条 trigger 成立的规则；
 * 更具体的规则仍整体覆盖更泛的规则（「具体优先」不变）。
 * 恒有 `resolveForwarding(...) === resolveMostSpecificForwardingRules(...)[0] ?? null`。
 * 代理侧：codex-api `load-forwarding-contract.ts` 已同名实现（1.29.5）；kiro-api 已跟进（同名实现）。
 */
export function resolveMostSpecificForwardingRules(cfg: ForwardingConfig, sel: { service: string; model: string }): ForwardingRule[] {
  if (!cfg.enabled) return []
  const candidates = cfg.rules.filter((r) =>
    r.enabled
    && (r.service === sel.service || r.service === '*')
    && (r.downstreamModel === sel.model || r.downstreamModel === '*'))
  if (candidates.length === 0) return []
  const score = (r: ForwardingRule) => (r.service === sel.service ? 2 : 0) + (r.downstreamModel === sel.model ? 1 : 0)
  const best = Math.max(...candidates.map(score))
  return candidates.filter((r) => score(r) === best)
}

/**
 * 严格校验（后台**写路径**专用）。解析/决策路径继续用 fail-safe 的
 * `parseForwardingConfig` / `parseRule`（局部坏不拖垮整体）；但 operator 在后台
 * 保存配置时，坏规则必须**当场拒绝并给出可诊断原因**（铁律五：写路径显式校验），
 * 绝不静默丢弃后写一份「和他填的不一样」的配置进 app_settings。
 *
 * 纯加法：不改任何已发布类型/语义，代理侧镜像的仍是 parse/resolve 那一套，
 * 故无跨仓契约漂移。
 */

/**
 * 写路径的**显式容量上限**（2026-09-17 事故：`Data too long for column 'setting_value'`）。
 *
 * mig 025 的 `setting_value VARCHAR(512)` 装不下 3 条规则（530 字符），operator 在
 * 后台保存时拿到的是 MySQL 1406 被兜成的「internal server error」——不可诊断。
 * 修法分两层，缺一不可：
 *   ① schema：列加宽（mig 121），让列不再是那个「意外的悬崖」；
 *   ② 这里：把上限变成**契约里显式写下的数字**，超限返回可诊断的 400。
 *
 * 两个上限都**必须可触发**，否则就是死代码（首版把尺寸上限设成 32KB 而 64 条最坏
 * 才 24.9KB，永远撞不到——已修正）。按实测：单条典型 167 字符、最坏 388 字符
 * （4 个字段各顶满 NAME_RE 的 64 字符），于是 16KB 这个点让两条路径各司其职——
 *   · 肥规则：42 条撞**尺寸**上限（早于 64 条）
 *   · 典型规则：64 条撞**条数**上限（早于 96 条）
 * 不变式：任何被接受的配置 ≤ 16KB ≤ 列容量 64KB（4× 余量），由
 * tests/app-settings-value-capacity.test.ts 机械校验。
 *
 * ⚠️ 只作用于**写路径**。读路径 `parseForwardingConfig` 刻意保持宽容——代理侧镜像的
 * 就是它，加限制会造成跨仓语义漂移（历史配置再大也必须能被代理读出来）。
 */
export const MAX_FORWARDING_RULES = 64

/** 序列化后允许的最大字符数（写路径 400 的阈值；见上方两条触发路径）。 */
export const MAX_FORWARDING_CONFIG_CHARS = 16_000

export type ForwardingValidation =
  | { readonly ok: true; readonly value: ForwardingConfig }
  | { readonly ok: false; readonly error: string }

/** 校验单条规则并给出可诊断原因（哪一字段坏）。 */
export function validateRule(input: unknown): { ok: true; value: ForwardingRule } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'rule must be an object' }
  const o = input as Record<string, unknown>
  if (!isStr(o['service']) || !NAME_RE.test(o['service'])) return { ok: false, error: 'service: non-empty name (≤64, [A-Za-z0-9_.:@*-])' }
  if (!isStr(o['downstreamModel']) || !NAME_RE.test(o['downstreamModel'])) return { ok: false, error: 'downstreamModel: non-empty name (≤64)' }
  if (!isStr(o['vendorProviderType']) || !NAME_RE.test(o['vendorProviderType'])) return { ok: false, error: 'vendorProviderType: non-empty name (≤64)' }
  if (!isStr(o['vendorModel']) || !NAME_RE.test(o['vendorModel'])) return { ok: false, error: 'vendorModel: non-empty name (≤64)' }
  if (o['trigger'] !== 'on_overload' && o['trigger'] !== 'on_exhaustion' && o['trigger'] !== 'on_failure') return { ok: false, error: "trigger: 'on_overload'|'on_exhaustion'|'on_failure'" }
  const share = Number(o['sharePct'])
  if (!Number.isFinite(share) || share < 0 || share > 100) return { ok: false, error: 'sharePct: integer 0–100' }
  const enabled = o['enabled'] !== false
  return {
    ok: true,
    value: {
      service: o['service'], downstreamModel: o['downstreamModel'],
      vendorProviderType: o['vendorProviderType'], vendorModel: o['vendorModel'],
      trigger: o['trigger'], sharePct: Math.floor(share), enabled,
    },
  }
}

/** 严格校验整体配置（后台 PUT）：任一坏规则 → 拒绝并指明第几条、坏在哪。 */
export function validateForwardingConfig(input: unknown): ForwardingValidation {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'body must be a JSON object' }
  const o = input as Record<string, unknown>
  if (typeof o['enabled'] !== 'boolean') return { ok: false, error: 'enabled: boolean required' }
  const rulesRaw = o['rules']
  if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) return { ok: false, error: 'rules: must be an array' }
  const arr = Array.isArray(rulesRaw) ? rulesRaw : []
  // 条数上限：先于逐条校验判，省得为一条注定被拒的载荷白跑 64 遍。
  if (arr.length > MAX_FORWARDING_RULES) {
    return { ok: false, error: `rules: too many (${arr.length}); max ${MAX_FORWARDING_RULES}` }
  }
  const rules: ForwardingRule[] = []
  for (let i = 0; i < arr.length; i++) {
    const r = validateRule(arr[i])
    if (!r.ok) return { ok: false, error: `rules[${i}]: ${r.error}` }
    rules.push(r.value)
  }
  const value: ForwardingConfig = { enabled: o['enabled'], rules }
  // 尺寸兜底：字段级 NAME_RE 已封住单条上界，这里量的是**归一后实际要落库的那串**。
  // 放在最后是因为它必须量最终形态（默认值补齐、sharePct 取整之后）。
  const bytes = JSON.stringify(value).length
  if (bytes > MAX_FORWARDING_CONFIG_CHARS) {
    return { ok: false, error: `config: serialized ${bytes} chars exceeds ${MAX_FORWARDING_CONFIG_CHARS}` }
  }
  return { ok: true, value }
}

/**
 * 分流判定（纯函数，v2，2026-10-16 补缺）：sharePct=100 全转；<100 时按请求维度确定性抽样
 * （用 seed，如 reqId/sessionId 的哈希）——同一会话稳定命中同一侧，避免一次会话里忽转忽不转。
 *
 * 这是 codex-api / kiro-api 两仓 `load-forwarding-contract.ts` 早已各自落地、逐字相同的实现
 * （kiro-api 侧文件头曾注明"契约包 v1 没收，暂留本地，已报总指挥补进包"）；v2 把它收进包，
 * 两仓之后改成 re-export，不再手工对 sha。FNV-1a 32 位哈希，seed 用字节逐个异或 + 质数乘。
 */
export function shouldForward(rule: ForwardingRule, seed: string): boolean {
  if (rule.sharePct >= 100) return true
  if (rule.sharePct <= 0) return false
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return (h % 100) < rule.sharePct
}
