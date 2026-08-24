import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import type { HookLogBucket } from "@/lib/thread-context"
import {
  areMessageRenderFieldsEqual,
  areMessageToolRenderInputsEqual
} from "@/lib/message-render-stability"
import type { HITLRequest, Message, ToolCallState } from "@/types"
import { HookLogChip } from "./HookLogViews"
import { MessageBubble } from "./MessageBubble"

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

export const CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD = 100
const DETACHED_HOOK_LOG_WINDOW_SIZE = 80

export interface ChatMessageVirtualListProps {
  messages: Message[]
  visibleMessageIndexes: readonly number[]
  lastUserMessageIndex: number
  contentVersion: number
  historyHasMore: boolean
  historyPageLoading: boolean
  historyRemainingCount: number
  onLoadEarlierHistoryPage: () => void
  onRenderedMessageIdsChange: (messageIds: readonly string[]) => void
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
  customScrollParent: HTMLDivElement | null
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  onInitialVirtualItemsRendered: () => void
  onContentHeightChanged: () => void
  onAtBottomStateChange: (atBottom: boolean) => void
  footer: React.ReactNode
}

interface ChatMessageRowProps {
  message: Message
  previousMessage: Message | null
  isLastMessage: boolean
  hasUserAfterHead: boolean
  showAssistantMeta: boolean
  hookLogBucket?: HookLogBucket
  contentMessageRefs: React.RefObject<Map<string, HTMLDivElement>>
  setMessageRef: ChatMessageVirtualListProps["setMessageRef"]
  isLoading: boolean
  toolResults: Map<string, ChatToolResultInfo>
  toolCallStates: Map<string, ToolCallState>
  pendingApprovalToolCallKeys: Set<string>
  pendingApproval: HITLRequest | null
  autoApproveGitPush: boolean
  onApprovalDecision: ChatMessageVirtualListProps["onApprovalDecision"]
  onEditUserMessage: ChatMessageVirtualListProps["onEditUserMessage"]
  onSetGoalFromMessage: ChatMessageVirtualListProps["onSetGoalFromMessage"]
  onForkFromMessage: ChatMessageVirtualListProps["onForkFromMessage"]
  forkingMessageId: string | null
  onOpenHookLogBucket: ChatMessageVirtualListProps["onOpenHookLogBucket"]
  threadId: string
  assistantDurationMs?: number
  userSendTimeLabel: string | null
}

function ChatMessageRowImpl({
  message,
  previousMessage,
  isLastMessage,
  hasUserAfterHead,
  showAssistantMeta,
  hookLogBucket,
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
  assistantDurationMs,
  userSendTimeLabel
}: ChatMessageRowProps): React.JSX.Element {
  const navigatorRef = useMemo(
    () => setMessageRef(message.id, message.role),
    [message.id, message.role, setMessageRef]
  )
  const contentMessageRefMap = contentMessageRefs.current
  const combinedRef = useCallback(
    (node: HTMLDivElement | null): void => {
      navigatorRef(node)
      if (node && message.role !== "tool") {
        contentMessageRefMap.set(message.id, node)
        return
      }
      contentMessageRefMap.delete(message.id)
    },
    [contentMessageRefMap, message.id, message.role, navigatorRef]
  )
  const handleOpenHookLogBucket = useCallback(() => {
    if (hookLogBucket) onOpenHookLogBucket(hookLogBucket.turnId)
  }, [hookLogBucket, onOpenHookLogBucket])

  return (
    <div
      ref={combinedRef}
      data-chat-message-row=""
      data-chat-message-id={message.id}
      data-message-role={message.role}
    >
      <MessageBubble
        message={message}
        previousMessage={previousMessage}
        isStreaming={isLastMessage && isLoading}
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
        assistantDurationMs={assistantDurationMs}
        userSendTimeLabel={userSendTimeLabel}
      />
      {hookLogBucket && hookLogBucket.entries.length > 0 && (
        <div className="mt-1 ml-12">
          <HookLogChip bucket={hookLogBucket} onClick={handleOpenHookLogBucket} />
        </div>
      )}
    </div>
  )
}

function areChatMessageRowPropsEqual(
  previous: Readonly<ChatMessageRowProps>,
  next: Readonly<ChatMessageRowProps>
): boolean {
  return (
    areMessageRenderFieldsEqual(previous.message, next.message) &&
    (previous.previousMessage?.role ?? null) === (next.previousMessage?.role ?? null) &&
    previous.isLastMessage === next.isLastMessage &&
    previous.hasUserAfterHead === next.hasUserAfterHead &&
    previous.showAssistantMeta === next.showAssistantMeta &&
    previous.hookLogBucket === next.hookLogBucket &&
    previous.contentMessageRefs === next.contentMessageRefs &&
    previous.setMessageRef === next.setMessageRef &&
    previous.isLoading === next.isLoading &&
    previous.pendingApproval === next.pendingApproval &&
    previous.autoApproveGitPush === next.autoApproveGitPush &&
    previous.onApprovalDecision === next.onApprovalDecision &&
    previous.onEditUserMessage === next.onEditUserMessage &&
    previous.onSetGoalFromMessage === next.onSetGoalFromMessage &&
    previous.onForkFromMessage === next.onForkFromMessage &&
    previous.forkingMessageId === next.forkingMessageId &&
    previous.onOpenHookLogBucket === next.onOpenHookLogBucket &&
    previous.threadId === next.threadId &&
    previous.assistantDurationMs === next.assistantDurationMs &&
    previous.userSendTimeLabel === next.userSendTimeLabel &&
    areMessageToolRenderInputsEqual(previous.message, previous, next)
  )
}

const ChatMessageRow = React.memo(ChatMessageRowImpl, areChatMessageRowPropsEqual)

const VirtuosoMessageListWrapper = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, style, children, ...props }, ref) => (
  <div
    ref={ref}
    className={["space-y-4", className].filter(Boolean).join(" ")}
    style={style}
    {...props}
  >
    {children}
  </div>
))
VirtuosoMessageListWrapper.displayName = "VirtuosoMessageListWrapper"

interface ChatVirtualListContext {
  header: React.ReactNode
  footer: React.ReactNode
}

function ChatVirtualListHeader({
  context
}: {
  context?: ChatVirtualListContext
}): React.JSX.Element {
  return <>{context?.header}</>
}

function ChatVirtualListFooter({
  context
}: {
  context?: ChatVirtualListContext
}): React.JSX.Element {
  return <>{context?.footer}</>
}

const chatVirtualListComponents = {
  Header: ChatVirtualListHeader,
  List: VirtuosoMessageListWrapper,
  Footer: ChatVirtualListFooter
}

export const ChatMessageVirtualList = React.memo(function ChatMessageVirtualList({
  messages,
  visibleMessageIndexes,
  lastUserMessageIndex,
  contentVersion,
  historyHasMore,
  historyPageLoading,
  historyRemainingCount,
  onLoadEarlierHistoryPage,
  onRenderedMessageIdsChange,
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
  userSendTimeLabelById,
  customScrollParent,
  virtuosoRef,
  onInitialVirtualItemsRendered,
  onContentHeightChanged,
  onAtBottomStateChange,
  footer
}: ChatMessageVirtualListProps): React.JSX.Element | null {
  const shouldVirtualize =
    visibleMessageIndexes.length > CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD
  const initialVirtualItemsRenderedRef = useRef(false)
  const [detachedHookLogOffsetFromTail, setDetachedHookLogOffsetFromTail] = useState(0)

  useEffect(() => {
    initialVirtualItemsRenderedRef.current = false
  }, [shouldVirtualize, threadId])

  const handleItemsRendered = (): void => {
    if (initialVirtualItemsRenderedRef.current) return
    initialVirtualItemsRenderedRef.current = true
    onInitialVirtualItemsRendered()
  }

  const renderMessage = useCallback(
    (visibleIndex: number, messageIndex: number): React.JSX.Element | null => {
      const message = messages[messageIndex]
      if (!message) return null
      const previousMessageIndex = visibleMessageIndexes[visibleIndex - 1]
      const previousMessage =
        previousMessageIndex === undefined ? null : messages[previousMessageIndex] ?? null
      const nextMessageIndex = visibleMessageIndexes[visibleIndex + 1]
      const nextMessage =
        nextMessageIndex === undefined ? null : messages[nextMessageIndex] ?? null
      const hookLogBucket =
        hookLoggingEnabled && message.role === "user"
          ? hookLogBucketByTurnId.get(message.id)
          : undefined

      return (
        <ChatMessageRow
          message={message}
          previousMessage={previousMessage}
          isLastMessage={visibleIndex === visibleMessageIndexes.length - 1}
          hasUserAfterHead={messageIndex < lastUserMessageIndex}
          showAssistantMeta={
            message.role !== "assistant" || nextMessage === null || nextMessage.role !== "assistant"
          }
          hookLogBucket={hookLogBucket}
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
          assistantDurationMs={assistantDurationMsById.get(message.id)}
          userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
        />
      )
    },
    [
      assistantDurationMsById,
      autoApproveGitPush,
      contentMessageRefs,
      contentVersion,
      forkingMessageId,
      hookLogBucketByTurnId,
      hookLoggingEnabled,
      isLoading,
      lastUserMessageIndex,
      messages,
      onApprovalDecision,
      onEditUserMessage,
      onForkFromMessage,
      onOpenHookLogBucket,
      onSetGoalFromMessage,
      pendingApproval,
      pendingApprovalToolCallKeys,
      setMessageRef,
      threadId,
      toolCallStates,
      toolResults,
      userSendTimeLabelById,
      visibleMessageIndexes
    ]
  )

  const publishRenderedRange = useCallback(
    (startIndex: number, endIndex: number): void => {
      const messageIds: string[] = []
      for (let index = startIndex; index <= endIndex; index += 1) {
        const messageIndex = visibleMessageIndexes[index]
        const message = messageIndex === undefined ? undefined : messages[messageIndex]
        if (message) messageIds.push(message.id)
      }
      onRenderedMessageIdsChange(messageIds)
    },
    [messages, onRenderedMessageIdsChange, visibleMessageIndexes]
  )

  useEffect(() => {
    if (shouldVirtualize) return
    publishRenderedRange(0, visibleMessageIndexes.length - 1)
  }, [publishRenderedRange, shouldVirtualize, visibleMessageIndexes.length])

  const detachedHookLogEnd = Math.max(
    0,
    detachedHookLogBuckets.length - detachedHookLogOffsetFromTail
  )
  const detachedHookLogStart = Math.max(
    0,
    detachedHookLogEnd - DETACHED_HOOK_LOG_WINDOW_SIZE
  )
  const renderedDetachedHookLogBuckets = detachedHookLogBuckets.slice(
    detachedHookLogStart,
    detachedHookLogEnd
  )
  const historyHeader = historyHasMore ? (
    <button
      type="button"
      data-chat-history-boundary="older"
      onClick={onLoadEarlierHistoryPage}
      disabled={historyPageLoading}
      className="mx-auto mb-4 flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-60"
    >
      {historyPageLoading && <Loader2 className="size-3 animate-spin" />}
      {historyPageLoading
        ? "正在加载更早消息"
        : `加载更早的 ${Math.max(1, Math.min(500, historyRemainingCount))} 条消息`}
    </button>
  ) : null
  const footerContent = (
    <>
      {hookLoggingEnabled && detachedHookLogBuckets.length > 0 ? (
        <div className="mt-1 space-y-2 pt-4">
          <div className="flex flex-wrap justify-start gap-2">
            {renderedDetachedHookLogBuckets.map((bucket) => (
              <HookLogChip
                key={bucket.turnId}
                bucket={bucket}
                onClick={() => onOpenHookLogBucket(bucket.turnId)}
              />
            ))}
          </div>
          <div className="flex justify-center gap-2 text-xs text-muted-foreground">
            {detachedHookLogStart > 0 && (
              <button
                type="button"
                onClick={() =>
                  setDetachedHookLogOffsetFromTail((offset) =>
                    Math.min(detachedHookLogBuckets.length, offset + DETACHED_HOOK_LOG_WINDOW_SIZE)
                  )
                }
                className="rounded-full border border-border/70 px-2 py-0.5 hover:bg-muted"
              >
                更早的 Hook 日志
              </button>
            )}
            {detachedHookLogOffsetFromTail > 0 && (
              <button
                type="button"
                onClick={() =>
                  setDetachedHookLogOffsetFromTail((offset) =>
                    Math.max(0, offset - DETACHED_HOOK_LOG_WINDOW_SIZE)
                  )
                }
                className="rounded-full border border-border/70 px-2 py-0.5 hover:bg-muted"
              >
                更新的 Hook 日志
              </button>
            )}
          </div>
        </div>
      ) : null}
      {footer}
    </>
  )

  useEffect(() => {
    if (shouldVirtualize || !customScrollParent) return
    const content = customScrollParent.firstElementChild
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onContentHeightChanged)
    if (content) resizeObserver?.observe(content)
    return () => resizeObserver?.disconnect()
  }, [customScrollParent, onContentHeightChanged, shouldVirtualize])

  if (!shouldVirtualize || !customScrollParent) {
    return (
      <VirtuosoMessageListWrapper>
        {historyHeader}
        {visibleMessageIndexes.map((messageIndex, visibleIndex) => (
          <React.Fragment
            key={`${messages[messageIndex]?.role ?? "message"}:${messages[messageIndex]?.id ?? messageIndex}`}
          >
            {renderMessage(visibleIndex, messageIndex)}
          </React.Fragment>
        ))}
        {footerContent}
      </VirtuosoMessageListWrapper>
    )
  }

  return (
    <Virtuoso<number, ChatVirtualListContext>
      key={threadId}
      ref={virtuosoRef}
      data={visibleMessageIndexes}
      customScrollParent={customScrollParent}
      alignToBottom
      atBottomThreshold={32}
      followOutput={() => false}
      atBottomStateChange={onAtBottomStateChange}
      defaultItemHeight={112}
      increaseViewportBy={{ top: 600, bottom: 900 }}
      computeItemKey={(_index, messageIndex) => {
        const message = messages[messageIndex]
        return message ? `${message.role}:${message.id}` : messageIndex
      }}
      itemsRendered={handleItemsRendered}
      rangeChanged={({ startIndex, endIndex }) => publishRenderedRange(startIndex, endIndex)}
      totalListHeightChanged={onContentHeightChanged}
      context={{ header: historyHeader, footer: footerContent }}
      components={chatVirtualListComponents}
      itemContent={(visibleIndex, messageIndex) => renderMessage(visibleIndex, messageIndex)}
    />
  )
})
