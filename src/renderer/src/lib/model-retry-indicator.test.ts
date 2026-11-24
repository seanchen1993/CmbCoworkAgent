import { describe, expect, it } from "vitest"
import { captureModelRetryBaseline, hasModelRetryProgress } from "./model-retry-indicator"
import type { LiveStreamMessage } from "./live-stream-messages"

const ai = (id: string, content: LiveStreamMessage["content"]): LiveStreamMessage => ({
  id,
  type: "ai",
  content
})

describe("model retry progress", () => {
  const before = ai("draft", "Earlier assistant text")
  const baseline = captureModelRetryBaseline([before])

  it("ignores the old text and a shorter replay of the same message", () => {
    expect(hasModelRetryProgress(baseline, [before])).toBe(false)
    expect(hasModelRetryProgress(baseline, [ai("draft", "Earlier assistant")])).toBe(false)
  })

  it("recognizes new text even when the frame shrank or reused the message ID", () => {
    expect(hasModelRetryProgress(baseline, [ai("recovered", "OK")])).toBe(true)
    expect(hasModelRetryProgress(baseline, [ai("draft", "OK")])).toBe(true)
    expect(hasModelRetryProgress(baseline, [ai("draft", "Earlier assistant text continues")])).toBe(
      true
    )
  })

  it("requires visible assistant text", () => {
    const nonTextProgress: LiveStreamMessage[] = [
      before,
      ai("empty", " \n "),
      { ...ai("reasoning", ""), reasoning: "Still thinking" },
      ai("reasoning-block", [{ type: "reasoning", text: "Still thinking" }]),
      { id: "tool", type: "tool", content: "Tool result" },
      { id: "user", type: "human", content: "User input" }
    ]
    expect(hasModelRetryProgress(baseline, nonTextProgress)).toBe(false)
    expect(
      hasModelRetryProgress(baseline, [
        ...nonTextProgress,
        ai("reply", [{ type: "text", text: "The answer" }])
      ])
    ).toBe(true)
  })
})
