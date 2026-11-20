import { create } from "zustand"
import type { ThreadSearchResult, ThreadSearchTarget } from "../../../shared/thread-search-types"

export interface ThreadSearchNavigation {
  id: number
  result: ThreadSearchResult
  query: string
}

export type DurableSearchNavigation = ThreadSearchNavigation & {
  target: ThreadSearchTarget
}

export const useThreadSearch = create<{
  open: boolean
  openingVersion: number
  navigation: ThreadSearchNavigation | null
  failure: string
}>(() => ({ open: false, openingVersion: 0, navigation: null, failure: "" }))

let sequence = 0

export function openThreadSearch(): void {
  cancelThreadSearchNavigation()
  useThreadSearch.setState((current) => ({
    open: true,
    openingVersion: current.open ? current.openingVersion : current.openingVersion + 1,
    failure: ""
  }))
}

export function reserveThreadSearchNavigation(): number {
  useThreadSearch.setState({ navigation: null, failure: "" })
  return ++sequence
}

export function isCurrentThreadSearchNavigation(id: number): boolean {
  return id === sequence
}

export function cancelThreadSearchNavigation(): void {
  sequence += 1
  useThreadSearch.setState({ navigation: null })
}

export function finishThreadSearchNavigation(id: number, failure = ""): void {
  if (!isCurrentThreadSearchNavigation(id)) return
  sequence += 1
  useThreadSearch.setState({ navigation: null, failure })
}
