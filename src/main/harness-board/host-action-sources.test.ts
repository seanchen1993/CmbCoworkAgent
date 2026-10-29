import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import type { PluginMetadata } from "../types"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { createProjectActionBinding } from "./project-runtime/action-input"
import { hostProjectActionSources } from "./host-action-sources"
import { currentRuntimePluginSource, issueRuntimePluginSourceToken,
  withRuntimePluginSource } from "../plugins/runtime-source-scope"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-action-lock-"))
  roots.push(root)
  const action: ClawActionDescriptor = { pluginId: "locked-id", plugin: "locked-name",
    digest: "b".repeat(64), actionId: "run", name: "Run",
    platform: { id: "delivery", version: "1.0.0", action: "run" }, inputSchema: { type: "object" },
    outputSchema: { type: "object" } }
  const project = { ...hostProjectFixture(root), stageIndex: 0 } as HostProjectState
  const binding = createProjectActionBinding("checked", action, {})
  project.manifest.actions = [{ id: binding.id, ref: binding.ref }]
  project.manifest.stages[0].actionIds = [binding.id]
  writeFileSync(join(root, "devclaw.project-actions.lock.json"), JSON.stringify({
    apiVersion: "devclaw.project-actions-lock/v1", bindings: [binding] }))
  const plugin: PluginMetadata = { id: action.pluginId, name: action.plugin, path: join(root, "provider"),
    version: "2.0.0", enabled: true, description: "", author: "", skillCount: 1,
    mcpServerCount: 1, createdAt: "", updatedAt: "" }
  mkdirSync(plugin.path)
  let active = true
  const catalog = [action], plugins = [plugin]
  return { root, project, plugin, action, catalog, plugins, revoke: () => { active = false },
    resolve: () => hostProjectActionSources({ root, project, catalog: async () => catalog,
      plugins: () => plugins, assertCurrent: () => { if (!active) throw Error("ORIGINAL_SCOPE_REVOKED") } }) }
}

it("resolves the original retained contract and freezes only exact approved action sources in a native token", async () => {
  const f = fixture(), sources = await f.resolve()
  expect(sources).toEqual([{ plugin: f.plugin, name: f.action.plugin, digest: f.action.digest }])
  const token = issueRuntimePluginSourceToken({ mode: "host", threadId: "thread", incarnationKey: "original",
    projectId: "project", operationId: "operation", stageId: "code", packageDigest: "a".repeat(64),
    workspace: f.root, plugin: { ...f.plugin, id: "parent" }, capabilitySources: [], actionSources: sources })
  sources[0].plugin.path = join(f.root, "changed")
  sources[0].digest = "c".repeat(64)
  withRuntimePluginSource(token, () => {
    const pinned = currentRuntimePluginSource()!.actionSources![0]
    expect(pinned.plugin.path).toBe(f.plugin.path)
    expect(pinned.digest).toBe(f.action.digest)
    expect(Object.isFrozen(pinned.plugin)).toBe(true)
    expect(Object.isFrozen(pinned)).toBe(true)
  })
})

it.each(["digest", "provider-id", "target", "schema", "missing", "disabled", "revoked"] as const)(
  "refuses a %s mismatch against the retained lock", async change => {
    const f = fixture()
    if (change === "digest") f.action.digest = "c".repeat(64)
    if (change === "provider-id") f.action.pluginId = "same-name-other-install"
    if (change === "target") f.action.platform!.action = "other"
    if (change === "schema") f.action.inputSchema = { type: "object", required: ["new"] }
    if (change === "missing") f.plugins.length = 0
    if (change === "disabled") f.plugin.enabled = false
    if (change === "revoked") f.revoke()
    await expect(f.resolve()).rejects.toThrow()
  })
