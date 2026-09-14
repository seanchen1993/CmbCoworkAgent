import { createContext, useContext, useLayoutEffect, useState } from "react"

export interface ReasoningExpansionState {
  open: boolean
  autoOpened: boolean
  autoCollapsed: boolean
}

// Virtual rows unmount while scrolling. Preserve both automatic progress and explicit choices
// for the lifetime of the list, bounded independently of the transcript size.
export const ReasoningExpansionContext = createContext<Map<string, ReasoningExpansionState> | null>(
  null
)
const MAX_SAVED_REASONING_CHOICES = 500
const INITIAL_REASONING_STATE: ReasoningExpansionState = {
  open: false,
  autoOpened: false,
  autoCollapsed: false
}

// Match the original two one-shot effects, in order. A manual toggle changes only `open`:
// starting an answer still auto-collapses once, but later tokens cannot override a toggle.
export function advanceReasoningExpansion(
  previous: ReasoningExpansionState,
  hasReasoning: boolean,
  isStreaming: boolean,
  shouldCollapse: boolean
): ReasoningExpansionState {
  if (!hasReasoning || !isStreaming) return previous
  let next = previous
  if (!next.autoOpened) next = { ...next, open: true, autoOpened: true }
  if (shouldCollapse && !next.autoCollapsed) {
    next = { ...next, open: false, autoCollapsed: true }
  }
  return next
}

export function rememberReasoningExpansion(
  choices: Map<string, ReasoningExpansionState>,
  messageId: string,
  state: ReasoningExpansionState
): void {
  choices.delete(messageId)
  choices.set(messageId, state)
  if (choices.size > MAX_SAVED_REASONING_CHOICES) {
    const oldest = choices.keys().next().value
    if (oldest !== undefined) choices.delete(oldest)
  }
}

export function useReasoningExpansion(
  messageId: string,
  hasReasoning: boolean,
  isStreaming: boolean,
  shouldCollapse: boolean
): [boolean, () => void] {
  const choices = useContext(ReasoningExpansionContext)
  const [saved, setSaved] = useState(() => ({
    messageId,
    choices,
    state: advanceReasoningExpansion(
      choices?.get(messageId) ?? INITIAL_REASONING_STATE,
      hasReasoning,
      isStreaming,
      shouldCollapse
    )
  }))
  const previous =
    saved.messageId === messageId && saved.choices === choices
      ? saved.state
      : (choices?.get(messageId) ?? INITIAL_REASONING_STATE)
  const state = advanceReasoningExpansion(previous, hasReasoning, isStreaming, shouldCollapse)
  // Adjust this component's own state during render, before committing its DOM. An effect would
  // commit the wrong row height first and let ResizeObserver/scroll anchoring react to it.
  if (saved.messageId !== messageId || saved.choices !== choices || saved.state !== state) {
    setSaved({ messageId, choices, state })
  }

  useLayoutEffect(() => {
    if (!choices || !hasReasoning) return
    rememberReasoningExpansion(choices, messageId, state)
  }, [choices, hasReasoning, messageId, state])

  const toggle = (): void => {
    setSaved({ messageId, choices, state: { ...state, open: !state.open } })
  }

  return [state.open, toggle]
}
