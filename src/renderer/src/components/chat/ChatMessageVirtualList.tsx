import React, { useEffect, useMemo, useRef } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import type { HookLogBucket } from "@/lib/thread-context"
import { buildVisibleMessageLayout, messageHasVisibleRow } from "@/lib/message-display-visibility"
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

export interface ChatMessageFlags {
  showAssistantMeta: boolean[]
  hasUserAfterHead: boolean[]
}

export const CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD = 100

export interface ChatMessageVirtualListProps {
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
  customScrollParent: HTMLDivElement | null
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  onInitialVirtualItemsRendered: () => void
  onContentHeightChanged: () => void
  onAtBottomStateChange: (atBottom: boolean) => void
  footer: React.ReactNode
}

const VirtuosoMessageListWrapper = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, style, children, ...props }, ref) => (
  <div ref={ref} className={className} style={style} {...props}>
    {children}
  </div>
))
VirtuosoMessageListWrapper.displayName = "VirtuosoMessageListWrapper"

export const ChatMessageVirtualList = React.memo(function ChatMessageVirtualList({
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
  userSendTimeLabelById,
  customScrollParent,
  virtuosoRef,
  onInitialVirtualItemsRendered,
  onContentHeightChanged,
  onAtBottomStateChange,
  footer
}: ChatMessageVirtualListProps): React.JSX.Element | null {
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
  const visibleMessages = useMemo(
    () =>
      messages.flatMap((message, index) => {
        const hookLogBucket =
          hookLoggingEnabled && message.role === "user"
            ? hookLogBucketByTurnId.get(message.id)
            : undefined
        return messageHasVisibleRow(message, Boolean(hookLogBucket?.entries.length))
          ? [{ message, index }]
          : []
      }),
    [hookLogBucketByTurnId, hookLoggingEnabled, messages]
  )
  const shouldVirtualize = visibleMessages.length > CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD
  const initialVirtualItemsRenderedRef = useRef(false)

  useEffect(() => {
    initialVirtualItemsRenderedRef.current = false
  }, [shouldVirtualize, threadId])

  const handleItemsRendered = (): void => {
    if (initialVirtualItemsRenderedRef.current) return
    initialVirtualItemsRenderedRef.current = true
    onInitialVirtualItemsRendered()
  }

  const renderMessage = ({
    message,
    index
  }: (typeof visibleMessages)[number]): React.JSX.Element => {
    const previousMessage = visibleMessageLayout.previousVisibleMessageByIndex[index]
    const isLastMessage = index === visibleMessageLayout.lastVisibleMessageIndex
    const hasUserAfterHead = perMessageFlags.hasUserAfterHead[index]
    const showAssistantMeta = perMessageFlags.showAssistantMeta[index]

    const hookLogBucketForTurn =
      hookLoggingEnabled && message.role === "user"
        ? hookLogBucketByTurnId.get(message.id)
        : undefined

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
  }

  const footerContent = (
    <>
      {hookLoggingEnabled && detachedHookLogBuckets.length > 0 ? (
        <div className="flex flex-wrap justify-start gap-2 mt-1 pt-4">
          {detachedHookLogBuckets.map((bucket) => (
            <HookLogChip
              key={bucket.turnId}
              bucket={bucket}
              onClick={() => onOpenHookLogBucket(bucket.turnId)}
            />
          ))}
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

    return () => {
      resizeObserver?.disconnect()
    }
  }, [customScrollParent, onContentHeightChanged, shouldVirtualize])

  if (!shouldVirtualize || !customScrollParent) {
    return (
      <VirtuosoMessageListWrapper>
        {visibleMessages.map((item) => (
          <React.Fragment key={`${item.message.role}:${item.message.id}`}>
            {renderMessage(item)}
          </React.Fragment>
        ))}
        {footerContent}
      </VirtuosoMessageListWrapper>
    )
  }

  return (
    <Virtuoso
      key={threadId}
      ref={virtuosoRef}
      data={visibleMessages}
      customScrollParent={customScrollParent}
      alignToBottom
      atBottomThreshold={32}
      followOutput={() => false}
      atBottomStateChange={onAtBottomStateChange}
      defaultItemHeight={112}
      increaseViewportBy={{ top: 600, bottom: 900 }}
      computeItemKey={(_index, item) => `${item.message.role}:${item.message.id}`}
      itemsRendered={handleItemsRendered}
      totalListHeightChanged={onContentHeightChanged}
      components={{
        List: VirtuosoMessageListWrapper,
        Footer: () => footerContent
      }}
      itemContent={(_index, item) => renderMessage(item)}
    />
  )
})
