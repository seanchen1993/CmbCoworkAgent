import type { AppNotificationFinish } from "../../shared/app-notifications"
import { projectHarnessNotification, type CreateHarnessNotification, type HarnessNotification } from "../../shared/harness-notifications"
import { notificationService } from "../services/notification-service"

/** Domain convenience API; persistence and channels know nothing about these associations. */
export const harnessNotifications = {
  get(id: string): HarnessNotification | undefined {
    return projectHarnessNotification(notificationService.get(id))
  },
  pending(): HarnessNotification[] {
    return notificationService.pending().flatMap((message) => {
      const value = projectHarnessNotification(message)
      return value ? [value] : []
    })
  },
  create(input: CreateHarnessNotification): HarnessNotification {
    const { notificationId, kind, type, title, message, targets, ...payload } = input
    const value = notificationService.create({
      notificationId, kind, type, title, message, targets, payload
    })
    return { ...value, ...payload }
  },
  finish(id: string, input: AppNotificationFinish): boolean {
    return notificationService.finish(id, input)
  },
  disableIm(projectId: string, featureId: string): void {
    for (const value of this.pending()) {
      if (value.projectId === projectId && value.featureId === featureId) {
        notificationService.disableChannel(value.notificationId, "im")
      }
    }
  },
  invalidateRun(runId: string, exceptId?: string): void {
    for (const value of this.pending()) {
      if (value.runId === runId && value.notificationId !== exceptId) {
        notificationService.finish(value.notificationId, { status: "invalidated", channel: "system",
          result: "托管运行已结束", reasonCode: "managed_run_ended" })
      }
    }
  }
}
