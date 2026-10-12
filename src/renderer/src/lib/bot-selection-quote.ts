import type { BotMessage } from "../../../shared/bot-types"
import {
  botQuoteSourceProjection,
  BOT_SELECTION_QUOTE_TEXT_LIMIT,
  BOT_SELECTION_QUOTE_FRAGMENT_LIMIT,
  quoteUtf16Boundary,
  type BotSelectionQuote
} from "../../../shared/bot-selection-quotes"

export interface BotMessageQuoteScope {
  viewId: string
  conversationId: string
  threadRootId?: string
  dataEpoch: string
  active: boolean
  messages: readonly BotMessage[]
}
export interface BotSelectedMessageQuote {
  viewId: string
  expectedText: string
  quote: BotSelectionQuote
}
const forbidden =
  'button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[inert],[aria-hidden="true"],[data-chat-search-ignore]'
const element = (node: Node | null) =>
  node instanceof Element ? node : (node?.parentElement ?? null)
function visibleText(fragment: DocumentFragment): string {
  for (const hidden of fragment.querySelectorAll("[data-chat-search-ignore]")) hidden.remove()
  return fragment.textContent ?? ""
}
function inDiscussion(message: BotMessage, scope: BotMessageQuoteScope): boolean {
  return (
    message.conversationId === scope.conversationId &&
    (message.threadRootId === scope.threadRootId || message.id === scope.threadRootId)
  )
}

/** Synchronous intent from one actual message text surface. No clipboard access,
 * selectionchange listener, global key handler or arbitrary-document quotation. */
export function captureBotMessageQuote(
  root: HTMLElement,
  selection: Selection | null,
  scope: BotMessageQuoteScope
): BotSelectedMessageQuote | null {
  if (
    !scope.active ||
    !scope.viewId ||
    !root.isConnected ||
    !selection ||
    selection.rangeCount !== 1 ||
    selection.isCollapsed
  )
    return null
  const start = element(selection.anchorNode),
    end = element(selection.focusNode)
  if (!start || !end || start.closest(forbidden) || end.closest(forbidden)) return null
  const body = start.closest<HTMLElement>("[data-bot-quote-source]")
  if (
    !body ||
    !root.contains(body) ||
    !body.contains(end) ||
    end.closest("[data-bot-quote-source]") !== body
  )
    return null
  const article = body.closest<HTMLElement>("article[data-message-id]")
  const id = body.dataset.botQuoteSource
  if (!id || article?.dataset.messageId !== id) return null
  const source = scope.messages.find((message) => message.id === id)
  if (
    !source ||
    source.sender === "system" ||
    source.routineOutcome ||
    source.importedContext ||
    source.skillTrial ||
    !inDiscussion(source, scope)
  )
    return null
  const range = selection.getRangeAt(0)
  if (range.cloneContents().querySelector(forbidden)) return null
  // Each folded Markdown fragment has its real source range. A selection spanning
  // an omitted middle, hidden card or separate fragment is never guessed.
  const markdown = source.sender === "bot"
  const fragment = markdown
    ? start.closest<HTMLElement>("[data-chat-search-text]")
    : (start.closest<HTMLElement>("[data-bot-quote-from]") ?? body)
  if (!fragment || !body.contains(fragment) || !fragment.contains(end)) return null
  const from = markdown
    ? Number(fragment.dataset.chatSearchSourceStart)
    : Number(fragment.dataset.botQuoteFrom ?? 0)
  const to = markdown
    ? Number(fragment.dataset.chatSearchSourceEnd)
    : Number(fragment.dataset.botQuoteTo ?? source.text.length)
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > source.text.length ||
    to - from > BOT_SELECTION_QUOTE_FRAGMENT_LIMIT ||
    !quoteUtf16Boundary(source.text, from) ||
    !quoteUtf16Boundary(source.text, to)
  )
    return null
  let display: string
  try {
    display = botQuoteSourceProjection(source.text.slice(from, to), markdown)
  } catch {
    return null
  }
  const full = document.createRange()
  full.selectNodeContents(fragment)
  if (visibleText(full.cloneContents()) !== display) return null
  const prefix = document.createRange()
  prefix.selectNodeContents(fragment)
  prefix.setEnd(range.startContainer, range.startOffset)
  let selectionFrom = visibleText(prefix.cloneContents()).length
  const selected = visibleText(range.cloneContents())
  const trimmed = selected.trim()
  if (!trimmed) return null
  selectionFrom += selected.length - selected.trimStart().length
  let length = Math.min(trimmed.length, BOT_SELECTION_QUOTE_TEXT_LIMIT)
  if (!quoteUtf16Boundary(trimmed, length)) length--
  const text = trimmed.slice(0, length)
  const selectionTo = selectionFrom + text.length
  if (
    !quoteUtf16Boundary(display, selectionFrom) ||
    !quoteUtf16Boundary(display, selectionTo) ||
    display.slice(selectionFrom, selectionTo) !== text
  )
    return null
  return {
    viewId: scope.viewId,
    expectedText: source.text,
    quote: {
      sourceMessageId: source.id,
      sourceConversationId: source.conversationId,
      ...(source.threadRootId ? { sourceThreadRootId: source.threadRootId } : {}),
      sourceSequence: source.sequence,
      sourceDataEpoch: scope.dataEpoch,
      sourceFragment: { from, to },
      selection: { from: selectionFrom, to: selectionTo },
      text,
      truncated: trimmed.length > text.length
    }
  }
}
export function currentBotMessageQuote(
  intent: BotSelectedMessageQuote,
  scope: BotMessageQuoteScope
): boolean {
  if (
    !scope.active ||
    scope.viewId !== intent.viewId ||
    scope.dataEpoch !== intent.quote.sourceDataEpoch
  )
    return false
  const source = scope.messages.find((message) => message.id === intent.quote.sourceMessageId)
  return (
    !!source &&
    source.sender !== "system" &&
    !source.routineOutcome &&
    !source.importedContext &&
    !source.skillTrial &&
    inDiscussion(source, scope) &&
    source.conversationId === intent.quote.sourceConversationId &&
    source.threadRootId === intent.quote.sourceThreadRootId &&
    source.sequence === intent.quote.sourceSequence &&
    source.text === intent.expectedText
  )
}
