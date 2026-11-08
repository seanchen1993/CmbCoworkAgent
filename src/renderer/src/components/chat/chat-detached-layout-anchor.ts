import { isChatRowPresented } from "./chat-row-presentation"
import {
  CHAT_SCROLL_NAVIGATION_EVENT,
  isChatScrollNavigationActive
} from "./chat-scroll-navigation"

const CHAT_DETACHED_ANCHOR_OWNER_RELEASED = "chat-detached-anchor-owner-released"

/** Capture the restored geometry before another content measurement can change it. */
export function notifyChatDetachedAnchorOwnerReleased(viewport: HTMLElement): void {
  viewport.dispatchEvent(new Event(CHAT_DETACHED_ANCHOR_OWNER_RELEASED))
}

interface DetachedLayoutAnchorOptions {
  root: HTMLElement
  viewport: HTMLElement
  /** Null yields to following/restoration; a new lease invalidates a programmatic reveal. */
  readLease: () => number | null
  correctPendingAnchorLayout?: () => boolean
  hasPendingAnchorLayout?: () => boolean
  acquireScrollAnchor?: () => () => void
  prepareCorrection?: () => void
  commitCorrection?: () => void
  positionAnchor?: (element: HTMLElement, offset: number) => boolean
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
  readLease,
  correctPendingAnchorLayout,
  hasPendingAnchorLayout,
  acquireScrollAnchor,
  prepareCorrection,
  commitCorrection,
  positionAnchor
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
  let releaseScrollAnchor: (() => void) | undefined
  let gestureTimer: ReturnType<typeof setTimeout> | undefined
  const releaseOwnership = (): void => {
    releaseScrollAnchor?.()
    releaseScrollAnchor = undefined
  }
  const syncOwnership = (): void => {
    if (anchor && performance.now() >= wheelIntentUntil) {
      releaseScrollAnchor ??= acquireScrollAnchor?.()
    } else releaseOwnership()
  }
  const observedRows = new Set<HTMLElement>()
  let pendingList: Element | null = null

  const releaseRowObservations = (): void => {
    for (const row of observedRows) resize.unobserve(row)
    observedRows.clear()
  }
  const observeRows = (): void => {
    const currentRows = new Set(root.querySelectorAll<HTMLElement>("[data-chat-message-row]"))
    for (const row of observedRows) {
      if (!currentRows.has(row)) {
        resize.unobserve(row)
        observedRows.delete(row)
      }
    }
    for (const row of currentRows) {
      if (observedRows.has(row)) continue
      observedRows.add(row)
      resize.observe(row)
    }
  }

  const enabled = (): boolean => {
    const next = readLease()
    const navigating = isChatScrollNavigationActive(viewport)
    if (next !== lease || next === null || navigating) {
      anchor = null
      releaseOwnership()
    }
    lease = next
    // Following output needs no detached measurements. Reading scrollTop here can
    // force layout for every streamed DOM mutation before the browser's frame.
    if (next === null || navigating || !root.isConnected || !viewport.isConnected) {
      releaseOwnership()
      if (!hasPendingAnchorLayout?.() || navigating || !root.isConnected || !viewport.isConnected) {
        releaseRowObservations()
        if (pendingList) resize.unobserve(pendingList)
        pendingList = null
      }
      return false
    }
    // At the absolute head the history boundary owns the position. Anchoring a later
    // readable row while earlier protected rows expand would scroll that boundary away.
    const atHead = viewport.scrollTop <= 0.5
    if (atHead) {
      releaseOwnership()
      anchor = null
      releaseRowObservations()
    }
    return !atHead
  }
  const sampleAnchor = (): VisibleAnchor | null => {
    const bounds = viewport.getBoundingClientRect()
    let pendingAnchor: VisibleAnchor | null = null
    for (const element of root.querySelectorAll<HTMLElement>("[data-chat-message-row]")) {
      const rect = element.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
        // A verified cached body can remain readable while its FunctionSite refresh is busy.
        const pending =
          Boolean(element.querySelector("[data-function-site-pending]")) ||
          !isChatRowPresented(element)
        const candidate = {
          element,
          messageId: element.dataset.chatMessageId ?? "",
          offset: rect.top - bounds.top,
          pending
        }
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
    syncOwnership()
    // Opposing height changes can leave both the root and virtual list the same size.
    // Observe only mounted rows while detached so those changes still settle before paint.
    observeRows()
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
    if (
      !root.contains(anchor.element) ||
      anchor.element.dataset.chatMessageId !== anchor.messageId
    ) {
      anchor = null
      releaseOwnership()
      return
    }
    let offset = anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    let delta = offset - anchor.offset
    if (Math.abs(delta) <= 0.5) return
    const transactionTop = viewport.scrollTop
    try {
      prepareCorrection?.()
      if (
        !anchor ||
        !root.contains(anchor.element) ||
        anchor.element.dataset.chatMessageId !== anchor.messageId
      ) {
        anchor = null
        releaseOwnership()
        return
      }
      offset = anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      delta = offset - anchor.offset
      if (Math.abs(delta) <= 0.5) return
      if (positionAnchor?.(anchor.element, anchor.offset)) {
        // Native positioning clamps at the viewport boundary. Re-capture after its DOM commit
        // rather than rebasing from the stale spacer geometry that prompted this correction.
        if (viewport.scrollTop <= 0.5 ||
          viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 0.5) requestCapture()
        return
      }
      const previousTop = viewport.scrollTop
      const desired = previousTop + delta
      const top = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, desired))
      if (Math.abs(top - viewport.scrollTop) > 0.5) viewport.scrollTop = top
      // A boundary cannot preserve an out-of-range offset. Rebase once rather than accumulating it.
      if (Math.abs(top - desired) > 0.5) anchor.offset = offset - (top - previousTop)
    } finally {
      // RO corrections can precede the next scroll event; publish the final viewport now.
      if (viewport.scrollTop !== transactionTop) commitCorrection?.()
    }
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
  const onOwnerReleased = (): void => {
    if (!enabled() || performance.now() < wheelIntentUntil || scrollbarPointer !== null) return
    // A queued capture must not replace this handoff with the next frame's changed geometry.
    // Keep the size transaction barrier: only this read transfers ownership synchronously.
    captureRequested = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    capture()
  }
  const onNavigationChange = (): void => {
    // The index write and exact-occurrence centering can span several layout transactions.
    // Rebase only after their owner releases; an earlier reading row must not undo them.
    anchor = null
    releaseOwnership()
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
    if (
      !event
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLElement && target.hasAttribute("data-scroll-area-scrollbar")
        )
    )
      return
    anchor = null
    releaseOwnership()
    scrollbarPointer = event.pointerId
    pointerX = event.clientX
    pointerY = event.clientY
    requestCapture()
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (
      scrollbarPointer !== event.pointerId ||
      (pointerX === event.clientX && pointerY === event.clientY)
    )
      return
    pointerX = event.clientX
    pointerY = event.clientY
    releaseOwnership()
    // Capture after Radix consumes this movement. Never correct against the preceding pointer.
    requestCapture()
  }
  const onPointerEnd = (event: PointerEvent): void => {
    if (scrollbarPointer !== event.pointerId) return
    scrollbarPointer = null
    requestCapture()
  }
  const onBlur = (): void => {
    scrollbarPointer = null
    requestCapture()
  }
  const onWheelOrTouch = (): void => {
    wheelIntentUntil = performance.now() + 120
    releaseOwnership()
    if (!hasPendingAnchorLayout?.()) {
      releaseRowObservations()
      if (pendingList) resize.unobserve(pendingList)
      pendingList = null
    }
    if (gestureTimer !== undefined) clearTimeout(gestureTimer)
    gestureTimer = setTimeout(() => {
      gestureTimer = undefined
      requestCapture()
    }, 120)
    requestCapture()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    if (
      ownerDocument.activeElement !== ownerDocument.body &&
      !scrollRoot.contains(ownerDocument.activeElement)
    )
      return
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      onWheelOrTouch()
    }
  }
  const correctPendingLayout = (rowsChanged = false): void => {
    const active = root.isConnected && viewport.isConnected &&
      !isChatScrollNavigationActive(viewport) && hasPendingAnchorLayout?.()
    if (active) {
      if (rowsChanged || observedRows.size === 0) observeRows()
      correctPendingAnchorLayout?.()
    } else releaseRowObservations()
    const list = active ? root.querySelector('[data-testid="virtuoso-item-list"]') : null
    if (list !== pendingList) {
      if (pendingList) resize.unobserve(pendingList)
      pendingList = list
      if (pendingList) resize.observe(pendingList)
    }
  }
  const onMutation = (records: MutationRecord[]): void => {
    if (!enabled()) {
      if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame)
      measurementFrame = undefined
      awaitingSizes = false
      correctPendingLayout(records.some(record => record.type === "childList"))
      return
    }
    const includesRow = (node: Node): boolean =>
      node instanceof HTMLElement &&
      (node.matches("[data-chat-message-row]") ||
        Boolean(node.querySelector("[data-chat-message-row]")))
    if (
      records.some(
        (record) =>
          record.type === "childList" &&
          [...record.addedNodes, ...record.removedNodes].some(includesRow)
      )
    )
      observeRows()
    if (prepareCorrection) {
      // Native refresh publishes sizes synchronously; the old DOM-only barrier is unnecessary.
      if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame)
      measurementFrame = undefined
      awaitingSizes = false
      correct()
      if (!anchor) requestCapture()
      return
    }
    if (
      records.some((record) =>
        (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(
          "[data-chat-message-row]"
        )
      )
    ) {
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
  mutation.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "data-function-site-pending"]
  })
  const resize = new ResizeObserver(() => {
    if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame)
    measurementFrame = undefined
    awaitingSizes = false
    if (!enabled()) {
      correctPendingLayout()
      return
    }
    correct()
    if (anchor || captureRequested) schedule()
  })
  resize.observe(root)
  viewport.addEventListener("scroll", onScroll, { passive: true })
  viewport.addEventListener(CHAT_DETACHED_ANCHOR_OWNER_RELEASED, onOwnerReleased)
  viewport.addEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigationChange)
  viewport.addEventListener("wheel", onWheelOrTouch, { passive: true })
  viewport.addEventListener("touchmove", onWheelOrTouch, { passive: true })
  scrollRoot.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true })
  ownerDocument.addEventListener("pointermove", onPointerMove, { capture: true, passive: true })
  ownerDocument.addEventListener("pointerup", onPointerEnd, true)
  ownerDocument.addEventListener("pointercancel", onPointerEnd, true)
  ownerDocument.addEventListener("keydown", onKeyDown, true)
  ownerDocument.defaultView?.addEventListener("blur", onBlur)
  // A restoration can release before this observer mounts. Acquire its existing geometry now.
  capture()
  return () => {
    releaseOwnership()
    if (gestureTimer !== undefined) clearTimeout(gestureTimer)
    mutation.disconnect()
    resize.disconnect()
    observedRows.clear()
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (measurementFrame !== undefined) cancelAnimationFrame(measurementFrame)
    viewport.removeEventListener("scroll", onScroll)
    viewport.removeEventListener(CHAT_DETACHED_ANCHOR_OWNER_RELEASED, onOwnerReleased)
    viewport.removeEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigationChange)
    viewport.removeEventListener("wheel", onWheelOrTouch)
    viewport.removeEventListener("touchmove", onWheelOrTouch)
    scrollRoot.removeEventListener("pointerdown", onPointerDown, true)
    ownerDocument.removeEventListener("pointermove", onPointerMove, true)
    ownerDocument.removeEventListener("pointerup", onPointerEnd, true)
    ownerDocument.removeEventListener("pointercancel", onPointerEnd, true)
    ownerDocument.removeEventListener("keydown", onKeyDown, true)
    ownerDocument.defaultView?.removeEventListener("blur", onBlur)
    anchor = null
  }
}
