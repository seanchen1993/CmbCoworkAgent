import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import { ModControlStore } from "../../mods/control-store"
import { compileFunctionPlugin } from "../../mods/v2/loader"
import * as sourceFence from "../../mods/v2/source-adoption-fence"
import { createLegacyModsRuntime } from "./legacy-mods-runtime"

it("retains an existing compiled grant identity and rejects source updates and revoked grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-mods-fence-"))
  const store = new ModControlStore(join(root, "mods.sqlite"))
  try {
    const installed = join(root, "installed"),
      pinned = join(root, "pinned")
    mkdirSync(join(installed, "hooks"), { recursive: true })
    writeFileSync(join(installed, "plugin.json"), '{"name":"fixed-mod"}')
    writeFileSync(join(installed, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    writeFileSync(join(installed, "hooks/register.ts"), "export function register(){}")
    cpSync(installed, pinned, { recursive: true })
    const compiled = await compileFunctionPlugin(installed)
    const plugin = {
      id: "installed",
      name: "fixed-mod",
      path: installed,
      enabled: true
    } as PluginMetadata
    const rawWorkspace = "C:\\Users\\Author\\Workspace"
    const workspaceKey = rawWorkspace.toLowerCase()
    const runtime = createLegacyModsRuntime({
      store,
      workspaceKey: (value) => {
        expect(value).toBe(rawWorkspace)
        return workspaceKey
      },
      plugins: () => [plugin],
      isEnabled: (value) => {
        expect(value).toBe(workspaceKey)
        return true
      }
    })
    await expect(runtime.capture(plugin, pinned, rawWorkspace)).rejects.toThrow("GRANT_REQUIRED")
    store.grant(workspaceKey, "function:fixed-mod", compiled.digest, true)
    const admission = await runtime.capture(plugin, pinned, rawWorkspace)
    expect(admission.identity.digest).toBe(compiled.digest)
    expect(() => admission.assertCurrent()).not.toThrow()
    store.grant(workspaceKey, "function:fixed-mod", compiled.digest, false)
    expect(() => admission.assertCurrent()).toThrow("GRANT_REVOKED")
    store.grant(workspaceKey, "function:fixed-mod", compiled.digest, true)
    const next = await runtime.capture(plugin, pinned, rawWorkspace)
    writeFileSync(join(installed, "hooks/register.ts"), "export function register(){ return 1 }")
    expect(() => next.assertCurrent()).toThrow("SOURCE_CHANGED")
    await expect(runtime.capture(plugin, pinned, rawWorkspace)).rejects.toThrow("DIGEST_CHANGED")
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})


function authorityFixture() {
  const root = mkdtempSync(join(tmpdir(), "legacy-mods-authority-"))
  const installed = join(root, "installed"), pinned = join(root, "pinned")
  mkdirSync(join(installed, "hooks"), { recursive: true })
  writeFileSync(join(installed, "plugin.json"), '{"name":"fixed-mod","version":"1.0.0"}')
  writeFileSync(join(installed, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  writeFileSync(join(installed, "hooks/register.ts"), "export function register(){}")
  cpSync(installed, pinned, { recursive: true })
  const store = new ModControlStore(join(root, "mods.sqlite"))
  let current: PluginMetadata = { id: "installed", name: "fixed-mod", version: "1.0.0",
    path: installed, enabled: true, description: "", author: "", createdAt: "", updatedAt: "",
    skillCount: 0, hookCount: 0, mcpServerCount: 0 }
  let enabled = true
  const runtime = createLegacyModsRuntime({ store, workspaceKey: value => value,
    isEnabled: () => enabled, plugins: () => [current] })
  return { root, installed, pinned, store, runtime, plugin: current,
    change: (value: Partial<PluginMetadata>) => { current = { ...current, ...value } },
    disableWorkspace: () => { enabled = false },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }) } }
}

it("keeps metadata authority readers free of full proofs but rejects changed bytes at the actual boundary", async () => {
  const f = authorityFixture()
  const fence = vi.spyOn(sourceFence, "assertFunctionSourcesCurrent")
  try {
    const compiled = await compileFunctionPlugin(f.installed)
    f.store.grant(f.root, "function:fixed-mod", compiled.digest, true)
    const admission = await f.runtime.capture(f.plugin, f.pinned, f.root)
    const baseline = fence.mock.calls.length
    expect(baseline).toBeGreaterThanOrEqual(2)
    writeFileSync(join(f.installed, "hooks/register.ts"), "export function register(){ return 1 }")
    for (let index = 0; index < 100; index++) admission.assertAuthorityCurrent()
    expect(fence).toHaveBeenCalledTimes(baseline)
    expect(() => admission.assertCurrent()).toThrow("SOURCE_CHANGED")
    expect(fence.mock.calls.length).toBeGreaterThan(baseline)
  } finally { fence.mockRestore(); f.close() }
})

it.each(["workspace", "uuid", "name", "version", "path", "disabled", "grant-epoch", "installed-root", "pinned-root", "removed-installed-root", "removed-pinned-root"] as const)
  ("rejects %s immediately without inspecting source bytes", async kind => {
    const f = authorityFixture()
    const fence = vi.spyOn(sourceFence, "assertFunctionSourcesCurrent")
    try {
      const compiled = await compileFunctionPlugin(f.installed)
      f.store.grant(f.root, "function:fixed-mod", compiled.digest, true)
      const admission = await f.runtime.capture(f.plugin, f.pinned, f.root)
      const baseline = fence.mock.calls.length
      if (kind === "workspace") f.disableWorkspace()
      else if (kind === "uuid") f.change({ id: "foreign-uuid" })
      else if (kind === "name") f.change({ name: "foreign-name" })
      else if (kind === "version") f.change({ version: "1.0.1" })
      else if (kind === "path") f.change({ path: f.pinned })
      else if (kind === "disabled") f.change({ enabled: false })
      else if (kind === "grant-epoch") f.store.grant(f.root, "function:fixed-mod", compiled.digest, true)
      else {
        const changed = kind.endsWith("installed-root") ? f.installed : f.pinned
        renameSync(changed, changed + "-retired")
        if (!kind.startsWith("removed-")) cpSync(changed + "-retired", changed, { recursive: true })
      }
      expect(() => admission.assertAuthorityCurrent()).toThrow()
      expect(fence).toHaveBeenCalledTimes(baseline)
    } finally { fence.mockRestore(); f.close() }
  })
