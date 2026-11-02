import { useEffect, useRef } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useReasoningExpansion } from "../chat/reasoning-expansion-context"
import { normalizeVisibleReasoningText } from "@/lib/message-display-visibility"

export function DesignReasoning({
  id,
  reasoning,
  isStreaming = false,
  isThinking = false,
  hasAnswer = false,
}: {
  id: string
  reasoning?: string
  isStreaming?: boolean
  isThinking?: boolean
  hasAnswer?: boolean
}) {
  const text = normalizeVisibleReasoningText(reasoning)
  const [open, toggle] = useReasoningExpansion(id, Boolean(text), isStreaming, hasAnswer)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (isThinking && open && content.current) content.current.scrollTop = content.current.scrollHeight
  }, [text, isThinking, open])
  if (!text) return null

  return (
    <div data-testid="design-reasoning" style={{ minWidth: 0, marginBottom: 8 }}>
      <button type="button" onClick={toggle} aria-expanded={open} style={{
        display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 6,
        border: "1px solid var(--border, #e5e2db)", background: "var(--muted, #f4f3ef)",
        padding: "4px 8px", color: "var(--muted-foreground, #80796e)", fontSize: 12, cursor: "pointer",
      }}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{isThinking ? "思考中…" : "思考"}</span>
      </button>
      {open && <div ref={content} aria-label="模型思考内容" data-chat-search-ignore style={{
        marginTop: 8, maxHeight: 180, overflow: "auto", padding: "8px 10px",
        border: "1px solid var(--border, #e5e2db)", borderRadius: 6,
        background: "var(--muted, #f4f3ef)", color: "var(--muted-foreground, #80796e)",
        fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      }}>{text}</div>}
    </div>
  )
}
