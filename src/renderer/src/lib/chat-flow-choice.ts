import { useSyncExternalStore } from "react"

export interface ChatFlowChoice {
  workspace: string
  id: string
  revision: number
  name: string
  bindingRevision?: number
}

// Explicit one-message UI intent only. Bindings never implicitly select an execution mode.
const choices = new Map<string, ChatFlowChoice>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function selectChatFlow(threadId: string, choice: ChatFlowChoice | null): void {
  choices.delete(threadId)
  if (choice) choices.set(threadId, choice)
  while (choices.size > 64) choices.delete(choices.keys().next().value!)
  for (const listener of listeners) listener()
}

export function useChatFlowChoice(threadId: string): ChatFlowChoice | null {
  return useSyncExternalStore(subscribe, () => choices.get(threadId) ?? null)
}

export const currentChatFlowChoice = (threadId: string) => choices.get(threadId) ?? null

export function consumeChatFlowChoice(threadId: string, expected: ChatFlowChoice): void {
  if (choices.get(threadId) === expected) selectChatFlow(threadId, null)
}
