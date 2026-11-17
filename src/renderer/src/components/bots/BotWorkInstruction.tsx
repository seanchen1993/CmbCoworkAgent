import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

// Match ordinary user messages, including the existing chat-search expansion contract.
const COLLAPSED_HEIGHT = 260

export function BotWorkInstruction({ label, text }: { label: string; text: string }): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = (): void => setOverflow(content.scrollHeight > COLLAPSED_HEIGHT + 8)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [text])

  return (
    <section className="bot-work-instruction" aria-label="Bot 交办说明">
      <div className="bot-work-instruction-label">{label}</div>
      <div
        ref={contentRef}
        data-chat-search-user-content-collapse-threshold={COLLAPSED_HEIGHT}
        className="bot-work-instruction-text"
        style={overflow && !expanded ? {
          maxHeight: COLLAPSED_HEIGHT,
          overflow: "hidden",
          maskImage: "linear-gradient(to bottom, black 60%, transparent)"
        } : undefined}
      >
        {text}
      </div>
      {overflow && (
        <button
          type="button"
          data-chat-search-expand-user-content
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground/80 hover:text-foreground"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {expanded ? "收起" : "显示更多"}
        </button>
      )}
    </section>
  )
}
