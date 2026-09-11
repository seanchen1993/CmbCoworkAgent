import { BrowserWindow } from "electron"

/** Broadcast a channel (with optional payload) to every renderer. */
export function notifyRenderer(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(channel, payload)
      } catch (error) {
        console.warn("[RendererNotification] renderer notification failed", error)
      }
    }
  }
}
