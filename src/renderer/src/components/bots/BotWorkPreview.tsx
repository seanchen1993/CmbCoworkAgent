import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ArrowLeft, ChevronRight, Loader2, MessageCircle, Wrench } from "lucide-react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import type { Message, Thread, ToolCall, ToolCallState } from "@/types"
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown"
import { ChatPresentationContext } from "@/components/chat/chat-presentation-context"
import { matchesBotThreadDraftRef } from "@/lib/bot-conversation-draft"
import { splitBotInlineReasoning } from "@/lib/bot-inline-reasoning"
import { mergeBotMessageOrigins, quietBotTurnMessageIds } from "@/lib/bot-routine-visibility"
import { matchesBoundBotWorkThreadSummary } from "@/lib/bot/work-thread-summary"
import { resolveBotWorkStatus } from "@/lib/bot/work-status"
import { isVisibleCheckpointTranscriptMessage } from "@/lib/goal-transcript"
import { liveStreamMessageRole, type LiveStreamMessage } from "@/lib/live-stream-messages"
import { isThreadDeletionPending } from "@/lib/store"
import { useThreadContext } from "@/lib/thread-context"
import { getToolLabel } from "@/lib/tool-labels"
import { buildToolResultAssociations, getWorkerToolUiKey } from "@/lib/worker-tool-result-key"
import { parseBotHistoryFileDelivery } from "../../../../shared/bots/file-delivery"
import { parseBotMessageReply, projectBotReplyInput } from "../../../../shared/bots/message-reply"
import { BOT_ROUTINE_SILENT, isBotRoutineSilent } from "../../../../shared/bots/routine-silence"
import { botContinuationTaskId } from "../../../../shared/bots/task-continuation"
import type { BotMessageOrigin, BotTask } from "../../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../../shared/bots/work"
import { isVisibleTranscriptMessage, mergeCheckpointAuthorityTranscriptMessages } from "../../../../shared/checkpoint-transcript"
import { projectVisibleChatSearchContent } from "../../../../shared/chat-search-visible-content"
import { projectCoordinatorTranscriptNoise } from "../../../../shared/internal-notification-turn"
import { getMessageProviderOccurrenceIdentity } from "../../../../shared/message-role-collision"
import { cleanUserAttachmentContentForDisplay } from "../../../../shared/user-attachment-display"
import { BotWorkStatusIcon, botWorkStatus, botWorkStatusTone } from "./BotWorkPanel"

const PAGE_LIMIT = 16
const PAGE_BYTES = 96 * 1024
const REPLY_CHARS = 2400
const LIVE_TAIL_LIMIT = 24
const REQUEST_ANCHOR_LIMIT = 128

const NARROW_PREVIEW_QUERY = "(max-width: 900px)"
function subscribePreviewWidth(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_PREVIEW_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
function isNarrowPreview(): boolean {
  return window.matchMedia(NARROW_PREVIEW_QUERY).matches
}

export const BOT_WORK_DELETION_PENDING_MESSAGE = "清理尚未完成，可在主对话继续删除此任务。"

export function isWorkDeletionPending(work: BotWorkItem | null): boolean {
  return work?.deletionPending === true
}

type PreviewReply = ({ text: string; partial: boolean; progress?: "current" | "recent" } | { delivered: true }) & { orderUnconfirmed?: true }
type PreviewTaskIdentity = Pick<BotTask, "id" | "requestId">
type ActivityMessage = LiveStreamMessage & { role?: Message["role"]; created_at?: Date; subagent_tool_call_id?: string }

function previewMessageRole(message: ActivityMessage): string {
  return message.role ?? liveStreamMessageRole(message.type)
}

function findLiveRequest(messages: readonly ActivityMessage[], task?: PreviewTaskIdentity): number {
  if (!task) return -1
  const start = Math.max(0, messages.length - REQUEST_ANCHOR_LIMIT)
  for (let index = messages.length - 1; index >= start; index--) {
    const message = messages[index]
    if (previewMessageRole(message) !== "user") continue
    // Managed turns echo the Host request ID. A yielded run has its own exact continuation ID.
    return message.id && (message.id === task.requestId || botContinuationTaskId(message.id) === task.id)
      ? index : -1
  }
  return -1
}

function isSilentPreviewEnd(message: Message): boolean {
  return message.role === "assistant" && !message.subagent_tool_call_id && !message.tool_calls?.length &&
    typeof message.content === "string" && isBotRoutineSilent(message.content)
}

export function projectBotWorkPreviewReply(
  messages: readonly Message[],
  truncatedMessageIds: readonly string[] = [],
  hasOlderRows = false,
  origins: readonly BotMessageOrigin[] = []
): PreviewReply | null {
  // A stabilized current-run copy can be persisted after the guided reply.
  // Keep the original provider occurrence in its durable transcript position.
  const transcript = mergeCheckpointAuthorityTranscriptMessages(messages, [])
  const quiet = origins.length ? quietBotTurnMessageIds(transcript, mergeBotMessageOrigins(origins, [])) : undefined
  const firstUser = transcript.findIndex(message => message.role === "user")
  const leadingEnd = firstUser === -1 ? transcript.length : firstUser
  // A bounded page can cut off the source of a quiet turn. Its text cannot
  // be confirmed as visible, even if the final marker is still in the page.
  const leadingAssistant = hasOlderRows ? transcript.slice(0, leadingEnd)
    .findLast(message => message.role === "assistant" && !message.subagent_tool_call_id) : undefined
  const quietLeadingText = leadingAssistant && isSilentPreviewEnd(leadingAssistant)
  // The full task places a confirmed delivery at its assistant tool call.
  const results = buildToolResultAssociations(transcript)
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index]
    if (message.role !== "assistant" || message.subagent_tool_call_id ||
      quiet?.has(message.id) || !isVisibleCheckpointTranscriptMessage(message)) continue
    const delivered = message.tool_calls?.some((call, callIndex) => {
      if (call.name !== "bot_deliver_files") return false
      const result = results.get(getWorkerToolUiKey(message.id, call.id, callIndex))
      return result && !result.is_error && parseBotHistoryFileDelivery(result.content, message.botHistoryDeliveryScope) !== null
    })
    const text = quietLeadingText && index < leadingEnd ? "" : visiblePreviewAssistant(message).text
    if (!delivered && !text) continue
    const identity = getMessageProviderOccurrenceIdentity(message)
    const orderUnconfirmed = hasOlderRows && Boolean(message.provider_source_id) &&
      message.provider_source_id !== message.id && !messages.some((other) =>
        other.id !== message.id && getMessageProviderOccurrenceIdentity(other) === identity
      )
    return {
      ...(delivered ? { delivered: true } : {
        text: text.slice(0, REPLY_CHARS),
        partial: text.length > REPLY_CHARS || Boolean(message.content_is_projection) ||
          truncatedMessageIds.includes(message.id),
        ...(message.tool_calls?.length ? { progress: "recent" as const } : {})
      }),
      ...(orderUnconfirmed ? { orderUnconfirmed: true } : {})
    }
  }
  return null
}

type PreviewActivity = { text: string; partial: boolean; tool: string | null }
const NO_ACTIVITY: PreviewActivity = { text: "", partial: false, tool: null }
const NO_LIVE_ACTIVITY = { ...NO_ACTIVITY, streaming: false }
const noActivity = () => NO_LIVE_ACTIVITY
const fileTools = new Set(["read_file", "write_file", "edit_file", "grep", "glob"])

function previewToolLabel(call: ToolCall): string {
  const label = getToolLabel(call.name, { showToolName: false })
  if (!fileTools.has(call.name)) return label
  // Show a short filename for structured file tools. Commands, queries, and
  // arbitrary arguments remain in the full conversation.
  const path = call.args?.file_path ?? call.args?.path ?? (call.name === "glob" ? call.args?.pattern : undefined)
  const name = typeof path === "string" ? path.split(/[/\\]/).at(-1) : undefined
  return name && /^[\p{L}\p{N}_.-]{1,80}$/u.test(name) ? `${label} · ${name}` : label
}

function previewAssistantText(content: ActivityMessage["content"]): string {
  const blocks = typeof content === "string" ? [content] : (content ?? []).flatMap((block) => {
    if (!block || typeof block !== "object") return []
    const part = block as { type?: unknown; text?: unknown }
    return part.type === "text" && typeof part.text === "string" ? [part.text] : []
  })
  const text = blocks.join("\n")
  // The opening tag itself can be split across streaming frames.
  const trimmed = text.trimStart()
  if (trimmed.length <= 7 && "<think>".startsWith(trimmed.toLowerCase())) return ""
  const body = splitBotInlineReasoning(text).body
  return body === text && blocks.length > 1 ? blocks.map(block => splitBotInlineReasoning(block).body).join("\n") : body
}

function visiblePreviewAssistant(message: ActivityMessage) {
  const visible = projectCoordinatorTranscriptNoise("assistant", previewAssistantText(message.content), message.tool_calls)
  const text = visible.contentText.trim()
  const silent = isBotRoutineSilent(text)
  return {
    ...visible,
    silent,
    text: visible.hidden || !isVisibleTranscriptMessage("assistant", text) || silent
      ? "" : text
  }
}

/** Inspect only the current run's bounded tail and its latest unresolved tool batch. */
export function projectBotWorkPreviewActivity(
  messages: readonly ActivityMessage[],
  turnStart: number,
  toolStates: Readonly<Record<string, Pick<ToolCallState, "status" | "updatedAt">>>,
  showTool: boolean,
  activeTask?: PreviewTaskIdentity
): PreviewActivity {
  const requestIndex = findLiveRequest(messages, activeTask)
  const first = Math.max(requestIndex + 1, messages.length - LIVE_TAIL_LIMIT)
  const returned = new Set<string>()
  let tool: string | null = null
  let latestAssistant = true
  for (let index = messages.length - 1; index >= first; index--) {
    const message = messages[index]
    const started = new Date(message.start_at ?? message.created_at ?? NaN).getTime()
    if (requestIndex < 0 && !(started >= turnStart)) break
    if (message.subagent_tool_call_id) continue
    const role = previewMessageRole(message)
    if (role === "tool" && message.tool_call_id) {
      returned.add(message.tool_call_id)
      continue
    }
    if (role !== "assistant") break
    const visible = visiblePreviewAssistant(message)
    if (!message.tool_calls?.length && visible.silent) break
    if (latestAssistant && showTool && !visible.hidden) {
      const pending = visible.visibleToolCalls?.find((call) => {
        if (!call.id || !call.name || returned.has(call.id)) return false
        const state = toolStates[call.id]
        return !state || state.updatedAt.getTime() < started ||
          state.status === "queued" || state.status === "running"
      })
      if (pending) tool = previewToolLabel(pending)
    }
    latestAssistant = false
    const { text } = visible
    if (!text || BOT_ROUTINE_SILENT.startsWith(text)) continue
    return { text: text.slice(-REPLY_CHARS), partial: text.length > REPLY_CHARS, tool }
  }
  return tool ? { ...NO_ACTIVITY, tool } : NO_ACTIVITY
}

type ActivePreviewTask = PreviewTaskIdentity & Pick<BotTask, "threadId" | "state" | "updatedAt">

function useBotWorkPreviewActivity(threadId: string | null, task: ActivePreviewTask | undefined) {
  const context = useThreadContext()
  const turn = useRef<{ taskId: string; start: number } | null>(null)
  if (!task) turn.current = null
  // updatedAt on admission is later than the previous task's output even
  // when this request was queued before the previous turn finished.
  else if (turn.current?.taskId !== task.id) turn.current = { taskId: task.id, start: task.updatedAt }
  const taskId = turn.current?.taskId
  const turnStart = turn.current?.start
  const requestId = task?.requestId
  const waiting = task?.state === "waiting_user"
  const subscribe = useCallback((listener: () => void) => {
    if (!threadId) return () => {}
    const state = context.subscribeToThreadState(threadId, listener)
    const stream = context.subscribeToStream(threadId, listener)
    context.initializeThread(threadId)
    return () => { state(); stream() }
  }, [context, threadId])
  const snapshot = useMemo(() => {
    let previous = NO_LIVE_ACTIVITY
    return () => {
      if (!threadId || !taskId || !requestId || turnStart === undefined || isThreadDeletionPending(threadId)) return NO_LIVE_ACTIVITY
      const state = context.getThreadState(threadId)
      const stream = context.getStreamData(threadId)
      if (!state.scheduledTaskLoading && !stream.isLoading) {
        // Runtime completion can precede the Host's durable reply update.
        if (previous.streaming) previous = { ...previous, tool: null, streaming: false }
        return previous
      }
      const next = projectBotWorkPreviewActivity(
        state.scheduledTaskLoading ? state.messages : stream.liveMessages,
        Math.max(turnStart, state.activeTurnStartTime ?? 0),
        state.toolCallStates,
        !waiting && !state.pendingApproval && !state.pendingUserInput && !state.pendingApprovals.length,
        { id: taskId, requestId }
      )
      if (!previous.streaming || next.text !== previous.text || next.partial !== previous.partial || next.tool !== previous.tool)
        previous = { ...next, streaming: true }
      return previous
    }
  }, [context, threadId, taskId, requestId, turnStart, waiting])
  return useSyncExternalStore(subscribe, snapshot, noActivity)
}

function matchesPreviewThread(thread: Thread | null, work: BotWorkItem): boolean {
  if (!thread || thread.thread_id !== work.threadId) return false
  const metadata = thread.metadata
  if (!metadata || metadata.botGroupId != null || metadata.botMockBindingId != null) return false
  const link = work.conversation
  if (link) {
    return link.ref.kind === "local_thread" && matchesBotThreadDraftRef(thread, link.ref) &&
      matchesBoundBotWorkThreadSummary(thread, work)
  }
  return metadata.botId === work.botId && metadata.botWorkId === work.id &&
    metadata.botHostId === "local" &&
    (metadata.botAudienceKey == null || metadata.botAudienceKey === "desktop")
}

type History = {
  owner: string
  reply?: PreviewReply | null
  error?: boolean
}

export function BotWorkPreview({
  work,
  title,
  directoryError,
  activeTask,
  backLabel,
  onBack,
  onOpen,
  onOpenMain,
  onRetry
}: {
  work: BotWorkItem | null
  title: string
  directoryError: string | null
  activeTask?: ActivePreviewTask
  backLabel: string
  onBack(): void
  onOpen(): void
  onOpenMain?(): void
  onRetry(): void
}) {
  const back = useRef<HTMLButtonElement>(null)
  const floatingPreview = useRef<HTMLElement>(null)
  const narrow = useSyncExternalStore(subscribePreviewWidth, isNarrowPreview, () => false)
  const currentWork = useRef(work)
  currentWork.current = work
  const [history, setHistory] = useState<History | null>(null)
  const [verifiedOwner, setVerifiedOwner] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const link = work?.conversation
  const deletionPending = isWorkDeletionPending(work)
  const canRead = Boolean(work?.threadInitialized && !work.source && work.audienceKey === "desktop" &&
    !deletionPending && !work.deletionCommitted && (!link || link.state === "bound"))
  const owner = canRead && work
    ? JSON.stringify([work.botId, work.id, work.threadId, link?.ref])
    : null
  const visibleHistory = history?.owner === owner ? history : null
  const task = activeTask && activeTask.threadId === work?.threadId &&
    (activeTask.state === "running" || activeTask.state === "waiting_user") ? activeTask : undefined
  const liveThreadId = owner && verifiedOwner === owner && task ? task.threadId : null
  const activity = useBotWorkPreviewActivity(liveThreadId, task)
  const liveReply = activity.text ? { text: activity.text, partial: activity.partial, progress: "current" as const } : null
  const reply: PreviewReply | null | undefined = liveReply ?? visibleHistory?.reply
  const rawGoal = work?.goal ?? ""
  const goalKey = JSON.stringify([work?.botId, work?.id, rawGoal])
  const [goalOrigin, setGoalOrigin] = useState<{ key: string; origin?: BotMessageOrigin["origin"]; error?: true } | null>(null)
  const hasQuotedGoal = Boolean(parseBotMessageReply(rawGoal))
  useEffect(() => {
    if (!work || !hasQuotedGoal) return
    let disposed = false
    void window.api.bots.messageOrigins(work.botId, [`work-start-${work.id}`], undefined, work.id)
      .then(origins => { if (!disposed) setGoalOrigin({ key: goalKey, origin: origins[0]?.origin }) })
      .catch(() => { if (!disposed) setGoalOrigin({ key: goalKey, error: true }) })
    return () => { disposed = true }
  }, [goalKey, hasQuotedGoal, retry])
  const goalReply = goalOrigin?.key === goalKey && goalOrigin.origin?.kind === "user" ? goalOrigin.origin.replyTo : undefined
  const goal = useMemo(() => projectVisibleChatSearchContent(
    "user", cleanUserAttachmentContentForDisplay(projectBotReplyInput(rawGoal, goalReply, true))
  ).trim(), [rawGoal, goalReply])

  useLayoutEffect(() => {
    if (narrow) return
    const preview = floatingPreview.current
    const workspace = preview?.closest<HTMLElement>(".bots-workspace")
    const conversation = workspace?.querySelector<HTMLElement>(':scope > .bots-conversation[data-bot-floating-chat="true"]')
    if (!preview || !workspace || !conversation) return

    let footer: HTMLElement | null = null
    const measure = () => {
      const rect = footer?.getBoundingClientRect()
      const bottom = rect?.height ? Math.max(24, Math.ceil(workspace.getBoundingClientRect().bottom - rect.top + 12)) : 24
      const value = `${bottom}px`
      if (preview.style.bottom !== value) preview.style.bottom = value
    }
    const resize = new ResizeObserver(measure)
    const observeFooter = () => {
      const next = conversation.querySelector<HTMLElement>(
        ':scope > .bot-conversation-content > [data-chat-surface="bot"] > [data-chat-footer]'
      )
      if (footer === next) return
      if (footer) resize.unobserve(footer)
      footer = next
      if (footer) resize.observe(footer)
      measure()
    }
    resize.observe(conversation)
    observeFooter()
    // Details can open a task before the main conversation finishes mounting.
    const children = new MutationObserver(observeFooter)
    children.observe(conversation, { childList: true })
    return () => {
      children.disconnect()
      resize.disconnect()
      preview.style.removeProperty("bottom")
    }
  }, [narrow])

  useEffect(() => {
    if (!narrow) back.current?.focus({ preventScroll: true })
  }, [narrow])

  useEffect(() => {
    const work = currentWork.current
    if (!owner || !work) return
    let disposed = false
    let verified = false
    void (async () => {
      const thread = await window.api.threads.get(work.threadId)
      if (disposed) return
      if (!matchesPreviewThread(thread, work)) throw new Error("无法确认任务会话")
      verified = true
      setVerifiedOwner(owner)
      const options = { limit: PAGE_LIMIT, byteBudget: PAGE_BYTES }
      const page = await window.api.threads.getMessagesPage(work.threadId, options)
      if (disposed) return
      let messages = page.messages
      let truncated = page.truncatedMessageIds
      let hasOlderRows = page.hasMore
      // Tool traffic, a provider alias, or a quiet turn's source may be one page back.
      const firstReply = messages.some(isSilentPreviewEnd) ? null :
        projectBotWorkPreviewReply(messages, truncated, hasOlderRows)
      if ((!firstReply || firstReply.orderUnconfirmed) && page.hasMore &&
          page.beforeOrdinal !== null && page.beforeMessageId !== null) {
        const previous = await window.api.threads.getMessagesPage(work.threadId, {
          ...options,
          beforeOrdinal: page.beforeOrdinal,
          beforeMessageId: page.beforeMessageId
        })
        if (disposed) return
        messages = [...previous.messages, ...page.messages]
        truncated = [...(previous.truncatedMessageIds ?? []), ...(page.truncatedMessageIds ?? [])]
        hasOlderRows = previous.hasMore
      }
      const sourceIds = messages.some(isSilentPreviewEnd)
        ? messages.filter(message => message.role === "user").map(message => message.id) : []
      const origins = sourceIds.length
        ? await window.api.bots.messageOrigins(work.botId, sourceIds, undefined, work.id) : []
      if (disposed) return
      const reply = messages === page.messages && firstReply ? firstReply :
        projectBotWorkPreviewReply(messages, truncated, hasOlderRows, origins)
      setHistory({ owner, reply })
    })().catch(() => {
      if (disposed) return
      if (!verified) setVerifiedOwner(null)
      setHistory({ owner, error: true })
    })
    return () => { disposed = true }
  }, [owner, work?.updatedAt, work?.activity?.version, work?.executionState, task?.id, retry])

  const workTitle = work?.title ?? title
  const conclusion = work ? resolveBotWorkStatus(work).summary : undefined
  const content = <>
      <header className="bot-work-preview-header">
        <button ref={back} type="button" className="bot-icon-button"
          aria-label={backLabel} title={backLabel} onClick={onBack}>
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <DialogPrimitive.Title asChild><h2 title={workTitle}>{workTitle}</h2></DialogPrimitive.Title>
      </header>
      <div className="bot-work-preview-content">
        {work && (
          <span className="bot-work-status" data-tone={botWorkStatusTone(work)}>
            <BotWorkStatusIcon work={work} />
            {botWorkStatus(work)}
            {work.readyServiceState && <small> · 服务运行中</small>}
          </span>
        )}
        {work?.resultNeedsUser && onOpenMain && (
          <p className="bot-work-preview-note">
            <span className="min-w-0 break-words">{work.resultNeedsUser}</span>
            <button type="button" className="shrink-0" onClick={onOpenMain}>前往主对话</button>
          </p>
        )}
        {conclusion && (
          <p className="bot-work-preview-note">
            <span className="min-w-0 break-words">{conclusion}</span>
            {onOpenMain && <button type="button" className="shrink-0" onClick={onOpenMain}>前往主对话</button>}
          </p>
        )}
        {hasQuotedGoal && (goalOrigin?.key !== goalKey || goalOrigin.error) ? (
          <p className="bot-work-preview-note">
            {goalOrigin?.key === goalKey && goalOrigin.error ? <button onClick={() => setRetry(value => value + 1)}>重试读取任务要求</button> : "正在读取任务要求…"}
          </p>
        ) : goal && (
          <details className="bot-work-preview-goal">
            <summary>
              <span>任务要求</span>
              <ChevronRight size={13} aria-hidden="true" />
              <span className="bot-work-preview-goal-peek" aria-hidden="true">{goal}</span>
            </summary>
            <p>{goal}</p>
          </details>
        )}
        {activity.tool && (
          <p className="bot-work-preview-tool" role="status">
            <Wrench size={15} aria-hidden="true" />
            <span title={activity.tool}>{activity.tool}</span>
          </p>
        )}
        {!work && directoryError ? (
          <p className="bot-work-preview-note" role="alert">
            {directoryError} <button type="button" onClick={onRetry}>重试</button>
          </p>
        ) : !work || (canRead && !visibleHistory && !liveReply && !activity.tool) ? (
          <p className="bot-work-preview-note" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> 正在读取任务…
          </p>
        ) : deletionPending ? (
          <p className="bot-work-preview-note">{BOT_WORK_DELETION_PENDING_MESSAGE}</p>
        ) : visibleHistory?.error && !liveReply && !activity.tool ? (
          <p className="bot-work-preview-note" role="alert">
            暂时无法读取回复。{" "}
            <button type="button" onClick={() => {
              setHistory(null)
              setRetry((value) => value + 1)
            }}>重试</button>
          </p>
        ) : reply && "delivered" in reply ? (
          <p className="bot-work-preview-note">已交付附件，打开聊天查看</p>
        ) : reply ? (
          <article className="bot-work-preview-reply" aria-label={
            reply.orderUnconfirmed ? "回复片段" :
              reply.progress === "current" ? "当前进展" : reply.progress === "recent" ? "最近进展" : "最近回复"
          }>
            <ChatPresentationContext.Provider value="bot">
              <StreamingMarkdown isStreaming={Boolean(liveReply && activity.streaming)} botTranscript>{reply.text}</StreamingMarkdown>
            </ChatPresentationContext.Provider>
            {reply.orderUnconfirmed ? (
              <p className="bot-work-preview-note">回复片段。打开聊天查看最近回复。</p>
            ) : reply.partial && (
              <p className="bot-work-preview-note">打开聊天查看完整回复。</p>
            )}
          </article>
        ) : link?.state !== "detached" && !activity.tool && (
          <p className="bot-work-preview-note">暂无可预览的回复。</p>
        )}
      </div>
      <footer className="bot-work-preview-footer">
        <button
          type="button"
          disabled={!work || work.deletionCommitted || deletionPending}
          onClick={onOpen}
        >
          <MessageCircle size={18} aria-hidden="true" />
          打开聊天
        </button>
      </footer>
  </>
  return (
    <DialogPrimitive.Root open modal={narrow} onOpenChange={(open) => { if (!open) onBack() }}>
      {narrow ? <>
        <DialogPrimitive.Overlay className="bot-work-preview-overlay" />
        <DialogPrimitive.Content className="bot-work-preview" aria-describedby={undefined}
          data-cmb-modal-dialog="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            back.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}>{content}</DialogPrimitive.Content>
      </> : (
        <section ref={floatingPreview} className="bot-work-preview" aria-label="任务预览"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.stopPropagation()
              onBack()
            }
          }}>{content}</section>
      )}
    </DialogPrimitive.Root>
  )
}
