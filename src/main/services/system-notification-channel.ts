import { Notification } from "electron"
import { stripThink } from "./notify"
import { registerNotificationChannel } from "./notification-channels"

const systemNotifications = new Map<string, Notification>()
export function initializeSystemNotificationChannel(): void {
  registerNotificationChannel("system", "system_notification", {
    created(value) {
      if (!Notification.isSupported()) return
      const notification = new Notification({
        title: value.title,
        body: stripThink(value.message)
          .trim()
          .slice(0, 200)
      })
      systemNotifications.set(value.notificationId, notification)
      notification.once("close", () => {
        if (systemNotifications.get(value.notificationId) === notification) {
          systemNotifications.delete(value.notificationId)
        }
      })
      notification.show()
    },
    ended(value) {
      const notification = systemNotifications.get(value.notificationId)
      systemNotifications.delete(value.notificationId)
      notification?.close()
    }
  })
}
