/**
 * gateway/catalog.ts — model_catalog read path (GET /v1/models + the model
 * admission gate), through the versioned view `v_proxy_catalog_v1`.
 *
 * Columns read: provider_type (WHERE), model_id, label, advertised, enabled,
 * display_order (ORDER BY). One query feeds both consumers: the advertised
 * list (advertised=1 AND enabled=1, like kiro-api) and the enabled set (a
 * request for a non-enabled model is refused before any upstream round trip).
 *
 * `null` = the catalog is not readable on this host yet (view / grant missing,
 * errno 1146/1142) — the caller keeps the pre-catalog behaviour (upstream
 * model list, no admission gate). errno 1356 and every other fault reject.
 */
import type { RowDataPacket } from "mysql2/promise"

import type { GatewayPool, Queryable } from "./db"
import { viewOrFallback } from "./view-fallback"

/** The model_catalog family this proxy serves. */
export const COPILOT_CATALOG_PROVIDER_TYPE = "copilot"

export type CatalogRow = {
  model_id: string
  label: string | null
  advertised: number | boolean | null
  enabled: number | boolean | null
}

const SELECT_COPILOT_CATALOG = `
  SELECT model_id, label, advertised, enabled
    FROM v_proxy_catalog_v1
   WHERE provider_type = ?
   ORDER BY display_order, model_id`

export async function selectCopilotCatalog(
  db: Queryable,
): Promise<CatalogRow[] | null> {
  return viewOrFallback(
    "v_proxy_catalog_v1",
    async () => {
      const [rows] = await db.query<(RowDataPacket & CatalogRow)[]>(
        SELECT_COPILOT_CATALOG,
        [COPILOT_CATALOG_PROVIDER_TYPE],
      )
      return rows
    },
    () => null,
  )
}

export type CatalogGateway = {
  /** Every copilot catalog row (any enabled/advertised), or null when unreadable. */
  listCopilotModels(): Promise<CatalogRow[] | null>
}

export function createCatalogGateway(pool: GatewayPool): CatalogGateway {
  return { listCopilotModels: () => selectCopilotCatalog(pool) }
}
