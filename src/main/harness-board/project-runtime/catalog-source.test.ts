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
import { RetainedPackageSnapshots } from "./package-snapshots"
it("keeps an unopted original parent board context pinned without inventing a flow manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "parent-worker-source-"))
  try {
    const installed = join(root, "installed")
    mkdirSync(join(installed, "board_core"), { recursive: true })
    writeFileSync(join(installed, "plugin.json"), '{"name":"original","version":"1"}')
    writeFileSync(join(installed, "board_core/board_config.json"), '{"source":"retained"}')
    const snapshot = new RetainedPackageSnapshots(join(root, "snapshots")).capture(installed)
    const plugin = { id: "original", name: "original", version: "1", enabled: true, path: installed } as PluginMetadata
    writeFileSync(join(installed, "board_core/board_config.json"), '{"source":"changed"}')
    expect(fixedCatalogPlugin("parent", plugin, { mode: "capabilities", projectId: "parent",
      installedPluginId: "original", root: snapshot.root, packageDigest: snapshot.digest })?.path).toBe(snapshot.root)
    expect(() => fixedCatalogPlugin("parent", { ...plugin, version: "2" }, { mode: "capabilities", projectId: "parent",
      installedPluginId: "original", root: snapshot.root, packageDigest: snapshot.digest })).toThrow("SOURCE_CHANGED")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
