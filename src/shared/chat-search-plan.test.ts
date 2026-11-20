import { describe, expect, it } from "vitest"
import { createChatSearchPlan, CHAT_SEARCH_INPUT_LIMIT } from "./chat-search-plan"
import { projectVisibleChatSearchContentWithMetadata } from "./chat-search-visible-content"

describe("message search input budget", () => {
  it("preserves system content fallbacks even for malformed legacy text blocks", () => {
    const result = projectVisibleChatSearchContentWithMetadata(
      "system",
      [{ type: "text", content: "visible notice" }],
      { includeFoldedContent: true }
    )
    expect(result.text).toBe("visible notice")
  })
  it("retains the visible tail when a long answer completes", () => {
    const text = `HEAD_TARGET\n\n${"x".repeat(300_000)}\n\nTAIL_TARGET`
    const result = projectVisibleChatSearchContentWithMetadata("assistant", text, {
      includeFoldedContent: true
    })
    expect(result.text).toContain("HEAD_TARGET")
    expect(result.text).toContain("TAIL_TARGET")
    expect(result.truncated).toBe(true)
  })

  it("shares the input budget before projecting any of 32 large blocks", () => {
    const content = Array.from({ length: 32 }, () => ({
      type: "text",
      text: "paragraph **bold** and `code`.\n\n".repeat(10_000)
    }))
    const plan = createChatSearchPlan("assistant", content)
    expect(plan.segments.reduce((sum, segment) => sum + segment.raw.length, 0)).toBeLessThanOrEqual(
      CHAT_SEARCH_INPUT_LIMIT
    )
    expect(plan.truncated).toBe(true)
    expect(plan.segments.some((segment) => segment.blockIndex === 31)).toBe(true)
    const projected = projectVisibleChatSearchContentWithMetadata("assistant", content, {
      includeFoldedContent: true
    })
    expect(projected.text.length).toBeLessThanOrEqual(CHAT_SEARCH_INPUT_LIMIT)
  })

  it("does not enumerate an unbounded block array or renumber original blocks", () => {
    const blocks: unknown[] = [{ type: "image" }, { type: "text", text: "visible" }]
    blocks.length = 100_000
    Object.defineProperty(blocks, 128, {
      get() {
        throw new Error("unbounded read")
      }
    })
    const plan = createChatSearchPlan("assistant", blocks)
    expect(plan.segments[0].blockIndex).toBe(1)
    expect(plan.truncated).toBe(true)
  })
})
