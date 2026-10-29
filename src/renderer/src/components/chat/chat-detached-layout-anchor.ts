import { isChatRowPresented } from "./chat-row-presentation"
import { CHAT_SCROLL_NAVIGATION_EVENT, isChatScrollNavigationActive } from "./chat-scroll-navigation"

interface DetachedLayoutAnchorOptions {
  root: HTMLElement
  viewport: HTMLElement
  /** Null yields to following/restoration; a new lease invalidates a programmatic reveal. */
  readLease: () => number | null
}

interface VisibleAnchor {
  element: HTMLElement
  messageId: string
  offset: number
  pending: boolean
}

/** Preserve a detached reader's row, while actual scrolling always owns its new position. */
export function installChatDetachedLayoutAnchor({
  root,
  viewport,
  readLease
}: DetachedLayoutAnchorOptions): () => void {
  const scrollRoot = viewport.parentElement ?? viewport
  const ownerDocument = viewport.ownerDocument
  let lease: number | null = null
  let anchor: VisibleAnchor | null = null
  let frame: number | undefined
  let measurementFrame: number | undefined
  let captureRequested = false
  let scrollbarPointer: number | null = null
  let pointerX = 0
  let pointerY = 0
  let wheelIntentUntil = 0
  let awaitingSizes = false

  const enabled = (): boolean => {
    const next = readLease()
    const navigating = isChatScrollNavigationActive(viewport)
    if (next !== lease || next === null || navigating) anchor = null
    lease = next
    return next !== null && !navigating && root.isConnected && viewport.isConnected
  }
  const sampleAnchor = (): VisibleAnchor | null => {
    const bounds = viewport.getBoundingClientRect()
    let pendingAnchor: VisibleAnchor | null = null
    for (const element of root.querySelectorAll<HTMLElement>("[data-chat-message-row]")) {
      const rect = element.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
        // A verified cached body can remain readable while its FunctionSite refresh is busy.
        const pending = Boolean(element.querySelector("[data-function-site-pending]")) ||
          !isChatRowPresented(element)
        const candidate = { element, messageId: element.dataset.chatMessageId ?? "",
          offset: rect.top - bounds.top, pending }
        if (pending) {
          pendingAnchor ??= candidate
          continue
        }
        return candidate
      }
    }
    return pendingAnchor
  }
  const capture = (): void => {
    anchor = null
    if (!enabled()) return
    anchor = sampleAnchor()
    const list = root.querySelector('[data-testid="virtuoso-item-list"]')
    if (list) resize.observe(list)
  }
  const correct = (): void => {
    if (!enabled() || captureRequested || performance.now() < wheelIntentUntil) return
    if (!anchor) {
      capture()
      return
    }
    if (anchor.pending) {
      const readable = sampleAnchor()
      if (readable && !readable.pending) {
        // A short pending B can be pushed out by an earlier A becoming readable first.
        // Retaining B's old offset would scroll that new readable A away. Promote before
        // any compensation, then preserve A for subsequent independent height changes.
        anchor = readable
        return
      }
    }
    // Remember newly presented content before Virtuoso's pending size transaction can move it.
    // The barrier postpones writes only; it must not discard this first readable position.
    if (awaitingSizes) return
    if (!root.contains(anchor.element) || anchor.element.dataset.chatMessageId !== anchor.messageId) {
      anchor = null
      return
    }
    const offset = anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    const delta = offset - anchor.offset
    if (Math.abs(delta) <= 0.5) return
    const previousTop = viewport.scrollTop
    const desired = previousTop + delta
    const top = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, desired))
    if (Math.abs(top - viewport.scrollTop) > 0.5) viewport.scrollTop = top
    // A boundary cannot preserve an out-of-range offset. Rebase once rather than accumulating it.
    if (Math.abs(top - desired) > 0.5) anchor.offset = offset - (top - previousTop)
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (captureRequested) {
        captureRequested = false
        capture()
      } else correct()
    })
  }
  const requestCapture = (): void => {
    captureRequested = true
    schedule()
  }
  const onNavigationChange = (): void => {
    // The index write and exact-occurrence centering can span several layout transactions.
    // Rebase only after their owner releases; an earlier reading row must not undo them.
    anchor = null
    requestCapture()
  }
  const onScroll = (): void => {
    if (!enabled()) return
    if (captureRequested || performance.now() < wheelIntentUntil) requestCapture()
    else {
      correct()
      schedule()
    }
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (!event.composedPath().some(target => target instanceof HTMLElement &&
      target.hasAttribute("data-scroll-area-scrollbar"))) return
    anchor = null
    scrollbarPointer = event.pointerId
    pointerX = event.clientX
    pointerY = event.clientY
    requestCapture()
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (scrollbarPointer !== event.pointerId ||
      (pointerX === event.clientX && pointerY === event.clientY)) return
    pointerX = event.clientX
    pointerY = event.clientY
    // Capture after Radix consumes this movement. Never correct against the preceding pointer.
    requestCapture()
  }
  const onPointerEnd = (event: PointerEvent): void => {
    if (scrollbarPointer !== event.pointerId) return
    scrollbarPointer = null
    schedule()
  }
  const onWheelOrTouch = (): void => {
    wheelIntentUntil = performance.now() + 120
    requestCapture()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    if (ownerDocument.activeElement !== ownerDocument.body &&
      !scrollRoot.contains(ownerDocument.activeElement)) return
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)) return
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      onWheelOrTouch()
    }
  }
  const onMutation = (records: MutationRecord[]): void => {
    if (records.some(record => (record.target instanceof Element ? record.target :
      record.target.parentElement)?.closest("[data-chat-message-row]"))) {
      awaitingSizes = true
      if (measurementFrame === undefined) {
        // A class-only mutation, or equal growth/shrink in two rows, need not resize the list.
        // Give its normal measurement transaction two frames, then clear this barrier once.
        measurementFrame = requestAnimationFrame(() => {
          measurementFrame = requestAnimationFrame(() => {
            measurementFrame = undefined
            awaitingSizes = false
            correct()
          })
        })
      }
    }
    // Let Virtuoso consume the changed item sizes before writing scrollTop. Writing against its
    // previous size tree can recycle the very row being preserved. Spacer commits need one check.
    // The last input can precede the new range's DOM. Its first materialization gets
    // one coalesced read capture, even if no previous row was available to preserve.
    if (!anchor && enabled()) requestCapture()
    else if (anchor || captureRequested) schedule()
  }
  const mutation = new MutationObserver(onMutation)
  mutation.observe(root, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["style", "class", "data-function-site-pending"] })
  const resize = new ResizeObserver(() => {
    if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame)
    measurementFrame = undefined
    awaitingSizes = false
    correct()
    if (anchor || captureRequested) schedule()
  })
  resize.observe(root)
  viewport.addEventListener("scroll", onScroll, { passive: true })
  viewport.addEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigationChange)
  viewport.addEventListener("wheel", onWheelOrTouch, { passive: true })
  viewport.addEventListener("touchmove", onWheelOrTouch, { passive: true })
  scrollRoot.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true })
  ownerDocument.addEventListener("pointermove", onPointerMove, { capture: true, passive: true })
  ownerDocument.addEventListener("pointerup", onPointerEnd, true)
  ownerDocument.addEventListener("pointercancel", onPointerEnd, true)
  ownerDocument.addEventListener("keydown", onKeyDown, true)
  return () => {
    mutation.disconnect()
    resize.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame)
    viewport.removeEventListener("scroll", onScroll)
    viewport.removeEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigationChange)
    viewport.removeEventListener("wheel", onWheelOrTouch)
    viewport.removeEventListener("touchmove", onWheelOrTouch)
    scrollRoot.removeEventListener("pointerdown", onPointerDown, true)
    ownerDocument.removeEventListener("pointermove", onPointerMove, true)
    ownerDocument.removeEventListener("pointerup", onPointerEnd, true)
    ownerDocument.removeEventListener("pointercancel", onPointerEnd, true)
    ownerDocument.removeEventListener("keydown", onKeyDown, true)
    anchor = null
  }
}
