/**
 * copilot-upstream-path.ts — which upstream Copilot endpoint can serve a model.
 *
 * GitHub binds each model to its endpoints strictly; the wrong one answers 400
 * (`unsupported_api_for_model`). Measured on an enterprise seat (operator
 * report, 2026-08, ~480 calls) and live 2026-10-21:
 *   /chat/completions ← gpt-4.x, gpt-4o, gemini
 *   /responses        ← gpt-5.x (5.6 terra/sol/luna, 5.5, 5.4-mini,
 *                        5.3-codex), the gpt-6 family, grok-4.5
 *   /v1/messages      ← every Claude model
 *
 * Decision order (documented choice: metadata first):
 *   1. The upstream /models metadata `supported_endpoints`, when the model is
 *      listed and the field is non-empty — the authority, follows GitHub as it
 *      changes without a code edit.
 *   2. Else the family table above — so a model missing from a stale or
 *      not-yet-loaded model list still reaches the right endpoint.
 *   3. Else unknown → chat/completions (the pre-existing behaviour), and the
 *      chat handler additionally retries ONCE on Responses if upstream answers
 *      400 unsupported_api_for_model (stale-metadata safety net).
 */

export type CopilotUpstreamPath = "chat_completions" | "responses" | "messages"

const ENDPOINT_TO_PATH: Record<string, CopilotUpstreamPath> = {
  "/chat/completions": "chat_completions",
  "/v1/chat/completions": "chat_completions",
  "/responses": "responses",
  "/v1/responses": "responses",
  "ws:/responses": "responses",
  "/v1/messages": "messages",
}

export function pathsFromSupportedEndpoints(
  endpoints: ReadonlyArray<string> | undefined,
): Set<CopilotUpstreamPath> {
  const out = new Set<CopilotUpstreamPath>()
  for (const endpoint of endpoints ?? []) {
    const path = ENDPOINT_TO_PATH[endpoint]
    if (path) out.add(path)
  }
  return out
}

/** Family table (fallback when metadata is absent). */
export function familyUpstreamPath(
  modelId: string,
): CopilotUpstreamPath | null {
  const id = modelId.trim().toLowerCase()
  if (id.startsWith("claude-")) return "messages"
  if (/^gpt-(5|6|7)(\b|[.-])/.test(id) || id.includes("codex")) {
    return "responses"
  }
  if (id.startsWith("grok-")) return "responses"
  if (id.startsWith("gpt-4") || id.startsWith("gemini")) {
    return "chat_completions"
  }
  return null
}

/** Every upstream path that can serve `modelId`, metadata first, then the family table. */
export function servablePaths(
  modelId: string,
  metadata: { supported_endpoints?: Array<string> } | undefined,
): Set<CopilotUpstreamPath> {
  const fromMetadata = pathsFromSupportedEndpoints(
    metadata?.supported_endpoints,
  )
  if (fromMetadata.size > 0) return fromMetadata
  const family = familyUpstreamPath(modelId)
  return new Set(family ? [family] : [])
}

/**
 * True when /v1/chat/completions must be served through the Responses API:
 * the model is servable on /responses and NOT on /chat/completions.
 */
export function chatNeedsResponses(
  modelId: string,
  metadata: { supported_endpoints?: Array<string> } | undefined,
): boolean {
  const paths = servablePaths(modelId, metadata)
  return paths.has("responses") && !paths.has("chat_completions")
}

/** Upstream 400 body that means "this model is not on this endpoint". */
export function isUnsupportedApiForModel(body: string): boolean {
  return body.includes("unsupported_api_for_model")
}

const PATH_TO_ENDPOINT: Record<CopilotUpstreamPath, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/v1/messages",
}

/**
 * Endpoint metadata to route on: the upstream record's own
 * `supported_endpoints` when present, else the family table's endpoint —
 * so a model missing from a stale model list is still sent to the path
 * GitHub binds it to instead of the chat/completions default.
 */
export function routingEndpoints(
  modelId: string,
  metadata: { supported_endpoints?: Array<string> } | undefined,
): { supported_endpoints?: Array<string> } | undefined {
  if (
    metadata?.supported_endpoints
    && metadata.supported_endpoints.length > 0
  ) {
    return metadata
  }
  const family = familyUpstreamPath(modelId)
  return family ? { supported_endpoints: [PATH_TO_ENDPOINT[family]] } : metadata
}
