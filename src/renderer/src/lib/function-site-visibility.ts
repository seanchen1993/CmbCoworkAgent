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

const observations = new Map<Element, {
  visible?: boolean
  update(intersecting: boolean): void
  stopWatchingStyle(): void
  subscribers: Set<(visible: boolean) => void>
}>()
let observer: IntersectionObserver | undefined

/** One observer for mounted sites; queued reads consult a boolean, never scroll-time layout. */
export function observeFunctionSiteVisibility(element: HTMLElement | null, onChange?: () => void) {
  const row = element?.closest<HTMLElement>("[data-chat-message-row]")
  const viewport = row?.closest<HTMLElement>("[data-radix-scroll-area-viewport]")
  const presentation = viewport && row?.closest("[data-chat-initial-presentation]")
  const presentable = (): boolean => {
    if (!row || presentation?.getAttribute("data-chat-initial-presentation") !== "pending")
      return true
    // The initial positioning probe has a box even while Virtuoso hides it.
    // Visibility is inherited, so one row style read covers the hidden wrapper.
    return row.ownerDocument.defaultView?.getComputedStyle(row).visibility === "visible"
  }
  let visible = false
  if (row && viewport && typeof IntersectionObserver !== "undefined" &&
    presentation?.getAttribute("data-chat-initial-presentation") === "ready") {
    // Virtual remounts during scrolling use the shared observer's geometry. Reading
    // layout synchronously here puts every new row on the wheel-to-paint path.
    visible = !element?.ownerDocument.hidden && observations.get(row)?.visible === true
  } else if (row && viewport && element?.isConnected && !element.ownerDocument.hidden) {
    // Chat rows have a real layout box. A scheduling hint needs only their intersection,
    // not repeated style/range reads through the same ancestor chain for every cold site.
    const box = row.getBoundingClientRect()
    const area = viewport.getBoundingClientRect()
    visible = box.width > 0 && box.height > 0 && box.bottom > area.top && box.top < area.bottom &&
      box.right > area.left && box.left < area.right && presentable()
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
        const observation = observations.get(entry.target)
        if (!observation) continue
        observation.update(entry.isIntersecting && entry.intersectionRatio > 0)
      }
    })
    const observation = observations.get(target)
    if (observation) observation.subscribers.add(changed)
    else {
      const observedTarget = target
      let styleObserver: MutationObserver | undefined
      const observation: NonNullable<ReturnType<typeof observations.get>> = {
        subscribers: new Set([changed]),
        stopWatchingStyle() {
          styleObserver?.disconnect()
          styleObserver = undefined
        },
        update(intersecting) {
          const next = intersecting && presentable()
          if (intersecting && !next && row && presentation &&
            typeof MutationObserver !== "undefined" && !styleObserver) {
            // Virtuoso clears an ancestor's visibility without necessarily moving
            // the row. Only an intersecting hidden probe needs a style subscription.
            styleObserver = new MutationObserver(() => {
              if (observations.get(observedTarget) === observation) observation.update(true)
            })
            for (let node: Element | null = row; node; node = node.parentElement) {
              styleObserver.observe(node, { attributes: true, attributeFilter: ["class", "style"] })
              if (node === presentation) break
            }
          } else if (!intersecting || next) {
            observation.stopWatchingStyle()
          }
          observation.visible = next
          for (const update of observation.subscribers) update(next)
        }
      }
      observations.set(observedTarget, observation)
      observer.observe(target)
    }
  }
  return {
    visible: () => visible,
    close: () => {
      if (!target) return
      const observation = observations.get(target)
      observation?.subscribers.delete(changed)
      if (!observation?.subscribers.size) {
        observation?.stopWatchingStyle()
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
