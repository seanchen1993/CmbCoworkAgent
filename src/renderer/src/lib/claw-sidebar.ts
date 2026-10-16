import { createContext, useSyncExternalStore } from "react"
import { useAppStore } from "@/lib/store"

const hosts = new Map<string, HTMLElement>()
const paneOpens = new Map<string, Map<string, string>>()
const protectedFlowViews = new Set<string>()
export function protectFlowTaskView(threadId: string, active: boolean) {
  if (active) protectedFlowViews.add(threadId)
  else protectedFlowViews.delete(threadId)
  return () => {
    protectedFlowViews.delete(threadId)
  }
}
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const notify = () => {
  for (const listener of listeners) listener()
}

export function attachClawSidebarHost(threadId: string, element: HTMLElement | null) {
  if (element) hosts.set(threadId, element)
  else {
    hosts.delete(threadId)
    paneOpens.delete(threadId)
  }
  notify()
}

export function useClawSidebarHost(threadId: string) {
  return useSyncExternalStore(subscribe, () => hosts.get(threadId) ?? null)
}

export function openClawSidebar(tab?: "run" | "configuration" | "results") {
  const store = useAppStore.getState()
  store.setRightModule("claw")
  store.setRightPanelCollapsed(false)
  if (tab) window.dispatchEvent(new CustomEvent("claw:sidebar-tab", { detail: tab }))
}

export function openClawRecovery(threadId: string): void {
  openClawSidebar("configuration")
  window.dispatchEvent(new CustomEvent("claw:runtime-recovery", { detail: { threadId } }))
}

const notices = new Map<string, Record<string, string>>()
export function publishClawNotice(threadId: string, source: string, text: string) {
  const current = notices.get(threadId) ?? {}
  if ((current[source] ?? "") === text) return
  const next = { ...current }
  if (text) next[source] = text
  else delete next[source]
  if (Object.keys(next).length) notices.set(threadId, next)
  else notices.delete(threadId)
  notify()
}
const emptyNotices: Record<string, string> = {}
export function useClawNotices(threadId: string) {
  return useSyncExternalStore(subscribe, () => notices.get(threadId) ?? emptyNotices)
}

/** Inline panes are visible by default; sidebar descendants wait for the committed results tab. */
export const ClawResultsVisibility = createContext(true)

export function revealClawPanes(
  threadId: string,
  rows: readonly { key: string; openRequestId?: string }[]
): void {
  if (!hosts.has(threadId)) return
  const observed = paneOpens.get(threadId) ?? new Map<string, string>()
  paneOpens.set(threadId, observed)
  const activeKeys = new Set(rows.map((row) => row.key))
  for (const key of observed.keys()) if (!activeKeys.has(key)) observed.delete(key)
  let opened = false
  for (const row of rows) {
    if (row.openRequestId && observed.get(row.key) !== row.openRequestId) {
      observed.set(row.key, row.openRequestId)
      opened = true
    }
  }
  const store = useAppStore.getState()
  if (!opened || store.currentThreadId !== threadId || store.mainView !== "thread") return
  if (protectedFlowViews.has(threadId)) {
    publishClawNotice(threadId, "flow-panes", "有新的灵件记录")
    return
  }
  openClawSidebar("results")
}
