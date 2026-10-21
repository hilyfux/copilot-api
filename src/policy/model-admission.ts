/**
 * model-admission.ts — the one decision "may this downstream model be served,
 * and as which upstream model?", applied by every Copilot-served protocol face
 * (/v1/chat/completions, /v1/responses, /v1/messages) right before the
 * upstream call.
 *
 *   1. Catalog gate: when the gateway catalog is available, the requested id
 *      must be an ENABLED provider_type='copilot' row (advertised or not).
 *      Otherwise → a clean 400 invalid_request_error, no upstream round trip.
 *      Catalog unavailable → no gate (pre-catalog behaviour, fail-open).
 *   2. Strategy: the user's effective strategy rule for target_backend
 *      'copilot_api' may name an upstream_model; none → identity.
 *
 * The gate runs on the DOWNSTREAM id, before strategy, so a strategy rule can
 * never resurrect a model the operator disabled (Claude rows ship disabled).
 * No cross-family mapping is implied: copilot rules are identity mappings
 * (operator decision "各走各的").
 */
import { currentCatalog, findCatalogId } from "~/models/advertised-models"
import { requestContext } from "~/lib/request-context"
import { strategyUpstreamModelFor } from "~/strategy/strategy-reader"

export type ModelAdmission =
  | { ok: true; model: string; requestedModel: string }
  | { ok: false; status: 400; body: ModelRejectionBody }

/** Anthropic-envelope error (`type:"error"`), also readable by OpenAI clients. */
export type ModelRejectionBody = {
  type: "error"
  error: { type: "invalid_request_error"; message: string }
}

export function modelNotEnabledBody(model: string): ModelRejectionBody {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `The model '${model}' is not available on this service. Call GET /v1/models for the list of available models.`,
    },
  }
}

export function admitCopilotModel(requestedModel: string): ModelAdmission {
  const catalog = currentCatalog()
  // The id strategy rules are matched against: the catalog spelling when the
  // catalog knows the model, else the id as sent.
  let matchId = requestedModel
  if (catalog) {
    const catalogId = findCatalogId(catalog.enabled, requestedModel)
    if (!catalogId) {
      return {
        ok: false,
        status: 400,
        body: modelNotEnabledBody(requestedModel),
      }
    }
    matchId = catalogId
  }

  const userId = requestContext.getStore()?.gatewayUserId
  const upstream = strategyUpstreamModelFor(userId, matchId)
  return {
    ok: true,
    model: upstream && upstream !== matchId ? upstream : requestedModel,
    requestedModel,
  }
}
