import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import type { BrowserWindow } from "electron"

const state = vi.hoisted(() => ({ plugin: undefined as PluginMetadata | undefined,
  beforeScan: undefined as (() => void | Promise<void>) | undefined,
  scanned: [] as string[], projectCurrent: true }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {} }, shell: {} }))
vi.mock("../storage", () => ({ getDisabledSkills: () => [],
  getEnabledPluginSkillSourceMetadata: () => [] }))
vi.mock("./service", () => ({ getHarnessProjectAdapterSnapshot: async () => state.plugin }))
vi.mock("../services/thread-service", () => ({ createThreadService: vi.fn() }))
vi.mock("../services/im/feature-thread-grant", () => ({ materializeHarnessFeatureThreadGrant: vi.fn() }))
vi.mock("../services/title-generator", () => ({ generateTitle: () => "test" }))
vi.mock("../ipc/skills", async importOriginal => {
  const original = await importOriginal<typeof import("../ipc/skills")>()
  return { listAllSkills: async () => [], listPluginSkills: async (...args: Parameters<typeof original.listPluginSkills>) => {
    state.scanned.push(...(args[0] ?? []).map(source => source.sourceDir))
    await state.beforeScan?.()
    return original.listPluginSkills(...args)
  } }
})
import { prepareManagedHarnessSession } from "./auto-mode-action-executor"
import { LegacyProjectRuntimeService } from "./project-runtime/legacy-runtime-service"
import { LegacyOperationStore } from "./project-runtime/legacy-operation-store"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { withLegacyProjectSkillSource } from "./project-runtime/legacy-entry-gate"
import { getPluginSkillSearchSources, readPluginManifest } from "../plugins/manifest"
import { SkillLifecycleRegistry } from "../agent/skill-lifecycle/registry"
import { parseSkillUseBlock } from "../agent/skill-lifecycle/marker"
import { runtimeDirectory } from "./project-runtime/safe-files"
import { currentRuntimePluginSource } from "../plugins/runtime-source-scope"

const skillNames = [
  "autobiz-requirement-discuss",
  ...Array.from({ length: 14 }, (_, index) => `legacy-fixture-stage-${index + 2}`)
]
const originalSkillBody = "Read the retained fixture requirements before proposing changes."
const delivery: AgentRunDelivery = { window: {} as BrowserWindow, send: vi.fn(), isAvailable: () => true }
let root = "", cleanup: (() => void) | undefined
let preparedFixture: ReturnType<typeof setup>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "legacy-managed-source-"))
  state.plugin = undefined; state.beforeScan = undefined; state.scanned = []; state.projectCurrent = true
  // Build this case's real independent package/store before the timed behavior.
  // Capture is fixture construction; prepare and every source check remain in the 5s test.
  preparedFixture = setup()
})
afterEach(() => {
  cleanup?.(); cleanup = undefined
  expect(root.split(/[\\/]/).at(-1)).toMatch(/^legacy-managed-source-/)
  rmSync(root, { recursive: true, force: true })
})

function setup() {
  const installed = join(root, "installed"), workspace = join(root, "workspace")
  mkdirSync(installed); mkdirSync(workspace)
  // A small real package keeps source pinning independent of historical delivery artifacts.
  // All fifteen Skills still pass through durable snapshots and the production async scanner.
  const metadata = { name: "legacy-managed-skills-fixture", version: "1.0.0", skills: "skills" }
  writeFileSync(join(installed, "plugin.json"), JSON.stringify(metadata))
  const manifest = hostProjectFixture(workspace).manifest
  manifest.plugin = { id: metadata.name, version: metadata.version }
  manifest.mode = "legacy"
  manifest.stateOwner = "plugin"
  manifest.stages = skillNames.map((name, index) => ({
    ...manifest.stages[0],
    id: `stage-${index + 1}`,
    title: name,
    skill: `skills/autobiz/${name}/SKILL.md`
  }))
  writeFileSync(join(installed, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const name of skillNames) {
    const directory = join(installed, "skills/autobiz", name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Retained legacy fixture Skill ${name}\n---\n${originalSkillBody}\n`)
  }
  state.plugin = { id: "actual-installed-uuid", name: metadata.name, path: installed,
    version: metadata.version, description: "", author: "", enabled: true,
    skillCount: 15, hookCount: 0, mcpServerCount: 0, createdAt: "", updatedAt: "" }
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const snapshot = snapshots.capture(installed)
  const store = new LegacyOperationStore(join(root, "operations.sqlite"))
  // Native enable/admission has its own suite/App evidence. This fixture establishes
  // its original durable binding and real retained bytes; no run or grant is created.
  store.enable({ projectId: "project", workspace: runtimeDirectory(workspace),
    installedPluginId: state.plugin.id, packageId: metadata.name,
    packageVersion: metadata.version, packageDigest: snapshot.digest, mods: null })
  const service = new LegacyProjectRuntimeService(store, snapshots, {
    resolveThread: () => undefined,
    resolvePlugin: async (projectId, requestedWorkspace) => {
      if (projectId !== "project" || runtimeDirectory(requestedWorkspace) !== runtimeDirectory(workspace))
        throw Error("REAL_PROJECT_SCOPE_CHANGED")
      return { ...state.plugin! }
    }, assertProjectIdle: () => {},
    assertInstalledSourceCurrent: (_project, _workspace, id) => {
      if (state.plugin?.id !== id || !state.plugin.enabled) throw Error("REAL_INSTALLED_SOURCE_CHANGED")
    }, assertProjectBindingCurrent: () => {
      if (!state.projectCurrent) throw Error("REAL_PROJECT_SCOPE_CHANGED")
    }
  })
  const unregister = service.register()
  cleanup = () => { unregister(); store.close() }
  const prepare = () => prepareManagedHarnessSession({ projectId: "project", featureId: "feature",
    runId: "managed-run", nodeId: "biz.prd", workspacePath: workspace, delivery,
    nextAction: { slashSkill: "autobiz-requirement-discuss", userMessage: "Read the original selected Skill" } })
  return { installed, workspace, snapshot, store, service, unregister, prepare }
}

it("builds an exact native managed Skill block from the real retained fifteen-Skill package", async () => {
  const f = preparedFixture
  const registry = new SkillLifecycleRegistry(getPluginSkillSearchSources(f.snapshot.root,
    readPluginManifest(f.snapshot.root)!.manifest))
  const oldPath = join(f.installed, "skills/autobiz/autobiz-requirement-discuss/SKILL.md")
  expect(registry.resolveExplicit({ skillName: "autobiz-requirement-discuss", skillPath: oldPath })).toBeNull()
  // A later mutable installation edit must never enter the source-bound message.
  writeFileSync(oldPath, "---\nname: different-live-skill\n---\nChanged live installation")
  const result = await f.prepare()
  const parsed = parseSkillUseBlock(result.modelMessage)!
  expect(parsed.skillPath).toBe(join(f.snapshot.root, "skills/autobiz/autobiz-requirement-discuss/SKILL.md"))
  expect(registry.resolveExplicit(parsed)).toMatchObject({ name: "autobiz-requirement-discuss" })
  expect(state.scanned.every(path => path.startsWith(f.snapshot.root))).toBe(true)
  const { listPluginSkills } = await import("../ipc/skills")
  const skills = await listPluginSkills(getPluginSkillSearchSources(f.snapshot.root,
    readPluginManifest(f.snapshot.root)!.manifest).map(source => ({ ...source,
      pluginId: state.plugin!.id, pluginName: state.plugin!.name,
      pluginRoot: f.snapshot.root, isProjectModePlugin: true })))
  expect(skills).toHaveLength(15)
  expect(skills.map(skill => skill.name).sort()).toEqual([...skillNames].sort())
  expect(readFileSync(parsed.skillPath, "utf8")).toContain(originalSkillBody)
  expect(readFileSync(parsed.skillPath, "utf8")).not.toContain("Changed live installation")
  expect(f.snapshot.manifest).toMatchObject({ mode: "legacy", stateOwner: "plugin" })
  expect(f.store.list("project")).toEqual([])
  expect(currentRuntimePluginSource()).toBeUndefined()
})

it.each(["disabled", "uuid", "version", "project", "binding", "retained-bytes"] as const)(
  "rejects %s changes while the original asynchronous Skill scan is in flight", async change => {
    const f = preparedFixture
    state.beforeScan = () => {
      if (change === "disabled") state.plugin!.enabled = false
      if (change === "uuid") state.plugin!.id = "different-uuid"
      if (change === "version") state.plugin!.version = "999.0.0"
      if (change === "project") state.projectCurrent = false
      if (change === "binding") f.store.disable("project")
      if (change === "retained-bytes") writeFileSync(join(f.snapshot.root,
        "skills/autobiz/autobiz-requirement-discuss/SKILL.md"), "changed retained source")
    }
    await expect(f.prepare()).rejects.toThrow(/CHANGED|MISMATCH|UNAVAILABLE/)
    expect(f.store.list("project")).toEqual([])
  }
)

it("rejects a foreign workspace, drops its reader on unregister, and leaves unconfigured projects unchanged", async () => {
  const f = preparedFixture, foreign = join(root, "foreign")
  mkdirSync(foreign)
  const callback = vi.fn(async () => "must not run")
  await expect(withLegacyProjectSkillSource("project", foreign, callback)).rejects.toThrow("LEGACY_WORKSPACE_CHANGED")
  expect(callback).not.toHaveBeenCalled()
  expect(await withLegacyProjectSkillSource("unconfigured", foreign,
    async bound => bound)).toBeUndefined()
  f.unregister()
  expect(await withLegacyProjectSkillSource("project", f.workspace,
    async bound => bound)).toBeUndefined()
  expect(currentRuntimePluginSource()).toBeUndefined()
})
