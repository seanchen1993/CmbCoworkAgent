import { describe, expect, it } from "vitest"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"

describe("Bot inline reasoning presentation", () => {
  it("separates streamed and completed provider reasoning", () => {
    expect(splitBotInlineReasoning("<think>检查中")).toEqual({ body: "", reasoning: "检查中" })
    expect(splitBotInlineReasoning("<think>检查完毕</think>\n合计50.75")).toEqual({ body: "合计50.75", reasoning: "检查完毕" })
  })
  it("preserves examples and tags inside ordinary content", () => {
    for (const text of ["示例 <think>text</think>", "```xml\n<think>text</think>\n```", "合计50.75"]) {
      expect(splitBotInlineReasoning(text)).toEqual({ body: text, reasoning: "" })
    }
  })
})
