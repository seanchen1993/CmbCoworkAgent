import { Quote } from "lucide-react"
import type { BotSelectionQuote } from "../../../../shared/bot-selection-quotes"

export function BotMessageSelectionQuote({
  quote,
  open
}: {
  quote: BotSelectionQuote
  open?(messageId: string): void
}) {
  const content = (
    <>
      <Quote size={14} aria-hidden />
      <span className="bot-selection-quote-content">
        <span className="bot-selection-quote-label">
          引用消息{quote.truncated ? " · 已截取" : ""}
        </span>
        <span className="bot-selection-quote-excerpt">{quote.text}</span>
      </span>
    </>
  )
  return open ? (
    <button
      type="button"
      className="bot-selection-quote bot-message-selection-quote"
      aria-label="查看引用的原消息"
      title={quote.text}
      onClick={() => open(quote.sourceMessageId)}
    >
      {content}
    </button>
  ) : (
    <span className="bot-selection-quote" title={quote.text}>
      {content}
    </span>
  )
}
