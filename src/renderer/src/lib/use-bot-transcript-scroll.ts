import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { shouldConfirmChatViewportBottom } from "../../../shared/chat-scroll-controller"

const AT_BOTTOM_THRESHOLD = 32
const USER_SCROLL_DELTA = 1
const USER_INTENT_WINDOW_MS = 350

interface BotTranscriptScrollCallbacks {
  onReadPosition(): void
  onUserDetach(): void
  onContentHeightChanged(): void
}

interface BotTranscriptScrollObservation extends BotTranscriptScrollCallbacks {
  scrollParent: HTMLElement
  following: RefObject<boolean>
}

export interface BotTranscriptScrollOptions extends BotTranscriptScrollCallbacks {
  scrollParent: HTMLElement | null
  viewId: string | null
  following: RefObject<boolean>
}

/** Adapt the existing ChatContainer gesture rules without adding a second scroll writer.
 * Native scroll events also arrive during virtual item measurements and browser anchoring;
 * only a recent user gesture may detach or restore the caller's follow intent.
 */
export function observeBotTranscriptScroll({
  scrollParent,
  following,
  onReadPosition,
  onUserDetach,
  onContentHeightChanged
}: BotTranscriptScrollObservation): () => void {
  const document = scrollParent.ownerDocument
  const window = document.defaultView
  if (!window) return () => {}
  let active = true,
    previousTop = scrollParent.scrollTop,
    upwardIntentUntil = 0,
    downwardIntentUntil = 0,
    scrollbarPointerActive = false,
    lastTouchY: number | null = null

  const rememberDirection = (direction: "up" | "down"): void => {
    const until = window.performance.now() + USER_INTENT_WINDOW_MS
    upwardIntentUntil = direction === "up" ? until : 0
    downwardIntentUntil = direction === "down" ? until : 0
    // Native wheel/touch scrolling can be applied after a queued animation frame.
    // Yield the pending follow write at the gesture boundary, before it can erase
    // the upward movement and make the later scroll event look like layout.
    if (direction === "up" && scrollParent.scrollTop > USER_SCROLL_DELTA) {
      detach()
      onReadPosition()
    } else if (!following.current) {
      // Either direction cancels a pending anchor restoration. A detached
      // reader owns the next native movement, including downward scrolling.
      onUserDetach()
      onReadPosition()
    }
  }
  const detach = (): void => {
    following.current = false
    onUserDetach()
  }
  const observeScroll = (): void => {
    const nextTop = scrollParent.scrollTop
    const movement = nextTop - previousTop
    previousTop = nextTop
    if (movement < -USER_SCROLL_DELTA && window.performance.now() <= upwardIntentUntil) {
      upwardIntentUntil = 0
      if (following.current) detach()
    } else if (
      shouldConfirmChatViewportBottom({
        distanceToBottom: scrollParent.scrollHeight - nextTop - scrollParent.clientHeight,
        movementDelta: movement,
        atBottomThreshold: AT_BOTTOM_THRESHOLD,
        detachDelta: USER_SCROLL_DELTA,
        detached: !following.current,
        downwardIntentActive: window.performance.now() <= downwardIntentUntil,
        scrollbarPointerActive
      }) &&
      !following.current
    ) {
      following.current = true
      onContentHeightChanged()
    }
    onReadPosition()
  }
  const rememberWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) rememberDirection("up")
    else if (event.deltaY > 0) rememberDirection("down")
  }
  const rememberScrollbarPointer = (event: PointerEvent): void => {
    const customScrollbar = event
      .composedPath()
      .some(
        (target) =>
          target instanceof window.HTMLElement && target.hasAttribute("data-scroll-area-scrollbar")
      )
    // Bot uses native overflow scrollbars. Windows reserves a gutter; macOS may overlay
    // its scrollbar, so its narrow edge hit area has no offsetWidth/clientWidth difference.
    const bounds = scrollParent.getBoundingClientRect()
    const gutter = Math.max(12, scrollParent.offsetWidth - scrollParent.clientWidth)
    const nativeScrollbar =
      event.target === scrollParent &&
      scrollParent.scrollHeight > scrollParent.clientHeight &&
      event.clientX >= bounds.right - gutter &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    if (!customScrollbar && !nativeScrollbar) return
    scrollbarPointerActive = true
    upwardIntentUntil = downwardIntentUntil = 0
    detach()
    onReadPosition()
  }
  const finishScrollbarPointer = (): void => {
    if (!scrollbarPointerActive) return
    scrollbarPointerActive = false
    previousTop = scrollParent.scrollTop
    if (
      scrollParent.scrollHeight - previousTop - scrollParent.clientHeight <=
      AT_BOTTOM_THRESHOLD
    ) {
      following.current = true
      onContentHeightChanged()
    }
    onReadPosition()
  }
  const clearPointerIntent = (): void => {
    scrollbarPointerActive = false
  }
  const rememberTouch = (event: TouchEvent): void => {
    lastTouchY = event.touches[0]?.clientY ?? null
  }
  const rememberTouchDirection = (event: TouchEvent): void => {
    const next = event.touches[0]?.clientY ?? null
    if (lastTouchY !== null && next !== null) {
      if (next > lastTouchY + USER_SCROLL_DELTA) rememberDirection("up")
      else if (next < lastTouchY - USER_SCROLL_DELTA) rememberDirection("down")
    }
    lastTouchY = next
  }
  const finishTouch = (): void => {
    lastTouchY = null
  }
  const rememberKeyboard = (event: KeyboardEvent): void => {
    if (!scrollParent.contains(document.activeElement) && document.activeElement !== document.body)
      return
    const target = event.target
    if (
      target instanceof window.HTMLInputElement ||
      target instanceof window.HTMLTextAreaElement ||
      (target instanceof window.HTMLElement && target.isContentEditable)
    )
      return
    if (
      event.key === "ArrowUp" ||
      event.key === "PageUp" ||
      event.key === "Home" ||
      (event.key === " " && event.shiftKey)
    )
      rememberDirection("up")
    else if (
      event.key === "ArrowDown" ||
      event.key === "PageDown" ||
      event.key === "End" ||
      (event.key === " " && !event.shiftKey)
    )
      rememberDirection("down")
  }
  const clearUserIntent = (): void => {
    upwardIntentUntil = downwardIntentUntil = 0
    scrollbarPointerActive = false
    lastTouchY = null
  }

  scrollParent.addEventListener("scroll", observeScroll, { passive: true })
  scrollParent.addEventListener("wheel", rememberWheel, { passive: true })
  scrollParent.addEventListener("pointerdown", rememberScrollbarPointer, {
    capture: true,
    passive: true
  })
  scrollParent.addEventListener("touchstart", rememberTouch, { passive: true })
  scrollParent.addEventListener("touchmove", rememberTouchDirection, { passive: true })
  scrollParent.addEventListener("touchend", finishTouch, { passive: true })
  scrollParent.addEventListener("touchcancel", finishTouch, { passive: true })
  window.addEventListener("keydown", rememberKeyboard, true)
  window.addEventListener("pointerup", finishScrollbarPointer, true)
  window.addEventListener("pointercancel", clearPointerIntent, true)
  window.addEventListener("blur", clearUserIntent)

  const resize = new window.ResizeObserver(() => {
    if (!active) return
    onContentHeightChanged()
    onReadPosition()
  })
  const content = scrollParent.querySelector(".bot-transcript-content")
  if (content) resize.observe(content)
  resize.observe(scrollParent)
  return () => {
    active = false
    resize.disconnect()
    scrollParent.removeEventListener("scroll", observeScroll)
    scrollParent.removeEventListener("wheel", rememberWheel)
    scrollParent.removeEventListener("pointerdown", rememberScrollbarPointer, true)
    scrollParent.removeEventListener("touchstart", rememberTouch)
    scrollParent.removeEventListener("touchmove", rememberTouchDirection)
    scrollParent.removeEventListener("touchend", finishTouch)
    scrollParent.removeEventListener("touchcancel", finishTouch)
    window.removeEventListener("keydown", rememberKeyboard, true)
    window.removeEventListener("pointerup", finishScrollbarPointer, true)
    window.removeEventListener("pointercancel", clearPointerIntent, true)
    window.removeEventListener("blur", clearUserIntent)
  }
}

export function useBotTranscriptScroll({
  scrollParent,
  viewId,
  following,
  ...callbacks
}: BotTranscriptScrollOptions): void {
  const latest = useRef(callbacks)
  useLayoutEffect(() => {
    latest.current = callbacks
  })
  useEffect(() => {
    if (!scrollParent || !viewId) return
    return observeBotTranscriptScroll({
      scrollParent,
      following,
      onReadPosition: () => latest.current.onReadPosition(),
      onUserDetach: () => latest.current.onUserDetach(),
      onContentHeightChanged: () => latest.current.onContentHeightChanged()
    })
  }, [following, scrollParent, viewId])
}
