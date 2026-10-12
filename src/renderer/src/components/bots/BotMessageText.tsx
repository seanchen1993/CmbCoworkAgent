import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react"
import { AtSign, ChevronDown, Sparkles } from "lucide-react"
import type { BotMessage } from "../../../../shared/bot-types"
import type { BotInlineReferenceAddress } from "../../../../shared/bot-inline-references"
import type { BotSkillReference } from "../../../../shared/bot-skill-references"
import { botMessageLinkParts, type BotMessageLinkPart } from "../../../../shared/bot-message-links"
import { messageReferenceSpans } from "@/lib/bot-message-inline-references"
import {
  botSelectionQuoteSpans,
  validSelectionQuoteSpans,
  type BotSelectionQuoteSpan
} from "../../../../shared/bot-selection-quotes"
import { BotMessageSelectionQuote } from "./BotMessageSelectionQuote"
import { BotAvatar } from "./BotAvatar"
import { BotEntityIcon } from "./BotEntityReferences"

function literalPlainTextRange(parts: readonly BotMessageLinkPart[], from: number, to: number) {
  return parts.flatMap<ReactNode>((part) => {
    if (part.to <= from || part.from >= to) return []
    const start = Math.max(from, part.from)
    const end = Math.min(to, part.to)
    if (part.kind !== "link" || start !== part.from || end !== part.to)
      return [part.text.slice(start - part.from, end - part.from)]
    return [
      <a
        key={part.from}
        href={part.href}
        className="break-all underline underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {part.text}
      </a>
    ]
  })
}

function literalTextRange(
  parts: readonly BotMessageLinkPart[],
  from: number,
  to: number,
  quotes: readonly BotSelectionQuoteSpan[],
  open?: (messageId: string) => void
): ReactNode[] {
  const output: ReactNode[] = []
  let cursor = from
  for (const span of quotes) {
    if (span.from < from || span.to > to) continue
    if (span.from > cursor)
      output.push(
        <span key={`literal:${cursor}`} data-bot-quote-from={cursor} data-bot-quote-to={span.from}>
          {literalPlainTextRange(parts, cursor, span.from)}
        </span>
      )
    output.push(
      <BotMessageSelectionQuote key={`quote:${span.from}`} quote={span.quote} open={open} />
    )
    cursor = span.to
  }
  if (to > cursor)
    output.push(
      <span key={`literal:${cursor}`} data-bot-quote-from={cursor} data-bot-quote-to={to}>
        {literalPlainTextRange(parts, cursor, to)}
      </span>
    )
  return output
}

interface BotMessageTextProps {
  message: BotMessage
  conversationFor(reference: BotInlineReferenceAddress): string | undefined
  open(conversationId: string): void
  openSkill?(reference: BotSkillReference): void
  openQuote?(messageId: string): void
  /** Explicit message navigation reveals the original body, including a hidden match. */
  reveal?: boolean
}

const COLLAPSED_USER_MESSAGE_LINES = 24
const COLLAPSED_SYSTEM_MESSAGE_LINES = 6

/** Keep the original rich text and its UTF-16 source ranges mounted. Folding is
 * presentation only; neither delivery, quotation nor copy reads a shortened body.
 * Like Grok's message fold, measure the natural child rather than the clipped box. */
function FoldedMessageText({
  children,
  reveal,
  lines
}: {
  children: ReactNode
  reveal?: boolean
  lines: number
}) {
  const content = useRef<HTMLDivElement>(null)
  const contentId = useId()
  const [fold, setFold] = useState({ expanded: reveal === true, reveal: reveal === true })
  const [tall, setTall] = useState(false)
  // Consume a new navigation cue during render; keep the user's choice after the
  // temporary highlight clears, without an effect-driven extra render.
  if (fold.reveal !== (reveal === true))
    setFold({ expanded: reveal === true || fold.expanded, reveal: reveal === true })
  const expanded = fold.expanded
  useLayoutEffect(() => {
    const node = content.current
    if (!node) return
    let active = true
    const inspect = () => {
      if (!active) return
      const bounds = node.getBoundingClientRect()
      // Hidden workspaces have no usable layout; retain the last measured state.
      if (bounds.width <= 0) return
      const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight)
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return
      const next = bounds.height > lineHeight * lines + 1
      setTall((current) => (current === next ? current : next))
    }
    inspect()
    const observer = new ResizeObserver(inspect)
    observer.observe(node)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [lines])
  return (
    <div
      className="bot-user-message-text"
      data-expanded={expanded}
      style={{ "--bot-user-message-lines": lines } as CSSProperties}
    >
      <div
        className="bot-user-message-clip"
        data-collapsed={(tall && !expanded) || undefined}
        id={contentId}
        onFocusCapture={() => {
          // Tab may reach a link or inline reference below the visual fold.
          // Reveal before painting so a focused control never remains clipped.
          if (tall && !expanded) setFold((current) => ({ ...current, expanded: true }))
        }}
      >
        <div ref={content} className="bot-user-message-content">
          {children}
        </div>
      </div>
      {tall && (
        <button
          type="button"
          className="bot-user-message-fold"
          aria-controls={contentId}
          aria-expanded={expanded}
          data-chat-search-ignore
          data-bot-quote-ignore
          onClick={() => setFold((current) => ({ ...current, expanded: !current.expanded }))}
        >
          {expanded ? "收起" : "展开"}
          <ChevronDown size={13} aria-hidden />
        </button>
      )}
    </div>
  )
}

export function BotMessageText(props: BotMessageTextProps) {
  const body = <BotMessageTextContent {...props} />
  const lines =
    props.message.sender === "user"
      ? COLLAPSED_USER_MESSAGE_LINES
      : props.message.sender === "system"
        ? COLLAPSED_SYSTEM_MESSAGE_LINES
        : null
  // Plain Host notes retain their full body with a shorter visual fold. Dedicated
  // status/approval cards are rendered separately; Bot answers never fold here.
  // Reused rows cannot inherit another message's or sender's expanded state.
  return lines !== null ? (
    <FoldedMessageText
      key={`${props.message.conversationId}:${props.message.id}:${props.message.sender}`}
      lines={lines}
      reveal={props.reveal}
    >
      {body}
    </FoldedMessageText>
  ) : (
    body
  )
}

function BotMessageTextContent({
  message,
  conversationFor,
  open,
  openSkill,
  openQuote
}: BotMessageTextProps) {
  const spans = messageReferenceSpans(message)
  const parts = botMessageLinkParts(message.text)
  const selected = botSelectionQuoteSpans.safeParse(message.selectionQuotes ?? [])
  const quotes =
    selected.success && validSelectionQuoteSpans(message.text, selected.data) ? selected.data : []
  if (!spans.length)
    return (
      <span className="whitespace-pre-wrap">
        {literalTextRange(parts, 0, message.text.length, quotes, openQuote)}
      </span>
    )
  return (
    <span className="whitespace-pre-wrap" data-inline-message>
      {spans.map((span, index) => {
        const prefix = literalTextRange(
          parts,
          spans[index - 1]?.to ?? 0,
          span.from,
          quotes,
          openQuote
        )
        const reference = span.reference,
          label = message.text.slice(span.from, span.to)
        const target = conversationFor(reference)
        const content = (
          <>
            {reference.kind === "bot" || reference.kind === "recipient" ? (
              <BotAvatar agentId={reference.id} size="xs" isStatic />
            ) : reference.kind === "skill" ? (
              <Sparkles size={13} aria-hidden />
            ) : reference.kind === "everyone" ? (
              <AtSign size={13} aria-hidden />
            ) : (
              <BotEntityIcon kind={reference.kind} />
            )}
            <span className="bot-inline-reference-label">{label}</span>
          </>
        )
        const title = reference.kind === "skill" ? `${label} · v${reference.version}` : label
        return (
          <Fragment key={span.from}>
            {prefix}
            {target || (reference.kind === "skill" && openSkill) ? (
              <button
                type="button"
                className="bot-inline-reference bot-message-inline-reference"
                data-kind={reference.kind}
                title={title}
                onClick={() => {
                  if (reference.kind === "skill" && openSkill)
                    openSkill({
                      botId: reference.botId,
                      id: reference.id,
                      version: reference.version,
                      name: label.slice(1)
                    })
                  else if (target) open(target)
                }}
              >
                {content}
              </button>
            ) : (
              <span
                className="bot-inline-reference bot-message-inline-reference"
                data-kind={reference.kind}
                title={title}
              >
                {content}
              </span>
            )}
          </Fragment>
        )
      })}
      {literalTextRange(parts, spans.at(-1)!.to, message.text.length, quotes, openQuote)}
    </span>
  )
}
