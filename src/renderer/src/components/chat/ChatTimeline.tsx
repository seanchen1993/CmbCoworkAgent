import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef
} from "react"
import {
  List,
  type ListImperativeAPI,
  type RowComponentProps,
  useDynamicRowHeight
} from "react-window"
import type { HITLRequest, Message, ToolCallState } from "@/types"
import type { HookLogBucket } from "@/lib/thread-context"
import { MessageBubble } from "./MessageBubble"
import { HookLogChip } from "./HookLogViews"
import { cn } from "@/lib/utils"
import { buildVisibleMessageLayout, messageHasVisibleRow } from "@/lib/message-display-visibility"
import {
  buildVirtualChatTimelineSegment,
  type VirtualChatTimelineItem,
  type VirtualChatTimelineSegment
} from "@/lib/virtual-chat-timeline-segment"

export type ChatApprovalDecision =
  | "approve"
  | "approve_session"
  | "approve_permanent"
  | "reject"
  | "edit"

export interface ChatToolResultInfo {
  content: string | unknown
  is_error?: boolean
}

export interface ChatMessageFlags {
  showAssistantMeta: boolean[]
  hasUserAfterHead: boolean[]
}

export interface ChatMessageListProps {
  messages: Message[]
  perMessageFlags: ChatMessageFlags
  hookLoggingEnabled: boolean
  hookLogBucketByTurnId: Map<string, HookLogBucket>
  detachedHookLogBuckets: HookLogBucket[]
  contentMessageRefs: React.RefObject<Map<string, HTMLDivElement>>
  setMessageRef: (messageId: string, role: Message["role"]) => (node: HTMLDivElement | null) => void
  isLoading: boolean
  toolResults: Map<string, ChatToolResultInfo>
  toolCallStates: Map<string, ToolCallState>
  pendingApprovalToolCallKeys: Set<string>
  pendingApproval: HITLRequest | null
  autoApproveGitPush: boolean
  onApprovalDecision: (decision: ChatApprovalDecision) => void
  onEditUserMessage: (message: Message) => void
  onSetGoalFromMessage: (text: string) => void
  onForkFromMessage: (message: Message) => void
  forkingMessageId: string | null
  onOpenHookLogBucket: (turnId: string) => void
  threadId: string
  assistantDurationMsById: Map<string, number>
  userSendTimeLabelById: Map<string, string>
}

type ChatMessageRowProps = Omit<
  ChatMessageListProps,
  "messages" | "perMessageFlags" | "detachedHookLogBuckets"
> & {
  message: Message
  previousMessage: Message | null
  isStreaming: boolean
  showAssistantMeta: boolean
  hasUserAfterHead: boolean
}

function areChatMessageRowPropsEqual(
  previous: Readonly<ChatMessageRowProps>,
  next: Readonly<ChatMessageRowProps>
): boolean {
  for (const key of Object.keys(previous) as Array<keyof ChatMessageRowProps>) {
    if (key === "assistantDurationMsById" || key === "userSendTimeLabelById") continue
    if (previous[key] !== next[key]) return false
  }
  const messageId = previous.message.id
  return (
    previous.assistantDurationMsById.get(messageId) ===
      next.assistantDurationMsById.get(messageId) &&
    previous.userSendTimeLabelById.get(messageId) === next.userSendTimeLabelById.get(messageId)
  )
}

const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  previousMessage,
  isStreaming,
  showAssistantMeta,
  hasUserAfterHead,
  hookLoggingEnabled,
  hookLogBucketByTurnId,
  contentMessageRefs,
  setMessageRef,
  isLoading,
  toolResults,
  toolCallStates,
  pendingApprovalToolCallKeys,
  pendingApproval,
  autoApproveGitPush,
  onApprovalDecision,
  onEditUserMessage,
  onSetGoalFromMessage,
  onForkFromMessage,
  forkingMessageId,
  onOpenHookLogBucket,
  threadId,
  assistantDurationMsById,
  userSendTimeLabelById
}: ChatMessageRowProps): React.JSX.Element | null {
  const hookLogBucketForTurn =
    hookLoggingEnabled && message.role === "user"
      ? hookLogBucketByTurnId.get(message.id)
      : undefined
  const hasHookLogChip = Boolean(hookLogBucketForTurn?.entries.length)
  if (!messageHasVisibleRow(message, hasHookLogChip)) return null

  const navigatorRef = setMessageRef(message.id, message.role)
  const combinedRef = (node: HTMLDivElement | null): void => {
    navigatorRef(node)
    if (node && message.role !== "tool") {
      contentMessageRefs.current.set(message.id, node)
      return
    }
    contentMessageRefs.current.delete(message.id)
  }

  return (
    <div ref={combinedRef} data-message-role={message.role}>
      <MessageBubble
        message={message}
        previousMessage={previousMessage}
        isStreaming={isStreaming}
        showAssistantMeta={showAssistantMeta}
        toolResults={toolResults}
        toolCallStates={toolCallStates}
        pendingApprovalToolCallKeys={pendingApprovalToolCallKeys}
        pendingApproval={pendingApproval}
        autoApproveGitPush={autoApproveGitPush}
        onApprovalDecision={onApprovalDecision}
        onEditUserMessage={onEditUserMessage}
        onSetGoalFromMessage={onSetGoalFromMessage}
        onForkFromMessage={onForkFromMessage}
        forkingMessageId={forkingMessageId}
        threadId={threadId}
        isLoading={isLoading}
        hasUserAfterHead={hasUserAfterHead}
        assistantDurationMs={assistantDurationMsById.get(message.id)}
        userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
      />
      {hookLogBucketForTurn && hookLogBucketForTurn.entries.length > 0 && (
        <div className="mt-1 ml-12">
          <HookLogChip
            bucket={hookLogBucketForTurn}
            onClick={() => onOpenHookLogBucket(hookLogBucketForTurn.turnId)}
          />
        </div>
      )}
    </div>
  )
}, areChatMessageRowPropsEqual)

export const VIRTUAL_CHAT_TIMELINE_THRESHOLD = 80
const SCROLL_POSITION_PRESERVE_DISTANCE = 32
const BOTTOM_SETTLE_DISTANCE = 32
const BOTTOM_SETTLE_MAX_FRAMES = 60
const BOTTOM_SETTLE_STABLE_FRAMES = 2
const VIRTUAL_CHAT_DEFAULT_ROW_HEIGHT = 120
const VIRTUAL_CHAT_OVERSCAN_COUNT = 20

export interface ChatVirtualTimelineHandle {
  readonly element: HTMLDivElement | null
  scrollToEnd(): void
  scrollToMessage(messageId: string): boolean
}

interface VirtualChatTimelineRowProps {
  historyItems: readonly VirtualChatTimelineItem[]
  liveItems: readonly VirtualChatTimelineItem[]
  perMessageFlags: ChatMessageFlags
  lastVisibleMessageIndex: number
  reserveLeftSpace: boolean
  tail: React.ReactNode
  scrollEndRef: React.RefObject<HTMLSpanElement | null>
  chatMessageListProps: Omit<
    ChatMessageListProps,
    "messages" | "perMessageFlags" | "detachedHookLogBuckets"
  >
}

function VirtualChatTimelineRow({
  ariaAttributes,
  index,
  style,
  historyItems,
  liveItems,
  perMessageFlags,
  lastVisibleMessageIndex,
  reserveLeftSpace,
  tail,
  scrollEndRef,
  chatMessageListProps
}: RowComponentProps<VirtualChatTimelineRowProps>): React.JSX.Element {
  const item =
    index < historyItems.length
      ? historyItems[index]
      : index < historyItems.length + liveItems.length
        ? liveItems[index - historyItems.length]
        : undefined
  const messageIndex = item?.messageIndex
  let content: React.ReactNode
  if (messageIndex === undefined || !item?.message) {
    content = (
      <>
        {tail}
        <span ref={scrollEndRef} aria-hidden="true" />
      </>
    )
  } else {
    content = (
      <ChatMessageRow
        {...chatMessageListProps}
        message={item.message}
        previousMessage={item.previousMessage ?? null}
        isStreaming={messageIndex === lastVisibleMessageIndex && chatMessageListProps.isLoading}
        showAssistantMeta={perMessageFlags.showAssistantMeta[messageIndex]}
        hasUserAfterHead={perMessageFlags.hasUserAfterHead[messageIndex]}
      />
    )
  }

  return (
    <div style={style} {...ariaAttributes}>
      <div className={cn("px-4 py-2", reserveLeftSpace && "md:pl-[20px]")}>
        <div className="max-w-3xl mx-auto">{content}</div>
      </div>
    </div>
  )
}

interface VirtualChatTimelineProps {
  historyMessages: readonly Message[]
  liveMessages: readonly Message[]
  perMessageFlags: ChatMessageFlags
  reserveLeftSpace: boolean
  chatMessageListProps: Omit<
    ChatMessageListProps,
    "messages" | "perMessageFlags" | "detachedHookLogBuckets" | "setMessageRef"
  >
  setMessageRef: ChatMessageListProps["setMessageRef"]
  tail?: React.ReactNode
  threadId: string
  historyLoading: boolean
}

export const VirtualChatTimeline = React.forwardRef<
  ChatVirtualTimelineHandle,
  VirtualChatTimelineProps
>(function VirtualChatTimeline(
  {
    historyMessages,
    liveMessages,
    perMessageFlags,
    reserveLeftSpace,
    chatMessageListProps,
    setMessageRef,
    tail = null,
    threadId,
    historyLoading
  },
  ref
): React.JSX.Element {
  const listRef = useRef<ListImperativeAPI>(null)
  const lastRowIndexRef = useRef(0)
  const bottomSettleFrameRef = useRef<number | null>(null)
  const bottomSettleTokenRef = useRef(0)
  const stickyToBottomRef = useRef(true)
  const scrollEndRef = useRef<HTMLSpanElement>(null)
  const completionScrollTopRef = useRef<number | null>(null)
  const isVisibleVirtualMessage = useCallback(
    (message: Message): boolean => {
      const hasHookLogChip =
        chatMessageListProps.hookLoggingEnabled &&
        message.role === "user" &&
        Boolean(chatMessageListProps.hookLogBucketByTurnId.get(message.id)?.entries.length)
      return messageHasVisibleRow(message, hasHookLogChip)
    },
    [chatMessageListProps.hookLogBucketByTurnId, chatMessageListProps.hookLoggingEnabled]
  )
  const historySegment: VirtualChatTimelineSegment = useMemo(
    () =>
      buildVirtualChatTimelineSegment(historyMessages, {
        messageIndexOffset: 0,
        rowIndexOffset: 0,
        previousVisibleMessage: null,
        isVisible: isVisibleVirtualMessage
      }),
    [historyMessages, isVisibleVirtualMessage]
  )
  const liveSegment: VirtualChatTimelineSegment = useMemo(
    () =>
      buildVirtualChatTimelineSegment(liveMessages, {
        messageIndexOffset: historyMessages.length,
        rowIndexOffset: historySegment.items.length,
        previousVisibleMessage: historySegment.lastVisibleMessage,
        isVisible: isVisibleVirtualMessage
      }),
    [
      historyMessages.length,
      historySegment.items.length,
      historySegment.lastVisibleMessage,
      isVisibleVirtualMessage,
      liveMessages
    ]
  )
  const lastVisibleMessageIndex =
    liveSegment.lastVisibleMessageIndex >= 0
      ? liveSegment.lastVisibleMessageIndex
      : historySegment.lastVisibleMessageIndex
  const rowCount = historySegment.items.length + liveSegment.items.length + 1
  lastRowIndexRef.current = Math.max(0, rowCount - 1)

  const dynamicRowHeight = useDynamicRowHeight({
    // Bias the first estimate low. Overestimating a dynamic row makes the
    // virtualizer stop mounting before the viewport, which is visible as a
    // blank area while the real height cache is still warming up.
    defaultRowHeight: VIRTUAL_CHAT_DEFAULT_ROW_HEIGHT,
    // Keep measured history rows stable while streaming appends new rows.
    key: threadId
  })
  const rowProps = useMemo(
    () => ({
      historyItems: historySegment.items,
      liveItems: liveSegment.items,
      perMessageFlags,
      lastVisibleMessageIndex,
      reserveLeftSpace,
      tail,
      scrollEndRef,
      chatMessageListProps: {
        ...chatMessageListProps,
        setMessageRef
      }
    }),
    [
      chatMessageListProps,
      historySegment.items,
      lastVisibleMessageIndex,
      liveSegment.items,
      perMessageFlags,
      tail,
      reserveLeftSpace,
      setMessageRef,
      scrollEndRef
    ]
  )
  const cancelBottomSettle = useCallback((): void => {
    bottomSettleTokenRef.current += 1
    if (bottomSettleFrameRef.current !== null) {
      cancelAnimationFrame(bottomSettleFrameRef.current)
      bottomSettleFrameRef.current = null
    }
  }, [])
  const scrollToLastRow = useCallback((): void => {
    listRef.current?.scrollToRow({
      index: lastRowIndexRef.current,
      align: "end",
      behavior: "instant"
    })
  }, [])
  const scrollToBottomNow = useCallback((): boolean => {
    const viewport = listRef.current?.element
    if (!viewport) return false

    // The row scroll first makes the tail row eligible for rendering. Once it
    // exists, use the actual DOM geometry so dynamic row measurements are
    // reflected instead of relying on react-window's stale estimate.
    scrollEndRef.current?.scrollIntoView({ block: "end", inline: "nearest" })
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return true
  }, [])
  const queueScrollEndAnchor = useCallback((): void => {
    stickyToBottomRef.current = true
    cancelBottomSettle()
    const token = bottomSettleTokenRef.current

    const settle = (frame: number, previousHeight: number, stableFrames: number): void => {
      if (token !== bottomSettleTokenRef.current || !stickyToBottomRef.current) return

      const viewport = listRef.current?.element
      if (!viewport) {
        if (frame >= BOTTOM_SETTLE_MAX_FRAMES) return
        bottomSettleFrameRef.current = requestAnimationFrame(() =>
          settle(frame + 1, previousHeight, stableFrames)
        )
        return
      }

      if (frame === 0) {
        // First make the tail part of the rendered range. The next frame will
        // read the concrete scrollHeight after react-window commits it.
        scrollToLastRow()
      } else {
        scrollToBottomNow()
      }

      const height = viewport.scrollHeight
      const distanceToBottom = height - viewport.scrollTop - viewport.clientHeight
      const viewportReady = viewport.clientHeight > 0
      const heightStable = previousHeight >= 0 && Math.abs(height - previousHeight) < 1
      const nextStableFrames = heightStable ? stableFrames + 1 : 0

      if (
        frame < BOTTOM_SETTLE_MAX_FRAMES &&
        (!viewportReady ||
          distanceToBottom > BOTTOM_SETTLE_DISTANCE ||
          nextStableFrames < BOTTOM_SETTLE_STABLE_FRAMES)
      ) {
        bottomSettleFrameRef.current = requestAnimationFrame(() =>
          settle(frame + 1, height, nextStableFrames)
        )
      } else {
        bottomSettleFrameRef.current = null
      }
    }

    bottomSettleFrameRef.current = requestAnimationFrame(() => settle(0, -1, 0))
  }, [cancelBottomSettle, scrollToBottomNow, scrollToLastRow])
  const scrollToEnd = useCallback((): void => {
    queueScrollEndAnchor()
  }, [queueScrollEndAnchor])
  const scrollToMessage = useCallback(
    (messageId: string): boolean => {
      const messageRowIndex =
        liveSegment.messageRowIndexById.get(messageId) ??
        historySegment.messageRowIndexById.get(messageId)
      if (messageRowIndex === undefined) return false
      const list = listRef.current
      if (!list) return false
      stickyToBottomRef.current = false
      cancelBottomSettle()
      list.scrollToRow({
        index: messageRowIndex,
        align: "center",
        behavior: "instant"
      })
      return true
    },
    [cancelBottomSettle, historySegment.messageRowIndexById, liveSegment.messageRowIndexById]
  )

  useImperativeHandle(
    ref,
    () => ({
      get element(): HTMLDivElement | null {
        return listRef.current?.element ?? null
      },
      scrollToEnd,
      scrollToMessage
    }),
    [scrollToEnd, scrollToMessage]
  )

  // 回复完成会收缩 tail；用户正在阅读历史时，保持其当前 viewport 位置。
  useLayoutEffect(() => {
    const viewport = listRef.current?.element
    if (chatMessageListProps.isLoading) {
      completionScrollTopRef.current = null
      return () => {
        if (!viewport) return
        const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
        if (distanceToBottom > SCROLL_POSITION_PRESERVE_DISTANCE) {
          completionScrollTopRef.current = viewport.scrollTop
        }
      }
    }

    const scrollTop = completionScrollTopRef.current
    if (scrollTop === null) return undefined
    completionScrollTopRef.current = null
    if (viewport) viewport.scrollTop = scrollTop
    return undefined
  }, [chatMessageListProps.isLoading])

  // Claude-style sticky follow: initial mount and later content growth only
  // chase the bottom while sticky is still true.
  useLayoutEffect(() => {
    if (historyLoading || rowCount <= 1 || !stickyToBottomRef.current) return
    queueScrollEndAnchor()
  }, [historyLoading, queueScrollEndAnchor, rowCount, threadId])

  useEffect(() => () => cancelBottomSettle(), [cancelBottomSettle])

  const handleListResize = useCallback((): void => {
    if (!historyLoading && rowCount > 1 && stickyToBottomRef.current) {
      queueScrollEndAnchor()
    }
  }, [historyLoading, queueScrollEndAnchor, rowCount])

  // User scroll state is explicit. Content growth may follow the bottom only
  // while the user is already there; scrolling up breaks the sticky behavior,
  // and returning within the threshold re-enables it.
  useEffect(() => {
    let viewport: HTMLDivElement | null = null
    let attachFrame: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    let cleanupAttached = (): void => {}

    const updateStickyFromViewport = (): void => {
      if (!viewport) return
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const nextSticky = distanceToBottom <= BOTTOM_SETTLE_DISTANCE
      if (stickyToBottomRef.current && !nextSticky) {
        cancelBottomSettle()
      }
      stickyToBottomRef.current = nextSticky
    }

    const observeListContent = (): void => {
      if (!viewport || !resizeObserver) return
      resizeObserver.disconnect()
      resizeObserver.observe(viewport)
      const spacer = viewport.lastElementChild
      if (spacer?.getAttribute("aria-hidden") === "true") {
        resizeObserver.observe(spacer)
      }
      if (scrollEndRef.current) resizeObserver.observe(scrollEndRef.current)
    }

    const attach = (): void => {
      viewport = listRef.current?.element ?? null
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
          observeListContent()
          if (!historyLoading && stickyToBottomRef.current) {
            queueScrollEndAnchor()
          }
        })
        observeListContent()
      }

      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver(observeListContent)
        mutationObserver.observe(viewport, { childList: true })
      }

      cleanupAttached = (): void => {
        viewport?.removeEventListener("scroll", handleScroll)
        resizeObserver?.disconnect()
        mutationObserver?.disconnect()
      }
    }

    attach()

    return () => {
      if (attachFrame !== null) cancelAnimationFrame(attachFrame)
      cleanupAttached()
    }
  }, [cancelBottomSettle, historyLoading, queueScrollEndAnchor, rowCount])

  return (
    <List
      className="flex-1 min-h-0"
      defaultHeight={720}
      listRef={listRef}
      onResize={handleListResize}
      // Dynamic message heights can be much larger than the default estimate.
      // Keep a generous row buffer so range updates do not expose the spacer.
      overscanCount={VIRTUAL_CHAT_OVERSCAN_COUNT}
      rowComponent={VirtualChatTimelineRow}
      rowCount={rowCount}
      rowHeight={dynamicRowHeight}
      rowProps={rowProps}
      style={{ height: "100%", width: "100%" }}
    />
  )
})

export const ChatMessageList = React.memo(function ChatMessageList({
  messages,
  perMessageFlags,
  hookLoggingEnabled,
  hookLogBucketByTurnId,
  detachedHookLogBuckets,
  contentMessageRefs,
  setMessageRef,
  isLoading,
  toolResults,
  toolCallStates,
  pendingApprovalToolCallKeys,
  pendingApproval,
  autoApproveGitPush,
  onApprovalDecision,
  onEditUserMessage,
  onSetGoalFromMessage,
  onForkFromMessage,
  forkingMessageId,
  onOpenHookLogBucket,
  threadId,
  assistantDurationMsById,
  userSendTimeLabelById
}: ChatMessageListProps): React.JSX.Element {
  const visibleMessageLayout = useMemo(
    () =>
      buildVisibleMessageLayout(messages, (message) => {
        const hasHookLogChip =
          hookLoggingEnabled &&
          message.role === "user" &&
          Boolean(hookLogBucketByTurnId.get(message.id)?.entries.length)
        return messageHasVisibleRow(message, hasHookLogChip)
      }),
    [hookLogBucketByTurnId, hookLoggingEnabled, messages]
  )

  return (
    <>
      {messages.map((message, index) => {
        const previousMessage = visibleMessageLayout.previousVisibleMessageByIndex[index]
        const isLastMessage = index === visibleMessageLayout.lastVisibleMessageIndex
        return (
          <ChatMessageRow
            key={`${message.role}:${message.id}`}
            message={message}
            previousMessage={previousMessage}
            isStreaming={isLastMessage && isLoading}
            showAssistantMeta={perMessageFlags.showAssistantMeta[index]}
            hasUserAfterHead={perMessageFlags.hasUserAfterHead[index]}
            hookLoggingEnabled={hookLoggingEnabled}
            hookLogBucketByTurnId={hookLogBucketByTurnId}
            contentMessageRefs={contentMessageRefs}
            setMessageRef={setMessageRef}
            isLoading={isLoading}
            toolResults={toolResults}
            toolCallStates={toolCallStates}
            pendingApprovalToolCallKeys={pendingApprovalToolCallKeys}
            pendingApproval={pendingApproval}
            autoApproveGitPush={autoApproveGitPush}
            onApprovalDecision={onApprovalDecision}
            onEditUserMessage={onEditUserMessage}
            onSetGoalFromMessage={onSetGoalFromMessage}
            onForkFromMessage={onForkFromMessage}
            forkingMessageId={forkingMessageId}
            onOpenHookLogBucket={onOpenHookLogBucket}
            threadId={threadId}
            assistantDurationMsById={assistantDurationMsById}
            userSendTimeLabelById={userSendTimeLabelById}
          />
        )
      })}

      {hookLoggingEnabled && detachedHookLogBuckets.length > 0 && (
        <div className="flex flex-wrap justify-start gap-2 mt-1">
          {detachedHookLogBuckets.map((bucket) => (
            <HookLogChip
              key={bucket.turnId}
              bucket={bucket}
              onClick={() => onOpenHookLogBucket(bucket.turnId)}
            />
          ))}
        </div>
      )}
    </>
  )
})
