import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import {
  quoteText,
  botQuoteSourceProjection,
  type BotSelectionQuote,
  type BotSelectionQuoteSpan
} from "../../shared/bot-selection-quotes"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bot = store.createBot({ nonce: "bot", name: "Worker" })
  const source = (nonce: string, text: string) => {
    const receipt = store.send({
      nonce,
      conversationId: bot.conversationId,
      text
    })
    return store.message({
      conversationId: bot.conversationId,
      id: receipt.messageId
    })
  }
  const quote = (
    message: ReturnType<typeof source>,
    from = 0,
    to = message.text.length
  ): BotSelectionQuote => ({
    sourceMessageId: message.id,
    sourceConversationId: message.conversationId,
    sourceSequence: message.sequence,
    sourceDataEpoch: store.dataEpoch(),
    sourceFragment: { from: 0, to: message.text.length },
    selection: { from, to },
    text: message.text.slice(from, to),
    truncated: false
  })
  const input = (quotes: BotSelectionQuote[], nonce = "selected") => {
    let text = ""
    const selectionQuotes: BotSelectionQuoteSpan[] = []
    for (const quote of quotes) {
      if (text) text += "\n"
      const from = text.length
      text += quoteText(quote)
      selectionQuotes.push({ from, to: text.length, quote })
    }
    text += "\nCompare the selected excerpts."
    return { nonce, conversationId: bot.conversationId, text, selectionQuotes }
  }
  return { store, bot, source, quote, input }
}
it("persists two independently bound sources atomically with the original send receipt", () => {
  const f = fixture()
  const first = f.source("first", "First source"),
    second = f.source("second", "Second source")
  const input = f.input([f.quote(first), f.quote(second)])
  const receipt = f.store.send(input)
  expect(f.store.send(input)).toEqual(receipt)
  const stored = f.store.message({
    conversationId: f.bot.conversationId,
    id: receipt.messageId
  })
  expect(stored.selectionQuotes?.map(({ quote }) => quote.sourceMessageId)).toEqual([
    first.id,
    second.id
  ])
  expect(stored.replyTo).toBeNull()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_message_selection_quotes")[0].values[0][0]).toBe(
    1
  )
})
it("rejects an invented excerpt and leaves no accepted message or nonce receipt", () => {
  const f = fixture(),
    source = f.source("source", "Actual source")
  const quoted = { ...f.quote(source), text: "Invented text" }
  const before = f.store.messages(f.bot.conversationId).length
  expect(() => f.store.send(f.input([quoted]))).toThrow(
    expect.objectContaining({ code: "selection_quote_unavailable" })
  )
  expect(f.store.messages(f.bot.conversationId)).toHaveLength(before)
  expect(f.store.hasSendReceipt("selected")).toBe(false)
})
it("rejects a source from a different conversation even if its message exists", () => {
  const f = fixture(),
    source = f.source("source", "Actual source")
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  expect(() =>
    f.store.send({
      ...f.input([f.quote(source)]),
      conversationId: other.conversationId
    })
  ).toThrow(expect.objectContaining({ code: "selection_quote_scope" }))
})
it("rejects stale source epochs instead of retargeting a restored message identity", () => {
  const f = fixture(),
    source = f.source("source", "Actual source")
  expect(() =>
    f.store.send(f.input([{ ...f.quote(source), sourceDataEpoch: "retired-epoch" }]))
  ).toThrow(expect.objectContaining({ code: "data_epoch" }))
})
it("rejects a half-surrogate excerpt without starting any new run", () => {
  const f = fixture(),
    source = f.source("source", "A😀B")
  expect(() => f.store.send(f.input([f.quote(source, 1, 2)]))).toThrow(
    expect.objectContaining({ code: "selection_quote_unavailable" })
  )
  expect(f.store.hasSendReceipt("selected")).toBe(false)
})

it("binds a visible Markdown excerpt to its immutable formatted Bot answer", () => {
  const f = fixture()
  f.source("work", "Reply with the source material")
  const lease = f.store.claim("host", 300_000)!
  f.store.finish(lease.lease, "succeeded", "**strong** and [label](https://example.com)")
  const response = f.store
    .messages(f.bot.conversationId)
    .find((message) => message.sender === "bot")!
  const text = botQuoteSourceProjection(response.text, true)
  const selected = { ...f.quote(response), selection: { from: 0, to: text.length }, text }
  const receipt = f.store.send(f.input([selected]))
  expect(
    f.store.message({ conversationId: f.bot.conversationId, id: receipt.messageId })
      .selectionQuotes?.[0].quote.text
  ).toBe("strong and label")
})
