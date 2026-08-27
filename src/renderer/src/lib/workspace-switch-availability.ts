export interface WorkspaceSwitchThreadState {
  historyLoading: boolean
  historyMessageTotal: number
  messages: readonly unknown[]
}

/** Fail closed until the thread shell exists and durable history has finished loading. */
export function canChangeThreadWorkspace(
  state: WorkspaceSwitchThreadState | null | undefined
): boolean {
  return Boolean(
    state &&
      !state.historyLoading &&
      state.historyMessageTotal === 0 &&
      state.messages.length === 0
  )
}
