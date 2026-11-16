import { BotHistorySources } from "./BotHistorySources"
import { toast } from "sonner"
import { parseBotWorkAttachmentHref, parseBotWorkHistoryHref, parseBotWorkHref } from "../../../../shared/bots/work-history"
import { parseBotThreadHistoryHref } from "../../../../shared/bots/thread-history"
import { cleanUserAttachmentContentForDisplay } from "../../../../shared/user-attachment-display"
import { isThreadDeletionPending, isThreadRetired, useAppStore } from "@/lib/store"
import {
  ensureBotWorkThreadSummary,
  openBotWorkThreadChat,
  resolveBotWorkThreadForNavigation
} from "@/lib/bot/work-thread-summary"
import { matchesBotThreadDraftRef } from "@/lib/bot-conversation-draft"
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
  ChatDesktopWorkIdContext,
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
import { botWorkCardIds, botWorkReceipt, loadBotWorkCardTitles } from "@/lib/bot-work-receipt"
import { botWorkResultLabel } from "../../../../shared/bots/work-result"
import { delegatedTaskReceipt } from "@/lib/bot-exchange-view"
import { BotExchangePanel } from "./BotExchangePanel"
import { mergeBotMessageOrigins, hiddenBotTaskMessageIds } from "@/lib/bot-routine-visibility"
import { BOT_ROUTINE_SILENT } from "../../../../shared/bots/routine-silence"
import { splitBotInlineReasoning } from "../../../../shared/bots/inline-reasoning"
import { BotBrowserHelpCard } from "./BotBrowserHelpCard"
import { botBrowserHelpHistory } from "@/lib/bot-browser-help-history"
import { BotDeliveredFile, BotDeliveredFiles } from "./BotDeliveredFile"
import { BotFileDeliveryPreview } from "./BotMessageFilePreview"
import type { OpenResourcePreviewDetail } from "@/lib/resource-preview-events"
import { botGroupBrowserScope } from "../../../../shared/bots/contracts"
import { botImBrowserScope } from "../../../../shared/bots/im-channel"
import { projectBotExecution, visibleBotDelivery } from "@/lib/bot-execution-visibility"
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
  imConversationId,
  conversationThreadId,
  desktopWorkId,
  workRevision = 0,
  onOpenWork,
  onPreviewWork,
  onOpenRoutineDetails,
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
  imConversationId?: string
  conversationThreadId?: string
  desktopWorkId?: string
  workRevision?: number
  onOpenWork?(workId: string): void
  onPreviewWork?(workId: string, trigger: HTMLButtonElement, title: string): void
  onOpenRoutineDetails?(): void
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
  const originWindow = JSON.stringify([client.hostId, botId, groupId, threadId, windowKey])
  const [loadedOriginWindow, setLoadedOriginWindow] = useState<string | null>(null)
  const [originRetry, setOriginRetry] = useState(0)
  useEffect(() => {
    let disposed = false
    setLoadedOriginWindow(null)
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
      if (!disposed) {
        setOrigins(found)
        setLoadedOriginWindow(originWindow)
      }
    })().catch((error) => {
      if (!disposed) {
        console.warn("[Bots] Message origins unavailable", error)
        if (!groupId) toast.error("暂时无法读取消息信息，编辑尚未就绪", {
          action: { label: "重试", onClick: () => {
            if (!disposed) setOriginRetry(value => value + 1)
          } }
        })
      }
    })
    return () => {
      disposed = true
    }
  }, [client, botId, groupId, threadId, windowKey, context, originWindow, originRetry])
  const taskByMessage = useMemo(() => mergeBotMessageOrigins(origins, tasks), [tasks, origins])
  const workTitleScope = JSON.stringify([client.hostId, botId, threadId])
  const [workTitleState, setWorkTitleState] = useState<{ scope: string; titles: Map<string, string> }>()
  const workTitles = workTitleState?.scope === workTitleScope ? workTitleState.titles : undefined
  useEffect(() => {
    if (!threadId || groupId || !client.works) return
    let disposed = false
    const ids = botWorkCardIds(context.getThreadState(threadId).messages, taskByMessage, botId)
    void loadBotWorkCardTitles(client.works, botId, ids, () => !disposed).then(titles => {
      if (!disposed) setWorkTitleState(previous =>
        previous?.scope === workTitleScope && previous.titles.size === titles.size &&
        [...titles].every(([id, title]) => previous.titles.get(id) === title)
          ? previous : { scope: workTitleScope, titles })
    }).catch(error => {
      if (!disposed) console.warn("[Bots] Current task titles unavailable", error)
    })
    return () => { disposed = true }
  }, [client, botId, groupId, threadId, context, windowKey, taskByMessage, workRevision, workTitleScope])
  const mentionProjectionWarnings = useRef(new Set<string>())
  useEffect(() => { mentionProjectionWarnings.current.clear() }, [windowKey, threadId])
  const replySource = useMemo(
    () =>
      groupId
        ? null
        : {
            editReady: loadedOriginWindow === originWindow,
            resolve: (messageId: string) => client.messageReply(botId, messageId),
            skillFor: (messageId: string) => {
              const origin = taskByMessage.get(messageId)?.origin
              return origin?.kind === "user" ? origin.explicitSkill : undefined
            },
            quoteFor: (message: Message) => {
              const origin = taskByMessage.get(message.id)?.origin
              if (origin?.kind !== "user" || !origin.replyTo || typeof message.content !== "string")
                return undefined
              const parsed = parseBotMessageReply(message.content)
              return parsed?.reply.id === origin.replyTo.id &&
                parsed.reply.ordinal === origin.replyTo.ordinal &&
                parsed.reply.role === origin.replyTo.role
                ? { ...parsed.reply, sourceThreadId: origin.replyTo.sourceThreadId }
                : undefined
            }
          },
    [client, botId, groupId, taskByMessage, loadedOriginWindow, originWindow]
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
      view = projectBotExecution(messages, running, cardCallIds, null, undefined, desktopWorkId)
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
    desktopWorkId,
    tasks,
    cardCallIds
  ])
  useEffect(() => {
    if (!exchangeId && exchangeTrigger.current?.isConnected) exchangeTrigger.current.focus()
  }, [exchangeId])
  const historyNavigation = useRef(0)
  const [attachmentPreview, setAttachmentPreview] = useState<{
    ownerThreadId: string
    client: BotClient
    botId: string
    request: OpenResourcePreviewDetail
  } | null>(null)
  const closeAttachmentPreview = useCallback(() => {
    historyNavigation.current++
    setAttachmentPreview(null)
  }, [])
  useEffect(() => {
    setAttachmentPreview(null)
    const initial = useAppStore.getState()
    const unsubscribe = client.hostId === "local" && !groupId && !imConversationId && threadId === bot?.threadId
      ? useAppStore.subscribe(state => {
      if (state.mainView !== initial.mainView || state.currentThreadId !== initial.currentThreadId ||
          state.showCustomizeView) closeAttachmentPreview()
      }) : () => {}
    return () => {
      historyNavigation.current++
      unsubscribe()
    }
  }, [client, threadId, botId, bot?.threadId, groupId, imConversationId, closeAttachmentPreview])
  const openHistorySource = useCallback(
    async (href: string) => {
      const navigation = ++historyNavigation.current
      const initial = useAppStore.getState()
      let viewChanged = initial.showCustomizeView
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.mainView !== initial.mainView || state.currentThreadId !== initial.currentThreadId ||
            state.showCustomizeView) viewChanged = true
      })
      const isCurrent = () => historyNavigation.current === navigation && !viewChanged
      const unavailable = () => new Error("此历史来源暂不可用，请重新查询。")
      const sourceNavigation = useChatSourceNavigation.getState()
      let requested: typeof sourceNavigation.target = null
      const request = ({ threadId, messageId, ordinal }: NonNullable<typeof sourceNavigation.target>) => {
        requested = { threadId, messageId, ordinal }
        sourceNavigation.request(requested)
      }
      const openThread = async (target: NonNullable<typeof sourceNavigation.target>) => {
        if (!isCurrent()) return
        if (isThreadDeletionPending(target.threadId) || isThreadRetired(target.threadId)) throw unavailable()
        request(target)
        await openBotWorkThreadChat(context, target.threadId)
      }

      try {
        if (!isCurrent()) return
        if (groupId) throw unavailable()
        const attachment = parseBotWorkAttachmentHref(href)
        if (attachment) {
          if (imConversationId || client.hostId !== "local" || !threadId || threadId !== bot?.threadId ||
              !client.works?.resolveSource || !client.authorizeDeliveredFile) throw unavailable()
          const { callId, fileIndex, ...historySource } = attachment
          const target = await client.works.resolveSource(botId, historySource)
          if (!isCurrent()) return
          if (target.messageId !== attachment.messageId || isThreadDeletionPending(target.threadId) ||
              isThreadRetired(target.threadId)) throw unavailable()
          const source = { threadId: target.threadId, assistantMessageId: target.messageId, callId, fileIndex }
          const authorized = await client.authorizeDeliveredFile(source)
          if (!isCurrent()) return
          if (isThreadDeletionPending(target.threadId) || isThreadRetired(target.threadId)) throw unavailable()
          // The main chat owns this dialog. Its read-only content keeps the original
          // source thread, preserving the previewer's receipt and Markdown checks.
          setAttachmentPreview({ ownerThreadId: threadId, client, botId, request: {
            threadId: target.threadId, intentId: navigation, filePath: authorized.filePath,
            workspacePathKind: "absolute", externalPreviewGrant: authorized.grant,
            externalPreviewGrantExpiresAt: authorized.expiresAt,
            ...(authorized.markdownBasePath ? { markdownBasePath: authorized.markdownBasePath } : {}),
            botDeliverySource: source
          } })
          return
        }
        const workId = parseBotWorkHref(href)
        if (workId) {
          if (imConversationId || client.hostId !== "local" || !onOpenWork || !client.works) throw unavailable()
          const work = await client.works.get(botId, workId)
          if (!isCurrent()) return
          if (work.id !== workId || work.botId !== botId || work.audienceKey !== "desktop" ||
              work.source || (work.conversation && work.conversation.state !== "bound")) throw unavailable()
          onOpenWork(workId)
          return
        }
        const ordinary = parseBotThreadHistoryHref(href)
        if (ordinary && client.conversations?.resolveHistory) {
          const target = await client.conversations.resolveHistory(botId, ordinary)
          if (!isCurrent()) return
          if (target.threadId !== ordinary.conversation.threadId || target.messageId !== ordinary.messageId)
            throw unavailable()
          await ensureBotWorkThreadSummary(target.threadId, isCurrent, thread =>
            matchesBotThreadDraftRef(thread, ordinary.conversation))
          await openThread(target)
          return
        }

        const source = parseBotWorkHistoryHref(href)
        if (!source || !client.works?.resolveSource) throw unavailable()
        const target = await client.works.resolveSource(botId, source)
        if (!isCurrent()) return
        if (target.messageId !== source.messageId) throw unavailable()
        if (target.detached) {
          // A retained delivery can outlive the work record. The Host has verified
          // its historical association and the original message without rebinding it.
          await ensureBotWorkThreadSummary(target.threadId, isCurrent)
          await openThread(target)
          return
        }

        if (client.hostId === "local" && client.conversations && !imConversationId) {
          const work = await client.works.get(botId, source.workId)
          if (!isCurrent()) return
          if (work.botId !== botId || work.id !== source.workId || work.threadId !== target.threadId)
            throw unavailable()
          if (!work.source && work.audienceKey === "desktop") {
            if (work.conversation && work.conversation.state !== "bound") throw unavailable()
            const threadId = await resolveBotWorkThreadForNavigation(client, work, isCurrent)
            if (threadId === target.threadId) await openThread(target)
            return
          }
        }

        // Channel and remote work still open in their own conversation surface.
        if (!onOpenWork) throw unavailable()
        request(target)
        onOpenWork(source.workId)
      } catch (error) {
        if (requested && useChatSourceNavigation.getState().target === requested) sourceNavigation.clear()
        if (isCurrent()) toast.error(error instanceof Error ? error.message : "无法定位原消息")
      } finally {
        unsubscribe()
      }
    },
    [client, botId, bot?.threadId, threadId, onOpenWork, groupId, imConversationId, context]
  )
  const presentTool = useCallback(
    (tool: ToolCall, result?: Pick<ToolResult, "content" | "is_error">, assistantMessageId?: string,
      deliveryScope?: Message["botHistoryDeliveryScope"]) => {
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
            scopeId={imConversationId ? botImBrowserScope(imConversationId, botId) : groupId ? botGroupBrowserScope(groupId, botId) : botId}
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
      if (history?.entries.length && !groupId &&
          (!("thread" in history) || (client.hostId === "local" && !imConversationId &&
            threadId === bot?.threadId && client.conversations?.resolveHistory)))
        return (
          <BotHistorySources
            page={history}
            messageId={typeof tool.args?.messageId === "string" ? tool.args.messageId.trim() : undefined}
            onOpen={openHistorySource}
          />
        )
      const workReceipt = botWorkReceipt(tool, result, botId)
      if (workReceipt && (onPreviewWork || onOpenWork)) {
        const title = workTitles?.get(workReceipt.id) ?? workReceipt.title
        return (
          <button
            type="button"
            className="bot-exchange-link"
            onClick={(event) => onPreviewWork
              ? onPreviewWork(workReceipt.id, event.currentTarget, title)
              : onOpenWork?.(workReceipt.id)}
          >
            <span>
              {workReceipt.label} · {title}
            </span>
            <ChevronRight size={14} />
          </button>
        )
      }
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
                  if (onOpenRoutineDetails) onOpenRoutineDetails()
                  else {
                    useBotViewStore.getState().update(client.hostId, {
                      selectedId: botId,
                      groupId: null,
                      detailOpen: true,
                      detailTab: "details"
                    })
                  }
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
        const files = visibleBotDelivery(result.content, deliveryScope, desktopWorkId)
        if (!files) return null
        return (
          <BotDeliveredFiles files={files} callId={tool.id} client={client} botId={botId}
            groupId={groupId} imConversationId={imConversationId} threadId={threadId}
            assistantMessageId={desktopWorkId ? assistantMessageId : undefined} />
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
      bot?.threadId,
      onOpenWork,
      onPreviewWork,
      onOpenRoutineDetails,
      workTitles,
      schedules,
      tasks,
      client,
      groupId,
      imConversationId,
      botId,
      threadId,
      desktopWorkId,
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
        const text = typeof message.content === "string"
          ? message.content
          : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
        return (
          <section className="bot-work-instruction" aria-label="Bot 交办说明">
            <div className="bot-work-instruction-label">
              {task.origin.dispatch === "create" ? "Bot 交办" : "Bot 补充"}
            </div>
            <div className="bot-work-instruction-text">
              {cleanUserAttachmentContentForDisplay(text)}
            </div>
          </section>
        )
      }
      if (task?.origin.kind === "work_result") {
        const origin = task.origin
        const title = workTitles?.get(origin.workId) ?? origin.workTitle
        return (
          <button
            type="button"
            className="bot-exchange-link"
            onClick={(event) => onPreviewWork
              ? onPreviewWork(origin.workId, event.currentTarget, title)
              : onOpenWork?.(origin.workId)}
            disabled={!onPreviewWork && !onOpenWork}
            aria-label={botWorkResultLabel(origin.executionState) + "：" + title}
          >
            <span>
              {botWorkResultLabel(origin.executionState)} · {title}
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
    [taskByMessage, onOpenWork, onPreviewWork, workTitles]
  )
  const presentFile = useCallback(
    (file: { filePath: string; threadId: string; label: ReactNode; messageId?: string }) => {
      if (file.messageId && deliveredReferences.get(file.messageId)?.has(file.filePath)) return null
      return <BotDeliveredFile {...file} client={client} botId={botId} groupId={groupId} imConversationId={imConversationId} />
    },
    [client, botId, groupId, imConversationId, deliveredReferences]
  )
  return (
    <ChatHistorySourceContext.Provider value={groupId ? null : openHistorySource}>
      <div className="bot-conversation-content" hidden={Boolean(exchangeId)}>
        <ChatToolPresentationContext.Provider value={presentTool}>
          <ChatMessagePresentationContext.Provider value={presentMessage}>
            <ChatMessageVisibilityContext.Provider value={executionView.quietMessages}>
              <ChatPresentationContext.Provider value="bot">
                <ChatDesktopWorkIdContext.Provider value={desktopWorkId}>
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
                </ChatDesktopWorkIdContext.Provider>
              </ChatPresentationContext.Provider>
            </ChatMessageVisibilityContext.Provider>
          </ChatMessagePresentationContext.Provider>
        </ChatToolPresentationContext.Provider>
      </div>
      {attachmentPreview && attachmentPreview.ownerThreadId === threadId &&
        attachmentPreview.client === client && attachmentPreview.botId === botId && !groupId && !imConversationId && (
        <BotFileDeliveryPreview
          key={`${attachmentPreview.request.threadId}:${attachmentPreview.request.intentId}`}
          client={client}
          botId={botId}
          ownerThreadId={attachmentPreview.ownerThreadId}
          threadId={attachmentPreview.request.threadId}
          name={bot?.name ?? "Bot"}
          request={attachmentPreview.request}
          clear={closeAttachmentPreview}
        />
      )}
      {exchangeId && (
        <BotExchangePanel
          key={exchangeId}
          client={client}
          botId={botId}
          taskId={exchangeId}
          groupId={groupId}
          imConversationId={imConversationId}
          onClose={() => setExchangeId(null)}
        />
      )}
    </ChatHistorySourceContext.Provider>
  )
}
