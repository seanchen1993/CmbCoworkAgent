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
import { listLocalThreadRunLeases } from "../agent/thread-run-lease"
import {
  getHarnessProjectAdapterSnapshot,
  getHarnessProjectRootPath
} from "../harness-board/service"
import { LegacyOperationStore } from "../harness-board/project-runtime/legacy-operation-store"
import { LegacyProjectRuntimeService } from "../harness-board/project-runtime/legacy-runtime-service"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { runtimeDirectory } from "../harness-board/project-runtime/safe-files"
import { registerUnavailableLegacyRuntime } from "../harness-board/project-runtime/unavailable"
import { ProjectWorkspaceModeGuard } from "../harness-board/project-runtime/workspace-mode-guard"

/** Register at startup so persisted opt-in bindings fence the very first original entry. */
export function registerLegacyProjectRuntimeHandlers(
  ipc: IpcMain,
  trusted: (event: IpcMainInvokeEvent) => unknown
) {
  const root = join(getOpenworkDir(), "legacy-project-runtime")
  function readThread(threadId: string) {
    const thread = getThreadCore(threadId)
    if (!thread) return undefined
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (!metadata || typeof metadata.workspacePath !== "string") return undefined
    const feature = metadata.harnessFeature
    const project = metadata.harnessProjectSession
    const projectId = feature?.projectId ?? project?.projectId
    if (typeof projectId !== "string" || !projectId) return undefined
    const featureId = typeof feature?.slug === "string" ? feature.slug : "__project_session__"
    // Do not inspect or constrain ordinary legacy workspaces before the service finds an opt-in.
    return {
      projectId,
      featureId,
      workspace: metadata.workspacePath,
      incarnation: JSON.stringify(captureThreadIncarnation(thread))
    }
  }
  let service: LegacyProjectRuntimeService
  try {
    mkdirSync(root, { recursive: true })
    service = new LegacyProjectRuntimeService(
      new LegacyOperationStore(
        join(root, "operations.sqlite"),
        undefined,
        new ProjectWorkspaceModeGuard(
          join(getOpenworkDir(), "local-projects", "state.sqlite"),
          join(root, "operations.sqlite"),
          join(getOpenworkDir(), "project-workspace-mode.sqlite")
        )
      ),
      new HostPackageSnapshots(join(root, "packages")),
      {
        resolveThread: readThread,
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
        assertProjectIdle: (projectId, workspace) => {
          for (const lease of listLocalThreadRunLeases()) {
            const current = readThread(lease.threadId)
            const raw = getThreadCore(lease.threadId)?.metadata
            const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
            if (
              current?.projectId === projectId ||
              (typeof metadata?.workspacePath === "string" &&
                runtimeDirectory(metadata.workspacePath) === runtimeDirectory(workspace))
            )
              throw Error("PROJECT_LEGACY_RUNNING")
          }
        }
      }
    )
    service.recoverInterrupted()
    service.register()
  } catch {
    registerUnavailableLegacyRuntime((threadId) => Boolean(readThread(threadId)))
    for (const channel of ["legacy-view", "legacy-enable", "legacy-disable"]) {
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
  const view = (projectId: string) => ({
    binding: service.get(projectId) ?? null,
    operations: service.operations(projectId, 20)
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
}
