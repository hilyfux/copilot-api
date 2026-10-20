import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class UpstreamHeadersTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Upstream did not return headers within ${timeoutMs}ms`)
    this.name = "UpstreamHeadersTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export class UpstreamStreamInactivityTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Upstream stream was inactive for ${timeoutMs}ms`)
    this.name = "UpstreamStreamInactivityTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export async function forwardError(
  c: Context,
  error: unknown,
): Promise<Response> {
  if (
    error instanceof UpstreamHeadersTimeoutError
    || error instanceof UpstreamStreamInactivityTimeoutError
  ) {
    consola.error("Error occurred:", error)
    return c.json(
      {
        error: {
          message: error.message,
          type: "upstream_timeout",
        },
      },
      504,
    )
  }

  if (c.req.raw.signal.aborted || isAbortError(error)) {
    return new Response(null, {
      status: 499,
      statusText: "Client Closed Request",
    })
  }

  // No credential is a CONFIGURATION state: the proxy is up and the route
  // exists, a prerequisite is missing. Answering 500 tells the caller to retry
  // a request that will fail identically until a human imports an account, and
  // it makes a misconfigured proxy indistinguishable from a healthy one to any
  // monitor or deploy gate comparing 5xx baselines. Mapped here, in the single
  // error funnel, so routes added later inherit it.
  if (error instanceof Error && error.message === "Copilot token not found") {
    consola.warn("No Copilot credential configured — request refused (503)")
    return c.json(
      {
        error: {
          type: "service_unavailable",
          message:
            "No Copilot account is configured with an access token. Import one in the gateway admin (providers → GitHub Copilot → add account), then retry.",
        },
      },
      503,
    )
  }

  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    if (error.response.status === 429) {
      for (const [name, value] of error.response.headers) {
        const lowerName = name.toLowerCase()
        if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
          c.header(name, value)
        }
      }
    }

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"
