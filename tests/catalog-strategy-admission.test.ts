/**
 * Catalog cache + strategy cache + model admission (copilot-api consumes the
 * gateway model catalog and routing strategy "the same way kiro-api does").
 * Fakes only.
 */
import { afterEach, describe, expect, test } from "bun:test"

import type { CatalogGateway, CatalogRow } from "~/gateway/catalog"
import type { StrategyGateway, StrategySnapshot } from "~/gateway/strategy"
import { requestContext } from "~/lib/request-context"
import {
  buildCatalogSnapshot,
  createCatalogCache,
  currentCatalog,
  initCatalogCache,
} from "~/models/advertised-models"
import { admitCopilotModel } from "~/policy/model-admission"
import {
  createStrategyCache,
  initStrategyCache,
} from "~/strategy/strategy-reader"

const GPT = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]

const MIG171_ROWS: CatalogRow[] = [
  ...GPT.map((id) => ({
    model_id: id,
    label: id.toUpperCase(),
    advertised: 1,
    enabled: 1,
  })),
  {
    model_id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    advertised: 0,
    enabled: 0,
  },
  {
    model_id: "claude-opus-5",
    label: "Claude Opus 5",
    advertised: 0,
    enabled: 0,
  },
]

const silent = { warn: () => {} }

function catalogOf(rows: CatalogRow[] | null | Error): CatalogGateway {
  return {
    listCopilotModels: () =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  }
}

function strategyOf(snap: StrategySnapshot | Error): StrategyGateway {
  return {
    readSnapshot: () =>
      snap instanceof Error ? Promise.reject(snap) : Promise.resolve(snap),
  }
}

function asUser<T>(userId: string | null, fn: () => T): T {
  return requestContext.run(
    {
      traceId: "t",
      startTime: 0,
      userAgent: "",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      gatewayKeyHash: "kh",
      gatewayUserId: userId,
    },
    fn,
  )
}

afterEach(() => {
  initCatalogCache(null)
  initStrategyCache(null)
})

describe("catalog snapshot", () => {
  test("advertised = enabled AND advertised, in catalog order; disabled Claude rows hidden", () => {
    const snap = buildCatalogSnapshot(MIG171_ROWS)!
    expect(snap.advertised.map((m) => m.id)).toEqual(GPT)
    expect(snap.enabled.has("claude-opus-5")).toBe(false)
    expect(snap.known.has("claude-opus-5")).toBe(true)
  })

  test("enabled-but-unadvertised model is admitted but not listed", () => {
    const snap = buildCatalogSnapshot([
      { model_id: "hidden", label: null, advertised: 0, enabled: 1 },
    ])!
    expect(snap.advertised).toEqual([])
    expect(snap.enabled.has("hidden")).toBe(true)
  })

  test("zero copilot rows (mig 171 not applied) → unavailable", () => {
    expect(buildCatalogSnapshot([])).toBeNull()
  })

  test("refresh error keeps the last-good snapshot", async () => {
    let rows: CatalogRow[] | Error = MIG171_ROWS
    const cache = createCatalogCache(
      {
        listCopilotModels: () =>
          rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
      },
      { logger: silent, autoStart: false },
    )
    await cache.refresh()
    rows = new Error("db down")
    await cache.refresh()
    expect(cache.snapshot()?.advertised).toHaveLength(7)
  })

  test("view missing (null) → unavailable", async () => {
    const cache = createCatalogCache(catalogOf(null), {
      logger: silent,
      autoStart: false,
    })
    await cache.refresh()
    expect(cache.snapshot()).toBeNull()
  })
})

describe("model admission", () => {
  test("enabled GPT model → admitted unchanged (identity, no strategy)", async () => {
    const cache = createCatalogCache(catalogOf(MIG171_ROWS), {
      logger: silent,
      autoStart: false,
    })
    await cache.refresh()
    initCatalogCache(cache)
    expect(asUser("u1", () => admitCopilotModel("gpt-6-sol"))).toEqual({
      ok: true,
      model: "gpt-6-sol",
      requestedModel: "gpt-6-sol",
    })
  })

  test("disabled Claude model → 400 invalid_request_error with a readable message", async () => {
    const cache = createCatalogCache(catalogOf(MIG171_ROWS), {
      logger: silent,
      autoStart: false,
    })
    await cache.refresh()
    initCatalogCache(cache)
    const out = asUser("u1", () => admitCopilotModel("claude-opus-5"))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.status).toBe(400)
    expect(out.body.error.type).toBe("invalid_request_error")
    expect(out.body.error.message).toContain("claude-opus-5")
    expect(out.body.error.message).toContain("/v1/models")
  })

  test("unknown model → 400", async () => {
    const cache = createCatalogCache(catalogOf(MIG171_ROWS), {
      logger: silent,
      autoStart: false,
    })
    await cache.refresh()
    initCatalogCache(cache)
    expect(asUser("u1", () => admitCopilotModel("gpt-4o")).ok).toBe(false)
  })

  test("catalog unavailable → no gate (pre-catalog behaviour)", () => {
    initCatalogCache(createCatalogCache(null, { autoStart: false }))
    expect(currentCatalog()).toBeNull()
    expect(asUser("u1", () => admitCopilotModel("anything")).ok).toBe(true)
  })

  test("strategy rule remaps downstream → upstream_model for that user only", async () => {
    const cache = createCatalogCache(catalogOf(MIG171_ROWS), {
      logger: silent,
      autoStart: false,
    })
    await cache.refresh()
    initCatalogCache(cache)
    const strategy = createStrategyCache(
      strategyOf({
        users: [{ user_id: "u1", strategy_id: "strat_default" }],
        rules: [
          {
            strategy_id: "strat_default",
            match_kind: "exact",
            match_value: "gpt-6-sol",
            upstream_model: "gpt-6-luna",
          },
        ],
      }),
      { logger: silent, autoStart: false },
    )
    await strategy.refresh()
    initStrategyCache(strategy)
    expect(asUser("u1", () => admitCopilotModel("gpt-6-sol"))).toMatchObject({
      ok: true,
      model: "gpt-6-luna",
    })
    expect(asUser("u2", () => admitCopilotModel("gpt-6-sol"))).toMatchObject({
      ok: true,
      model: "gpt-6-sol",
    })
  })

  test("a strategy rule cannot resurrect a disabled model (gate runs first)", async () => {
    const cache = createCatalogCache(catalogOf(MIG171_ROWS), {
      logger: silent,
      autoStart: false,
    })
    await cache.refresh()
    initCatalogCache(cache)
    const strategy = createStrategyCache(
      strategyOf({
        users: [{ user_id: "u1", strategy_id: "s" }],
        rules: [
          {
            strategy_id: "s",
            match_kind: "exact",
            match_value: "claude-opus-5",
            upstream_model: "claude-opus-5",
          },
        ],
      }),
      { logger: silent, autoStart: false },
    )
    await strategy.refresh()
    initStrategyCache(strategy)
    expect(asUser("u1", () => admitCopilotModel("claude-opus-5")).ok).toBe(
      false,
    )
  })
})

describe("strategy cache", () => {
  test("DB error on first load → identity (fail-open), logged", async () => {
    const warns: string[] = []
    const cache = createStrategyCache(strategyOf(new Error("boom")), {
      logger: { warn: (m) => void warns.push(m) },
      autoStart: false,
    })
    await cache.refresh()
    expect(cache.upstreamModelFor("u1", "gpt-6-sol")).toBeNull()
    expect(warns[0]).toContain("boom")
  })

  test("DB error after a good load keeps the last-good rules", async () => {
    let snap: StrategySnapshot | Error = {
      users: [{ user_id: "u1", strategy_id: "s" }],
      rules: [
        {
          strategy_id: "s",
          match_kind: "default",
          match_value: "",
          upstream_model: "gpt-6-luna",
        },
      ],
    }
    const cache = createStrategyCache(
      {
        readSnapshot: () =>
          snap instanceof Error ? Promise.reject(snap) : Promise.resolve(snap),
      },
      { logger: silent, autoStart: false },
    )
    await cache.refresh()
    snap = new Error("blip")
    await cache.refresh()
    expect(cache.upstreamModelFor("u1", "whatever")).toBe("gpt-6-luna")
  })

  test("60s refresh timer is stoppable (no leak)", () => {
    const cache = createStrategyCache(strategyOf({ users: [], rules: [] }), {
      logger: silent,
    })
    cache.stop()
    cache.stop()
  })
})
