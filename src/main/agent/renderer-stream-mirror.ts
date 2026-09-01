import { BrowserWindow } from "electron"
import type { SchedulerRendererEvent } from "./stream-converter"

/**
 * Global lifecycle channel: a tiny {threadId, type} envelope for every turn
 * lifecycle transition, independent of per-thread subscriptions. Unopened
 * (lazy) threads use it to render the sidebar loading indicator without the
 * renderer ever paying for the full per-thread stream or early hydration.
 */
const THREAD_ACTIVITY_CHANNEL = "scheduler:thread-activity"

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(channel, payload)
  }
}

export function mirrorStandardTurnStreamToRenderer(
  threadId: string,
  event: SchedulerRendererEvent
): void {
  broadcast(`scheduler:stream:${threadId}`, event)
  if (event.type === "started" || event.type === "done" || event.type === "error") {
    broadcast(THREAD_ACTIVITY_CHANNEL, { threadId, type: event.type })
  }
}

export function notifyRemoteThreadChanged(): void {
  broadcast("threads:changed", undefined)
}
