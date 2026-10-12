import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { closeHistory } from "@tiptap/pm/history"
import { Quote, X } from "lucide-react"
import { botSelectionQuote } from "../../../../shared/bot-selection-quotes"

export function BotSelectionQuoteView({ node, editor, getPos, selected }: NodeViewProps) {
  const parsed = botSelectionQuote.safeParse(node.attrs.quote)
  if (!parsed.success) return <NodeViewWrapper as="span" contentEditable={false} />
  const quote = parsed.data
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="bot-selection-quote"
      data-selected={selected || undefined}
    >
      <Quote size={14} aria-hidden />
      <span className="bot-selection-quote-content" title={quote.text}>
        <span className="bot-selection-quote-label">
          引用消息{quote.truncated ? " · 已截取" : ""}
        </span>
        <span className="bot-selection-quote-excerpt">{quote.text}</span>
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label="移除引用片段"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const position = getPos()
          if (typeof position === "number")
            editor
              .chain()
              .focus()
              .command(({ tr }) => {
                closeHistory(tr)
                return true
              })
              .deleteRange({ from: position, to: position + node.nodeSize })
              .run()
        }}
      >
        <X size={12} />
      </button>
    </NodeViewWrapper>
  )
}
