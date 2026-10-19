import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { assertHostPackageSupported } from "./package-preflight"
import { hostProjectFixture } from "./host-fixtures.test-helper"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
it("admits bounded same-package extensions and rejects incomplete or unsupported declarations", () => {
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
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
  writeFileSync(join(root, "hooks/register.ts"), "export function register() {}")
  expect(() => assertHostPackageSupported(root, runtime)).not.toThrow()
  writeFileSync(join(root, "hooks/hooks.json"), '{"hooks":{}}')
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ ...manifest, mods: "mods.json" }))
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ ...manifest, mcpServers: ".mcp.json" }))
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest))
  writeFileSync(join(root, ".mcp.json"), "{}")
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PROJECT_MCP_CONFIG_INVALID")
  writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{"local":{"command":"node","args":[]}}}')
  expect(() => assertHostPackageSupported(root, runtime)).not.toThrow()
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ ...manifest, mcpServers: "unconsumed.json" }))
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PROJECT_MCP_PATH_UNSUPPORTED")
})

it.each([false, true])("admits real flat Hook files at the original Host boundary (explicit=%s)", (explicit) => {
  const root = mkdtempSync(join(tmpdir(), "package-flat-hooks-"))
  roots.push(root)
  const runtime = hostProjectFixture(root).manifest
  for (const stage of runtime.stages) {
    mkdirSync(join(root, "skills", stage.id), { recursive: true })
    writeFileSync(join(root, stage.skill!), "Instructions")
  }
  writeFileSync(join(root, "plugin.json"), JSON.stringify({
    name: "docs", version: "1.0.0", ...(explicit ? { hooks: "hooks/hooks.json" } : {})
  }))
  mkdirSync(join(root, "hooks"))
  writeFileSync(join(root, "hooks/hooks.json"), JSON.stringify([
    { id: "integrity", event: "Stop", type: "command", command: "python check.py" }
  ]))
  expect(() => assertHostPackageSupported(root, runtime)).not.toThrow()
  writeFileSync(join(root, "hooks/hooks.json"), "[{")
  expect(() => assertHostPackageSupported(root, runtime)).toThrow(SyntaxError)
  writeFileSync(join(root, "hooks/hooks.json"), "null")
  expect(() => assertHostPackageSupported(root, runtime)).toThrow("PROJECT_EXTENSION_RESOURCE_MISSING")
})
