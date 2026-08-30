import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChatSearchMatch } from "@/lib/chat-search-matches"
import {
  CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT,
  CHAT_SEARCH_PREVIEW_LIMIT,
  boundDurableSearchPreview,
  collectNeedleOffsets,
  createLeadingTrailingThrottle,
  formatChatSearchStatus,
  isSearchableChatTextNode,
  mergeChatSearchResults,
  prepareUserContentForSearchHighlight,
  scanDurableChatSearch,
  type DurableChatSearchMatch,
  type DurableChatSearchPage
} from "./ChatSearchOverlay"

function durableMatch(
  messageId: string,
  ordinal: number,
  occurrenceCount = 1,
  preview = `preview ${messageId}`
): DurableChatSearchMatch {
  return {
    messageId,
    ordinal,
    role: "assistant",
    createdAt: ordinal,
    occurrenceCount,
    preview
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("chat search max-wait throttle", () => {
  it("runs leading and max-wait calls during a token stream that never becomes quiet", () => {
    vi.useFakeTimers()
    const values: number[] = []
    const throttle = createLeadingTrailingThrottle((value: number) => values.push(value), 120, 480)

    throttle.schedule(0)
    expect(values).toEqual([0])

    for (let value = 1; value <= 4; value += 1) {
      vi.advanceTimersByTime(100)
      throttle.schedule(value)
    }
    expect(values).toEqual([0])

    // The trailing quiet timer keeps moving, but the fixed max-wait does not.
    vi.advanceTimersByTime(80)
    expect(values).toEqual([0, 4])

    vi.advanceTimersByTime(20)
    throttle.schedule(5)
    throttle.schedule(6)
    expect(values).toEqual([0, 4, 5])
    vi.advanceTimersByTime(120)
    expect(values).toEqual([0, 4, 5, 6])
  })

  it("cancels a queued trailing recompute", () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const throttle = createLeadingTrailingThrottle(callback, 120, 480)

    throttle.schedule("leading")
    throttle.schedule("trailing")
    throttle.cancel()
    vi.runAllTimers()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenLastCalledWith("leading")
  })
})

describe("durable chat search scanning", () => {
  it("advances across an empty page, yields, and bounds expanded occurrences and previews", async () => {
    const oversizedPreview = `  ${"long preview ".repeat(80)}  `
    const pages: DurableChatSearchPage[] = [
      {
        matches: [],
        beforeOrdinal: 300,
        beforeMessageId: "cursor-300",
        hasMore: true,
        scanned: 100
      },
      {
        matches: [
          durableMatch("already-loaded", 275, 500),
          durableMatch("message-a", 250, 2, oversizedPreview)
        ],
        beforeOrdinal: 200,
        beforeMessageId: "cursor-200",
        hasMore: true,
        scanned: 100
      },
      {
        matches: [durableMatch("message-b", 150, 50)],
        beforeOrdinal: 100,
        beforeMessageId: "cursor-100",
        hasMore: true,
        scanned: 100
      }
    ]
    const search = vi.fn(async () => pages.shift() as DurableChatSearchPage)
    const yieldControl = vi.fn(async () => undefined)
    const progress = vi.fn()

    const result = await scanDurableChatSearch({
      query: "needle",
      search,
      maxOccurrences: 3,
      getLocalCoverage: (messageId) => ({
        occurrenceCount: messageId === "already-loaded" ? 500 : 0,
        authoritative: messageId === "already-loaded"
      }),
      yieldControl,
      onProgress: progress
    })

    expect(search.mock.calls).toEqual([
      ["needle", { limit: 100 }],
      [
        "needle",
        { beforeOrdinal: 300, beforeMessageId: "cursor-300", limit: 100 }
      ],
      [
        "needle",
        { beforeOrdinal: 200, beforeMessageId: "cursor-200", limit: 100 }
      ]
    ])
    expect(yieldControl).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenCalledTimes(3)
    expect(progress.mock.calls[0][0].addedMatches).toEqual([])
    expect(result).toMatchObject({
      retainedOccurrenceCount: 3,
      pageCount: 3,
      scanned: 300,
      truncated: true,
      cancelled: false
    })
    expect(result.matches.map((match) => [match.messageId, match.occurrenceCount])).toEqual([
      ["message-a", 2],
      ["message-b", 1]
    ])
    expect(result.matches[0].preview.length).toBeLessThanOrEqual(CHAT_SEARCH_PREVIEW_LIMIT)
    expect(result.matches[0].preview.endsWith("…")).toBe(true)
  })

  it("drops a page resolved for an obsolete query generation", async () => {
    let activeGeneration = 1
    let resolvePage: ((page: DurableChatSearchPage) => void) | undefined
    const search = vi.fn(
      () =>
        new Promise<DurableChatSearchPage>((resolve) => {
          resolvePage = resolve
        })
    )
    const progress = vi.fn()
    const pending = scanDurableChatSearch({
      query: "old query",
      search,
      shouldContinue: () => activeGeneration === 1,
      onProgress: progress
    })

    await Promise.resolve()
    activeGeneration = 2
    resolvePage?.({
      matches: [durableMatch("stale", 1)],
      beforeOrdinal: null,
      beforeMessageId: null,
      hasMore: false,
      scanned: 1
    })

    await expect(pending).resolves.toMatchObject({ cancelled: true, matches: [] })
    expect(progress).not.toHaveBeenCalled()
  })

  it("terminates a non-advancing cursor instead of looping forever", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        matches: [],
        beforeOrdinal: 10,
        beforeMessageId: "same",
        hasMore: true,
        scanned: 100
      })
      .mockResolvedValueOnce({
        matches: [],
        beforeOrdinal: 10,
        beforeMessageId: "same",
        hasMore: true,
        scanned: 100
      })

    const result = await scanDurableChatSearch({
      query: "rare",
      search,
      yieldControl: async () => undefined
    })

    expect(search).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ pageCount: 2, truncated: true, cancelled: false })
  })
})

describe("bounded renderer search results", () => {
  it("collects only indexed body and folded-tool text regions", () => {
    const bodyArea = { kind: "body" }
    const toolArea = { kind: "tool" }
    const row = {
      contains: (area: unknown) => area === bodyArea || area === toolArea
    } as unknown as HTMLElement
    const node = (area: unknown): Node =>
      ({
        nodeValue: "needle",
        parentElement: {
          tagName: "SPAN",
          closest: () => area
        }
      }) as unknown as Node

    expect(isSearchableChatTextNode(node(null), row)).toBe(false) // CMBDevClaw heading
    expect(isSearchableChatTextNode(node(null), row)).toBe(false) // reasoning button
    expect(isSearchableChatTextNode(node(bodyArea), row)).toBe(true)
    expect(isSearchableChatTextNode(node(toolArea), row)).toBe(true)
    expect(isSearchableChatTextNode(node(null), row)).toBe(false) // expanded raw details
    expect(isSearchableChatTextNode(node(null), row)).toBe(false) // tool status
  })

  it("does not restore a durable false hit for an authoritative loaded zero-match row", async () => {
    const result = await scanDurableChatSearch({
      query: "secret",
      search: async () => ({
        matches: [durableMatch("loaded-reasoning", 10, 1)],
        beforeOrdinal: null,
        beforeMessageId: null,
        hasMore: false
      }),
      getLocalCoverage: () => ({ occurrenceCount: 0, authoritative: true })
    })
    expect(result.matches).toEqual([])
  })

  it("excludes user chips while keeping user body and system notice text searchable", () => {
    const userBodyArea = { kind: "user-body" }
    const systemNoticeArea = { kind: "system-notice" }
    const row = {
      contains: (area: unknown) => area === userBodyArea || area === systemNoticeArea
    } as unknown as HTMLElement
    const node = (area: unknown): Node =>
      ({
        nodeValue: "same-name",
        parentElement: { tagName: "SPAN", closest: () => area }
      }) as unknown as Node

    expect(isSearchableChatTextNode(node(null), row)).toBe(false) // Skill/browser chip
    expect(isSearchableChatTextNode(node(userBodyArea), row)).toBe(true)
    expect(isSearchableChatTextNode(node(systemNoticeArea), row)).toBe(true)
  })

  it("ignores Markdown controls without exposing them as searchable ranges", () => {
    const bodyArea = { kind: "markdown" }
    const ignoredArea = { kind: "copy-button" }
    const searchableRow = {
      contains: (area: unknown) => area === bodyArea || area === ignoredArea
    } as unknown as HTMLElement
    const ignoredNode = {
      parentElement: {
        tagName: "SPAN",
        closest: (selector: string) =>
          selector === "[data-chat-search-text]" ? bodyArea : ignoredArea
      }
    } as unknown as Node
    expect(isSearchableChatTextNode(ignoredNode, searchableRow)).toBe(false)
  })

  it("expands a clipped user body before collecting highlight ranges", () => {
    const click = vi.fn()
    const content = {
      dataset: { chatSearchUserContentCollapseThreshold: "260" },
      scrollHeight: 700
    }
    const collapsedButton = {
      getAttribute: () => "false",
      click
    }
    const row = {
      querySelector: (selector: string) =>
        selector.includes("collapse-threshold") ? content : collapsedButton
    } as unknown as HTMLElement

    expect(prepareUserContentForSearchHighlight(row)).toBe(true)
    expect(click).toHaveBeenCalledOnce()

    const measuringRow = {
      querySelector: (selector: string) =>
        selector.includes("collapse-threshold") ? content : null
    } as unknown as HTMLElement
    expect(prepareUserContentForSearchHighlight(measuringRow)).toBe(true)

    const expandedRow = {
      querySelector: (selector: string) =>
        selector.includes("collapse-threshold")
          ? content
          : { getAttribute: () => "true", click }
    } as unknown as HTMLElement
    expect(prepareUserContentForSearchHighlight(expandedRow)).toBe(false)
  })

  it("does not render a duplicate durable-history preview row below the search controls", () => {
    const source = readFileSync(new URL("./ChatSearchOverlay.tsx", import.meta.url), "utf8")

    expect(source).not.toContain("data-chat-search-durable-preview")
    expect(source).not.toContain("历史消息：")
  })

  it("preserves local/live matches, de-duplicates durable message ids, and caps expansion", () => {
    const localMatches: ChatSearchMatch[] = [
      { messageId: "loaded", occurrenceIndex: 0, sortIndex: 10 },
      { messageId: "dynamic", occurrenceIndex: 0, sortIndex: 11 }
    ]
    const merged = mergeChatSearchResults(
      localMatches,
      [
        durableMatch("loaded", 10, 4),
        durableMatch("oldest", 1, 3),
        durableMatch("older", 2, 3)
      ],
      3
    )

    expect(merged.truncated).toBe(true)
    expect(merged.matches.map((match) => match.messageId)).toEqual([
      "oldest",
      "loaded",
      "dynamic"
    ])
    expect(merged.matches.filter((match) => match.messageId === "loaded")).toHaveLength(1)
  })

  it("retains durable occurrences beyond a truncated local document", () => {
    const merged = mergeChatSearchResults(
      [{ messageId: "large", occurrenceIndex: 0, sortIndex: 10 }],
      [{ ...durableMatch("large", 10, 1), occurrenceOffset: 1 }],
      10
    )
    expect(merged.matches.map((match) => match.occurrenceIndex)).toEqual([0, 1])
  })

  it("caps CSS match offsets and durable preview allocation", () => {
    const offsets = collectNeedleOffsets(
      "x".repeat(CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT + 200),
      "x"
    )
    expect(offsets).toHaveLength(CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT)
    expect(offsets.at(-1)).toBe(CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT - 1)

    const preview = boundDurableSearchPreview(" word\n".repeat(500))
    expect(preview.length).toBeLessThanOrEqual(CHAT_SEARCH_PREVIEW_LIMIT)
    expect(preview).not.toContain("\n")
  })

  it("reports scanning, failure, and truncation states explicitly", () => {
    expect(formatChatSearchStatus(true, 0, 0, true, false, false)).toBe("扫描中…")
    expect(formatChatSearchStatus(true, 2, 0, false, true, false)).toBe("1/2 · 已截断")
    expect(formatChatSearchStatus(true, 0, 0, false, false, true)).toBe("历史搜索失败")
  })
})
