import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { PluginMetadata } from "../../types"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { fixedCatalogPlugin } from "./catalog-source"

it("verifies a worker source independently and rejects tamper, scope drift and disabled installation", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-worker-source-"))
  try {
    const installed = join(root, "installed")
    mkdirSync(installed)
    const manifest = hostProjectFixture(root).manifest
    manifest.mode = "legacy"
    manifest.stateOwner = "plugin"
    writeFileSync(join(installed, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    writeFileSync(join(installed, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
    const snapshot = new HostPackageSnapshots(join(root, "snapshots")).capture(installed)
    const plugin = {
      id: "installation",
      name: "docs",
      enabled: true,
      path: installed,
      version: "2.0.0"
    } as PluginMetadata
    const source = {
      projectId: "project",
      installedPluginId: plugin.id,
      root: snapshot.root,
      packageDigest: snapshot.digest
    }
    expect(fixedCatalogPlugin("project", plugin, source)).toMatchObject({
      path: snapshot.root,
      version: "1.0.0"
    })
    expect(() => fixedCatalogPlugin("other", plugin, source)).toThrow("BINDING_CHANGED")
    expect(() => fixedCatalogPlugin("project", { ...plugin, enabled: false }, source)).toThrow(
      "BINDING_CHANGED"
    )
    expect(fixedCatalogPlugin("project", plugin)).toBe(plugin)
    writeFileSync(join(snapshot.root, "plugin.json"), '{"name":"docs","version":"tampered"}')
    expect(() => fixedCatalogPlugin("project", plugin, source)).toThrow("PACKAGE_CHANGED")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
