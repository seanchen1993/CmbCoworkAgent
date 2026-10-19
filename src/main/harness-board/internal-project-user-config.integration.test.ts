import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterAll, afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import type { ExtensionContract } from "../../shared/project-runtime"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"

const state = vi.hoisted(() => ({ root: "", chosen: "", plugins: [] as PluginMetadata[] }))
vi.mock("../services/workspace-probe-worker?nodeWorker", async () => ({
  // Replace only Vite's build-time loader; execute the production probe in a real Node worker.
  default: (await import("../services/workspace-probe.test-helper")).createWorkspaceProbeTestWorker
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root, getPlugins: () => state.plugins }))
vi.mock("electron-store", () => ({ default: class { get() { return null } } }))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [state.chosen] }) }
}))
vi.mock("../db", async (original) => ({
  ...await original<typeof import("../db")>(),
  createThread: (threadId: string, metadata: Record<string, unknown>) => ({
    thread_id: threadId, metadata: JSON.stringify(metadata), created_at: 1, updated_at: 1
  })
}))
vi.mock("../ipc/models", () => ({ getDefaultModel: () => null }))
vi.mock("../ipc/recent-workspace", () => ({ resolveRecentWorkspacePath: async () => null }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./service", async (original) => ({
  ...await original<typeof import("./service")>(),
  // Stage-list presentation is independent of the original context collector under test.
  resolveHarnessFeatureCurrentStage: async () => null
}))

import { createThreadService } from "../services/thread-service"
import { buildHarnessFeatureAgentContext } from "./service"
import { registerNativeProjectSourceHandlers } from "../ipc/native-project-source"
import { CompositionInternalProjects } from "./project-runtime/composition-internal-projects"
import { RetainedPackageSnapshots } from "./project-runtime/package-snapshots"
import { ModControlStore } from "../mods/control-store"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionConfigurationSourceCache } from "../mods/v2/configuration-source-cache"
import { readInternalHarnessDirectoryUserConfig, admitInternalHarnessContextSource } from "./internal-project-user-config"
import { captureInternalHarnessProjectIdentityGuard, readInternalHarnessProject } from "./internal-project-context"
import { configureExtensionContextDirectoryBinding } from "./extension-context"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { CONTEXT_HANDOFF_PROTOCOL, parseProjectRuntimeManifest, wrapProjectRuntimeManifest } from "../../shared/project-runtime"
import { captureRuntimePluginSourceToken, issueRuntimePluginSourceToken, withRuntimePluginSource } from "../plugins/runtime-source-scope"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { createHostProjectInputIdentity } from "./project-runtime/package-input-identity"
import { setProjectActionRuntime } from "./project-action-runtime"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"
import { extensionContextStorageKey } from "./extension-context"
import { closeWorkspaceProbeWorker } from "../services/workspace-probe-client"
import { removeWorkspaceProbeTestWorker } from "../services/workspace-probe.test-helper"

afterAll(async () => {
  await closeWorkspaceProbeWorker()
  removeWorkspaceProbeTestWorker()
})

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  configureExtensionContextDirectoryBinding()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function fixture(approve = true, directoryBinding = true) {
  const root = state.root = mkdtempSync(join(tmpdir(), "internal-context-config-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const installed = join(root, "installed"), workspace = join(root, "units", "unit")
  const knowledge = state.chosen = join(root, "native-chosen-knowledge")
  for (const path of [installed, workspace, knowledge, join(installed, "mods"), join(installed, "board_core")])
    mkdirSync(path, { recursive: true })
  writeFileSync(join(knowledge, "rule.md"), "UNIT_KNOWLEDGE_READ_BEFORE_MODEL")
  const runtime = parseProjectRuntimeManifest(JSON.parse(createProjectTemplate({
    packageId: "context-owner", name: "Context owner", version: "1.0.0"
  }).files.find(file => file.path === "devclaw.project-runtime.json")!.text))
  runtime.mode = "legacy"
  runtime.stateOwner = "plugin"
  const contract: ExtensionContract = {
    apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL],
    context: {
      sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true, ...(directoryBinding ? { binding: "knowledgeRoot" } : {}) },
      provider: { entry: "provider.py", operations: ["session-context"] }
    }
  }
  writeFileSync(join(installed, "devclaw.project-runtime.json"), JSON.stringify(wrapProjectRuntimeManifest(runtime, contract)))
  writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "context-owner", version: "1.0.0" }))
  writeFileSync(join(installed, "mods/manifest.json"), JSON.stringify({
    apiVersion: "cmb.mods/v2", id: "actual-native-config-name", entry: "main.ts",
    userConfig: { knowledgeRoot: { type: "directory", title: "Knowledge", description: "Read-only" } }
  }))
  writeFileSync(join(installed, "mods/main.ts"), "export function register(){ /* Context config declaration only. */ }")
  writeFileSync(join(installed, "board_core/board_config.json"), JSON.stringify({
    apiVersion: 2, inspectCommands: { [process.platform]: {
      session_context_inject: 'python "${pluginPath}/provider.py"'
    } }
  }))
  // A real provider process reads the host-bound directory and returns actual file contents.
  // AutoBiz's complete immutable Python/JS collector is separately exercised by its App suite.
  writeFileSync(join(installed, "provider.py"), [
    "import json, os",
    "from pathlib import Path",
    'knowledge=Path(os.environ["DEVCLAW_KNOWLEDGE_ROOT"])',
    'text=(knowledge/"rule.md").read_text(encoding="utf-8")',
    'config=Path(os.environ["DEVCLAW_RUNTIME_CONFIG_PATH"])',
    'config.with_name("context-proof.json").write_text(json.dumps({"root":str(knowledge),"text":text}),encoding="utf-8")',
    'print(json.dumps({"ok":True,"sessionContext":text,"agentmdLoadStatus":[],"agentConfig":{"agentMode":"solo"}}))'
  ].join("\n"))
  const native = { id: "installed-uuid", name: "context-owner", version: "1.0.0", path: installed, enabled: true } as PluginMetadata
  state.plugins = [native]
  const retained = new RetainedPackageSnapshots(join(root, "retained")).capture(installed)
  const projects = new CompositionInternalProjects(join(root, "internal.sqlite"), () => {
    if (!owned) throw Error("ORIGINAL_OWNER_REVOKED")
  })
  let owned = true
  cleanup.push(() => projects.close())
  cleanup.push(projects.register())
  await projects.prepare({ ...native, path: retained.root }, retained.digest)
  const record = projects.create({
    parentProjectId: "parent", compositionRunId: "run", unitId: "unit", featureId: "feature",
    goal: "Read this unit's chosen knowledge", workspace,
    packageDigest: retained.digest, plugin: { ...native, path: retained.root }
  }, {
    projectId: "parent", name: "Parent", projectDir: "parent", projectCode: "parent", workspacePath: root,
    "harness-adapter": { id: native.id, name: native.name, version: native.version, type: "plugin" },
    lifecycle: { status: "active", createAt: "2026-10-17T00:00:00Z" }
  } as HarnessProjectMetadata)
  const store = new ModControlStore(join(root, "mods.sqlite"))
  const manager = new FunctionModsManager(store, {
    plugins: () => state.plugins, enabled: () => true,
    publish: async (_workspace, value) => value, changed: () => {}
  }, () => {
    const guests: FunctionGuestRuntime[] = []
    return {
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() { for (const guest of guests) void guest.dispose() },
      async stopAndDrain() { await Promise.all(guests.map(guest => guest.dispose())) }
    }
  })
  cleanup.push(() => { manager.close(); store.close() })
  const guard = captureInternalHarnessProjectIdentityGuard(record.projectId)
  const full = () => { guard(); readInternalHarnessProject(record.projectId) }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
  registerNativeProjectSourceHandlers({ handle: (
    key: string, run: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  ) => handlers.set(key, run) } as unknown as IpcMain,
    "unit", (_event, key) => {
      if (key !== record.projectId) throw Error("UNIT_CHANGED")
      full()
      return {
        manager, workspaceControl: undefined,
        project: { projectId: record.projectId, version: 1, pluginDigest: retained.digest },
        input: { workspace, plugin: record.plugin, scope: { projectId: record.projectId, packageDigest: retained.digest } },
        guard: full, authorityGuard: guard
      }
    })
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender } as unknown as IpcMainInvokeEvent
  const call = <T>(name: string, input: unknown) => handlers.get(`unit:${name}`)!(event, input) as Promise<T>
  let view = await call<FunctionUserConfigView>("user-config", { threadId: record.projectId, pluginId: native.id })
  const binding = { threadId: record.projectId, pluginId: native.id, digest: view.digest,
    workspace: view.workspace, revision: view.savedRevision, key: "knowledgeRoot" }
  const selected = await call<string>("user-config-pick-path", binding)
  view = await call<FunctionUserConfigView>("user-config-save", { ...binding, value: selected })
  expect(view.savedRevision).toBe(1)
  const approveSource = () => call("mods-approve", { projectId: record.projectId, projectVersion: 1,
    packageDigest: retained.digest, compiledDigest: view.digest })
  if (approve) await approveSource()
  const providerData = join(root, "plugin-data", extensionContextStorageKey(
    { name: native.name, version: native.version! },
    readFileSync(join(retained.root, "board_core/board_config.json")), contract.context!,
    directoryBinding ? knowledge : undefined
  ))
  if (!directoryBinding) {
    const data = join(root, "plugin-data", extensionContextStorageKey(
      { name: native.name, version: native.version! },
      readFileSync(join(retained.root, "board_core/board_config.json")), contract.context!
    ), "knowledge")
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, "rule.md"), "UNIT_KNOWLEDGE_READ_BEFORE_MODEL")
  }
  const inputs = createHostProjectInputIdentity(manager, { rules: () => [], contextDataRoot: join(root, "plugin-data") })
  const flows = new FlowManager(new FlowStore(store), { assertScope: () => undefined, changed: () => undefined,
    prepare: async () => { throw Error("MUST_NOT_RUN_FLOW_FOR_CONTEXT") } })
  setProjectActionRuntime({ ...inputs, flows, catalog: async () => [], prepareSelection: async () => undefined })
  const read = (overrides: Partial<{ projectId: string; sourceRoot: string; workspace: string; key: string }> = {}) =>
    readInternalHarnessDirectoryUserConfig(manager, value => value, {
      projectId: record.projectId, sourceRoot: retained.root, workspace, key: "knowledgeRoot", ...overrides
    })
  configureExtensionContextDirectoryBinding((sourceRoot, directory, _name, key, projectId) =>
    read({ sourceRoot, workspace: directory, key, projectId: projectId! }),
    (sourceRoot, directory, projectId) => admitInternalHarnessContextSource(manager, value => value,
      { sourceRoot, workspace: directory, projectId }))
  return { root, workspace, knowledge, record, manager, store, retained, read,
    approveSource, providerProof: join(providerData, "context-proof.json"), compiledDigest: view.digest, revokeOwner: () => { owned = false } }
}

it("reads a native unit save during actual pre-admission thread context creation without minting a runtime token", async () => {
  const f = await fixture()
  const grant = f.store.getProjectFunctionGrant(f.workspace, f.record.projectId, f.retained.digest, "actual-native-config-name")
  expect(grant?.enabled).toBe(true)
  expect(captureRuntimePluginSourceToken()).toBeUndefined()
  await expect(f.manager.readDirectoryUserConfig(f.workspace, f.retained.root, "knowledgeRoot"))
    .rejects.toMatchObject({ code: "MODS_CONFIG_PLUGIN_MISSING" })
  const thread = await createThreadService({ workspacePath: f.workspace, isInternalFlowRuntime: true,
    harnessFeature: { projectId: f.record.projectId, slug: f.record.featureId }
  }, { managedWorkspace: true })
  expect(thread.metadata?.subagentsEnabled).toBe(false)
  const context = await buildHarnessFeatureAgentContext(thread.metadata, { workspacePath: f.workspace })
  expect(context?.harnessAgentsPrompt).toContain("UNIT_KNOWLEDGE_READ_BEFORE_MODEL")
  expect(context?.sessionContextInjectWarning).toBeUndefined()
  expect(await f.read()).toBe(f.knowledge)
  expect(captureRuntimePluginSourceToken()).toBeUndefined()
  expect(f.store.getGrant(f.workspace, "function:actual-native-config-name")).toBeNull()
  expect(f.store.getProjectFunctionGrant(f.workspace, f.record.projectId, f.retained.digest, "actual-native-config-name")).toEqual(grant)
}, 15_000)

it.each(["owner", "installation", "retained-bytes"])("rejects %s changes across the original config compiler await", async change => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = FunctionConfigurationSourceCache.prototype.read
  vi.spyOn(FunctionConfigurationSourceCache.prototype, "read").mockImplementation(async function(this: FunctionConfigurationSourceCache, path) {
    const result = await original.call(this, path)
    entered.resolve(); await release.promise
    return result
  })
  const reading = f.read(), rejected = expect(reading).rejects.toThrow()
  await entered.promise
  if (change === "owner") f.revokeOwner()
  if (change === "installation") state.plugins = []
  if (change === "retained-bytes") writeFileSync(join(f.retained.root, "mods/main.ts"), "export function register(){throw Error('changed')}")
  release.resolve()
  await rejected
})

it("never substitutes the parent, another unit, a mutable installation or an undeclared field", async () => {
  const f = await fixture()
  for (const input of [
    { workspace: join(f.root, "parent") }, { workspace: join(f.root, "units", "another") },
    { sourceRoot: state.plugins[0].path }, { projectId: "composition-legacy:run:another" },
    { key: "undeclared" }
  ]) await expect(f.read(input)).rejects.toThrow()
  expect(readFileSync(join(f.knowledge, "rule.md"), "utf8")).toBe("UNIT_KNOWLEDGE_READ_BEFORE_MODEL")
})

it("does not borrow another opaque project or revive an ended turn during a host configuration read", async () => {
  const f = await fixture()
  let live = true
  const token = (projectId: string) => issueRuntimePluginSourceToken({
    mode: "legacy", capabilitySources: [], threadId: "thread", incarnationKey: "original",
    projectId, operationId: "operation", workspace: f.workspace,
    packageDigest: f.retained.digest, stageId: "stage", plugin: f.record.plugin
  }, () => { readInternalHarnessProject(f.record.projectId) }, () => {
    if (!live) throw Error("ORIGINAL_TURN_ENDED")
  })
  await withRuntimePluginSource(token("other-project"), async () => {
    await expect(f.read()).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  })
  await withRuntimePluginSource(token(f.record.projectId), async () => {
    expect(await f.read()).toBe(f.knowledge)
    live = false
    await expect(f.read()).rejects.toThrow("ORIGINAL_TURN_ENDED")
  })
})


it("requires exact native approval before a provider without a directory binding can spawn", async () => {
  const f = await fixture(false, false)
  const input = { projectId: f.record.projectId, sourceRoot: f.retained.root, workspace: f.workspace }
  await expect(admitInternalHarnessContextSource(f.manager, value => value, input)).rejects.toThrow()
  const create = () => createThreadService({ workspacePath: f.workspace, isInternalFlowRuntime: true,
    harnessFeature: { projectId: f.record.projectId, slug: f.record.featureId }
  }, { managedWorkspace: true })
  await create()
  expect(existsSync(f.providerProof)).toBe(false)
  expect(captureRuntimePluginSourceToken()).toBeUndefined()
  await f.approveSource()
  const originalGrant = f.store.getProjectFunctionGrant(f.workspace, f.record.projectId,
    f.retained.digest, "actual-native-config-name")
  const thread = await create()
  expect(thread.metadata?.subagentsEnabled).toBe(false)
  expect(JSON.parse(readFileSync(f.providerProof, "utf8")).text).toBe("UNIT_KNOWLEDGE_READ_BEFORE_MODEL")
  expect(f.store.getProjectFunctionGrant(f.workspace, f.record.projectId,
    f.retained.digest, "actual-native-config-name")).toEqual(originalGrant)
  f.store.grantProjectFunction(f.workspace, f.record.projectId, f.retained.digest,
    "actual-native-config-name", f.compiledDigest, false)
  rmSync(f.providerProof)
  await expect(admitInternalHarnessContextSource(f.manager, value => value, input)).rejects.toThrow()
  await create()
  expect(existsSync(f.providerProof)).toBe(false)
  expect(f.store.getGrant(f.workspace, "function:actual-native-config-name")).toBeNull()
}, 20_000)
