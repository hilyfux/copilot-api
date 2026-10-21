/**
 * 契约包版本 —— P4（2026-10-16）。规则见 docs/data-contract.md「契约包」一节与
 * WORKSPACE-collab/contracts-pkg-design.md §3：
 *
 *  - CONTRACT_VERSION：正整数，单调递增。包里任何文件的去头内容变化 → 必须 +1，然后跑
 *    `bun scripts/contracts-manifest.ts` 重写 MANIFEST.json（版本没涨就改内容，脚本拒绝写、测试变红）。
 *  - 同一 major 内只扩展：新字段可选、新规则带默认、不删不改不收窄。
 *  - 收缩走下一个 major：CONTRACT_MAJOR +1；CONTRACT_MIN_COMPAT = 网关能接受的最旧代理契约版本，
 *    只在 major 切换时动。
 *  - 兼容关系：代理的 CONTRACT_VERSION ≤ 同主机网关的 CONTRACT_VERSION，且 ≥ 网关的 CONTRACT_MIN_COMPAT。
 *
 * 线上以进程 `/version` 的 contractsVersion / contractsMajor 为准（app_settings[contracts.version] 只做观测）。
 */
export const CONTRACT_MAJOR = 1
export const CONTRACT_VERSION = 2
export const CONTRACT_MIN_COMPAT = 1
