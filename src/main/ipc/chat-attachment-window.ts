import type { BrowserWindow, IpcMainInvokeEvent } from "electron"

export function assertChatAttachmentWindow(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
) {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || window.webContents !== event.sender ||
      event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    throw new Error("附件仅支持当前应用主窗口")
  return window
}
