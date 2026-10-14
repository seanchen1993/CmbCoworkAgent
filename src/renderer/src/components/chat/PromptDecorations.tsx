import { useEffect, useState, type CSSProperties, type RefObject } from "react"
import type { FunctionPromptDecoration } from "../../../../shared/mods/v2/prompt-edit"
import { clampPromptDecorationGraphemes } from "@/lib/prompt-decoration"

function color(value: string | undefined): string | undefined {
  if (!value) return undefined
  const semantic: Record<string, string> = {
    warning: "var(--color-warning, #d97706)",
    error: "var(--color-destructive, #dc2626)",
    success: "#16a34a",
    muted: "var(--color-muted-foreground)",
    foreground: "var(--color-foreground)"
  }
  return semantic[value] ?? (CSS.supports("color", value) ? value : undefined)
}

/** Paint is isolated from the actual editable textarea and never contributes submitted text. */
export function PromptDecorations({
  text,
  decorations,
  textarea,
  className
}: {
  text: string
  decorations: FunctionPromptDecoration[]
  textarea: RefObject<HTMLTextAreaElement | null>
  className: string
}) {
  const [scroll, setScroll] = useState(0)
  useEffect(() => {
    const node = textarea.current
    const update = () => setScroll(node?.scrollTop ?? 0)
    update()
    node?.addEventListener("scroll", update)
    return () => node?.removeEventListener("scroll", update)
  }, [textarea])
  if (!decorations.length) return null
  const spans = clampPromptDecorationGraphemes(text, decorations)
  const boundaries = [
    ...new Set([0, text.length, ...spans.flatMap((span) => [span.start, span.end])])
  ].sort((left, right) => left - right)
  return (
    <div
      aria-hidden="true"
      data-prompt-decorations
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <pre
        className={className}
        style={{
          margin: 0,
          transform: `translateY(-${scroll}px)`,
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          fontFamily: "ui-monospace, monospace"
        }}
      >
        {boundaries.slice(0, -1).map((start, index) => {
          const end = boundaries[index + 1]
          const merged = Object.assign(
            {},
            ...spans.filter((span) => span.start <= start && span.end >= end)
          ) as FunctionPromptDecoration
          const lines = [
            merged.underline && "underline",
            merged.strikethrough && "line-through"
          ].filter(Boolean)
          const style: CSSProperties = {
            color: color(merged.color),
            backgroundColor: color(merged.backgroundColor),
            opacity: merged.dimColor ? 0.55 : undefined,
            fontWeight: merged.bold ? "bold" : undefined,
            fontStyle: merged.italic ? "italic" : undefined,
            textDecoration: lines.length ? lines.join(" ") : undefined
          }
          return (
            <span key={start} style={style}>
              {text.slice(start, end)}
            </span>
          )
        })}
        {text.endsWith("\n") ? " " : ""}
      </pre>
    </div>
  )
}
