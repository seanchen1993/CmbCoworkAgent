import { useEffect, useSyncExternalStore } from "react"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import { useAppStore } from "./store"
import { sameSimpleAuthoringScope } from "./simple-authoring-intent"

export interface SimpleAuthoringTaskIntent {
  id: string
  scope: { threadId: string; workspace: string | null }
  profileId: string
  flow?: SavedFlow
  suggestedText: string
  kind?: "command"
}
let pending: SimpleAuthoringTaskIntent | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function prepareSimpleAuthoringTask(intent: SimpleAuthoringTaskIntent): void {
  const store = useAppStore.getState()
  if (store.currentThreadId !== intent.scope.threadId) return
  pending = structuredClone(intent)
  store.setShowCustomizeView(false)
  for (const listener of listeners) listener()
}
export function dismissSimpleAuthoringTask(id: string): void {
  if (pending?.id !== id) return
  pending = null
  for (const listener of listeners) listener()
}
export function useSimpleAuthoringTask(threadId: string, workspace: string | null) {
  const value = useSyncExternalStore(subscribe, () => pending)
  const scoped = value && sameSimpleAuthoringScope(value.scope, { threadId, workspace }) ? value : null
  useEffect(
    () => () => {
      if (scoped) dismissSimpleAuthoringTask(scoped.id)
    },
    [threadId, workspace, scoped?.id]
  )
  return scoped
}
