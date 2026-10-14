import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getOpenworkDir, getPlugins } from "../storage"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { readProjectRuntimeDescription } from "../harness-board/project-runtime/description"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import { inspectHostProjectExecution } from "../harness-board/project-runtime/host-execution-inspector"
import { compareProjectVersions } from "../../shared/project-runtime/version-report"
import { registerLegacyProjectRuntimeHandlers } from "./project-runtime-legacy"
import { ProjectWorkspaceModeGuard } from "../harness-board/project-runtime/workspace-mode-guard"
import { projectHostFacts, registerBuiltinProjectFacts } from "../mods/builtins/project-facts"
import { getThreadCore } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { getProjectActionRuntime } from "../harness-board/project-action-runtime"
import { projectActionResults } from "../harness-board/project-action-results"
import { readProjectActionLock } from "../harness-board/project-runtime/action-input"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { isProjectPreviewId, projectPreviewRegistry } from "../mods/devtools/project-preview-registry"
import { registerProjectPreviewHandlers } from "./project-preview"
import { projectAuthoringSessions } from "../mods/devtools/project-authoring-session"
import { ProjectLibrary } from "../harness-board/project-runtime/project-library"
import type { ProjectLibraryApi } from "../../shared/project-runtime/project-library"
import type {
  LocalProjectCommand,
  LocalProjectSummary,
  LocalProjectTemplate
} from "../../shared/project-runtime/platform-api"

/** Separate from legacy Harness storage and enterprise configuration. */
export function registerProjectRuntimeHandlers(
  ipc: IpcMain,
  mainWindow: () => BrowserWindow | null
) {
  let service: HostProjectService | undefined
  let snapshots: HostPackageSnapshots | undefined
  let library: ProjectLibrary | undefined
  const runOwners = new Map<string, BrowserWindow>()
  projectAuthoringSessions.setChanged((threadId) => {
    const owner = mainWindow()
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
      owner.webContents.send("mods:development-changed", { threadId })
  })
  registerBuiltinProjectFacts((threadId, workspace) => {
    if (!service) return undefined
    const row = getThreadCore(threadId)
    const metadata = typeof row?.metadata === "string" ? JSON.parse(row.metadata) : row?.metadata
    const binding = metadata?.hostProjectRuntime
    if (!binding || typeof binding.projectId !== "string") return undefined
    return projectHostFacts(
      threadId,
      workspace,
      binding,
      service.get(binding.projectId),
      service.operations(binding.projectId, 20)
    )
  })
  function trusted(event: IpcMainInvokeEvent) {
    const owner = mainWindow()
    if (
      !owner ||
      owner.isDestroyed() ||
      event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame
    )
      throw Error("PROJECT_UNTRUSTED_SENDER")
    return owner
  }
  function platform() {
    if (!service) {
      const root = join(getOpenworkDir(), "local-projects")
      const store = new HostProjectStore(
        join(root, "state.sqlite"),
        undefined,
        new ProjectWorkspaceModeGuard(
          join(root, "state.sqlite"),
          join(getOpenworkDir(), "legacy-project-runtime", "operations.sqlite"),
          join(getOpenworkDir(), "project-workspace-mode.sqlite")
        )
      )
      snapshots = new HostPackageSnapshots(join(root, "packages"))
      service = new HostProjectService(store, snapshots, {
        resolveInstalledPlugin: async (id) => {
          const plugin = isProjectPreviewId(id)
            ? projectPreviewRegistry.resolve(id)
            : getPlugins().find((item) => item.id === id)
          if (!plugin) return undefined
          return {
            installedPluginId: id,
            root: plugin.path,
            packageId: plugin.name,
            packageVersion: plugin.version,
            enabled: plugin.enabled
          }
        },
        authorize: async (project) => {
          if (isProjectPreviewId(project.installedPluginId)) {
            projectPreviewRegistry.assertProject(project)
            return
          }
          if (
            !getPlugins().some(
              (plugin) => plugin.id === project.installedPluginId && plugin.enabled
            )
          )
            throw Error("PROJECT_PLUGIN_UNAVAILABLE")
        },
        inspectOperation: inspectHostProjectExecution,
        executeSkill: async (context) => {
          const libraryPath = join(getOpenworkDir(), "local-projects", "library.sqlite")
          if (existsSync(libraryPath)) {
            library ??= new ProjectLibrary(libraryPath)
            context.knowledgeReference = library.knowledgeContext(context.project.projectId)
          }
          const owner = runOwners.get(context.operation.operationId)
          if (!owner || owner.isDestroyed()) throw Error("PROJECT_EXECUTION_WINDOW_UNAVAILABLE")
          const { executeHostProjectStage } =
            await import("../harness-board/project-action-executor")
          return executeHostProjectStage(context, owner, () => {
            const current = store.get(context.project.projectId)
            const operation = store.getOperation(context.operation.operationId)
            if (
              !current ||
              current.version !== context.ticket.expectedVersion ||
              current.pluginDigest !== context.ticket.pluginDigest ||
              operation?.status !== "started" ||
              operation.cancelRequestedAt !== null
            )
              throw Error("PROJECT_ACTION_OPERATION_CHANGED")
          })
        }
      })
      service.recoverInterrupted()
    }
    return service
  }
  registerLegacyProjectRuntimeHandlers(ipc, trusted)
  function libraryScope(event: IpcMainInvokeEvent, projectId: string) {
    trusted(event)
    if (typeof projectId !== "string" || !projectId || projectId.length > 256)
      throw Error("PROJECT_INVALID_INPUT")
    const project = platform().get(projectId)
    if (!project) throw Error("PROJECT_NOT_FOUND")
    if (isProjectPreviewId(project.installedPluginId)) projectPreviewRegistry.assertProject(project)
    else if (!getPlugins().some((item) => item.id === project.installedPluginId && item.enabled))
      throw Error("PROJECT_PLUGIN_UNAVAILABLE")
    library ??= new ProjectLibrary(join(getOpenworkDir(), "local-projects", "library.sqlite"))
    return { project, library }
  }
  ipc.handle("project-runtime:library-list", (event, projectId: string) =>
    libraryScope(event, projectId).library.list(projectId))
  ipc.handle("project-runtime:library-capture", (event, projectId: string, input: Parameters<ProjectLibraryApi["capture"]>[1]) => {
    const { project, library } = libraryScope(event, projectId)
    const operations = platform().operations(projectId, 50)
    if (operations.some((item) => ["started", "cancel_requested"].includes(item.status)))
      throw Error("PROJECT_LIBRARY_BUSY")
    const operation = operations.find((item) => item.operationId === input?.operationId)
    if (!operation) throw Error("PROJECT_LIBRARY_CHECK_REQUIRED")
    snapshots!.read(project.pluginDigest)
    return library.capture(project, operation, input)
  })
  ipc.handle("project-runtime:library-read", (event, projectId: string, id: string, path: string) =>
    libraryScope(event, projectId).library.read(projectId, id, path))
  ipc.handle("project-runtime:library-remove", (event, projectId: string, id: string) =>
    libraryScope(event, projectId).library.remove(projectId, id))
  ipc.handle("project-runtime:library-reuse", (event, sourceProjectId: string, id: string, targetProjectId: string) => {
    libraryScope(event, sourceProjectId)
    return libraryScope(event, targetProjectId).library.reuse(sourceProjectId, id, targetProjectId)
  })
  ipc.handle("project-runtime:library-send", (event, projectId: string, id: string, input: Parameters<ProjectLibraryApi["send"]>[2]) => {
    const { project, library } = libraryScope(event, projectId)
    // Preview projects can never publish outside the isolated development workspace.
    if (isProjectPreviewId(project.installedPluginId)) throw Error("PROJECT_LIBRARY_PREVIEW_LOCAL_ONLY")
    return library.send(projectId, id, input, () => {
      const current = libraryScope(event, projectId).project
      if (current.pluginDigest !== project.pluginDigest) throw Error("PROJECT_PACKAGE_IDENTITY_MISMATCH")
    })
  })
  registerProjectPreviewHandlers(ipc, trusted, platform, (project) => snapshots!.read(project.pluginDigest).root)
  function view(projectId: string) {
    const api = platform()
    const project = api.get(projectId)
    if (!project) throw Error("PROJECT_NOT_FOUND")
    return { project, operations: api.operations(projectId, 20), preview: projectPreviewRegistry.describe(project) }
  }
  ipc.handle("project-runtime:templates", async (event) => {
    trusted(event)
    const results: LocalProjectTemplate[] = []
    for (const plugin of getPlugins()
      .filter((plugin) => plugin.enabled)
      .slice(0, 100)) {
      const description = await readProjectRuntimeDescription(plugin.path)
      if (description?.status !== "ready" || description.manifest.mode !== "host") continue
      let unavailableReason: string | undefined
      try {
        assertHostPackageSupported(plugin.path, description.manifest)
      } catch (error) {
        const code = error instanceof Error ? error.message : ""
        unavailableReason = /PINNED_MODS|PINNED_MCP/.test(code)
          ? "此模板还包含共享灵件或外部服务，尚不能作为固定版本的本地任务运行；请使用原插件入口。"
          : "此模板缺少可运行的技能或检查配置，请让作者修正后重新安装。"
      }
      results.push({
        installedPluginId: plugin.id,
        name: plugin.name,
        version: plugin.version,
        stages: description.manifest.stages.map((stage) => stage.title),
        ...(unavailableReason ? { unavailableReason } : {})
      })
    }
    trusted(event)
    return results
  })
  ipc.handle("project-runtime:list", (event, afterProjectId = ""): LocalProjectSummary[] => {
    trusted(event)
    if (typeof afterProjectId !== "string" || afterProjectId.length > 256)
      throw Error("PROJECT_INVALID_CURSOR")
    return platform()
      .list(20, afterProjectId)
      .map((project) => ({
        projectId: project.projectId,
        name: project.name,
        workspace: project.workspace,
        status: project.status,
        stageIndex: project.stageIndex,
        updatedAt: project.updatedAt,
        packageVersion: project.packageVersion
      }))
  })
  ipc.handle("project-runtime:get", (event, id: string) => {
    trusted(event)
    return view(id)
  })
  ipc.handle(
    "project-runtime:action-results",
    async (event, projectId: string, operationId: string) => {
      trusted(event)
      if (
        typeof projectId !== "string" ||
        typeof operationId !== "string" ||
        !projectId ||
        !operationId ||
        projectId.length > 256 ||
        operationId.length > 256
      )
        throw Error("PROJECT_INVALID_INPUT")
      // Opening a result never initializes/reconciles a runtime or creates a ledger.
      if (!service || !snapshots) throw Error("PROJECT_ACTION_RESULTS_UNAVAILABLE")
      const project = service.get(projectId)
      const operation = service
        .operations(projectId, 20)
        .find((item) => item.operationId === operationId)
      if (!project || !operation?.execution?.threadId)
        throw Error("PROJECT_OPERATION_SCOPE_CHANGED")
      const threadId = operation.execution.threadId
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("PROJECT_ACTION_RESULT_SCOPE_CHANGED")
      const incarnation = captureThreadIncarnation(thread)
      const metadata =
        typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
      if (
        typeof metadata?.workspacePath !== "string" ||
        !isSameWorkspacePath(metadata.workspacePath, project.workspace)
      )
        throw Error("PROJECT_ACTION_RESULT_SCOPE_CHANGED")
      const snapshot = snapshots.read(project.pluginDigest)
      if (JSON.stringify(snapshot.manifest) !== JSON.stringify(project.manifest))
        throw Error("PROJECT_PACKAGE_IDENTITY_MISMATCH")
      const lock = readProjectActionLock(snapshot.root, project.manifest)
      const runtime = getProjectActionRuntime()
      if (!runtime.readRuns) throw Error("PROJECT_ACTION_RESULTS_UNAVAILABLE")
      const assertCurrent = () => {
        trusted(event)
        const current = getThreadCore(threadId)
        if (
          !matchesThreadIncarnation(current, incarnation) ||
          current?.metadata !== thread.metadata ||
          JSON.stringify(service?.get(projectId)) !== JSON.stringify(project) ||
          JSON.stringify(
            service?.operations(projectId, 20).find((item) => item.operationId === operationId)
          ) !== JSON.stringify(operation)
        )
          throw Error("PROJECT_ACTION_RESULT_SCOPE_CHANGED")
      }
      // Catalogue retains the original live grants; an unavailable provider never reveals its output.
      const catalog = await runtime.catalog(project.workspace, threadId).catch(() => [])
      assertCurrent()
      const result = projectActionResults({
        project,
        operation,
        threadId,
        binding: metadata?.hostProjectRuntime,
        lock,
        runs: runtime.readRuns(project.workspace, threadId),
        catalog
      })
      assertCurrent()
      return result
    }
  )
  ipc.handle("project-runtime:versions", async (event, id: string) => {
    trusted(event)
    const project = view(id).project
    const plugin = getPlugins().find(
      (item) => item.id === project.installedPluginId && item.enabled
    )
    const description = plugin ? await readProjectRuntimeDescription(plugin.path) : undefined
    trusted(event)
    return compareProjectVersions(
      project,
      description?.status === "ready" ? description.manifest : undefined
    )
  })
  ipc.handle(
    "project-runtime:create",
    async (
      event,
      input: {
        name: string
        workspace: string
        installedPluginId: string
        goal: string
      }
    ) => {
      trusted(event)
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error("PROJECT_INVALID_INPUT")
      if (typeof input.installedPluginId !== "string" || isProjectPreviewId(input.installedPluginId))
        throw Error("PROJECT_PREVIEW_EXPLICIT_ENTRY_REQUIRED")
      const project = await platform().localCreate({ ...input, projectId: randomUUID() })
      trusted(event)
      return view(project.projectId)
    }
  )
  ipc.handle(
    "project-runtime:command",
    async (event, projectId: string, command: LocalProjectCommand) => {
      const owner = trusted(event)
      const api = platform()
      const current = view(projectId)
      if (!command || typeof command !== "object" || Array.isArray(command))
        throw Error("PROJECT_INVALID_COMMAND")
      if (isProjectPreviewId(current.project.installedPluginId) &&
        command.kind !== "cancel" && command.kind !== "reconcile")
        projectPreviewRegistry.assertProject(current.project)
      if (command.kind === "prepare") {
        api.prepare({
          projectId,
          expectedVersion: command.expectedVersion,
          idempotencyKey: command.idempotencyKey
        })
      } else {
        // Resolve against durable identity, never accept an operation belonging to another project.
        const operation = current.operations.find(
          (item) => item.operationId === command.operationId
        )
        if (!operation) throw Error("PROJECT_OPERATION_SCOPE_CHANGED")
        if (command.kind === "approve")
          api.approve(operation.operationId, {
            expectedVersion: command.expectedVersion,
            inputFingerprint: command.inputFingerprint,
            decision: command.decision,
            actorId: "desktop-user"
          })
        else if (command.kind === "advance") api.transition(operation.operationId)
        else if (command.kind === "cancel") api.cancel(operation.operationId)
        else if (command.kind === "validate") await api.validate(operation.operationId)
        else if (command.kind === "reconcile") await api.reconcile(operation.operationId)
        else if (command.kind === "start") {
          if (runOwners.has(operation.operationId)) throw Error("PROJECT_OPERATION_ALREADY_RUNNING")
          runOwners.set(operation.operationId, owner)
          try {
            await api.start(operation.operationId)
          } finally {
            runOwners.delete(operation.operationId)
          }
        } else throw Error("PROJECT_INVALID_COMMAND")
      }
      trusted(event)
      const updated = api.get(projectId)!
      if (isProjectPreviewId(updated.installedPluginId))
        projectPreviewRegistry.complete(updated, api.operations(projectId, 100))
      return view(projectId)
    }
  )
}
