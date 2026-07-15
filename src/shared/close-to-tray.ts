export type CloseToTrayPromptAction = "minimize-to-tray" | "direct-close" | "cancel"

export type WindowCloseBehavior = "ask" | "minimize-to-tray" | "quit"

export type CloseToTrayPromptReason = "close-choice" | "active-runs" | "tray-unavailable"

export const DEFAULT_WINDOW_CLOSE_BEHAVIOR: WindowCloseBehavior = "ask"

export function isWindowCloseBehavior(value: unknown): value is WindowCloseBehavior {
  return value === "ask" || value === "minimize-to-tray" || value === "quit"
}

export function normalizeWindowCloseBehavior(value: unknown): WindowCloseBehavior {
  return isWindowCloseBehavior(value) ? value : DEFAULT_WINDOW_CLOSE_BEHAVIOR
}

export function closePromptActionToBehavior(
  action: CloseToTrayPromptAction
): WindowCloseBehavior | null {
  if (action === "minimize-to-tray") return "minimize-to-tray"
  if (action === "direct-close") return "quit"
  return null
}

export interface WindowCloseRequestContext {
  behavior: WindowCloseBehavior
  isAppQuitting: boolean
  trayAvailable: boolean
  hasActiveForegroundRuns: boolean
}

export type WindowCloseRequestDecision =
  | { action: "allow-close" }
  | { action: "minimize-to-tray" }
  | { action: "quit" }
  | { action: "prompt"; reason: CloseToTrayPromptReason }

export function resolveWindowCloseRequest(
  context: WindowCloseRequestContext
): WindowCloseRequestDecision {
  if (context.isAppQuitting) return { action: "allow-close" }

  if (context.behavior === "minimize-to-tray" && context.trayAvailable) {
    return { action: "minimize-to-tray" }
  }

  if (context.behavior === "quit" && !context.hasActiveForegroundRuns) {
    return { action: "quit" }
  }

  if (context.hasActiveForegroundRuns) {
    return { action: "prompt", reason: "active-runs" }
  }

  if (!context.trayAvailable) {
    return { action: "prompt", reason: "tray-unavailable" }
  }

  return { action: "prompt", reason: "close-choice" }
}

export interface CloseToTrayPromptResponse {
  requestId: number
  action: CloseToTrayPromptAction
  rememberChoice: boolean
}

export function isCloseToTrayPromptResponse(value: unknown): value is CloseToTrayPromptResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.requestId === "number" &&
    Number.isSafeInteger(record.requestId) &&
    record.requestId > 0 &&
    (record.action === "minimize-to-tray" ||
      record.action === "direct-close" ||
      record.action === "cancel") &&
    typeof record.rememberChoice === "boolean"
  )
}

export interface CloseToTrayPromptOpenEvent {
  type: "open"
  requestId: number
  trayAreaName: string
  reason: CloseToTrayPromptReason
  canMinimizeToTray: boolean
  rememberChoiceAllowed: boolean
}

export interface CloseToTrayPromptDismissEvent {
  type: "dismiss"
  requestId: number
  reason: "timeout" | "renderer-reset"
}

export type CloseToTrayPromptEvent = CloseToTrayPromptOpenEvent | CloseToTrayPromptDismissEvent

export function reduceCloseToTrayPrompt(
  current: CloseToTrayPromptOpenEvent | null,
  event: CloseToTrayPromptEvent
): CloseToTrayPromptOpenEvent | null {
  if (event.type === "open") return event
  return current?.requestId === event.requestId ? null : current
}
