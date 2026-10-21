/**
 * 静态区域 → Mihomo 监听端口表 —— 契约包（P4，2026-10-16）。
 *
 * 唯一定义处。之前三份：codex-api / kiro-api `src/upstream/region-proxy.ts` 的 REGION_PROXY_PORT
 * 各一份，网关 `src/regions/registry.ts` 每行再手写 proxyPort。现在注册表每行从这里取端口，代理 sync
 * 本包后从这里 import（region-proxy.ts 里只剩带 https-proxy-agent 的 fetch 工厂，不是契约）。
 *
 * 只含**静态基础区域**。DYN 槽位（7906–7913）与节点池自动分配段（7918–7999）是运行时经
 * `app_settings.region_dynamic_slots` 发布的，由 bridge/region-egress-contract.ts 解析，不在这里。
 *
 * 演进：只加不改。端口一经分配永不改、永不复用（改端口 = 绑在该区域的账号换出口 = 跨区）。
 * 加一个静态区域 = 这里加一行 + 网关 registry.ts 加一行 + 主机 Mihomo config.yaml 加 listener，
 * 契约包升 CONTRACT_VERSION，各代理 sync。
 */

export const REGION_PROXY_PORT = {
  singapore:   7893,
  japan:       7894,
  us:          7895,
  korea:       7896,
  taiwan:      7897,
  dubai:       7898,
  switzerland: 7899,
  australia:   7900,
  india:       7901,
  thailand:    7902,
  'taiwan-home':    7903,
  'singapore-home': 7904,
  'hong-kong':      7905,
  'sg-mel':         7914,
  'sg-a':           7915,
  'sg-b':           7916,
  'us-home':        7917,
} as const satisfies Readonly<Record<string, number>>

/** 有静态端口的区域 slug。 */
export type StaticRegionSlug = keyof typeof REGION_PROXY_PORT
