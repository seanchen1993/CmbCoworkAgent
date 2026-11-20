import { describe, expect, it } from "vitest"
import {
  MESSAGE_ID_INDEX_THRESHOLD,
  createMessageIdIndexLookup
} from "./lazy-message-id-index"

function createCountedMessages(count: number): {
  messages: Array<{ readonly id: string }>
  getReadCount: () => number
} {
  let readCount = 0
  const messages = Array.from({ length: count }, (_, index) => ({
    get id() {
      readCount += 1
      return `message-${index}`
    }
  }))
  return { messages, getReadCount: () => readCount }
}

describe("lazy message id index", () => {
  it("does not allocate or scan until the first lookup", () => {
    const { messages, getReadCount } = createCountedMessages(MESSAGE_ID_INDEX_THRESHOLD)

    createMessageIdIndexLookup(messages)

    expect(getReadCount()).toBe(0)
  })

  it("keeps short transcript lookups linear instead of retaining a map", () => {
    const { messages, getReadCount } = createCountedMessages(MESSAGE_ID_INDEX_THRESHOLD - 1)
    const lookup = createMessageIdIndexLookup(messages)

    expect(lookup.findFirstIndex("message-0")).toBe(0)
    expect(lookup.findFirstIndex("message-0")).toBe(0)
    expect(getReadCount()).toBe(2)
  })

  it("builds one reusable index for a long transcript", () => {
    const { messages, getReadCount } = createCountedMessages(MESSAGE_ID_INDEX_THRESHOLD)
    const lookup = createMessageIdIndexLookup(messages)

    expect(lookup.findFirstIndex(`message-${MESSAGE_ID_INDEX_THRESHOLD - 1}`)).toBe(
      MESSAGE_ID_INDEX_THRESHOLD - 1
    )
    expect(getReadCount()).toBe(MESSAGE_ID_INDEX_THRESHOLD)

    expect(lookup.findFirstIndex("message-0")).toBe(0)
    expect(lookup.findFirstIndex("missing")).toBe(-1)
    expect(getReadCount()).toBe(MESSAGE_ID_INDEX_THRESHOLD)
  })

  it("keeps repeated streaming lookups to one traversal of a 10k history", () => {
    const messageCount = 10_000
    const { messages, getReadCount } = createCountedMessages(messageCount)
    const lookup = createMessageIdIndexLookup(messages)

    for (let update = 0; update < 1_000; update += 1) {
      expect(lookup.findFirstIndex(`message-${messageCount - 1}`)).toBe(messageCount - 1)
    }

    expect(getReadCount()).toBe(messageCount)
  })

  it("preserves findIndex first-match semantics for duplicate ids", () => {
    const messages = Array.from({ length: MESSAGE_ID_INDEX_THRESHOLD }, (_, index) => ({
      id: index === MESSAGE_ID_INDEX_THRESHOLD - 1 ? "message-0" : `message-${index}`
    }))

    expect(createMessageIdIndexLookup(messages).findFirstIndex("message-0")).toBe(0)
  })
})
