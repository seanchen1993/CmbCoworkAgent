import { useCallback, useEffect, useRef, useState } from "react"
import type { HITLRequest, UserInputRequest } from "@/types"
import type { ChatVirtualTimelineHandle } from "./ChatTimeline"
import type { UserInputRequestDialogLayout } from "./UserInputRequestDialog"

interface UseChatTimelineScrollOptions {
  threadId: string
  isVirtualized: boolean
  messageCount: number
  historyLoading: boolean
  pendingApproval: HITLRequest | null
  pendingUserInput: UserInputRequest | null
  userInputDialogLayout: UserInputRequestDialogLayout | null
  lastContentMessageId: string | null
}

// 统一管理普通与虚拟时间线的定位、回底和临时留白，避免滚动实现散落在容器中。
export function useChatTimelineScroll({
  threadId,
  isVirtualized,
  messageCount,
  historyLoading,
  pendingApproval,
  pendingUserInput,
  userInputDialogLayout,
  lastContentMessageId
}: UseChatTimelineScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualTimelineRef = useRef<ChatVirtualTimelineHandle>(null)
  const scrollEndRef = useRef<HTMLSpanElement>(null)
  const contentMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const pendingUserMessageScrollRef = useRef<{ threadId: string; messageId: string } | null>(null)
  const [conversationBottomPaddingState, setConversationBottomPaddingState] = useState<{
    threadId: string
    value?: number
  }>({ threadId })
  const conversationBottomPadding =
    conversationBottomPaddingState.threadId === threadId
      ? conversationBottomPaddingState.value
      : undefined

  const getViewport = useCallback((): HTMLDivElement | null => {
    if (isVirtualized) return virtualTimelineRef.current?.element ?? null
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [isVirtualized])

  const scrollToMessage = useCallback(
    (messageId: string): boolean => {
      if (!isVirtualized) return false
      return virtualTimelineRef.current?.scrollToMessage(messageId) ?? false
    },
    [isVirtualized]
  )
  const scrollToConversationBottom = useCallback((): boolean => {
    if (isVirtualized) {
      const timeline = virtualTimelineRef.current
      if (!timeline) return false
      timeline.scrollToEnd()
      return true
    }
    const scrollEnd = scrollEndRef.current
    if (!scrollEnd) return false
    scrollEnd.scrollIntoView({ block: "end" })
    return true
  }, [isVirtualized])

  const requestUserMessageScroll = useCallback((messageId: string): void => {
    pendingUserMessageScrollRef.current = { threadId, messageId }
    setConversationBottomPaddingState({
      threadId,
      value: Math.max(280, Math.round(window.innerHeight * 0.45))
    })
  }, [threadId])

  useEffect(() => {
    const pending = pendingUserMessageScrollRef.current
    if (!pending || pending.threadId !== threadId) return

    const frame = requestAnimationFrame(() => {
      if (scrollToConversationBottom()) pendingUserMessageScrollRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [conversationBottomPadding, messageCount, scrollToConversationBottom, threadId])

  const handleScrollToConversationBottom = useCallback((): void => {
    pendingUserMessageScrollRef.current = null
    setConversationBottomPaddingState({ threadId })
    requestAnimationFrame(() => {
      scrollToConversationBottom()
    })
  }, [scrollToConversationBottom, threadId])

  useEffect(() => {
    pendingUserMessageScrollRef.current = null
    const frame = requestAnimationFrame(() => {
      setConversationBottomPaddingState({ threadId })
    })
    return () => cancelAnimationFrame(frame)
  }, [threadId])

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
    userInputDialogLayout?.height,
    userInputDialogLayout?.top
  ])

  useEffect(() => {
    if (historyLoading || isVirtualized) return
    scrollEndRef.current?.scrollIntoView({ block: "end" })
  }, [historyLoading, isVirtualized, threadId])

  return {
    scrollRef,
    virtualTimelineRef,
    scrollEndRef,
    contentMessageRefs,
    conversationBottomPadding,
    getViewport,
    scrollToMessage,
    scrollToConversationBottom,
    requestUserMessageScroll,
    handleScrollToConversationBottom
  }
}
