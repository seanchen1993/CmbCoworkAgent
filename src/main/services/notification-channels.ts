import type { AppNotification, AppNotificationTarget } from "../../shared/app-notifications"

type NotificationChannel = {
  created: (notification: AppNotification) => void | Promise<void>
  ended: (notification: AppNotification) => void
}
type DeliveryTarget = Exclude<AppNotificationTarget, "app_view">
const channels = new Map<
  string,
  { target: DeliveryTarget; sourceType?: string; adapter: NotificationChannel }
>()

export function registerNotificationChannel(
  key: string,
  target: DeliveryTarget,
  adapter: NotificationChannel,
  sourceType?: string
): void {
  channels.set(key, { target, sourceType, adapter })
}

export function publishNotificationLifecycle(
  notification: AppNotification,
  change: "created" | "ended" | "channel_disabled"
): void {
  for (const { target, sourceType, adapter } of channels.values()) {
    if (!notification.targets.includes(target) || (sourceType && sourceType !== notification.type)) continue
    try {
      if (notification.status !== "pending" || notification.disabledTargets?.[target]) {
        adapter.ended(notification)
      } else if (change === "created") {
        void Promise.resolve(adapter.created(notification)).catch((error) => {
          console.warn(`[Notifications] ${target} delivery failed:`, error)
        })
      }
    } catch (error) {
      console.warn(`[Notifications] ${target} update failed:`, error)
    }
  }
}
