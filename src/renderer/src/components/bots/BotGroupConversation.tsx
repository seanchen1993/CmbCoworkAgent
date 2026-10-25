import { BotGroupMentionInput, type BotGroupInputControl } from "./BotGroupMentionInput"
import {
  displayedGroupMentions,
  groupMessageRecipients,
  type BotGroupMention
} from "@/lib/bot-group-mentions"
import { BotInlineMentionsContext } from "./BotInlineMentionsContext"
import { botErrorMessage } from "@/lib/bot-error-message"
import { botGroupMessageView } from "@/lib/bot-group-message-view"
import { BotGroupAvatar } from "./BotGroupAvatar"
import { BotGroupMessageActions } from "./BotGroupMessageActions"
import { BotMessageReactionsProvider } from "./BotMessageReactions"
import { BotGroupQuestion, BotGroupQuestionBody } from "./BotGroupQuestion"
import { BotQuestionHistory } from "./BotQuestionHistory"
import { BotGroupQuestionAnswer } from "./BotGroupQuestionAnswer"
import { BotGroupSearch } from "./BotGroupSearch"
import { botGroupQuestionHistory, botGroupQuestionReplies } from "@/lib/bot-question-history"
import { botGroupActiveTasks } from "@/lib/bot-group-question"
import { useGroupQuestions, type BotGroupPendingQuestion } from "./use-group-questions"
import { BotMentionLabel } from "./BotMentionLabel"
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useBotMessageEntrances } from "@/lib/use-bot-message-entrances"
import { BotMessageEntrance } from "./BotMessageEntrance"
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FolderOpen,
  Loader2,
  MessageCircle,
  Monitor,
  Plus,
  Settings2,
  Square,
  X
} from "lucide-react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown"
import { ChatContainer } from "@/components/chat/ChatContainer"
import { ChatSearchContext } from "@/components/chat/ChatSearchContext"
import type { DurableChatSearchMatch } from "@/components/chat/ChatSearchOverlay"
import type { ChatSearchReveal } from "../../../../shared/chat-search-types"
import { ChatPresentationContext } from "@/components/chat/chat-presentation-context"
import type {
  BotClient,
  BotDefinition,
  BotGroup,
  BotGroupMessage,
  BotTask
} from "../../../../shared/bots/contracts"
import { BotAvatar } from "./BotAvatar"
import { BotMessageFilePreview } from "./BotMessageFilePreview"
import { BotDeliveredFile } from "./BotDeliveredFile"
import { BotConversationTools } from "./BotConversationTools"
import { BotExchangePanel } from "./BotExchangePanel"
import {
  EMPTY_GROUP_DRAFT,
  groupDraftKey,
  sendGroupDraft,
  useBotGroupDrafts
} from "@/lib/bot-group-drafts"
import { splitBotInlineReasoning } from "@/lib/bot-inline-reasoning"
import { EMPTY_GROUP_HISTORY, mergeGroupHistory } from "@/lib/bot-group-history"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_PICKER_FILES,
  type FileAttachment
} from "../../../../shared/file-attachment"
import { cleanUserAttachmentContentForDisplay } from "../../../../shared/user-attachment-display"

type GroupTimelineItem =
  | { kind: "message"; message: BotGroupMessage }
  | ({ kind: "question" } & BotGroupPendingQuestion)

export function BotGroupConversation({
  group,
  bots,
  userInitials,
  tasks,
  backgroundThreads = [],
  revision,
  client,
  onEdit,
  onDetails,
  detailOpen,
  detailsTriggerRef,
  onOpenBot,
  onBrowser,
  onFiles
}: {
  group: BotGroup
  bots: BotDefinition[]
  userInitials: string
  tasks: BotTask[]
  backgroundThreads?: string[]
  revision: number
  client: BotClient
  onEdit(): void
  onDetails(): void
  detailOpen: boolean
  detailsTriggerRef?: RefObject<HTMLButtonElement | null>
  onOpenBot(bot: BotDefinition): void
  onBrowser(): void
  onFiles(): void
}) {
  const [history, setHistory] = useState(EMPTY_GROUP_HISTORY)
  const { messages } = history
  const answerReplies = useMemo(() => botGroupQuestionReplies(messages), [messages])
  const questions = useGroupQuestions(client.hostId, group.id, tasks)
  const timeline = useMemo<GroupTimelineItem[]>(
    () => [
      ...messages.map((message) => ({ kind: "message" as const, message })),
      ...questions
        .filter(
          (question) =>
            !messages.some(
              (message) => message.question?.request.requestId === question.request.requestId
            )
        )
        .map((question) => ({ kind: "question" as const, ...question }))
    ],
    [messages, questions]
  )
  const listRef = useRef<VirtuosoHandle>(null)
  const viewportRef = useRef<HTMLElement | null>(null)
  const getViewport = useCallback(() => viewportRef.current, [])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchReveal, setSearchReveal] = useState<ChatSearchReveal | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const entranceIds = useMemo(() => messages.map((item) => item.id), [messages])
  const { entering: enteringMessages, retire: retireMessage } = useBotMessageEntrances(
    `${client.hostId}:group:${group.id}`,
    entranceIds,
    history.loaded && atBottom && !anchorId
  )
  const anchorRef = useRef<string | null>(null)
  const historyGeneration = useRef(0)
  const scrollAfterOrdinal = useRef<number | null>(null)
  const olderPending = useRef(false)
  const searchRevealOwner = useRef<number | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const draftKey = groupDraftKey(client.hostId, group.id)
  useEffect(() => useBotGroupDrafts.getState().restore(draftKey), [draftKey])
  const draft = useBotGroupDrafts((state) => state.drafts[draftKey] ?? EMPTY_GROUP_DRAFT)
  const input = draft.text
  const inputRef = useRef<BotGroupInputControl>(null)
  const [expandedInput, setExpandedInput] = useState(false)
  const mentioned = groupMessageRecipients(draft.mentions, group.memberIds, {
    targets: draft.targets,
    replyAuthorId: draft.replyTo?.authorBotId
  })
  const targets = mentioned.ids
  const editDraft = (patch: {
    text?: string
    mentions?: BotGroupMention[]
    targets?: string[] | null
    attachments?: FileAttachment[]
    replyTo?: { id: string; ordinal: number; text: string; authorBotId: string | null } | null
  }) => useBotGroupDrafts.getState().edit(draftKey, patch)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<BotTask | null>(null)
  const [exchange, setExchange] = useState<BotGroupMessage["exchange"]>()
  const exchangeTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!exchange && exchangeTrigger.current?.isConnected) exchangeTrigger.current.focus()
  }, [exchange])
  const [older, setOlder] = useState(true)
  const refreshRef = useRef<() => void>(() => {})
  const members = bots.filter((bot) => group.memberIds.includes(bot.id))
  const [attaching, setAttaching] = useState(false)
  const attachmentLock = useRef(false)
  const attachmentGeneration = useRef(0)
  useEffect(() => {
    attachmentGeneration.current++
    attachmentLock.current = false
    setAttaching(false)
    return () => {
      attachmentGeneration.current++
    }
  }, [client, group.id])
  const attach = async (dropped?: File[]) => {
    if (attachmentLock.current || draft.sending) return
    const member = members.find((bot) => !bot.archived && !bot.deleting)
    if (!member) {
      setError("没有可用于添加附件的群成员")
      return
    }
    const currentDraft = useBotGroupDrafts.getState().drafts[draftKey] ?? EMPTY_GROUP_DRAFT
    const count = MAX_ATTACHMENT_PICKER_FILES - currentDraft.attachments.length
    const chars =
      24_000 - currentDraft.attachments.reduce((sum, file) => sum + file.content.length, 0)
    if (count < 1 || chars < 1) {
      setError("一次最多添加 3 个附件，提取正文合计不超过 24,000 字符。")
      return
    }
    const generation = attachmentGeneration.current
    const current = () => mounted.current && attachmentGeneration.current === generation
    attachmentLock.current = true
    // Establish the draft before awaiting; group pruning must make late results inert.
    if (!useBotGroupDrafts.getState().drafts[draftKey]) editDraft({ attachments: [] })
    setAttaching(true)
    setError(null)
    try {
      if (
        dropped &&
        (dropped.length > count || dropped.some((file) => file.size > MAX_ATTACHMENT_FILE_BYTES))
      )
        throw new Error(`一次最多再添加 ${count} 个附件，单个拖入文件不能超过 5 MiB。`)
      const added = dropped
        ? await client.attachFileBytes(
            member.id,
            await Promise.all(
              dropped.map(async (file) => ({
                fileName: file.name,
                bytes: await file.arrayBuffer()
              }))
            ),
            chars,
            group.id
          )
        : await client.attachFiles(member.id, count, chars, group.id)
      if (!current()) return
      const latest = useBotGroupDrafts.getState().drafts[draftKey]
      if (!latest) return
      editDraft({ attachments: [...latest.attachments, ...added] })
    } catch (cause) {
      if (current()) setError(botErrorMessage(cause, "添加群附件失败，请重试"))
    } finally {
      if (current()) {
        attachmentLock.current = false
        setAttaching(false)
      }
    }
  }
  const running = botGroupActiveTasks(group.id, tasks)
  const backgroundMembers = group.memberIds.filter((id) =>
    backgroundThreads.includes(`group-${group.id}-${id}`)
  )
  useEffect(() => {
    let disposed = false,
      pending = false,
      dirty = true
    const refresh = async () => {
      if (anchorRef.current) return
      dirty = true
      if (pending) return
      pending = true
      try {
        while (dirty && !disposed) {
          dirty = false
          const page = await client.groupMessages(group.id)
          if (!disposed && !anchorRef.current) {
            setHistory((previous) => mergeGroupHistory(previous, page))
            setError(null)
          }
        }
      } catch (cause) {
        if (!disposed) setError(botErrorMessage(cause))
      } finally {
        pending = false
      }
    }
    refreshRef.current = () => {
      void refresh()
    }
    void refresh()
    return () => {
      disposed = true
      refreshRef.current = () => {}
    }
  }, [group.id, client])
  useEffect(() => {
    refreshRef.current()
  }, [revision])
  const returnToLatest = () => {
    historyGeneration.current++
    searchRevealOwner.current = null
    olderPending.current = false
    setBusy(false)
    anchorRef.current = null
    setAnchorId(null)
    setOlder(true)
    setHistory(EMPTY_GROUP_HISTORY)
    refreshRef.current()
  }
  const cancelSearchReveal = useCallback(() => {
    if (
      searchRevealOwner.current !== null &&
      searchRevealOwner.current === historyGeneration.current
    ) {
      historyGeneration.current++
      olderPending.current = false
      if (mounted.current) setBusy(false)
    }
    searchRevealOwner.current = null
  }, [])
  useEffect(() => {
    if (inspecting || exchange) {
      cancelSearchReveal()
      setSearchOpen(false)
      setSearchReveal(null)
    }
  }, [inspecting, exchange, cancelSearchReveal])
  const jumpToReply = useCallback(
    async (reply: { id: string; ordinal: number }, search = false) => {
      const index = messages.findIndex((item) => item.id === reply.id)
      if (index >= 0) {
        cancelSearchReveal()
        listRef.current?.scrollToIndex({
          index,
          align: "center",
          behavior: search ? "auto" : "smooth"
        })
        return
      }
      if (olderPending.current && !search) return
      olderPending.current = true
      const generation = ++historyGeneration.current
      searchRevealOwner.current = search ? generation : null
      setBusy(true)
      try {
        // Resolve the exact same-group message and its context without walking old pages.
        const page = await client.groupMessages(group.id, { targetMessageId: reply.id })
        if (!mounted.current || historyGeneration.current !== generation) return
        if (!page.some((item) => item.id === reply.id)) throw new Error("被回复的消息已不可用")
        anchorRef.current = reply.id
        setAnchorId(reply.id)
        setOlder(page.length === 50)
        setHistory(mergeGroupHistory(EMPTY_GROUP_HISTORY, page))
        if (search) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      } catch (cause) {
        if (mounted.current && historyGeneration.current === generation)
          setError(botErrorMessage(cause))
      } finally {
        if (historyGeneration.current === generation) {
          olderPending.current = false
          if (mounted.current) setBusy(false)
        }
        if (searchRevealOwner.current === generation) searchRevealOwner.current = null
      }
    },
    [messages, client, group.id, cancelSearchReveal]
  )
  const revealSearchMessage = useCallback(
    (messageId: string) => {
      cancelSearchReveal()
      const index = timeline.findIndex((item) =>
        item.kind === "message"
          ? item.message.id === messageId
          : `question-${item.request.requestId}` === messageId
      )
      if (index >= 0) listRef.current?.scrollToIndex({ index, align: "center", behavior: "auto" })
    },
    [timeline, cancelSearchReveal]
  )
  const revealSearchHistory = useCallback(
    (match: DurableChatSearchMatch) =>
      jumpToReply({ id: match.messageId, ordinal: match.ordinal }, true),
    [jumpToReply]
  )
  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    // The composer already exposes this validation error, including to screen readers.
    if (mentioned.error) return
    if (
      (!input.trim() && !draft.attachments.length) ||
      !targets.length ||
      draft.sending ||
      attachmentLock.current
    )
      return
    cancelSearchReveal()
    scrollAfterOrdinal.current = messages.at(-1)?.ordinal ?? 0
    if (anchorRef.current) returnToLatest()
    await sendGroupDraft(client, group)
    if (!mounted.current) return
    if (useBotGroupDrafts.getState().drafts[draftKey]?.error) scrollAfterOrdinal.current = null
    refreshRef.current()
  }
  const loadEarlier = async () => {
    if (!messages.length || olderPending.current) return
    olderPending.current = true
    const generation = historyGeneration.current
    setBusy(true)
    try {
      const page = await client.groupMessages(group.id, messages[0].ordinal)
      if (!mounted.current || historyGeneration.current !== generation) return
      setOlder(page.length === 50)
      setHistory((current) => mergeGroupHistory(current, page))
    } catch (cause) {
      if (mounted.current && historyGeneration.current === generation)
        setError(botErrorMessage(cause))
    } finally {
      if (historyGeneration.current === generation) {
        olderPending.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }
  return (
    <ChatPresentationContext.Provider value="bot">
      {members.map((bot) => (
        <BotMessageFilePreview
          key={bot.id}
          botId={bot.id}
          groupId={group.id}
          threadId={`group-${group.id}-${bot.id}`}
          name={group.name}
          client={client}
        />
      ))}
      <header className="bot-chat-header bot-group-header">
        <button
          className="bot-title-pill"
          ref={detailsTriggerRef}
          aria-label="查看群聊详情"
          aria-expanded={detailOpen}
          onClick={onDetails}
        >
          <BotGroupAvatar
            memberIds={group.memberIds}
            bots={bots}
            userInitials={userInitials}
            size={26}
          />
          <span>{group.name}</span>
        </button>
        <div className="bot-group-header-actions">
          <button className="bot-icon-button" aria-label="群聊资料库" onClick={onFiles}>
            <FolderOpen size={18} />
          </button>
          <button className="bot-icon-button" aria-label="群聊浏览器" onClick={onBrowser}>
            <Monitor size={18} />
          </button>
          <button className="bot-icon-button" aria-label="群聊设置" onClick={onEdit}>
            <Settings2 size={18} />
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="bot-notice">
          <span>{error}</span>
          <button onClick={() => refreshRef.current()}>重试</button>
          <button aria-label="关闭提示" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="bot-conversation-content" hidden={Boolean(exchange)}>
        {inspecting ? (
          <>
            <div className="bot-queue">
              <span>成员执行记录</span>
              <button onClick={() => setInspecting(null)}>返回群聊</button>
            </div>
            <BotConversationTools
              executionDetails
              key={inspecting.threadId}
              client={client}
              botId={inspecting.botId}
              groupId={group.id}
              bots={bots}
              tasks={tasks.filter((task) => task.threadId === inspecting.threadId)}
            >
              <ChatContainer
                key={inspecting.threadId}
                threadId={inspecting.threadId}
                surface="bot"
                readOnlyReason="请回到群聊交办新的工作；当前审批可在此处理。"
                allowUserInputInReadOnly
                managedTurn={{
                  busy: running.some((task) => task.id === inspecting.id),
                  cancel: () => client.cancel(inspecting.id),
                  submit: async () => {
                    throw new Error("请回到群聊发送消息")
                  },
                  placeholder: "请回到群聊发送消息"
                }}
              />
            </BotConversationTools>
          </>
        ) : (
          <BotMessageReactionsProvider client={client} target={{ kind: "group", groupId: group.id }} messageIds={messages.map((message) => message.id)}>
            <div className="bot-group-timeline">
              <BotGroupSearch
                client={client}
                groupId={group.id}
                messages={messages}
                questions={questions}
                enabled={!inspecting && !exchange}
                open={searchOpen}
                onOpenChange={setSearchOpen}
                getViewport={getViewport}
                onRevealMessage={revealSearchMessage}
                onRevealDurableMessage={revealSearchHistory}
                onCancelDurableReveal={cancelSearchReveal}
                onRevealSearchContext={setSearchReveal}
              />
              {!history.loaded ? (
                <div className="bot-empty">
                  <Loader2 className="size-5 animate-spin" aria-label="正在读取群聊" />
                </div>
              ) : (
                <Virtuoso
                  key={anchorId ?? "latest"}
                  ref={listRef}
                  scrollerRef={(element) => {
                    viewportRef.current = element instanceof HTMLElement ? element : null
                  }}
                  className="flex-1 min-h-0"
                  data={timeline}
                  firstItemIndex={history.firstIndex}
                  computeItemKey={(_, item) =>
                    item.kind === "message" ? item.message.id : `question-${item.request.requestId}`
                  }
                  followOutput={!anchorId && !searchOpen}
                  scrollIntoViewOnChange={() => {
                    if (
                      anchorRef.current ||
                      scrollAfterOrdinal.current === null ||
                      (messages.at(-1)?.ordinal ?? 0) <= scrollAfterOrdinal.current
                    )
                      return false
                    // Let Virtuoso wait for the new row's measurements before consuming
                    // the explicit send intent. A React effect can target the old tail.
                    scrollAfterOrdinal.current = null
                    return { index: timeline.length - 1, align: "end", behavior: "auto" }
                  }}
                  atBottomThreshold={32}
                  atBottomStateChange={setAtBottom}
                  initialTopMostItemIndex={{
                    index: Math.max(
                      0,
                      anchorId
                        ? messages.findIndex((item) => item.id === anchorId)
                        : timeline.length - 1
                    ),
                    align: anchorId ? "center" : "end"
                  }}
                  components={{
                    EmptyPlaceholder: () => (
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        还没有消息
                      </div>
                    ),
                    Header: () =>
                      older && messages.length >= 50 ? (
                        <button
                          className="mx-auto block py-3 text-xs text-muted-foreground"
                          disabled={busy}
                          onClick={() => void loadEarlier()}
                        >
                          加载更早的消息
                        </button>
                      ) : null
                  }}
                  itemContent={(index, row) => {
                    if (row.kind === "question") {
                      const bot = members.find((member) => member.id === row.task.botId)
                      return bot && !bot.deleting ? (
                        <div data-chat-message-id={`question-${row.request.requestId}`}>
                          <BotGroupQuestion {...row} bot={bot} onOpenBot={onOpenBot} />
                          {searchReveal?.messageId === `question-${row.request.requestId}` && (
                            <ChatSearchContext location={searchReveal.location} />
                          )}
                        </div>
                      ) : null
                    }
                    const item = row.message
                    const pendingQuestion =
                      item.question &&
                      questions.find(
                        (question) =>
                          question.request.requestId === item.question?.request.requestId
                      )
                    const questionHistory = item.question && botGroupQuestionHistory(item.question)
                    const displayText = item.authorBotId
                      ? splitBotInlineReasoning(item.text).body
                      : cleanUserAttachmentContentForDisplay(item.text)
                    const mentions = displayedGroupMentions(
                      item.text,
                      displayText,
                      item.mentions ?? []
                    )
                    const author = item.authorBotId
                      ? bots.find((bot) => bot.id === item.authorBotId)
                      : null
                    const replyText = (
                      displayText.trim()
                        ? displayText
                        : (item.files ?? []).map((file) => file.name).join("、")
                    ).slice(0, 1000)
                    const replyToMessage = replyText
                      ? () => {
                          editDraft({
                            replyTo: {
                              id: item.id,
                              ordinal: item.ordinal,
                              authorBotId: item.authorBotId,
                              text: replyText
                            }
                          })
                          inputRef.current?.focus()
                        }
                      : undefined
                    const position = index - history.firstIndex
                    const previous = messages[position - 1]
                    const previousAnswer = previous && answerReplies.get(previous.id)?.at(-1)
                    const presentation = botGroupMessageView(
                      item,
                      previous && previousAnswer
                        ? { ...previous, authorBotId: null, createdAt: previousAnswer.createdAt }
                        : previous,
                      messages[position + 1]
                    )
                    return (
                      <>
                        {presentation.date && (
                          <div className="bot-message-date">{presentation.date}</div>
                        )}
                        <BotMessageEntrance
                          key={item.id}
                          id={item.id}
                          entering={enteringMessages.has(item.id)}
                          onEntered={retireMessage}
                        >
                          <article
                            className="bot-group-message"
                            data-chat-message-id={item.id}
                            data-user={!item.authorBotId}
                            data-continued={presentation.continued}
                            aria-label={`${author?.name ?? (item.authorBotId ? "已移除的 Bot" : "你")} · ${new Date(item.createdAt).toLocaleString()}`}
                          >
                            {presentation.showAuthor && (
                              <div className="bot-group-author">
                                {author && !author.deleting ? (
                                  <button
                                    className="bot-group-author-link"
                                    aria-label={`打开 ${author.name} 的聊天`}
                                    onClick={() => onOpenBot(author)}
                                  >
                                    <span style={{ color: author.color }}>{author.name}</span>
                                  </button>
                                ) : (
                                  <span>
                                    {item.authorBotId ? (author?.name ?? "已移除的 Bot") : "你"}
                                  </span>
                                )}
                              </div>
                            )}
                            {(presentation.showAvatar || answerReplies.has(item.id)) &&
                              author &&
                              !author.deleting && (
                                <button
                                  className="bot-group-avatar-link"
                                  aria-label={`查看 ${author.name}`}
                                  onClick={() => onOpenBot(author)}
                                >
                                  <BotAvatar color={author.color} shape={author.shape} size={23} />
                                </button>
                              )}
                            <time
                              className="bot-group-message-time"
                              dateTime={new Date(item.createdAt).toISOString()}
                            >
                              {new Date(item.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit"
                              })}
                            </time>
                            {item.question &&
                              (pendingQuestion ? (
                                <BotGroupQuestionBody {...pendingQuestion} />
                              ) : questionHistory ? (
                                <BotQuestionHistory history={questionHistory} group />
                              ) : (
                                <div className="bot-question-history">
                                  {item.question.request.questions.map((question) => (
                                    <section className="bot-question-card" key={question.id}>
                                      <header>
                                        <span>{question.question}</span>
                                        <span className="bot-question-status">
                                          {item.question!.state === "waiting_user"
                                            ? "等待作答"
                                            : "作答回执暂不可用"}
                                        </span>
                                      </header>
                                    </section>
                                  ))}
                                </div>
                              ))}
                            {item.text && (
                              <div className="bot-group-bubble">
                                {item.replyTo && (
                                  <button
                                    type="button"
                                    className="bot-group-reply-preview"
                                    aria-label="跳转到被回复的消息"
                                    disabled={busy}
                                    onClick={() => void jumpToReply(item.replyTo!)}
                                  >
                                    <MessageCircle size={14} />
                                    <span>
                                      “
                                      {
                                        splitBotInlineReasoning(
                                          cleanUserAttachmentContentForDisplay(item.replyTo.text)
                                        ).body
                                      }
                                      ”
                                    </span>
                                  </button>
                                )}
                                <BotInlineMentionsContext.Provider
                                  value={
                                    mentions.length
                                      ? {
                                          mentions,
                                          renderLabel: (mention) => (
                                            <BotMentionLabel
                                              mention={mention}
                                              bot={bots.find(
                                                (bot) => bot.id === mention.botId && !bot.deleting
                                              )}
                                            />
                                          ),
                                          canOpen: (id) =>
                                            bots.some((bot) => bot.id === id && !bot.deleting),
                                          open: (id) => {
                                            const bot = bots.find(
                                              (bot) => bot.id === id && !bot.deleting
                                            )
                                            if (bot) onOpenBot(bot)
                                          }
                                        }
                                      : null
                                  }
                                >
                                  <StreamingMarkdown
                                    isStreaming={false}
                                    botTranscript={Boolean(item.authorBotId)}
                                    threadId={author ? `group-${group.id}-${author.id}` : undefined}
                                  >
                                    {displayText}
                                  </StreamingMarkdown>
                                </BotInlineMentionsContext.Provider>
                                <BotGroupMessageActions
                                  messageId={item.id}
                                  author={
                                    author?.name ?? (item.authorBotId ? "已移除的 Bot" : "你")
                                  }
                                  text={displayText}
                                  onError={(cause) =>
                                    setError(botErrorMessage(cause, "复制失败，请重试。"))
                                  }
                                  onReply={replyToMessage}
                                />
                              </div>
                            )}
                            {item.files && author && (
                              <div className="bot-delivered-files">
                                {item.files.map((file) => (
                                  <BotDeliveredFile
                                    key={file.filePath}
                                    client={client}
                                    botId={author.id}
                                    groupId={group.id}
                                    threadId={`group-${group.id}-${author.id}`}
                                    filePath={file.filePath}
                                    attachmentPath={file.attachmentPath}
                                    size={file.size}
                                  />
                                ))}
                                {!item.text && (
                                  <BotGroupMessageActions
                                    messageId={item.id}
                                    author={author.name}
                                    text=""
                                    onReply={replyToMessage}
                                    onError={(cause) => setError(botErrorMessage(cause))}
                                  />
                                )}
                              </div>
                            )}
                            {item.exchange && (
                              <button
                                className="bot-exchange-link"
                                onClick={(event) => {
                                  exchangeTrigger.current = event.currentTarget
                                  setExchange(item.exchange)
                                }}
                              >
                                查看 Bot 交流
                                <ChevronRight size={14} />
                              </button>
                            )}
                            {searchReveal?.messageId === item.id && (
                              <ChatSearchContext location={searchReveal.location} />
                            )}
                          </article>
                        </BotMessageEntrance>
                        {answerReplies.get(item.id)?.map((reply, replyIndex, replies) => (
                          <BotGroupQuestionAnswer
                            key={reply.source.id}
                            history={reply.history}
                            previousAt={replies[replyIndex - 1]?.createdAt ?? item.createdAt}
                            onQuote={() => void jumpToReply(reply.source)}
                          />
                        ))}
                      </>
                    )
                  }}
                />
              )}
              {(anchorId || !atBottom) && history.loaded && messages.length > 0 && (
                <button
                  className="bot-group-latest bot-icon-button"
                  aria-label="回到最新群消息"
                  onClick={() => {
                    cancelSearchReveal()
                    if (anchorRef.current) returnToLatest()
                    else
                      listRef.current?.scrollToIndex({
                        index: "LAST",
                        align: "end",
                        behavior: "auto"
                      })
                  }}
                >
                  <ArrowDown size={18} />
                </button>
              )}
            </div>
            {(running.length > 0 || backgroundMembers.length > 0) && (
              <div className="bot-group-progress">
                {running.map((task) => (
                  <button key={task.id} onClick={() => setInspecting(task)}>
                    <span className="bot-status-dot" />
                    {bots.find((bot) => bot.id === task.botId)?.name ?? "Bot"} ·{" "}
                    {task.state === "waiting_user"
                      ? "需要确认"
                      : task.state === "queued"
                        ? "等待执行"
                        : "正在处理"}
                  </button>
                ))}
                {backgroundMembers
                  .filter((id) => !running.some((task) => task.botId === id))
                  .map((id) => (
                    <span key={id}>
                      <span className="bot-status-dot" />
                      {bots.find((bot) => bot.id === id)?.name ?? "Bot"} · 正在处理
                    </span>
                  ))}
                <button
                  aria-label="停止群聊工作"
                  onClick={() =>
                    void Promise.all(
                      [
                        ...new Set([...running.map((task) => task.botId), ...backgroundMembers])
                      ].map((id) => client.stopConversation(id, group.id))
                    ).catch((cause) => setError(botErrorMessage(cause)))
                  }
                >
                  <Square size={13} />
                </button>
              </div>
            )}
            <form
              className="bot-group-composer"
              onSubmit={send}
              onKeyDown={(event) => {
                if (
                  event.key === "Escape" &&
                  !event.defaultPrevented &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229 &&
                  draft.replyTo
                ) {
                  event.preventDefault()
                  editDraft({ replyTo: null })
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault()
              }}
              onDrop={(event) => {
                if (event.dataTransfer.files.length) {
                  event.preventDefault()
                  void attach(Array.from(event.dataTransfer.files))
                }
              }}
            >
              {draft.replyTo && (
                <div className="bot-group-reply-draft">
                  <button
                    type="button"
                    className="bot-group-reply-preview"
                    disabled={busy}
                    aria-label="跳转到被回复的消息"
                    onClick={() => void jumpToReply(draft.replyTo!)}
                  >
                    <MessageCircle size={15} />
                    <span>“{draft.replyTo.text || "文件消息"}”</span>
                  </button>
                  <button
                    type="button"
                    className="bot-icon-button"
                    aria-label="取消回复"
                    onClick={() => {
                      editDraft({ replyTo: null })
                      inputRef.current?.focus()
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {draft.targets !== null && draft.mentions.length === 0 && (
                <div className="bot-group-recipients" aria-label="交办给">
                  <span>
                    {members
                      .filter((bot) => targets.includes(bot.id))
                      .map((bot) => bot.name)
                      .join("、") || "尚未选择成员"}
                  </span>
                  <button type="button" onClick={() => editDraft({ targets: null })}>
                    恢复所有人
                  </button>
                </div>
              )}
              {draft.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 pb-2">
                  {draft.attachments.map((file) => (
                    <span
                      key={file.filePath}
                      className="inline-flex max-w-full items-center gap-2 rounded-xl bg-muted px-3 py-1.5 text-xs"
                    >
                      <span className="truncate">{file.filename}</span>
                      <button
                        type="button"
                        className="bot-icon-button"
                        aria-label={`移除附件 ${file.filename}`}
                        disabled={attaching || draft.sending}
                        onClick={() =>
                          editDraft({
                            attachments: draft.attachments.filter(
                              (item) => item.filePath !== file.filePath
                            )
                          })
                        }
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div
                className="bot-group-composer-fields"
                data-expanded={expandedInput || draft.attachments.length > 0}
              >
                <button
                  type="button"
                  className="bot-icon-button"
                  aria-label="添加群附件"
                  disabled={
                    attaching ||
                    draft.sending ||
                    draft.attachments.length >= MAX_ATTACHMENT_PICKER_FILES
                  }
                  onClick={() => void attach()}
                >
                  {attaching ? <Loader2 size={18} className="animate-spin" /> : <Plus size={20} />}
                </button>
                <BotGroupMentionInput
                  text={input}
                  mentions={draft.mentions}
                  members={members}
                  placeholder={questions.length ? "输入你的回答，或聊点别的" : undefined}
                  inputRef={inputRef}
                  onEdit={editDraft}
                  onLayout={(multiline, hasText) =>
                    setExpandedInput((expanded) => hasText && (expanded || multiline))
                  }
                  onCancelReply={() => {
                    if (!draft.replyTo) return false
                    editDraft({ replyTo: null })
                    return true
                  }}
                  onPasteFiles={(files) => void attach(files)}
                />
                {(input.trim().length > 0 || draft.attachments.length > 0 || draft.sending) && (
                  <button
                    type="submit"
                    className="bot-group-send"
                    disabled={
                      draft.sending ||
                      attaching ||
                      (!input.trim() && !draft.attachments.length) ||
                      !targets.length
                    }
                    aria-label="发送群聊消息"
                  >
                    {draft.sending ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <ArrowUp size={20} />
                    )}
                  </button>
                )}
              </div>
              {mentioned.error && (
                <p role="alert" className="text-xs text-destructive">
                  {mentioned.error}
                </p>
              )}
              {draft.error && (
                <p role="alert" className="text-xs text-destructive">
                  {draft.error}
                </p>
              )}
              {draft.storageError && (
                <p role="alert" className="text-xs text-destructive">
                  {draft.storageError}
                </p>
              )}
            </form>
          </BotMessageReactionsProvider>
        )}
      </div>
      {exchange && (
        <BotExchangePanel
          key={exchange.taskId}
          client={client}
          botId={exchange.botId}
          groupId={group.id}
          taskId={exchange.taskId}
          onClose={() => setExchange(undefined)}
        />
      )}
    </ChatPresentationContext.Provider>
  )
}
