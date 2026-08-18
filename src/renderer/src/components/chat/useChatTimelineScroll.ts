import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { HITLRequest, UserInputRequest } from "@/types"
import type { ChatVirtualTimelineHandle } from "./ChatTimeline"
import type { UserInputRequestDialogLayout } from "./UserInputRequestDialog"

const NON_VIRTUAL_STICKY_DISTANCE = 32

interface UseChatTimelineScrollOptions {
  threadId: string
  isVirtualized: boolean
  messageCount: number
  historyLoading: boolean
  pendingApproval: HITLRequest | null
  pendingUserInput: UserInputRequest | null
  userInputDialogLayout: UserInputRequestDialogLayout | null
  lastContentMessageId: string | null
  contentFollowKey: string
}

// 统一管理普通与虚拟时间线的定位和回底，避免滚动实现散落在容器中。
export function useChatTimelineScroll({
  threadId,
  isVirtualized,
  messageCount,
  historyLoading,
  pendingApproval,
  pendingUserInput,
  userInputDialogLayout,
  lastContentMessageId,
  contentFollowKey
}: UseChatTimelineScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualTimelineRef = useRef<ChatVirtualTimelineHandle>(null)
  const scrollEndRef = useRef<HTMLSpanElement>(null)
  const contentMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const nonVirtualStickyRef = useRef(true)
  const virtualInitialRepinPendingRef = useRef(true)

  const getViewport = useCallback((): HTMLDivElement | null => {
    if (isVirtualized) return virtualTimelineRef.current?.element ?? null
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [isVirtualized])

  const scrollToMessage = useCallback(
    (messageId: string): boolean => {
      if (!isVirtualized) {
        return false
      }
      virtualInitialRepinPendingRef.current = false
      const timeline = virtualTimelineRef.current
      return timeline?.scrollToMessage(messageId) ?? false
    },
    [isVirtualized]
  )

  const pauseStickyFollow = useCallback((): void => {
    if (isVirtualized) {
      virtualInitialRepinPendingRef.current = false
      return
    }
    nonVirtualStickyRef.current = false
  }, [isVirtualized])
  const scrollToConversationBottom = useCallback((): boolean => {
    if (isVirtualized) {
      const timeline = virtualTimelineRef.current
      if (!timeline) return false
      timeline.scrollToEnd()
      return true
    }
    const viewport = getViewport()
    if (!viewport) return false
    nonVirtualStickyRef.current = true
    scrollEndRef.current?.scrollIntoView({ block: "end" })
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return true
  }, [getViewport, isVirtualized])

  const handleScrollToConversationBottom = useCallback((): void => {
    requestAnimationFrame(() => {
      scrollToConversationBottom()
    })
  }, [scrollToConversationBottom])

  useEffect(() => {
    if (!pendingApproval) return
    scrollToConversationBottom()
  }, [pendingApproval, scrollToConversationBottom])

  useEffect(() => {
    if (!pendingUserInput || !userInputDialogLayout) return
    const viewport = getViewport()
    if (!viewport) return

    const frame = requestAnimationFrame(() => {
      const targetElement = lastContentMessageId
        ? contentMessageRefs.current.get(lastContentMessageId)
        : null
      const viewportRect = viewport.getBoundingClientRect()
      const targetBottom = Math.max(viewportRect.top + 24, userInputDialogLayout.top - 12)

      if (targetElement) {
        const targetRect = targetElement.getBoundingClientRect()
        const scrollDelta = targetRect.bottom - targetBottom
        if (Math.abs(scrollDelta) > 1) {
          viewport.scrollTop = Math.max(0, viewport.scrollTop + scrollDelta)
        }
      } else {
        scrollToConversationBottom()
      }
    })

    return () => cancelAnimationFrame(frame)
  }, [
    getViewport,
    lastContentMessageId,
    pendingUserInput,
    scrollToConversationBottom,
    userInputDialogLayout
  ])

  useEffect(() => {
    if (isVirtualized) return
    nonVirtualStickyRef.current = true
  }, [isVirtualized, threadId])

  useEffect(() => {
    virtualInitialRepinPendingRef.current = isVirtualized
  }, [isVirtualized, threadId])

  useEffect(() => {
    if (historyLoading || isVirtualized) return
    const frame = requestAnimationFrame(() => {
      scrollToConversationBottom()
    })
    return () => cancelAnimationFrame(frame)
  }, [historyLoading, isVirtualized, scrollToConversationBottom, threadId])

  useLayoutEffect(() => {
    if (historyLoading || isVirtualized || !nonVirtualStickyRef.current) return

    let frame: number | null = null
    let attempts = 0
    let stableFrames = 0
    let lastMaxScroll = -1

    const follow = (): void => {
      if (!nonVirtualStickyRef.current) return
      const viewport = getViewport()
      if (!viewport || viewport.clientHeight <= 0) {
        if (attempts >= 12) return
        attempts += 1
        frame = requestAnimationFrame(follow)
        return
      }

      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      if (viewport.scrollTop !== maxScroll) {
        viewport.scrollTop = maxScroll
      }

      const distanceToBottom = maxScroll - viewport.scrollTop
      const heightChanged = maxScroll !== lastMaxScroll
      lastMaxScroll = maxScroll
      stableFrames = distanceToBottom <= 1 && !heightChanged ? stableFrames + 1 : 0
      if (stableFrames >= 2 || attempts >= 12) return

      attempts += 1
      frame = requestAnimationFrame(follow)
    }

    follow()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [contentFollowKey, getViewport, historyLoading, isVirtualized])

  // Match the virtual timeline's sticky semantics for the regular ScrollArea:
  // user scroll breaks following, returning to the bottom restores it, and
  // content growth follows only while sticky remains true.
  useEffect(() => {
    if (isVirtualized) return

    let viewport: HTMLDivElement | null = null
    let attachFrame: number | null = null
    let followFrame: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    let cleanupAttached = (): void => {}

    const cancelFollow = (): void => {
      if (followFrame !== null) {
        cancelAnimationFrame(followFrame)
        followFrame = null
      }
    }

    const updateStickyFromViewport = (): void => {
      if (!viewport) return
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const nextSticky = distanceToBottom <= NON_VIRTUAL_STICKY_DISTANCE
      if (nonVirtualStickyRef.current && !nextSticky) {
        cancelFollow()
      }
      nonVirtualStickyRef.current = nextSticky
    }

    const queueStickyFollow = (): void => {
      if (historyLoading || !nonVirtualStickyRef.current || followFrame !== null) {
        return
      }

      followFrame = requestAnimationFrame(() => {
        followFrame = null
        if (!historyLoading && nonVirtualStickyRef.current) {
          scrollToConversationBottom()
        }
      })
    }

    const observeContent = (): void => {
      if (!viewport || !resizeObserver) return
      resizeObserver.disconnect()
      resizeObserver.observe(viewport)
      const content = viewport.firstElementChild
      if (content) resizeObserver.observe(content)
      if (scrollEndRef.current) resizeObserver.observe(scrollEndRef.current)
    }

    const attach = (): void => {
      viewport = getViewport()
      if (!viewport) {
        attachFrame = requestAnimationFrame(attach)
        return
      }

      const handleScroll = (): void => {
        updateStickyFromViewport()
      }
      viewport.addEventListener("scroll", handleScroll, { passive: true })

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          observeContent()
          queueStickyFollow()
        })
        observeContent()
      }

      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver(() => {
          observeContent()
          queueStickyFollow()
        })
        mutationObserver.observe(viewport, { childList: true, subtree: true })
      }

      queueStickyFollow()

      cleanupAttached = (): void => {
        viewport?.removeEventListener("scroll", handleScroll)
        resizeObserver?.disconnect()
        mutationObserver?.disconnect()
        cancelFollow()
      }
    }

    attach()

    return () => {
      if (attachFrame !== null) cancelAnimationFrame(attachFrame)
      cleanupAttached()
    }
  }, [getViewport, historyLoading, isVirtualized, scrollToConversationBottom, threadId])

  // The virtual timeline owns sticky follow during normal streaming, but the
  // thread boundary still needs one explicit repin so first entry and A -> B ->
  // A reuse land at the concrete bottom instead of the browser default.
  useEffect(() => {
    if (!isVirtualized || historyLoading || !virtualInitialRepinPendingRef.current) return

    let frame: number | null = null
    let attempts = 0
    let stableFrames = 0
    let lastMaxScroll = -1

    const finish = (): void => {
      virtualInitialRepinPendingRef.current = false
    }

    const retry = (): void => {
      if (attempts >= 60) {
        finish()
        return
      }
      attempts += 1
      frame = requestAnimationFrame(repin)
    }

    const repin = (): void => {
      const viewport = getViewport()
      if (!viewport) {
        retry()
        return
      }

      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      if (viewport.clientHeight <= 0) {
        retry()
        return
      }

      if (viewport.scrollTop !== maxScroll) {
        viewport.scrollTop = maxScroll
      }

      const distanceToBottom = maxScroll - viewport.scrollTop
      const heightChanged = maxScroll !== lastMaxScroll
      lastMaxScroll = maxScroll
      stableFrames = distanceToBottom <= 1 && !heightChanged ? stableFrames + 1 : 0
      if (stableFrames >= 2) {
        finish()
        return
      }

      retry()
    }

    frame = requestAnimationFrame(repin)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [getViewport, historyLoading, isVirtualized, messageCount, threadId])

  return {
    scrollRef,
    virtualTimelineRef,
    scrollEndRef,
    contentMessageRefs,
    getViewport,
    scrollToMessage,
    scrollToConversationBottom,
    pauseStickyFollow,
    handleScrollToConversationBottom
  }
}
