import { describe, expect, it } from "vitest"
import {
  createChatSearchMatcher,
  shouldHydrateDurableSearchMatch,
  type ChatSearchCorpus,
  type ChatSearchDocument
} from "./chat-search-matches"

function corpus(stableDocuments: readonly ChatSearchDocument[]): ChatSearchCorpus {
  return { stableDocuments, dynamicDocuments: [], dynamicMessageIds: new Set() }
}

describe("incremental stable chat search matcher", () => {
  it("reveals a resident durable result even when the bounded local corpus omitted it", () => {
    const localCorpus = corpus([{ messageId: "local-only", text: "needle" }])
    const residentIndexes = new Map([["resident-outside-local-corpus", 501]])

    expect(
      createChatSearchMatcher()(localCorpus, "needle").some(
        (match) => match.messageId === "resident-outside-local-corpus"
      )
    ).toBe(false)
    expect(
      shouldHydrateDurableSearchMatch("resident-outside-local-corpus", residentIndexes)
    ).toBe(false)
    expect(shouldHydrateDurableSearchMatch("released-message", residentIndexes)).toBe(true)
  })

  it("recomputes only one replaced document out of 500", () => {
    let reads = 0
    const document = (index: number, text: string): ChatSearchDocument => ({
      messageId: `m-${index}`,
      sortIndex: index,
      get text() {
        reads += 1
        return text
      }
    })
    const initial = Array.from({ length: 500 }, (_, index) => document(index, "ordinary"))
    const matcher = createChatSearchMatcher()
    expect(matcher(corpus(initial), "needle")).toEqual([])
    expect(reads).toBe(500)

    reads = 0
    const replacement = document(499, "new needle")
    const next = [...initial.slice(0, -1), replacement]
    expect(matcher(corpus(next), "needle")).toEqual([
      { messageId: "m-499", occurrenceIndex: 0, sortIndex: 499 }
    ])
    expect(reads).toBe(1)
  })

  it("handles deletion, reordering, and the global max without stale matches", () => {
    const matcher = createChatSearchMatcher(2)
    const first = { messageId: "first", text: "needle", sortIndex: 1 }
    const second = { messageId: "second", text: "needle needle", sortIndex: 2 }
    expect(matcher(corpus([first, second]), "needle").map((match) => match.messageId))
      .toEqual(["first", "second"])
    expect(matcher(corpus([second]), "needle")).toEqual([
      { messageId: "second", occurrenceIndex: 0, sortIndex: 2 },
      { messageId: "second", occurrenceIndex: 1, sortIndex: 2 }
    ])
  })
})
