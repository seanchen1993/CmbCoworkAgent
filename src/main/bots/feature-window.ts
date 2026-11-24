import type { BrowserWindow } from "electron"
import { createBrowserWindowAgentRunDelivery } from "../agent/agent-run-service"

let windowForProject: (() => BrowserWindow | null) | undefined
export function configureBotFeatureWindow(resolve: () => BrowserWindow | null) {
  windowForProject = resolve
}
export function featureDelivery() {
  const window = windowForProject?.()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed())
    throw new Error("请先打开 App 主窗口")
  return createBrowserWindowAgentRunDelivery(window)
}
