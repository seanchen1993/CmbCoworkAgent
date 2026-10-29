import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import {
  readHostProjectThreadTarget,
  sameHostProjectThreadTarget,
  type HostProjectThreadTarget
} from "./host-project-thread"

export interface HostProjectIntent {
  id: string
  accountRevision: number
  target: HostProjectThreadTarget
}

let pending: HostProjectIntent | null = null
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function hostProjectIntentCurrent(intent: HostProjectIntent): boolean {
  const state = useAppStore.getState()
  return (
    pending?.id === intent.id &&
    state.accountRevision === intent.accountRevision &&
    sameHostProjectThreadTarget(
      intent.target,
      readHostProjectThreadTarget(
        state.threads.find((thread) => thread.thread_id === intent.target.threadId)
      )
    )
  )
}

export function openHostProjectFromThread(threadId: string): void {
  const state = useAppStore.getState()
  const target = readHostProjectThreadTarget(
    state.threads.find((thread) => thread.thread_id === threadId)
  )
  if (!target) throw Error("HOST_PROJECT_NAVIGATION_CHANGED")
  pending = { id: crypto.randomUUID(), accountRevision: state.accountRevision, target }
  state.setShowHarnessBoardView(true)
  notify()
}

export function dismissHostProjectIntent(id: string): void {
  if (pending?.id !== id) return
  pending = null
  notify()
}

export const readHostProjectIntent = () => pending
export const useHostProjectIntent = () => useSyncExternalStore(subscribe, readHostProjectIntent)
