import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react"
import { ChevronRight, Clock } from "lucide-react"
import type { Message, ToolCall, ToolResult } from "@/types"
import type {
  BotClient,
  BotTask,
  BotDefinition,
  BotMessageOrigin
} from "../../../../shared/bots/contracts"
import { useThreadContext, useThreadStateSelector } from "@/lib/thread-context"
import {
  ChatPresentationContext,
  ChatActivityPresentationContext,
  ChatExecutionDetailsContext,
  ChatFoldedToolCallsContext,
  ChatFoldedMessageIdsContext,
  ChatFilePresentationContext,
  ChatMessageVisibilityContext,
  ChatMessagePresentationContext,
  ChatToolPresentationContext
} from "../chat/chat-presentation-context"
import { delegatedTaskReceipt } from "@/lib/bot-exchange-view"
import { BotExchangePanel } from "./BotExchangePanel"
import { quietBotTurnMessageIds } from "@/lib/bot-routine-visibility"
import { BotBrowserHelpCard } from "./BotBrowserHelpCard"
import { BotDeliveredFile } from "./BotDeliveredFile"
import { parseBotFileDelivery } from "../../../../shared/bots/file-delivery"
import { botGroupBrowserScope } from "../../../../shared/bots/contracts"
import { projectBotExecution } from "@/lib/bot-execution-visibility"
import { botProfileEvent } from "@/lib/bot-profile-event"
import { botDeliveredFileReferences } from "@/lib/bot-delivered-file-references"
import { getModCards, subscribeModCards } from "@/lib/mod-cards-store"
import { useBotViewStore } from "./view-store"
import { BotActivity } from "./BotActivity"

export function BotConversationTools({
  client,
  botId,
  groupId,
  tasks,
  bots,
  executionDetails,
  children
}: {
  client: BotClient
  botId: string
  groupId?: string
  tasks: BotTask[]
  bots: BotDefinition[]
  executionDetails?: boolean
  children: ReactNode
}) {
  const [exchangeId, setExchangeId] = useState<string | null>(null)
  const bot = bots.find((item) => item.id === botId)
  const exchangeTrigger = useRef<HTMLButtonElement | null>(null)
  const threadId = groupId ? `group-${groupId}-${botId}` : (bot?.threadId ?? null)
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
  // The window identity is stable during streamed token updates; source lookups need no per-token work.
  const windowKey = useThreadStateSelector(
    threadId,
    (state) => `${state.messages.length}:${state.messages[0]?.id}:${state.messages.at(-1)?.id}`
  )
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
  const taskByMessage = useMemo(
    () => new Map([...origins, ...tasks].map((task) => [task.requestId, task])),
    [tasks, origins]
  )
  const deliveredReferences = useMemo(
    () => botDeliveredFileReferences(threadId ? context.getThreadState(threadId).messages : []),
    [context, threadId, windowKey]
  )
  const executionView = useMemo(() => {
    if (!threadId)
      return {
        hiddenMessages: new Set<string>(),
        foldedTools: new Set<string>(),
        quietMessages: new Set<string>()
      }
    const messages = context.getThreadState(threadId).messages
    let view = { hiddenMessages: new Set<string>(), foldedTools: new Set<string>() }
    if (!showExecutionDetails) {
      const running = tasks.some((task) =>
        ["queued", "running", "waiting_user"].includes(task.state)
      )
      const cardCallIds = new Set(cards.map((card) => card.callId))
      view = projectBotExecution(messages, running, cardCallIds)
    }
    return { ...view, quietMessages: quietBotTurnMessageIds(messages, taskByMessage) }
  }, [threadId, context, taskByMessage, windowKey, showExecutionDetails, tasks, cards])
  useEffect(() => {
    if (!exchangeId && exchangeTrigger.current?.isConnected) exchangeTrigger.current.focus()
  }, [exchangeId])
  const presentTool = useCallback(
    (tool: ToolCall, result?: Pick<ToolResult, "content" | "is_error">) => {
      if (!result) {
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
      const profileEvent = !showExecutionDetails ? botProfileEvent(tool, result) : null
      if (profileEvent)
        return (
          <div className="bot-profile-event" role="note" title={profileEvent}>
            {profileEvent}
          </div>
        )
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
    [bots, tasks, client, groupId, botId, threadId, showExecutionDetails]
  )
  const presentMessage = useCallback(
    (message: Message) => {
      if (message.role !== "user") return null
      const task = taskByMessage.get(message.id)
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
    [taskByMessage]
  )
  const presentFile = useCallback(
    (file: { filePath: string; threadId: string; label: ReactNode; messageId?: string }) => {
      if (file.messageId && deliveredReferences.get(file.messageId)?.has(file.filePath)) return null
      return <BotDeliveredFile {...file} client={client} botId={botId} groupId={groupId} />
    },
    [client, botId, groupId, deliveredReferences]
  )
  return (
    <>
      <div className="bot-conversation-content" hidden={Boolean(exchangeId)}>
        <ChatToolPresentationContext.Provider value={presentTool}>
          <ChatMessagePresentationContext.Provider value={presentMessage}>
            <ChatMessageVisibilityContext.Provider value={executionView.quietMessages}>
              <ChatPresentationContext.Provider value="bot">
                <ChatExecutionDetailsContext.Provider value={showExecutionDetails}>
                  <ChatFoldedToolCallsContext.Provider value={executionView.foldedTools}>
                    <ChatFoldedMessageIdsContext.Provider value={executionView.hiddenMessages}>
                      <ChatFilePresentationContext.Provider value={presentFile}>
                        <ChatActivityPresentationContext.Provider
                          value={
                            !showExecutionDetails && bot && threadId ? (
                              <BotActivity bot={bot} threadId={threadId} />
                            ) : null
                          }
                        >
                          {children}
                        </ChatActivityPresentationContext.Provider>
                      </ChatFilePresentationContext.Provider>
                    </ChatFoldedMessageIdsContext.Provider>
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
    </>
  )
}
