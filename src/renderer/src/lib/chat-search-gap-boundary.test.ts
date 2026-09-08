import { describe, expect, it } from "vitest"
import { resolveChatSearchContiguousTailStart } from "./chat-search-gap-boundary"

const messages = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }))

describe("chat search gap boundary", () => {
  it("starts at a directly visible boundary", () => {
    expect(resolveChatSearchContiguousTailStart(messages("old", "tail"), messages("old", "tail"), "tail"))
      .toBe(1)
  })

  it("advances from a hidden raw boundary to the next visible survivor", () => {
    expect(
      resolveChatSearchContiguousTailStart(
        messages("old", "hidden-worker", "tail-a", "tail-b"),
        messages("old", "tail-a", "tail-b"),
        "hidden-worker"
      )
    ).toBe(1)
  })

  it("fails closed when the raw boundary or a visible survivor is missing", () => {
    expect(resolveChatSearchContiguousTailStart(messages("old"), messages("old"), "missing"))
      .toBe(1)
    expect(resolveChatSearchContiguousTailStart(messages("old", "hidden"), messages("old"), "hidden"))
      .toBe(1)
  })
})
