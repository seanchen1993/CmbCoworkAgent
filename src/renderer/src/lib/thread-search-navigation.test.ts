import { describe, expect, it } from "vitest"
import {
  cancelThreadSearchNavigation,
  cancelThreadSearchOnTabChange,
  isCurrentThreadSearchNavigation,
  isOwnedThreadSearchTransition,
  isThreadSearchSurface,
  openThreadSearch,
  reserveThreadSearchNavigation,
  useThreadSearch,
  withOwnedThreadSearchTransition,
  type ThreadSearchNavigation
} from "./thread-search-navigation"

describe("cross-conversation search panel", () => {
  it("uses a new query scope each time the panel reopens", () => {
    const before = useThreadSearch.getState().openingVersion
    try {
      openThreadSearch()
      expect(useThreadSearch.getState().openingVersion).toBe(before + 1)
      openThreadSearch()
      expect(useThreadSearch.getState().openingVersion).toBe(before + 1)

      useThreadSearch.setState({ open: false })
      openThreadSearch()
      expect(useThreadSearch.getState().openingVersion).toBe(before + 2)
    } finally {
      useThreadSearch.setState({ open: false, openingVersion: before })
    }
  })

  it("freezes the project context until the panel is reopened", () => {
    try {
      useThreadSearch.setState({ projectId: "project-a", open: false })
      openThreadSearch(true)
      useThreadSearch.setState({ projectId: "project-b" })
      openThreadSearch(true)
      expect(useThreadSearch.getState().origin).toEqual({ projectMode: true, projectId: "project-a" })
      useThreadSearch.setState({ open: false })
      openThreadSearch(true)
      expect(useThreadSearch.getState().origin).toEqual({ projectMode: true, projectId: "project-b" })
    } finally {
      useThreadSearch.setState({ open: false, projectId: null, origin: null })
    }
  })

  it("rejects a superseded route owner and clears ownership after the transition", () => {
    const a = reserveThreadSearchNavigation()
    const b = reserveThreadSearchNavigation()
    expect(withOwnedThreadSearchTransition(a, () => { throw new Error("stale") })).toBe(false)
    expect(withOwnedThreadSearchTransition(b, () => {
      expect(isOwnedThreadSearchTransition()).toBe(true)
    })).toBe(true)
    expect(isOwnedThreadSearchTransition()).toBe(false)
    cancelThreadSearchNavigation()
  })

  it("cancels on a file switch in the source during pending route validation", () => {
    const id = reserveThreadSearchNavigation("source", "destination")
    cancelThreadSearchOnTabChange("unrelated")
    expect(isCurrentThreadSearchNavigation(id)).toBe(true)
    cancelThreadSearchOnTabChange("source")
    expect(isCurrentThreadSearchNavigation(id)).toBe(false)
  })

  it("enables reveal only for the committed route and the exact target panel", () => {
    const route = { kind: "featureSession", projectId: "project", slug: "feature" } as const
    const request: ThreadSearchNavigation = {
      id: 1,
      query: "test",
      navigationTicketId: "ticket",
      route,
      result: {
        route, matchedBy: "title", navigation: "threadOnly", target: null,
        threadId: "thread", incarnation: { token: null, legacyCreatedAt: 1 },
        title: "test", workspacePath: null, frozenUpdatedAt: 1, snippet: "test", snippetRanges: []
      },
      stage: "board-mounting"
    }
    expect(isThreadSearchSurface(request, "thread", "harness-project", route)).toBe(false)
    const committed = { ...request, stage: "chat" as const }
    expect(isThreadSearchSurface(committed, "thread", "harness-project", route)).toBe(true)
    expect(isThreadSearchSurface(committed, "thread", "harness-feature-session", route)).toBe(false)
    expect(isThreadSearchSurface(committed, "other", "harness-project", route)).toBe(false)
    expect(isThreadSearchSurface(committed, "thread", "default", null)).toBe(false)
    expect(isThreadSearchSurface(committed, "thread", "harness-project", {
      ...route, slug: "other"
    })).toBe(false)
  })
})
