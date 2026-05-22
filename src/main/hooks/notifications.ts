import { BrowserWindow } from "electron"
import type { HookLoggingConfig } from "../types"

export interface HooksChangedPayload {
  reason?: string
  at: string
}

export interface HookLoggingChangedPayload {
  config: HookLoggingConfig
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

export function notifyHookLoggingChanged(config: HookLoggingConfig): void {
  const payload: HookLoggingChangedPayload = {
    config,
    at: new Date().toISOString()
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send("hooks:logging:changed", payload)
  }
}
