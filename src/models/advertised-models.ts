/**
 * Advertised-models cache — gateway `model_catalog` (provider_type='copilot')
 * as the source of /v1/models discovery and of the model admission gate.
 * Mirror of kiro-api `src/models/advertised-models.ts`.
 *
 * agent-gateway owns model_catalog; operators flip `advertised` / `enabled`
 * in /admin/models. This cache polls every 60s so a change takes effect
 * without a redeploy.
 *
 * Two answers from one snapshot:
 *   · advertised(): rows with advertised=1 AND enabled=1, catalog order.
 *   · isEnabled(model): enabled=1 (advertised or not).
 *
 * "Unavailable" (no gateway, view missing, never loaded, or a successful read
 * with ZERO copilot rows — i.e. mig 171 not applied) → `snapshot()` is null and
 * every caller keeps the pre-catalog behaviour: the raw upstream model list
 * and no admission gate. A refresh error keeps the last-good snapshot.
 */
import type { CatalogGateway, CatalogRow } from "~/gateway/catalog"
import { familyUpstreamPath } from "~/lib/copilot-upstream-path"
import { toClientModelId } from "~/lib/models"
import type { Model } from "~/lib/types/models"

export const CATALOG_REFRESH_MS = 60_000

export type AdvertisedCatalogModel = { id: string; label: string }

export type CatalogSnapshot = {
  advertised: AdvertisedCatalogModel[]
  enabled: ReadonlySet<string>
  known: ReadonlySet<string>
}

export type CatalogCache = {
  snapshot(): CatalogSnapshot | null
  refresh(): Promise<void>
  stop(): void
}

function truthy(value: number | boolean | null | undefined): boolean {
  return value === true || Number(value) === 1
}

export function buildCatalogSnapshot(
  rows: readonly CatalogRow[],
): CatalogSnapshot | null {
  if (rows.length === 0) return null
  const advertised: AdvertisedCatalogModel[] = []
  const enabled = new Set<string>()
  const known = new Set<string>()
  for (const row of rows) {
    const id = row.model_id.trim()
    if (!id) continue
    known.add(id)
    if (!truthy(row.enabled)) continue
    enabled.add(id)
    if (truthy(row.advertised)) {
      advertised.push({ id, label: row.label?.trim() || id })
    }
  }
  return { advertised, enabled, known }
}

export function createCatalogCache(
  catalog: CatalogGateway | null,
  opts: {
    logger?: { warn: (m: string) => void }
    refreshMs?: number
    autoStart?: boolean
  } = {},
): CatalogCache {
  let current: CatalogSnapshot | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let warnedEmpty = false
  const logger = opts.logger ?? {
    warn: (m: string) => console.warn(`[models] ${m}`),
  }

  async function refresh(): Promise<void> {
    if (!catalog) return
    try {
      const rows = await catalog.listCopilotModels()
      if (rows === null) {
        current = null
        return
      }
      current = buildCatalogSnapshot(rows)
      if (!current && !warnedEmpty) {
        warnedEmpty = true
        logger.warn(
          "model_catalog has no provider_type='copilot' rows — serving the upstream model list and not gating models until it does",
        )
      }
      if (current) warnedEmpty = false
    } catch (err) {
      logger.warn(
        `refresh failed (keeping last-good catalog${current ? "" : "; none yet → upstream model list"}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  if (catalog && opts.autoStart !== false) {
    void refresh()
    timer = setInterval(
      () => void refresh(),
      opts.refreshMs ?? CATALOG_REFRESH_MS,
    )
    if (typeof timer.unref === "function") timer.unref()
  }

  return {
    snapshot: () => current,
    refresh,
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

/**
 * Catalog spellings a downstream id may arrive in: as sent, without the
 * Claude discovery `[1m]` suffix, and in the client-friendly Claude form
 * (`claude-sonnet-4.6` → `claude-sonnet-4-6`).
 */
export function catalogIdCandidates(model: string): string[] {
  const trimmed = model.trim()
  const noSuffix = trimmed.replace(/\[1m\]$/i, "")
  return [...new Set([trimmed, noSuffix, toClientModelId(noSuffix)])]
}

export function findCatalogId(
  ids: ReadonlySet<string>,
  model: string,
): string | null {
  for (const candidate of catalogIdCandidates(model)) {
    if (ids.has(candidate)) return candidate
  }
  return null
}

const FAMILY_ENDPOINT = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/v1/messages",
} as const

/** Minimal upstream-shaped record for a catalog model the upstream list lacks. */
function synthesizeModel(entry: AdvertisedCatalogModel): Model {
  const family = familyUpstreamPath(entry.id)
  return {
    id: entry.id,
    name: entry.label,
    object: "model",
    vendor: "copilot",
    version: entry.id,
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: entry.id,
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    ...(family ? { supported_endpoints: [FAMILY_ENDPOINT[family]] } : {}),
  }
}

/**
 * The copilot model records /v1/models advertises when the catalog is
 * available: EXACTLY the catalog's advertised rows, in catalog order — each
 * enriched with the upstream /models record when GitHub lists it (context
 * window, reasoning efforts, endpoints), else a minimal synthesized record
 * carrying the catalog label. Upstream models absent from the catalog are not
 * advertised.
 */
export function selectAdvertisedCopilotModels(
  advertised: ReadonlyArray<AdvertisedCatalogModel>,
  upstream: ReadonlyArray<Model>,
): Array<Model> {
  return advertised.map((entry) => {
    const match = upstream.find((model) =>
      catalogIdCandidates(model.id).includes(entry.id),
    )
    return match ?
        { ...match, name: entry.label || match.name }
      : synthesizeModel(entry)
  })
}

// ── Module singleton ────────────────────────────────────────────────────────
let installed: CatalogCache | null = null

export function initCatalogCache(cache: CatalogCache | null): void {
  installed?.stop()
  installed = cache
}

/** Current catalog snapshot, or null = unavailable (keep upstream behaviour). */
export function currentCatalog(): CatalogSnapshot | null {
  return installed?.snapshot() ?? null
}
