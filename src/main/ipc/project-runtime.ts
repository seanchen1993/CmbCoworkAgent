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
import { registerProjectRuntimeModsHandlers } from "./project-runtime-mods"
import { projectAuthoringSessions } from "../mods/devtools/project-authoring-session"
import { ProjectStageDebugSessions, configureProjectStageDebugResolver } from "../mods/devtools/project-stage-debug"
import { getModsManager } from "../mods/manager"
import { ProjectLibrary } from "../harness-board/project-runtime/project-library"
import { registerProjectCompositionHandlers } from "./project-composition"
import { createLegacyCompositionDependencies } from "../harness-board/project-runtime/composition-legacy-production"
import { createBrowserWindowAgentRunDelivery } from "../agent/agent-run-service"
import { assertOriginalProjectWorkspaceIdle } from "../harness-board/project-runtime/composition-workspace-busy"
import { listLocalThreadRunLeases, registerLocalThreadRunAdmissionGuard } from "../agent/thread-run-lease"
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
  let debugging: ProjectStageDebugSessions | undefined
  function stageDebug() {
    const manager = getModsManager()
    if (!manager) throw Error("DEVELOPMENT_DISABLED")
    debugging ??= new ProjectStageDebugSessions({
      root: join(getOpenworkDir(), "project-stage-debug"), settings: manager.store,
      sessions: projectAuthoringSessions, registry: projectPreviewRegistry, platform,
      retainedRoot: (project) => snapshots!.read(project.pluginDigest).root,
      assertInspectionScope: (scope) => {
        const thread = getThreadCore(scope.threadId)
        const metadata = typeof thread?.metadata === "string"
          ? JSON.parse(thread.metadata) : thread?.metadata
        if (!matchesThreadIncarnation(thread, scope.incarnation) ||
          typeof metadata?.workspacePath !== "string" ||
          !isSameWorkspacePath(metadata.workspacePath, scope.workspace))
          throw Error("PROJECT_STAGE_DEBUG_INSPECTION_SCOPE_CHANGED")
      },
      assertWorkspaceIdle: (workspace) => {
        for (const lease of listLocalThreadRunLeases()) {
          const raw = getThreadCore(lease.threadId)?.metadata
          const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
          if (typeof metadata?.workspacePath === "string" &&
            isSameWorkspacePath(metadata.workspacePath, workspace))
            throw Error("PROJECT_STAGE_DEBUG_SOURCE_UNSETTLED")
        }
      }
    })
    return debugging
  }
  configureProjectStageDebugResolver(stageDebug)
  const runOwners = new Map<string, BrowserWindow>()
  const compositions = registerProjectCompositionHandlers(ipc, {
    trusted, host: platform,
    legacy: input => createLegacyCompositionDependencies({ ...input,
      delivery: context => createBrowserWindowAgentRunDelivery(input.owner(context)) }),
    bindOwner: (operation, owner) => { runOwners.set(operation.operationId, owner) },
    assertWorkspaceIdle: (workspace) => {
      for (const lease of listLocalThreadRunLeases()) {
        const raw = getThreadCore(lease.threadId)?.metadata
        const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
        if (typeof metadata?.workspacePath === "string" &&
          isSameWorkspacePath(metadata.workspacePath, workspace)) throw Error("COMPOSITION_WORKSPACE_BUSY")
      }
      assertOriginalProjectWorkspaceIdle(workspace,
        join(getOpenworkDir(), "local-projects", "state.sqlite"),
        join(getOpenworkDir(), "legacy-project-runtime", "operations.sqlite"))
    }
  })
  function compositionGuard<T>(workspace: string, work: () => T): T {
    // No database or runtime initialization on the unchanged, non-composition path.
    if (!existsSync(join(getOpenworkDir(), "project-compositions", "state.sqlite"))) return work()
    return compositions().guardWorkspaceMutation(workspace, work)
  }
  function internalCompositionProject(projectId: string): boolean {
    return projectId.startsWith("composition:") &&
      existsSync(join(getOpenworkDir(), "project-compositions", "state.sqlite")) &&
      Boolean(compositions().parentForHostUnit(projectId))
  }
  registerLocalThreadRunAdmissionGuard((threadId, work) => {
    const raw = getThreadCore(threadId)?.metadata
    const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
    return typeof metadata?.workspacePath === "string"
      ? compositionGuard(metadata.workspacePath, work) : work()
  })
  projectAuthoringSessions.setChanged((threadId) => {
    const owner = mainWindow()
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
      owner.webContents.send("mods:development-changed", { threadId })
  })
  projectAuthoringSessions.configureTrialObservation((projectId) => ({
    project: platform().get(projectId),
    operations: platform().operations(projectId, 100)
  }))
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
        ),
        compositionGuard
      )
      snapshots = new HostPackageSnapshots(join(root, "packages"))
      service = new HostProjectService(store, snapshots, {
        assertCommand: (project, kind) => stageDebug().assertCommand(project, kind),
        authorizeStageBranch: async (context) => stageDebug().authorizeBranch(context),
        beforeExecuteStage: async (context) => {
          if (isProjectPreviewId(context.project.installedPluginId))
            await stageDebug().beforeExecute(context)
        },
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
        authorizeInspection: async (project, operation) => {
          const inspection = await stageDebug().authorizeInspection(project, operation)
          if (inspection) return inspection
          // Ordinary projects retain their original authorization requirements.
          if (isProjectPreviewId(project.installedPluginId)) {
            projectPreviewRegistry.assertProject(project)
            return
          }
          if (!getPlugins().some((plugin) =>
            plugin.id === project.installedPluginId && plugin.enabled))
            throw Error("PROJECT_PLUGIN_UNAVAILABLE")
        },
        inspectOperation: inspectHostProjectExecution,
        executeSkill: async (context) => {
          context.stageDebug = stageDebug().executionPolicy(context.project)
          const bindThread = context.bindThread
          context.bindThread = (threadId) => {
            bindThread(threadId)
            projectAuthoringSessions.notifyTrialProject(context.project.projectId)
          }
          projectAuthoringSessions.notifyTrialProject(context.project.projectId)
          context.internalCompositionUnit = internalCompositionProject(context.project.projectId)
          const libraryPath = join(getOpenworkDir(), "local-projects", "library.sqlite")
          if (existsSync(libraryPath)) {
            library ??= new ProjectLibrary(libraryPath)
            context.knowledgeReference = library.knowledgeContext(context.project.projectId)
          }
          const owner = runOwners.get(context.operation.operationId)
          if (!owner || owner.isDestroyed()) throw Error("PROJECT_EXECUTION_WINDOW_UNAVAILABLE")
          const { executeHostProjectStage } =
            await import("../harness-board/project-action-executor")
          try { return await executeHostProjectStage(context, owner, () => {
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
          }) } finally { runOwners.delete(context.operation.operationId) }
        }
      })
      service.recoverInterrupted()
    }
    return service
  }
  registerLegacyProjectRuntimeHandlers(ipc, trusted, compositionGuard)
  function libraryScope(event: IpcMainInvokeEvent, projectId: string) {
    trusted(event)
    if (internalCompositionProject(projectId)) throw Error("COMPOSITION_USE_PARENT_PROJECT")
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
  registerProjectPreviewHandlers(ipc, trusted, platform,
    (project) => snapshots!.read(project.pluginDigest).root, stageDebug)
  registerProjectRuntimeModsHandlers(ipc, trusted, platform,
    project => snapshots!.read(project.pluginDigest).root, internalCompositionProject)
  function view(projectId: string) {
    if (internalCompositionProject(projectId)) throw Error("COMPOSITION_USE_PARENT_PROJECT")
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
    const visible: ReturnType<HostProjectService["list"]> = []
    let cursor = afterProjectId
    while (visible.length < 20) {
      const page = platform().list(100, cursor)
      if (!page.length) break
      for (const project of page) {
        if (!internalCompositionProject(project.projectId)) visible.push(project)
        if (visible.length === 20) break
      }
      cursor = page[page.length - 1].projectId
      if (page.length < 100) break
    }
    return visible
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
      if (internalCompositionProject(projectId)) throw Error("COMPOSITION_USE_PARENT_PROJECT")
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
      stageDebug().assertCommand(current.project, command.kind)
      if (isProjectPreviewId(current.project.installedPluginId) &&
        command.kind !== "cancel" && command.kind !== "reconcile")
        projectPreviewRegistry.assertProject(current.project)
      // Native cancellation never depends on an invalid configuration or unavailable knowledge.
      if (command.kind !== "cancel") await api.prepareRuntimeInputs(projectId)
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
            projectAuthoringSessions.notifyTrialProject(projectId)
          }
        } else throw Error("PROJECT_INVALID_COMMAND")
      }
      trusted(event)
      const updated = api.get(projectId)!
      if (isProjectPreviewId(updated.installedPluginId))
        projectPreviewRegistry.complete(updated, api.operations(projectId, 100))
      if (updated.status === "completed") stageDebug().end(updated)
      projectAuthoringSessions.notifyTrialProject(projectId)
      return view(projectId)
    }
  )
}
