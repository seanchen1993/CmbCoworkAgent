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
import { runtimeDirectory } from "../harness-board/project-runtime/safe-files"
import type { ProjectStageDebugSessions } from "../mods/devtools/project-stage-debug"
import type { ProjectStageDebugApi } from "../../shared/project-runtime/stage-debug"
import { z } from "zod"

export function registerProjectPreviewHandlers(
  ipc: IpcMain,
  trusted: (event: IpcMainInvokeEvent) => unknown,
  platform: () => HostProjectService,
  retainedRoot: (project: HostProjectState) => string,
  stageDebug?: () => ProjectStageDebugSessions
) {
  const recovering = new Set<string>()
  if (stageDebug) {
    const threadId = z.string().min(1).max(256)
    const digest = z.string().regex(/^[a-f0-9]{64}$/)
    const prepare = z.object({ threadId, snapshotId: digest,
      draftId: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), revision: z.number().int().min(1).max(8),
      expectedDigest: digest, mode: z.enum(["stage", "downstream"]) }).strict()
    const comparison = z.object({ threadId, projectId: z.string().uuid() }).strict()
    const create = z.object({ threadId, preparationId: z.string().uuid(), expectedDigest: digest }).strict()
    ipc.handle("project-preview:stage-debug-compare", async (event, value: { threadId: string; projectId: string }) => {
      trusted(event)
      const input = comparison.parse(value)
      return stageDebug().compare(context(event, input.threadId), input)
    })
    ipc.handle("project-preview:stage-debug-list", (event, value: string) => {
      trusted(event)
      const current = context(event, threadId.parse(value))
      return stageDebug().list(current)
    })
    ipc.handle("project-preview:stage-debug-prepare", async (event,
      value: Parameters<ProjectStageDebugApi["prepare"]>[0]) => {
      trusted(event)
      const input = prepare.parse(value)
      return stageDebug().prepare(context(event, input.threadId), input)
    })
    ipc.handle("project-preview:stage-debug-create", async (event,
      value: Parameters<ProjectStageDebugApi["create"]>[0]) => {
      trusted(event)
      const input = create.parse(value)
      return stageDebug().create(context(event, input.threadId), input)
    })
  }
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
    const request = projectAuthoringSessions.trialRequest(scope)
    const drafts: ProjectPreviewDraft[] = projectAuthoringSessions.list(scope).map((draft) => {
      const projectId = projectPreviewRegistry.projectFor(scope, draft.id)
      const saved = projectId ? undefined : projectPreviewRegistry.retained(scope, draft.id)
      const project = saved ? platform().get(saved.projectId) : undefined
      return {
        id: draft.id,
        name: draft.name,
        revision: draft.revision,
        digest: draft.source.digest,
        projectId,
        ...(request?.draftId === draft.id && request.journey ? { journey: request.journey } : {}),
        ...(saved
          ? {
              recovery: {
                projectId: saved.projectId,
                revision: saved.snapshot.revision,
                digest: saved.snapshot.digest,
                workspace: saved.snapshot.workspace,
                goal: project?.goal ?? "",
                projectVersion: project?.version ?? null,
                status: !project
                  ? ("missing" as const)
                  : project.status === "completed"
                    ? ("completed" as const)
                    : draft.revision !== saved.snapshot.revision ||
                        draft.source.digest !== saved.snapshot.digest
                      ? ("draft-changed" as const)
                      : ("needs-confirmation" as const),
                hasUnconfirmedEffects:
                  !!project &&
                  platform()
                    .operations(project.projectId, 100)
                    .some((operation) =>
                      ["started", "cancel_requested", "unknown"].includes(operation.status)
                    ),
                ...(project && stageDebug?.().isBranch(project) ? { debugBranch: true } : {})
              }
            }
          : {}),
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
      }
    })
    return { threadId, workspace: scope.workspace, drafts }
  })
  ipc.handle(
    "project-preview:create",
    async (event, input: Parameters<ProjectPreviewApi["create"]>[0]) => {
      if (!input || typeof input !== "object") throw Error("PROJECT_INVALID_INPUT")
      const { scope, guard } = context(event, input.threadId)
      if (projectPreviewRegistry.projectFor(scope, input.draftId))
        throw Error("PROJECT_DEV_RUNNING")
      if (projectPreviewRegistry.retained(scope, input.draftId))
        throw Error("PROJECT_PREVIEW_RECOVERY_REQUIRED")
      const draft = projectAuthoringSessions.read(scope, input.draftId)
      if (draft.revision !== input.revision) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
      if (input.expectedDigest !== undefined && input.expectedDigest !== draft.source.digest)
        throw Error("PROJECT_SOURCE_CHANGED")
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
      let created = false
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
        created = true
        guard()
        await projectPreviewRegistry.bind(project, retainedRoot(project))
        bound = true
        projectAuthoringSessions.bindTrialProject(scope, input.draftId, project, guard)
        return projectId
      } catch (error) {
        if (!bound) {
          if (registeredId) {
            if (created) projectPreviewRegistry.detach(registeredId)
            else projectPreviewRegistry.abandon(registeredId)
          } else lease.release()
        }
        throw error
      }
    }
  )
  ipc.handle(
    "project-preview:recover",
    async (event, input: Parameters<ProjectPreviewApi["recover"]>[0]) => {
      if (!input || typeof input !== "object") throw Error("PROJECT_INVALID_INPUT")
      const { scope, guard } = context(event, input.threadId)
      const saved = projectPreviewRegistry.retained(scope, input.draftId)
      const api = platform()
      const project = saved && api.get(saved.projectId)
      if (project && stageDebug?.().isBranch(project))
        throw Error("PROJECT_STAGE_DEBUG_RECONFIRMATION_REQUIRED")
      if (
        !saved ||
        !project ||
        saved.projectId !== input.projectId ||
        saved.snapshot.revision !== input.revision ||
        saved.snapshot.digest !== input.expectedDigest ||
        project.version !== input.expectedProjectVersion
      )
        throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
      if (recovering.has(saved.id)) throw Error("PROJECT_DEV_BUSY")
      recovering.add(saved.id)
      let release: (() => void) | undefined
      try {
        const expected = JSON.stringify(project)
        const current = () => {
          guard()
          if (JSON.stringify(api.get(project.projectId)) !== expected)
            throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
        }
        current()
        runtimeDirectory(project.workspace)
        const draft = projectAuthoringSessions.read(scope, input.draftId)
        if (draft.revision !== input.revision || draft.source.digest !== input.expectedDigest)
          throw Error("PROJECT_DRAFT_REVISION_CHANGED")
        const actions = draft.source.files.some(
          (file) => file.path === "devclaw.project-actions.lock.json"
        )
          ? await getProjectActionCatalog(scope.workspace, scope.threadId)
          : []
        current()
        if (!draft.development)
          await projectAuthoringSessions.inspect(
            scope,
            draft.id,
            draft.revision,
            "dev",
            current,
            actions
          )
        current()
        const lease = projectAuthoringSessions.acquireDevelopment(
          scope,
          draft.id,
          draft.revision,
          guard,
          project.workspace
        )
        release = lease.release
        await projectPreviewRegistry.recover({
          scope,
          draftId: draft.id,
          project,
          snapshot: lease.snapshot,
          retainedRoot: retainedRoot(project),
          actions,
          operations: api.operations(project.projectId, 100),
          guard,
          assertProjectCurrent: current,
          release: lease.release,
          cancelPrepared: (id) => api.cancel(id)
        })
        release = undefined
        projectAuthoringSessions.bindTrialProject(scope, draft.id, project, guard)
        return project.projectId
      } finally {
        release?.()
        recovering.delete(saved.id)
      }
    }
  )
  ipc.handle(
    "project-preview:finish",
    (event, input: Parameters<ProjectPreviewApi["finish"]>[0]) => {
      if (!input || typeof input !== "object") throw Error("PROJECT_INVALID_INPUT")
      const { scope, guard } = context(event, input.threadId)
      const api = platform()
      const project = api.get(input.projectId)
      if (input.draftId && !projectPreviewRegistry.projectFor(scope, input.draftId)) {
        const saved = projectPreviewRegistry.retained(scope, input.draftId)
        if (!saved || saved.projectId !== input.projectId || recovering.has(saved.id))
          throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
        guard()
        projectPreviewRegistry.finishRetained(
          scope,
          input.draftId,
          project,
          project ? api.operations(project.projectId, 100) : [],
          (id) => api.cancel(id),
          stageDebug?.().finishOptions(project)
        )
        stageDebug?.().end(project)
        return
      }
      if (!project) throw Error("PROJECT_NOT_FOUND")
      projectPreviewRegistry.finish(
        project,
        scope,
        api.operations(project.projectId, 100),
        (operationId) => api.cancel(operationId),
        stageDebug?.().finishOptions(project)
      )
      stageDebug?.().end(project)
    }
  )
}
