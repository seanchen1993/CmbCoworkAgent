import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"

const state = vi.hoisted(() => ({
  service: undefined as unknown,
  plugins: [] as Array<{ id: string; path: string; name: string; version: string; enabled: boolean }>,
  afterSnapshot: undefined as (() => void) | undefined
}))
vi.mock("electron", () => ({ BrowserWindow: {} }))
vi.mock("../storage", () => ({ getOpenworkDir: () => "C:/unused-runtime-authority", getPlugins: () => state.plugins }))
vi.mock("../db", () => ({ getThreadCore: () => undefined }))
vi.mock("../harness-board/project-runtime/host-service", () => ({
  HostProjectService: class { constructor() { return state.service as object } }
}))
vi.mock("../harness-board/project-runtime/host-store", () => ({ HostProjectStore: class {} }))
vi.mock("../harness-board/project-runtime/package-snapshots", async (importOriginal) => ({
  ...await importOriginal<typeof import("../harness-board/project-runtime/package-snapshots")>(),
  HostPackageSnapshots: class {}
}))
vi.mock("../plugins/derivation-source", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/derivation-source")>()
  return { ...original, snapshotDerivationSource: async (directory: string) => {
    const snapshot = await original.snapshotDerivationSource(directory)
    state.afterSnapshot?.()
    return snapshot
  } }
})
vi.mock("../harness-board/project-runtime/workspace-mode-guard", () => ({ ProjectWorkspaceModeGuard: class {} }))
vi.mock("./project-runtime-legacy", () => ({ registerLegacyProjectRuntimeHandlers: () => undefined }))
vi.mock("./project-runtime-import", () => ({ registerProjectImportHandlers: () => {} }))
vi.mock("./project-preview", () => ({ registerProjectPreviewHandlers: () => {} }))
vi.mock("./project-runtime-mods", () => ({ registerProjectRuntimeModsHandlers: () => {} }))
vi.mock("./project-composition", () => ({ registerProjectCompositionHandlers: () => () => ({}) }))
vi.mock("./user-input", () => ({ configureHostInputResumeHandler: () => {} }))
vi.mock("../services/user-input", () => ({ getHostInputWait: () => undefined, getHostInputContinuation: () => undefined }))
vi.mock("../agent/workflow/run-manager", () => ({ workflowRunManager: {} }))
vi.mock("../agent/local-sandbox", () => ({ LocalSandbox: {} }))
vi.mock("../agent/thread-run-lease", () => ({ registerLocalThreadRunAdmissionGuard: () => {}, listLocalThreadRunLeases: () => [] }))
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
afterEach(() => {
  state.plugins = []
  state.afterSnapshot = undefined
  for (const root of templateRoots.splice(0)) rmSync(root, { recursive: true, force: true })
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
    call: (name: string, ...args: unknown[]) =>
      handlers.get(`project-runtime:${name}`)!(event, ...args),
    destroy: () => {
      destroyed = true
    }
  }
}

function installedTemplate() {
  const root = mkdtempSync(join(tmpdir(), "project-template-identity-"))
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
  const malformed = mkdtempSync(join(tmpdir(), "not-a-host-template-"))
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
