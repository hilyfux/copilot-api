/**
 * Contract package offline manifest test (P4 S3 onboarding, 2026-10-21).
 *
 * src/contracts-pkg/ is copied verbatim by agent-gateway
 * `bun scripts/sync-contracts.ts --into ../copilot-api`; this repo never edits
 * it. Each file's header-stripped sha256 must equal MANIFEST.json, no stray
 * files, and contracts/VERSION == version.ts == MANIFEST. Drift is always
 * fixed by re-running the sync, never by editing here. No sibling repo needed.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import {
  CONTRACT_MAJOR,
  CONTRACT_MIN_COMPAT,
  CONTRACT_VERSION,
} from "~/contracts-pkg/version"

const ROOT = join(import.meta.dir, "..")
const PKG = join(ROOT, "src", "contracts-pkg")
type Manifest = {
  contractMajor: number
  contractVersion: number
  contractMinCompat: number
  files: Record<string, { sha256: string }>
}
const manifest = JSON.parse(
  readFileSync(join(PKG, "MANIFEST.json"), "utf8"),
) as Manifest

/** headerRule: .ts drops line 1 through the first line that is exactly ' *\/'. */
function digest(rel: string): string {
  const src = readFileSync(join(PKG, rel), "utf8")
  let body = src
  if (rel.endsWith(".ts")) {
    const lines = src.split("\n")
    const end = lines.findIndex((l) => l === " */")
    body = end >= 0 ? lines.slice(end + 1).join("\n") : src
  }
  return createHash("sha256").update(body).digest("hex")
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [relative(PKG, p)]
  })
}

describe("src/contracts-pkg matches its MANIFEST (offline)", () => {
  for (const [rel, meta] of Object.entries(manifest.files)) {
    test(rel, () => expect(digest(rel)).toBe(meta.sha256))
  }

  test("no stray files beyond MANIFEST (+ MANIFEST.json / version.ts)", () => {
    const extra = walk(PKG).filter(
      (r) =>
        !(r in manifest.files) && r !== "MANIFEST.json" && r !== "version.ts",
    )
    expect(extra).toEqual([])
  })

  test("version.ts == MANIFEST == contracts/VERSION (v3)", () => {
    expect([CONTRACT_MAJOR, CONTRACT_VERSION, CONTRACT_MIN_COMPAT]).toEqual([
      manifest.contractMajor,
      manifest.contractVersion,
      manifest.contractMinCompat,
    ])
    const env = Object.fromEntries(
      readFileSync(join(ROOT, "contracts", "VERSION"), "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
    ) as Record<string, string>
    expect([
      Number(env.CONTRACT_MAJOR),
      Number(env.CONTRACT_VERSION),
      Number(env.CONTRACT_MIN_COMPAT),
    ]).toEqual([CONTRACT_MAJOR, CONTRACT_VERSION, CONTRACT_MIN_COMPAT])
    expect(CONTRACT_VERSION).toBe(3)
  })
})

describe("billing / strategy decisions come from the package, not local copies", () => {
  test("billing gate + strategy reader import the package modules", () => {
    const gate = readFileSync(join(ROOT, "src/policy/billing-gate.ts"), "utf8")
    expect(gate).toContain('from "~/contracts-pkg/billing/charge-preference"')
    expect(gate).toContain('from "~/contracts-pkg/billing/windows"')
    expect(gate).toContain('from "~/contracts-pkg/billing/billing-decision"')
    const strategy = readFileSync(
      join(ROOT, "src/strategy/strategy-reader.ts"),
      "utf8",
    )
    expect(strategy).toContain('from "~/contracts-pkg/strategy/resolve"')
  })
})
