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

const observations = new Map<Element, Set<(visible: boolean) => void>>()
let observer: IntersectionObserver | undefined

/** One observer for mounted sites; queued reads consult a boolean, never scroll-time layout. */
export function observeFunctionSiteVisibility(element: HTMLElement | null, onChange?: () => void) {
  const row = element?.closest<HTMLElement>("[data-chat-message-row]")
  const viewport = row?.closest<HTMLElement>("[data-radix-scroll-area-viewport]")
  let visible = false
  if (row && viewport && element?.isConnected && !element.ownerDocument.hidden) {
    // Chat rows have a real layout box. A scheduling hint needs only their intersection,
    // not repeated style/range reads through the same ancestor chain for every cold site.
    const box = row.getBoundingClientRect()
    const area = viewport.getBoundingClientRect()
    visible = box.width > 0 && box.height > 0 && box.bottom > area.top && box.top < area.bottom &&
      box.right > area.left && box.left < area.right
  } else {
    visible = isFunctionSiteInViewport(element)
  }
  // Transcript sites use display:contents. Observe the nearest layout box instead:
  // observing the section itself would report zero area even when its text is visible.
  let target = row ?? element
  const view = element?.ownerDocument.defaultView
  while (!row && target && view?.getComputedStyle(target).display === "contents")
    target = target.parentElement
  const changed = (value: boolean) => {
    if (visible === value) return
    visible = value
    onChange?.()
  }
  if (target && typeof IntersectionObserver !== "undefined") {
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // The initial transcript is intentionally clipped until protected rows are ready.
        // Preserve its initial geometry hint; clipping must not demote all cold visible rows.
        if (entry.target.closest('[data-chat-initial-presentation="pending"]')) continue
        for (const update of observations.get(entry.target) ?? [])
          update(entry.isIntersecting && entry.intersectionRatio > 0)
      }
    })
    const subscribers = observations.get(target) ?? new Set()
    subscribers.add(changed)
    observations.set(target, subscribers)
    observer.observe(target)
  }
  return {
    visible: () => visible,
    close: () => {
      if (!target) return
      const subscribers = observations.get(target)
      subscribers?.delete(changed)
      if (!subscribers?.size) {
        observer?.unobserve(target)
        observations.delete(target)
      }
      if (!observations.size) {
        observer?.disconnect()
        observer = undefined
      }
    }
  }
}
