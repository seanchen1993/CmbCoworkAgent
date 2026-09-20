import {
  isNotificationPendingForTarget,
  type AppDecisionChannel,
  type AppDecisionInput,
  type AppDecisionResult,
  type AppNotification,
  type AppNotificationTarget
} from "../../shared/app-notifications"
import { notificationService } from "./notification-service"

export interface NotificationActionContext {
  channel: Exclude<AppDecisionChannel, "system">
  context?: unknown
}
type Handler = (notification: AppNotification, input: AppDecisionInput, context: NotificationActionContext) => Promise<AppDecisionResult>
const handlers = new Map<string, Handler>()
const decisionTargets: Record<NotificationActionContext["channel"], AppNotificationTarget> = {
  desktop: "app_view",
  im: "im"
}
export function registerNotificationActions(source: string, handler: Handler): void {
  handlers.set(source, handler)
}
export async function decideNotification(input: AppDecisionInput, context: NotificationActionContext): Promise<AppDecisionResult> {
  if (!input || typeof input.notificationId !== "string" || typeof input.action !== "string") {
    return { applied: false, message: "决策参数无效" }
  }
  const value = notificationService.get(input.notificationId)
  if (!isNotificationPendingForTarget(value, decisionTargets[context.channel])) {
    return { applied: false, message: "该决策已处理或当前渠道已失效。" }
  }
  const handler = handlers.get(value.type)
  return handler ? handler(value, input, context) : { applied: false, message: "该消息源不支持此操作。" }
}
