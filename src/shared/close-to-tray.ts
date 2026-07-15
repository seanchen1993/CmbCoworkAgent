export type CloseToTrayPromptAction = "minimize-to-tray" | "direct-close" | "cancel"

export interface CloseToTrayPromptOpenEvent {
  type: "open"
  requestId: number
  trayAreaName: string
}

export interface CloseToTrayPromptDismissEvent {
  type: "dismiss"
  requestId: number
  reason: "timeout" | "renderer-reset"
}

export type CloseToTrayPromptEvent =
  | CloseToTrayPromptOpenEvent
  | CloseToTrayPromptDismissEvent

export function reduceCloseToTrayPrompt(
  current: CloseToTrayPromptOpenEvent | null,
  event: CloseToTrayPromptEvent
): CloseToTrayPromptOpenEvent | null {
  if (event.type === "open") return event
  return current?.requestId === event.requestId ? null : current
}
