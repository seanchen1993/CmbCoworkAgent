import {
  botSelectionQuoteSpans,
  botQuoteSourceProjection,
  quoteUtf16Boundary,
  validSelectionQuoteSpans,
  type BotSelectionQuoteSpan
} from "../../shared/bot-selection-quotes"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"

/** Uses the original send transaction and writer; no additional runtime or task. */
export class BotSelectionQuotes {
  constructor(private readonly store: BotStore) {}
  parse(text: string, input: unknown): BotSelectionQuoteSpan[] {
    const parsed = botSelectionQuoteSpans.safeParse(input ?? [])
    if (!parsed.success || !validSelectionQuoteSpans(text, parsed.data))
      throw new BotDomainError("invalid_selection_quote", "引用选区格式无效，请重新选择")
    return parsed.data
  }
  resolve(
    conversationId: string,
    threadRootId: string | undefined,
    spans: readonly BotSelectionQuoteSpan[]
  ): BotSelectionQuoteSpan[] {
    for (const { quote } of spans) {
      this.store.assertMutationEpoch(quote.sourceDataEpoch)
      if (
        quote.sourceConversationId !== conversationId ||
        (quote.sourceThreadRootId !== threadRootId && quote.sourceMessageId !== threadRootId)
      )
        throw new BotDomainError("selection_quote_scope", "引用不属于当前对话或讨论")
      const row = this.store.db.exec(
        `SELECT m.sequence,m.sender,m.text,t.root_id FROM bot_messages m
         LEFT JOIN bot_message_threads t ON t.message_id=m.id
         WHERE m.id=? AND m.conversation_id=?
           AND NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=m.id)`,
        [quote.sourceMessageId, conversationId]
      )[0]?.values[0]
      if (
        !row ||
        Number(row[0]) !== quote.sourceSequence ||
        row[1] === "system" ||
        (row[3] === null ? undefined : String(row[3])) !== quote.sourceThreadRootId
      )
        throw new BotDomainError("selection_quote_unavailable", "引用来源已变化，请重新选择")
      const source = String(row[2]),
        { sourceFragment, selection } = quote
      if (
        sourceFragment.to > source.length ||
        !quoteUtf16Boundary(source, sourceFragment.from) ||
        !quoteUtf16Boundary(source, sourceFragment.to)
      )
        throw new BotDomainError("selection_quote_unavailable", "引用来源选区已变化")
      const display = botQuoteSourceProjection(
        source.slice(sourceFragment.from, sourceFragment.to),
        row[1] === "bot"
      )
      if (
        selection.to > display.length ||
        !quoteUtf16Boundary(display, selection.from) ||
        !quoteUtf16Boundary(display, selection.to) ||
        display.slice(selection.from, selection.to) !== quote.text
      )
        throw new BotDomainError("selection_quote_unavailable", "引用内容与来源不一致，请重新选择")
    }
    return spans.map((span) => ({
      ...span,
      quote: {
        ...span.quote,
        sourceFragment: { ...span.quote.sourceFragment },
        selection: { ...span.quote.selection }
      }
    }))
  }
  save(messageId: string, spans: readonly BotSelectionQuoteSpan[]): void {
    if (spans.length)
      this.store.db.run("INSERT INTO bot_message_selection_quotes VALUES(?,?)", [
        messageId,
        JSON.stringify(spans)
      ])
  }
  forMessages(ids: readonly string[]): Map<string, BotSelectionQuoteSpan[]> {
    const result = new Map<string, BotSelectionQuoteSpan[]>()
    if (!ids.length) return result
    // Message paging already caps ids at 200, avoiding an unbounded per-row query.
    const rows =
      this.store.db.exec(
        `SELECT message_id,spans FROM bot_message_selection_quotes WHERE message_id IN (${ids.map(() => "?").join(",")})`,
        [...ids]
      )[0]?.values ?? []
    for (const [id, spans] of rows)
      result.set(String(id), botSelectionQuoteSpans.parse(JSON.parse(String(spans))))
    return result
  }
}
