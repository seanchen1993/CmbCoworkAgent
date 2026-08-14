import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react"
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
import {
  buildVisibleMessageLayout,
  messageHasVisibleRow,
  type VisibleMessageLayout
} from "@/lib/message-display-visibility"

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
})

export const VIRTUAL_CHAT_TIMELINE_THRESHOLD = 80
const INITIAL_SCROLL_CORRECTION_LIMIT = 8

interface VirtualChatTimelineItem {
  id: string
  messageIndex?: number
}

export interface ChatVirtualTimelineHandle {
  readonly element: HTMLDivElement | null
  scrollToEnd(): void
  scrollToMessage(messageId: string): boolean
}

interface VirtualChatTimelineRowProps {
  items: readonly VirtualChatTimelineItem[]
  messages: readonly Message[]
  perMessageFlags: ChatMessageFlags
  visibleMessageLayout: VisibleMessageLayout<Message>
  reserveRightSpace: boolean
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
  items,
  messages,
  perMessageFlags,
  visibleMessageLayout,
  reserveRightSpace,
  tail,
  scrollEndRef,
  chatMessageListProps
}: RowComponentProps<VirtualChatTimelineRowProps>): React.JSX.Element {
  const item = items[index]
  const messageIndex = item.messageIndex
  let content: React.ReactNode
  if (messageIndex === undefined) {
    content = (
      <>
        {tail}
        <span ref={scrollEndRef} aria-hidden="true" />
      </>
    )
  } else {
    const message = messages[messageIndex]
    content = message ? (
      <ChatMessageRow
        {...chatMessageListProps}
        message={message}
        previousMessage={visibleMessageLayout.previousVisibleMessageByIndex[messageIndex]}
        isStreaming={
          messageIndex === visibleMessageLayout.lastVisibleMessageIndex &&
          chatMessageListProps.isLoading
        }
        showAssistantMeta={perMessageFlags.showAssistantMeta[messageIndex]}
        hasUserAfterHead={perMessageFlags.hasUserAfterHead[messageIndex]}
      />
    ) : null
  }

  return (
    <div style={style} {...ariaAttributes}>
      <div className={cn("px-4 py-2", reserveRightSpace && "md:pr-[20px]")}>
        <div className="max-w-3xl mx-auto">{content}</div>
      </div>
    </div>
  )
}

interface VirtualChatTimelineProps {
  messages: readonly Message[]
  perMessageFlags: ChatMessageFlags
  reserveRightSpace: boolean
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
    messages,
    perMessageFlags,
    reserveRightSpace,
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
  const initialScrollActiveRef = useRef(false)
  const initialScrollCorrectionsRef = useRef(0)
  const initialScrollFrameRef = useRef<number | null>(null)
  const initialScrollSettledFrameRef = useRef<number | null>(null)
  const scrollEndFrameRef = useRef<number | null>(null)
  const scrollEndRef = useRef<HTMLSpanElement>(null)
  const pendingAssistantScrollFromMessageIdRef = useRef<string | null>(null)
  const lastMessageIdRef = useRef<string | null>(null)
  lastMessageIdRef.current = messages[messages.length - 1]?.id ?? null
  const { items, visibleMessageLayout, messageRowIndexById } = useMemo(() => {
    const layout = buildVisibleMessageLayout(messages, (message) => {
      const hasHookLogChip =
        chatMessageListProps.hookLoggingEnabled &&
        message.role === "user" &&
        Boolean(chatMessageListProps.hookLogBucketByTurnId.get(message.id)?.entries.length)
      return messageHasVisibleRow(message, hasHookLogChip)
    })
    const nextItems: VirtualChatTimelineItem[] = []
    const nextMessageRowIndexById = new Map<string, number>()

    messages.forEach((message, messageIndex) => {
      const hasHookLogChip =
        chatMessageListProps.hookLoggingEnabled &&
        message.role === "user" &&
        Boolean(chatMessageListProps.hookLogBucketByTurnId.get(message.id)?.entries.length)
      if (!messageHasVisibleRow(message, hasHookLogChip)) return

      nextMessageRowIndexById.set(message.id, nextItems.length)
      nextItems.push({
        id: `message:${message.role}:${message.id}`,
        messageIndex
      })
    })

    // Keep a concrete end anchor mounted for explicit user-initiated scrolling.
    nextItems.push({
      id: "timeline-tail"
    })

    return {
      items: nextItems,
      visibleMessageLayout: layout,
      messageRowIndexById: nextMessageRowIndexById
    }
  }, [
    chatMessageListProps.hookLogBucketByTurnId,
    chatMessageListProps.hookLoggingEnabled,
    messages
  ])
  lastRowIndexRef.current = Math.max(0, items.length - 1)

  const dynamicRowHeight = useDynamicRowHeight({
    defaultRowHeight: 180,
    key: items.map((item) => item.id).join("\u0000")
  })
  const rowProps = useMemo(
    () => ({
      items,
      messages,
      perMessageFlags,
      visibleMessageLayout,
      reserveRightSpace,
      tail,
      scrollEndRef,
      chatMessageListProps: {
        ...chatMessageListProps,
        setMessageRef
      }
    }),
    [
      chatMessageListProps,
      items,
      messages,
      perMessageFlags,
      tail,
      reserveRightSpace,
      setMessageRef,
      scrollEndRef,
      visibleMessageLayout
    ]
  )
  const scrollToLastRow = useCallback((): void => {
    listRef.current?.scrollToRow({
      index: lastRowIndexRef.current,
      align: "end",
      behavior: "instant"
    })
  }, [])
  const queueScrollEndAnchor = useCallback((): void => {
    if (scrollEndFrameRef.current !== null) {
      cancelAnimationFrame(scrollEndFrameRef.current)
    }
    scrollEndFrameRef.current = requestAnimationFrame(() => {
      scrollEndFrameRef.current = null
      // Mount the tail row without reading layout, then use its concrete anchor.
      scrollToLastRow()
      scrollEndFrameRef.current = requestAnimationFrame(() => {
        scrollEndFrameRef.current = null
        scrollEndRef.current?.scrollIntoView({ block: "end", inline: "nearest" })
      })
    })
  }, [scrollToLastRow])
  const queueInitialScrollCorrection = useCallback((): void => {
    if (
      !initialScrollActiveRef.current ||
      initialScrollCorrectionsRef.current >= INITIAL_SCROLL_CORRECTION_LIMIT ||
      initialScrollFrameRef.current !== null
    ) {
      return
    }

    if (initialScrollSettledFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollSettledFrameRef.current)
      initialScrollSettledFrameRef.current = null
    }
    initialScrollFrameRef.current = requestAnimationFrame(() => {
      initialScrollFrameRef.current = null
      if (!initialScrollActiveRef.current) return

      initialScrollCorrectionsRef.current += 1
      scrollToLastRow()
      if (initialScrollCorrectionsRef.current >= INITIAL_SCROLL_CORRECTION_LIMIT) {
        initialScrollActiveRef.current = false
        return
      }

      initialScrollSettledFrameRef.current = requestAnimationFrame(() => {
        if (!initialScrollActiveRef.current) return
        scrollToLastRow()
        initialScrollSettledFrameRef.current = requestAnimationFrame(() => {
          initialScrollSettledFrameRef.current = null
          if (!initialScrollActiveRef.current) return
          scrollToLastRow()
          initialScrollActiveRef.current = false
        })
      })
    })
  }, [scrollToLastRow])
  const startInitialScrollCorrection = useCallback((): void => {
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current)
      initialScrollFrameRef.current = null
    }
    if (initialScrollSettledFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollSettledFrameRef.current)
      initialScrollSettledFrameRef.current = null
    }
    initialScrollActiveRef.current = true
    initialScrollCorrectionsRef.current = 0
    queueInitialScrollCorrection()
  }, [queueInitialScrollCorrection])
  const scrollToEnd = useCallback((): void => {
    pendingAssistantScrollFromMessageIdRef.current = lastMessageIdRef.current
    queueScrollEndAnchor()
  }, [queueScrollEndAnchor])
  const handleListResize = useCallback((): void => {
    queueInitialScrollCorrection()
  }, [queueInitialScrollCorrection])
  const scrollToMessage = useCallback(
    (messageId: string): boolean => {
      const messageRowIndex = messageRowIndexById.get(messageId)
      if (messageRowIndex === undefined) return false
      listRef.current?.scrollToRow({
        index: messageRowIndex,
        align: "center",
        behavior: "smooth"
      })
      return true
    },
    [messageRowIndexById]
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

  useEffect(() => {
    const pendingMessageId = pendingAssistantScrollFromMessageIdRef.current
    const lastMessage = messages[messages.length - 1]
    if (
      !pendingMessageId ||
      !lastMessage ||
      lastMessage.id === pendingMessageId ||
      lastMessage.role !== "assistant"
    ) {
      return
    }

    pendingAssistantScrollFromMessageIdRef.current = null
    queueScrollEndAnchor()
  }, [messages, queueScrollEndAnchor])

  useEffect(() => {
    if (historyLoading) return undefined
    startInitialScrollCorrection()
    return () => {
      initialScrollActiveRef.current = false
      initialScrollCorrectionsRef.current = 0
      if (initialScrollFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollFrameRef.current)
        initialScrollFrameRef.current = null
      }
      if (initialScrollSettledFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollSettledFrameRef.current)
        initialScrollSettledFrameRef.current = null
      }
      if (scrollEndFrameRef.current !== null) {
        cancelAnimationFrame(scrollEndFrameRef.current)
        scrollEndFrameRef.current = null
      }
    }
  }, [historyLoading, startInitialScrollCorrection, threadId])

  // Dynamic row measurements replace react-window's estimated heights after
  // the list reaches the tail, so re-align only during initial entry.
  useEffect(() => {
    queueInitialScrollCorrection()
  }, [dynamicRowHeight, queueInitialScrollCorrection])

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible" && initialScrollActiveRef.current) {
        if (initialScrollFrameRef.current !== null) {
          cancelAnimationFrame(initialScrollFrameRef.current)
          initialScrollFrameRef.current = null
        }
        queueInitialScrollCorrection()
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [queueInitialScrollCorrection])

  return (
    <List
      className="flex-1 min-h-0"
      defaultHeight={720}
      listRef={listRef}
      onResize={handleListResize}
      overscanCount={8}
      rowComponent={VirtualChatTimelineRow}
      rowCount={items.length}
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
