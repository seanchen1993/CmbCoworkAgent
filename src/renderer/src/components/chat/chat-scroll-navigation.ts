export const CHAT_SCROLL_NAVIGATION_EVENT = "chat-scroll-navigation-change"
import { claimChatViewportScrollOwner, hasChatViewportScrollOwner } from "./chat-viewport-scroll-owner"

export function isChatScrollNavigationActive(viewport: HTMLElement): boolean {
  return hasChatViewportScrollOwner(viewport, "search")
}

/** A search owns its viewport until its exact occurrence has settled or is cancelled. */
export function beginChatScrollNavigation(viewport: HTMLElement): () => void {
  const lease = claimChatViewportScrollOwner(viewport, "search")
  viewport.dispatchEvent(new Event(CHAT_SCROLL_NAVIGATION_EVENT))
  return () => {
    if (!lease.release()) return
    viewport.dispatchEvent(new Event(CHAT_SCROLL_NAVIGATION_EVENT))
  }
}
