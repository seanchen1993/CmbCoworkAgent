import { expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"

const state = vi.hoisted(() => ({ service: undefined as unknown }))
vi.mock("electron", () => ({ BrowserWindow: {} }))
vi.mock("../storage", () => ({ getOpenworkDir: () => "C:/unused-runtime-authority", getPlugins: () => [] }))
vi.mock("../db", () => ({ getThreadCore: () => undefined }))
vi.mock("../harness-board/project-runtime/host-service", () => ({
  HostProjectService: class { constructor() { return state.service as object } }
}))
vi.mock("../harness-board/project-runtime/host-store", () => ({ HostProjectStore: class {} }))
vi.mock("../harness-board/project-runtime/package-snapshots", () => ({ HostPackageSnapshots: class {} }))
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
