/** Grok root navigation history; bounded to 200 Cmb conversation visits. See PROVENANCE. */
export interface RootShellNavigationState {
  entries: readonly string[]
  cursor: number
  pendingTarget: string | null
  appliedAgentId: string | null
}

export function createRootShellNavigationState(): RootShellNavigationState {
  return { entries: [], cursor: -1, pendingTarget: null, appliedAgentId: null }
}

export function recordRootShellAgentSelection(
  state: RootShellNavigationState,
  agentId: string
): RootShellNavigationState {
  if (agentId === state.appliedAgentId) return state
  if (agentId === state.pendingTarget)
    return { ...state, pendingTarget: null, appliedAgentId: agentId }
  const entries = [...state.entries.slice(0, state.cursor + 1), agentId].slice(-200)
  return { entries, cursor: entries.length - 1, pendingTarget: null, appliedAgentId: agentId }
}

export function resolveRootShellNavigation(
  state: RootShellNavigationState,
  availableAgentIds: ReadonlySet<string>,
  direction: "back" | "forward"
): { state: RootShellNavigationState; targetId: string } | null {
  const step = direction === "back" ? -1 : 1
  const current = state.cursor >= 0 ? (state.entries[state.cursor] ?? null) : null
  for (let index = state.cursor + step; index >= 0 && index < state.entries.length; index += step) {
    const targetId = state.entries[index]
    if (targetId != null && availableAgentIds.has(targetId) && targetId !== current) {
      return { state: { ...state, cursor: index, pendingTarget: targetId }, targetId }
    }
  }
  return null
}
