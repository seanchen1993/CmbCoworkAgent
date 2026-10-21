import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { PluginStartUseService } from "./plugin-start-use"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { derivationContentIdentity, snapshotDerivationSource } from "./derivation-source"
import type { PluginMetadata } from "../types"
import { withPluginCatalogMutation } from "./catalog-mutation"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(name = "docs", host = true) {
  const root = mkdtempSync(join(tmpdir(), "plugin-start-use-"))
  roots.push(root)
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  const manifest = hostProjectFixture(root).manifest
  manifest.plugin.id = name
  if (host) {
    writeFileSync(join(root, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    for (const stage of manifest.stages) {
      mkdirSync(join(root, "skills", stage.id), { recursive: true })
      writeFileSync(
        join(root, stage.skill!),
        "Preserve checks and produce actual project artifacts."
      )
    }
  }
  let plugins: PluginMetadata[] = [
    {
      id: "own-install",
      name,
      version: "1.0.0",
      path: root,
      enabled: true,
      updatedAt: "one",
      createdAt: "one",
      description: "",
      author: "",
      skillCount: 0,
      mcpServerCount: 0
    }
  ]
  const input = {
    threadId: "creator",
    expectedWorkspace: root,
    pluginId: "own-install",
    expected: { name, version: "1.0.0" }
  }
  return {
    root,
    input,
    plugins: () => plugins,
    replace: (next: PluginMetadata[]) => (plugins = next)
  }
}

it.each(["docs", "warehouse-quality"])(
  "discovers the native project form for %s without creating or executing",
  async (name) => {
    const f = fixture(name)
    const diagnostics = vi.fn(async () => [
      {
        code: "permission" as const,
        resolution: "project-form" as const,
        message: "创建后仍需原生批准。"
      }
    ])
    const service = new PluginStartUseService({ plugins: f.plugins, diagnostics })
    const report = await service.prepare(f.input, () => {})
    expect(report).toMatchObject({
      kind: "host-project",
      canOpen: true,
      identity: { pluginId: f.input.pluginId, name, version: "1.0.0" },
      issues: [{ code: "permission", resolution: "project-form" }]
    })
    expect(report.identity.digest).toBe(
      derivationContentIdentity((await snapshotDerivationSource(f.root)).files)
    )
    expect(diagnostics).toHaveBeenCalledOnce()
  }
)

it("routes an installed ordinary plugin to chat and a legacy project to its original form", async () => {
  const f = fixture("chat-helper", false)
  const service = new PluginStartUseService({ plugins: f.plugins })
  expect((await service.prepare(f.input, () => {})).kind).toBe("chat")
  mkdirSync(join(f.root, "board_core"))
  writeFileSync(join(f.root, "board_core/board_config.json"), "{}")
  expect((await service.prepare(f.input, () => {})).kind).toBe("plugin-project")
})

it("keeps a newly installed disabled plugin inert until exact explicit enablement, then diagnoses fresh", async () => {
  const f = fixture()
  f.replace(f.plugins().map((plugin) => ({ ...plugin, enabled: false })))
  const diagnostics = vi.fn(async () => [])
  const enable = vi.fn(async (_id, guard) => {
    guard()
    f.replace(f.plugins().map((plugin) => ({ ...plugin, enabled: true, updatedAt: "enabled" })))
  })
  const service = new PluginStartUseService({ plugins: f.plugins, diagnostics, enable })
  const report = await service.prepare(f.input, () => {})
  expect(report).toMatchObject({ canOpen: false, activationRequired: true })
  expect(enable).not.toHaveBeenCalled()
  expect(diagnostics).not.toHaveBeenCalled()
  await expect(service.enable(f.input, () => {})).rejects.toThrow("EXACT_IDENTITY_REQUIRED")
  const ready = await service.enable({ ...f.input, expected: report.identity }, () => {})
  expect(ready).toMatchObject({ canOpen: true })
  expect(ready.activationRequired).toBeUndefined()
  expect(enable).toHaveBeenCalledOnce()
  expect(diagnostics).toHaveBeenCalledOnce()
})

it.each(["removed", "version", "bytes", "scope", "account"])(
  "does not enable an old installation when %s changes while waiting for the native catalog lock",
  async (change) => {
    const f = fixture()
    f.replace(f.plugins().map((plugin) => ({ ...plugin, enabled: false })))
    const enable = vi.fn(async () => {})
    const service = new PluginStartUseService({ plugins: f.plugins, enable })
    const report = await service.prepare(f.input, () => {})
    let release!: () => void
    const held = withPluginCatalogMutation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await Promise.resolve()
    let current = true
    const action = service.enable({ ...f.input, expected: report.identity }, () => {
      if (!current) throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
    })
    const rejected = expect(action).rejects.toThrow()
    if (change === "removed") f.replace([])
    if (change === "version")
      f.replace(f.plugins().map((plugin) => ({ ...plugin, version: "2.0.0" })))
    if (change === "bytes")
      writeFileSync(join(f.root, "skills/draft/SKILL.md"), "Changed installed source")
    if (change === "scope" || change === "account") current = false
    release()
    await held
    await rejected
    expect(enable).not.toHaveBeenCalled()
  }
)

it("rechecks real installed bytes when opening instead of trusting an earlier success", async () => {
  const f = fixture()
  const service = new PluginStartUseService({ plugins: f.plugins })
  const first = await service.prepare(f.input, () => {})
  writeFileSync(join(f.root, "skills/draft/SKILL.md"), "Changed source, same name/version")
  await expect(service.prepare({ ...f.input, expected: first.identity }, () => {})).rejects.toThrow(
    "PLUGIN_START_USE_CONTENT_CHANGED"
  )
})

it.each(["removed", "disabled", "updated", "scope"])(
  "rejects %s during fresh preflight",
  async (change) => {
    const f = fixture()
    let live = true
    const diagnostics = async () => {
      if (change === "removed") f.replace([])
      if (change === "disabled") f.replace(f.plugins().map((p) => ({ ...p, enabled: false })))
      if (change === "updated") f.replace(f.plugins().map((p) => ({ ...p, updatedAt: "new" })))
      if (change === "scope") live = false
      return []
    }
    const service = new PluginStartUseService({ plugins: f.plugins, diagnostics })
    await expect(
      service.prepare(f.input, () => {
        if (!live) throw Error("SCOPE_CHANGED")
      })
    ).rejects.toThrow(change === "scope" ? "SCOPE_CHANGED" : "PLUGIN_START_USE_IDENTITY_CHANGED")
  }
)

it("rejects a source change during diagnostics and never falls back from a broken project to chat", async () => {
  const f = fixture()
  const service = new PluginStartUseService({
    plugins: f.plugins,
    diagnostics: async () => {
      writeFileSync(join(f.root, "skills/review/SKILL.md"), "Changed")
      return []
    }
  })
  await expect(service.prepare(f.input, () => {})).rejects.toThrow(
    "PLUGIN_START_USE_CONTENT_CHANGED"
  )
  writeFileSync(join(f.root, "devclaw.project-runtime.json"), "{broken")
  await expect(service.prepare(f.input, () => {})).rejects.toThrow()
})

it("rejects wrong UUID/name/version", async () => {
  const f = fixture()
  const service = new PluginStartUseService({ plugins: f.plugins })
  await expect(service.prepare({ ...f.input, pluginId: "other" }, () => {})).rejects.toThrow(
    "PLUGIN_START_USE_PLUGIN_UNAVAILABLE"
  )
  await expect(
    service.prepare({ ...f.input, expected: { name: "other", version: "1.0.0" } }, () => {})
  ).rejects.toThrow("PLUGIN_START_USE_IDENTITY_CHANGED")
  writeFileSync(join(f.root, "plugin.json"), JSON.stringify({ name: "docs", version: "2.0.0" }))
  await expect(service.prepare(f.input, () => {})).rejects.toThrow()
})

it("bounds native diagnostics and rejects invalid resolution without exposing raw exceptions", async () => {
  const f = fixture()
  const diagnostics = vi.fn(async () =>
    Array.from({ length: 65 }, () => ({
      code: "configuration" as const,
      message: "Fill required fields.",
      resolution: "plugin-settings" as const
    }))
  )
  const service = new PluginStartUseService({ plugins: f.plugins, diagnostics })
  await expect(service.prepare(f.input, () => {})).rejects.toThrow(
    "PLUGIN_START_USE_DIAGNOSTIC_INVALID"
  )
})

it("does not expose original parser fragments or paths when the installed source is malformed", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "plugin.json"), '{"private":"never-publish-source-fragment"')
  const service = new PluginStartUseService({ plugins: f.plugins })
  await expect(service.prepare(f.input, () => {})).rejects.toThrow(
    "PLUGIN_START_USE_PACKAGE_INVALID"
  )
})
