import {
  projectHarnessNotification,
  type ManagedBizRetryChoice
} from "../../shared/harness-notifications"
import type { ManagedBizRetryDecisionInput } from "./notification-operation-types"
import { randomUUID } from "node:crypto"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import type { AppDecisionResult, AppNotification } from "../../shared/app-notifications"
import type {
  ManagedRunEvent,
  ManagedRunPolicyResult,
  ManagedRunSessionAction,
  ManagedRunSnapshot
} from "../../shared/harness-board-types"
import { harnessNotifications } from "./notifications"
import { onNotificationChanged } from "../services/notification-service"
import { registerNotificationActions } from "../services/notification-actions"
import { managedRunStore } from "./managed-run-store"
import {
  invalidateNotificationProjection,
  registerNotificationVisibility
} from "../services/notification-read-model"

type ResolveBizRetry = (input: ManagedBizRetryDecisionInput) => Promise<AppDecisionResult>
interface ManagedBizRetryRequest {
  run: ManagedRunSnapshot
  sourceEvent: Pick<ManagedRunEvent, "eventId" | "type">
  policyResult: Extract<ManagedRunPolicyResult, { type: "biz_retry" }>
  summary: string
  delivery: AgentRunDelivery
  stageName: string
  nextAction?: ManagedRunSessionAction
}
interface BizRetryExecution {
  sourceEvent: ManagedBizRetryRequest["sourceEvent"]
  delivery: AgentRunDelivery
  state: "pending" | "handling"
}

class ManagedBizRetryService {
  // Execution resources only; persisted message status stays in the notification read model.
  private readonly executionsById = new Map<string, BizRetryExecution>()
  private resolveBizRetry?: ResolveBizRetry

  initialize(resolve: ResolveBizRetry): void {
    if (this.resolveBizRetry) return
    this.resolveBizRetry = resolve
    registerNotificationVisibility("biz_retry", (notification) => this.isLiveDecision(notification))
    onNotificationChanged((notification, change) => {
      // publish() signals the read-model change after source listeners release execution resources.
      if (change === "ended") this.executionsById.delete(notification.notificationId)
    })
    registerNotificationActions("biz_retry", async (_notification, input, origin) => {
      const context = origin.context as
        | {
            delivery?: AgentRunDelivery
            route?: { principalId: string; conversationKey: string }
          }
        | undefined
      return this.resolveDecision({
        notificationId: input.notificationId,
        choice: input.action as ManagedBizRetryChoice,
        message: input.message,
        channel: origin.channel,
        delivery: context?.delivery,
        route: context?.route
      })
    })
  }

  /** Shared by the input guard and APP projection; stale persistence cannot keep input blocked. */
  isLiveDecision(value: AppNotification): boolean {
    const notification = projectHarnessNotification(value)
    if (notification?.type !== "biz_retry" || notification.status !== "pending") return false
    const pending = this.executionsById.get(notification.notificationId)
    // A decision can be between saving a terminal/new-session snapshot and returning its result.
    if (pending?.state === "handling") return true
    if (pending && notification.runId) {
      try {
        const record = managedRunStore.getRun({
          projectId: notification.projectId,
          featureId: notification.featureId,
          runId: notification.runId
        })
        if (record.snapshot?.status === "running" && !record.corrupt) return true
      } catch (error) {
        // An unavailable read is not proof that a live decision has ended.
        console.warn("[Decision] Failed to inspect Biz Retry run:", error)
        return true
      }
    }
    return false
  }

  /** Explicit reconciliation at decision boundaries; read projections never mutate storage. */
  reconcileDecision(notificationId: string): void {
    try {
      const notification = harnessNotifications.get(notificationId)
      if (
        notification?.type !== "biz_retry" ||
        notification.status !== "pending" ||
        this.isLiveDecision(notification)
      )
        return
      this.removeNotification(notificationId)
      harnessNotifications.finish(notificationId, {
        status: "invalidated",
        channel: "system",
        reasonCode: "biz_retry_unavailable",
        result: "托管决策已中断或运行已结束"
      })
    } catch (error) {
      console.warn("[Decision] Failed to clean up unavailable Biz Retry:", error)
    }
  }

  blocksThread(threadId: string): boolean {
    return harnessNotifications
      .pending()
      .some(
        (notification) =>
          notification.sourceThreadId === threadId && this.isLiveDecision(notification)
      )
  }

  request(input: ManagedBizRetryRequest): boolean {
    const originThreadId = input.run.currentSession?.threadId
    if (!originThreadId) return false
    if (
      input.run.status !== "running" ||
      ![
        input.run.projectId,
        input.run.featureId,
        input.run.runId,
        originThreadId,
        input.stageName,
        input.summary,
        input.sourceEvent.eventId,
        input.policyResult.reasonCode
      ].every((value) => typeof value === "string" && value.trim()) ||
      input.policyResult.type !== "biz_retry" ||
      !["continue_current_thread", "start_new_thread"].includes(input.policyResult.proposedAction)
    ) {
      throw new Error("Biz Retry 消息源上下文无效")
    }
    // Replacement is scoped to a single waiting decision, never to unrelated gates.
    for (const value of harnessNotifications.pending()) {
      if (value.type === "biz_retry" && value.runId === input.run.runId) {
        harnessNotifications.finish(value.notificationId, {
          status: "invalidated",
          channel: "system",
          reasonCode: "decision_replaced",
          result: "已产生新的托管决策"
        })
      }
    }
    const decisionId = randomUUID()
    const pending: BizRetryExecution = {
      sourceEvent: input.sourceEvent,
      delivery: input.delivery,
      state: "pending"
    }
    this.executionsById.set(decisionId, pending)
    try {
      harnessNotifications.create({
        notificationId: decisionId,
        kind: "decision",
        type: "biz_retry",
        projectId: input.run.projectId,
        featureId: input.run.featureId,
        runId: input.run.runId,
        sourceThreadId: originThreadId,
        nodeId: input.stageName,
        targets: ["app_view", "im", "system_notification"],
        title: "托管运行需要人工确认",
        message: input.summary,
        policyResult: input.policyResult,
        bizRetry: { nextAction: input.nextAction }
      })
    } catch (error) {
      this.executionsById.delete(decisionId)
      throw error
    }
    return true
  }
  async resolveDecision(input: {
    notificationId: string
    choice: ManagedBizRetryChoice
    message?: string
    channel: "desktop" | "im"
    delivery?: AgentRunDelivery
    route?: { principalId: string; conversationKey: string }
  }): Promise<AppDecisionResult> {
    if (
      !["stop", "continue", "new_thread"].includes(input.choice) ||
      (input.message !== undefined &&
        (typeof input.message !== "string" || input.message.length > 10000))
    ) {
      return { applied: false, message: "决策参数无效" }
    }
    const pending = this.executionsById.get(input.notificationId)
    const notification = harnessNotifications.get(input.notificationId)
    if (
      !pending ||
      notification?.status !== "pending" ||
      notification.type !== "biz_retry" ||
      !notification.runId ||
      notification.policyResult?.type !== "biz_retry"
    ) {
      this.reconcileDecision(input.notificationId)
      return { applied: false, message: "该决策已处理或已中断，请刷新后查看。" }
    }
    if (pending.state !== "pending") return { applied: false, message: "该决策正在处理，请稍后。" }
    pending.state = "handling"
    try {
      if (!this.resolveBizRetry) throw new Error("Biz Retry source is not initialized")
      const result = await this.resolveBizRetry({
        decisionId: input.notificationId,
        projectId: notification.projectId,
        featureId: notification.featureId,
        runId: notification.runId,
        originThreadId: notification.sourceThreadId,
        policyResult: notification.policyResult,
        sourceEvent: pending.sourceEvent,
        summary: notification.message,
        delivery: input.delivery ?? pending.delivery,
        choice: input.choice,
        message: input.message,
        channel: input.channel,
        route: input.route
      })
      if (result.applied) this.removeNotification(input.notificationId)
      return result
    } catch (error) {
      console.warn("[Decision] Managed Biz Retry action failed:", error)
      if (!this.executionsById.has(input.notificationId)) {
        return { applied: false, message: "该决策已结束，请检查已有会话和托管状态，不要重复执行。" }
      }
      if (harnessNotifications.get(input.notificationId)?.status === "resolved") {
        this.removeNotification(input.notificationId)
        return { applied: true, message: "操作已执行，但后续记录失败，请查看托管状态。" }
      }
      return { applied: false, message: "托管操作未完成，可重试或选择退出托管。" }
    } finally {
      if (this.executionsById.get(input.notificationId) === pending) {
        pending.state = "pending"
        this.reconcileDecision(input.notificationId)
      }
    }
  }

  removeNotification(notificationId: string): void {
    if (this.executionsById.delete(notificationId)) invalidateNotificationProjection(notificationId)
  }

  removeRunNotifications(runId: string, exceptId?: string): void {
    for (const notification of harnessNotifications.pending()) {
      if (
        notification.type === "biz_retry" &&
        notification.runId === runId &&
        notification.notificationId !== exceptId
      ) {
        this.removeNotification(notification.notificationId)
      }
    }
  }
}
export const managedBizRetryService = new ManagedBizRetryService()
export function initializeBizRetrySource(resolve: ResolveBizRetry): void {
  managedBizRetryService.initialize(resolve)
}
