import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { getModDevelopmentService } from "../mods/devtools/development-service"
import { projectAuthoringSessions } from "../mods/devtools/project-authoring-session"
import { projectPreviewRegistry } from "../mods/devtools/project-preview-registry"
import { getProjectActionCatalog } from "../harness-board/project-action-runtime"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type {
  ProjectPreviewApi,
  ProjectPreviewDraft
} from "../../shared/project-runtime/development-preview"

export function registerProjectPreviewHandlers(
  ipc: IpcMain,
  trusted: (event: IpcMainInvokeEvent) => unknown,
  platform: () => HostProjectService,
  retainedRoot: (project: HostProjectState) => string
) {
  function context(event: IpcMainInvokeEvent, threadId: string) {
    trusted(event)
    if (typeof threadId !== "string" || !threadId || threadId.length > 256)
      throw Error("PROJECT_INVALID_INPUT")
    const creator = getModDevelopmentService()
    if (!creator) throw Error("DEVELOPMENT_DISABLED")
    const initial = creator.projectAuthoringContext(threadId)
    const guard = () => {
      trusted(event)
      initial.assertCurrent()
      const current = creator.projectAuthoringContext(threadId)
      if (JSON.stringify(current.scope) !== JSON.stringify(initial.scope))
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      current.assertCurrent()
    }
    return { scope: initial.scope, guard }
  }
  ipc.handle("project-preview:list", (event, threadId: string) => {
    const { scope } = context(event, threadId)
    const drafts: ProjectPreviewDraft[] = projectAuthoringSessions.list(scope).map((draft) => ({
      id: draft.id,
      name: draft.name,
      revision: draft.revision,
      projectId: projectPreviewRegistry.projectFor(scope, draft.id),
      ...(draft.development
        ? {
            development: {
              devId: draft.development.devId,
              workspace: draft.development.workspace,
              currentRevision: draft.development.currentRevision,
              currentDigest: draft.development.currentDigest,
              pendingRevision: draft.development.pendingRevision,
              activeRuns: draft.development.activeRuns,
              updateState: draft.development.updateState
            }
          }
        : {})
    }))
    return { threadId, workspace: scope.workspace, drafts }
  })
  ipc.handle(
    "project-preview:create",
    async (event, input: Parameters<ProjectPreviewApi["create"]>[0]) => {
      if (!input || typeof input !== "object") throw Error("PROJECT_INVALID_INPUT")
      const { scope, guard } = context(event, input.threadId)
      if (projectPreviewRegistry.projectFor(scope, input.draftId))
        throw Error("PROJECT_DEV_RUNNING")
      const draft = projectAuthoringSessions.read(scope, input.draftId)
      if (draft.revision !== input.revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
      const actions = draft.source.files.some(
        (file) => file.path === "devclaw.project-actions.lock.json"
      )
        ? await getProjectActionCatalog(scope.workspace, scope.threadId)
        : []
      guard()
      if (!draft.development)
        await projectAuthoringSessions.inspect(
          scope,
          input.draftId,
          input.revision,
          "dev",
          guard,
          actions
        )
      guard()
      const lease = projectAuthoringSessions.acquireDevelopment(
        scope,
        input.draftId,
        input.revision,
        guard
      )
      const projectId = randomUUID()
      let registeredId: string | undefined
      let bound = false
      try {
        const plugin = await projectPreviewRegistry.register({
          projectId,
          scope,
          snapshot: lease.snapshot,
          guard,
          release: lease.release,
          actions
        })
        registeredId = plugin.id
        guard()
        const project = await platform().localCreate({
          projectId,
          name: `${draft.name} · 隔离试用 v${input.revision}`,
          workspace: lease.snapshot.workspace,
          installedPluginId: plugin.id,
          goal: input.goal
        })
        guard()
        await projectPreviewRegistry.bind(project, retainedRoot(project))
        bound = true
        return projectId
      } catch (error) {
        if (!bound) {
          if (registeredId) projectPreviewRegistry.abandon(registeredId)
          else lease.release()
        }
        throw error
      }
    }
  )
  ipc.handle(
    "project-preview:finish",
    (event, input: Parameters<ProjectPreviewApi["finish"]>[0]) => {
      if (!input || typeof input !== "object") throw Error("PROJECT_INVALID_INPUT")
      const { scope } = context(event, input.threadId)
      const api = platform()
      const project = api.get(input.projectId)
      if (!project) throw Error("PROJECT_NOT_FOUND")
      projectPreviewRegistry.finish(
        project,
        scope,
        api.operations(project.projectId, 100),
        (operationId) => api.cancel(operationId)
      )
    }
  )
}
