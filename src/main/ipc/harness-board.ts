import type { IpcMain } from "electron"
import {
  archiveHarnessProject,
  createHarnessFeature,
  createHarnessProject,
  buildHarnessFeatureDialogTips,
  getHarnessDynamicWorkflowConfig,
  getHarnessProjectDetail,
  getHarnessProjectDetails,
  getHarnessRunDetail,
  listHarnessAdapters,
  listHarnessProjects,
  skipHarnessRunNode,
  updateHarnessProjectMetadata
} from "../harness-board/service"
import { startHarnessWatchRefs } from "../harness-board/watch-ref-watcher"
import type {
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessAdapterRegistryItem,
  HarnessDynamicWorkflowConfig
} from "../../shared/harness-board-types"
import type {
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult
} from "../../shared/harness-board-types"

export function registerHarnessBoardHandlers(ipcMain: IpcMain): void {
  console.log("[HarnessBoard] Registering harness board handlers...")

  ipcMain.handle("harnessBoard:registry", async (): Promise<HarnessAdapterRegistryItem[]> => {
    return listHarnessAdapters()
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
    "harnessBoard:createFeature",
    async (_event, input: HarnessFeatureCreateInput): Promise<HarnessFeatureCreateResult> => {
      return createHarnessFeature(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:getDynamicWorkflowConfig",
    async (_event, projectId: string): Promise<HarnessDynamicWorkflowConfig | null> => {
      return getHarnessDynamicWorkflowConfig(projectId)
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
      startHarnessWatchRefs(`project:${projectId}`, detail.project.projectRootPath, detail.watchRefs)
      return detail
    }
  )

  ipcMain.handle(
    "harnessBoard:getProjectDetails",
    async (
      _event,
      payload: string[] | { projectIds: string[]; watchRefs?: boolean }
    ): Promise<Record<string, HarnessProjectDetailViewModel>> => {
      const projectIds = Array.isArray(payload) ? payload : payload.projectIds
      const shouldWatchRefs = Array.isArray(payload) ? true : payload.watchRefs !== false
      const details = getHarnessProjectDetails(projectIds)
      if (shouldWatchRefs) {
        for (const [projectId, detail] of Object.entries(details)) {
          startHarnessWatchRefs(`project:${projectId}`, detail.project.projectRootPath, detail.watchRefs)
        }
      }
      return details
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
        detail.project.projectRootPath,
        detail.run.watchRefs
      )
      return detail
    }
  )

  ipcMain.handle(
    "harnessBoard:skipNode",
    async (_event, input: HarnessSkipNodeInput): Promise<HarnessSkipNodeResult> => {
      return skipHarnessRunNode(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:getDialogTips",
    async (_event, payload: { projectId: string; slug: string }): Promise<string | null> => {
      return buildHarnessFeatureDialogTips(payload.projectId, payload.slug)
    }
  )
}
