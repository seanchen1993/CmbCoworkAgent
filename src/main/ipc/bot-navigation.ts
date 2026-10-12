import { ipcMain, type BrowserWindow } from "electron"
import type { BotDeepLinkController } from "../bots/upstream/grok-deep-link-controller"

/** Only the actual workspace main frame can declare its navigation listener ready. */
export function registerBotNavigationHandlers(
  controller: BotDeepLinkController,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle("bots:navigationReady", (event) => {
    const window = getWindow()
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Bot 导航必须来自应用主界面")
    controller.markReady()
  })
}
