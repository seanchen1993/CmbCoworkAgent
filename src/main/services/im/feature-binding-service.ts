import { randomUUID } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { HARNESS_SOURCE, type HarnessFeatureSummary } from "../../../shared/harness-board-types"
import { DEFAULT_IM_CHANNEL_ID } from "../../../shared/im-gateway-contract"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { getAgentModeFromMetadata, type AgentMode } from "../../agent/coordinator-mode"
import { getThread } from "../../db"
import type { createThreadService } from "../thread-service"
import { isFeatureGateEnabled } from "../../feature-gates"
import { defaultThreadTitle } from "../title-generator"
import {
  buildHarnessFeatureAgentContext,
  getHarnessProjectDetail,
  getHarnessRunDetail,
  listHarnessProjects
} from "../../harness-board/service"
import { getBuiltinRobotSettings } from "../../storage"
import { FEATURE_GATES } from "../../../shared/feature-gates"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"

export interface ImRemoteProjectListItem {
  id: string
  name: string
}

export interface ImRemoteFeatureListItem {
  projectId: string
  slug: string
  title: string
  status: string
}

export type ImFeatureValidationResult =
  | {
      valid: true
      project: ImRemoteProjectListItem
      feature: ImRemoteFeatureListItem
      workspacePath: string
    }
  | { valid: false; reasonCode: string; message: string }

export interface ImCreatedFeatureThread {
  threadId: string
  /** Whatever the shared creation path settled on — requested, inherited or default. */
  agentMode: AgentMode
  title: string
  workspacePath: string
  projectId: string
  featureSlug: string
  projectName: string
  featureTitle: string
}

/** A deliberately user-safe binding failure that may be returned to IM verbatim. */
export class ImFeatureBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImFeatureBindingError"
  }
}

interface FeatureBindingDependencies {
  conversationState: ImConversationStateStore
  getSettings: typeof getBuiltinRobotSettings
  projectModeEnabled: () => Promise<boolean>
  listProjects: typeof listHarnessProjects
  getProjectDetail: typeof getHarnessProjectDetail
  getRunDetail: typeof getHarnessRunDetail
  buildFeatureContext: typeof buildHarnessFeatureAgentContext
  getThread: typeof getThread
  createThread: typeof createThreadService
  createId: () => string
}

function existingDirectory(path: string | null | undefined): string | null {
  const normalized = path?.trim()
  if (!normalized || !isAbsolute(normalized) || !existsSync(normalized)) return null
  try {
    if (!statSync(normalized).isDirectory()) return null
    return realpathSync(normalized)
  } catch {
    return null
  }
}

function activeFeature(run: HarnessFeatureSummary): boolean {
  return run.location !== "archived" && run.featureStatus !== "archived"
}

function settingsAllowFeatures(dependencies: FeatureBindingDependencies): boolean {
  const settings = dependencies.getSettings()
  return settings.enabled
}

export class ImFeatureBindingService {
  private readonly dependencies: FeatureBindingDependencies

  constructor(dependencies: Partial<FeatureBindingDependencies> = {}) {
    this.dependencies = {
      conversationState: dependencies.conversationState ?? imConversationStateStore,
      getSettings: dependencies.getSettings ?? getBuiltinRobotSettings,
      projectModeEnabled:
        dependencies.projectModeEnabled ??
        (async () => (await isFeatureGateEnabled(FEATURE_GATES.projectMode)).enabled),
      listProjects: dependencies.listProjects ?? listHarnessProjects,
      getProjectDetail: dependencies.getProjectDetail ?? getHarnessProjectDetail,
      getRunDetail: dependencies.getRunDetail ?? getHarnessRunDetail,
      buildFeatureContext: dependencies.buildFeatureContext ?? buildHarnessFeatureAgentContext,
      getThread: dependencies.getThread ?? getThread,
      // Imported lazily on purpose. thread-service reaches into the IPC layer
      // (models, recent-workspace, electron-store); a static edge from an IM
      // service pulls all of that into the IM module graph and reorders
      // initialization, which is how remote-access-service ends up being read
      // before it exists.
      createThread:
        dependencies.createThread ??
        (async (metadata) => (await import("../thread-service")).createThreadService(metadata)),
      createId: dependencies.createId ?? randomUUID
    }
  }

  async listRemoteProjects(): Promise<ImRemoteProjectListItem[]> {
    if (
      !settingsAllowFeatures(this.dependencies) ||
      !(await this.dependencies.projectModeEnabled())
    ) {
      return []
    }
    return (await this.dependencies.listProjects())
      .filter(
        (project) =>
          project.lifecycle.status === "active" && project.boardCompatibility.compatible === true
      )
      .map((project) => ({ id: project.projectId, name: project.name.trim() || project.projectId }))
  }

  async listRemoteFeatures(projectId: string): Promise<ImRemoteFeatureListItem[]> {
    const projects = await this.listRemoteProjects()
    if (!projects.some((project) => project.id === projectId)) return []
    const detail = await this.dependencies.getProjectDetail(projectId)
    if (detail.error || detail.projectState?.uiKind === "archived") return []
    return detail.runs.filter(activeFeature).map((run) => ({
      projectId,
      slug: run.slug,
      title: run.title.trim() || run.slug,
      status: run.overallStatus?.label || run.featureStatusLabel || run.featureStatus
    }))
  }

  async validateFeature(
    projectId: string,
    featureSlug: string
  ): Promise<ImFeatureValidationResult> {
    if (!settingsAllowFeatures(this.dependencies)) {
      return {
        valid: false,
        reasonCode: "REMOTE_FEATURE_ACCESS_DISABLED",
        message: "本设备未开启 Feature 远程访问。"
      }
    }
    if (!(await this.dependencies.projectModeEnabled())) {
      return {
        valid: false,
        reasonCode: "REMOTE_PROJECT_MODE_DISABLED",
        message: "本设备未开启 Project Mode。"
      }
    }

    const project = (await this.dependencies.listProjects()).find(
      (candidate) => candidate.projectId === projectId
    )
    if (
      !project ||
      project.lifecycle.status !== "active" ||
      project.boardCompatibility.compatible !== true
    ) {
      return {
        valid: false,
        reasonCode: "REMOTE_PROJECT_UNAVAILABLE",
        message: "项目不存在、已归档或插件不兼容。"
      }
    }

    let detail: Awaited<ReturnType<typeof getHarnessProjectDetail>>
    let runDetail: Awaited<ReturnType<typeof getHarnessRunDetail>>
    try {
      detail = await this.dependencies.getProjectDetail(projectId)
      runDetail = await this.dependencies.getRunDetail(projectId, featureSlug)
    } catch {
      return {
        valid: false,
        reasonCode: "REMOTE_FEATURE_UNAVAILABLE",
        message: "Feature 或项目状态暂时无法读取。"
      }
    }
    if (detail.error || !existingDirectory(detail.project.projectRootPath)) {
      return {
        valid: false,
        reasonCode: "REMOTE_PROJECT_DIRECTORY_UNAVAILABLE",
        message: "项目目录不可用。"
      }
    }
    const feature = detail.runs.find((candidate) => candidate.slug === featureSlug)
    if (!feature || !activeFeature(feature)) {
      return {
        valid: false,
        reasonCode: "REMOTE_FEATURE_UNAVAILABLE",
        message: "Feature 不存在或已归档。"
      }
    }

    const sessionWorkspaceCandidates = runDetail.sessions
      .slice()
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
      .map((session) =>
        existingDirectory(
          parseStandardThreadMetadata(this.dependencies.getThread(session.threadId)?.metadata)
            .workspacePath
        )
      )
    const workspacePath =
      existingDirectory(detail.project.sessionWorkspacePath) ??
      sessionWorkspaceCandidates.find((candidate): candidate is string => Boolean(candidate)) ??
      existingDirectory(detail.project.projectRootPath)
    if (!workspacePath) {
      return {
        valid: false,
        reasonCode: "REMOTE_WORKSPACE_UNAVAILABLE",
        message: "无法安全解析 Feature 工作区，请先在桌面配置或创建一次 Feature 会话。"
      }
    }

    const harnessContext = await this.dependencies.buildFeatureContext(
      { harnessFeature: { projectId, slug: featureSlug, source: HARNESS_SOURCE } },
      { workspacePath }
    )
    if (!harnessContext) {
      return {
        valid: false,
        reasonCode: "REMOTE_HARNESS_CONTEXT_UNAVAILABLE",
        message: "Feature 的插件或系统约束上下文无法加载。"
      }
    }
    return {
      valid: true,
      project: { id: projectId, name: project.name.trim() || projectId },
      feature: {
        projectId,
        slug: feature.slug,
        title: feature.title.trim() || feature.slug,
        status: feature.overallStatus?.label || feature.featureStatusLabel || feature.featureStatus
      },
      workspacePath
    }
  }

  async validateExistingFeatureThread(
    metadata: Record<string, unknown>,
    workspacePath: string
  ): Promise<ImFeatureValidationResult> {
    const harness = metadata.harnessFeature
    if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
      return {
        valid: false,
        reasonCode: "REMOTE_THREAD_METADATA_MISMATCH",
        message: "Project Mode 会话元数据不完整。"
      }
    }
    const feature = harness as Record<string, unknown>
    if (typeof feature.projectId !== "string" || typeof feature.slug !== "string") {
      return {
        valid: false,
        reasonCode: "REMOTE_THREAD_METADATA_MISMATCH",
        message: "Project Mode 会话缺少项目或 Feature 标识。"
      }
    }
    const normalizedWorkspace = existingDirectory(workspacePath)
    if (!normalizedWorkspace) {
      return {
        valid: false,
        reasonCode: "REMOTE_WORKSPACE_UNAVAILABLE",
        message: "Project Mode 会话工作区不可用。"
      }
    }
    const validation = await this.validateFeature(feature.projectId, feature.slug)
    if (!validation.valid) return validation
    const harnessContext = await this.dependencies.buildFeatureContext(metadata, {
      workspacePath: normalizedWorkspace
    })
    if (!harnessContext) {
      return {
        valid: false,
        reasonCode: "REMOTE_HARNESS_CONTEXT_UNAVAILABLE",
        message: "Project Mode 会话的插件或系统约束上下文无法加载。"
      }
    }
    return { ...validation, workspacePath: normalizedWorkspace }
  }

  /**
   * Creates the Feature's session through the shared path (createThreadService),
   * not the raw row writer.
   *
   * That path maps the Feature's own configured mode onto the thread — solo and
   * multi to normal, agent_team to coordinator, workflow to workflow — but only
   * when the caller does not name a mode itself (thread-service.ts checks
   * hasOwnProperty). This used to pass agentMode: "normal" unconditionally, so
   * the same Feature produced a workflow session on the desktop and an ordinary
   * one from Zhaohu.
   *
   * `agentMode` is therefore passed through only when a person asked for it,
   * and its absence is what lets the Feature decide.
   */
  async createFeatureThread(input: {
    conversationKey: string
    principalId: string
    projectId: string
    featureSlug: string
    targetId: string
    agentMode?: AgentMode
  }): Promise<ImCreatedFeatureThread> {
    this.dependencies.conversationState.assertConversationOwner(
      input.conversationKey,
      input.principalId
    )
    const validation = await this.validateFeature(input.projectId, input.featureSlug)
    if (!validation.valid) throw new ImFeatureBindingError(validation.message)

    const title = defaultThreadTitle()
    const thread = await this.dependencies.createThread({
      title,
      workspacePath: validation.workspacePath,
      ...(input.agentMode ? { agentMode: input.agentMode } : {}),
      targetKind: "feature",
      remoteThread: true,
      remoteReadOnly: false,
      remoteState: "active",
      harnessFeature: {
        projectId: input.projectId,
        slug: input.featureSlug,
        source: HARNESS_SOURCE
      },
      imDeliveryContext: {
        provider: DEFAULT_IM_CHANNEL_ID,
        principalId: input.principalId,
        conversationKey: input.conversationKey,
        targetId: input.targetId
      }
    })
    return {
      threadId: thread.thread_id,
      agentMode: getAgentModeFromMetadata(thread.metadata ?? {}),
      title,
      workspacePath: validation.workspacePath,
      projectId: input.projectId,
      featureSlug: input.featureSlug,
      projectName: validation.project.name,
      featureTitle: validation.feature.title
    }
  }
}

export const imFeatureBindingService = new ImFeatureBindingService()

export function validateImExistingFeatureThread(
  metadata: Record<string, unknown>,
  workspacePath: string,
  service: ImFeatureBindingService = imFeatureBindingService
): Promise<ImFeatureValidationResult> {
  return service.validateExistingFeatureThread(metadata, workspacePath)
}

export async function validateImFeatureTarget(
  target: Extract<ImTargetSnapshot, { kind: "feature" }>,
  metadata: Record<string, unknown>,
  service: ImFeatureBindingService = imFeatureBindingService
): Promise<ImFeatureValidationResult> {
  const harness = metadata.harnessFeature
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
    return {
      valid: false,
      reasonCode: "REMOTE_THREAD_METADATA_MISMATCH",
      message: "远程 Feature Thread 元数据不完整。"
    }
  }
  const feature = harness as Record<string, unknown>
  if (feature.projectId !== target.projectId || feature.slug !== target.featureSlug) {
    return {
      valid: false,
      reasonCode: "REMOTE_THREAD_METADATA_MISMATCH",
      message: "远程 Feature Thread 与 binding 不一致。"
    }
  }
  const validation = await service.validateFeature(target.projectId, target.featureSlug)
  if (!validation.valid) return validation
  if (existingDirectory(target.workspacePath) !== validation.workspacePath) {
    return {
      valid: false,
      reasonCode: "REMOTE_WORKSPACE_UNAVAILABLE",
      message: "Feature 工作区已变化，请重新绑定。"
    }
  }
  return validation
}
