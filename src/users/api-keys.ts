/**
 * api-keys.ts — downstream client-key hashing.
 *
 * `agent_gateway.client_keys.key_hash` may hold either the hex or the
 * base64url form of sha256(rawKey) depending on when the key was minted, so both
 * are computed and matched. Same rule as kiro-api / codex-api — one key format
 * across every proxy.
 */
import { createHash, timingSafeEqual } from "node:crypto"

export function hashClientKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

export function hashClientKeyBothEncodings(key: string): {
  hex: string
  base64url: string
} {
  const sha = createHash("sha256").update(key).digest()
  return { hex: sha.toString("hex"), base64url: sha.toString("base64url") }
}

export function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/** Extract the presented key from a request: `x-api-key` or `Authorization: Bearer`. */
export function presentedKey(request: Request): string | null {
  const apiKey = request.headers.get("x-api-key")
  if (apiKey) return apiKey.trim()
  const authorization = request.headers.get("authorization")
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim()
  }
  return null
}
