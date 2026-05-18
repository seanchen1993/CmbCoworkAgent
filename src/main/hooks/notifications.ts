import { BrowserWindow } from "electron"

export interface HooksChangedPayload {
  reason?: string
  at: string
}

export function notifyHooksChanged(reason?: string): void {
  const payload: HooksChangedPayload = {
    reason,
    at: new Date().toISOString()
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send("hooks:changed", payload)
  }
}
