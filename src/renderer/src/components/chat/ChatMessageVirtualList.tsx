import { windowPresentation } from "@/lib/window-presentation"
import { claimVirtualizedChatScrollAnchor } from "@/lib/chat-scroll-anchor-owner"
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { startInitialChatPresentation, sampleInitialChatPresentation, isFirstLiveChatUserRow } from "@/lib/chat-initial-presentation"
import { Loader2 } from "lucide-react"
import {
  Virtuoso,
  type FlatIndexLocationWithAlign,
  type ListRange,
  type VirtuosoHandle
} from "react-virtuoso"
import type { HookLogBucket } from "@/lib/thread-context"
import { getAssistantStartTime } from "@/lib/message-bubble-timing"
import {
  areMessageRenderFieldsEqual,
  areMessageToolRenderInputsEqual
} from "@/lib/message-render-stability"
import type { HITLRequest, Message, ToolCallState } from "@/types"
import { HookLogChip } from "./HookLogViews"
import { MessageBubble } from "./MessageBubble"
import { FunctionTurnNotices } from "./FunctionTurnNotices"
import type { FunctionTurnNotice } from "../../../../shared/mods/v2/turn"
import { placeFunctionTurnNotices } from "../../../../shared/mods/v2/turn-notice-placement"
import { ChatSearchContext } from "./ChatSearchContext"
import { ReasoningExpansionContext, ReasoningExpansionStore } from "./reasoning-expansion-context"
import {
  UserMessageExpansionContext,
  UserMessageExpansionStore
} from "./user-message-expansion-context"
import { subscribeToMessageDiscard, type MessageAttempts } from "@/lib/message-discard-events"
import { projectChatVirtualWindow } from "./chat-virtual-window"
import { ChatVirtualPrependLayout, type ChatVirtualPrependLayoutContext } from "./chat-virtual-prepend-layout"
import type { ChatSearchLocation, ChatSearchReveal } from "../../../../shared/chat-search-types"
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
const EMPTY_FUNCTION_NOTICES: readonly FunctionTurnNotice[] = []

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
  { startIndex, endIndex }: ListRange,
  firstItemIndex = 0
): ChatScrollVirtualRangeSnapshot | null {
  const firstMessageIndex = visibleMessageIndexes[startIndex - firstItemIndex]
  const lastMessageIndex = visibleMessageIndexes[endIndex - firstItemIndex]
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
  functionTurnNotices?: readonly FunctionTurnNotice[]
  messageAttempts?: MessageAttempts
  searchReveal?: ChatSearchReveal | null
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
  messageGeneration: number
  messageRevision: number
  searchLocation?: ChatSearchLocation
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
  messageGeneration,
  messageRevision,
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
  userSendTimeLabel,
  searchLocation
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
        messageGeneration={messageGeneration}
        messageRevision={messageRevision}
        searchLocation={message.role === "assistant" && searchLocation?.kind === "body"
          ? searchLocation : undefined}
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
      {(message.role !== "assistant" || searchLocation?.kind !== "body") &&
        <ChatSearchContext location={searchLocation} />}
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
    previous.messageGeneration === next.messageGeneration &&
    previous.messageRevision === next.messageRevision &&
    areMessageRenderFieldsEqual(previous.message, next.message) &&
    (previous.message === next.message ||
      getAssistantStartTime(previous.message) === getAssistantStartTime(next.message)) &&
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
    previous.searchLocation === next.searchLocation &&
    areMessageToolRenderInputsEqual(previous.message, previous, next)
  )
}

const ChatMessageRow = React.memo(ChatMessageRowImpl, areChatMessageRowPropsEqual)

// Virtuoso measures item boxes, excluding margins. Put spacing inside each measured item;
// space-y-* on the list makes the DOM taller than the virtual offsets and causes scroll jumps.
// flow-root 同时阻止系统通知等子元素的顶部 margin 穿透 item，确保混合消息也能完整测量。
const VirtuosoMessageListWrapper = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div"> & { context?: ChatVirtualListContext }
>(({ className, style, children, ...props }, ref) => (
  <ChatVirtualPrependLayout
    forwardedRef={ref}
    className={["[&>[data-item-index]]:flow-root [&>[data-item-index]]:pb-4", className]
      .filter(Boolean)
      .join(" ")}
    style={style}
    {...props}
  >
    {children}
  </ChatVirtualPrependLayout>
))
VirtuosoMessageListWrapper.displayName = "VirtuosoMessageListWrapper"

interface ChatVirtualListContext extends ChatVirtualPrependLayoutContext {
  header: React.ReactNode
  footer: React.ReactNode
}

interface ChatVirtualMessageRow {
  identity: string
  messageIndex: number
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
  functionTurnNotices = EMPTY_FUNCTION_NOTICES,
  messageAttempts,
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
  searchReveal,
  customScrollParent,
  virtuosoRef,
  navigatorVirtualRangeRef,
  initialTopMostItemIndex,
  onInitialVirtualItemsRendered,
  onContentHeightChanged,
  onAtBottomStateChange,
  footer
}: ChatMessageVirtualListProps): React.JSX.Element | null {
  const virtualRows = useMemo(() => visibleMessageIndexes.map(messageIndex => {
    const message = messages[messageIndex]
    const identity = message ? JSON.stringify([message.role, message.id, message.tool_call_id ?? "",
      message.provider_source_id ?? "", message.provider_occurrence ?? ""])
      : `missing:${messageIndex}`
    return { identity, messageIndex }
  }), [messages, visibleMessageIndexes])
  const virtualIdentities = useMemo(() => virtualRows.map(row => row.identity), [virtualRows])
  const virtualPositionByIdentity = useMemo(() =>
    new Map(virtualRows.map((row, index) => [row.identity, index])), [virtualRows])
  const [previousVirtualWindow, setVirtualWindow] = useState(() =>
    projectChatVirtualWindow(null, threadId, virtualIdentities))
  const virtualWindow = projectChatVirtualWindow(previousVirtualWindow, threadId, virtualIdentities)
  if (virtualWindow !== previousVirtualWindow) setVirtualWindow(virtualWindow)
  const turnNoticePlacements = useMemo(
    () =>
      placeFunctionTurnNotices(
        messages,
        visibleMessageIndexes,
        functionTurnNotices,
        historyGapBeforeMessageId
      ),
    [messages, visibleMessageIndexes, functionTurnNotices, historyGapBeforeMessageId]
  )
  const shouldVirtualize = shouldVirtualizeChatMessageList(visibleMessageIndexes.length)
  useLayoutEffect(() => {
    if (!shouldVirtualize || !customScrollParent) return
    return claimVirtualizedChatScrollAnchor(customScrollParent)
  }, [customScrollParent, shouldVirtualize])
  const presentationRoot = useRef<HTMLDivElement>(null)
  const [presentedThread, setPresentedThread] = useState<string | null>(null)
  // Only a first live user row bypasses history settling. A running history still needs the barrier.
  const firstLiveUserRow = isFirstLiveChatUserRow(isLoading, canLoadReleasedHistory,
    visibleMessageIndexes.length, messages[visibleMessageIndexes[0]]?.role)
  const presentationReady = presentedThread === threadId || firstLiveUserRow
  if (firstLiveUserRow && presentedThread !== threadId) setPresentedThread(threadId)
  useLayoutEffect(() => {
    if (!shouldVirtualize || !customScrollParent || !presentationRoot.current || presentationReady) return
    const root = presentationRoot.current
    const viewport = customScrollParent
    const gate = startInitialChatPresentation({
      sample: () => sampleInitialChatPresentation(root, viewport),
      reveal: () => setPresentedThread(threadId),
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: id => window.cancelAnimationFrame(id),
      setDeadline: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearDeadline: id => clearTimeout(id),
      now: () => performance.now(),
      isVisible: () => windowPresentation.isPresentable(root.ownerDocument.visibilityState === "visible")
    })
    // Do not hold the user's scroll/focus intent behind the initial presentation barrier.
    const reveal = (): void => gate.reveal()
    const visibilityChanged = (): void => gate.visibilityChanged()
    root.ownerDocument.addEventListener("visibilitychange", visibilityChanged)
    const unsubscribePresentation = windowPresentation.subscribe(visibilityChanged)
    viewport.addEventListener("wheel", reveal, { passive: true })
    viewport.addEventListener("touchstart", reveal, { passive: true })
    viewport.addEventListener("pointerdown", reveal)
    viewport.addEventListener("keydown", reveal)
    return () => {
      gate.dispose()
      root.ownerDocument.removeEventListener("visibilitychange", visibilityChanged)
      unsubscribePresentation()
      viewport.removeEventListener("wheel", reveal)
      viewport.removeEventListener("touchstart", reveal)
      viewport.removeEventListener("pointerdown", reveal)
      viewport.removeEventListener("keydown", reveal)
    }
  }, [threadId, shouldVirtualize, customScrollParent, presentationReady])

  const reasoningExpansion = useMemo<{
    threadId: string
    choices: NonNullable<React.ContextType<typeof ReasoningExpansionContext>>
  }>(() => ({ threadId, choices: new ReasoningExpansionStore() }), [threadId])
  const userMessageExpansion = useMemo(
    () => ({ threadId, choices: new UserMessageExpansionStore() }),
    [threadId]
  )
  useLayoutEffect(
    () =>
      subscribeToMessageDiscard(threadId, (messageIds, revision) => {
        reasoningExpansion.choices.discardMessages(threadId, messageIds, revision)
        userMessageExpansion.choices.discardMessages(threadId, messageIds, revision)
      }),
    [reasoningExpansion, threadId, userMessageExpansion]
  )
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
        range,
        virtualWindow.firstItemIndex
      )
    },
    [messages, navigatorVirtualRangeRef, visibleMessageIndexes, virtualWindow.firstItemIndex]
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
            messageGeneration={messageAttempts?.generations.get(message.id) ?? 0}
            messageRevision={messageAttempts?.revision ?? 0}
            searchLocation={searchReveal?.messageId === message.id ? searchReveal.location : undefined}
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
          <FunctionTurnNotices
            notices={turnNoticePlacements.get(message.id)}
            anchorMessageId={message.id}
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
      messageAttempts,
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
      turnNoticePlacements,
      userSendTimeLabelById,
      searchReveal,
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
    // The scroll parent arrives in the container's first layout effect. Mounting rows here
    // would parse every Markdown bubble before paint, then remount them inside Virtuoso.
    // Keep the initial commit cheap for cached threads as well as cold history loads.
    return (
      <VirtuosoMessageListWrapper>
        {historyHeader}
        {footerContent}
      </VirtuosoMessageListWrapper>
    )
  }

  return (
    <ReasoningExpansionContext.Provider value={reasoningExpansion.choices}>
    <UserMessageExpansionContext.Provider value={userMessageExpansion.choices}>
      <div ref={presentationRoot} className="relative" data-chat-initial-presentation={presentationReady ? "ready" : "pending"}>
      <Virtuoso<ChatVirtualMessageRow, ChatVirtualListContext>
        key={virtualWindow.key}
        firstItemIndex={virtualWindow.firstItemIndex}
        // Clip paint only; keep authorized site scheduling, geometry and scroll measurement live.
        style={presentationReady ? undefined : { clipPath: "inset(50%)" }}
        inert={!presentationReady}
        aria-hidden={!presentationReady || undefined}
        ref={virtuosoRef}
        data={virtualRows}
        customScrollParent={customScrollParent}
        initialTopMostItemIndex={resolvedInitialTopMostItemIndex}
        alignToBottom
        atBottomThreshold={32}
        followOutput={false}
        skipAnimationFrameInResizeObserver
        atBottomStateChange={onAtBottomStateChange}
        // Probe the actual initial row instead of estimating a tall transcript from a
        // fixed short-message height. Pending content is still measured independently.
        increaseViewportBy={{ top: 600, bottom: 900 }}
        computeItemKey={(_index, row) => row.identity}
        itemsRendered={handleItemsRendered}
        rangeChanged={handleVirtualRangeChanged}
        totalListHeightChanged={onContentHeightChanged}
        context={{ header: historyHeader, footer: footerContent,
          windowKey: virtualWindow.key, firstItemIndex: virtualWindow.firstItemIndex,
          scrollParent: customScrollParent }}
        components={chatVirtualListComponents}
        itemContent={(_absoluteIndex, row) => {
          // Virtuoso can expose its previous measured row during the prepend transaction.
          // Resolve that exact identity in the new projection, never read its old numeric slot.
          const visibleIndex = virtualPositionByIdentity.get(row.identity)
          return visibleIndex === undefined ? null
            : renderMessage(visibleIndex, visibleMessageIndexes[visibleIndex])
        }}
      />
      {!presentationReady && <div aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-3 space-y-3">
        <div className="h-3 w-1/2 rounded bg-muted" />
        <div className="h-3 w-1/3 rounded bg-muted" />
      </div>}
      </div>
    </UserMessageExpansionContext.Provider>
    </ReasoningExpansionContext.Provider>
  )
})
