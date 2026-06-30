import type { IpcMain } from "electron"
import {
  archiveHarnessProject,
  createHarnessFeature,
  createHarnessProject,
  buildHarnessFeatureDialogTips,
  getHarnessDynamicWorkflowConfig,
  deleteHarnessProject,
  getHarnessProjectDetail,
  getHarnessProjectDetails,
  getHarnessKnowledgePreview,
  getHarnessLocalAgentmdServiceUnitMappings,
  getHarnessProjectPublicAgentmdServiceUnits,
  getHarnessRunDetail,
  listHarnessAdapters,
  listHarnessProjects,
  listHarnessServiceUnitMappings,
  saveHarnessServiceUnitMappings,
  skipHarnessRunNode,
  syncHarnessProjectConstraints,
  updateHarnessProjectMetadata
} from "../harness-board/service"
import {
  getEnterpriseProjectDetails,
  searchEnterpriseProjects
} from "../harness-board/enterprise-projects"
import { startHarnessWatchRefs } from "../harness-board/watch-ref-watcher"
import { purgeProjectAnalytics } from "../services/project-analytics-purge"
import { reportProjectSnapshotNow } from "../services/harness-status-reporter"
import type {
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchResult,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessServiceUnitMapping,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessAdapterRegistryItem,
  HarnessDynamicWorkflowConfig
} from "../../shared/harness-board-types"
import type {
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult
} from "../../shared/harness-board-types"
import type { HarnessKnowledgePreviewResult } from "../../shared/harness-board-types"

export function registerHarnessBoardHandlers(ipcMain: IpcMain): void {
  console.log("[HarnessBoard] Registering harness board handlers...")

  ipcMain.handle("harnessBoard:registry", async (): Promise<HarnessAdapterRegistryItem[]> => {
    return listHarnessAdapters()
  })

  ipcMain.handle("harnessBoard:listProjects", async (): Promise<HarnessProjectListItem[]> => {
    return listHarnessProjects()
  })

  ipcMain.handle("harnessBoard:getServiceUnitMappings", async (): Promise<HarnessServiceUnitMapping[]> => {
    return listHarnessServiceUnitMappings()
  })

  ipcMain.handle(
    "harnessBoard:saveServiceUnitMappings",
    async (_event, mappings: HarnessServiceUnitMapping[]): Promise<HarnessServiceUnitMapping[]> => {
      return saveHarnessServiceUnitMappings(mappings)
    }
  )

  ipcMain.handle(
    "harnessBoard:syncProjectConstraints",
    async (_event, adapterId: string): Promise<HarnessProjectConstraintSyncResult> => {
      return syncHarnessProjectConstraints(adapterId)
    }
  )

  ipcMain.handle(
    "harnessBoard:getKnowledgePreview",
    async (_event, adapterId: string): Promise<HarnessKnowledgePreviewResult> => {
      return getHarnessKnowledgePreview(adapterId)
    }
  )

  ipcMain.handle(
    "harnessBoard:createProject",
    async (_event, input: HarnessProjectCreateInput): Promise<HarnessProjectMetadata> => {
      const created = createHarnessProject(input)
      // 立即补一次快照上报，避免新建项目要等下一轮 20 分钟定时扫描才出现在运营面板。
      // 尽力而为：内部已 try/catch，不抛错、不阻断创建结果返回。
      void reportProjectSnapshotNow(created.projectId)
      return created
    }
  )

  ipcMain.handle(
    "harnessBoard:searchEnterpriseProjects",
    async (
      _event,
      input: HarnessEnterpriseProjectSearchInput
    ): Promise<HarnessEnterpriseProjectSearchResult> => {
      return searchEnterpriseProjects(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:getEnterpriseProjectDetails",
    async (
      _event,
      input: HarnessEnterpriseProjectDetailInput
    ): Promise<HarnessEnterpriseProjectDetailResult> => {
      return getEnterpriseProjectDetails(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:createFeature",
    async (_event, input: HarnessFeatureCreateInput): Promise<HarnessFeatureCreateResult> => {
      const result = createHarnessFeature(input)
      // 新建 feature 后立即补一次该项目的快照上报，让面板尽快反映新特性，无需等定时扫描。
      void reportProjectSnapshotNow(result.projectId)
      return result
    }
  )

  ipcMain.handle(
    "harnessBoard:getDynamicWorkflowConfig",
    async (_event, projectId: string): Promise<HarnessDynamicWorkflowConfig | null> => {
      return getHarnessDynamicWorkflowConfig(projectId)
    }
  )

  ipcMain.handle(
    "harnessBoard:getPublicAgentmdServiceUnits",
    async (_event, projectId: string): Promise<string[]> => {
      return getHarnessProjectPublicAgentmdServiceUnits(projectId)
    }
  )

  ipcMain.handle(
    "harnessBoard:getLocalAgentmdServiceUnitMappings",
    async (_event, mappings: HarnessServiceUnitMapping[]): Promise<string[]> => {
      return getHarnessLocalAgentmdServiceUnitMappings(mappings)
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
