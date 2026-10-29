/** Transport-neutral envelope. The source owns the payload and action vocabulary. */
export type AppNotificationTarget = "app_view" | "im" | "system_notification"
export type AppNotificationStatus = "pending" | "resolved" | "invalidated"
/** Who decided; "system" means automatic termination, not an OS notification delivery. */
export type AppDecisionChannel = "desktop" | "im" | "system"
export interface AppNotification {
  notificationId: string
  kind: "decision"
  type: string
  status: AppNotificationStatus
  targets: AppNotificationTarget[]
  disabledTargets?: Partial<Record<AppNotificationTarget, boolean>>
  title: string
  message: string
  payload: unknown
  createdAt: string
  updatedAt: string
  completedAt?: string
  action?: string
  channel?: AppDecisionChannel
  reasonCode?: string
  result?: string
}
export type CreateAppNotificationInput = Pick<AppNotification,
  "kind" | "type" | "targets" | "title" | "message" | "payload"
> & { notificationId?: string }
export interface AppNotificationFinish {
  status: "resolved" | "invalidated"
  action?: string
  channel: AppDecisionChannel
  reasonCode: string
  result: string
}
export interface AppDecisionInput {
  notificationId: string
  action: string
  message?: string
}
export interface AppDecisionResult {
  applied: boolean
  message: string
}

export function isNotificationPendingForTarget(
  notification: AppNotification | undefined,
  target: AppNotificationTarget
): notification is AppNotification {
  return Boolean(
    notification?.kind === "decision" &&
    notification.status === "pending" &&
    notification.targets.includes(target) &&
    !notification.disabledTargets?.[target]
  )
}
