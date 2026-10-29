/** A measured box may still belong to Virtuoso's hidden initial probe. */
export function isChatRowPresented(row: HTMLElement): boolean {
  if (!row.isConnected || row.closest(
    '[data-chat-initial-presentation="pending"], [aria-hidden="true"], [inert]'
  )) return false
  if (typeof row.checkVisibility === "function") {
    return row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
  const view = row.ownerDocument.defaultView
  if (!view) return false
  for (let element: HTMLElement | null = row; element; element = element.parentElement) {
    const style = view.getComputedStyle(element)
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false
    }
  }
  return true
}
