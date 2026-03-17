import { BrowserWindow, Notification } from "electron"
import { getEnabledHooks } from "../storage"
import { runHooks } from "../hooks/runner"

const BODY_MAX = 200

/**
 * Show a desktop notification only when the app window is NOT focused.
 * This avoids disturbing the user when they are already looking at the app.
 */
export function notifyIfBackground(title: string, body: string): void {
  if (!Notification.isSupported()) return

  const win = BrowserWindow.getFocusedWindow()
  if (win && win.isFocused()) return

  // Fire Notification hooks
  runHooks(getEnabledHooks(), "Notification", {
    toolArgs: { title, body }
  }).catch((e) => console.warn("[Notify] Notification hook error:", e))

  sendNotification(title, body)
}

/**
 * Always show a desktop notification regardless of window focus.
 * Use for autonomous tasks (scheduled tasks) where the user expects to be notified.
 */
export function notifyAlways(title: string, body: string): void {
  if (!Notification.isSupported()) return
  sendNotification(title, body)
}

function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/g, "")
}

function sendNotification(title: string, body: string): void {
  let text = stripThink(body).trim()
  if (text.length > BODY_MAX) {
    text = text.slice(0, BODY_MAX - 3) + "..."
  }
  new Notification({ title, body: text }).show()
}
