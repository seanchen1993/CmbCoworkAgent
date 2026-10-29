import { describe, expect, it } from "vitest"
import { placeFunctionTurnNotices } from "./turn-notice-placement"
import type { FunctionTurnNotice } from "./turn"

const messages = [
  { id: "turn-a", role: "user" },
  { id: "answer-a", role: "assistant" },
  { id: "turn-b", role: "user" },
  { id: "answer-b", role: "assistant" }
]
const notice = (turnId: string, anchorMessageId?: string): FunctionTurnNotice => ({
  id: `notice:${turnId}`,
  turnId,
  text: "Extra",
  ...(anchorMessageId ? { anchorMessageId } : {})
})

describe("host turn notice placement", () => {
  it("keeps each notice at its actual message when another turn arrives", () => {
    const a = notice("turn-a", "answer-a")
    const b = notice("turn-b", "answer-b")
    expect([...placeFunctionTurnNotices(messages, [0, 1, 2, 3], [a, b])]).toEqual([
      ["answer-a", [a]],
      ["answer-b", [b]]
    ])
    expect(a.anchorMessageId).toBe("answer-a")
  })

  it("places an empty assistant's notice after a visible row in the same resident turn", () => {
    const a = notice("turn-a", "answer-a")
    expect([...placeFunctionTurnNotices(messages, [0, 2, 3], [a])]).toEqual([["turn-a", [a]]])
    expect(placeFunctionTurnNotices(messages, [0, 2, 3], [a], "answer-a").size).toBe(0)
    expect(placeFunctionTurnNotices(messages, [2, 3], [a]).size).toBe(0)
  })

  it("keeps pre-response cancellation at the actual user message", () => {
    const a = notice("turn-a")
    expect([...placeFunctionTurnNotices(messages, [0, 1, 2, 3], [a])]).toEqual([["turn-a", [a]]])
    expect(placeFunctionTurnNotices(messages, [1, 2, 3], [a]).size).toBe(0)
  })

  it("does not move missing history notices onto a newer turn", () => {
    expect(
      placeFunctionTurnNotices(messages.slice(2), [0, 1], [notice("turn-a", "answer-a")]).size
    ).toBe(0)
    expect(
      placeFunctionTurnNotices(messages, [0, 1, 2, 3], [notice("turn-a", "missing")]).size
    ).toBe(0)
  })

  it("requires a unique provider id match within the known resident turn", () => {
    const history = [
      { id: "turn-a", role: "user" },
      { id: "reused", role: "assistant", provider_source_id: "reused" },
      { id: "turn-b", role: "user" },
      { id: "normalized-b", role: "assistant", provider_source_id: "reused" }
    ]
    const b = notice("turn-b", "reused")
    expect([...placeFunctionTurnNotices(history, [0, 1, 2, 3], [b])]).toEqual([
      ["normalized-b", [b]]
    ])
    expect(placeFunctionTurnNotices(history, [0, 1, 2, 3], [b], "normalized-b").size).toBe(0)
    history.push({ id: "ambiguous", role: "assistant", provider_source_id: "reused" })
    expect(placeFunctionTurnNotices(history, [0, 1, 2, 3, 4], [b]).size).toBe(0)
  })

  it("keeps multiple completions in order without modifying input or requiring the older user row", () => {
    const a = notice("turn-a", "answer-a")
    const next = { ...a, id: "next", text: "Second" }
    Object.freeze(a)
    const result = placeFunctionTurnNotices(messages.slice(1), [0, 1, 2], Object.freeze([a, next]))
    expect(result.get("answer-a")).toEqual([a, next])
  })
})
