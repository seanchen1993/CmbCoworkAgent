export interface ThreadAgentModeSwitchState {
  historyLoading: boolean
  historyMessageTotal: number
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
      state.historyMessageTotal === 0 &&
      state.residentMessageCount === 0
  )
}
