import React, { useMemo } from "react"
import { List, type ListImperativeAPI, type RowComponentProps, useDynamicRowHeight } from "react-window"
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
export type ChatTimelineListRef = ListImperativeAPI

export interface VirtualChatTimelineItem {
  id: string
  messageIndex?: number
  node?: React.ReactNode
}

interface VirtualChatTimelineRowProps {
  items: readonly VirtualChatTimelineItem[]
  messages: readonly Message[]
  perMessageFlags: ChatMessageFlags
  visibleMessageLayout: VisibleMessageLayout<Message>
  reserveRightSpace: boolean
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
  chatMessageListProps
}: RowComponentProps<VirtualChatTimelineRowProps>): React.JSX.Element {
  const item = items[index]
  const messageIndex = item.messageIndex
  let content: React.ReactNode
  if (messageIndex === undefined) {
    content = item.node ?? null
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

export function VirtualChatTimeline({
  items,
  messages,
  perMessageFlags,
  visibleMessageLayout,
  reserveRightSpace,
  listRef,
  chatMessageListProps
}: {
  items: readonly VirtualChatTimelineItem[]
  messages: readonly Message[]
  perMessageFlags: ChatMessageFlags
  visibleMessageLayout: VisibleMessageLayout<Message>
  reserveRightSpace: boolean
  listRef: React.Ref<ListImperativeAPI>
  chatMessageListProps: Omit<
    ChatMessageListProps,
    "messages" | "perMessageFlags" | "detachedHookLogBuckets"
  >
}): React.JSX.Element {
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
      chatMessageListProps
    }),
    [
      chatMessageListProps,
      items,
      messages,
      perMessageFlags,
      reserveRightSpace,
      visibleMessageLayout
    ]
  )

  return (
    <List
      className="flex-1 min-h-0"
      defaultHeight={720}
      listRef={listRef}
      overscanCount={8}
      rowComponent={VirtualChatTimelineRow}
      rowCount={items.length}
      rowHeight={dynamicRowHeight}
      rowProps={rowProps}
      style={{ height: "100%", width: "100%" }}
    />
  )
}

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
