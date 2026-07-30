import { randomUUID } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { coordinatorWorkerManager } from "../../agent/coordinator-worker-manager"
import { SqlGoalStore } from "../../agent/goals/goal-store"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import {
  parseStandardThreadMetadata,
  type StandardThreadMetadata
} from "../../agent/standard-thread-turn"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { getThread, type ThreadRow } from "../../db"
import { hasPendingUserInputForThread } from "../user-input"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import { imFeatureBindingService, type ImFeatureBindingService } from "./feature-binding-service"
import {
  imRemoteGrantStore,
  type ImFeatureGrantRecord,
  type ImGrantRouteIdentity,
  type ImRemoteGrantStore,
  type ImThreadGrantRecord
} from "./remote-grant-store"

export type ImAuthorizedRemoteTarget =
  | {
      kind: "thread_grant"
      grantId: string
      grantVersion: number
      label: string
      threadId: string
    }
  | {
      kind: "feature_grant"
      grantId: string
      grantVersion: number
      label: string
      projectId: string
      featureSlug: string
      existingThreadId?: string
    }

export class ImRemoteAccessError extends Error {
  constructor(
    readonly code:
      | "REMOTE_ROUTE_UNAVAILABLE"
      | "REMOTE_THREAD_UNAVAILABLE"
      | "REMOTE_THREAD_UNSUPPORTED"
      | "REMOTE_FEATURE_UNAVAILABLE"
      | "REMOTE_GRANT_STALE",
    message: string
  ) {
    super(message)
    this.name = "ImRemoteAccessError"
  }
}

interface RemoteAccessDependencies {
  conversations: ImConversationStateStore
  grants: ImRemoteGrantStore
  features: ImFeatureBindingService
  getThread: typeof getThread
  createId: () => string
  getGoal: (threadId: string) => { status: string } | null
  coordinator: Pick<
    typeof coordinatorWorkerManager,
    | "hasRunningWorkersForThread"
    | "hasNotifications"
    | "hasTerminalWorkerAwaitingNotificationForThread"
  >
  workflow: Pick<typeof workflowRunManager, "isBusyForThread">
  hasPendingApproval: (threadId: string) => boolean
  hasPendingUserInput: (threadId: string) => boolean
}

function existingDirectory(path: string | undefined): string | null {
  const normalized = path?.trim()
  if (!normalized || !isAbsolute(normalized) || !existsSync(normalized)) return null
  try {
    if (!statSync(normalized).isDirectory()) return null
    return realpathSync(normalized)
  } catch {
    return null
  }
}

function targetRouteMatches(
  route: ImGrantRouteIdentity,
  grant: ImThreadGrantRecord | ImFeatureGrantRecord
): boolean {
  return (
    grant.principalId === route.principalId &&
    grant.conversationKey === route.conversationKey &&
    grant.deviceEpoch === route.deviceEpoch
  )
}

const goalStore = new SqlGoalStore()

export class ImRemoteAccessService {
  private readonly dependencies: RemoteAccessDependencies

  constructor(dependencies: Partial<RemoteAccessDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      grants: dependencies.grants ?? imRemoteGrantStore,
      features: dependencies.features ?? imFeatureBindingService,
      getThread: dependencies.getThread ?? getThread,
      createId: dependencies.createId ?? randomUUID,
      getGoal: dependencies.getGoal ?? ((threadId) => goalStore.get(threadId)),
      coordinator: dependencies.coordinator ?? coordinatorWorkerManager,
      workflow: dependencies.workflow ?? workflowRunManager,
      hasPendingApproval: dependencies.hasPendingApproval ?? hasPendingApprovalForRuntimeThread,
      hasPendingUserInput: dependencies.hasPendingUserInput ?? hasPendingUserInputForThread
    }
  }

  async enableThread(input: {
    route: ImGrantRouteIdentity
    threadId: string
  }): Promise<ImThreadGrantRecord> {
    await this.dependencies.conversations.ensureConversation(input.route)
    const validation = this.validateGrantableThread(input.threadId)
    return this.dependencies.grants.enableThreadGrant({
      route: input.route,
      threadId: validation.thread.thread_id,
      title: validation.thread.title?.trim() || `会话 ${validation.thread.thread_id.slice(0, 8)}`
    })
  }

  async disableThread(threadId: string): Promise<ImThreadGrantRecord | null> {
    const grant = await this.dependencies.grants.revokeThreadGrant(threadId)
    if (grant) await this.suspendTargetsForGrant(grant.grantId, "REMOTE_GRANT_REVOKED")
    return grant
  }

  async enableFeature(input: {
    route: ImGrantRouteIdentity
    projectId: string
    featureSlug: string
  }): Promise<ImFeatureGrantRecord> {
    await this.dependencies.conversations.ensureConversation(input.route)
    const validation = await this.dependencies.features.validateFeature(
      input.projectId,
      input.featureSlug
    )
    if (!validation.valid) {
      throw new ImRemoteAccessError("REMOTE_FEATURE_UNAVAILABLE", validation.message)
    }
    return this.dependencies.grants.enableFeatureGrant({
      route: input.route,
      projectId: input.projectId,
      featureSlug: input.featureSlug,
      projectName: validation.project.name,
      featureTitle: validation.feature.title
    })
  }

  async disableFeature(
    projectId: string,
    featureSlug: string
  ): Promise<ImFeatureGrantRecord | null> {
    const grant = await this.dependencies.grants.revokeFeatureGrant(projectId, featureSlug)
    if (grant) await this.suspendTargetsForGrant(grant.grantId, "REMOTE_GRANT_REVOKED")
    return grant
  }

  async listAuthorizedTargets(route: ImGrantRouteIdentity): Promise<ImAuthorizedRemoteTarget[]> {
    this.dependencies.conversations.assertCurrentRoute(
      route.conversationKey,
      route.principalId,
      route.deviceEpoch
    )
    const targets: ImAuthorizedRemoteTarget[] = []
    for (const grant of this.dependencies.grants.listThreadGrants(route.conversationKey)) {
      if (grant.state !== "active" || !targetRouteMatches(route, grant)) continue
      try {
        this.validateGrantableThread(grant.threadId)
      } catch {
        continue
      }
      targets.push({
        kind: "thread_grant",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        label: grant.titleSnapshot,
        threadId: grant.threadId
      })
    }
    for (const grant of this.dependencies.grants.listFeatureGrants(route.conversationKey)) {
      if (grant.state !== "active" || !targetRouteMatches(route, grant)) continue
      const existing = this.dependencies.conversations
        .listTargets(route.conversationKey)
        .find(
          ({ snapshot, state }) =>
            state === "active" &&
            snapshot.kind === "feature" &&
            snapshot.grantId === grant.grantId &&
            snapshot.projectId === grant.projectId &&
            snapshot.featureSlug === grant.featureSlug &&
            Boolean(this.dependencies.getThread(snapshot.threadId))
        )
      targets.push({
        kind: "feature_grant",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        label: `${grant.projectNameSnapshot} / ${grant.featureTitleSnapshot}`,
        projectId: grant.projectId,
        featureSlug: grant.featureSlug,
        ...(existing ? { existingThreadId: existing.snapshot.threadId } : {})
      })
    }
    return targets.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"))
  }

  async bindThreadGrant(input: {
    route: ImGrantRouteIdentity
    grantId: string
    grantVersion: number
  }): Promise<Extract<ImTargetSnapshot, { kind: "thread" }>> {
    const grant = this.dependencies.grants.getThreadGrantById(input.grantId)
    if (!grant || grant.grantVersion !== input.grantVersion || grant.state !== "active") {
      throw new ImRemoteAccessError("REMOTE_GRANT_STALE", "会话授权已变化，请重新发送 /会话。")
    }
    this.dependencies.grants.assertActiveThreadGrant({
      grantId: input.grantId,
      grantVersion: input.grantVersion,
      route: input.route,
      threadId: grant.threadId
    })
    const validation = this.validateGrantableThread(grant.threadId)
    const reusable = this.dependencies.conversations
      .listTargets(input.route.conversationKey)
      .find(
        ({ snapshot }) =>
          snapshot.kind === "thread" &&
          snapshot.grantId === grant.grantId &&
          snapshot.threadId === grant.threadId
      )
    if (reusable?.snapshot.kind === "thread") {
      return (await this.dependencies.conversations.refreshGrantTarget({
        targetId: reusable.snapshot.targetId,
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        workspacePath: validation.workspacePath,
        title: grant.titleSnapshot,
        activate: true
      })) as Extract<ImTargetSnapshot, { kind: "thread" }>
    }
    const target: Extract<ImTargetSnapshot, { kind: "thread" }> = {
      kind: "thread",
      targetId: this.dependencies.createId(),
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      threadId: grant.threadId,
      title: grant.titleSnapshot,
      workspacePath: validation.workspacePath
    }
    await this.dependencies.conversations.registerTarget(input.route.conversationKey, target, {
      state: "active",
      activate: true
    })
    return target
  }

  async bindFeatureGrant(input: {
    route: ImGrantRouteIdentity
    grantId: string
    grantVersion: number
  }): Promise<Extract<ImTargetSnapshot, { kind: "feature" }>> {
    const grant = this.dependencies.grants.getFeatureGrantById(input.grantId)
    if (!grant || grant.grantVersion !== input.grantVersion || grant.state !== "active") {
      throw new ImRemoteAccessError("REMOTE_GRANT_STALE", "Feature 授权已变化，请重新发送 /会话。")
    }
    this.dependencies.grants.assertActiveFeatureGrant({
      grantId: input.grantId,
      grantVersion: input.grantVersion,
      route: input.route,
      projectId: grant.projectId,
      featureSlug: grant.featureSlug
    })
    return this.dependencies.features.bindFeature({
      ...input.route,
      projectId: grant.projectId,
      featureSlug: grant.featureSlug,
      grantId: grant.grantId,
      grantVersion: grant.grantVersion
    })
  }

  getThreadGrant(threadId: string): ImThreadGrantRecord | null {
    return this.dependencies.grants.getThreadGrant(threadId)
  }

  getFeatureGrant(projectId: string, featureSlug: string): ImFeatureGrantRecord | null {
    return this.dependencies.grants.getFeatureGrant(projectId, featureSlug)
  }

  listThreadGrants(): ImThreadGrantRecord[] {
    return this.dependencies.grants.listThreadGrants()
  }

  listFeatureGrants(): ImFeatureGrantRecord[] {
    return this.dependencies.grants.listFeatureGrants()
  }

  validateThreadForRemoteAccess(threadId: string): {
    thread: ThreadRow
    workspacePath: string
  } {
    return this.validateGrantableThread(threadId)
  }

  validateThreadForCompletionDelivery(threadId: string): {
    thread: ThreadRow
    workspacePath: string
  } {
    const { thread, workspacePath } = this.validateThreadStructure(threadId)
    return { thread, workspacePath }
  }

  async suspendRoute(
    conversationKey: string,
    expectedDeviceEpoch: number,
    reasonCode = "ROUTE_TAKEOVER"
  ): Promise<void> {
    await this.dependencies.grants.suspendRouteGrants(
      conversationKey,
      expectedDeviceEpoch,
      reasonCode
    )
  }

  private validateGrantableThread(threadId: string): {
    thread: ThreadRow
    workspacePath: string
  } {
    const { thread, workspacePath, parsed } = this.validateThreadStructure(threadId)
    if (parsed.agentMode !== "normal") {
      throw new ImRemoteAccessError(
        "REMOTE_THREAD_UNSUPPORTED",
        "第一阶段只支持桌面创建的普通 Agent 会话。"
      )
    }
    const goal = this.dependencies.getGoal(threadId)
    if (
      (goal && goal.status !== "complete") ||
      this.dependencies.coordinator.hasRunningWorkersForThread(threadId) ||
      this.dependencies.coordinator.hasNotifications(threadId) ||
      this.dependencies.coordinator.hasTerminalWorkerAwaitingNotificationForThread(threadId) ||
      this.dependencies.workflow.isBusyForThread(threadId, workspacePath) ||
      this.dependencies.hasPendingApproval(threadId) ||
      this.dependencies.hasPendingUserInput(threadId)
    ) {
      throw new ImRemoteAccessError(
        "REMOTE_THREAD_UNSUPPORTED",
        "会话仍有高级模式任务或桌面交互待处理，暂不能接入招乎。"
      )
    }
    return { thread, workspacePath }
  }

  private validateThreadStructure(threadId: string): {
    thread: ThreadRow
    workspacePath: string
    parsed: StandardThreadMetadata
  } {
    const thread = this.dependencies.getThread(threadId)
    if (!thread) {
      throw new ImRemoteAccessError("REMOTE_THREAD_UNAVAILABLE", "会话不存在或已删除。")
    }
    const parsed = parseStandardThreadMetadata(thread.metadata)
    const workspacePath = existingDirectory(parsed.workspacePath)
    if (!workspacePath) {
      throw new ImRemoteAccessError("REMOTE_THREAD_UNAVAILABLE", "会话工作区不可用。")
    }
    if (parsed.metadata.targetKind === "inbox" || parsed.metadata.remoteThread === true) {
      throw new ImRemoteAccessError(
        "REMOTE_THREAD_UNSUPPORTED",
        "远程收件箱或 IM 创建的会话不能作为桌面会话授权目标。"
      )
    }
    return { thread, workspacePath, parsed }
  }

  private async suspendTargetsForGrant(grantId: string, reasonCode: string): Promise<void> {
    for (const conversation of this.dependencies.conversations.listConversations()) {
      for (const target of this.dependencies.conversations.listTargets(
        conversation.conversationKey
      )) {
        if (
          target.snapshot.kind !== "inbox" &&
          target.snapshot.grantId === grantId &&
          target.state !== "revoked"
        ) {
          await this.dependencies.conversations.updateTargetState(
            target.snapshot.targetId,
            "suspended",
            reasonCode
          )
        }
      }
    }
  }
}

export const imRemoteAccessService = new ImRemoteAccessService()
