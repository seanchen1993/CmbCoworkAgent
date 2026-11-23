import { create } from "zustand"
import type { ThreadSearchResult, ThreadSearchRoute, ThreadSearchTarget } from "../../../shared/thread-search-types"

import type { HarnessProjectListItem } from "../../../shared/harness-board-types"

export interface ThreadSearchNavigation {
  id: number
  result: ThreadSearchResult
  query: string
  route: ThreadSearchRoute
  navigationTicketId: string
  searchReadOnly?: true
  stage: "board" | "board-mounting" | "chat"
  project?: HarnessProjectListItem
  onProjectReady?: () => void
  onProjectAccessResolved?: (available: boolean) => void
  restoreSourceView?: () => void
}

export type DurableSearchNavigation = ThreadSearchNavigation & {
  target: ThreadSearchTarget
}

export const useThreadSearch = create<{
  open: boolean
  openingVersion: number
  ordinarySidebarAnchor: { threadId: string } | null
  navigation: ThreadSearchNavigation | null
  failure: string
  projectId: string | null
  projectRoute: Exclude<ThreadSearchRoute, { kind: "ordinary" }> | null
  projectSessionThreadId: string | null
  readOnlyProjectThreadId: string | null
  origin: { projectMode: boolean; projectId: string | null } | null
}>(() => ({
  open: false, openingVersion: 0, ordinarySidebarAnchor: null, navigation: null, failure: "",
  projectId: null, projectRoute: null, projectSessionThreadId: null,
  readOnlyProjectThreadId: null, origin: null
}))

export function isReadOnlyProjectSearchThread(threadId: string): boolean {
  const { readOnlyProjectThreadId, navigation } = useThreadSearch.getState()
  return readOnlyProjectThreadId === threadId ||
    (navigation?.result.threadId === threadId &&
      navigation.route.kind !== "ordinary" &&
      Boolean(navigation.searchReadOnly || navigation.onProjectAccessResolved))
}

let sequence = 0
let ownedTransition: number | null = null
let pendingTicket: string | undefined
let pendingTabs: { source: string | null; target: string } | null = null

function releaseTicket(token: string): void {
  void globalThis.window?.api?.threads?.searchCancelNavigation?.(token).catch(() => {})
}

export function bindThreadSearchTicket(id: number, token: string): boolean {
  if (id !== sequence) {
    releaseTicket(token)
    return false
  }
  pendingTicket = token
  return true
}

export function isOwnedThreadSearchTransition(): boolean {
  return ownedTransition !== null && ownedTransition === sequence
}

export function withOwnedThreadSearchTransition(id: number, action: () => void): boolean {
  if (id !== sequence) return false
  const previous = ownedTransition
  ownedTransition = id
  try {
    action()
  } finally {
    ownedTransition = previous
  }
  return id === sequence
}

export function isThreadSearchSurface(
  navigation: ThreadSearchNavigation,
  threadId: string,
  surface: string,
  projectRoute: ThreadSearchRoute | null
): boolean {
  if (navigation.stage !== "chat" || navigation.result.threadId !== threadId) return false
  const route = navigation.route
  if (route.kind === "ordinary") return surface === "default" || surface === "bot"
  const expectedSurface = route.kind === "featureSession" ? "harness-project" : "harness-feature-session"
  return surface === expectedSurface &&
    projectRoute?.kind === route.kind && projectRoute.projectId === route.projectId &&
    (route.kind !== "featureSession" || (projectRoute.kind === "featureSession" && projectRoute.slug === route.slug))
}

export function openThreadSearch(projectMode = false): void {
  cancelThreadSearchNavigation()
  useThreadSearch.setState((current) => ({
    open: true,
    openingVersion: current.open ? current.openingVersion : current.openingVersion + 1,
    failure: "",
    origin: current.open ? current.origin : { projectMode, projectId: projectMode ? current.projectId : null }
  }))
}

export function reserveThreadSearchNavigation(source: string | null = null, target?: string): number {
  cancelThreadSearchNavigation()
  pendingTabs = target ? { source, target } : null
  useThreadSearch.setState({ failure: "", ordinarySidebarAnchor: null })
  return sequence
}

export function isCurrentThreadSearchNavigation(id: number): boolean {
  return id === sequence
}

export function cancelThreadSearchForExternalRoute(): void {
  if (isOwnedThreadSearchTransition()) return
  const { navigation, ordinarySidebarAnchor } = useThreadSearch.getState()
  if (ordinarySidebarAnchor) useThreadSearch.setState({ ordinarySidebarAnchor: null })
  if (pendingTabs || navigation) cancelThreadSearchNavigation()
}

export function cancelThreadSearchOnTabChange(threadId: string): void {
  if (pendingTabs && (pendingTabs.source === threadId || pendingTabs.target === threadId)) {
    cancelThreadSearchNavigation()
  }
}

export function cancelThreadSearchNavigation(): void {
  pendingTabs = null
  sequence += 1
  if (pendingTicket) releaseTicket(pendingTicket)
  pendingTicket = undefined
  useThreadSearch.setState({ navigation: null })
}

export function finishThreadSearchNavigation(id: number, failure = ""): void {
  if (!isCurrentThreadSearchNavigation(id)) return
  const navigation = useThreadSearch.getState().navigation
  if (failure && navigation?.id === id && navigation.stage === "board" && navigation.restoreSourceView) {
    withOwnedThreadSearchTransition(id, navigation.restoreSourceView)
  }
  cancelThreadSearchNavigation()
  useThreadSearch.setState({ failure })
}
