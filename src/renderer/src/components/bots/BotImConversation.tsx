import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Loader2,
  Square,
  MoreHorizontal,
  PanelRight,
  RefreshCw,
  UsersRound,
  X
} from "lucide-react"
import { parseBotWorkHistoryHref } from "../../../../shared/bots/work-history"
import { useChatSourceNavigation } from "@/lib/chat-source-navigation"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type {
  BotClient,
  BotTask,
  BotDefinition,
  BotSchedule,
  BotConversationActivity
} from "../../../../shared/bots/contracts"
import type { BotImConversation as Conversation } from "../../../../shared/bots/im-channel"
import type { BotMockFeedEntry } from "../../../../shared/bots/mock-channel"
import { botErrorMessage } from "@/lib/bot-error-message"
import { BotAvatar } from "./BotAvatar"
import { useBotReadState } from "./use-bot-read-state"
import type { useBotWorks } from "./use-bot-works"
import type { BotWorkItem } from "../../../../shared/bots/work"
import { BotWorkPanel } from "./BotWorkPanel"
import { BotBrowserPanel } from "./BotBrowserPanel"
import { botImBrowserScope } from "../../../../shared/bots/im-channel"
import { botWorkBrowserScope } from "../../../../shared/bots/work"
import { BotSchedulePanel } from "./BotSchedulePanel"
import { BotMemoryPanel } from "./BotMemoryPanel"
import { ChatContainer } from "@/components/chat/ChatContainer"
import { BotConversationTools } from "./BotConversationTools"
import { BotMessageFilePreview } from "./BotMessageFilePreview"
import { BotExecutionDetailsToggle } from "./BotExecutionDetailsToggle"
import { useBotViewStore } from "./view-store"
import "./bot-im-conversation.css"

const stateLabels: Record<string, string> = {
  queued: "等待处理",
  running: "正在处理",
  waiting_user: "等待补充",
  failed: "处理失败",
  cancelled: "已停止",
  interrupted: "已中断",
  pending: "等待回传",
  sending: "正在回传",
  blocked: "回传已停止",
  unknown: "送达待核对",
  outcome_unknown: "结果待核对"
}
export const imConversationStatus = (value: Conversation) =>
  value.state === "revoked" ? "已解除接入" : value.connected ? "已连接招乎" : "离线 · 保留本地记录"

function GroupAvatar({ small = false }: { small?: boolean }) {
  return (
    <span className="bot-im-avatar" data-small={small}>
      <UsersRound size={small ? 19 : 30} strokeWidth={1.6} />
    </span>
  )
}

export function BotImConversationRows({
  conversations,
  bots,
  selectedId,
  onSelect
}: {
  conversations: Conversation[]
  bots: BotDefinition[]
  selectedId?: string | null
  onSelect(id: string): void
}) {
  if (!conversations.length) return null
  return (
    <section className="bot-im-list" aria-label="招乎群聊">
      <h3>招乎群聊</h3>
      {conversations.map((group) => (
        <button
          key={group.id}
          className="bot-list-item"
          data-selected={selectedId === group.id}
          aria-label={`招乎群聊：${group.title}`}
          data-bot-row-key={`im:${group.id}`}
          data-bot-unread-count={group.activity.unread ? 1 : 0}
          onClick={() => onSelect(group.id)}
          title={group.title}
        >
          <GroupAvatar small />
          <span className="bot-im-row-copy">
            <span className="bot-im-row-title">{group.title}</span>
            <span className="bot-list-preview">{group.activity.preview || "尚无群消息"}</span>
            <span className="bot-im-row-caption">
              {bots.find((bot) => bot.id === group.botId)?.name}
              {group.state === "revoked" ? " · 已解除" : !group.connected ? " · 离线" : ""}
            </span>
          </span>
          {group.activity.unread && <span className="bot-unread-dot" aria-label="群聊有未读消息" />}
        </button>
      ))}
    </section>
  )
}

export function BotImConversation({
  conversation,
  bot,
  client,
  revision,
  tasks = [],
  backgroundThreads = [],
  detailOpen,
  onDetails,
  onManage,
  onMain,
  onWork
}: {
  conversation: Conversation
  bot: BotDefinition
  client: BotClient
  revision: number
  tasks?: BotTask[]
  backgroundThreads?: string[]
  detailOpen: boolean
  onDetails(): void
  onManage(): void
  onMain(): void
  onWork(id: string): void
}) {
  const showExecutionDetails = useBotViewStore((state) =>
    Boolean(state.hosts[client.hostId]?.showExecutionDetails)
  )
  const executionThreadId = showExecutionDetails ? conversation.threadId : undefined
  const [stopping, setStopping] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)
  const groupTasks = tasks.filter(
    (task) =>
      task.mockSource?.transport === "im" &&
      task.mockSource.bindingId === conversation.id &&
      task.botId === bot.id &&
      !task.workId &&
      !("rootWorkId" in task.origin && task.origin.rootWorkId)
  )
  const activeTasks = groupTasks.filter((task) =>
    ["queued", "running", "waiting_user"].includes(task.state)
  )
  const backgroundBusy = Boolean(
    conversation.threadId && backgroundThreads.includes(conversation.threadId)
  )
  const stop = async () => {
    if (stopping) return
    setStopping(true)
    setControlError(null)
    try {
      await client.im!.stopConversation(bot.id, conversation.id)
    } catch (cause) {
      if (mounted.current) setControlError(botErrorMessage(cause))
    } finally {
      if (mounted.current) setStopping(false)
    }
  }
  const [entries, setEntries] = useState<BotMockFeedEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [moreBusy, setMoreBusy] = useState(false)
  const [gap, setGap] = useState(false)
  const [retry, setRetry] = useState(0)
  const [presented, setPresented] = useState<BotConversationActivity>()
  const windowRef = useRef<{ items: BotMockFeedEntry[]; before: string | null }>({
    items: [],
    before: null
  })
  const mounted = useRef(true),
    epoch = useRef(0)
  const openHistory = async (href: string) => {
    const source = parseBotWorkHistoryHref(href),
      currentEpoch = epoch.current
    if (!source || !client.works?.resolveSource) return
    try {
      const work = await client.works.get(bot.id, source.workId)
      if (work.source?.bindingId !== conversation.id) throw new Error("此来源不属于当前群聊")
      const target = await client.works.resolveSource(bot.id, source)
      if (!mounted.current || currentEpoch !== epoch.current) return
      useChatSourceNavigation.getState().request(target)
      onWork(work.id)
    } catch (cause) {
      if (mounted.current && currentEpoch === epoch.current) setError(botErrorMessage(cause))
    }
  }
  const scroll = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    scrollTop = useRef(0)
  const anchor = useRef<{ height: number; top: number } | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current++
    }
  }, [])
  useEffect(() => {
    const token = ++epoch.current
    setLoading(true)
    const read = client.im?.conversationHistory
    if (!read) {
      setError("当前客户端暂不支持打开招乎群会话。")
      setLoading(false)
      return
    }
    void read(bot.id, conversation.id)
      .then(
        (page) => {
          if (!mounted.current || token !== epoch.current) return
          const old = windowRef.current
          const overlap =
            !old.items.length ||
            !page.items.length ||
            page.items.some((item) => old.items.some((entry) => entry.id === item.id))
          const next = {
            items: overlap
              ? [
                  ...new Map(
                    [...old.items, ...page.items].map((entry) => [entry.id, entry])
                  ).values()
                ]
              : page.items,
            before: overlap && old.items.length ? old.before : page.before
          }
          windowRef.current = next
          setEntries(next.items)
          setCursor(next.before)
          setError(null)
          if (!overlap) {
            setGap(true)
            atBottom.current = true
          }
          setPresented(conversation.activity)
        },
        (cause) => {
          if (mounted.current && token === epoch.current) setError(botErrorMessage(cause))
        }
      )
      .finally(() => {
        if (mounted.current && token === epoch.current) setLoading(false)
      })
  }, [client, bot.id, conversation.id, revision, retry])
  useBotReadState(client, presented)
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node || executionThreadId) return
    if (anchor.current) {
      node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height
      anchor.current = null
    } else node.scrollTop = atBottom.current ? node.scrollHeight : scrollTop.current
    scrollTop.current = node.scrollTop
  }, [entries, executionThreadId])
  const more = async () => {
    if (!cursor || moreBusy || loading || !client.im?.conversationHistory) return
    setMoreBusy(true)
    const token = epoch.current
    try {
      const page = await client.im.conversationHistory(bot.id, conversation.id, cursor)
      if (!mounted.current || token !== epoch.current) return
      if (page.before === cursor) throw new Error("历史记录分页没有前进，请刷新后重试。")
      if (scroll.current)
        anchor.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }
      const next = {
        items: [
          ...new Map(
            [...windowRef.current.items, ...page.items].map((entry) => [entry.id, entry])
          ).values()
        ],
        before: page.before
      }
      windowRef.current = next
      setEntries(next.items)
      setCursor(page.before)
      setError(null)
    } catch (cause) {
      if (mounted.current) setError(botErrorMessage(cause))
    } finally {
      if (mounted.current) setMoreBusy(false)
    }
  }
  const ordered = [...entries].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return (
    <>
      <header className="bot-chat-header bot-im-header">
        <div className="bot-im-header-actions">
          <BotExecutionDetailsToggle hostId={client.hostId} compact />
          <button
            className="bot-icon-button"
            aria-label="返回 Bot 主对话"
            title="返回 Bot 主对话"
            onClick={onMain}
          >
            <ArrowLeft size={19} />
          </button>
        </div>
        <button
          className="bot-title-pill"
          onClick={onDetails}
          aria-label="查看招乎群详情"
          aria-expanded={detailOpen}
        >
          <UsersRound size={22} strokeWidth={1.6} />
          <span>{conversation.title}</span>
        </button>
        <button
          className="bot-icon-button"
          onClick={onDetails}
          aria-label={detailOpen ? "关闭群详情" : "打开群详情"}
          aria-expanded={detailOpen}
        >
          <PanelRight size={19} />
        </button>
      </header>
      <div className="bot-im-context">
        <span>
          <span className="bot-im-connection-dot" data-online={conversation.connected} />
          {imConversationStatus(conversation)}
        </span>
        <button onClick={onManage} aria-label="管理群接入">
          <MoreHorizontal size={17} />
        </button>
      </div>
      {controlError && (
        <div className="bot-notice" role="alert">
          {controlError}
        </div>
      )}
      {executionThreadId && (
        <div className="bot-conversation-content">
          <BotMessageFilePreview
            client={client}
            botId={bot.id}
            threadId={executionThreadId}
            name={conversation.title}
          />
          <BotConversationTools
            executionDetails
            client={client}
            botId={bot.id}
            conversationThreadId={executionThreadId}
            bots={[bot]}
            onOpenWork={onWork}
            tasks={groupTasks.filter((task) => task.threadId === executionThreadId)}
          >
            <ChatContainer
              key={executionThreadId}
              threadId={executionThreadId}
              surface="bot"
              readOnlyReason="请在招乎群中继续交流；当前审批可在此处理。"
              allowUserInputInReadOnly
              managedTurn={{
                busy:
                  backgroundBusy || activeTasks.some((task) => task.threadId === executionThreadId),
                cancel: stop,
                submit: async () => {
                  throw new Error("请在招乎群中发送消息")
                },
                placeholder: "请在招乎群中发送消息"
              }}
            />
          </BotConversationTools>
        </div>
      )}
      <div
        hidden={Boolean(executionThreadId)}
        className="bot-im-transcript"
        ref={scroll}
        aria-label={`${conversation.title}消息记录`}
        onScroll={() => {
          const node = scroll.current
          if (node && !executionThreadId) {
            atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100
            scrollTop.current = node.scrollTop
          }
        }}
      >
        {cursor && (
          <button
            className="bot-im-history-more"
            onClick={() => void more()}
            disabled={loading || moreBusy}
          >
            {moreBusy ? <Loader2 size={14} className="animate-spin" /> : null} 查看更早消息
          </button>
        )}
        {gap && <p className="bot-im-history-note">已更新到最近消息，可向上查看更早记录。</p>}
        {error && (
          <div className="bot-im-history-note" role="alert">
            {error}{" "}
            <button onClick={() => setRetry((v) => v + 1)}>
              <RefreshCw size={13} /> 重试
            </button>
          </div>
        )}
        {!ordered.length && !error && (
          <div className="bot-empty" role="status">
            {loading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <UsersRound size={28} strokeWidth={1.4} />
            )}
            <p>{loading ? "正在读取群消息…" : "群里的交流，会显示在这里"}</p>
            {!loading && (
              <span className="bot-im-empty-hint">
                在招乎群中 @机器人发送消息后，记录会自动同步。
              </span>
            )}
          </div>
        )}
        {ordered.map((entry, i) => {
          const date = new Date(entry.createdAt).toLocaleDateString()
          const newDate =
            i === 0 || new Date(ordered[i - 1].createdAt).toLocaleDateString() !== date
          return (
            <div key={entry.id} data-im-message={entry.id}>
              {newDate && <div className="bot-message-date">{date}</div>}
              <article className="bot-im-message" data-author={entry.kind}>
                <div className="bot-im-message-avatar">
                  {entry.kind === "bot" ? (
                    <BotAvatar color={bot.color} shape={bot.shape} size={26} />
                  ) : (
                    <UsersRound size={19} strokeWidth={1.6} />
                  )}
                </div>
                <div className="bot-im-message-content">
                  <div className="bot-group-author">
                    <span>{entry.kind === "bot" ? bot.name : "群成员"}</span>
                    <time dateTime={new Date(entry.createdAt).toISOString()}>
                      {new Date(entry.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </time>
                  </div>
                  <div className="bot-group-bubble bot-im-bubble">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) =>
                          href && parseBotWorkHistoryHref(href) ? (
                            <button
                              className="bot-im-text-button"
                              onClick={() => void openHistory(href)}
                            >
                              {children}
                              <ArrowUpRight size={13} />
                            </button>
                          ) : href && /^https?:\/\//i.test(href) ? (
                            <a href={href} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          ) : (
                            <span>{children}</span>
                          ),
                        img: ({ alt }) => <span>{alt || "图片"}</span>
                      }}
                    >
                      {entry.text}
                    </ReactMarkdown>
                  </div>
                  {(entry.workId || stateLabels[entry.state]) && (
                    <div className="bot-im-message-meta">
                      {stateLabels[entry.state] && <span>{stateLabels[entry.state]}</span>}
                      {entry.workId && (
                        <button onClick={() => onWork(entry.workId!)}>
                          查看独立任务 <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            </div>
          )
        })}
      </div>
      {(activeTasks.length > 0 || backgroundBusy) && (
        <div className="bot-im-execution-bar" role="status">
          <span>
            {backgroundBusy || activeTasks.some((task) => task.state === "running")
              ? "正在处理"
              : activeTasks.some((task) => task.state === "waiting_user")
                ? "等待你处理"
                : "等待执行"}
          </span>
          <button disabled={stopping} onClick={() => void stop()}>
            <Square size={13} />
            {stopping ? "正在停止…" : "停止群内执行"}
          </button>
        </div>
      )}
      <footer className="bot-im-composer-note">
        <UsersRound size={17} strokeWidth={1.5} />
        <span>
          {conversation.state === "revoked"
            ? "接入已解除，历史消息仍可查看"
            : "请在招乎群内 @机器人继续交流"}
        </span>
      </footer>
    </>
  )
}

export function BotImConversationDetails({
  conversation,
  bot,
  client,
  onClose,
  onManage,
  onMain,
  onWork,
  controller,
  selectedWork,
  schedules = [],
  onBack
}: {
  conversation: Conversation
  bot: BotDefinition
  client: BotClient
  revision: number
  onClose(): void
  onManage(): void
  onMain(): void
  onWork(id: string): void
  controller: ReturnType<typeof useBotWorks>
  selectedWork: BotWorkItem | null
  schedules?: BotSchedule[]
  onBack(): void
}) {
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [computerOpen, setComputerOpen] = useState(false)
  return (
    <>
      <div className="bot-detail-actions">
        <button className="bot-icon-button" aria-label="关闭群详情" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <div className="bot-profile bot-im-profile">
        <GroupAvatar />
        <h2>{conversation.title}</h2>
        <span className="bot-im-type-label">招乎群聊</span>
      </div>
      <div className="bot-im-details-section">
        <h3>服务 Bot</h3>
        <button className="bot-im-owner" onClick={onMain}>
          <BotAvatar color={bot.color} shape={bot.shape} size={32} />
          <span>
            <strong>{bot.name}</strong>
            <small>打开私人主对话</small>
          </span>
          <ChevronRight size={16} />
        </button>
      </div>
      <BotWorkPanel
        key={conversation.id}
        client={client}
        botId={bot.id}
        controller={controller}
        selected={selectedWork}
        onSelect={(id) => (id ? onWork(id) : onBack())}
        onBack={onBack}
        heading="群内任务"
        backLabel="返回群聊"
        allowCreate={false}
        disabled={Boolean(bot.archived || bot.deleting)}
      />
      <div className="bot-im-details-section">
        <button
          className="bot-im-text-button"
          aria-expanded={memoryOpen}
          onClick={() => setMemoryOpen(!memoryOpen)}
        >
          记忆 <ChevronRight size={14} />
        </button>
        {!memoryOpen && <p>使用 Bot 共享记忆与本群记忆。</p>}
      </div>
      {memoryOpen && (
        <BotMemoryPanel
          key={conversation.id}
          bot={bot}
          client={client}
          peers={[]}
          groupId={conversation.id}
        />
      )}
      <div className="bot-im-details-section">
        <button
          className="bot-im-text-button"
          aria-expanded={computerOpen}
          onClick={() => setComputerOpen(!computerOpen)}
        >
          电脑 <ChevronRight size={14} />
        </button>
        {computerOpen && (
          <BotBrowserPanel
            key={selectedWork?.id ?? conversation.id}
            client={client}
            botId={
              selectedWork
                ? botWorkBrowserScope(selectedWork.id, bot.id)
                : botImBrowserScope(conversation.id, bot.id)
            }
          />
        )}
      </div>
      <BotSchedulePanel
        botId={bot.id}
        client={client}
        allowCreate={false}
        schedules={schedules.filter(
          (item) => item.botId === bot.id && item.audienceKey === `im:${conversation.id}`
        )}
      />
      <div className="bot-im-details-section bot-im-connection-section">
        <h3>接入</h3>
        <p>{imConversationStatus(conversation)}</p>
        <p>这里展示本机收到的群消息和 Bot 回复，不包含未发送给机器人的群消息。</p>
        <button className="bot-im-text-button" onClick={onManage}>
          管理接入 <ChevronRight size={14} />
        </button>
      </div>
    </>
  )
}
