/** Preserve transcript ownership while an inner scroll area consumes the gesture. */
export function canChatViewportConsumeScrollGesture(
  event: Event,
  viewport: HTMLElement,
  direction: "up" | "down"
): boolean {
  if (event.defaultPrevented) return false
  const view = viewport.ownerDocument.defaultView
  if (!view) return false
  for (const target of event.composedPath()) {
    if (target === viewport) break
    if (!(target instanceof HTMLElement) || target.scrollHeight <= target.clientHeight) continue
    const style = view.getComputedStyle(target)
    if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue
    if ((direction === "up" ? target.scrollTop > 0 :
      target.scrollTop + target.clientHeight < target.scrollHeight) ||
      /^(contain|none)$/.test(style.overscrollBehaviorY)) return false
  }
  return true
}

/** Native controls consume some navigation keys without cancelling the DOM event. */
export function isChatViewportScrollKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented ||
    !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
    return false
  }
  const target = event.target
  if (!(target instanceof HTMLElement)) return true
  if (target.isContentEditable || target.closest("input, textarea, select")) return false
  // Arrow/Page keys on a button still scroll; Space activates buttons and disclosures.
  return event.key !== " " || !target.closest("button, summary")
}
