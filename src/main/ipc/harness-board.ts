import type { IpcMain } from "electron"
import {
  archiveHarnessProject,
  createHarnessFeature,
  createHarnessProject,
  buildHarnessFeatureDialogTips,
  deleteHarnessProject,
  getHarnessProjectDetail,
  getHarnessProjectDetails,
  getHarnessRunDetail,
  listHarnessAdapters,
  listHarnessProjects,
  updateHarnessProjectMetadata
} from "../harness-board/service"
import { startHarnessWatchRefs } from "../harness-board/watch-ref-watcher"
import { purgeProjectAnalytics } from "../services/project-analytics-purge"
import type {
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessAdapterRegistryItem
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
    "harnessBoard:deleteProject",
    async (_event, projectId: string): Promise<HarnessProjectMetadata> => {
      const deleted = deleteHarnessProject(projectId)
      // 项目本地删除后，后台清理其在 ES 中的 trace/event 文档，使其不再出现在运营面板统计中。
      // 尽力而为（fire-and-forget）：内网部分机器无法直连 ES/后端，清理失败不应阻断或回滚删除。
      void purgeProjectAnalytics(projectId)
        .then((result) => {
          console.log(`[HarnessBoard] purged analytics for deleted project ${projectId}:`, result)
        })
        .catch((e) => {
          console.error(
            `[HarnessBoard] purgeProjectAnalytics failed for deleted project ${projectId}:`,
            e
          )
        })
      return deleted
    }
  )

  ipcMain.handle(
    "harnessBoard:getProjectDetail",
    async (_event, projectId: string): Promise<HarnessProjectDetailViewModel> => {
      const detail = getHarnessProjectDetail(projectId)
      startHarnessWatchRefs(
        `project:${projectId}`,
        detail.project.projectRootPath,
        detail.watchRefs
      )
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
          startHarnessWatchRefs(
            `project:${projectId}`,
            detail.project.projectRootPath,
            detail.watchRefs
          )
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
    "harnessBoard:getDialogTips",
    async (_event, payload: { projectId: string; slug: string }): Promise<string | null> => {
      return buildHarnessFeatureDialogTips(payload.projectId, payload.slug)
    }
  )
}
