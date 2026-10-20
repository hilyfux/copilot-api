import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import {
  createAuthMiddleware,
  getConfiguredAdminApiKeys,
} from "./lib/request-auth"
import { traceIdMiddleware } from "./lib/trace"
import type { ManagedAuthenticator } from "./users/managed-auth"
import { createManagedAuthMiddleware } from "./users/managed-auth-middleware"
import { alphaSearchRoutes } from "./routes/alpha-search/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { configRoutes } from "./routes/admin/config/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { imageRoutes } from "./routes/images/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerAlphaSearchRoutes } from "./routes/provider/alpha-search/route"
import { providerImageRoutes } from "./routes/provider/images/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { providerResponsesRoutes } from "./routes/provider/responses/route"
import { responsesRoutes } from "./routes/responses/route"
import { usageRoute } from "./routes/usage/route"
import { videoRoutes } from "./routes/videos/route"
export interface CreateServerOptions {
  networkExposed?: boolean
  /**
   * Authenticates downstream client keys against agent-gateway.
   * `null` = standalone mode (no gateway database configured).
   */
  authenticator?: ManagedAuthenticator | null
}

function resolveSameOriginCorsOrigin(
  origin: string,
  context: Context,
): string | null {
  if (!origin) {
    return null
  }

  try {
    return origin === new URL(context.req.url).origin ? origin : null
  } catch {
    return null
  }
}

export function createServer(options: CreateServerOptions = {}): Hono {
  const server = new Hono()
  const networkExposed = options.networkExposed ?? false

  server.use(traceIdMiddleware)
  server.use(logger())
  server.use(
    networkExposed ? cors({ origin: resolveSameOriginCorsOrigin }) : cors(),
  )
  server.use(
    "*",
    createManagedAuthMiddleware(options.authenticator ?? null, {
      // "/health" is probed by the container runtime with no credential; it must
      // never require one or every container would report unhealthy.
      allowUnauthenticatedPaths: ["/", "/health"],
    }),
  )
  server.use(
    "/admin/*",
    createAuthMiddleware({
      getApiKeys: getConfiguredAdminApiKeys,
      allowUnauthenticatedPaths: [],
      allowWhenNoApiKeys: false,
    }),
  )

  server.get("/", (c) => c.text("Server running"))

  /**
   * Health probe. agent-stack's Dockerfile.proxy HEALTHCHECK curls /health and
   * every other proxy answers there, so this service answers there too rather
   * than making the shared recipe aware of a per-service path. Deliberately
   * dumb: it reports that the process is serving, not that the upstream is
   * reachable — a missing Copilot credential must NOT make the container
   * unhealthy (the operator imports it after the system is live).
   */
  server.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "copilot-api",
    }),
  )

  server.route("/chat/completions", completionRoutes)
  server.route("/admin/config", configRoutes)
  server.route("/models", modelRoutes)
  server.route("/embeddings", embeddingRoutes)
  server.route("/usage", usageRoute)
  server.route("/responses", responsesRoutes)
  server.route("/alpha/search", alphaSearchRoutes)
  server.route("/images", imageRoutes)
  server.route("/videos", videoRoutes)

  // Compatibility with tools that expect v1/ prefix
  server.route("/v1/chat/completions", completionRoutes)
  server.route("/v1/models", modelRoutes)
  server.route("/v1/embeddings", embeddingRoutes)
  server.route("/v1/responses", responsesRoutes)
  server.route("/v1/alpha/search", alphaSearchRoutes)
  server.route("/v1/images", imageRoutes)
  server.route("/v1/videos", videoRoutes)

  // Anthropic compatible endpoints
  server.route("/v1/messages", messageRoutes)

  // Provider scoped endpoints
  server.route("/:provider/v1/messages", providerMessageRoutes)
  server.route("/:provider/v1/models", providerModelRoutes)
  server.route("/:provider/v1/responses", providerResponsesRoutes)
  server.route("/:provider/v1/alpha/search", providerAlphaSearchRoutes)
  server.route("/:provider/v1/images", providerImageRoutes)

  server.route("/:provider/models", providerModelRoutes)
  server.route("/:provider/responses", providerResponsesRoutes)
  server.route("/:provider/alpha/search", providerAlphaSearchRoutes)
  server.route("/:provider/images", providerImageRoutes)

  return server
}

export const server = createServer()
