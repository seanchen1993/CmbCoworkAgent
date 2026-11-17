import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  hostProjectFixture,
  prepareFixture,
  TEST_FINGERPRINT
} from "../harness-board/project-runtime/host-fixtures.test-helper"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import { ModControlStore } from "../mods/control-store"
import type { FunctionModsManager } from "../mods/v2/manager"
import { configureProjectUseRuntime } from "../harness-board/project-use-authorization"
import { ProjectCompositionStore } from "../harness-board/project-runtime/composition-store"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { HostUserInputStore } from "../services/host-user-input-store"
import { configureHostUserInputPersistence } from "../services/user-input"

type RegisterComposition = typeof import("./project-composition").registerProjectCompositionHandlers
type HostStore = import("../harness-board/project-runtime/host-store").HostProjectStore

const state = vi.hoisted(() => ({
  service: undefined as unknown,
  plugins: [] as Array<{ id: string; path: string; name: string; version: string; enabled: boolean }>,
  binding: undefined as import("../../shared/harness-board-types").HarnessNativeFeatureBinding | undefined,
  nativeRuntime: undefined as import("../harness-board/native-harness").NativeHarnessRuntime | undefined,
  ensureNative: vi.fn(),
  assertFeatureCurrent: vi.fn(),
  nativeReady: vi.fn(async (...args: unknown[]) => {
    void args
    return { ready: true, assertCurrent: () => {}, assertExecutionReady: () => {} }
  }),
  afterSnapshot: undefined as ((directory: string) => void) | undefined,
  dataRoot: undefined as string | undefined,
  threadWorkspaces: {} as Record<string, string>,
  registerComposition: undefined as RegisterComposition | undefined,
  composition: undefined as ReturnType<RegisterComposition> | undefined,
  closeAdmission: undefined as (() => void) | undefined,
  hostStoreOpened: vi.fn(),
  openHostStore: undefined as ((path: string) => HostStore) | undefined
}))
vi.mock("../harness-board/native-harness", () => ({
  configureNativeHarnessRuntime: (nativeRuntime: import("../harness-board/native-harness").NativeHarnessRuntime) => {
    state.nativeRuntime = nativeRuntime
  },
  assertNativeHarnessFeatureCurrent: (binding: import("../../shared/harness-board-types").HarnessNativeFeatureBinding) => {
    state.assertFeatureCurrent(binding)
    if (JSON.stringify(state.binding) !== JSON.stringify(binding)) throw Error("HARNESS_NATIVE_BINDING_CHANGED")
  },
  assertNativeHarnessProjectMutable: () => {},
  readNativeHarnessFeature: (project: string, feature: string) =>
    state.binding?.projectId === project && state.binding?.featureId === feature ? state.binding : undefined,
  findNativeHarnessFeatureByRunId: (id: string) => state.binding?.hostRunId === id ? state.binding : undefined,
  ensureNativeHarnessFeatureRun: (...args: unknown[]) => state.ensureNative(...args)
}))
vi.mock("../harness-board/service", () => ({
  // These IPC fixtures represent pre-existing native projects without owner receipts.
  // Real parent/child providers and aggregate consent are covered by the service integration.
  readHarnessProjectUseParent: () => undefined,
  prepareHarnessProjectUseParent: async () => undefined,
  assertHarnessProjectUseChild: () => { throw Error("UNEXPECTED_OWNER_ADMISSION") }
}))
vi.mock("./native-harness-source", () => ({
  registerNativeHarnessSourceHandlers: () => (...args: unknown[]) => state.nativeReady(...args)
}))
vi.mock("electron", () => ({ BrowserWindow: {} }))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.dataRoot ?? "C:/unused-runtime-authority", getPlugins: () => state.plugins,
  getUserInfo: () => null }))
vi.mock("../db", async (importOriginal) => {
  const readTestThread = (id: string) => state.threadWorkspaces[id]
    ? { metadata: JSON.stringify({ workspacePath: state.threadWorkspaces[id] }) } : undefined
  return {
    ...await importOriginal<typeof import("../db")>(),
    getThreadCore: readTestThread,
    getThreadRuntimeScope: readTestThread
  }
})
vi.mock("../harness-board/project-runtime/host-service", () => ({
  HostProjectService: class { constructor() { return state.service as object } }
}))
vi.mock("../harness-board/project-runtime/host-store", () => ({ HostProjectStore: class {
  constructor(path: string) {
    if (state.openHostStore) return state.openHostStore(path)
    if (state.dataRoot) {
      state.hostStoreOpened()
      throw Error("HOST_DATABASE_UNREADABLE")
    }
  }
} }))
vi.mock("../harness-board/project-runtime/package-snapshots", async (importOriginal) => ({
  ...await importOriginal<typeof import("../harness-board/project-runtime/package-snapshots")>(),
  HostPackageSnapshots: class {}
}))
vi.mock("../plugins/derivation-source", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/derivation-source")>()
  return { ...original, snapshotDerivationSource: async (directory: string) => {
    const snapshot = await original.snapshotDerivationSource(directory)
    state.afterSnapshot?.(directory)
    return snapshot
  } }
})
vi.mock("../harness-board/project-runtime/workspace-mode-guard", () => ({ ProjectWorkspaceModeGuard: class {} }))
vi.mock("./project-runtime-legacy", () => ({ registerLegacyProjectRuntimeHandlers: () => undefined }))
vi.mock("./project-runtime-import", () => ({ registerProjectImportHandlers: () => {} }))
vi.mock("./project-preview", () => ({ registerProjectPreviewHandlers: () => {} }))
vi.mock("./project-runtime-mods", () => ({ registerProjectRuntimeModsHandlers: () => {} }))
vi.mock("./project-composition", () => ({
  registerProjectCompositionHandlers: (...args: Parameters<RegisterComposition>) =>
    state.registerComposition ? (state.composition = state.registerComposition(...args)) : {}
}))
vi.mock("./user-input", () => ({ configureHostInputResumeHandler: () => {} }))
vi.mock("../agent/workflow/run-manager", () => ({ workflowRunManager: {} }))
vi.mock("../agent/local-sandbox", () => ({ LocalSandbox: {} }))
vi.mock("../agent/thread-run-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/thread-run-lease")>()
  return {
    ...actual,
    registerLocalThreadRunAdmissionGuard: (guard: Parameters<typeof actual.registerLocalThreadRunAdmissionGuard>[0]) => {
      if (state.registerComposition)
        state.closeAdmission = actual.registerLocalThreadRunAdmissionGuard(guard)
    }
  }
})
vi.mock("../agent/agent-run-service", () => ({ createBrowserWindowAgentRunDelivery: () => ({}) }))
vi.mock("../harness-board/project-action-runtime", () => ({ getProjectActionRuntime: () => ({}) }))
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ store: {} }) }))
vi.mock("../mods/builtins/project-facts", () => ({ registerBuiltinProjectBinding: () => {}, registerBuiltinProjectFacts: () => {}, projectHostFacts: () => ({}) }))
vi.mock("../mods/devtools/project-preview-registry", () => ({
  isProjectPreviewId: () => false, projectPreviewRegistry: { describe: () => undefined }
}))
vi.mock("../mods/devtools/project-authoring-session", () => ({ projectAuthoringSessions: {
  setChanged: () => {}, configureTrialObservation: () => {}, notifyTrialProject: () => {}
} }))
vi.mock("../mods/devtools/project-stage-debug", () => ({
  ProjectStageDebugSessions: class { assertCommand() { return undefined } }, configureProjectStageDebugResolver: () => {}
}))
vi.mock("../mods/devtools/stage-recovery-inputs", () => ({ StageRecoveryInputs: class {} }))
vi.mock("../harness-board/project-runtime-function-source", () => ({ getProjectRuntimeFunctionManager: () => undefined }))
vi.mock("../mods/v2/platform-project-runtime-native", () => ({
  configureProjectRuntimePlatformResolver: () => {}, configureProjectRuntimeNativeCommand: () => {}
}))
vi.mock("../harness-board/project-runtime/composition-legacy-production", () => ({ createLegacyCompositionDependencies: () => ({}) }))
import { registerProjectRuntimeHandlers } from "./project-runtime"

it("rejects internal Host feature material fields from the standalone renderer create IPC", async () => {
  const localCreate = vi.fn()
  state.service = { recoverInterrupted: () => {}, localCreate }
  const contents = { mainFrame: {}, isDestroyed: () => false }
  const owner = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerProjectRuntimeHandlers({
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  } as unknown as IpcMain, () => owner)
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
  await expect(handlers.get("project-runtime:create")!(event, {
    installedPluginId: "installed",
    name: "Standalone project",
    workspace: "C:/fixture",
    goal: "Review",
    harnessFeatureInputs: { selectedDeployUnits: ["orders"], knowledgeRoots: [] }
  })).rejects.toThrow("PROJECT_INVALID_INPUT")
  expect(localCreate).not.toHaveBeenCalled()
})

it("captures explicit prepare instructions before the native preparation await", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const prepare = vi.fn()
  state.service = {
    recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => ({ projectId: "project", installedPluginId: "installed", version: 1,
      stageIndex: 0, manifest: { stages: [{}] } }),
    operations: () => [], prepare,
    prepareRuntimeInputs: async () => { entered.resolve(); await release.promise }
  }
  const contents = { mainFrame: {}, isDestroyed: () => false }
  const owner = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerProjectRuntimeHandlers({ handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as IpcMain,
    () => owner)
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
  const command = { kind: "prepare", expectedVersion: 1, idempotencyKey: "new-op",
    stageInstructions: "Original explicit task" }
  const result = handlers.get("project-runtime:command")!(event, "project", command)
  await entered.promise
  command.stageInstructions = "Late replacement"
  release.resolve()
  await result
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ projectId: "project", expectedVersion: 1,
    idempotencyKey: "new-op", stageInstructions: "Original explicit task" })
})

it("forwards bounded-result feedback only through the trusted native result-decision call", async () => {
  const decideResultApproval = vi.fn()
  const project = { projectId: "project", installedPluginId: "installed", version: 1,
    status: "active", stageIndex: 0, manifest: { stages: [{}] } }
  state.service = {
    recoverInterrupted: () => {}, importedSource: () => undefined, get: () => project,
    operations: () => [{ operationId: "operation", expectedVersion: 1, status: "succeeded" }],
    prepareRuntimeInputs: async () => {}, decideResultApproval
  }
  const contents = { mainFrame: {}, isDestroyed: () => false }
  const owner = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerProjectRuntimeHandlers({ handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as IpcMain,
    () => owner)
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
  const review = { operationId: "operation", expectedVersion: 1, inputFingerprint: "a".repeat(64),
    pluginDigest: "b".repeat(64), artifactFingerprint: "c".repeat(64),
    receiptFingerprint: "d".repeat(64), policyDigest: "e".repeat(64) }
  await handlers.get("project-runtime:command")!(event, "project", {
    kind: "approve-result", operationId: "operation", review,
    decision: "rejected", feedback: "Revise the business boundary", actorId: "untrusted-field"
  })
  expect(decideResultApproval).toHaveBeenCalledExactlyOnceWith("operation", {
    ...review, decision: "rejected", feedback: "Revise the business boundary", actorId: "desktop-user"
  })
  await expect(handlers.get("project-runtime:command")!({ ...event, sender: {} }, "project", {
    kind: "approve-result", operationId: "operation", review, decision: "rejected", feedback: "Other"
  })).rejects.toThrow("PROJECT_UNTRUSTED_SENDER")
  expect(decideResultApproval).toHaveBeenCalledTimes(1)
})

it.each(["destroyed", "replaced"])("rejects the actual desktop command before approval after its window is %s during preparation", async change => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const approve = vi.fn()
  state.service = {
    recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => ({ projectId: "project", installedPluginId: "installed", version: 1,
      stageIndex: 0, manifest: { stages: [{}] } }),
    operations: () => [{ operationId: "operation", expectedVersion: 1 }],
    prepareRuntimeInputs: async () => { entered(); await new Promise<void>(resolve => { release = resolve }) },
    approve
  }
  let destroyed = false
  const contents = { mainFrame: {}, isDestroyed: () => false }
  const owner = { isDestroyed: () => destroyed, webContents: contents } as unknown as BrowserWindow
  let mainWindow = owner
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerProjectRuntimeHandlers({ handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as IpcMain,
    () => mainWindow)
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
  const result = handlers.get("project-runtime:command")!(event, "project", {
    kind: "approve", operationId: "operation", expectedVersion: 1,
    inputFingerprint: "a".repeat(64), decision: "approved"
  })
  await waiting
  if (change === "destroyed") destroyed = true
  else mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as unknown as BrowserWindow
  release()
  await expect(result).rejects.toThrow("PROJECT_UNTRUSTED_SENDER")
  expect(approve).not.toHaveBeenCalled()
})


const templateRoots: string[] = []
let authorizationStore: ModControlStore
beforeEach(() => {
  const root = mkdtempSync(join(canonicalTmpdir(), "native-authority-control-"))
  templateRoots.push(root)
  authorizationStore = new ModControlStore(join(root, "control.sqlite"))
  configureProjectUseRuntime({ store: authorizationStore, workspaceKey: value => value,
    manager: { setProjectUseGrantResolver: () => {} } as unknown as FunctionModsManager,
    control: {
      applicationStamp: () => "unchanged", settingsStamp: () => "unchanged",
      globallyEnabled: () => false, enabled: () => false,
      enable: () => { throw Error("UNEXPECTED_OWNER_ENABLE") },
      initialize: () => { throw Error("UNEXPECTED_OWNER_INITIALIZATION") },
      enableApplication: () => { throw Error("UNEXPECTED_OWNER_ENABLE") }
    } })
})
afterEach(() => {
  state.closeAdmission?.()
  state.composition?.store().close()
  state.closeAdmission = undefined
  state.composition = undefined
  state.registerComposition = undefined
  state.threadWorkspaces = {}
  state.dataRoot = undefined
  state.hostStoreOpened.mockClear()
  state.openHostStore = undefined
  authorizationStore.close()
  state.plugins = []
  state.binding = undefined
  state.nativeRuntime = undefined
  state.ensureNative.mockReset()
  state.assertFeatureCurrent.mockClear()
  state.nativeReady.mockReset().mockResolvedValue({ ready: true, assertCurrent: () => {},
    assertExecutionReady: () => {} })
  state.afterSnapshot = undefined
  for (const root of templateRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("admits ordinary chat with an existing composition store and an unreadable Host database", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "composition-chat-admission-"))
  templateRoots.push(root)
  state.dataRoot = root
  const workspace = join(root, "leased-workspace")
  const unrelated = join(root, "unrelated-workspace")
  mkdirSync(workspace)
  mkdirSync(unrelated)
  mkdirSync(join(root, "local-projects"))
  writeFileSync(join(root, "local-projects", "state.sqlite"), "unreadable Host database")
  state.threadWorkspaces = { chat: workspace, unrelated }
  state.registerComposition = (await vi.importActual<typeof import("./project-composition")>(
    "./project-composition"
  )).registerProjectCompositionHandlers
  const seed = new ProjectCompositionStore(join(root, "project-compositions", "state.sqlite"))
  try {
    nativeHandlers()
    expect(claimLocalThreadRunLease({ threadId: "chat", owner: "desktop", runId: "plain" }).acquired)
      .toBe(true)
    releaseLocalThreadRunLease("chat", "desktop", "plain")

    seed.create({
      apiVersion: "devclaw.project-composition/v1",
      parentProjectId: "parent",
      workspace,
      units: [{ id: "step", kind: "flow", inputs: [], outputs: [],
        source: { pluginId: "plugin", capabilityId: "step", packageDigest: "a".repeat(64) } }]
    }, "request")
    expect(() => claimLocalThreadRunLease({ threadId: "chat", owner: "desktop", runId: "leased" }))
      .toThrow("COMPOSITION_WORKSPACE_BUSY")
    expect(claimLocalThreadRunLease({ threadId: "unrelated", owner: "desktop", runId: "other" }).acquired)
      .toBe(true)
    expect(state.hostStoreOpened).not.toHaveBeenCalled()
  } finally {
    releaseLocalThreadRunLease("chat", "desktop", "leased")
    releaseLocalThreadRunLease("unrelated", "desktop", "other")
    seed.close()
  }
})

function nativeHandlers() {
  let destroyed = false
  const contents = { mainFrame: {}, isDestroyed: () => destroyed }
  const owner = { isDestroyed: () => destroyed, webContents: contents } as unknown as BrowserWindow
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerProjectRuntimeHandlers(
    {
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler)
    } as unknown as IpcMain,
    () => owner
  )
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame
  } as unknown as IpcMainInvokeEvent
  return {
    native: (...args: unknown[]) => handlers.get("harnessBoard:nativeFeatureCommand")!(event, ...args),
    call: (name: string, ...args: unknown[]) =>
      handlers.get(`project-runtime:${name}`)!(event, ...args),
    destroy: () => {
      destroyed = true
    }
  }
}

function installedTemplate() {
  const root = mkdtempSync(join(canonicalTmpdir(), "project-template-identity-"))
  templateRoots.push(root)
  const manifest = hostProjectFixture(root).manifest
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(root, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(join(root, "skills", stage.id), { recursive: true })
    writeFileSync(join(root, stage.skill!), "Original reviewed stage")
  }
  const plugin = {
    id: `installed-${state.plugins.length}`,
    path: root,
    name: "docs",
    version: "1.0.0",
    enabled: true
  }
  state.plugins.push(plugin)
  return plugin
}

it("returns exact ordinary template content identities without scanning unrelated broken plugins", async () => {
  const plugin = installedTemplate()
  const other = installedTemplate()
  const malformed = mkdtempSync(join(canonicalTmpdir(), "not-a-host-template-"))
  templateRoots.push(malformed)
  writeFileSync(join(malformed, "devclaw.project-runtime.json"), "{bad json")
  state.plugins.unshift(
    { ...plugin, id: "missing-chat", path: join(malformed, "missing") },
    { ...plugin, id: "malformed-chat", path: malformed },
    { ...plugin, id: "disabled", enabled: false }
  )
  const expected = derivationContentIdentity((await snapshotDerivationSource(plugin.path)).files)
  const result = (await nativeHandlers().call("templates")) as Array<Record<string, unknown>>
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({
    installedPluginId: plugin.id,
    expectedTemplate: { pluginId: plugin.id, name: "docs", version: "1.0.0", digest: expected }
  })
  expect(result[1]).toMatchObject({
    installedPluginId: other.id,
    expectedTemplate: { pluginId: other.id, digest: expected }
  })
})

it("reads only the selected Host template even if another installed template cannot be snapshotted", async () => {
  const broken = installedTemplate()
  const selected = installedTemplate()
  const scanned: string[] = []
  state.afterSnapshot = (directory) => {
    scanned.push(directory)
    if (directory === broken.path) throw Error("UNRELATED_SOURCE_CHANGED")
  }
  const handlers = nativeHandlers()
  await expect(handlers.call("templates", selected.id)).resolves.toMatchObject([
    { installedPluginId: selected.id, expectedTemplate: { pluginId: selected.id } }
  ])
  expect(scanned).toEqual([selected.path])
  await expect(handlers.call("templates", "absent")).resolves.toEqual([])
  expect(scanned).toEqual([selected.path])
  await expect(handlers.call("templates")).rejects.toThrow("UNRELATED_SOURCE_CHANGED")
})

it("discovers a Host template after one hundred enabled ordinary plugins", async () => {
  const plugin = installedTemplate()
  state.plugins.unshift(...Array.from({ length: 100 }, (_, index) => ({
    ...plugin, id: `ordinary-${index}`, path: join(plugin.path, `ordinary-${index}`)
  })))
  const result = await nativeHandlers().call("templates") as Array<Record<string, unknown>>
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ installedPluginId: plugin.id })
})

it("reports the installed-plugin scan budget instead of silently hiding templates", async () => {
  const plugin = installedTemplate()
  state.plugins = Array.from({ length: 4097 }, (_, index) => ({
    ...plugin, id: `installed-${index}`
  }))
  await expect(nativeHandlers().call("templates")).rejects.toThrow("PROJECT_TEMPLATE_PLUGIN_LIMIT")
})

it("retains all Host candidates after the former one hundred template boundary", async () => {
  const plugin = installedTemplate()
  state.plugins = Array.from({ length: 101 }, (_, index) => ({
    ...plugin, id: `installed-${index}`
  }))
  const result = await nativeHandlers().call("templates") as Array<Record<string, unknown>>
  expect(result).toHaveLength(101)
  expect(result.at(-1)).toMatchObject({ installedPluginId: "installed-100" })
})

it("forwards bounded literal project search to the account's store before paging", async () => {
  const list = vi.fn(() => [])
  state.service = { recoverInterrupted: () => {}, list }
  const handlers = nativeHandlers()
  expect(await handlers.call("list", "", "report_%")).toEqual([])
  expect(list).toHaveBeenCalledExactlyOnceWith(100, "", "report_%")
  for (const query of ["x".repeat(513), "bad\0query", 7, null])
    expect(() => handlers.call("list", "", query)).toThrow("SEARCH_QUERY_INVALID")
  expect(list).toHaveBeenCalledTimes(1)
})

it.each(["bytes", "disabled", "replaced", "window"])(
  "does not publish a template identity after %s changes during its real source read",
  async (change) => {
    const plugin = installedTemplate()
    const handlers = nativeHandlers()
    state.afterSnapshot = () => {
      if (change === "bytes") writeFileSync(join(plugin.path, "skills/draft/SKILL.md"), "Changed")
      if (change === "disabled") plugin.enabled = false
      if (change === "replaced") state.plugins = [{ ...plugin, path: `${plugin.path}-new` }]
      if (change === "window") handlers.destroy()
    }
    await expect(handlers.call("templates")).rejects.toThrow()
  }
)

it("rechecks earlier template identities after later template reads", async () => {
  const first = installedTemplate()
  installedTemplate()
  let reads = 0
  state.afterSnapshot = () => {
    if (++reads === 2) writeFileSync(join(first.path, "skills/draft/SKILL.md"), "Late change")
  }
  await expect(nativeHandlers().call("templates")).rejects.toThrow("PACKAGE_CHANGED")
})

function creationService(localCreate: (...args: unknown[]) => unknown) {
  const project = {
    projectId: "project",
    installedPluginId: "installed",
    version: 1,
    status: "active",
    stageIndex: 0,
    manifest: { stages: [{}] }
  }
  state.service = {
    recoverInterrupted: () => {},
    importedSource: () => undefined,
    get: () => project,
    operations: () => [],
    localCreate
  }
  return project
}

const templateIdentity = {
  pluginId: "installed",
  name: "docs",
  version: "1.0.0",
  digest: "a".repeat(64)
}
const templateCreation = {
  name: "Project",
  workspace: "C:/workspace",
  goal: "Review",
  installedPluginId: "installed"
}

it("routes ordinary expectedTemplate through the retained-source CAS without a Creator thread", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let captured: Record<string, unknown> | undefined
  const project = creationService(async (...args) => {
    captured = args[0] as Record<string, unknown>
    entered.resolve()
    await release.promise
    const assertCurrent = args[1] as () => void
    assertCurrent()
    return project
  })
  const expectedTemplate = { ...templateIdentity }
  const pending = nativeHandlers().call("create", { ...templateCreation, expectedTemplate })
  await entered.promise
  expectedTemplate.digest = "b".repeat(64)
  release.resolve()
  await pending
  expect(captured).toMatchObject({ ...templateCreation, expectedPlugin: templateIdentity })
  expect(captured).not.toHaveProperty("expectedTemplate")
  expect(captured).not.toHaveProperty("startUseScope")
})

it("keeps Creator scope mandatory and rejects mixing or malformed ordinary identities", async () => {
  const localCreate = vi.fn()
  creationService(localCreate)
  const handlers = nativeHandlers()
  for (const input of [
    { expectedPlugin: templateIdentity },
    { expectedTemplate: templateIdentity, expectedPlugin: templateIdentity },
    {
      expectedTemplate: templateIdentity,
      startUseScope: { threadId: "fake", expectedWorkspace: "C:/workspace" }
    },
    { expectedTemplate: null },
    { expectedTemplate: { ...templateIdentity, pluginId: "other" } },
    { expectedTemplate: { ...templateIdentity, digest: "invalid" } },
    { expectedTemplate: { ...templateIdentity, grant: true } }
  ])
    await expect(handlers.call("create", { ...templateCreation, ...input })).rejects.toThrow()
  expect(localCreate).not.toHaveBeenCalled()
})

it("keeps ordinary template creation fenced after its native await", async () => {
  const handlers = nativeHandlers()
  creationService(async (...args) => {
    await Promise.resolve()
    handlers.destroy()
    const assertCurrent = args[1] as () => void
    assertCurrent()
    throw Error("unexpected commit")
  })
  await expect(
    handlers.call("create", { ...templateCreation, expectedTemplate: templateIdentity })
  ).rejects.toThrow("PROJECT_UNTRUSTED_SENDER")
})

function nativeFeatureFixture() {
  state.binding = {
    engine: "host", projectId: "container", featureId: "feature-a", hostRunId: "host-a",
    title: "Feature A", workspace: "C:/feature-a", repositoryWorkspace: "C:/repository",
    installedPluginId: "installed", packageDigest: "b".repeat(64),
    expectedPlugin: { pluginId: "installed", name: "generic", version: "1.0", digest: "c".repeat(64) }
  }
  const project = { projectId: "host-a", installedPluginId: "installed", pluginDigest: "b".repeat(64),
    workspace: "C:/feature-a", version: 1, status: "active", stageIndex: 0,
    manifest: { stages: [{}] } }
  const operation = { operationId: "host-op", expectedVersion: 1, status: "started" }
  return { project, operation }
}

it("dispatches Feature first-start using the original Host continuation and permits cancellation while rejecting duplicate starts", async () => {
  const { project, operation } = nativeFeatureFixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const cancel = vi.fn()
  const continuation = vi.fn(async (_id, options) => {
    options.beforeStart(operation)
    entered.resolve()
    await release.promise
    options.assertAuthority()
    return { reason: "cancelled" }
  })
  state.service = {
    recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => project, operations: () => [operation],
    prepareRuntimeInputs: async () => {}, continue: continuation, cancel
  }
  const beforeCreate = vi.fn()
  state.ensureNative.mockImplementation(async (_project, _feature, _goal, guard, workspace, preflight) => {
    const assertReady = await preflight({ original: state.binding, workspace, assertCurrent: guard })
    assertReady()
    beforeCreate()
  })
  const h = nativeHandlers()
  const starting = h.native("container", "feature-a", {
    kind: "start-feature", initialUserMessage: "Actual independent Feature request"
  })
  await entered.promise
  expect(beforeCreate).toHaveBeenCalledOnce()
  expect(state.nativeReady).toHaveBeenCalledTimes(2)
  expect(state.nativeReady.mock.calls[0][2]).toMatchObject({ assertCurrent: expect.any(Function) })
  expect(state.nativeReady.mock.calls[1]).toHaveLength(2)
  await expect(h.native("container", "feature-a", {
    kind: "start-feature", initialUserMessage: "Late second request"
  })).rejects.toThrow("PROJECT_OPERATION_ALREADY_RUNNING")
  await h.native("container", "feature-a", { kind: "cancel", operationId: "host-op" })
  expect(cancel).toHaveBeenCalledExactlyOnceWith("host-op")
  expect(state.ensureNative.mock.calls[0].slice(0, 3)).toEqual([
    "container", "feature-a", "Actual independent Feature request"
  ])
  expect(continuation).toHaveBeenCalledTimes(1)
  release.resolve()
  await starting
})

it("rejects another Feature and a late binding replacement before native approval", async () => {
  const { project, operation } = nativeFeatureFixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const approve = vi.fn()
  state.service = {
    recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => project, operations: () => [operation], approve,
    prepareRuntimeInputs: async () => { entered.resolve(); await release.promise }
  }
  const h = nativeHandlers()
  await expect(h.native("container", "feature-b", { kind: "cancel", operationId: "host-op" }))
    .rejects.toThrow("HARNESS_NATIVE_RUN_NOT_STARTED")
  const deciding = h.native("container", "feature-a", {
    kind: "approve", operationId: "host-op", expectedVersion: 1,
    inputFingerprint: "a".repeat(64), decision: "approved"
  })
  await entered.promise
  expect(state.assertFeatureCurrent).toHaveBeenCalledOnce()
  state.binding = { ...state.binding!, repositoryWorkspace: "C:/other-repository" }
  release.resolve()
  await expect(deciding).rejects.toThrow("HARNESS_NATIVE_BINDING_CHANGED")
  expect(state.assertFeatureCurrent).toHaveBeenCalledTimes(2)
  expect(approve).not.toHaveBeenCalled()
})

it("keeps standalone Host history visible and excludes Feature-owned executions", async () => {
  const { project } = nativeFeatureFixture()
  const standalone = { ...project, projectId: "standalone", name: "Historical run" }
  state.service = {
    recoverInterrupted: () => {}, list: () => [project, standalone]
  }
  expect(nativeHandlers().call("list")).toEqual([expect.objectContaining({ projectId: "standalone" })])
})

it("retries first Host recovery after repairing storage and closes each failed candidate", async () => {
  const { HostProjectStore } = await vi.importActual<
    typeof import("../harness-board/project-runtime/host-store")
  >("../harness-board/project-runtime/host-store")
  const root = mkdtempSync(join(canonicalTmpdir(), "host-recovery-retry-"))
  templateRoots.push(root)
  state.dataRoot = root
  const path = join(root, "local-projects", "state.sqlite")
  const seed = new HostProjectStore(path)
  const project = seed.create(hostProjectFixture(root))
  const operation = seed.prepare(prepareFixture())
  const ticket = seed.start(operation.operationId, TEST_FINGERPRINT)
  seed.bindExecutionThread(ticket, "original-thread")
  seed.close()

  const candidates: HostStore[] = []
  state.openHostStore = (database) => {
    const store = new HostProjectStore(database)
    candidates.push(store)
    return store
  }
  const recover = vi.fn(() => candidates.at(-1)!.recoverInterrupted())
  state.service = {
    recoverInterrupted: recover,
    get: (id: string) => candidates.at(-1)!.get(id),
    operations: (id: string, limit: number) => candidates.at(-1)!.listOperations(id, limit),
    importedSource: () => undefined
  }
  const close = vi.spyOn(HostProjectStore.prototype, "close")
  const raw = new DatabaseSync(path)
  try {
    const status = raw.prepare("UPDATE host_operations SET status=? WHERE id=?")
    status.run("cancel_requested", operation.operationId)
    const handlers = nativeHandlers()
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => handlers.call("get", project.projectId)).toThrow("STORAGE_MISMATCH")
    }
    expect(close.mock.contexts).toEqual(candidates)
    expect(close).toHaveBeenCalledTimes(2)

    status.run("started", operation.operationId)
    const expected = {
      project: { projectId: project.projectId },
      operations: [expect.objectContaining({
        operationId: operation.operationId,
        status: "unknown",
        execution: expect.objectContaining({ threadId: "original-thread" })
      })]
    }
    expect(handlers.call("get", project.projectId)).toMatchObject(expected)
    expect(handlers.call("get", project.projectId)).toMatchObject(expected)
    expect(recover).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(2)
  } finally {
    raw.close()
    const closed = close.mock.contexts
    close.mockRestore()
    for (const candidate of candidates) {
      if (!closed.includes(candidate)) candidate.close()
    }
  }
})

it.each(["unknown", "started"] as const)(
  "keeps %s Host history readable when the separate input ledger is corrupt",
  async (status) => {
    const { HostProjectStore } = await vi.importActual<
      typeof import("../harness-board/project-runtime/host-store")
    >("../harness-board/project-runtime/host-store")
    const root = mkdtempSync(join(canonicalTmpdir(), "host-view-input-ledger-"))
    templateRoots.push(root)
    const inputPath = join(root, "user-input.sqlite")
    const store = new HostProjectStore(join(root, "state.sqlite"))
    try {
      const project = store.create(hostProjectFixture(root))
      const historical = store.prepare(prepareFixture())
      store.cancel(historical.operationId)
      const pending = store.prepare(prepareFixture({ idempotencyKey: "interrupted" }))
      const ticket = store.start(pending.operationId, TEST_FINGERPRINT)
      store.bindExecutionThread(ticket, "original-thread")
      if (status === "unknown") store.recoverInterrupted()
      const resumeInput = vi.fn()
      const execute = vi.fn((operationId: string) => store.start(operationId, TEST_FINGERPRINT))
      state.service = {
        get: (id: string) => store.get(id),
        operations: (id: string, limit: number) => store.listOperations(id, limit),
        importedSource: () => undefined,
        recoverInterrupted: () => {},
        prepareRuntimeInputs: async () => {},
        start: execute,
        resumeInput
      }
      const handlers = nativeHandlers()
      const healthy = new HostUserInputStore(inputPath)
      try {
        configureHostUserInputPersistence({ store: () => healthy, isCurrent: () => false })
        expect(handlers.call("get", project.projectId)).not.toHaveProperty("inputWaitError")
      } finally {
        healthy.close()
      }
      const damaged = Buffer.from("invalid SQLite input ledger".repeat(128))
      writeFileSync(inputPath, damaged)
      const openInput = vi.fn(() => new HostUserInputStore(inputPath))
      configureHostUserInputPersistence({
        store: openInput,
        isCurrent: () => false
      })
      const expected = {
        project: { projectId: project.projectId },
        operations: [
          expect.objectContaining({ operationId: pending.operationId, status }),
          expect.objectContaining({ operationId: historical.operationId, status: "cancelled" })
        ],
        inputWaitError: expect.stringContaining("续接输入记录不可读")
      }
      const detail = handlers.call("get", project.projectId)
      expect(detail).toMatchObject(expected)
      expect(detail).not.toHaveProperty("inputWait")
      expect(state.nativeRuntime?.view(project.projectId)).toMatchObject(expected)
      openInput.mockClear()
      const summary = state.nativeRuntime?.view(project.projectId, "summary")
      expect(summary).toMatchObject({ project: expected.project, operations: expected.operations })
      expect(summary).not.toHaveProperty("inputWaitError")
      expect(openInput).not.toHaveBeenCalled()
      expect(state.nativeRuntime?.view(project.projectId, "discussion")).toMatchObject(expected)
      expect(openInput).toHaveBeenCalledOnce()
      await expect(handlers.call("command", project.projectId, {
        kind: "resume-input", operationId: pending.operationId, requestId: "host-input:original"
      })).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 26 })
      expect(resumeInput).not.toHaveBeenCalled()
      await expect(handlers.call("command", project.projectId, {
        kind: "start", operationId: pending.operationId
      })).rejects.toThrow("OPERATION_NOT_PREPARED")
      expect(store.getOperation(pending.operationId)?.status).toBe(status)
      expect(readFileSync(inputPath)).toEqual(damaged)
    } finally {
      configureHostUserInputPersistence(undefined)
      store.close()
    }
  }
)

it("omits result review work from Host project summaries and rechecks it in run detail", () => {
  const { project, operation } = nativeFeatureFixture()
  const proposal = { ...project, manifest: { stages: [{ resultApproval: "human" }] } }
  const succeeded = { ...operation, status: "succeeded" }
  const operations = vi.fn(() => [succeeded])
  const resultReview = vi.fn(() => { throw Error("PROJECT_HOST_INPUT_CHANGED") })
  state.service = {
    recoverInterrupted: () => {},
    get: () => proposal,
    importedSource: () => undefined,
    operations,
    resultReview
  }
  nativeHandlers()
  const summary = state.nativeRuntime?.view(project.projectId, "summary")
  expect(summary).toMatchObject({ operations: [succeeded] })
  expect(summary).not.toHaveProperty("resultReviewError")
  expect(operations).toHaveBeenLastCalledWith(project.projectId, 20, false)
  expect(resultReview).not.toHaveBeenCalled()
  expect(state.nativeRuntime?.view(project.projectId, "discussion")).toEqual(summary)
  expect(resultReview).not.toHaveBeenCalled()

  expect(state.nativeRuntime?.view(project.projectId)).toMatchObject({
    operations: [succeeded],
    resultApprovalRequired: true,
    resultReviewError: expect.stringContaining("成果或检查已变化")
  })
  expect(operations).toHaveBeenLastCalledWith(project.projectId, 20, true)
  expect(resultReview).toHaveBeenCalledExactlyOnceWith(succeeded.operationId)
})

it("does not let a Feature replace its fixed package through the standalone migration command", async () => {
  const { project } = nativeFeatureFixture()
  const prepareRuntimeInputs = vi.fn()
  state.service = {
    recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => project, operations: () => [], prepareRuntimeInputs
  }
  await expect(nativeHandlers().call("command", "host-a", {
    kind: "review-plan", expectedVersion: 1
  })).rejects.toThrow("HARNESS_NATIVE_FEATURE_SOURCE_FIXED")
  expect(prepareRuntimeInputs).not.toHaveBeenCalled()
})

it("passes the prospective directory to native readiness before creating the first Host run", async () => {
  const { project } = nativeFeatureFixture()
  const beforeCreate = vi.fn()
  const continuation = vi.fn()
  state.service = { recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => project, operations: () => [], continue: continuation }
  state.ensureNative.mockImplementation(async (_project, _feature, _goal, guard, workspace, preflight) => {
    await preflight({ original: state.binding, workspace, assertCurrent: guard })
    beforeCreate()
  })
  state.nativeReady.mockResolvedValue({ ready: false, assertCurrent: () => {}, assertExecutionReady: () => {} })
  const handlers = nativeHandlers()
  await expect(handlers.native("container", "feature-a", {
    kind: "start-feature", initialUserMessage: "First goal", workspacePath: "C:/chosen-execution"
  })).rejects.toThrow("所选运行目录")
  expect(state.nativeReady).toHaveBeenCalledWith(expect.anything(), "host-a",
    expect.objectContaining({ workspace: "C:/chosen-execution" }))
  expect(beforeCreate).not.toHaveBeenCalled()
  expect(continuation).not.toHaveBeenCalled()
})

it("refuses to create a replacement at the Host adapter for a missing published Feature", async () => {
  nativeFeatureFixture()
  const localCreate = vi.fn()
  state.service = { recoverInterrupted: () => {}, get: () => undefined, localCreate }
  nativeHandlers()
  const binding = state.binding!
  await expect(state.nativeRuntime!.create({
    projectId: binding.hostRunId, installedPluginId: binding.installedPluginId,
    name: binding.title, workspace: binding.workspace, goal: "Original user request",
    expectedPlugin: binding.expectedPlugin
  })).rejects.toThrow("HARNESS_NATIVE_EXECUTION_MISSING")
  expect(localCreate).not.toHaveBeenCalled()
})

it("blocks an already persisted native continuation before any Skill when its actual scope is not ready", async () => {
  const { project } = nativeFeatureFixture()
  const continuation = vi.fn()
  const prepareRuntimeInputs = vi.fn()
  state.service = { recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => project, operations: () => [], prepareRuntimeInputs, continue: continuation }
  state.ensureNative.mockImplementation(async (_project, _feature, _goal, guard) => guard())
  state.nativeReady.mockResolvedValue({ ready: false, assertCurrent: () => {}, assertExecutionReady: () => {} })
  const result = await nativeHandlers().native("container", "feature-a", {
    kind: "start-feature", initialUserMessage: "Actual request", workspacePath: "C:/chosen-execution"
  }) as { continuation: { reason: string; error: string } }
  expect(result.continuation.reason).toBe("blocked")
  expect(result.continuation.error).toContain("本次运行目录已保存")
  expect(state.ensureNative.mock.calls[0][4]).toBe("C:/chosen-execution")
  expect(state.nativeReady).toHaveBeenCalledTimes(1)
  expect(prepareRuntimeInputs).not.toHaveBeenCalled()
  expect(continuation).not.toHaveBeenCalled()
})

it("carries the independent readiness fence past the dispatch preparation await", async () => {
  const { project } = nativeFeatureFixture()
  let configured = true
  const continuation = vi.fn()
  state.nativeReady.mockResolvedValue({ ready: true, assertCurrent: () => {},
    assertExecutionReady: () => { if (!configured) throw Error("DEPENDENCY_CONFIGURATION_CHANGED") } })
  state.service = { recoverInterrupted: () => {}, importedSource: () => undefined,
    get: () => project, operations: () => [], continue: continuation,
    prepareRuntimeInputs: async () => { await Promise.resolve(); configured = false } }
  state.ensureNative.mockImplementation(async (_project, _feature, _goal, guard) => guard())
  await expect(nativeHandlers().native("container", "feature-a", {
    kind: "start-feature", initialUserMessage: "Actual request"
  })).rejects.toThrow("DEPENDENCY_CONFIGURATION_CHANGED")
  expect(continuation).not.toHaveBeenCalled()
})
