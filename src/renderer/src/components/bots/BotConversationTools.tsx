import { BotHistorySources } from "./BotHistorySources"
import { toast } from "sonner"
import { parseBotWorkHistoryHref } from "../../../../shared/bots/work-history"
import { botHistoryReceipt } from "@/lib/bot-history-receipt"
import { useChatSourceNavigation } from "@/lib/chat-source-navigation"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react"
import { ChevronRight, Clock, Hand } from "lucide-react"
import type { Message, ToolCall, ToolResult } from "@/types"
import type {
  BotClient,
  BotTask,
  BotDefinition,
  BotGroup,
  BotMessageOrigin,
  BotSchedule
} from "../../../../shared/bots/contracts"
import { useThreadContext, useThreadStateSelector } from "@/lib/thread-context"
import {
  ChatHistorySourceContext,
  ChatPresentationContext,
  ChatReplySourceContext,
  ChatActivityPresentationContext,
  ChatExecutionDetailsContext,
  ChatFoldedToolCallsContext,
  ChatExecutionCardCallIdsContext,
  ChatFilePresentationContext,
  ChatMessageVisibilityContext,
  ChatMessagePresentationContext,
  ChatUserTextPresentationContext,
  ChatToolPresentationContext
} from "../chat/chat-presentation-context"
import { botWorkReceipt } from "@/lib/bot-work-receipt"
import { botWorkResultLabel } from "../../../../shared/bots/work-result"
import { delegatedTaskReceipt } from "@/lib/bot-exchange-view"
import { BotExchangePanel } from "./BotExchangePanel"
import { mergeBotMessageOrigins, hiddenBotTaskMessageIds } from "@/lib/bot-routine-visibility"
import { BOT_ROUTINE_SILENT } from "../../../../shared/bots/routine-silence"
import { splitBotInlineReasoning } from "../../../../shared/bots/inline-reasoning"
import { BotBrowserHelpCard } from "./BotBrowserHelpCard"
import { botBrowserHelpHistory } from "@/lib/bot-browser-help-history"
import { BotDeliveredFile } from "./BotDeliveredFile"
import { parseBotFileDelivery } from "../../../../shared/bots/file-delivery"
import { botGroupBrowserScope } from "../../../../shared/bots/contracts"
import { projectBotExecution } from "@/lib/bot-execution-visibility"
import { botProfileEvent } from "@/lib/bot-profile-event"
import { botScheduleReceipt } from "@/lib/bot-schedule-view"
import {
  botQuestionHistory,
  stoppedBotQuestionHistory,
  type BotQuestionHistory as QuestionHistory
} from "@/lib/bot-question-history"
import { BotQuestionHistory } from "./BotQuestionHistory"
import { parseBotMessageReply } from "../../../../shared/bots/message-reply"
import { botDeliveredFileReferences } from "@/lib/bot-delivered-file-references"
import { getModCards, subscribeModCards } from "@/lib/mod-cards-store"
import { useBotViewStore } from "./view-store"
import { BotActivity } from "./BotActivity"
import { botConversationState } from "@/lib/bot-task-view"
import { botActiveTaskCreatedAt } from "@/lib/bot-avatar-mood"
import { projectPrivateBotMentions } from "@/lib/bot-private-mentions"
import { BotMentionLabel } from "./BotMentionLabel"

export function BotConversationTools({
  client,
  botId,
  groupId,
  conversationThreadId,
  onOpenWork,
  onOpenBot,
  onOpenGroup,
  groups = [],
  tasks,
  bots,
  schedules,
  executionDetails,
  children
}: {
  client: BotClient
  botId: string
  groupId?: string
  conversationThreadId?: string
  onOpenWork?(workId: string): void
  onOpenBot?(botId: string): void
  onOpenGroup?(groupId: string): void
  groups?: readonly BotGroup[]
  tasks: BotTask[]
  bots: BotDefinition[]
  schedules?: readonly BotSchedule[]
  executionDetails?: boolean
  children: ReactNode
}) {
  const [exchangeId, setExchangeId] = useState<string | null>(null)
  const bot = bots.find((item) => item.id === botId)
  const exchangeTrigger = useRef<HTMLButtonElement | null>(null)
  const threadId =
    conversationThreadId ?? (groupId ? `group-${groupId}-${botId}` : (bot?.threadId ?? null))
  const context = useThreadContext()
  const savedExecutionDetails = useBotViewStore((state) =>
    Boolean(state.hosts[client.hostId]?.showExecutionDetails)
  )
  const showExecutionDetails = executionDetails ?? savedExecutionDetails
  const subscribeCards = useCallback(
    (listener: () => void) => (threadId ? subscribeModCards(threadId, listener) : () => {}),
    [threadId]
  )
  const getCards = useCallback(() => getModCards(threadId ?? ""), [threadId])
  const cards = useSyncExternalStore(subscribeCards, getCards)
  const cardCallIds = useMemo(() => new Set(cards.map((card) => card.callId)), [cards])
  // The window identity is stable during streamed token updates; source lookups need no per-token work.
  const windowKey = useThreadStateSelector(
    threadId,
    (state) => `${state.messages.length}:${state.messages[0]?.id}:${state.messages.at(-1)?.id}`
  )
  // Observe only transitions into/out of a control token, without refetching origins per token.
  const streamingQuietMessage = useThreadStateSelector(threadId, (state) => {
    const last = state.messages.at(-1)
    if (last?.role !== "assistant" || typeof last.content !== "string") return ""
    const body = splitBotInlineReasoning(last.content).body.trim()
    return body && BOT_ROUTINE_SILENT.startsWith(body) ? last.id : ""
  })
  const [origins, setOrigins] = useState<BotMessageOrigin[]>([])
  useEffect(() => {
    let disposed = false
    if (!threadId) {
      setOrigins([])
      return
    }
    const ids = context
      .getThreadState(threadId)
      .messages.filter((item) => item.role === "user")
      .map((item) => item.id)
    const visible = new Set(ids)
    setOrigins((previous) => previous.filter((item) => visible.has(item.requestId)))
    void (async () => {
      const found: BotMessageOrigin[] = []
      for (let offset = 0; offset < ids.length && !disposed; offset += 100)
        found.push(
          ...(await client.messageOrigins(botId, ids.slice(offset, offset + 100), groupId))
        )
      if (!disposed) setOrigins(found)
    })().catch((error) => {
      if (!disposed) console.warn("[Bots] Message origins unavailable", error)
    })
    return () => {
      disposed = true
    }
  }, [client, botId, groupId, threadId, windowKey, context])
  const taskByMessage = useMemo(() => mergeBotMessageOrigins(origins, tasks), [tasks, origins])
  const mentionProjectionWarnings = useRef(new Set<string>())
  useEffect(() => { mentionProjectionWarnings.current.clear() }, [windowKey, threadId])
  const replySource = useMemo(
    () =>
      groupId
        ? null
        : {
            resolve: (messageId: string) => client.messageReply(botId, messageId),
            quoteFor: (message: Message) => {
              const origin = taskByMessage.get(message.id)?.origin
              if (origin?.kind !== "user" || !origin.replyTo || typeof message.content !== "string")
                return undefined
              const parsed = parseBotMessageReply(message.content)
              return parsed?.reply.id === origin.replyTo.id &&
                parsed.reply.ordinal === origin.replyTo.ordinal &&
                parsed.reply.role === origin.replyTo.role
                ? parsed.reply
                : undefined
            }
          },
    [client, botId, groupId, taskByMessage]
  )
  const presentUserText = useCallback((message: Message, text: string) => {
    if (groupId || typeof message.content !== "string") return text
    const origin = taskByMessage.get(message.id)?.origin
    if (origin?.kind !== "user" || !origin.mentions?.length) return text
    const { mentions, reason } = projectPrivateBotMentions(origin, message.content, text)
    if (reason && !mentionProjectionWarnings.current.has(message.id)) {
      mentionProjectionWarnings.current.add(message.id)
      console.warn("[Bots] Private mention display unavailable:", reason)
    }
    if (!mentions.length) return text
    const nodes: ReactNode[] = []
    let offset = 0
    for (const mention of mentions) {
      nodes.push(text.slice(offset, mention.start))
      const peer = mention.kind === "group" ? undefined : bots.find((item) => item.id === mention.botId && !item.deleting)
      const mentionedGroup = mention.kind === "group" ? groups.find((item) => item.id === mention.groupId && !item.deleting) : undefined
      const label = <BotMentionLabel mention={mention} bot={peer} />
      const open = mentionedGroup && onOpenGroup ? () => onOpenGroup(mentionedGroup.id)
        : peer && onOpenBot ? () => onOpenBot(peer.id) : undefined
      const identity = mention.kind === "group" ? `group:${mention.groupId}` : `bot:${mention.botId}`
      nodes.push(open
        ? <button key={`${mention.start}:${identity}`} type="button" className="bot-inline-mention" onClick={open}>{label}</button>
        : <span key={`${mention.start}:${identity}`} className="bot-inline-mention">{label}</span>)
      offset = mention.end
    }
    nodes.push(text.slice(offset))
    return <>{nodes}</>
  }, [groupId, taskByMessage, bots, groups, onOpenBot, onOpenGroup])
  const deliveredReferences = useMemo(
    () => botDeliveredFileReferences(threadId ? context.getThreadState(threadId).messages : []),
    [context, threadId, windowKey]
  )
  const executionView = useMemo(() => {
    if (!threadId)
      return {
        hiddenMessages: new Set<string>(),
        foldedTools: new Set<string>(),
        quietMessages: new Set<string>(),
        stoppedQuestions: new Map<string, QuestionHistory>()
      }
    const messages = context.getThreadState(threadId).messages
    let view = { hiddenMessages: new Set<string>(), foldedTools: new Set<string>() }
    if (!showExecutionDetails) {
      const running = tasks.some((task) =>
        ["queued", "running", "waiting_user"].includes(task.state)
      )
      view = projectBotExecution(messages, running, cardCallIds)
    }
    return {
      ...view,
      quietMessages: hiddenBotTaskMessageIds(messages, taskByMessage),
      stoppedQuestions: showExecutionDetails
        ? new Map<string, QuestionHistory>()
        : stoppedBotQuestionHistory(messages, taskByMessage)
    }
  }, [
    threadId,
    context,
    taskByMessage,
    windowKey,
    streamingQuietMessage,
    showExecutionDetails,
    tasks,
    cardCallIds
  ])
  useEffect(() => {
    if (!exchangeId && exchangeTrigger.current?.isConnected) exchangeTrigger.current.focus()
  }, [exchangeId])
  const openHistorySource = useCallback(
    (href: string) => {
      const source = parseBotWorkHistoryHref(href)
      if (!source || !client.works?.resolveSource || !onOpenWork || groupId) {
        toast.error("此历史来源暂不可用，请重新查询。")
        return
      }
      void client.works
        .resolveSource(botId, source)
        .then((target) => {
          useChatSourceNavigation.getState().request(target)
          onOpenWork(source.workId)
        })
        .catch((error) => toast.error(error instanceof Error ? error.message : "无法定位原消息"))
    },
    [client, botId, onOpenWork, groupId]
  )
  const presentTool = useCallback(
    (tool: ToolCall, result?: Pick<ToolResult, "content" | "is_error">) => {
      if (!result) {
        const stoppedQuestion =
          !showExecutionDetails && tool.name === "request_user_input" && !cardCallIds.has(tool.id)
            ? executionView.stoppedQuestions.get(tool.id)
            : undefined
        if (stoppedQuestion) return <BotQuestionHistory history={stoppedQuestion} />
        if (
          !(
            tool.name === "bot_request_browser_help" ||
            (tool.name === "bot_browser" && tool.args.action === "request_help")
          ) ||
          typeof tool.args.instruction !== "string" ||
          !tasks.some((task) => task.state === "waiting_user")
        )
          return null
        return (
          <BotBrowserHelpCard
            client={client}
            scopeId={groupId ? botGroupBrowserScope(groupId, botId) : botId}
            instruction={tool.args.instruction.trim()}
          />
        )
      }
      const browserHelpHistory = !showExecutionDetails ? botBrowserHelpHistory(tool, result) : null
      if (browserHelpHistory)
        return (
          <div className="bot-browser-help" role="note" data-bot-browser-help-history>
            <Hand size={16} aria-hidden="true" />
            <span>
              电脑 · {browserHelpHistory.status === "skipped" ? "已跳过" : "协助已结束"} · {browserHelpHistory.instruction}
            </span>
          </div>
        )
      const questionHistory = !showExecutionDetails ? botQuestionHistory(tool, result) : null
      if (questionHistory) return <BotQuestionHistory history={questionHistory} />
      const profileEvent = !showExecutionDetails ? botProfileEvent(tool, result) : null
      if (profileEvent)
        return (
          <div className="bot-profile-event" role="note" title={profileEvent}>
            {profileEvent}
          </div>
        )
      const history = botHistoryReceipt(tool, result)
      if (history?.entries.length && !groupId)
        return (
          <BotHistorySources
            page={history}
            onOpen={openHistorySource}
          />
        )
      const workReceipt = botWorkReceipt(tool, result, botId)
      if (workReceipt && onOpenWork)
        return (
          <button
            type="button"
            className="bot-exchange-link"
            onClick={() => onOpenWork(workReceipt.id)}
          >
            <span>
              {workReceipt.label} · {workReceipt.title}
            </span>
            <ChevronRight size={14} />
          </button>
        )
      const scheduleReceipt = !showExecutionDetails ? botScheduleReceipt(tool, result) : null
      if (scheduleReceipt && scheduleReceipt.action !== "list") {
        if (scheduleReceipt.action === "remove")
          return (
            <div className="bot-profile-event" role="note">
              例行任务已删除
            </div>
          )
        const exists = schedules?.some(
          (schedule) => schedule.id === scheduleReceipt.id && schedule.botId === botId
        )
        return (
          <div className="bot-profile-event bot-schedule-event" role="note">
            <span>已{scheduleReceipt.created ? "创建" : "更新"}例行任务</span>
            {exists ? (
              <button
                type="button"
                className="bot-routine-link"
                title={scheduleReceipt.name}
                aria-label={`查看例行任务：${scheduleReceipt.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  useBotViewStore.getState().update(client.hostId, {
                    selectedId: botId,
                    groupId: null,
                    detailOpen: true,
                    detailTab: "details"
                  })
                }}
              >
                <Clock size={14} aria-hidden="true" />
                <span>{scheduleReceipt.name}</span>
              </button>
            ) : (
              <span className="truncate" title={scheduleReceipt.name}>
                {scheduleReceipt.name}
              </span>
            )}
          </div>
        )
      }
      if (tool.name === "bot_deliver_files" && !result.is_error && threadId) {
        const files = parseBotFileDelivery(result.content)
        if (!files) return null
        return (
          <div className="bot-delivered-files">
            {files.map((file) => (
              <BotDeliveredFile
                key={file.filePath}
                client={client}
                botId={botId}
                groupId={groupId}
                threadId={threadId}
                filePath={file.filePath}
                attachmentPath={file.attachmentPath}
                size={file.size}
              />
            ))}
          </div>
        )
      }
      const receipt = delegatedTaskReceipt(tool, result)
      if (!receipt) return null
      const peer = bots.find((bot) => bot.id === (receipt.botId ?? tool.args.botId))
      const peerName = peer?.name ?? receipt.botName
      return (
        <button
          type="button"
          className="bot-exchange-link"
          onClick={(event) => {
            exchangeTrigger.current = event.currentTarget
            setExchangeId(receipt.taskId)
          }}
        >
          <span>{peerName ? `已向 ${peerName} 发送消息` : "已发送协作消息"}</span>
          <ChevronRight size={14} />
          <span className="sr-only">查看 Bot 交流</span>
        </button>
      )
    },
    [
      openHistorySource,
      bots,
      onOpenWork,
      schedules,
      tasks,
      client,
      groupId,
      botId,
      threadId,
      showExecutionDetails,
      cardCallIds,
      executionView.stoppedQuestions
    ]
  )
  const presentMessage = useCallback(
    (message: Message) => {
      if (message.role !== "user") return null
      const task = taskByMessage.get(message.id)
      if (task?.origin.kind === "work" && task.origin.dispatch) {
        return (
          <section className="bot-work-instruction" aria-label="Bot 交办说明">
            <div className="bot-work-instruction-label">
              {task.origin.dispatch === "create" ? "Bot 交办" : "Bot 补充"}
            </div>
            <div className="bot-work-instruction-text">
              {typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n")}
            </div>
          </section>
        )
      }
      if (task?.origin.kind === "work_result") {
        const origin = task.origin
        return (
          <button
            type="button"
            className="bot-exchange-link"
            onClick={() => onOpenWork?.(origin.workId)}
            disabled={!onOpenWork}
            aria-label={botWorkResultLabel(origin.executionState) + "：" + origin.workTitle}
          >
            <span>
              {botWorkResultLabel(origin.executionState)} · {origin.workTitle}
            </span>
            <ChevronRight size={14} />
          </button>
        )
      }
      if (task?.origin.kind === "schedule") {
        return (
          <details className="bot-routine-event">
            <summary>
              <Clock size={14} aria-hidden="true" />
              <span>例行任务已触发</span>
              <ChevronRight size={14} aria-hidden="true" />
              <span className="sr-only">查看执行指令</span>
            </summary>
            <div className="bot-routine-instructions">
              {typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n")}
            </div>
          </details>
        )
      }
      if (task?.origin.kind !== "bot") return null
      const taskId = task.origin.expectsReply
        ? task.id
        : task.requestId.startsWith("reply-")
          ? task.requestId.slice(6)
          : null
      if (!taskId) return null
      return (
        <button
          type="button"
          className="bot-exchange-link"
          onClick={(event) => {
            exchangeTrigger.current = event.currentTarget
            setExchangeId(taskId)
          }}
        >
          <span>
            收到来自 {task.origin.fromBotName ?? "其他 Bot"} 的
            {task.origin.expectsReply ? "消息" : "回复"}
          </span>
          <ChevronRight size={14} />
          <span className="sr-only">查看 Bot 交流</span>
        </button>
      )
    },
    [taskByMessage, onOpenWork]
  )
  const presentFile = useCallback(
    (file: { filePath: string; threadId: string; label: ReactNode; messageId?: string }) => {
      if (file.messageId && deliveredReferences.get(file.messageId)?.has(file.filePath)) return null
      return <BotDeliveredFile {...file} client={client} botId={botId} groupId={groupId} />
    },
    [client, botId, groupId, deliveredReferences]
  )
  return (
    <ChatHistorySourceContext.Provider value={groupId ? null : openHistorySource}>
      <div className="bot-conversation-content" hidden={Boolean(exchangeId)}>
        <ChatToolPresentationContext.Provider value={presentTool}>
          <ChatMessagePresentationContext.Provider value={presentMessage}>
            <ChatMessageVisibilityContext.Provider value={executionView.quietMessages}>
              <ChatPresentationContext.Provider value="bot">
                <ChatExecutionDetailsContext.Provider value={showExecutionDetails}>
                  <ChatFoldedToolCallsContext.Provider value={executionView.foldedTools}>
                    <ChatExecutionCardCallIdsContext.Provider value={cardCallIds}>
                      <ChatFilePresentationContext.Provider value={presentFile}>
                        <ChatActivityPresentationContext.Provider
                          value={
                            !showExecutionDetails && bot && threadId ? (
                              <BotActivity
                                bot={bot}
                                threadId={threadId}
                                taskCreatedAt={botActiveTaskCreatedAt(tasks, threadId)}
                                waiting={botConversationState(tasks) === "waiting_user"}
                              />
                            ) : null
                          }
                        >
                          <ChatReplySourceContext.Provider value={replySource}>
                            <ChatUserTextPresentationContext.Provider value={presentUserText}>
                              {children}
                            </ChatUserTextPresentationContext.Provider>
                          </ChatReplySourceContext.Provider>
                        </ChatActivityPresentationContext.Provider>
                      </ChatFilePresentationContext.Provider>
                    </ChatExecutionCardCallIdsContext.Provider>
                  </ChatFoldedToolCallsContext.Provider>
                </ChatExecutionDetailsContext.Provider>
              </ChatPresentationContext.Provider>
            </ChatMessageVisibilityContext.Provider>
          </ChatMessagePresentationContext.Provider>
        </ChatToolPresentationContext.Provider>
      </div>
      {exchangeId && (
        <BotExchangePanel
          key={exchangeId}
          client={client}
          botId={botId}
          taskId={exchangeId}
          groupId={groupId}
          onClose={() => setExchangeId(null)}
        />
      )}
    </ChatHistorySourceContext.Provider>
  )
}
