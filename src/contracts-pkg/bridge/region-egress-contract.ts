/**
 * 区域**出口契约**（2026-09-26）—— 跨仓单一数据源。
 *
 * 权威定义在本仓（agent-gateway）`src/bridge/region-egress-contract.ts`。
 * codex-api / kiro-api 各放一份**逐字镜像**（MIRRORED VERBATIM）：
 *
 *  · 镜像只允许**改文件头**（本注释块，第 1 行到第一个恰为 ` *\/` 的行）——头里写
 *    「xxx-api 侧镜像，MIRRORED VERBATIM from agent-gateway …」即可；**头部以下逐字相同**。
 *  · 校验：`sed '1,/^ \*\/$/d' <file> | shasum -a 256` —— 三个仓得到同一个值。
 *    本仓 `tests/region-egress-contract.test.ts` 钉住了这个值；改正文 = 同一窗口改三个仓
 *    + 更新钉住值（铁律 §二.1/§二.5）。
 *  · 正文**零 import、零 IO、纯函数**：拷过去不依赖任何仓的模块。
 *  · 别名归一（如 `SG` → `singapore`）**不在**本契约里：各仓先用自家 normalizeRegion
 *    得到规范 slug，再交给 `resolveRegionEgress`。
 *
 * ## 为什么要有它（2026-09-26 区域链路审计 G2/G3）
 *
 * 账号 ↔ 区域绑定是 INVIOLABLE 红线：绑了区域的账号只能从该区域的 Mihomo 监听出口，
 * 解析不出端口就**必须失败**，绝不静默走宿主机 IP。审计发现同一件事在各处各判一遍：
 *  ① codex-api / kiro-api 在「动态区域 slug（uk/philippines）+ settings 尚未加载」的冷启动
 *     窗口里查不到端口 → 走了宿主机出口；
 *  ② gateway 的 OAuth 沙箱 / kiro 用量探测只认静态端口表 → 动态区域账号从宿主机出口；
 *  ③ 各仓对 `region_dynamic_slots` 的解析宽严不一（撞端口、撞静态表都照收）。
 * 抽成一份纯函数，三仓逐字共用，判定只有一个答案。
 *
 * ## 契约要点
 *
 *  1. `region_dynamic_slots`（gateway app_settings，owner = agent-gateway）形状：
 *     `{ <slug>: { slug, label, slotGroup, proxyPort, includePattern } }`。本契约**只认**
 *     key 与 `proxyPort`（+ 可选 `slug` 一致性），其余字段是 gateway 内部细节。
 *  2. 静态端口表恒优先：动态 slug 撞静态 slug、动态端口撞任一静态端口 → 丢弃该动态行。
 *     两个动态 slug 共用一个端口 → 两个都丢（歧义 = 跨区风险）。
 *  3. 出口判定三态：
 *       proxy  —— 解析到端口（静态或动态）；
 *       direct —— 只有两种：显式 `'direct'`（operator 刻意选择），或未绑定（NULL/空）且调用方
 *                 显式允许（codex CODEX_API_ALLOW_DIRECT_EGRESS / kiro 默认、OAuth 沙箱）；
 *       reject —— 其余一切：未绑定且不允许、settings 尚未加载时的非静态 slug、未分配 slug、
 *                 端口非法。调用方必须把 reject 变成请求失败（502 / 拒开沙箱），**不得降级**。
 */

/** 显式直连哨兵（与 agent-gateway `DIRECT_REGION` 同字面量）。 */
export const DIRECT_EGRESS_REGION = 'direct'

/** 区域 slug 形状：小写字母数字开头，只含小写字母/数字/连字符，≤64。 */
const REGION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export type RegionPortMap = Readonly<Record<string, number>>

/** 合法监听端口：1..65535 的整数。 */
export function isValidProxyPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

export type DynamicPortRejectReason =
  | 'invalid-slug'
  | 'reserved-slug'
  | 'invalid-entry'
  | 'slug-mismatch'
  | 'invalid-port'
  | 'static-slug-collision'
  | 'static-port-collision'
  | 'duplicate-port'

export type DynamicPortsParse = {
  /** 可用的 slug → 端口。 */
  ports: Record<string, number>
  /** 被丢弃的行及原因（观测用：调用方应 warn，静默丢弃 = 未被观测的 bug）。 */
  rejected: { slug: string; reason: DynamicPortRejectReason }[]
}

/**
 * 解析 `region_dynamic_slots` 原值（JSON 字符串或已解析对象）→ slug→port + 丢弃明细。
 * 永不抛：空 / 非法 JSON / 非对象 → 空结果。`staticPorts` 用于排除与静态表的冲突。
 */
export function parseDynamicRegionPortsDetailed(raw: unknown, staticPorts: RegionPortMap = {}): DynamicPortsParse {
  const out: DynamicPortsParse = { ports: {}, rejected: [] }
  let obj: unknown = raw
  if (typeof obj === 'string') {
    if (obj.trim().length === 0) return out
    try { obj = JSON.parse(obj) } catch { return out }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out

  const staticPortSet = new Set(Object.values(staticPorts))
  const candidates: { slug: string; port: number }[] = []
  for (const [slug, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!REGION_SLUG_RE.test(slug)) { out.rejected.push({ slug, reason: 'invalid-slug' }); continue }
    if (slug === DIRECT_EGRESS_REGION) { out.rejected.push({ slug, reason: 'reserved-slug' }); continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { out.rejected.push({ slug, reason: 'invalid-entry' }); continue }
    const entry = value as { slug?: unknown; proxyPort?: unknown }
    if (entry.slug !== undefined && entry.slug !== slug) { out.rejected.push({ slug, reason: 'slug-mismatch' }); continue }
    if (!isValidProxyPort(entry.proxyPort)) { out.rejected.push({ slug, reason: 'invalid-port' }); continue }
    if (Object.prototype.hasOwnProperty.call(staticPorts, slug)) { out.rejected.push({ slug, reason: 'static-slug-collision' }); continue }
    if (staticPortSet.has(entry.proxyPort)) { out.rejected.push({ slug, reason: 'static-port-collision' }); continue }
    candidates.push({ slug, port: entry.proxyPort })
  }

  const portUse = new Map<number, number>()
  for (const c of candidates) portUse.set(c.port, (portUse.get(c.port) ?? 0) + 1)
  for (const c of candidates) {
    if ((portUse.get(c.port) ?? 0) > 1) { out.rejected.push({ slug: c.slug, reason: 'duplicate-port' }); continue }
    out.ports[c.slug] = c.port
  }
  return out
}

/** `parseDynamicRegionPortsDetailed(...).ports` 的简写。 */
export function parseDynamicRegionPorts(raw: unknown, staticPorts: RegionPortMap = {}): Record<string, number> {
  return parseDynamicRegionPortsDetailed(raw, staticPorts).ports
}

export type RegionEgressInput = {
  /** 账号的规范区域 slug（已做别名归一）；null/undefined/空 = 未绑定。 */
  region: string | null | undefined
  /** 编译期静态端口表（基础区域）。 */
  staticPorts: RegionPortMap
  /** 运行时动态端口表（最好来自 parseDynamicRegionPorts）。 */
  dynamicPorts: RegionPortMap
  /** 动态表是否**至少成功加载过一次**。false 时非静态 slug 一律 reject（冷启动窗口）。 */
  settingsLoaded: boolean
  /** 未绑定（NULL/空）时是否允许宿主机直连。显式 'direct' 不受此开关影响。 */
  allowDirectForUnbound: boolean
}

export type RegionEgressDecision =
  | { kind: 'proxy'; port: number; source: 'static' | 'dynamic' }
  | { kind: 'direct'; reason: 'explicit' | 'unbound-allowed' }
  | {
      kind: 'reject'
      reason: 'unbound' | 'settings-not-loaded' | 'unknown-region-slug' | 'invalid-static-port' | 'invalid-dynamic-port'
    }

/** 纯判定：账号区域 → 出口。永不抛；reject 由调用方转成失败，绝不降级为 direct。 */
export function resolveRegionEgress(input: RegionEgressInput): RegionEgressDecision {
  const region = typeof input.region === 'string' ? input.region.trim() : ''
  if (region.length === 0) {
    return input.allowDirectForUnbound
      ? { kind: 'direct', reason: 'unbound-allowed' }
      : { kind: 'reject', reason: 'unbound' }
  }
  if (region === DIRECT_EGRESS_REGION) return { kind: 'direct', reason: 'explicit' }

  if (Object.prototype.hasOwnProperty.call(input.staticPorts, region)) {
    const port = input.staticPorts[region]
    return isValidProxyPort(port)
      ? { kind: 'proxy', port, source: 'static' }
      : { kind: 'reject', reason: 'invalid-static-port' }
  }

  if (!input.settingsLoaded) return { kind: 'reject', reason: 'settings-not-loaded' }

  if (Object.prototype.hasOwnProperty.call(input.dynamicPorts, region)) {
    const port = input.dynamicPorts[region]
    const staticPortTaken = Object.values(input.staticPorts).includes(port as number)
    return isValidProxyPort(port) && !staticPortTaken
      ? { kind: 'proxy', port, source: 'dynamic' }
      : { kind: 'reject', reason: 'invalid-dynamic-port' }
  }
  return { kind: 'reject', reason: 'unknown-region-slug' }
}

/** proxy 决策 → Mihomo loopback HTTP 代理 URL；其余 → null。 */
export function egressProxyUrl(decision: RegionEgressDecision): string | null {
  return decision.kind === 'proxy' ? `http://127.0.0.1:${decision.port}` : null
}
