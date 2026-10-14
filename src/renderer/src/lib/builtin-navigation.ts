import { openClawSidebar } from "./claw-sidebar"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"
import { useEffect, useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import type { BuiltinNavigationTarget } from "../features/slash-commands/builtin-commands"

export type BuiltinNavigationScope = { threadId: string; workspace: string | null }
type Request = BuiltinNavigationScope & { target: BuiltinNavigationTarget; id: number }
let request: Request | null = null
let sequence = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Explicit local navigation only: no runtime, model, or catalog reads. */
export function openBuiltinNavigation(
  target: BuiltinNavigationTarget,
  scope: BuiltinNavigationScope
) {
  const store = useAppStore.getState()
  if (store.currentThreadId !== scope.threadId) return
  if (target === "create") {
    store.setShowCustomizeView(true, "mods", "create")
    return
  }
  store.setShowCustomizeView(false)
  if (
    target === "runs" &&
    isOrdinaryFlowMetadata(store.threads.find((row) => row.thread_id === scope.threadId)?.metadata)
  ) {
    openClawSidebar("results")
    return
  }
  request = { ...scope, target, id: ++sequence }
  for (const listener of listeners) listener()
}

export function closeBuiltinNavigation(id: number) {
  if (request?.id !== id) return
  request = null
  for (const listener of listeners) listener()
}

export function useBuiltinNavigation(scope: BuiltinNavigationScope) {
  const value = useSyncExternalStore(subscribe, () => request)
  const scoped = value?.threadId === scope.threadId && value.workspace === scope.workspace ? value : null
  useEffect(
    () => () => {
      if (scoped) closeBuiltinNavigation(scoped.id)
    },
    [scope.threadId, scope.workspace, scoped?.id]
  )
  return scoped
}
