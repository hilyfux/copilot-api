/**
 * /v1/models advertises EXACTLY the gateway catalog rows with
 * provider_type='copilot' AND advertised=1 AND enabled=1 (like kiro-api
 * advertised-models.ts) instead of the raw upstream list; catalog unavailable
 * → the upstream list, unchanged. Fakes only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { CatalogRow } from "~/gateway/catalog"
import { state } from "~/lib/state"
import {
  createCatalogCache,
  initCatalogCache,
  selectAdvertisedCopilotModels,
} from "~/models/advertised-models"
import { getCopilotModelRecords } from "~/routes/models/model-discovery"
import { modelRoutes } from "~/routes/models/route"

const ROWS: CatalogRow[] = [
  { model_id: "gpt-6-sol", label: "GPT-6 Sol", advertised: 1, enabled: 1 },
  { model_id: "gpt-6-astra", label: "GPT-6 Astra", advertised: 1, enabled: 1 },
  {
    model_id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    advertised: 0,
    enabled: 0,
  },
]

const upstream = [
  {
    id: "gpt-6-sol",
    name: "raw",
    supported_endpoints: ["/responses"],
    capabilities: { limits: { max_prompt_tokens: 400000 }, supports: {} },
  },
  {
    id: "gpt-4o",
    name: "gpt-4o",
    supported_endpoints: ["/chat/completions"],
    capabilities: { limits: {}, supports: {} },
  },
  {
    id: "claude-sonnet-4.6",
    name: "c",
    supported_endpoints: ["/v1/messages"],
    capabilities: { limits: {}, supports: {} },
  },
]

const originalModels = state.models

async function installCatalog(rows: CatalogRow[] | null) {
  const cache = createCatalogCache(
    { listCopilotModels: () => Promise.resolve(rows) },
    { autoStart: false, logger: { warn: () => {} } },
  )
  await cache.refresh()
  initCatalogCache(cache)
}

beforeEach(() => {
  state.models = {
    object: "list",
    data: upstream,
  } as unknown as typeof state.models
})

afterEach(() => {
  initCatalogCache(null)
  state.models = originalModels
})

describe("catalog-driven copilot model records", () => {
  test("exactly the advertised+enabled rows, in catalog order; upstream metadata kept; label applied", async () => {
    await installCatalog(ROWS)
    const records = getCopilotModelRecords()
    expect(records.map((m) => m.id)).toEqual(["gpt-6-sol", "gpt-6-astra"])
    expect(records[0].capabilities.limits.max_prompt_tokens).toBe(400000)
    expect(records[0].name).toBe("GPT-6 Sol")
    // not listed upstream → synthesized, routed by the family table
    expect(records[1].supported_endpoints).toEqual(["/responses"])
  })

  test("catalog unavailable → raw upstream list", async () => {
    await installCatalog(null)
    expect(getCopilotModelRecords().map((m) => m.id)).toEqual([
      "gpt-6-sol",
      "gpt-4o",
      "claude-sonnet-4.6",
    ])
  })

  test("Claude catalog id (hyphen) matches the dotted upstream record", () => {
    const out = selectAdvertisedCopilotModels(
      [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
      upstream as never,
    )
    expect(out[0].id).toBe("claude-sonnet-4.6")
  })

  test("GET /v1/models (default client) lists only the catalog ids", async () => {
    await installCatalog(ROWS)
    const app = new Hono()
    app.route("/v1/models", modelRoutes)
    const res = await app.request("/v1/models", {
      headers: { "user-agent": "curl/8" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain("gpt-6-sol")
    expect(ids).toContain("gpt-6-astra")
    expect(ids).not.toContain("gpt-4o")
    expect(ids.some((id) => id.startsWith("claude"))).toBe(false)
  })
})
