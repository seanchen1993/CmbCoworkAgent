import { expect, it } from "vitest"
import {
  composerDocument,
  composerDocumentChange,
  composerDocumentPayload,
  composerDraftSelectionQuotes,
  parseComposerDocument
} from "./bot-composer-document"
import { quoteText, type BotSelectionQuote } from "../../../shared/bot-selection-quotes"

const quote = (id: string, text: string): BotSelectionQuote => ({
  sourceMessageId: id,
  sourceConversationId: "conversation",
  sourceSequence: 1,
  sourceDataEpoch: "current",
  sourceFragment: { from: 0, to: text.length },
  selection: { from: 0, to: text.length },
  text,
  truncated: false
})
it("keeps multiple quote identities alongside the existing skill, draft and attachments", () => {
  const first = quote("first", "first excerpt"),
    second = quote("second", "second excerpt")
  const draft = {
    prompt: "existing work",
    attachments: [{ path: "saved-artifact", name: "notes.txt" }],
    skills: [{ botId: "bot", id: "skill", version: 1, name: "Review" }]
  }
  const original = composerDocument(draft)
  const document = {
    type: "doc",
    content: [
      ...original.content,
      {
        type: "paragraph",
        content: [{ type: "quoteReference", attrs: { quote: first } }]
      },
      {
        type: "paragraph",
        content: [{ type: "quoteReference", attrs: { quote: second } }]
      },
      { type: "paragraph", content: [{ type: "text", text: "Compare them." }] }
    ]
  }
  const change = composerDocumentChange(document, draft)!
  const accepted = { ...draft, ...change }
  expect(accepted.attachments).toEqual(draft.attachments)
  expect(accepted.skills).toEqual(draft.skills)
  const payload = composerDocumentPayload(composerDocument(accepted))
  expect(payload.selectionQuotes.map(({ quote }) => quote.sourceMessageId)).toEqual([
    "first",
    "second"
  ])
  expect(payload.selectionQuotes.map((span) => payload.text.slice(span.from, span.to))).toEqual([
    quoteText(first),
    quoteText(second)
  ])
  expect(composerDraftSelectionQuotes(accepted)).toEqual(payload.selectionQuotes)
  expect(composerDraftSelectionQuotes({ ...accepted, prompt: "external edit" })).toEqual([])
})
it("rejects too many quote atoms and text over the original total message limit", () => {
  const node = {
    type: "quoteReference",
    attrs: { quote: quote("source", "excerpt") }
  }
  expect(
    parseComposerDocument({
      type: "doc",
      content: [{ type: "paragraph", content: Array.from({ length: 7 }, () => node) }]
    })
  ).toBeNull()
  const large = {
    type: "quoteReference",
    attrs: { quote: quote("source", "a".repeat(20_000)) }
  }
  expect(
    parseComposerDocument({
      type: "doc",
      content: [{ type: "paragraph", content: [large, large, large, large] }]
    })
  ).toBeNull()
})
