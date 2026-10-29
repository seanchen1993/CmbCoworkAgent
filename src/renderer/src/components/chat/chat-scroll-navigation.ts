export const CHAT_SCROLL_NAVIGATION_EVENT = "chat-scroll-navigation-change"

const navigationLeases = new WeakMap<HTMLElement, object>()

export function isChatScrollNavigationActive(viewport: HTMLElement): boolean {
  return navigationLeases.has(viewport)
}

/** A search owns its viewport until its exact occurrence has settled or is cancelled. */
export function beginChatScrollNavigation(viewport: HTMLElement): () => void {
  const lease = {}
  navigationLeases.set(viewport, lease)
  viewport.dispatchEvent(new Event(CHAT_SCROLL_NAVIGATION_EVENT))
  return () => {
    if (navigationLeases.get(viewport) !== lease) return
    navigationLeases.delete(viewport)
    viewport.dispatchEvent(new Event(CHAT_SCROLL_NAVIGATION_EVENT))
  }
}
