import type { AppNotification, CreateAppNotificationInput } from "./app-notifications"
import type { HarnessHumanGateSnapshot, ManagedRunPolicyResult, ManagedRunSessionAction } from "./harness-board-types"

export interface HarnessNotificationPayload {
  projectId: string
  featureId: string
  sourceThreadId: string
  runId?: string
  nodeId?: string
  policyResult?: ManagedRunPolicyResult
  humanGate?: { hookId: string }
  bizRetry?: { nextAction?: ManagedRunSessionAction }
}
/** Domain-only read model. Common notification services never import this type. */
export type HarnessNotification = AppNotification & HarnessNotificationPayload
export type ManagedBizRetryChoice = "stop" | "continue" | "new_thread"
export type CreateHarnessNotification = Omit<CreateAppNotificationInput, "payload" | "type" | "kind"> &
  Omit<HarnessNotificationPayload, "humanGate" | "bizRetry" | "policyResult"> & { kind: "decision" } & (
    | { type: "human_gate"; humanGate: { hookId: string }; bizRetry?: never;
        policyResult: Extract<ManagedRunPolicyResult, { type: "human_gate" }> }
    | { type: "biz_retry"; humanGate?: never; bizRetry: { nextAction?: ManagedRunSessionAction };
        runId: string; nodeId: string;
        policyResult: Extract<ManagedRunPolicyResult, { type: "biz_retry" }> }
  )

export function projectHarnessNotification(value: AppNotification | undefined): HarnessNotification | undefined {
  if (!value || (value.type !== "human_gate" && value.type !== "biz_retry")) return undefined
  const data = value.payload as HarnessNotificationPayload | null
  if (!data || typeof data !== "object" || typeof data.projectId !== "string" ||
    typeof data.featureId !== "string" || typeof data.sourceThreadId !== "string") return undefined
  return {
    ...value,
    projectId: data.projectId,
    featureId: data.featureId,
    sourceThreadId: data.sourceThreadId,
    runId: data.runId,
    nodeId: data.nodeId,
    policyResult: data.policyResult,
    humanGate: data.humanGate,
    bizRetry: data.bizRetry
  }
}
export function projectHumanGate(value: AppNotification | undefined): HarnessHumanGateSnapshot | undefined {
  const notification = projectHarnessNotification(value)
  if (notification?.type !== "human_gate" || notification.status !== "pending" || !notification.humanGate) return undefined
  return {
    gateId: notification.notificationId, status: "pending",
    projectId: notification.projectId, featureId: notification.featureId,
    sourceThreadId: notification.sourceThreadId, sourceManagedRunId: notification.runId,
    hookId: notification.humanGate.hookId, message: notification.message, createdAt: notification.createdAt
  }
}
