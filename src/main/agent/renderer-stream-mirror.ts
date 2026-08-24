import { BrowserWindow } from "electron"
import type { SchedulerRendererEvent } from "./stream-converter"

export function mirrorStandardTurnStreamToRenderer(
  threadId: string,
  event: SchedulerRendererEvent
): void {
  const channel = `scheduler:stream:${threadId}`
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(channel, event)
  }
}

export function notifyRemoteThreadChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send("threads:changed")
  }
}
