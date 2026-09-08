import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  Virtuoso,
  type FlatIndexLocationWithAlign,
  type ListRange,
  type VirtuosoHandle
} from "react-virtuoso"
import type { HookLogBucket } from "@/lib/thread-context"
import {
  areMessageRenderFieldsEqual,
  areMessageToolRenderInputsEqual
} from "@/lib/message-render-stability"
import type { HITLRequest, Message, ToolCallState } from "@/types"
import { HookLogChip } from "./HookLogViews"
import { MessageBubble } from "./MessageBubble"
import type {
  ChatScrollVirtualRangeRef,
  ChatScrollVirtualRangeSnapshot
} from "./ChatScrollNavigator"

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

export type ChatMessageVirtualInitialLocation = FlatIndexLocationWithAlign | number

// eslint-disable-next-line react-refresh/only-export-components
export const shouldVirtualizeChatMessageList = (visibleMessageCount: number): boolean => {
  // Keep one list implementation for the whole lifetime of a non-empty conversation. Switching
  // from plain DOM to Virtuoso at message 101 loses the user's anchor while streaming or paging.
  return visibleMessageCount > 0
}

function clampVirtualItemIndex(index: number, itemCount: number): number {
  const lastIndex = Math.max(0, Math.floor(itemCount) - 1)
  if (!Number.isFinite(index)) return lastIndex
  return Math.min(lastIndex, Math.max(0, Math.floor(index)))
}

// eslint-disable-next-line react-refresh/only-export-components
export const resolveChatMessageVirtualInitialLocation = (
  location: ChatMessageVirtualInitialLocation | undefined,
  itemCount: number
): ChatMessageVirtualInitialLocation | undefined => {
  if (location === undefined || itemCount <= 0) return undefined
  if (typeof location === "number") return clampVirtualItemIndex(location, itemCount)
  if (location.index === "LAST") return location

  const index = clampVirtualItemIndex(location.index, itemCount)
  return index === location.index ? location : { ...location, index }
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveChatScrollVirtualRangeSnapshot(
  messages: readonly Message[],
  visibleMessageIndexes: readonly number[],
  { startIndex, endIndex }: ListRange
): ChatScrollVirtualRangeSnapshot | null {
  const firstMessageIndex = visibleMessageIndexes[startIndex]
  const lastMessageIndex = visibleMessageIndexes[endIndex]
  const firstMessage = messages[firstMessageIndex]
  return firstMessageIndex === undefined || lastMessageIndex === undefined
    ? null
    : {
        firstMessageIndex,
        firstMessageIdentity: firstMessage
          ? [
              firstMessage.role,
              firstMessage.id,
              firstMessage.tool_call_id ?? "",
              firstMessage.provider_source_id ?? "",
              firstMessage.provider_occurrence ?? ""
            ].join(":")
          : "",
        lastMessageIndex
      }
}

export interface ChatMessageVirtualListProps {
  messages: Message[]
  visibleMessageIndexes: readonly number[]
  lastUserMessageIndex: number
  contentVersion: number
  historyHasMore: boolean
  historyPageLoading: boolean
  historyRemainingCount: number
  onLoadEarlierHistoryPage: () => void
  historyGapBeforeMessageId: string | null
  canLoadReleasedHistory: boolean
  onLoadReleasedHistoryWindow: () => void
  onRestoreLatestHistoryWindow: () => void
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
  navigatorVirtualRangeRef: ChatScrollVirtualRangeRef
  /**
   * Initial location in the projected `visibleMessageIndexes` list. React Virtuoso reads this
   * only when its virtual list mounts; subsequent follow/restore decisions belong to the parent.
   */
  initialTopMostItemIndex?: ChatMessageVirtualInitialLocation
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
  historyGapBeforeMessageId,
  canLoadReleasedHistory,
  onLoadReleasedHistoryWindow,
  onRestoreLatestHistoryWindow,
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
  navigatorVirtualRangeRef,
  initialTopMostItemIndex,
  onInitialVirtualItemsRendered,
  onContentHeightChanged,
  onAtBottomStateChange,
  footer
}: ChatMessageVirtualListProps): React.JSX.Element | null {
  const shouldVirtualize = shouldVirtualizeChatMessageList(visibleMessageIndexes.length)
  const initialVirtualItemsRenderedThreadRef = useRef<string | null>(null)
  const [detachedHookLogOffsetFromTail, setDetachedHookLogOffsetFromTail] = useState(0)

  useEffect(() => {
    if (shouldVirtualize && customScrollParent) return
    initialVirtualItemsRenderedThreadRef.current = null
  }, [customScrollParent, shouldVirtualize])

  const resolvedInitialTopMostItemIndex = useMemo(
    () =>
      resolveChatMessageVirtualInitialLocation(
        initialTopMostItemIndex,
        visibleMessageIndexes.length
      ),
    [initialTopMostItemIndex, visibleMessageIndexes.length]
  )

  const handleVirtualRangeChanged = useCallback(
    (range: ListRange): void => {
      navigatorVirtualRangeRef.current = resolveChatScrollVirtualRangeSnapshot(
        messages,
        visibleMessageIndexes,
        range
      )
    },
    [messages, navigatorVirtualRangeRef, visibleMessageIndexes]
  )

  const handleItemsRendered = (): void => {
    if (initialVirtualItemsRenderedThreadRef.current === threadId) return
    initialVirtualItemsRenderedThreadRef.current = threadId
    onInitialVirtualItemsRendered()
  }

  const renderMessage = useCallback(
    (visibleIndex: number, messageIndex: number): React.JSX.Element | null => {
      const message = messages[messageIndex]
      if (!message) return null
      const startsAfterReleasedHistory = message.id === historyGapBeforeMessageId
      const previousMessageIndex = visibleMessageIndexes[visibleIndex - 1]
      const previousMessage =
        startsAfterReleasedHistory || previousMessageIndex === undefined
          ? null
          : (messages[previousMessageIndex] ?? null)
      const nextMessageIndex = visibleMessageIndexes[visibleIndex + 1]
      const nextMessage =
        nextMessageIndex === undefined ? null : (messages[nextMessageIndex] ?? null)
      const hookLogBucket =
        hookLoggingEnabled && message.role === "user"
          ? hookLogBucketByTurnId.get(message.id)
          : undefined

      return (
        <>
          {startsAfterReleasedHistory ? (
            <div
              data-chat-history-boundary="released-middle"
              className="mb-4 flex flex-col items-center gap-1 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-center text-xs text-muted-foreground"
            >
              <span>为控制内存，中间消息当前未驻留</span>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {canLoadReleasedHistory ? (
                  <button
                    type="button"
                    onClick={onLoadReleasedHistoryWindow}
                    disabled={historyPageLoading}
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                  >
                    {historyPageLoading ? <Loader2 className="size-3 animate-spin" /> : null}
                    {historyPageLoading ? "正在读取中间消息" : "继续读取中间消息"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onRestoreLatestHistoryWindow}
                  disabled={historyPageLoading}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                >
                  {historyPageLoading && !canLoadReleasedHistory ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  返回最新消息
                </button>
              </div>
            </div>
          ) : null}
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
        </>
      )
    },
    [
      assistantDurationMsById,
      autoApproveGitPush,
      canLoadReleasedHistory,
      contentMessageRefs,
      contentVersion,
      forkingMessageId,
      historyGapBeforeMessageId,
      historyPageLoading,
      hookLogBucketByTurnId,
      hookLoggingEnabled,
      isLoading,
      lastUserMessageIndex,
      messages,
      onApprovalDecision,
      onEditUserMessage,
      onForkFromMessage,
      onLoadReleasedHistoryWindow,
      onOpenHookLogBucket,
      onRestoreLatestHistoryWindow,
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

  const detachedHookLogEnd = Math.max(
    0,
    detachedHookLogBuckets.length - detachedHookLogOffsetFromTail
  )
  const detachedHookLogStart = Math.max(0, detachedHookLogEnd - DETACHED_HOOK_LOG_WINDOW_SIZE)
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
    const canRenderPlainRows =
      !shouldVirtualize || visibleMessageIndexes.length <= CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD
    return (
      <VirtuosoMessageListWrapper>
        {historyHeader}
        {canRenderPlainRows &&
          visibleMessageIndexes.map((messageIndex, visibleIndex) => (
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
      initialTopMostItemIndex={resolvedInitialTopMostItemIndex}
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
      rangeChanged={handleVirtualRangeChanged}
      totalListHeightChanged={onContentHeightChanged}
      context={{ header: historyHeader, footer: footerContent }}
      components={chatVirtualListComponents}
      itemContent={(visibleIndex, messageIndex) => renderMessage(visibleIndex, messageIndex)}
    />
  )
})
