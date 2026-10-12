import { expect, it } from "vitest"
import {
  botQuoteSourceProjection,
  quoteText,
  validSelectionQuoteSpans,
  botSelectionQuoteSpans,
  type BotSelectionQuote
} from "./bot-selection-quotes"

const quote: BotSelectionQuote = {
  sourceMessageId: "source",
  sourceConversationId: "conversation",
  sourceSequence: 1,
  sourceDataEpoch: "current",
  sourceFragment: { from: 0, to: 12 },
  selection: { from: 0, to: 5 },
  text: "a\nb😀",
  truncated: false
}
it("projects formatted Markdown through the same parser as the message surface", () => {
  expect(botQuoteSourceProjection("**strong** and [label](https://example.com)", true)).toBe(
    "strong and label"
  )
  expect(botQuoteSourceProjection("```ts\nconst a = 1\n```", true)).toBe("const a = 1\n")
  expect(botQuoteSourceProjection("<script>alert(1)</script>", true)).toBe(
    "<script>alert(1)</script>"
  )
  expect(botQuoteSourceProjection("**literal user text**", false)).toBe("**literal user text**")
})
it("serializes literal excerpts without reinterpreting source text as a selected identity", () => {
  const value = quoteText(quote)
  expect(value).toBe("> a\n> b😀")
  const span = { from: 0, to: value.length, quote }
  expect(validSelectionQuoteSpans(value, [span])).toBe(true)
  expect(validSelectionQuoteSpans(value, [span, span])).toBe(false)
  expect(validSelectionQuoteSpans("changed", [span])).toBe(false)
  expect(botSelectionQuoteSpans.safeParse(Array.from({ length: 7 }, () => span)).success).toBe(
    false
  )
})
