import { describe, expect, it } from "vitest"
import {
  CHAT_SEARCH_DOCUMENT_TEXT_LIMIT,
  buildBoundedChatSearchText
} from "./bounded-chat-search-text"

describe("bounded chat search text", () => {
  it("keeps nested field names and values searchable", () => {
    expect(
      buildBoundedChatSearchText([
        { name: "inspect_workspace", args: { path: "src/needle.ts" } },
        "assistant answer"
      ])
    ).toContain("src/needle.ts")
  })

  it("hard-caps a single huge string", () => {
    const text = buildBoundedChatSearchText(["x".repeat(CHAT_SEARCH_DOCUMENT_TEXT_LIMIT * 2)])
    expect(text).toHaveLength(CHAT_SEARCH_DOCUMENT_TEXT_LIMIT)
  })

  it("does not enumerate an unbounded array after the entry budget", () => {
    let indexedReads = 0
    const values = new Proxy(Array.from({ length: 100_000 }, () => "tiny"), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1
        return Reflect.get(target, property, receiver)
      }
    })

    const text = buildBoundedChatSearchText([values])
    expect(text).toContain("[Truncated array]")
    expect(indexedReads).toBeLessThanOrEqual(256)
  })

  it("handles cycles without falling back to JSON.stringify", () => {
    const value: { label: string; self?: unknown } = { label: "needle" }
    value.self = value
    expect(buildBoundedChatSearchText([value])).toContain("[Circular]")
  })
})
