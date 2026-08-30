export type ThreadConversationPresence = "unknown" | "empty" | "nonempty"

export interface ThreadAgentModeSwitchState {
  historyLoading: boolean
  conversationPresence: ThreadConversationPresence
  residentMessageCount: number
}

/**
 * Fail closed until the durable transcript summary is known. A virtualized thread
 * can legitimately have no resident messages while older durable rows still exist.
 */
export function canChangeThreadAgentMode(
  state: ThreadAgentModeSwitchState | null | undefined
): boolean {
  return Boolean(
    state &&
      !state.historyLoading &&
      state.conversationPresence === "empty" &&
      state.residentMessageCount === 0
  )
}
