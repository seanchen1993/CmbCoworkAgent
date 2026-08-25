import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import {
  archiveHarnessProject,
  cancelHarnessDetailRequestScope,
  createHarnessFeature,
  createHarnessProject,
  buildHarnessFeatureDialogTips,
  getHarnessDynamicWorkflowConfig,
  deleteHarnessProject,
  getHarnessProjectDetail,
  getHarnessProjectDetails,
  getHarnessLocalAgentmdDeployUnitMappings,
  getHarnessProjectPublicAgentmdDeployUnits,
  getHarnessRunDetail,
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
  cancelHarnessCatalogScope,
  readHarnessCatalogPageInWorker
} from "../harness-board/catalog-client"
import {
  cancelHarnessKnowledgePreviewOwner,
  readHarnessKnowledgePreviewInWorker
} from "../harness-board/knowledge-preview-client"
import {
  cancelHarnessEnterpriseRequestScope,
  getEnterpriseProjectDetails,
  getProjectReviews,
  queryPipelineLabels,
  queryPipelines,
  searchDeployUnits,
  searchEnterpriseProjects
} from "../harness-board/enterprise-projects"
import {
  startHarnessWatchRefs,
  stopHarnessWatchRefs,
  stopAllHarnessWatchRefs
} from "../harness-board/watch-ref-watcher"
import { purgeProjectAnalytics } from "../services/project-analytics-purge"
import { reportProjectSnapshotNow } from "../services/harness-status-reporter"
import {
  HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH
} from "../harness-board/adapter-detail-protocol"
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
import {
  issueExternalFileReadGrant,
  revokeExternalFileReadGrantsForOwner
} from "../services/external-file-read-tokens"
import type {
  HarnessBoardCatalogPageInput,
  HarnessBoardCatalogPageResult
} from "../../shared/harness-board-types"
import type {
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult
} from "../../shared/harness-board-types"

export function registerHarnessBoardHandlers(ipcMain: IpcMain): void {
  console.log("[HarnessBoard] Registering harness board handlers...")

  const enterpriseCleanupSenders = new WeakSet<WebContents>()
  const desiredWatchScopesBySender = new Map<number, Set<string>>()
  const activeSingleProjectScopeBySender = new Map<number, string>()
  const activeRunScopeBySender = new Map<number, string>()
  const enterpriseScope = (senderId: number, lane: string): string =>
    `harness-enterprise:${senderId}:${lane}`
  const cancelEnterpriseSenderScopes = (senderId: number): void => {
    for (const lane of ["board-batch", "selected-project", "reviews"]) {
      cancelHarnessEnterpriseRequestScope(enterpriseScope(senderId, lane))
    }
  }
  const stopDesiredWatchScope = (senderId: number, scopeKey: string): void => {
    desiredWatchScopesBySender.get(senderId)?.delete(scopeKey)
    stopHarnessWatchRefs(scopeKey)
  }
  const desireWatchScope = (senderId: number, scopeKey: string): void => {
    const desired = desiredWatchScopesBySender.get(senderId) ?? new Set<string>()
    if (!desiredWatchScopesBySender.has(senderId)) {
      desiredWatchScopesBySender.set(senderId, desired)
    }
    desired.delete(scopeKey)
    while (desired.size >= 4) {
      const oldestScope = desired.values().next().value as string | undefined
      if (!oldestScope) break
      desired.delete(oldestScope)
      stopHarnessWatchRefs(oldestScope)
    }
    desired.add(scopeKey)
  }
  const stopDesiredWatchScopesForSender = (senderId: number): void => {
    const desired = desiredWatchScopesBySender.get(senderId)
    desiredWatchScopesBySender.delete(senderId)
    for (const scopeKey of desired ?? []) stopHarnessWatchRefs(scopeKey)
    activeSingleProjectScopeBySender.delete(senderId)
    activeRunScopeBySender.delete(senderId)
  }
  const ensureEnterpriseSenderCleanup = (event: IpcMainInvokeEvent): void => {
    if (enterpriseCleanupSenders.has(event.sender)) return
    enterpriseCleanupSenders.add(event.sender)
    const senderId = event.sender.id
    event.sender.once("destroyed", () => {
      cancelEnterpriseSenderScopes(senderId)
      cancelHarnessCatalogScope(`harness-dialog-tips:${senderId}`)
      cancelHarnessKnowledgePreviewOwner(senderId)
      stopDesiredWatchScopesForSender(senderId)
      revokeExternalFileReadGrantsForOwner(senderId)
    })
  }

  ipcMain.handle("harnessBoard:registry", async (event): Promise<HarnessAdapterRegistryItem[]> => {
    const result = await readHarnessCatalogPageInWorker(
      { includeProjects: false, registryLimit: 64 },
      `${event.sender.id}:registry`
    )
    return result.registry
  })

  ipcMain.handle(
    "harnessBoard:catalog",
    async (event): Promise<{
      projects: HarnessProjectListItem[]
      registry: HarnessAdapterRegistryItem[]
    }> => {
      const result = await readHarnessCatalogPageInWorker(
        { projectLimit: 24, registryLimit: 24 },
        `${event.sender.id}:catalog`
      )
      return { projects: result.projects, registry: result.registry }
    }
  )

  ipcMain.handle("harnessBoard:listProjects", async (event): Promise<HarnessProjectListItem[]> => {
    const result = await readHarnessCatalogPageInWorker(
      { includeRegistry: false, projectLimit: 64 },
      `${event.sender.id}:projects`
    )
    return result.projects
  })

  ipcMain.handle(
    "harnessBoard:catalogPage",
    async (event, input: HarnessBoardCatalogPageInput): Promise<HarnessBoardCatalogPageResult> =>
      readHarnessCatalogPageInWorker(
        input,
        `${event.sender.id}:${input.requestScope ?? "catalog-page"}`
      )
  )

  ipcMain.handle(
    "harnessBoard:cancelCatalogRequests",
    (
      event,
      requestedScope?: "board" | "board-registry" | "board-settings" | "chat-binding"
    ): void => {
    const prefix = `${event.sender.id}:`
    const suffixes = requestedScope ? [requestedScope] : [
      "catalog",
      "registry",
      "projects",
      "catalog-page",
      "board",
      "board-registry",
      "board-sidebar",
      "board-settings",
      "chat-binding"
    ]
    for (const suffix of suffixes) {
      cancelHarnessCatalogScope(`${prefix}${suffix}`)
    }
    }
  )

  ipcMain.handle("harnessBoard:getDeployUnitMappings", async (): Promise<HarnessDeployUnitMapping[]> => {
    return listHarnessDeployUnitMappings()
  })

  ipcMain.handle("harnessBoard:getLeanTokenConfig", async (event): Promise<HarnessLeanTokenConfig> => {
    return getHarnessLeanTokenConfig({ scope: `${event.sender.id}:board-settings` })
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
    async (event, adapterId: string): Promise<HarnessKnowledgePreviewResult> => {
      ensureEnterpriseSenderCleanup(event)
      const normalizedAdapterId = typeof adapterId === "string" ? adapterId.trim().slice(0, 512) : ""
      if (!normalizedAdapterId) throw new Error("Harness adapter id is required")
      const scope = `harness-knowledge:${event.sender.id}:${normalizedAdapterId}`
      const preview = await readHarnessKnowledgePreviewInWorker(normalizedAdapterId, scope)
      if (!preview.exists || !preview.path) return preview
      const previewablePaths = preview.files
        .filter((file) => !file.is_dir)
        .map((file) => file.path)
      if (previewablePaths.length === 0) return preview

      // The knowledge root comes from the main-process Harness adapter config.
      // The renderer receives only a sender-bound capability, never a path-to-
      // capability minting primitive.
      const issued = issueExternalFileReadGrant(
        preview.path,
        event.sender.id,
        previewablePaths,
        `harness-knowledge:${adapterId}`
      )
      if ("error" in issued) {
        return {
          ...preview,
          error: preview.error ? `${preview.error}；${issued.error}` : issued.error
        }
      }
      return { ...preview, previewGrant: issued.grant }
    }
  )

  ipcMain.handle("harnessBoard:cancelKnowledgePreviewRequests", (event): void => {
    cancelHarnessKnowledgePreviewOwner(event.sender.id)
  })

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
      event,
      input: HarnessEnterpriseProjectDetailInput
    ): Promise<HarnessEnterpriseProjectDetailResult> => {
      ensureEnterpriseSenderCleanup(event)
      const lane = input.requestScope === "board-batch" ? "board-batch" : "selected-project"
      return getEnterpriseProjectDetails(input, {
        scope: enterpriseScope(event.sender.id, lane)
      })
    }
  )

  ipcMain.handle(
    "harnessBoard:getProjectReviews",
    async (event, input: HarnessProjectReviewInput): Promise<HarnessProjectReviewResult> => {
      ensureEnterpriseSenderCleanup(event)
      return getProjectReviews(input, {
        scope: enterpriseScope(event.sender.id, "reviews")
      })
    }
  )

  ipcMain.handle(
    "harnessBoard:cancelEnterpriseRequests",
    (event, requestedLane: "board-batch" | "selected-project" | "reviews"): void => {
      if (!["board-batch", "selected-project", "reviews"].includes(requestedLane)) return
      cancelHarnessEnterpriseRequestScope(enterpriseScope(event.sender.id, requestedLane))
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
    async (event, projectId: string): Promise<HarnessProjectDetailViewModel> => {
      ensureEnterpriseSenderCleanup(event)
      const watchScopeKey = `project:${projectId}`
      desireWatchScope(event.sender.id, watchScopeKey)
      activeSingleProjectScopeBySender.set(event.sender.id, watchScopeKey)
      const detail = await getHarnessProjectDetail(projectId, {
        scope: `harness-project-detail:${event.sender.id}:single`,
        maxResponseBytes: HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES
      })
      if (desiredWatchScopesBySender.get(event.sender.id)?.has(watchScopeKey)) {
        startHarnessWatchRefs(watchScopeKey, detail.project.projectRootPath, detail.watchRefs)
      }
      return detail
    }
  )

  ipcMain.handle(
    "harnessBoard:getProjectDetails",
    async (
      event,
      payload: string[] | { projectIds: string[]; watchRefs?: boolean }
    ): Promise<Record<string, HarnessProjectDetailViewModel>> => {
      const projectIds = Array.isArray(payload) ? payload : payload.projectIds
      if (projectIds.length > HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH) {
        throw new Error(
          `Harness project detail request exceeds ${HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH} projects`
        )
      }
      const shouldWatchRefs = Array.isArray(payload) ? true : payload.watchRefs !== false
      if (shouldWatchRefs) {
        ensureEnterpriseSenderCleanup(event)
        for (const projectId of projectIds) {
          desireWatchScope(event.sender.id, `project:${projectId}`)
        }
      }
      const details = await getHarnessProjectDetails(projectIds, {
        scope: `harness-project-detail:${event.sender.id}:batch`,
        maxResponseBytes: HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES
      })
      if (shouldWatchRefs) {
        for (const [projectId, detail] of Object.entries(details)) {
          const watchScopeKey = `project:${projectId}`
          if (desiredWatchScopesBySender.get(event.sender.id)?.has(watchScopeKey)) {
            startHarnessWatchRefs(watchScopeKey, detail.project.projectRootPath, detail.watchRefs)
          }
        }
      }
      return details
    }
  )

  ipcMain.handle("harnessBoard:stopWatchRefs", (event, scopeKey?: string): void => {
    if (
      typeof scopeKey === "string" &&
      scopeKey.length <= 4_096 &&
      /^(project:[^:]+|run:[^:]+:.+)$/.test(scopeKey)
    ) {
      stopDesiredWatchScope(event.sender.id, scopeKey)
      if (scopeKey.startsWith("project:")) {
        if (activeSingleProjectScopeBySender.get(event.sender.id) === scopeKey) {
          activeSingleProjectScopeBySender.delete(event.sender.id)
          cancelHarnessDetailRequestScope(`harness-project-detail:${event.sender.id}:single`)
        }
      } else if (activeRunScopeBySender.get(event.sender.id) === scopeKey) {
        activeRunScopeBySender.delete(event.sender.id)
        cancelHarnessDetailRequestScope(`harness-run-detail:${event.sender.id}`)
      }
      return
    }
    stopDesiredWatchScopesForSender(event.sender.id)
    stopAllHarnessWatchRefs()
    cancelHarnessDetailRequestScope(`harness-project-detail:${event.sender.id}:single`)
    cancelHarnessDetailRequestScope(`harness-project-detail:${event.sender.id}:batch`)
    cancelHarnessDetailRequestScope(`harness-run-detail:${event.sender.id}`)
    cancelHarnessCatalogScope(`harness-dialog-tips:${event.sender.id}`)
    cancelEnterpriseSenderScopes(event.sender.id)
  })

  ipcMain.handle(
    "harnessBoard:getRunDetail",
    async (
      event,
      payload: { projectId: string; slug: string }
    ): Promise<HarnessRunDetailViewModel> => {
      ensureEnterpriseSenderCleanup(event)
      const watchScopeKey = `run:${payload.projectId}:${payload.slug}`
      desireWatchScope(event.sender.id, watchScopeKey)
      activeRunScopeBySender.set(event.sender.id, watchScopeKey)
      const detail = await getHarnessRunDetail(payload.projectId, payload.slug, {
        scope: `harness-run-detail:${event.sender.id}`
      })
      // Feature-page refreshes already paid for an authoritative feature_status
      // query, so reuse that result instead of spawning another adapter lookup
      // before the next code generation.
      primeHarnessStageAttribution(
        payload.projectId,
        payload.slug,
        resolveHarnessRunDetailCurrentStage(detail)
      )
      if (desiredWatchScopesBySender.get(event.sender.id)?.has(watchScopeKey)) {
        startHarnessWatchRefs(
          watchScopeKey,
          detail.project.projectRootPath,
          detail.run.watchRefs,
          { projectId: payload.projectId, featureSlug: payload.slug }
        )
      }
      return detail
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
    async (event, payload: { projectId: string; slug: string }): Promise<string | null> => {
      ensureEnterpriseSenderCleanup(event)
      return buildHarnessFeatureDialogTips(payload.projectId, payload.slug, {
        scope: `harness-dialog-tips:${event.sender.id}`
      })
    }
  )

  ipcMain.handle("harnessBoard:cancelDialogTips", (event): void => {
    cancelHarnessCatalogScope(`harness-dialog-tips:${event.sender.id}`)
  })
}
