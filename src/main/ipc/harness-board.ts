import { BrowserWindow, type IpcMain } from "electron"
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
  getHarnessLocalAgentmdDeployUnitMappings,
  getHarnessProjectPublicAgentmdDeployUnits,
  getHarnessProjectRootPath,
  getHarnessRunDetail,
  listHarnessAdapters,
  listHarnessProjects,
  listHarnessDeployUnitMappings,
  getHarnessLeanTokenConfig,
  saveHarnessDeployUnitMappings,
  saveHarnessLeanTokenConfig,
  skipHarnessRunNode,
  syncHarnessProjectConstraints,
  updateHarnessFeatureDeployUnits,
  updateHarnessProjectMetadata,
  resolveHarnessRunDetailCurrentStage
} from "../harness-board/service"
import {
  getEnterpriseProjectDetails,
  getProjectReviews,
  queryPipelineLabels,
  queryPipelines,
  searchDeployUnits,
  searchEnterpriseProjects
} from "../harness-board/enterprise-projects"
import { startHarnessWatchRefs } from "../harness-board/watch-ref-watcher"
import { managedRunStore } from "../harness-board/managed-run-store"
import {
  createBrowserWindowAgentRunDelivery
} from "../agent/agent-run-service"
import { managedRunController } from "../harness-board/managed-run-controller"
import { purgeProjectAnalytics } from "../services/project-analytics-purge"
import { reportProjectSnapshotNow } from "../services/harness-status-reporter"
import {
  markHarnessStageAttributionDirty,
  primeHarnessStageAttribution
} from "../services/harness-stage-attribution"
import type {
  HarnessDeployUnitSearchInput,
  HarnessDeployUnitSearchResult,
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchResult,
  HarnessPipelineLabelQueryInput,
  HarnessPipelineLabelQueryResult,
  HarnessPipelineQueryInput,
  HarnessPipelineQueryResult,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessDeployUnitMapping,
  HarnessLeanTokenConfig,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessAdapterRegistryItem,
  HarnessDynamicWorkflowConfig,
  HarnessKnowledgePreviewResult,
  HarnessFeatureDeployUnitBinding,
  HarnessFeatureDeployUnitUpdateInput,
  HarnessProjectReviewInput,
  HarnessProjectReviewResult
} from "../../shared/harness-board-types"
import type {
  ManagedRunEventCursor,
  ManagedRunEventsPage,
  ManagedRunIdentity,
  ManagedRunStartInput,
  ManagedRunStopInput,
  ManagedRunSummary
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

  ipcMain.handle("harnessBoard:getDeployUnitMappings", async (): Promise<HarnessDeployUnitMapping[]> => {
    return listHarnessDeployUnitMappings()
  })

  ipcMain.handle("harnessBoard:getLeanTokenConfig", async (): Promise<HarnessLeanTokenConfig> => {
    return getHarnessLeanTokenConfig()
  })

  ipcMain.handle(
    "harnessBoard:saveDeployUnitMappings",
    async (_event, mappings: HarnessDeployUnitMapping[]): Promise<HarnessDeployUnitMapping[]> => {
      return saveHarnessDeployUnitMappings(mappings)
    }
  )

  ipcMain.handle(
    "harnessBoard:saveLeanTokenConfig",
    async (_event, input: HarnessLeanTokenConfig): Promise<HarnessLeanTokenConfig> => {
      return saveHarnessLeanTokenConfig(input)
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
      const created = await createHarnessProject(input)
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
    "harnessBoard:searchDeployUnits",
    async (
      _event,
      input: HarnessDeployUnitSearchInput
    ): Promise<HarnessDeployUnitSearchResult> => {
      return searchDeployUnits(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:queryPipelines",
    async (_event, input: HarnessPipelineQueryInput): Promise<HarnessPipelineQueryResult> => {
      return queryPipelines(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:queryPipelineLabels",
    async (
      _event,
      input: HarnessPipelineLabelQueryInput
    ): Promise<HarnessPipelineLabelQueryResult> => {
      return queryPipelineLabels(input)
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
    "harnessBoard:getProjectReviews",
    async (_event, input: HarnessProjectReviewInput): Promise<HarnessProjectReviewResult> => {
      return getProjectReviews(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:createFeature",
    async (_event, input: HarnessFeatureCreateInput): Promise<HarnessFeatureCreateResult> => {
      const result = await createHarnessFeature(input)
      // 新建 feature 后立即补一次该项目的快照上报，让面板尽快反映新特性，无需等定时扫描。
      void reportProjectSnapshotNow(result.projectId)
      return result
    }
  )

  ipcMain.handle(
    "harnessBoard:updateFeatureDeployUnits",
    async (
      _event,
      input: HarnessFeatureDeployUnitUpdateInput
    ): Promise<HarnessFeatureDeployUnitBinding> => {
      return updateHarnessFeatureDeployUnits(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:startManagedRun",
    async (event, input: ManagedRunStartInput): Promise<ManagedRunSummary> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error("没有可用的应用主窗口，无法开始托管")
      return managedRunController.start({
        ...input,
        delivery: createBrowserWindowAgentRunDelivery(window)
      })
    }
  )

  ipcMain.handle(
    "harnessBoard:stopManagedRun",
    async (_event, input: ManagedRunStopInput): Promise<boolean> => {
      return managedRunController.stop(input)
    }
  )

  ipcMain.handle(
    "harnessBoard:getDynamicWorkflowConfig",
    async (_event, projectId: string): Promise<HarnessDynamicWorkflowConfig | null> => {
      return await getHarnessDynamicWorkflowConfig(projectId)
    }
  )

  ipcMain.handle(
    "harnessBoard:getPublicAgentmdDeployUnits",
    async (_event, projectId: string): Promise<string[]> => {
      return getHarnessProjectPublicAgentmdDeployUnits(projectId)
    }
  )

  ipcMain.handle(
    "harnessBoard:getLocalAgentmdDeployUnitMappings",
    async (_event, mappings: HarnessDeployUnitMapping[]): Promise<string[]> => {
      return getHarnessLocalAgentmdDeployUnitMappings(mappings)
    }
  )

  ipcMain.handle(
    "harnessBoard:updateProject",
    async (
      _event,
      payload: { projectId: string; input: HarnessProjectMetadataUpdateInput }
    ): Promise<HarnessProjectMetadata> => {
      const updated = updateHarnessProjectMetadata(payload.projectId, payload.input)
      // 编辑元数据（如 projectFromLean 切换）后立即补一次快照上报，否则改动要等下一轮
      // 20 分钟定时扫描才刷到运营面板。尽力而为：内部已 try/catch，不抛错、不阻断返回。
      void reportProjectSnapshotNow(payload.projectId)
      return updated
    }
  )

  ipcMain.handle(
    "harnessBoard:archiveProject",
    async (_event, projectId: string): Promise<HarnessProjectMetadata> => {
      const archived = archiveHarnessProject(projectId)
      // 归档后立即补一次快照上报，让面板尽快反映「已归档」状态变更，无需等定时扫描。
      void reportProjectSnapshotNow(projectId)
      return archived
    }
  )

  ipcMain.handle(
    "harnessBoard:deleteProject",
    async (_event, projectId: string): Promise<HarnessProjectMetadata> => {
      const projectDirectory = getHarnessProjectRootPath(projectId)
      const deleted = deleteHarnessProject(projectId)
      managedRunStore.removeProject(projectId, projectDirectory)
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
      const detail = await getHarnessProjectDetail(projectId)
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
      const details = await getHarnessProjectDetails(projectIds)
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
      const detail = await getHarnessRunDetail(payload.projectId, payload.slug)
      // Feature-page refreshes already paid for an authoritative feature_status
      // query, so reuse that result instead of spawning another adapter lookup
      // before the next code generation.
      primeHarnessStageAttribution(
        payload.projectId,
        payload.slug,
        resolveHarnessRunDetailCurrentStage(detail)
      )
      startHarnessWatchRefs(
        `run:${payload.projectId}:${payload.slug}`,
        detail.project.projectRootPath,
        detail.run.watchRefs,
        { projectId: payload.projectId, featureSlug: payload.slug }
      )
      return detail
    }
  )

  ipcMain.handle(
    "harnessBoard:getManagedRunEvents",
    async (
      _event,
      input: ManagedRunIdentity & { cursor?: ManagedRunEventCursor; limit?: number }
    ): Promise<ManagedRunEventsPage> => {
      return managedRunStore.listEvents(input, input.cursor, input.limit)
    }
  )

  ipcMain.handle(
    "harnessBoard:skipNode",
    async (_event, input: HarnessSkipNodeInput): Promise<HarnessSkipNodeResult> => {
      const result = await skipHarnessRunNode(input)
      markHarnessStageAttributionDirty(result.projectId, result.slug)
      return result
    }
  )

  ipcMain.handle(
    "harnessBoard:getDialogTips",
    async (_event, payload: { projectId: string; slug: string }): Promise<string | null> => {
      return buildHarnessFeatureDialogTips(payload.projectId, payload.slug)
    }
  )
}
