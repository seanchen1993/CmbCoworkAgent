import { existsSync, realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_IM_CHANNEL_ID } from "../../../shared/im-gateway-contract"
import { coordinatorWorkerManager } from "../../agent/coordinator-worker-manager"
import { SqlGoalStore } from "../../agent/goals/goal-store"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { getThread, updateThread, type ThreadRow } from "../../db"
import { hasPendingUserInputForThread } from "../user-input"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import type { ImEventRecord } from "./event-store"
import { validateImFeatureTarget } from "./feature-binding-service"
import {
  ImRemoteGrantError,
  imRemoteGrantStore,
  type ImRemoteGrantStore
} from "./remote-grant-store"

export type ImRemoteCapabilityReason =
  | "REMOTE_TARGET_INVALID"
  | "REMOTE_THREAD_MISSING"
  | "REMOTE_THREAD_METADATA_MISMATCH"
  | "REMOTE_AGENT_MODE_UNSUPPORTED"
  | "REMOTE_GOAL_UNSUPPORTED"
  | "REMOTE_COORDINATOR_UNSUPPORTED"
  | "REMOTE_WORKFLOW_UNSUPPORTED"
  | "REMOTE_INTERNAL_NOTIFICATION_PENDING"
  | "REMOTE_INTERACTION_PENDING"
  | "REMOTE_FEATURE_ACCESS_DISABLED"
  | "REMOTE_PROJECT_MODE_DISABLED"
  | "REMOTE_PROJECT_UNAVAILABLE"
  | "REMOTE_PROJECT_DIRECTORY_UNAVAILABLE"
  | "REMOTE_FEATURE_UNAVAILABLE"
  | "REMOTE_WORKSPACE_UNAVAILABLE"
  | "REMOTE_HARNESS_CONTEXT_UNAVAILABLE"
  | "REMOTE_GRANT_INVALID"

export type ImRemoteCapabilityDecision =
  | {
      allowed: true
      thread: ThreadRow
      metadata: Record<string, unknown>
      workspacePath: string
      target: ImTargetSnapshot
    }
  | { allowed: false; reasonCode: ImRemoteCapabilityReason; message: string }

export interface ImRemoteCapabilityGuardDependencies {
  conversationState: ImConversationStateStore
  getThread: typeof getThread
  updateThread?: typeof updateThread
  getGoal: (threadId: string) => { status: string } | null
  coordinator: {
    hasRunningWorkersForThread(threadId: string): boolean
    hasNotifications(threadId: string): boolean
    hasTerminalWorkerAwaitingNotificationForThread(threadId: string): boolean
  }
  workflow: {
    isBusyForThread(threadId: string, workspacePath: string | undefined): boolean
  }
  hasPendingApproval(threadId: string): boolean
  hasPendingUserInput(threadId: string): boolean
  validateFeatureTarget?: typeof validateImFeatureTarget
  grants: ImRemoteGrantStore
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function existingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function sameSnapshot(left: ImTargetSnapshot, right: ImTargetSnapshot): boolean {
  return (
    left.kind === right.kind &&
    left.targetId === right.targetId &&
    left.threadId === right.threadId &&
    canonicalPath(left.workspacePath) === canonicalPath(right.workspacePath) &&
    (left.kind === "inbox" ||
      (left.kind === "thread" && right.kind === "thread"
        ? left.grantId === right.grantId &&
          left.grantVersion === right.grantVersion &&
          left.title === right.title
        : left.kind === "feature" &&
          right.kind === "feature" &&
          left.bindingId === right.bindingId &&
          left.grantId === right.grantId &&
          left.grantVersion === right.grantVersion &&
          left.projectId === right.projectId &&
          left.featureSlug === right.featureSlug))
  )
}

function metadataMatchesTarget(
  metadata: Record<string, unknown>,
  target: ImTargetSnapshot,
  event: Pick<ImEventRecord, "conversationKey" | "principalId">
): boolean {
  if (canonicalPath(String(metadata.workspacePath ?? "")) !== canonicalPath(target.workspacePath)) {
    return false
  }
  if (target.kind === "thread") return true
  const delivery = metadata.imDeliveryContext
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return false
  const context = delivery as Record<string, unknown>
  if (
    context.provider !== DEFAULT_IM_CHANNEL_ID ||
    context.principalId !== event.principalId ||
    context.targetId !== target.targetId ||
    context.conversationKey !== event.conversationKey ||
    (target.kind === "feature" && context.bindingId !== target.bindingId)
  ) {
    return false
  }
  if (target.kind === "inbox") return metadata.targetKind === "inbox"
  const harnessFeature = metadata.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object" || Array.isArray(harnessFeature)) {
    return false
  }
  const binding = harnessFeature as Record<string, unknown>
  return binding.projectId === target.projectId && binding.slug === target.featureSlug
}

const defaultGoalStore = new SqlGoalStore()

export class ImRemoteCapabilityGuard {
  constructor(
    private readonly dependencies: ImRemoteCapabilityGuardDependencies = {
      conversationState: imConversationStateStore,
      getThread,
      getGoal: (threadId) => defaultGoalStore.get(threadId),
      coordinator: coordinatorWorkerManager,
      workflow: workflowRunManager,
      hasPendingApproval: hasPendingApprovalForRuntimeThread,
      hasPendingUserInput: hasPendingUserInputForThread,
      grants: imRemoteGrantStore
    }
  ) {}

  async evaluate(event: ImEventRecord): Promise<ImRemoteCapabilityDecision> {
    const snapshot = event.targetSnapshot
    if (!snapshot) {
      return {
        allowed: false,
        reasonCode: "REMOTE_TARGET_INVALID",
        message: "消息没有可执行的目标，请重新发送。"
      }
    }
    this.dependencies.conversationState.assertConversationOwner(
      event.conversationKey,
      event.principalId
    )
    const storedTarget = this.dependencies.conversationState
      .listTargets(event.conversationKey)
      .find(({ snapshot: candidate }) => candidate.targetId === snapshot.targetId)
    if (
      !storedTarget ||
      storedTarget.state !== "active" ||
      !sameSnapshot(storedTarget.snapshot, snapshot)
    ) {
      return {
        allowed: false,
        reasonCode: "REMOTE_TARGET_INVALID",
        message: "该远程目标已失效，请在招乎中重新选择目标。"
      }
    }

    try {
      const route = {
        principalId: event.principalId,
        conversationKey: event.conversationKey
      }
      if (snapshot.kind === "thread") {
        this.dependencies.grants.assertActiveThreadGrant({
          grantId: snapshot.grantId,
          grantVersion: snapshot.grantVersion,
          route,
          threadId: snapshot.threadId
        })
      } else if (snapshot.kind === "feature") {
        if (!snapshot.grantId || !snapshot.grantVersion) {
          throw new ImRemoteGrantError("GRANT_NOT_FOUND", "Legacy Feature target has no grant")
        }
        this.dependencies.grants.assertActiveFeatureGrant({
          grantId: snapshot.grantId,
          grantVersion: snapshot.grantVersion,
          route,
          projectId: snapshot.projectId,
          featureSlug: snapshot.featureSlug
        })
      }
    } catch (error) {
      if (!(error instanceof ImRemoteGrantError)) throw error
      return {
        allowed: false,
        reasonCode: "REMOTE_GRANT_INVALID",
        message: "该远程授权已撤销或发生变化，请在招乎中重新选择会话。"
      }
    }

    const thread = this.dependencies.getThread(snapshot.threadId)
    if (!thread) {
      return {
        allowed: false,
        reasonCode: "REMOTE_THREAD_MISSING",
        message: "远程会话已不存在，请重新绑定。"
      }
    }
    const parsed = parseStandardThreadMetadata(thread.metadata)
    if (
      snapshot.kind === "thread" &&
      (!parsed.workspacePath ||
        !existingDirectory(parsed.workspacePath) ||
        !existingDirectory(snapshot.workspacePath))
    ) {
      return {
        allowed: false,
        reasonCode: "REMOTE_WORKSPACE_UNAVAILABLE",
        message: "该会话的桌面工作区已不可用，请撤销授权后重新配置。"
      }
    }
    if (!parsed.workspacePath || !metadataMatchesTarget(parsed.metadata, snapshot, event)) {
      return {
        allowed: false,
        reasonCode: "REMOTE_THREAD_METADATA_MISMATCH",
        message: "远程会话上下文不一致，已阻止执行，请回到桌面检查。"
      }
    }
    if (
      snapshot.kind === "thread" &&
      (parsed.metadata.remoteThread === true || parsed.metadata.targetKind === "inbox")
    ) {
      return {
        allowed: false,
        reasonCode: "REMOTE_THREAD_METADATA_MISMATCH",
        message: "该授权目标已不再是桌面普通会话，请撤销授权后重新选择。"
      }
    }
    if (snapshot.kind === "feature") {
      const validation = await (this.dependencies.validateFeatureTarget ?? validateImFeatureTarget)(
        snapshot,
        parsed.metadata
      )
      if (!validation.valid) {
        if (snapshot.grantId) {
          await this.dependencies.grants.suspendGrant(
            "feature",
            snapshot.grantId,
            validation.reasonCode
          )
        }
        await this.dependencies.conversationState.updateTargetState(
          snapshot.targetId,
          "suspended",
          validation.reasonCode
        )
        const updateRemoteThread = this.dependencies.updateThread ?? updateThread
        updateRemoteThread(snapshot.threadId, {
          metadata: JSON.stringify({ ...parsed.metadata, remoteState: "suspended" })
        })
        return {
          allowed: false,
          reasonCode: validation.reasonCode as ImRemoteCapabilityReason,
          message: `${validation.message} Binding 已暂停，请修复后重新发送 /绑定。`
        }
      }
    }
    if (parsed.agentMode !== "normal") {
      return {
        allowed: false,
        reasonCode: "REMOTE_AGENT_MODE_UNSUPPORTED",
        message: "该会话不是普通 Agent 模式，请在桌面继续处理。"
      }
    }

    const goal = this.dependencies.getGoal(snapshot.threadId)
    if (goal && goal.status !== "complete") {
      return {
        allowed: false,
        reasonCode: "REMOTE_GOAL_UNSUPPORTED",
        message: "该会话存在进行中或暂停的 Goal，请在桌面继续处理。"
      }
    }
    if (this.dependencies.coordinator.hasRunningWorkersForThread(snapshot.threadId)) {
      return {
        allowed: false,
        reasonCode: "REMOTE_COORDINATOR_UNSUPPORTED",
        message: "该会话存在 Coordinator worker，请在桌面继续处理。"
      }
    }
    if (
      this.dependencies.coordinator.hasNotifications(snapshot.threadId) ||
      this.dependencies.coordinator.hasTerminalWorkerAwaitingNotificationForThread(
        snapshot.threadId
      )
    ) {
      return {
        allowed: false,
        reasonCode: "REMOTE_INTERNAL_NOTIFICATION_PENDING",
        message: "该会话有待处理的内部任务通知，请先在桌面处理。"
      }
    }
    if (this.dependencies.workflow.isBusyForThread(snapshot.threadId, parsed.workspacePath)) {
      return {
        allowed: false,
        reasonCode: "REMOTE_WORKFLOW_UNSUPPORTED",
        message: "该会话存在运行中或待报告的 Workflow，请在桌面继续处理。"
      }
    }
    if (
      this.dependencies.hasPendingApproval(snapshot.threadId) ||
      this.dependencies.hasPendingUserInput(snapshot.threadId)
    ) {
      return {
        allowed: false,
        reasonCode: "REMOTE_INTERACTION_PENDING",
        message: "该会话正在等待桌面审批或补充输入，请先在桌面处理。"
      }
    }

    return {
      allowed: true,
      thread,
      metadata: parsed.metadata,
      workspacePath: parsed.workspacePath,
      target: snapshot
    }
  }
}

export const imRemoteCapabilityGuard = new ImRemoteCapabilityGuard()
