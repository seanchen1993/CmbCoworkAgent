/** Scheduling hint only: never grants display/action authority or retains an expired frame.
 * Read at cold mount, not for every appended token. A contents wrapper needs its content range.
 */
export function isFunctionSiteInViewport(element: HTMLElement | null): boolean {
  if (!element?.isConnected) return false
  const view = element.ownerDocument.defaultView
  if (!view || element.ownerDocument.hidden) return false
  let rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    rect = range.getBoundingClientRect()
    range.detach()
  }
  let left = Math.max(0, rect.left),
    top = Math.max(0, rect.top)
  let right = Math.min(view.innerWidth, rect.right),
    bottom = Math.min(view.innerHeight, rect.bottom)
  if (![left, top, right, bottom].every(Number.isFinite)) return false
  let current: HTMLElement | null = element
  let depth = 0
  while (current && depth++ < 64) {
    const style = view.getComputedStyle(current)
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    )
      return false
    if (current !== element && style.display !== "contents") {
      const bounds = current.getBoundingClientRect()
      if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {
        left = Math.max(left, bounds.left)
        right = Math.min(right, bounds.right)
      }
      if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {
        top = Math.max(top, bounds.top)
        bottom = Math.min(bottom, bounds.bottom)
      }
    }
    if (right <= left || bottom <= top) return false
    current = current.parentElement
  }
  return current === null && right > left && bottom > top
}
