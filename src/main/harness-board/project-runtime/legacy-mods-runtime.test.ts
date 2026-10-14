import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { PluginMetadata } from "../../types"
import { ModControlStore } from "../../mods/control-store"
import { compileFunctionPlugin } from "../../mods/v2/loader"
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
