import { randomUUID } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { HARNESS_SOURCE, type HarnessFeatureSummary } from "../../../shared/harness-board-types"
import { DEFAULT_IM_CHANNEL_ID } from "../../../shared/im-gateway-contract"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { getThread, createThread, deleteThread, updateThread, type ThreadRow } from "../../db"
import { isFeatureGateEnabled } from "../../feature-gates"
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
  createThread: typeof createThread
  deleteThread: typeof deleteThread
  updateThread: typeof updateThread
  createId: () => string
  getRunLease: typeof getLocalThreadRunLease
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
  return settings.enabled && settings.remoteAccess === "inbox-and-features"
}

function bindingMetadataMatches(
  thread: ThreadRow,
  target: Extract<ImTargetSnapshot, { kind: "feature" }>,
  conversationKey: string,
  deviceEpoch: number
): boolean {
  const parsed = parseStandardThreadMetadata(thread.metadata)
  const harness = parsed.metadata.harnessFeature
  const delivery = parsed.metadata.imDeliveryContext
  if (
    !harness ||
    typeof harness !== "object" ||
    Array.isArray(harness) ||
    !delivery ||
    typeof delivery !== "object" ||
    Array.isArray(delivery)
  ) {
    return false
  }
  const feature = harness as Record<string, unknown>
  const context = delivery as Record<string, unknown>
  return (
    feature.projectId === target.projectId &&
    feature.slug === target.featureSlug &&
    context.provider === DEFAULT_IM_CHANNEL_ID &&
    context.conversationKey === conversationKey &&
    context.deviceEpoch === deviceEpoch &&
    context.targetId === target.targetId &&
    context.bindingId === target.bindingId &&
    existingDirectory(parsed.workspacePath) === existingDirectory(target.workspacePath)
  )
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
      createThread: dependencies.createThread ?? createThread,
      deleteThread: dependencies.deleteThread ?? deleteThread,
      updateThread: dependencies.updateThread ?? updateThread,
      createId: dependencies.createId ?? randomUUID,
      getRunLease: dependencies.getRunLease ?? getLocalThreadRunLease
    }
  }

  async listRemoteProjects(): Promise<ImRemoteProjectListItem[]> {
    if (
      !settingsAllowFeatures(this.dependencies) ||
      !(await this.dependencies.projectModeEnabled())
    ) {
      return []
    }
    return this.dependencies
      .listProjects()
      .filter(
        (project) =>
          project.lifecycle.status === "active" && project.boardCompatibility.compatible === true
      )
      .map((project) => ({ id: project.projectId, name: project.name.trim() || project.projectId }))
  }

  async listRemoteFeatures(projectId: string): Promise<ImRemoteFeatureListItem[]> {
    const projects = await this.listRemoteProjects()
    if (!projects.some((project) => project.id === projectId)) return []
    const detail = this.dependencies.getProjectDetail(projectId)
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

    const project = this.dependencies
      .listProjects()
      .find((candidate) => candidate.projectId === projectId)
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

    let detail: ReturnType<typeof getHarnessProjectDetail>
    let runDetail: ReturnType<typeof getHarnessRunDetail>
    try {
      detail = this.dependencies.getProjectDetail(projectId)
      runDetail = this.dependencies.getRunDetail(projectId, featureSlug)
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

    const harnessContext = this.dependencies.buildFeatureContext(
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

  async bindFeature(input: {
    conversationKey: string
    principalId: string
    deviceEpoch: number
    projectId: string
    featureSlug: string
  }): Promise<Extract<ImTargetSnapshot, { kind: "feature" }>> {
    this.dependencies.conversationState.assertCurrentRoute(
      input.conversationKey,
      input.principalId,
      input.deviceEpoch
    )
    const validation = await this.validateFeature(input.projectId, input.featureSlug)
    if (!validation.valid) throw new ImFeatureBindingError(validation.message)

    const reusable = this.dependencies.conversationState
      .listTargets(input.conversationKey)
      .find(
        (candidate) =>
          candidate.state !== "revoked" &&
          candidate.snapshot.kind === "feature" &&
          candidate.snapshot.projectId === input.projectId &&
          candidate.snapshot.featureSlug === input.featureSlug
      )
    if (reusable?.snapshot.kind === "feature") {
      const thread = this.dependencies.getThread(reusable.snapshot.threadId)
      const runLease = this.dependencies.getRunLease(reusable.snapshot.threadId)
      if (runLease) {
        throw new ImFeatureBindingError(
          runLease.owner === "desktop"
            ? "该 Feature Thread 正在桌面执行，请结束后再绑定。"
            : "该 Feature Thread 正在执行，请结束后再绑定。"
        )
      }
      if (
        thread &&
        bindingMetadataMatches(
          thread,
          reusable.snapshot,
          input.conversationKey,
          input.deviceEpoch
        ) &&
        existingDirectory(reusable.snapshot.workspacePath) === validation.workspacePath
      ) {
        await this.dependencies.conversationState.updateTargetState(
          reusable.snapshot.targetId,
          "active"
        )
        this.dependencies.updateThread(reusable.snapshot.threadId, {
          metadata: JSON.stringify({
            ...parseStandardThreadMetadata(thread.metadata).metadata,
            remoteState: "active"
          })
        })
        await this.dependencies.conversationState.setActiveTarget(
          input.conversationKey,
          reusable.snapshot.targetId
        )
        return reusable.snapshot
      }
      await this.dependencies.conversationState.updateTargetState(
        reusable.snapshot.targetId,
        "suspended",
        "Feature Thread or workspace no longer matches"
      )
    }

    const bindingId = this.dependencies.createId()
    const targetId = this.dependencies.createId()
    const threadId = this.dependencies.createId()
    const target: Extract<ImTargetSnapshot, { kind: "feature" }> = {
      kind: "feature",
      targetId,
      bindingId,
      projectId: input.projectId,
      featureSlug: input.featureSlug,
      projectName: validation.project.name,
      featureTitle: validation.feature.title,
      threadId,
      workspacePath: validation.workspacePath
    }
    this.dependencies.createThread(threadId, {
      title: `[远程 Feature] ${validation.project.name} / ${validation.feature.title}`,
      workspacePath: validation.workspacePath,
      agentMode: "normal",
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
        conversationKey: input.conversationKey,
        deviceEpoch: input.deviceEpoch,
        targetId,
        bindingId
      }
    })
    try {
      await this.dependencies.conversationState.registerTarget(input.conversationKey, target, {
        state: "active",
        activate: true
      })
      return target
    } catch (error) {
      this.dependencies.deleteThread(threadId)
      throw error
    }
  }
}

export const imFeatureBindingService = new ImFeatureBindingService()

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
