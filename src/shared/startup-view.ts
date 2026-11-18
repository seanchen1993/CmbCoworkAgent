export type StartupView = "thread" | "bots"

export const DEFAULT_STARTUP_VIEW: StartupView = "thread"
export const STARTUP_VIEW_GET_CHANNEL = "app:get-startup-view"
export const STARTUP_VIEW_SET_CHANNEL = "app:set-startup-view"

export function isStartupView(value: unknown): value is StartupView {
  return value === "thread" || value === "bots"
}
