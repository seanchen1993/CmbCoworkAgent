import type { IpcMain } from "electron"
import {
  archiveHarnessProject,
  createHarnessProject,
  getHarnessProjectDetail,
  getHarnessRunDetail,
  HARNESS_SKILL_REGISTRY,
  listHarnessProjects,
  updateHarnessProjectMetadata,
  upsertHarnessSessionBinding
} from "../harness-board/service"
import { startHarnessWatchRefs } from "../harness-board/watch-ref-watcher"
import { getThread } from "../db"
import { startWatching } from "../services/workspace-watcher"
import type {
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessSessionBinding,
  HarnessSessionBindingUpsertInput,
  HarnessSkillRegistryItem
} from "../../shared/harness-board-types"

function getThreadWorkspacePath(threadId: string): string | null {
  const thread = getThread(threadId)
  if (!thread?.metadata) return null
  try {
    const metadata = JSON.parse(thread.metadata) as Record<string, unknown>
    return typeof metadata.workspacePath === "string" && metadata.workspacePath.trim()
      ? metadata.workspacePath
      : null
  } catch {
    return null
  }
}

function startSessionWorkspaceWatchers(detail: HarnessRunDetailViewModel): void {
  for (const session of detail.sessions) {
    const workspacePath = getThreadWorkspacePath(session.threadId)
    if (workspacePath) {
      startWatching(session.threadId, workspacePath)
    }
  }
}

export function registerHarnessBoardHandlers(ipcMain: IpcMain): void {
  console.log("[HarnessBoard] Registering harness board handlers...")

  ipcMain.handle("harnessBoard:registry", async (): Promise<HarnessSkillRegistryItem[]> => {
    return HARNESS_SKILL_REGISTRY
  })

  ipcMain.handle("harnessBoard:listProjects", async (): Promise<HarnessProjectListItem[]> => {
    return listHarnessProjects()
  })

  ipcMain.handle(
    "harnessBoard:createProject",
    async (_event, input: HarnessProjectCreateInput): Promise<HarnessProjectMetadata> => {
      return createHarnessProject(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:updateProject",
    async (
      _event,
      payload: { projectId: string; input: HarnessProjectMetadataUpdateInput }
    ): Promise<HarnessProjectMetadata> => {
      return updateHarnessProjectMetadata(payload.projectId, payload.input)
    }
  )

  ipcMain.handle(
    "harnessBoard:archiveProject",
    async (_event, projectId: string): Promise<HarnessProjectMetadata> => {
      return archiveHarnessProject(projectId)
    }
  )

  ipcMain.handle(
    "harnessBoard:getProjectDetail",
    async (_event, projectId: string): Promise<HarnessProjectDetailViewModel> => {
      const detail = getHarnessProjectDetail(projectId)
      startHarnessWatchRefs(`project:${projectId}`, detail.project.workspacePath, detail.watchRefs)
      return detail
    }
  )

  ipcMain.handle(
    "harnessBoard:getRunDetail",
    async (
      _event,
      payload: { projectId: string; slug: string }
    ): Promise<HarnessRunDetailViewModel> => {
      const detail = getHarnessRunDetail(payload.projectId, payload.slug)
      startHarnessWatchRefs(
        `run:${payload.projectId}:${payload.slug}`,
        detail.project.workspacePath,
        detail.run.watchRefs
      )
      startSessionWorkspaceWatchers(detail)
      return detail
    }
  )

  ipcMain.handle(
    "harnessBoard:linkSession",
    async (_event, input: HarnessSessionBindingUpsertInput): Promise<HarnessSessionBinding> => {
      return upsertHarnessSessionBinding(input)
    }
  )
}
