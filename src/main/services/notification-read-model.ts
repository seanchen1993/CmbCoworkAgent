import type { AppNotification } from "../../shared/app-notifications"

const visibility = new Map<string, (notification: AppNotification) => boolean>()
const listeners = new Set<(notificationId: string) => void>()

/** Source predicates are read-only. Missing predicates leave ordinary messages visible. */
export function registerNotificationVisibility(
  source: string,
  isVisible: (notification: AppNotification) => boolean
): void {
  visibility.set(source, isVisible)
}

export function isNotificationVisible(notification: AppNotification): boolean {
  return visibility.get(notification.type)?.(notification) ?? true
}

export function onNotificationProjectionChanged(listener: (notificationId: string) => void): void {
  listeners.add(listener)
}

/** Shared read-model signal for persisted changes and runtime-only invalidation. */
export function invalidateNotificationProjection(notificationId: string): void {
  for (const listener of listeners) {
    try {
      listener(notificationId)
    } catch (error) {
      console.warn("[Notifications] Projection refresh failed:", error)
    }
  }
}
