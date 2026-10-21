/**
 * ISO 3166-1 alpha-2 aliases for canonical region slugs.
 *
 * agent-gateway is the single source of truth for region slugs
 * (`singapore` / `japan` / `korea` / …). Historically a small number of
 * provider_accounts.network_region rows were written with 2-letter ISO
 * codes (e.g. `kr`, `jp`, `tw`) — likely from a legacy admin entry path
 * before slug validation existed. Those rows cannot be retroactively
 * normalized server-side without coordinating an agent-gateway migration,
 * so proxies must accept the aliases at read time.
 *
 * Mirrors claude-api/src/upstream/region-aliases.ts. When adding a region
 * to agent-gateway/src/regions/registry.ts, add its alpha-2 alias here
 * AND in the claude-api sibling.
 */

export const REGION_ALIASES: Readonly<Record<string, string>> = {
  sg: 'singapore',
  jp: 'japan',
  // `us` is already canonical; listed to keep the mapping exhaustive
  us: 'us',
  kr: 'korea',
  tw: 'taiwan',
  ae: 'dubai',
  ch: 'switzerland',
  au: 'australia',
  in: 'india',
  th: 'thailand',
  hk: 'hong-kong',
  ph: 'philippines',
  // ISO 3166 alpha-2 for the United Kingdom is GB; `uk` is already the canonical slug.
  gb: 'uk',
}

/**
 * Returns the canonical region slug for a value that may be either an
 * agent-gateway canonical slug (passed through unchanged) or a 2-letter
 * ISO alpha-2 alias (translated via REGION_ALIASES). Unknown values fall
 * through unchanged so downstream lookups still produce the existing
 * "unknown region" diagnostics. Null/empty input returns null.
 *
 * Case-insensitive: 'KR' and 'kr' both map to 'korea'.
 */
export function normalizeRegion(region: string | null | undefined): string | null {
  if (!region) return null
  const lower = region.toLowerCase()
  return REGION_ALIASES[lower] ?? lower
}
