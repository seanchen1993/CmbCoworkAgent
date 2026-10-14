import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { assertHostPackageSupported } from "./package-preflight"
import { hostProjectFixture } from "./host-fixtures.test-helper"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
it("diagnoses unsupported package runtimes before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "package-preflight-"))
  roots.push(root)
  const runtime = hostProjectFixture(root).manifest
  for (const stage of runtime.stages) {
    mkdirSync(join(root, "skills", stage.id), { recursive: true })
    writeFileSync(join(root, stage.skill!), "Instructions")
  }
  const manifest = { name: "docs", version: "1.0.0" }
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest))
  expect(() => assertHostPackageSupported(root, runtime)).not.toThrow()
  mkdirSync(join(root, "hooks"))
  writeFileSync(join(root, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PINNED_MODS_UNSUPPORTED")
  writeFileSync(join(root, "hooks/hooks.json"), '{"hooks":{}}')
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ ...manifest, mods: "mods.json" }))
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PINNED_MODS_UNSUPPORTED")
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ ...manifest, mcpServers: ".mcp.json" }))
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PINNED_MCP_UNSUPPORTED")
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest))
  writeFileSync(join(root, ".mcp.json"), "{}")
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PINNED_MCP_UNSUPPORTED")
})
