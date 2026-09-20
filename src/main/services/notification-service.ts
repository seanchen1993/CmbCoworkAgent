import { formatGmt8Timestamp } from "../../shared/gmt8-time"
import { randomUUID } from "node:crypto"
import type { AppNotification, AppNotificationFinish, AppNotificationTarget, CreateAppNotificationInput } from "../../shared/app-notifications"
import { appNotificationStore, type NotificationCursor } from "./app-notifications"
import { publishNotificationLifecycle } from "./notification-channels"
import { invalidateNotificationProjection } from "./notification-read-model"

export type NotificationChange = "created" | "ended" | "channel_disabled" | "recovered"
const listeners = new Set<(value: AppNotification, change: NotificationChange) => void>()
export function onNotificationChanged(listener: (value: AppNotification, change: NotificationChange) => void): void {
  listeners.add(listener)
}
function publish(value: AppNotification, change: NotificationChange): void {
  for (const listener of listeners) {
    try { listener(value, change) } catch (error) {
      console.warn("[Notifications] Source listener failed:", error)
    }
  }
  if (change !== "recovered") {
    publishNotificationLifecycle(value, change)
    invalidateNotificationProjection(value.notificationId)
  }
}
const RETENTION_DAYS = 60
const MAX_TERMINAL_MESSAGES = 10_000
const DAY_MS = 24 * 60 * 60 * 1000
const yieldToMain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
function retentionCutoff(): string {
  return formatGmt8Timestamp(new Date(Date.now() - RETENTION_DAYS * DAY_MS))
}
class NotificationService {
  private cleanupTimer?: ReturnType<typeof setTimeout>

  get = (id: string): AppNotification | undefined => appNotificationStore.get(id)
  pending = (): AppNotification[] => appNotificationStore.pending()
  create(input: CreateAppNotificationInput): AppNotification {
    const timestamp = formatGmt8Timestamp()
    const value: AppNotification = { ...input, notificationId: input.notificationId ?? randomUUID(),
      status: "pending", createdAt: timestamp, updatedAt: timestamp }
    appNotificationStore.insert(value)
    publish(value, "created")
    return value
  }
  finish(id: string, input: AppNotificationFinish): boolean {
    const current = this.get(id)
    if (current?.status !== "pending") return false
    return this.finishPending(current, input)
  }
  private finishPending(current: AppNotification, input: AppNotificationFinish): boolean {
    const timestamp = formatGmt8Timestamp()
    const next = { ...current, ...input, updatedAt: timestamp, completedAt: timestamp }
    if (!appNotificationStore.updatePending(next)) return false
    publish(next, "ended")
    return true
  }
  disableChannel(id: string, target: AppNotificationTarget): void {
    const current = this.get(id)
    if (current?.status !== "pending" || current.disabledTargets?.[target]) return
    const next = {
      ...current,
      updatedAt: formatGmt8Timestamp(),
      disabledTargets: { ...current.disabledTargets, [target]: true }
    }
    if (appNotificationStore.updatePending(next)) publish(next, "channel_disabled")
  }
  async recover(): Promise<void> {
    const cutoff = retentionCutoff()
    for (const kind of ["pending", "terminal"] as const) {
      let cursor: NotificationCursor | undefined
      let remaining = kind === "terminal" ? MAX_TERMINAL_MESSAGES : Infinity
      while (remaining > 0) {
        const page = appNotificationStore.recoveryPage(kind, cutoff, cursor, Math.min(200, remaining))
        for (const value of page.values) {
          if (kind === "pending") {
            this.finishPending(value, { status: "invalidated", channel: "system",
              reasonCode: "app_restarted", result: "应用重启导致决策中断" })
          } else publish(value, "recovered")
        }
        if (page.count === 0) break
        cursor = page.cursor
        remaining -= page.count
        await yieldToMain()
      }
    }
    await this.cleanup()
  }
  private async cleanup(): Promise<void> {
    try {
      const cutoff = retentionCutoff()
      while (appNotificationStore.deleteExpiredBatch(cutoff) > 0) await yieldToMain()
      while (appNotificationStore.deleteOverflowBatch(MAX_TERMINAL_MESSAGES) > 0) await yieldToMain()
    } catch (error) {
      console.warn("[Notifications] Retention cleanup failed:", error)
    } finally {
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
      this.cleanupTimer = setTimeout(() => { void this.cleanup() }, DAY_MS)
      this.cleanupTimer.unref()
    }
  }
}
export const notificationService = new NotificationService()
