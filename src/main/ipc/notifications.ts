import { BrowserWindow, type IpcMain } from "electron"
import {
  isNotificationPendingForTarget,
  type AppDecisionInput
} from "../../shared/app-notifications"
import { createBrowserWindowAgentRunDelivery } from "../agent/agent-run-service"
import { notificationService } from "../services/notification-service"
import { decideNotification } from "../services/notification-actions"
import {
  isNotificationVisible,
  onNotificationProjectionChanged
} from "../services/notification-read-model"

export function registerNotificationHandlers(ipcMain: IpcMain): void {
  onNotificationProjectionChanged(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      try {
        window.webContents.send("appNotifications:changed")
      } catch (error) {
        console.warn("[Notifications] APP refresh failed:", error)
      }
    }
  })
  ipcMain.handle("appNotifications:list", () =>
    notificationService
      .pending()
      .filter(
        (item) => isNotificationPendingForTarget(item, "app_view") && isNotificationVisible(item)
      )
  )
  ipcMain.handle("appNotifications:decide", (event, input: AppDecisionInput) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("没有可用的应用窗口")
    return decideNotification(input, { channel: "desktop", context: {
      delivery: createBrowserWindowAgentRunDelivery(window)
    } })
  })
}
