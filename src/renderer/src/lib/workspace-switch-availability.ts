import type { ThreadConversationPresence } from "./agent-mode-switch-availability"

export interface WorkspaceSwitchThreadState {
  historyLoading: boolean
  historyConversationPresence: ThreadConversationPresence
  messages: readonly unknown[]
}

/** Fail closed until the thread shell exists and durable history has finished loading. */
export function canChangeThreadWorkspace(
  state: WorkspaceSwitchThreadState | null | undefined
): boolean {
  return Boolean(
    state &&
      !state.historyLoading &&
      state.historyConversationPresence === "empty" &&
      state.messages.length === 0
  )
}
