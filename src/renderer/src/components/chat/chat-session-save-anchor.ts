import type { ChatScrollSessionAnchor } from "./chat-scroll-session-store"
import { isChatRowPresented } from "./chat-row-presentation"

/** Internal inert frames remain painted; interaction ownership is checked by FunctionSite. */
function isRenderedText(node: Text, parent: HTMLElement): boolean {
  if (parent.closest('[aria-hidden="true"]')) return false
  const view = parent.ownerDocument.defaultView
  if (!view) return false
  if (typeof parent.checkVisibility === "function") {
    if (parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true
    if (view.getComputedStyle(parent).display !== "contents") return false
  }
  // Contents has no principal box. Bound both the ancestor walk and the measured text prefix.
  let ancestor: HTMLElement | null = parent
  for (let visited = 0; ancestor && visited < 64; visited++, ancestor = ancestor.parentElement) {
    const computed = view.getComputedStyle(ancestor)
    if (computed.display === "none" || computed.visibility === "hidden" ||
      computed.visibility === "collapse" || computed.opacity === "0" ||
      computed.contentVisibility === "hidden") return false
  }
  if (ancestor) return false
  const range = node.ownerDocument.createRange()
  range.setStart(node, 0)
  range.setEnd(node, Math.min(node.length, 256))
  return Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)
}

function hasBoundedReadableText(site: HTMLElement): boolean {
  // Count every node, including empty wrappers, so deeply nested markup is bounded too.
  const walker = site.ownerDocument.createTreeWalker(site, NodeFilter.SHOW_ALL)
  for (let visited = 0; visited < 64; visited++) {
    const node = walker.nextNode()
    if (!node) break
    if (node.nodeType !== Node.TEXT_NODE) continue
    const parent = node.parentElement
    if (!parent || parent.closest("script, style, template, noscript") ||
      !/\S/.test((node as Text).substringData(0, 256))) continue
    if (isRenderedText(node as Text, parent)) return true
  }
  return false
}

export function hasReadableChatSessionBody(row: HTMLElement): boolean {
  return !row.querySelector("[data-function-site-pending]") && isChatRowPresented(row) &&
    Array.from(row.querySelectorAll<HTMLElement>(
      '[data-function-site="UserMessage"], [data-function-site="AssistantMessage"], ' +
      '[data-function-site="CommandOutput"]'
    )).some(hasBoundedReadableText)
}

/** Prefer the text being read; retain the original mounted-row fallback for cold views. */
export function selectChatSessionSaveAnchor(viewport: HTMLElement): ChatScrollSessionAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  let fallback: ChatScrollSessionAnchor | null = null
  let readable: ChatScrollSessionAnchor | null = null
  let fallbackDistance = Number.POSITIVE_INFINITY
  let readableDistance = Number.POSITIVE_INFINITY
  for (const candidate of viewport.querySelectorAll<HTMLElement>("[data-chat-message-id]")) {
    const messageId = candidate.dataset.chatMessageId
    if (!messageId) continue
    const rect = candidate.getBoundingClientRect()
    const offsetFromViewportTop = rect.top - bounds.top
    const distance = Math.abs(offsetFromViewportTop)
    const anchor = { messageId, offsetFromViewportTop }
    if (distance < fallbackDistance) {
      fallbackDistance = distance
      fallback = anchor
    }
    if (distance >= readableDistance || rect.width <= 0 || rect.height <= 0 ||
      rect.bottom <= bounds.top || rect.top >= bounds.bottom ||
      candidate.querySelector("[data-function-site-pending]") || !isChatRowPresented(candidate)) continue
    if (!hasReadableChatSessionBody(candidate)) continue
    readableDistance = distance
    readable = anchor
  }
  return readable ?? fallback
}
