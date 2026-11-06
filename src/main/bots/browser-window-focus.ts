import type { BaseWindow, WebContents } from "electron"

/** The browser lives in a helper process, so show/focus alone may leave it behind the App on Windows. */
export function showBotBrowserWindow(
  window: BaseWindow & { webContents: WebContents },
  platform = process.platform
): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  const raise = platform === "win32" && !window.isAlwaysOnTop()
  try {
    if (raise) window.setAlwaysOnTop(true)
    window.show()
    window.moveTop()
    window.focus()
    window.webContents.focus()
  } finally {
    // Never leave the takeover window permanently above other applications.
    if (raise && !window.isDestroyed()) window.setAlwaysOnTop(false)
  }
}
