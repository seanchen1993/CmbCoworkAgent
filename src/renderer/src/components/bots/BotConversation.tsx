import "./bots.css"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CircleAlert, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { ChatContainer, type ManagedChatTurn } from "@/components/chat/ChatContainer"
import { useAppStore } from "@/lib/store"
import { useThreadContext, useThreadStateSelector } from "@/lib/thread-context"
import { botErrorMessage } from "@/lib/bot-error-message"
import { bindBotConversationDraft } from "@/lib/bot-conversation-draft"
import { BotDraftSender, validateBotDraft } from "@/lib/bot-draft-sender"
import {
  BOT_REQUEST_RECEIPT_LIMIT,
  botTaskAcceptsUserInput,
  type BotDefinition,
  type BotGroup,
  type BotClient,
  type BotSchedule,
  type BotTask
} from "../../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../../shared/bots/work"
import { botTaskPreview } from "@/lib/bot-task-view"
import { BotConversationTools } from "./BotConversationTools"
import { BotMessageFilePreview } from "./BotMessageFilePreview"
import { BotMessageReactionsProvider } from "./BotMessageReactions"
const active = (task: BotTask) => task.state === "running" || task.state === "waiting_user"

export function BotConversation({
  bot,
  work,
  bots,
  groups = [],
  schedules,
  tasks,
  backgroundBusy,
  client,
  onConfigureModel,
  onOpenWork,
  onOpenBot,
  onOpenGroup
}: {
  bot: BotDefinition
  work?: BotWorkItem | null
  bots: BotDefinition[]
  groups?: readonly BotGroup[]
  schedules: BotSchedule[]
  tasks: BotTask[]
  backgroundBusy: boolean
  client: BotClient
  onConfigureModel?(): void
  onOpenWork(workId: string): void
  onOpenBot?(botId: string): void
  onOpenGroup?(groupId: string): void
}) {
  const mentionGroups = useMemo(
    () => groups.filter(
      (group) => !group.deleting && group.hostId === bot.hostId && group.memberIds.includes(bot.id)
    ),
    [groups, bot.hostId, bot.id]
  )
  const threadId = work?.threadId ?? bot.threadId
  const reactionIdsKey = useThreadStateSelector(threadId, (state) =>
    JSON.stringify(
      state.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => message.id)
    )
  )
  // The host rejects unpersisted rows; task completion refreshes the same IDs.
  const reactionIds = useMemo(() => JSON.parse(reactionIdsKey ?? "[]") as string[], [reactionIdsKey])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null)
  const threadContext = useThreadContext()
  const [sendingRevision, setSendingRevision] = useState(0)
  const sender = useMemo(
    () =>
      new BotDraftSender(
        client,
        bot.id,
        threadContext.getThreadActions(threadId),
        setError,
        () => setSendingRevision((revision) => revision + 1),
        Date.now,
        work ? { botId: bot.id, workId: work.id } : undefined
      ),
    [client, bot.id, threadId, threadContext]
  )
  const submitDraft = useCallback<NonNullable<ManagedChatTurn["submitDraft"]>>(
    (draft) => sender.send(draft),
    [sender]
  )
  const reconcileDrafts = useCallback<NonNullable<ManagedChatTurn["reconcileDrafts"]>>(
    (drafts) => sender.reconcile(drafts),
    [sender]
  )
  useEffect(() => {
    let disposed = false
    let unbindDraft: (() => void) | undefined
    setReady(false)
    client
      .open(bot.id)
      .then(async () => {
        await useAppStore.getState().loadThreads()
        if (!disposed) {
          unbindDraft = bindBotConversationDraft(
            threadContext,
            client.hostId,
            bot.id,
            threadId,
            (message) => {
              if (!disposed) setDraftStorageError(message)
            },
            work?.id
          )
          setReady(true)
        }
      })
      .catch((cause) => {
        if (!disposed) setError(botErrorMessage(cause))
      })
    return () => {
      disposed = true
      unbindDraft?.()
    }
  }, [bot.id, threadId, bot.modelRef, client, threadContext])
  const running = tasks.find(active)
  const queued = tasks.filter((task) => task.state === "queued")
  const submit = useCallback<ManagedChatTurn["submit"]>(
    async (input, options) => {
      const messages = input?.messages
      const message = Array.isArray(messages) && messages.length === 1 ? messages[0]?.content : null
      if (typeof message !== "string" || !message.trim() || options?.command) {
        setError("此请求不能作为 Bot 消息发送，请从当前审批卡片操作。")
        return
      }
      const visibleId = options?.config?.configurable?.hook_turn_id
      const requestId = typeof visibleId === "string" ? visibleId : crypto.randomUUID()
      setError(null)
      try {
        await client.send({ botId: bot.id, requestId, message })
      } catch (cause) {
        setError(botErrorMessage(cause))
        throw cause
      }
    },
    [bot.id, threadId, client, threadContext]
  )
  const cancel = useCallback(async () => {
    sender.stopPreparing()
    await client.stopConversation(bot.id)
  }, [sender, client, bot.id])
  const managedTurn = useMemo<ManagedChatTurn>(
    () => ({
      ...(work?.source
        ? { textOnlyReason: "模拟渠道仅支持文字和同受众工作，不支持附件、技能或本机资源。" }
        : {}),
      ownerConversation: Boolean(work?.conversation?.state === "bound"),
      ...(!work ? { mentionOptions: {
        bots: bots.filter((peer) => peer.hostId === bot.hostId && peer.id !== bot.id && !peer.archived && !peer.deleting),
        groups: mentionGroups
      } } : {}),
      submit,
      submitDraft,
      validateDraft: validateBotDraft,
      reconcileDrafts,
      sendingDraftIds: sender.sending,
      maxPendingDrafts: BOT_REQUEST_RECEIPT_LIMIT,
      draftReceiptRevision: tasks
        .map((task) => `${task.id}:${task.updatedAt}:${task.state}`)
        .join("|"),
      attachFiles: (maxFiles, maxChars) => client.attachFiles(bot.id, maxFiles, maxChars),
      attachFileBytes: (files, maxChars) => client.attachFileBytes(bot.id, files, maxChars),
      cancel,
      ...(work?.conversation?.state === "bound" ? {} : { configureModel: onConfigureModel }),
      busy: Boolean(running) || backgroundBusy,
      busySubmitLabel: "发送消息",
      canReplyToQuestionsInComposer: Boolean(running && botTaskAcceptsUserInput(running)),
      placeholder: `给 ${bot.name} 发消息…`
    }),
    [
      submit,
      submitDraft,
      bots,
      mentionGroups,
      work,
      bot.hostId,
      reconcileDrafts,
      work?.source,
      work?.conversation?.state,
      sender,
      sendingRevision,
      tasks,
      cancel,
      running,
      backgroundBusy,
      bot.id,
      bot.name,
      client,
      onConfigureModel
    ]
  )
  if (!ready)
    return (
      <div className="bot-empty">
        {error ? <p role="alert">{error}</p> : <Loader2 className="size-5 animate-spin" />}
      </div>
    )
  return (
    <>
      {draftStorageError && (
        <div role="alert" className="bot-notice">
          {draftStorageError}
        </div>
      )}
      {error && (
        <div role="alert" className="bot-notice">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button aria-label="关闭提示" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {queued.length > 0 && (
        <div className="bot-queue" aria-live="polite">
          <span>{queued.length} 条待办</span>
          <span className="truncate">{botTaskPreview(queued[0])}</span>
          <button
            onClick={() =>
              void client.cancel(queued[0].id).catch((cause) => toast.error(botErrorMessage(cause)))
            }
          >
            撤回
          </button>
        </div>
      )}
      <BotMessageReactionsProvider client={client} target={{ kind: "bot", botId: bot.id, ...(work ? { workId: work.id } : {}) }} messageIds={reactionIds} enabled={!work?.source} refreshKey={`${running?.id ?? ""}:${running?.state ?? "idle"}`}>
      <BotConversationTools
        client={client}
        botId={bot.id}
        conversationThreadId={threadId}
        onOpenWork={onOpenWork}
        onOpenBot={onOpenBot}
        onOpenGroup={onOpenGroup}
        groups={mentionGroups}
        tasks={tasks}
        bots={bots}
        schedules={schedules}
      >
        <ChatContainer
          threadId={threadId}
          surface="bot"
          managedTurn={managedTurn}
          readOnlyReason={
            bot.archived
              ? "Bot 已归档，恢复后可以继续对话。"
              : work?.state === "completed"
                ? "工作已完成，点击右侧「继续处理」可在原会话继续。"
                : null
          }
        />
      </BotConversationTools>
      </BotMessageReactionsProvider>
      <BotMessageFilePreview botId={bot.id} threadId={threadId} name={bot.name} client={client} />
    </>
  )
}
