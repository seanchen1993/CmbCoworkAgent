import { managedRunStore } from "../harness-board/managed-run-store"
import {
  registerBuiltinLegacyMetricsReader,
  projectLegacyExecutionMetrics
} from "../mods/builtins/legacy-metrics"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { getThreadCore } from "../db"
import { getOpenworkDir, getPlugins } from "../storage"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { getLocalThreadRunLease, listLocalThreadRunLeases } from "../agent/thread-run-lease"
import { isAgentRunBusy } from "../agent/agent-run-service"
import { LocalSandbox } from "../agent/local-sandbox"
import { coordinatorWorkerManager } from "../agent/coordinator-worker-manager"
import {
  getHarnessProjectAdapterSnapshot,
  getHarnessProjectRootPath,
  assertHarnessProjectAdapterCurrent,
  captureHarnessKnowledgeDepositionWorkspace,
  getHarnessCapabilityFeatureWorkspace,
  readHarnessFeatureMetadata,
  requireHarnessFeatureWorkspace
} from "../harness-board/service"
import { LegacyOperationStore, legacyRecoveryRevision } from "../harness-board/project-runtime/legacy-operation-store"
import { LegacyProjectRuntimeService } from "../harness-board/project-runtime/legacy-runtime-service"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { runtimeDirectory } from "../harness-board/project-runtime/safe-files"
import { registerUnavailableLegacyRuntime } from "../harness-board/project-runtime/unavailable"
import { ProjectWorkspaceModeGuard } from "../harness-board/project-runtime/workspace-mode-guard"
import { LEGACY_PROJECT_SESSION_SCOPE } from "../harness-board/project-runtime/legacy-entry-gate"
import { LegacyOptInIndex, legacyIndexFilePresent } from "../harness-board/project-runtime/legacy-opt-in-index"
import { authorizeProjectWorkspaceResources } from "./project-workspace-resources"
import type {
  LegacyProjectRecoveryInput,
  LegacyProjectRuntimeView
} from "../../shared/project-runtime/legacy-operations"

/** Register at startup so persisted opt-in bindings fence the very first original entry. */
export function registerLegacyProjectRuntimeHandlers(
  ipc: IpcMain,
  trusted: (event: IpcMainInvokeEvent) => unknown,
  compositionGuard?: <T>(workspace: string, work: () => T) => T
) {
  const root = join(getOpenworkDir(), "legacy-project-runtime")
  const ledgerPath = join(root, "operations.sqlite")
  const indexPath = join(getOpenworkDir(), "legacy-project-bindings.sqlite")
  const optInIndex = new LegacyOptInIndex(indexPath)
  function readThread(threadId: string) {
    const thread = getThreadCore(threadId)
    if (!thread) return undefined
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (!metadata || typeof metadata.workspacePath !== "string") return undefined
    const feature = readHarnessFeatureMetadata(metadata)
    const project = metadata.harnessProjectSession
    const projectId = feature?.projectId ?? project?.projectId
    if (typeof projectId !== "string" || !projectId) return undefined
    const featureId = feature?.slug ?? LEGACY_PROJECT_SESSION_SCOPE
    // Do not inspect or constrain ordinary legacy workspaces before the service finds an opt-in.
    return {
      projectId,
      featureId,
      workspace: metadata.workspacePath,
      incarnation: JSON.stringify(captureThreadIncarnation(thread)),
      runId: feature?.runId,
      projectSessionKind: !feature && typeof project?.kind === "string" ? project.kind : undefined
    }
  }
  let store: LegacyOperationStore | undefined
  let service: LegacyProjectRuntimeService
  const priorIndex = optInIndex.read()
  let indexEstablished = priorIndex !== undefined
  let wasFresh = false
  const hasSidecar = () => ["-wal", "-shm", "-journal"].some((suffix) =>
    legacyIndexFilePresent(ledgerPath + suffix))
  const readProtectedProjects = () => {
    const latestIndex = optInIndex.read()
    if (latestIndex) return latestIndex
    try {
      if (wasFresh && !legacyIndexFilePresent(indexPath) && !legacyIndexFilePresent(ledgerPath) &&
          !hasSidecar()) return new Set<string>()
    } catch { /* An unsafe or inaccessible path cannot prove that opt-in has never happened. */ }
    return undefined
  }
  try {
    const ledgerExists = legacyIndexFilePresent(ledgerPath)
    if (!ledgerExists) {
      // A missing ledger cannot erase an earlier positive marker or repair an unreadable index.
      if (priorIndex?.size || (!priorIndex && legacyIndexFilePresent(indexPath)) || hasSidecar())
        throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      wasFresh = true
    }
    mkdirSync(root, { recursive: true })
    store = new LegacyOperationStore(
      ledgerPath,
      undefined,
      new ProjectWorkspaceModeGuard(
        join(getOpenworkDir(), "local-projects", "state.sqlite"),
        ledgerPath,
        join(getOpenworkDir(), "project-workspace-mode.sqlite")
      ),
      compositionGuard,
      optInIndex
    )
    try {
      store.refreshOptInIndex()
      indexEstablished = true
    } catch (error) {
      console.warn("[LegacyProjectRuntime] Could not initialize the opt-in index:", error)
    }
    service = new LegacyProjectRuntimeService(
      store,
      new HostPackageSnapshots(join(root, "packages")),
      {
        resolveThread: readThread,
        isKnownUnbound: (projectId) => indexEstablished && optInIndex.read()?.has(projectId) === false,
        threadExists: (threadId) => Boolean(getThreadCore(threadId)),
        captureExecutionWorkspace: async (threadId, thread, workspace, managed) => {
          const workspaceChanged = () => {
            throw Error("PROJECT_HOST_LEGACY_EXECUTION_WORKSPACE_NOT_REGISTERED: 请核对项目特性或托管会话的工作区。")
          }
          if (thread.featureId === LEGACY_PROJECT_SESSION_SCOPE) {
            if (thread.projectSessionKind === "system-constraints-update")
              return captureHarnessKnowledgeDepositionWorkspace(thread.projectId, workspace)
            return workspaceChanged()
          }
          const configured = await requireHarnessFeatureWorkspace(thread.projectId, thread.featureId)
          const preparingManagedRun = threadId === undefined && thread.runId !== undefined
          if (!preparingManagedRun && isSameWorkspacePath(configured, workspace)) return () => {
            if (!isSameWorkspacePath(getHarnessCapabilityFeatureWorkspace(thread.projectId, thread.featureId),
              workspace)) workspaceChanged()
          }
          const runId = thread.runId
          if (typeof runId !== "string" || !/^mr_[A-Za-z0-9_-]+$/.test(runId))
            return workspaceChanged()
          const freshManagedSession = managed && managed.threadId === threadId &&
            managed.projectId === thread.projectId && managed.featureId === thread.featureId &&
            managed.runId === runId && isSameWorkspacePath(managed.workspace, workspace)
          const assertManagedWorkspace = () => {
            const { snapshot, corrupt } = managedRunStore.getRun({
              projectId: thread.projectId, featureId: thread.featureId, runId
            })
            // Managed Skill preparation happens before a new session exists. The
            // run's original persisted workspace is already available at that point.
            if (corrupt || !isSameWorkspacePath(snapshot?.workspacePath, workspace) ||
              (threadId !== undefined && !freshManagedSession && snapshot?.currentSession?.threadId !== threadId))
              workspaceChanged()
          }
          assertManagedWorkspace()
          return assertManagedWorkspace
        },
        resolvePlugin: async (projectId, workspace) => {
          const adapter = await getHarnessProjectAdapterSnapshot(projectId)
          if (
            !adapter ||
            adapter.type !== "plugin" ||
            runtimeDirectory(getHarnessProjectRootPath(projectId)) !== runtimeDirectory(workspace)
          )
            throw Error("PROJECT_LEGACY_SCOPE_CHANGED")
          const plugin = getPlugins().find((item) => item.id === adapter.id && item.enabled)
          if (!plugin) throw Error("PROJECT_PLUGIN_UNAVAILABLE")
          return plugin
        },
        assertInstalledSourceCurrent: (projectId, workspace, installedPluginId) => {
          if (
            !getPlugins().some((plugin) => plugin.id === installedPluginId && plugin.enabled) ||
            !isSameWorkspacePath(getHarnessProjectRootPath(projectId), workspace)
          )
            throw Error("PROJECT_PLUGIN_UNAVAILABLE")
        },
        assertProjectBindingCurrent: assertHarnessProjectAdapterCurrent,
        authorizeRecovery: async (operation, workspaces) => {
          return authorizeProjectWorkspaceResources(workspaces, () => {
            if (getLocalThreadRunLease(operation.threadId) || isAgentRunBusy(operation.threadId) ||
                LocalSandbox.hasActiveBackgroundTasks(operation.threadId) ||
                coordinatorWorkerManager.hasRunningWorkersForThread(operation.threadId) ||
                coordinatorWorkerManager.hasTerminalWorkerAwaitingNotificationForThread(operation.threadId) ||
                coordinatorWorkerManager.hasAutoRunnableNotifications(operation.threadId))
              throw Error("PROJECT_LEGACY_RUNNING")
          })
        },
        assertProjectIdle: (projectId, workspace) => {
          for (const lease of listLocalThreadRunLeases()) {
            const current = readThread(lease.threadId)
            const raw = getThreadCore(lease.threadId)?.metadata
            const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
            if (
              current?.projectId === projectId ||
              (typeof metadata?.workspacePath === "string" &&
                isSameWorkspacePath(metadata.workspacePath, workspace))
            )
              throw Error("PROJECT_LEGACY_RUNNING")
          }
        }
      }
    )
    service.recoverInterrupted()
    service.register()
  } catch {
    store?.close()
    registerUnavailableLegacyRuntime((threadId) => readThread(threadId)?.projectId, readProtectedProjects)
    ipc.handle("project-runtime:legacy-view", (event, projectId: string): LegacyProjectRuntimeView => {
      trusted(event)
      if (typeof projectId !== "string" || !projectId || projectId.length > 256)
        throw Error("PROJECT_INVALID_ID")
      if (readProtectedProjects()?.has(projectId) === false)
        return { binding: null, operations: [], writeUnavailable: true }
      throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    })
    for (const channel of ["legacy-enable", "legacy-disable", "legacy-reconcile"]) {
      ipc.handle(`project-runtime:${channel}`, (event) => {
        trusted(event)
        throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      })
    }
    return
  }
  registerBuiltinLegacyMetricsReader((scope) => {
    const thread = readThread(scope.threadId)
    if (
      !thread ||
      thread.incarnation !== scope.incarnationKey ||
      !isSameWorkspacePath(thread.workspace, scope.workspace)
    )
      return { state: "unavailable" }
    const raw = getThreadCore(scope.threadId)?.metadata
    const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
    const runId = metadata?.harnessFeature?.runId
    const managed =
      typeof runId === "string" && /^mr_[A-Za-z0-9_-]+$/.test(runId)
        ? (managedRunStore.getRun({
            projectId: thread.projectId,
            featureId: thread.featureId,
            runId
          }).snapshot ?? undefined)
        : undefined
    return projectLegacyExecutionMetrics(
      scope,
      thread.projectId,
      thread.featureId,
      service.get(thread.projectId),
      service.operations(thread.projectId, 100),
      managed
    )
  })
  const view = (projectId: string): LegacyProjectRuntimeView => ({
    binding: service.get(projectId) ?? null,
    operations: service.operations(projectId, 20).map((operation) => ({
      ...operation,
      ...(operation.status === "unknown" ? { recoveryRevision: legacyRecoveryRevision(operation) } : {})
    }))
  })
  ipc.handle("project-runtime:legacy-view", (event, projectId: string) => {
    trusted(event)
    if (typeof projectId !== "string" || !projectId || projectId.length > 256)
      throw Error("PROJECT_INVALID_ID")
    return view(projectId)
  })
  ipc.handle("project-runtime:legacy-enable", async (event, projectId: string) => {
    trusted(event)
    await service.enable(projectId, getHarnessProjectRootPath(projectId))
    trusted(event)
    return view(projectId)
  })
  ipc.handle("project-runtime:legacy-disable", (event, projectId: string) => {
    trusted(event)
    service.disable(projectId)
    return view(projectId)
  })
  ipc.handle("project-runtime:legacy-reconcile", async (event, input: LegacyProjectRecoveryInput) => {
    trusted(event)
    const recovered = await service.reconcile(input, () => { trusted(event) })
    trusted(event)
    return view(recovered.projectId)
  })
  return service
}
