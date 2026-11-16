import "./bots.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CircleAlert, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { ChatContainer, type ManagedChatTurn } from "@/components/chat/ChatContainer"
import { useAppStore } from "@/lib/store"
import { useThreadContext, useThreadStateSelector } from "@/lib/thread-context"
import { botErrorMessage } from "@/lib/bot-error-message"
import { bindBotConversationDraft, workComposerDraftRef } from "@/lib/bot-conversation-draft"
import { assertCurrentBotUserQuote, BotDraftSender, validateBotDraft } from "@/lib/bot-draft-sender"
import { botWorkClient } from "@/lib/bot-work-client"
import { getQueuedBotWorkCreationInput } from "@/lib/queued-message-content"
import { isSkillCatalogFresh, projectChatSkillCatalog, revalidateSkillCatalog } from "@/lib/app-catalog-cache"
import { findEnabledSkillSelection } from "@/lib/skill-ids"
import type { QueuedMessage } from "@/types"
import {
  BOT_REQUEST_RECEIPT_LIMIT,
  botTaskAcceptsUserInput,
  type BotDefinition,
  type BotGroup,
  type BotClient,
  type BotSchedule,
  type BotTask
} from "../../../../shared/bots/contracts"
import type { BotWorkApproval, BotWorkItem, BotWorkWorkspaceRequest } from "../../../../shared/bots/work"
import type { BotSkillSelection } from "../../../../shared/bots/skill-selection"
import { botTaskPreview } from "@/lib/bot-task-view"
import { ensureBotWorkThreadSummary, matchesBoundBotWorkThreadSummary } from "@/lib/bot/work-thread-summary"
import { BotConversationTools } from "./BotConversationTools"
import { BotMessageFilePreview } from "./BotMessageFilePreview"
import { BotMessageReactionsProvider } from "./BotMessageReactions"
import { BotWorkControl, botWorkControlColor } from "./BotWorkControl"
import { BotSkillTargetDialog } from "./BotSkillTargetDialog"
import { BotWorkQuestions } from "./BotWorkQuestions"
import type { useBotWorks } from "./use-bot-works"
const active = (task: BotTask) => task.state === "running" || task.state === "waiting_user"

export function BotConversation({
  bot,
  work,
  workRevision = 0,
  bots,
  groups = [],
  schedules,
  tasks,
  backgroundBusy,
  collaborationPending = false,
  client,
  workDirectory,
  workQuestionTasks,
  onReadyChange,
  onOpenWorkApproval,
  onConfigureModel,
  onOpenWork,
  captureWorkNavigation,
  onPreviewWork,
  onOpenRoutineDetails,
  onOpenBot,
  onOpenGroup
}: {
  bot: BotDefinition
  work?: BotWorkItem | null
  workRevision?: number
  bots: BotDefinition[]
  groups?: readonly BotGroup[]
  schedules: BotSchedule[]
  tasks: BotTask[]
  backgroundBusy: boolean
  collaborationPending?: boolean
  client: BotClient
  workDirectory?: ReturnType<typeof useBotWorks>
  workQuestionTasks?: readonly BotTask[]
  onReadyChange?(ready: boolean): void
  onOpenWorkApproval?(approval: BotWorkApproval, isCurrent: () => boolean): void | Promise<void>
  onConfigureModel?(): void
  onOpenWork(workId: string): void
  captureWorkNavigation?(): () => boolean
  onPreviewWork?(workId: string, trigger: HTMLButtonElement, title: string): void
  onOpenRoutineDetails?(): void
  onOpenBot?(botId: string): void
  onOpenGroup?(groupId: string): void
}) {
  const mentionGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          !group.deleting && group.hostId === bot.hostId && group.memberIds.includes(bot.id)
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
  const reactionIds = useMemo(
    () => JSON.parse(reactionIdsKey ?? "[]") as string[],
    [reactionIdsKey]
  )
  const [ready, setReady] = useState(false)
  useEffect(() => { onReadyChange?.(ready) }, [onReadyChange, ready])
  const [error, setError] = useState<string | null>(null)
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null)
  const [workSettingsError, setWorkSettingsError] = useState<string | null>(null)
  const [workSettingsRetry, setWorkSettingsRetry] = useState(0)
  const threadContext = useThreadContext()
  const [sendingRevision, setSendingRevision] = useState(0)
  const [controlFocusRequest, setControlFocusRequest] = useState<{ id: number; target: "composer" | "control" }>()
  const [skillDraft, setSkillDraft] = useState<{
    draft: QueuedMessage
    error?: string
    retry?: QueuedMessage["botSkillTarget"]
  } | null>(null)
  const mounted = useRef(true)
  const currentWork = useRef(work)
  currentWork.current = work
  const userOwnsComposer = Boolean(work?.userControl && !work.userControl.settling)
  const settingsWorkId = client.hostId === "local" && userOwnsComposer && work?.audienceKey === "desktop" &&
    !work.source && !work.deletionPending && !work.deletionCommitted &&
    work.conversation?.state !== "detaching" && work.conversation?.state !== "detached"
    ? work.id : undefined
  const hasBoundWorkSettings = useAppStore(state => Boolean(settingsWorkId && work &&
    state.threads.some(thread => matchesBoundBotWorkThreadSummary(thread, work))))
  const inputBlockedReason = () => {
    const target = currentWork.current
    if (!target || target.source || target.audienceKey !== "desktop") return null
    if (target.userControl?.settling) return "正在等待原任务结算，草稿已保留。"
    if (!target.userControl) return "此任务由 Bot 管理，请先获取控制权，或回主对话补充要求。"
    return null
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const queue = useMemo(() => threadContext.getThreadActions(threadId), [threadContext, threadId])
  const sender = useMemo(
    () =>
      new BotDraftSender(
        client,
        bot.id,
        queue,
        setError,
        () => setSendingRevision((revision) => revision + 1),
        Date.now,
        work ? { botId: bot.id, workId: work.id } : undefined
      ),
    [client, bot.id, queue, work?.id]
  )
  const validateSkill = useCallback(async (selection: BotSkillSelection): Promise<boolean> => {
    const catalog = await revalidateSkillCatalog(useAppStore.getState().pluginVersion).catch(() => {
      throw new Error("暂时无法核对原技能，草稿已保留，请重试。")
    })
    if (!mounted.current) return false
    if (!isSkillCatalogFresh(catalog, useAppStore.getState().pluginVersion))
      throw new Error("技能目录正在更新，草稿已保留，请稍后重试。")
    const { skills, disabledSkillIds } = projectChatSkillCatalog(catalog)
    if (!findEnabledSkillSelection(selection, skills, disabledSkillIds))
      throw new Error("原技能已不可用，草稿已保留。")
    return true
  }, [])
  const dispatchSkill = useCallback(async (draft: QueuedMessage) => {
    const target = draft.botSkillTarget
    if (!target || target.kind === "main") return sender.send(draft, validateSkill)
    if (!client.works || sender.sending.has(draft.id)) return
    const isNavigationCurrent = captureWorkNavigation?.()
    sender.sending.add(draft.id)
    setSendingRevision(value => value + 1)
    let canRetarget = !draft.handoffRequestedAt && !draft.botHandoffTarget
    try {
      if (target.kind === "work") {
        const destination = await client.works.get(bot.id, target.workId)
        if (destination.botId !== bot.id || destination.id !== target.workId || destination.audienceKey !== "desktop" || destination.source)
          throw new Error("所选任务已不可用。")
        if (canRetarget && (destination.state === "completed" || destination.deletionPending ||
            destination.deletionCommitted || destination.userControl?.settling ||
            (destination.conversation && destination.conversation.state !== "bound")))
          throw new Error("所选任务暂时无法接收消息，请选择其他位置。")
        if (canRetarget && client.works.validateSkillWorkspace) {
          if (!mounted.current || queue.getQueuedMessage(draft.id) !== draft) return
          await client.works.validateSkillWorkspace(bot.id, {
            kind: "work", workId: destination.id, threadId: destination.threadId
          })
        }
        if (!mounted.current || queue.getQueuedMessage(draft.id) !== draft) return
        canRetarget = false
        await new BotDraftSender(botWorkClient(client, destination), bot.id, queue, setError,
          () => {}, Date.now, { botId: bot.id, workId: destination.id }, bot.threadId).send(draft, validateSkill, client)
        if (mounted.current && !queue.getQueuedMessage(draft.id) && isNavigationCurrent?.() !== false)
          onOpenWork(destination.id)
        return
      }
      if (!mounted.current || queue.getQueuedMessage(draft.id) !== draft) return
      setError(null)
      const { message, inputFileIds, explicitSkill, mentions } = getQueuedBotWorkCreationInput(draft)
      if (message.length > 30_000) throw new Error("新任务的交办正文不能超过 30000 字符。")
      const workspace: BotWorkWorkspaceRequest | undefined = "projectId" in target
        ? { kind: "project", projectId: target.projectId }
        : target.path ? { kind: "directory", path: target.path } : undefined
      // Read-only check before recording a possible send. Creation still revalidates the target.
      if (canRetarget && workspace && client.works.validateSkillWorkspace) {
        await client.works.validateSkillWorkspace(bot.id, workspace)
        if (!mounted.current || queue.getQueuedMessage(draft.id) !== draft) return
      }
      // An uncertain creation must reach the Host's original receipt lookup
      // before checking current settings. Only a fresh creation is checked here.
      if (canRetarget && explicitSkill && !await validateSkill(explicitSkill)) return
      if (!mounted.current || queue.getQueuedMessage(draft.id) !== draft) return
      if (canRetarget && draft.botReplyTo?.role === "user") {
        try {
          await assertCurrentBotUserQuote(draft, bot.id, client)
        } catch (cause) {
          if (mounted.current && queue.getQueuedMessage(draft.id) === draft)
            setError(botErrorMessage(cause))
          return
        }
        if (!mounted.current || queue.getQueuedMessage(draft.id) !== draft) return
      }
      canRetarget = false
      let persistenceError: string | null = "未能保存待发送草稿。"
      queue.updateQueuedMessage(draft.id, { handoffRequestedAt: draft.handoffRequestedAt ?? new Date() },
        cause => { persistenceError = cause })
      if (persistenceError) throw new Error(persistenceError)
      const committed = queue.getQueuedMessage(draft.id)
      if (!committed) return
      const result = await client.works.create({
        botId: bot.id, operationId: draft.id, title: target.title, goal: message, inputFileIds, explicitSkill,
        ...(mentions?.length ? { mentions } : {}),
        ...(workspace ? { workspace } : {})
      })
      if (result.work.botId !== bot.id || result.task.workId !== result.work.id ||
        result.task.origin.kind !== "user" || result.task.origin.explicitSkill?.name !== explicitSkill?.name ||
        result.task.origin.explicitSkill?.path !== explicitSkill?.path ||
        (workspace?.kind === "project" && (result.work.workspace?.kind !== "project" ||
          result.work.workspace.projectId !== workspace.projectId)))
        throw new Error("任务回执与原技能草稿不一致，请核对后重试。")
      if (queue.getQueuedMessage(draft.id) === committed)
        queue.deleteQueuedMessage(draft.id, cause => { if (cause && mounted.current) setError(cause) })
      if (mounted.current && isNavigationCurrent?.() !== false) onOpenWork(result.work.id)
    } catch (cause) {
      const message = botErrorMessage(cause)
      if (canRetarget && queue.getQueuedMessage(draft.id) === draft) {
        queue.updateQueuedMessage(draft.id, { botSkillTarget: undefined }, error => {
          if (!mounted.current) return
          const current = queue.getQueuedMessage(draft.id)
          if (!error && current) {
            setSkillDraft(previous => previous ?? { draft: current, error: message, retry: target })
          } else {
            setError(error ?? message)
          }
        })
      } else if (mounted.current) {
        setError(`${message} 原草稿已保留。`)
      }
    } finally {
      sender.sending.delete(draft.id)
      if (mounted.current) setSendingRevision(value => value + 1)
    }
  }, [bot.id, bot.threadId, captureWorkNavigation, client, onOpenWork, queue, sender, validateSkill])
  const submitDraft = useCallback<NonNullable<ManagedChatTurn["submitDraft"]>>(
    async (draft) => {
      const blocked = inputBlockedReason()
      if (blocked) {
        // A lost acknowledgement can still be recovered while details are
        // read-only. Reconciliation never dispatches the retained draft.
        if (draft.handoffRequestedAt) {
          await sender.reconcile([draft])
          if (!queue.getQueuedMessage(draft.id)) return
        }
        throw new Error(blocked)
      }
      if (!draft.botExplicitSkill && draft.skillBlock?.trim() && client.hostId === "local") {
        try {
          const restored = await sender.restoreLegacySkill(draft)
          if (!restored || !mounted.current) return
          draft = restored
        } catch (cause) {
          if (mounted.current) setError(botErrorMessage(cause))
          return
        }
      }
      if (draft.botExplicitSkill && !work && workDirectory && client.hostId === "local") {
        if (!draft.botSkillTarget && !draft.handoffRequestedAt && !draft.botHandoffTarget) {
          setSkillDraft({ draft })
          return
        }
        return dispatchSkill(draft)
      }
      return sender.send(draft, client.hostId === "local" ? validateSkill : undefined)
    },
    [sender, work, workDirectory, client.hostId, dispatchSkill, validateSkill]
  )
  const chooseSkillTarget = (target: NonNullable<QueuedMessage["botSkillTarget"]>) => {
    if (!skillDraft) return
    const current = queue.getQueuedMessage(skillDraft.draft.id)
    if (current !== skillDraft.draft || current.botSkillTarget || current.handoffRequestedAt || current.botHandoffTarget) {
      setSkillDraft(null)
      return
    }
    queue.updateQueuedMessage(current.id, { botSkillTarget: target }, cause => {
      if (cause) {
        setError(cause)
        return
      }
      const committed = queue.getQueuedMessage(current.id)
      if (!committed) return
      setSkillDraft(null)
      setError(null)
      void dispatchSkill(committed)
    })
  }
  useEffect(() => {
    sender.stopPreparing()
    return () => sender.stopPreparing()
  }, [sender, work?.userControl?.settling, work?.userControl?.stopping])
  const reconcileDrafts = useCallback<NonNullable<ManagedChatTurn["reconcileDrafts"]>>(
    (drafts) => sender.reconcile(drafts),
    [sender]
  )
  const workId = work?.id
  const workDraftRef = workComposerDraftRef(client.hostId, bot.id, work)
  const draftThreadToken = workDraftRef?.incarnation.token
  const draftThreadCreatedAt = workDraftRef?.incarnation.legacyCreatedAt
  useEffect(() => {
    let disposed = false
    let unbindDraft: (() => void) | undefined
    setReady(false)
    client
      .open(bot.id)
      .then(async () => {
        await useAppStore.getState().loadThreads()
        if (!disposed && work?.conversation?.state === "bound" && client.hostId === "local") {
          await ensureBotWorkThreadSummary(threadId, () => !disposed)
        }
        if (!disposed) {
          unbindDraft = bindBotConversationDraft(
            threadContext,
            client.hostId,
            bot.id,
            threadId,
            (message) => {
              if (!disposed) setDraftStorageError(message)
            },
            workId,
            draftThreadCreatedAt === undefined ? undefined : {
              kind: "local_thread", threadId,
              incarnation: { token: draftThreadToken ?? null, legacyCreatedAt: draftThreadCreatedAt }
            }
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
  }, [bot.id, threadId, bot.modelRef, client, threadContext, workId, draftThreadToken, draftThreadCreatedAt])
  const refreshWorks = workDirectory?.refresh
  useEffect(() => {
    if (!ready || !settingsWorkId || hasBoundWorkSettings) return
    const target = currentWork.current
    if (!target || target.id !== settingsWorkId || target.threadId !== threadId) return
    let disposed = false
    const isCurrent = () => {
      const latest = currentWork.current
      return !disposed && latest?.id === settingsWorkId && latest.threadId === threadId &&
        Boolean(latest.userControl && !latest.userControl.settling) &&
        !latest.deletionPending && !latest.deletionCommitted &&
        latest.conversation?.state !== "detaching" && latest.conversation?.state !== "detached"
    }
    setWorkSettingsError(null)
    void (async () => {
      // Native work already owns this thread. Bind it through the existing
      // workbench entrance only after takeover, without navigating or remounting.
      const bound = target.conversation?.state === "bound" ? target :
        await client.conversations?.expose(bot.id, settingsWorkId)
      if (!isCurrent()) return
      if (!bound || bound.id !== settingsWorkId || bound.botId !== bot.id ||
          bound.threadId !== threadId || bound.conversation?.state !== "bound")
        throw new Error("原任务关联不可用，无法加载设置。")
      await ensureBotWorkThreadSummary(threadId, isCurrent, thread => matchesBoundBotWorkThreadSummary(thread, bound))
      if (isCurrent() && target.conversation?.state !== "bound") await refreshWorks?.()
    })().catch(cause => {
      if (isCurrent()) setWorkSettingsError(botErrorMessage(cause, "无法加载任务设置。"))
    })
    return () => { disposed = true }
  }, [ready, settingsWorkId, hasBoundWorkSettings, workSettingsRetry, client, bot.id, threadId, refreshWorks])
  // Private review and publication use the main thread's lease, while their
  // controls belong to the originating work card.
  const conversationTasks = workId ? tasks : tasks.filter(task =>
    task.origin.kind !== "work_result" || !task.origin.review)
  const running = conversationTasks.find(active)
  const queued = conversationTasks.filter((task) => task.state === "queued")
  const submit = useCallback<ManagedChatTurn["submit"]>(
    async (input, options) => {
      const messages = input?.messages
      const message = Array.isArray(messages) && messages.length === 1 ? messages[0]?.content : null
      if (typeof message !== "string" || !message.trim() || options?.command) {
        setError("此请求不能作为 Bot 消息发送，请从当前审批卡片操作。")
        return
      }
      const blocked = inputBlockedReason()
      if (blocked) throw new Error(blocked)
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
  const cancelConversation = useCallback(async () => {
    sender.stopPreparing()
    await client.stopConversation(bot.id, undefined, workId, workId ? undefined : "background")
  }, [sender, client, bot.id, workId])
  const cancel = useCallback(async () => {
    if (running) {
      sender.stopPreparing()
      await client.cancel(running.id)
      return
    }
    if ((!workId || userOwnsComposer) && backgroundBusy) {
      try {
        await client.stopConversation(bot.id, undefined, workId, "background")
      } catch (cause) {
        toast.error(botErrorMessage(cause, "停止后台活动失败，请重试"))
      }
      return
    }
    if (workId) return cancelConversation()
    throw new Error("任务状态已变化，请根据当前状态重试")
  }, [sender, client, bot.id, workId, userOwnsComposer, running, backgroundBusy, cancelConversation])
  const managedTurn = useMemo<ManagedChatTurn>(
    () => ({
      ...(work?.source && work.source.transport !== "im"
        ? { textOnlyReason: "模拟渠道仅支持文字和同受众工作，不支持附件、技能或本机资源。" }
        : {}),
      ownerConversation: work?.conversation?.state === "bound" && (!userOwnsComposer || hasBoundWorkSettings),
      ...(work && !work.source ? {
        composerHeader: <BotWorkControl key={work.id} bot={bot} work={work} client={client} onOpenBot={onOpenBot}
          beforeChange={() => sender.stopPreparing()}
          onControlChanged={changed => setControlFocusRequest(previous => ({
            id: (previous?.id ?? 0) + 1, target: changed.userControl ? "composer" : "control"
          }))} />,
        controlFocusRequest,
        composerReadOnlyReason: inputBlockedReason() ?? undefined,
        userOwnsComposer,
        showReadOnlyStop: Boolean(running),
        controlColor: botWorkControlColor(bot.color)
      } : {}),
      ...(!work
        ? {
            mentionOptions: {
              bots: bots.filter(
                (peer) =>
                  peer.hostId === bot.hostId &&
                  peer.id !== bot.id &&
                  !peer.archived &&
                  !peer.deleting
              ),
              groups: mentionGroups
            }
          }
        : {}),
      submit,
      submitDraft,
      validateDraft: draft => inputBlockedReason() ?? validateBotDraft(draft),
      reconcileDrafts,
      sendingDraftIds: sender.sending,
      maxPendingDrafts: BOT_REQUEST_RECEIPT_LIMIT,
      draftReceiptRevision: tasks
        .map((task) => `${task.id}:${task.updatedAt}:${task.state}`)
        .join("|"),
      attachFiles: (maxFiles, maxChars) => client.attachFiles(bot.id, maxFiles, maxChars),
      attachFileBytes: (files, maxChars) => client.attachFileBytes(bot.id, files, maxChars),
      ...(client.hostId === "local" && !work?.source && client.attachWorkspaceFile ? {
        attachWorkspaceFile: (fileId: string, maxChars: number) =>
          client.attachWorkspaceFile!(bot.id, threadId, fileId, maxChars)
      } : {}),
      cancel,
      ...(work?.conversation?.state === "bound" ? {} : { configureModel: onConfigureModel }),
      busy: Boolean(running) || backgroundBusy,
      ...((!workId || userOwnsComposer) && !running && backgroundBusy ? { stopLabel: "停止后台活动" } : {}),
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
      userOwnsComposer,
      hasBoundWorkSettings,
      sender,
      sendingRevision,
      controlFocusRequest,
      tasks,
      cancel,
      running,
      backgroundBusy,
      bot.id,
      bot.name,
      bot.color,
      bot.shape,
      bot.archived,
      bot.deleting,
      threadId,
      client,
      onConfigureModel,
      onOpenBot
    ]
  )
  const workReactionsReadOnly = Boolean(managedTurn.composerReadOnlyReason)
  if (!ready)
    return (
      <div className="bot-empty">
        {error ? <p role="alert">{error}</p> : <Loader2 className="size-5 animate-spin" />}
      </div>
    )
  return (
    <>
      {workQuestionTasks && (
        <BotWorkQuestions client={client} botId={bot.id} tasks={workQuestionTasks} onOpenApproval={onOpenWorkApproval} />
      )}
      {skillDraft?.draft.botExplicitSkill && workDirectory && (
        <BotSkillTargetDialog key={skillDraft.draft.id} skill={skillDraft.draft.botExplicitSkill.name} directory={workDirectory}
          error={skillDraft.error} retry={skillDraft.retry}
          close={() => setSkillDraft(null)} choose={chooseSkillTarget} />
      )}
      {draftStorageError && (
        <div role="alert" className="bot-notice">
          {draftStorageError}
        </div>
      )}
      {settingsWorkId && !hasBoundWorkSettings && workSettingsError && (
        <div role="alert" className="bot-notice">
          <CircleAlert size={15} />
          <span>{workSettingsError}</span>
          <button type="button" onClick={() => setWorkSettingsRetry(value => value + 1)}>重试任务设置</button>
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
      {collaborationPending && !running && !backgroundBusy && (
        <div className="bot-queue">
          <span>协作任务仍在进行</span>
          <button onClick={() => void cancelConversation().catch((cause) => toast.error(botErrorMessage(cause)))}>
            停止协作
          </button>
        </div>
      )}
      {queued.length > 1 && work?.userControl?.heldInputs ? (
        <details className="bot-queue bot-held-queue">
          <summary>{queued.length} 条待办 · {work.userControl.heldInputs} 条等待归还</summary>
          {queued.map((task) => (
            <div key={task.id} className="bot-held-queue-row">
              <span className="truncate">{botTaskPreview(task)}</span>
              <button onClick={() => void client.cancel(task.id).catch((cause) => toast.error(botErrorMessage(cause)))}>
                撤回
              </button>
            </div>
          ))}
        </details>
      ) : queued.length > 0 && (
        <div className="bot-queue" aria-live="polite">
          <span>{queued.length} 条待办{work?.userControl?.heldInputs ? ` · ${work.userControl.heldInputs} 条等待归还` : ""}</span>
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
      <BotMessageReactionsProvider
        client={client}
        target={{ kind: "bot", botId: bot.id, ...(work ? { workId: work.id } : {}) }}
        messageIds={reactionIds}
        enabled={!work?.source}
        readOnly={workReactionsReadOnly}
        refreshKey={`${running?.id ?? ""}:${running?.state ?? "idle"}:${workReactionsReadOnly}`}
      >
        <BotConversationTools
          client={client}
          botId={bot.id}
          conversationThreadId={threadId}
          desktopWorkId={work && !work.source && work.audienceKey === "desktop" ? work.id : undefined}
          workRevision={workRevision}
          onOpenWork={onOpenWork}
          onPreviewWork={onPreviewWork}
          onOpenRoutineDetails={onOpenRoutineDetails}
          onOpenBot={onOpenBot}
          onOpenGroup={onOpenGroup}
          groups={mentionGroups}
          tasks={tasks}
          bots={bots}
          schedules={schedules.filter(
            (item) => (item.audienceKey ?? "desktop") === (work?.audienceKey ?? "desktop")
          )}
        >
          <ChatContainer
            threadId={threadId}
            surface="bot"
            managedTurn={managedTurn}
            readOnlyReason={
              bot.archived
                ? "Bot 已归档，恢复后可以继续对话。"
                : work?.state === "completed"
                  ? "任务已完成。打开任务菜单，选择「继续处理」。"
                  : null
            }
          />
        </BotConversationTools>
      </BotMessageReactionsProvider>
      <BotMessageFilePreview botId={bot.id} threadId={threadId} name={bot.name} client={client} />
    </>
  )
}
