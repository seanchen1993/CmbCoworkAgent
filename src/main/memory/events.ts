import { BrowserWindow } from "electron"

/**
 * Broadcast a memory:changed event to all renderer windows.
 *
 * Lives here (and not in ipc/memory.ts) so background producers like the
 * summarizer can notify the UI without importing IPC handler internals.
 */
export function notifyMemoryChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("memory:changed")
    }
  }
}
