import { BotRoutineOutcome } from "./BotRoutineOutcome"
import { routineOutcomeIntent } from "@/lib/bot-routine-outcome-intent"
import { readBotUserForm, hasBotUserFormMarker } from "../../../../shared/bot-user-form"
import { readBotComputerHelp } from "../../../../shared/bot-computer-help"
import { BotComputerHelp, BotComputerHelpViewer, type BotComputerHelpView } from "./BotComputerHelp"
import type { BotTeachArm } from "../../../../shared/bot-teach"
import { BotMessageLinkPreview } from "./BotLinkPreviewCard"
import { useBotLinkPreviews } from "@/lib/use-bot-link-previews"
import "./bot-link-preview.css"
import { BotEntityReferences } from "./BotEntityReferences"
import { captureBotMessageQuote, currentBotMessageQuote } from "@/lib/bot-selection-quote"
import type { BotPromptControls } from "./BotPromptEditor"
import { BotMessageText } from "./BotMessageText"
import { useBotUserBubbleTint } from "@/lib/use-bot-user-bubble-tint"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import { BotErrorTrayStack } from "./BotErrorTrayStack"
import { reportBotError } from "@/lib/bot-error-toast"
import { messageInlineReferenceKeys } from "@/lib/bot-message-inline-references"
import { botInlineReferenceIdentity } from "../../../../shared/bot-inline-references"
import { BotMessageTime } from "./BotMessageTime"
import { BotTranscriptList } from "./BotTranscriptList"
import type { VirtuosoHandle, FlatIndexLocationWithAlign } from "react-virtuoso"
import { assertBotPendingWorkCard } from "@/lib/bot-pending-work-card"
import { useBotTrackedWork } from "@/lib/use-bot-tracked-work"
import type { BotPendingWork, BotPendingCard } from "../../../../shared/bot-work-pages"
import { botApi } from "@/lib/bot-api"
import { BotEditor } from "./BotEditor"
import { BotConversationRowActions } from "./BotConversationRowActions"
import { BotHiddenConversations } from "./BotHiddenConversations"
import { projectBotSidebar } from "@/lib/bot-sidebar-projection"
import { BotQuickCreateFeedback } from "./BotQuickCreateFeedback"
import { useBotQuickCreate } from "@/lib/use-bot-quick-create"
import { BotGroupEditor } from "./BotGroupEditor"
import { BotNewChat } from "./BotNewChat"
import { BotNewChatComposer } from "./BotNewChatComposer"
import { BotNewChatGroup } from "./BotNewChatGroup"
import { BOT_SINGLE_BOT_ROOM_CAPABILITY } from "../../../../shared/bot-groups"
import type { BotGroupSaveRequest } from "@/lib/use-bot-group-save"
import type { BotQuickCreateSelectionContinuation } from "@/lib/bot-quick-create"
import type { BotAttachmentPickerHandle } from "@/lib/use-bot-composer-files"
import {
  adoptNewChatDraft,
  newChatSessionCurrent,
  newChatHasContent,
  type NewChatLocalSession
} from "@/lib/bot-new-chat-draft"
import { BotPluginPanes } from "./BotPluginPanes"
import { BotWorkspaceMenu } from "./BotWorkspaceMenu"
import { BotRecoveryRecords } from "./BotRecoveryRecords"
import { BotUsageBudget } from "./BotUsageBudget"
import { BotResources, type BotResourcePresentation } from "./BotResources"
import type { BotRoutineOpenIntent } from "@/lib/bot-routine-toggle"
import { BotContextImport, BotImportedContext } from "./BotContextImport"
import { botSteeringLabels } from "@/lib/bot-steering"
import { BotSkillTrialMessage } from "./BotSkillTrialMessage"
import { BotSecrets } from "./BotSecrets"
import { BotBackups } from "./BotBackups"
import { BotDownloads } from "./BotDownloads"
import { botArtifactDownloadClient, downloadBotFile } from "@/lib/bot-file-download"
import { BotWorkspaceMaintenance } from "./BotWorkspaceMaintenance"
import { BotBrowserMaintenance } from "./BotBrowserMaintenance"
import { BotComputerCheckpoints } from "./BotComputerCheckpoints"
import { BotStorage } from "./BotStorage"
import { BotQuestions, BotUserForm } from "./BotQuestions"
import { BotReactions } from "./BotReactions"
import { BotReplyQuote } from "./BotReply"
import { BotSearchDialog, type BotSearchOpenContext } from "./BotSearch"
import { BotCommandPalette } from "./BotCommandPalette"
import type { BotPaletteCommand } from "@/lib/bot-command-palette"
import { BotKeyboardHelp } from "./BotKeyboardHelp"
import { BotHelp } from "./BotHelp"
import { BotFirstTask, BotWelcome } from "./BotWelcome"
import { botShortcutActions, resolveBotWorkspaceShortcut } from "@/lib/bot-keyboard"
import { resolveAdjacentAgentId } from "./upstream/grok-keyboard-shortcuts"
import { botThreadView, botViewAddress } from "@/lib/bot-thread-view"
import { botMessageLink } from "../../../../shared/bot-deep-link"
import type { BotSearchMatch } from "../../../../shared/bot-search"
import type { BotSkillReference } from "../../../../shared/bot-skill-references"
import { readBotQuestions } from "../../../../shared/bot-questions"
import { BotIntroductionQuestion } from "./BotIntroductionQuestion"
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import {
  Plus,
  Search,
  X,
  Pin,
  AlertCircle,
  RefreshCw,
  Reply,
  GitBranch,
  ArrowLeft,
  Link2,
  Copy,
  Activity,
  HardDrive,
  Plug,
  Settings2,
  ShieldCheck,
  Star,
  PanelLeftClose,
  PanelLeftOpen
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotPinnedOrder } from "@/lib/use-bot-pinned-order"
import { resolveRootShellNavigation } from "./upstream/grok-navigation-history"
import type {
  BotConversation,
  BotInteraction,
  BotMessage,
  BotRun,
  BotCloneInput,
  CoworkBot
} from "../../../../shared/bot-types"
import { SidebarAgentStatusView, projectSidebarAgentStatus } from "./upstream/grok-sidebar-status"
import { grokTextPreview } from "./upstream/grok-text-preview"
import { BotInspector, type BotInspectorTab } from "./BotInspector"
import {
  botInspectorPreferences,
  botInspectorPreferenceScope,
  resolveBotInspectorPreference,
  type BotInspectorPreferences
} from "@/lib/bot-inspector-preferences"
import { BotGroupInspector } from "./BotGroupInspector"
import { BotAvatar } from "./BotAvatar"
import { BotMessageAuthor } from "./BotMessageAuthor"
import { botPersonaState } from "@/lib/bot-persona-state"
import { BotComposer } from "./BotComposer"
import { BotActions } from "./BotActions"
import { BotPrimarySettings } from "./BotPrimarySettings"
import { BotNotificationAction } from "./BotNotificationAction"
import { BotApprovalContent } from "./BotApprovalContent"
import { BotApprovalRules } from "./BotApprovalRules"
import { BotLocalToolPermissionCard } from "./BotLocalToolPermissionCard"
import { BotLocalToolPermissionSettings } from "./BotLocalToolPermissionSettings"
import { BotApprovalActions } from "./BotApprovalActions"
import "./bot-workspace.css"
import { BotPeerExchange, BotPeerExchangeLinks } from "./BotPeerExchange"
import {
  BotPeerExchangeReadQueueContext,
  createBotPeerExchangeReadQueue
} from "@/lib/bot-peer-exchange-read-queue"
import { botPeerExchangeKey, type BotPeerExchangeLink } from "../../../../shared/bot-peer-exchange"
import { BotPeerExchangeHeader } from "./BotPeerImages"
import { BotMessageAttachments } from "./BotMessageAttachments"
import type { BotMessageAttachment } from "../../../../shared/bot-message-attachments"
import type { BotPeerMessageImage } from "../../../../shared/bot-peer-images"
import { BotFiles } from "./BotFiles"
import { BotFilePreview } from "./BotFilePreview"
import { readBotSecretCard } from "../../../../shared/bot-secrets"
import { BotSecretInput } from "./BotSecretInput"
import { BotRecovery } from "./BotRecovery"
import { BotAsyncTasks } from "./BotAsyncTasks"
import { BotConversationTasks } from "./BotConversationTasks"
import { BotAvatarEditor } from "./BotAvatarEditor"
import { BotRunHistory } from "./BotRunHistory"
import type { BotRunAddress } from "../../../../shared/bot-run-history"
import { BotMessageMarkdown as StreamingMarkdown } from "./BotMessageMarkdown"
import { useBotReadPosition } from "@/lib/use-bot-read-position"
import { useBotTranscriptScroll } from "@/lib/use-bot-transcript-scroll"
import { BotViewVisibilityContext, useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { isBotPluginGrant } from "@/lib/bot-approval"

const emptyMessages: BotMessage[] = []

const statusLabel: Record<BotRun["status"], string> = {
  queued: "排队中",
  running: "工作中",
  waiting_input: "等待你处理",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  needs_review: "需要核对现场"
}
const report = reportBotError

/** List descriptors never become answer payloads. Only the exact current full
 * typed card is mounted, and a tracked identity keeps a page-outside card live. */
function PendingWorkCard({
  descriptor,
  refresh,
  openComputerHelp
}: {
  descriptor: BotPendingWork
  refresh(): Promise<void>
  openComputerHelp(view: BotComputerHelpView): void
}) {
  const { conversationId, threadRootId, runId } = descriptor.address
  const [expiryTick, setExpiryTick] = useState(() => Date.now())
  useEffect(() => {
    if (descriptor.status !== "pending") return
    const timer = setTimeout(
      () => setExpiryTick(Date.now()),
      Math.max(0, Math.min(descriptor.expiresAt - Date.now(), 2_147_483_647))
    )
    return () => clearTimeout(timer)
  }, [descriptor.status, descriptor.expiresAt])
  const hostId = useBotWorkspaceStore((state) => state.host?.hostId)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const tracked = useBotTrackedWork({
    kind: "interaction",
    conversationId,
    threadRootId,
    runId,
    interactionId: descriptor.id
  })
  const key = JSON.stringify([
    hostId,
    dataEpoch,
    conversationId,
    threadRootId,
    runId,
    descriptor.id,
    descriptor.revision,
    descriptor.runRevision,
    descriptor.runFence
  ])
  const [loaded, setLoaded] = useState<{ key: string; card: BotPendingCard }>()
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    if (
      !hostId ||
      !dataEpoch ||
      descriptor.status !== "pending" ||
      descriptor.expiresAt <= Date.now()
    )
      return
    void botApi
      .pendingCard({
        hostId,
        dataEpoch,
        conversationId,
        threadRootId,
        runId,
        interactionId: descriptor.id,
        revision: descriptor.revision
      })
      .then((card) => {
        const current = useBotWorkspaceStore.getState()
        if (!active || current.host?.hostId !== hostId || current.snapshot?.dataEpoch !== dataEpoch)
          return
        assertBotPendingWorkCard(
          card,
          {
            id: descriptor.id,
            revision: descriptor.revision,
            kind: descriptor.kind,
            status: descriptor.status,
            createdAt: descriptor.createdAt,
            expiresAt: descriptor.expiresAt,
            botId: descriptor.botId,
            address: { conversationId, threadRootId, runId },
            runRevision: descriptor.runRevision,
            runFence: descriptor.runFence
          },
          { hostId, dataEpoch }
        )
        setLoaded({ key, card })
        setFailure(undefined)
      })
      .catch((error) => {
        if (active)
          setFailure({
            key,
            message: error instanceof Error ? error.message : "待处理事项读取失败"
          })
      })
    return () => {
      active = false
    }
  }, [
    hostId,
    dataEpoch,
    conversationId,
    threadRootId,
    runId,
    descriptor.id,
    descriptor.revision,
    descriptor.kind,
    descriptor.createdAt,
    descriptor.botId,
    descriptor.runRevision,
    descriptor.runFence,
    descriptor.status,
    descriptor.expiresAt,
    key,
    retry
  ])
  const card = loaded?.key === key ? loaded.card : undefined
  const live = tracked.value?.interaction
  if (descriptor.status === "expired" || descriptor.expiresAt <= expiryTick)
    return (
      <p
        role="status"
        className="rounded-xl border border-border/60 px-4 py-3 text-xs text-muted-foreground"
      >
        此请求已结束或过期。刷新后查看最新进展。
      </p>
    )
  // The tracked projection contains pending items only. Authoritative absence
  // also follows an answer or cancellation, so retire this stale list card.
  if (tracked.value && !live) return null
  if (
    live &&
    (live.revision !== descriptor.revision ||
      live.runFence !== descriptor.runFence ||
      live.status !== "pending")
  )
    return (
      <p role="status" className="text-xs text-muted-foreground">
        此请求已变化，请刷新。
      </p>
    )
  if (card && live)
    return (
      <InteractionCard
        item={card.interaction}
        run={card.run}
        refresh={refresh}
        openComputerHelp={openComputerHelp}
      />
    )
  const error = failure?.key === key ? failure.message : tracked.error
  return (
    <div
      className="rounded-xl border border-border/60 px-4 py-3 text-xs text-muted-foreground"
      role={error ? "alert" : "status"}
    >
      {error ?? "正在读取待处理事项…"}
      {error && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRetry((value) => value + 1)
            void useBotWorkspaceStore.getState().refreshWorkPages()
          }}
        >
          重试
        </Button>
      )}
    </div>
  )
}
function PendingWorkCards({
  descriptors,
  total,
  refresh,
  openComputerHelp
}: {
  descriptors: BotPendingWork[]
  total: number
  refresh(): Promise<void>
  openComputerHelp(view: BotComputerHelpView): void
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const page = useBotWorkspaceStore((state) => state.pendingPage)
  useEffect(() => {
    useBotWorkspaceStore.getState().setWorkPageOpen("pending", open)
    return () => useBotWorkspaceStore.getState().setWorkPageOpen("pending", false)
  }, [open])
  const move = (direction: "next" | "previous" | "first") => {
    setExpanded(null)
    useBotWorkspaceStore.getState().navigateWorkPage("pending", direction)
  }
  const selected = page.items.find((item) => item.id === expanded)
  return (
    <section className="space-y-3" aria-label="待处理事项">
      {descriptors.slice(0, 4).map((descriptor) => (
        <PendingWorkCard
          key={descriptor.id}
          descriptor={descriptor}
          refresh={refresh}
          openComputerHelp={openComputerHelp}
        />
      ))}
      {total > descriptors.length && (
        <Button size="sm" variant="ghost" className="w-full" onClick={() => setOpen(true)}>
          查看全部待处理事项 · {total}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setExpanded(null)
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>待处理事项</DialogTitle>
            <DialogDescription>
              共 {page.counts?.pending ?? total} 项 · 第 {page.pageIndex + 1} 页
            </DialogDescription>
          </DialogHeader>
          {page.loading && (
            <p role="status" className="text-xs text-muted-foreground">
              正在读取…
            </p>
          )}
          {page.error && (
            <p role="alert" className="text-xs text-destructive">
              {page.error}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void useBotWorkspaceStore.getState().refreshWorkPages()}
              >
                重试
              </Button>
            </p>
          )}
          <div className="min-h-0 space-y-3 overflow-y-auto">
            {page.items.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className="h-auto w-full justify-between rounded-xl border border-border/60 px-4 py-3 text-left"
                disabled={item.status === "expired"}
                onClick={() => setExpanded(item.id)}
              >
                <span>{item.kind === "approval" ? "需要授权" : "需要你处理"}</span>
                <span className="text-xs text-muted-foreground">
                  {item.status === "expired" ? "已过期" : expanded === item.id ? "已展开" : "查看"}
                </span>
              </Button>
            ))}
            {selected && (
              <PendingWorkCard
                key={selected.id}
                descriptor={selected}
                refresh={refresh}
                openComputerHelp={openComputerHelp}
              />
            )}
          </div>
          <div className="flex justify-between border-t border-border/60 pt-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={!page.canPrevious || page.loading}
              onClick={() => move("previous")}
            >
              上一页
            </Button>
            {page.pageIndex > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={page.loading}
                onClick={() => move("first")}
              >
                回到第一页
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!page.canNext || page.loading}
              onClick={() => move("next")}
            >
              下一页
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function InteractionCard({
  item,
  run,
  refresh,
  openComputerHelp
}: {
  item: BotInteraction
  run?: BotRun
  refresh(): Promise<void>
  openComputerHelp(view: BotComputerHelpView): void
}) {
  const [full, setFull] = useState<{
    id: string
    revision: number
    prompt: string
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setFull(null)
    setError(null)
    setLoading(false)
    return () => {
      generation.current = current + 1
    }
  }, [item.id, item.revision])
  if (item.localProjectAccess)
    return <BotLocalToolPermissionCard key={item.id} item={item} run={run} refresh={refresh} />
  if (!item.promptTruncated || (full?.id === item.id && full.revision === item.revision))
    return (
      <InteractionBody
        item={
          item.promptTruncated ? { ...item, prompt: full!.prompt, promptTruncated: false } : item
        }
        refresh={refresh}
        run={run}
        openComputerHelp={openComputerHelp}
        expanded={Boolean(item.promptTruncated)}
      />
    )
  const load = async () => {
    if (loading || !run) return
    const current = generation.current
    setLoading(true)
    setError(null)
    try {
      const detail = await botApi.interactionDetail({
        conversationId: run.conversationId,
        runId: run.id,
        ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
        interactionId: item.id
      })
      if (current !== generation.current) return
      if (detail.interaction.status !== "pending") {
        await refresh()
        return
      }
      if (detail.secret) throw new Error("凭据请求不能以普通审批方式加载")
      setFull({
        id: item.id,
        revision: item.revision,
        prompt: detail.interaction.prompt
      })
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : "加载审批内容失败")
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }
  return (
    <section
      className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
      aria-label="操作审批"
    >
      <p className="text-sm font-medium">需要你的批准</p>
      <p className="text-sm text-muted-foreground">操作内容较长，请查看完整内容后确认。</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button size="sm" variant="outline" disabled={loading || !run} onClick={() => void load()}>
        {loading ? "正在加载…" : "查看完整操作"}
      </Button>
    </section>
  )
}

function InteractionBody({
  item,
  run,
  refresh,
  expanded,
  openComputerHelp
}: {
  item: BotInteraction
  run?: BotRun
  refresh(): Promise<void>
  expanded?: boolean
  openComputerHelp(view: BotComputerHelpView): void
}) {
  const denyRules = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("approval-deny-rules") ?? false
  )
  const card = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (expanded) card.current?.scrollIntoView({ block: "nearest" })
  }, [item.id, expanded])
  useEffect(() => {
    const node = card.current
    if (!node) return
    const reveal = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.open)
        node.scrollIntoView({ block: "nearest" })
    }
    node.addEventListener("toggle", reveal, true)
    return () => node.removeEventListener("toggle", reveal, true)
  }, [item.id])
  const [answer, setAnswer] = useState(""),
    [busy, setBusy] = useState(false)
  const secret = item.kind === "approval" ? readBotSecretCard(item.prompt) : null
  const questions = item.kind === "question" ? readBotQuestions(item.prompt) : null
  const form = item.kind === "question" ? readBotUserForm(item.prompt) : null
  const help = item.kind === "question" ? readBotComputerHelp(item.prompt) : null
  const submitting = useRef(false)
  const submit = async (value: string, remember = false) => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      await botApi.answer({
        id: item.id,
        revision: item.revision,
        answer: value,
        ...(remember ? { remember: true } : {})
      })
      await refresh()
    } catch (error) {
      report(error)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  if (hasBotUserFormMarker(item.prompt))
    return form && run ? (
      <BotUserForm
        item={item}
        card={form}
        refresh={refresh}
        address={{
          conversationId: run.conversationId,
          runId: run.id,
          ...(run.threadRootId ? { threadRootId: run.threadRootId } : {})
        }}
      />
    ) : (
      <p role="alert" className="rounded-xl border p-4 text-sm text-muted-foreground">
        表单格式或所属任务不可用，请核对原请求。
      </p>
    )
  if (help)
    return <BotComputerHelp item={item} card={help} refresh={refresh} open={openComputerHelp} />
  if (secret) return <BotSecretInput item={item} card={secret} refresh={refresh} />
  if (questions) return <BotQuestions item={item} questions={questions} refresh={refresh} />
  return (
    <section
      ref={card}
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
      aria-label={item.kind === "approval" ? "操作审批" : "待回答问题"}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <AlertCircle size={16} />
        {item.kind === "approval" ? "需要你的批准" : "需要补充信息"}
      </div>
      {item.kind === "approval" ? (
        <BotApprovalContent prompt={item.prompt} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{item.prompt}</p>
      )}
      {(item.review?.canRemember || (denyRules && item.review?.canDeny)) && (
        <p className="mt-3 text-xs text-muted-foreground">
          长期规则仅适用于此 Bot 在原项目执行相同命令和参数，可在审批规则中修改。
        </p>
      )}
      {item.autoReview && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          独立审核：{item.autoReview.reason}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {item.kind === "approval" ? (
          <BotApprovalActions
            busy={busy}
            pluginGrant={isBotPluginGrant(item.prompt)}
            canRemember={item.review?.canRemember ?? false}
            canDeny={denyRules && !!item.review?.canDeny}
            submit={(value, remember) => void submit(value, remember)}
          />
        ) : (
          <>
            <Input
              aria-label="回答"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => void submit(answer)}>
              提交
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

export function BotWorkspace() {
  const epoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [peerReads] = useState(createBotPeerExchangeReadQueue)
  return (
    <BotPeerExchangeReadQueueContext.Provider value={peerReads}>
      <BotWorkspaceContent key={epoch} />
    </BotPeerExchangeReadQueueContext.Provider>
  )
}

const botLinkPreviewTransport = () => window.api.botLinkPreviews
const openBotPreviewLink = (url: string) => window.electron.openExternal(url)

function BotWorkspaceContent() {
  const state = useBotWorkspaceStore()
  const documentVisible = useBotViewVisibility()
  const linkPreviews = useBotLinkPreviews(
    window.api?.botLinkPreviews ? botLinkPreviewTransport : undefined
  )
  const refreshInFlight = useRef(false)
  const workspace = useRef<HTMLDivElement>(null)
  const quoteInput = useRef<BotPromptControls>(null)
  const composerFocusRequested = useRef(false)
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showPrimarySettings, setShowPrimarySettings] = useState(false)
  const [primarySettingsInitialMode, setPrimarySettingsInitialMode] = useState<
    "guide" | "choose" | "create"
  >("guide")
  const [searchScope, setSearchScope] = useState<"workspace" | "conversation" | "bots">("workspace")
  const [showBackups, setShowBackups] = useState(false)
  const [showDownloads, setShowDownloads] = useState(false)
  const [showUsageBudget, setShowUsageBudget] = useState(false)
  const [showWorkspaceMaintenance, setShowWorkspaceMaintenance] = useState(false)
  const [showBrowserMaintenance, setShowBrowserMaintenance] = useState(false)
  const [showComputerCheckpoints, setShowComputerCheckpoints] = useState(false)
  const [showLocalToolPermission, setShowLocalToolPermission] = useState(false)
  const [rulesBot, setRulesBot] = useState<{ id: string; name: string } | null>(null)
  const [showStorage, setShowStorage] = useState(false)
  const [query, setQuery] = useState(""),
    [showHidden, setShowHidden] = useState(false)
  const [showSidebarFilter, setShowSidebarFilter] = useState(false)
  const sidebarFilterInput = useRef<HTMLInputElement>(null)
  const sidebarFilterFocus = useRef(false)
  const paletteTrigger = useRef<HTMLButtonElement>(null)
  const [editor, setEditor] = useState<CoworkBot | "new" | null>(null),
    [groupEditor, setGroupEditor] = useState<"new" | BotConversation | null>(null)
  const [resource, setResourceState] = useState<"memory" | "skills" | "routines" | null>(null)
  const [resourceBotId, setResourceBotId] = useState<string | null>(null)
  const [routineIntent, setRoutineIntent] = useState<BotRoutineOpenIntent | undefined>()
  const [referencedSkill, setReferencedSkill] = useState<BotSkillReference | undefined>()
  const resourceSession = useRef(0)
  const routineReturnFocus = useRef<{
    node: HTMLElement | null
    epoch: string
  } | null>(null)
  const [resourceSessionId, setResourceSessionId] = useState(0)
  const resourcePresentationRef = useRef<BotResourcePresentation>({
    busy: false,
    modal: false
  })
  const [resourcePresentation, setResourcePresentation] = useState<BotResourcePresentation>({
    busy: false,
    modal: false
  })
  const onResourcePresentationChange = useCallback(
    (value: BotResourcePresentation) => {
      if (resourceSession.current !== resourceSessionId) return
      resourcePresentationRef.current = value
      setResourcePresentation((previous) =>
        previous.busy === value.busy && previous.modal === value.modal ? previous : value
      )
    },
    [resourceSessionId]
  )
  const setResource = useCallback(
    (value: "memory" | "skills" | "routines" | null, botId?: string): boolean => {
      if (resourcePresentationRef.current.busy || resourcePresentationRef.current.modal)
        return false
      setResourceSessionId(++resourceSession.current)
      resourcePresentationRef.current = { busy: false, modal: false }
      setResourcePresentation({ busy: false, modal: false })
      setRoutineIntent(undefined)
      setResourceState(value)
      setResourceBotId(botId ?? null)
      setReferencedSkill(undefined)
      return true
    },
    []
  )
  const [importBot, setImportBot] = useState<CoworkBot | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [compactSidebar, setCompactSidebar] = useState(() => {
    try {
      return localStorage.getItem("bot-sidebar-compact") === "true"
    } catch {
      return false
    }
  })
  const toggleSidebar = () => {
    const next = !compactSidebar
    setCompactSidebar(next)
    try {
      localStorage.setItem("bot-sidebar-compact", String(next))
    } catch {
      /* Retain the live layout when storage is unavailable. */
    }
  }
  const openSidebarFilter = () => {
    sidebarFilterFocus.current = true
    if (compactSidebar) toggleSidebar()
    setShowSidebarFilter(true)
  }
  const closeSidebarFilter = () => {
    sidebarFilterFocus.current = false
    setQuery("")
    setShowSidebarFilter(false)
    paletteTrigger.current?.focus()
  }
  useLayoutEffect(() => {
    if (!showPalette && sidebarFilterFocus.current && sidebarFilterInput.current) {
      sidebarFilterFocus.current = false
      sidebarFilterInput.current.focus()
    }
  }, [showSidebarFilter, showPalette, compactSidebar])
  const [resourceFocus, setResourceFocus] = useState<string | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<
    (CoworkBot & { expectedDataEpoch: string }) | null
  >(null)
  const requestDelete = (target: CoworkBot) => {
    if (!state.host?.capabilities?.includes("bot-delete-epoch")) {
      report(new Error("请先重启最新后台，再删除 Bot。"))
      return
    }
    const expectedDataEpoch = state.snapshot?.dataEpoch ?? "initial"
    if ((useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") !== expectedDataEpoch)
      return
    setDeleteTarget({ ...target, expectedDataEpoch })
  }
  const newChatTrigger = useRef<HTMLButtonElement>(null)
  const newChatInput = useRef<HTMLInputElement>(null)
  const [newChat, updateNewChat] = useState<NewChatLocalSession | null>(null)
  const newChatOwner = useRef<NewChatLocalSession | null>(null)
  const [newChatMessageFocused, setNewChatMessageFocused] = useState(false)
  const setNewChat = (next: NewChatLocalSession | null) => {
    newChatOwner.current = next
    updateNewChat(next)
  }
  const isNewChatCurrent = (current = useBotWorkspaceStore.getState()) => {
    const session = newChatOwner.current
    return Boolean(session && newChatSessionCurrent(session, current))
  }
  const newChatActive = Boolean(
    newChat && newChat.phase !== "handoff" && newChatSessionCurrent(newChat, state)
  )
  useLayoutEffect(() => {
    if (newChat && !isNewChatCurrent()) setNewChat(null)
  }, [
    newChat,
    state.selected,
    state.host?.hostId,
    state.snapshot?.dataEpoch,
    state.viewportLease?.generation
  ])
  const creationFocus = useRef<{
    id: string
    dataEpoch: string
    generation: number
  } | null>(null)
  const focusCreatedConversation = (id: string) => {
    const current = useBotWorkspaceStore.getState()
    if (!current.snapshot || !current.viewportLease || current.selected !== id) return
    creationFocus.current = {
      id,
      dataEpoch: current.snapshot.dataEpoch ?? "initial",
      generation: current.viewportLease.generation
    }
    if (!newChatOwner.current?.files.length) setNewChat(null)
    composerFocusRequested.current = true
  }
  const quickCreate = useBotQuickCreate(focusCreatedConversation)
  const [quickCreateFeedbackOpen, setQuickCreateFeedbackOpen] = useState(false)
  const commitNewChat = (expected: string, changes: Partial<NewChatLocalSession>) => {
    const live = newChatOwner.current
    if (!live || !isNewChatCurrent() || live.phase !== "editing" || live.revision !== expected)
      return null
    const revision = crypto.randomUUID()
    const next = {
      ...live,
      ...changes,
      revision,
      draft: { ...(changes.draft ?? live.draft), revision }
    }
    setNewChat(next)
    return next
  }
  const handoffNewChat = (session: NewChatLocalSession, targetId: string): boolean => {
    const current = useBotWorkspaceStore.getState(),
      live = newChatOwner.current
    if (
      live?.openNonce !== session.openNonce ||
      live.revision !== session.revision ||
      !isNewChatCurrent()
    )
      return false
    const result = newChatHasContent(live)
      ? adoptNewChatDraft(live, current, targetId, localStorage)
      : undefined
    if (result && result.kind !== "adopted") {
      setNewChat({ ...live, phase: "editing", error: result.reason })
      return false
    }
    current.select(targetId)
    const target = useBotWorkspaceStore.getState(),
      lease = target.viewportLease
    if (target.selected !== targetId || !lease) return false
    const adoption =
      result?.kind === "adopted"
        ? result.receipt
        : {
            openNonce: live.openNonce,
            sourceRevision: live.revision,
            hostId: live.hostId,
            dataEpoch: live.dataEpoch,
            targetViewId: targetId,
            targetDraftRevision: target.drafts[targetId]?.revision ?? ""
          }
    setNewChat({
      ...live,
      phase: "handoff",
      error: undefined,
      handoff: {
        adoption,
        lease,
        batchId: crypto.randomUUID(),
        ready: Boolean(target.snapshot?.conversations.some((item) => item.id === targetId))
      }
    })
    return true
  }
  const continuationFor = (session: NewChatLocalSession): BotQuickCreateSelectionContinuation => {
    const openNonce = session.openNonce,
      sourceRevision = session.revision
    return {
      openNonce,
      sourceRevision,
      requestIntroduction: !newChatHasContent(session),
      current: () =>
        newChatOwner.current?.openNonce === openNonce &&
        newChatOwner.current.revision === sourceRevision &&
        isNewChatCurrent(),
      adopt: (_input, receipt) => {
        const live = newChatOwner.current
        return Boolean(
          live &&
          live.openNonce === openNonce &&
          live.revision === sourceRevision &&
          handoffNewChat(live, receipt.conversationId)
        )
      },
      ready: (receipt) => {
        const live = newChatOwner.current
        const valid =
          live?.openNonce === openNonce &&
          live.revision === sourceRevision &&
          live.handoff?.adoption.targetViewId === receipt.conversationId &&
          isNewChatCurrent()
        if (valid && live?.handoff)
          setNewChat({ ...live, handoff: { ...live.handoff, ready: true } })
        return Boolean(valid)
      }
    }
  }
  const startBotCreation = (nameHint?: string) => {
    creationFocus.current = null
    setQuickCreateFeedbackOpen(true)
    const session = newChatOwner.current
    if (session && isNewChatCurrent() && session.phase !== "handoff") {
      setNewChat({ ...session, phase: "resolving", error: undefined })
      const openNonce = session.openNonce
      return quickCreate.start(continuationFor(session), nameHint).finally(() => {
        const live = newChatOwner.current
        if (live?.openNonce === openNonce && live.phase === "resolving")
          setNewChat({ ...live, phase: "editing" })
      })
    } else return quickCreate.start(undefined, nameHint)
  }
  const createBot = () => {
    setNewChat(null)
    startBotCreation()
  }
  const openNewChat = (groupMode = false) => {
    if (quickCreate.state.busy) return
    const current = useBotWorkspaceStore.getState()
    const live = newChatOwner.current
    if (live && live.phase !== "handoff" && isNewChatCurrent()) {
      if (groupMode && !live.groupMode) commitNewChat(live.revision, { groupMode: true })
      newChatInput.current?.focus({ preventScroll: true })
      return
    }
    const revision = crypto.randomUUID()
    setNewChat({
      openNonce: crypto.randomUUID(),
      hostId: current.host?.hostId ?? "unconnected",
      dataEpoch: current.snapshot?.dataEpoch ?? "initial",
      originViewId: current.selected,
      originViewportGeneration: current.viewportLease?.generation ?? null,
      revision,
      draft: { prompt: "", attachments: [], revision },
      files: [],
      phase: "editing",
      groupMode
    })
  }
  const groupBinding = useRef<{
    openNonce: string
    sourceRevision: string
    nonce: string
  } | null>(null)
  const newChatGroupOwner = {
    isCurrent: () => isNewChatCurrent() && Boolean(newChatOwner.current?.groupMode),
    setResolving: (busy: boolean) => {
      const live = newChatOwner.current,
        binding = groupBinding.current
      if (
        !busy &&
        binding?.openNonce === live?.openNonce &&
        live?.phase === "resolving" &&
        isNewChatCurrent()
      )
        setNewChat({ ...live, phase: "editing" })
    },
    prepared: (input: BotGroupSaveRequest) => {
      const live = newChatOwner.current
      if (!live || !isNewChatCurrent() || !live.groupMode || live.phase !== "editing") return
      groupBinding.current = {
        openNonce: live.openNonce,
        sourceRevision: live.revision,
        nonce: input.nonce
      }
      setNewChat({ ...live, phase: "resolving", error: undefined })
    },
    saved: async (saved: BotConversation, input: BotGroupSaveRequest) => {
      const adopted = (() => {
        const binding = groupBinding.current,
          live = newChatOwner.current
        return Boolean(
          binding &&
          live?.openNonce === binding.openNonce &&
          live.revision === binding.sourceRevision &&
          input.nonce === binding.nonce &&
          input.expectedDataEpoch === live.dataEpoch &&
          isNewChatCurrent() &&
          handoffNewChat(live, saved.id)
        )
      })()
      await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
      const latest = useBotWorkspaceStore.getState(),
        actual = latest.snapshot?.conversations.find((item) => item.id === saved.id)
      if (
        adopted &&
        actual?.kind === "group" &&
        actual.revision === saved.revision &&
        actual.members.length === saved.members.length &&
        actual.members.every((id, index) => id === saved.members[index]) &&
        isNewChatCurrent() &&
        newChatOwner.current?.handoff?.adoption.targetViewId === saved.id
      ) {
        const session = newChatOwner.current!
        setNewChat({
          ...session,
          handoff: { ...session.handoff!, ready: true }
        })
        focusCreatedConversation(saved.id)
      }
    }
  }
  const acceptNewChatFiles = (picker: BotAttachmentPickerHandle) => {
    const live = newChatOwner.current,
      current = useBotWorkspaceStore.getState()
    if (
      !live ||
      !live.files.length ||
      live.phase !== "handoff" ||
      !live.handoff?.ready ||
      !isNewChatCurrent()
    )
      return
    const target = current.snapshot?.conversations.find(
      (item) => item.id === live.handoff?.adoption.targetViewId
    )
    if (
      !target ||
      target.members.some(
        (id) => !current.snapshot?.bots.some((bot) => bot.id === id && bot.deletedAt === null)
      )
    )
      return
    const { handoff, openNonce } = live
    const result = picker.acceptLocalBatch(
      {
        batchId: handoff.batchId,
        adoption: handoff.adoption,
        targetViewportGeneration: handoff.lease.generation,
        files: live.files
      },
      (completion) => {
        const session = newChatOwner.current
        if (
          session?.openNonce !== openNonce ||
          session.handoff?.batchId !== handoff.batchId ||
          !isNewChatCurrent()
        )
          return
        if (completion.state === "retired") return
        const files =
          completion.state === "cancelled"
            ? []
            : session.files.filter(
                (file) =>
                  !completion.confirmed.some(
                    (item) =>
                      item.localId === file.localId &&
                      session.handoff?.accepted?.some(
                        (job) => job.localId === item.localId && job.nonce === item.nonce
                      )
                  )
              )
        setNewChat(files.length ? { ...session, files } : null)
      }
    )
    if (result.kind === "accepted" && !live.handoff.accepted)
      setNewChat({
        ...live,
        error: undefined,
        handoff: { ...live.handoff, accepted: result.jobs }
      })
    else if (result.kind === "rejected" && live.error !== result.reason)
      setNewChat({ ...live, error: result.reason })
  }
  const [showFiles, setShowFiles] = useState(false)
  const [secretBot, setSecretBot] = useState<{
    id: string
    name: string
  } | null>(null)
  const [previewFile, setPreviewFile] = useState<{
    id: string
    conversationId: string
    media?: BotPeerMessageImage
    mediaGroup?: BotPeerMessageImage[]
    expectedArtifact?: BotMessageAttachment
    trigger?: HTMLButtonElement
    viewId?: string
    epoch?: string
  } | null>(null)
  const downloadsEpoch = state.snapshot?.dataEpoch
  const openDownloads = () => {
    if (!downloadsEpoch || useBotWorkspaceStore.getState().snapshot?.dataEpoch !== downloadsEpoch)
      return
    setShowFiles(false)
    setPreviewFile(null)
    setShowDownloads(true)
  }
  const [computerBot, setComputerBotState] = useState<string | null>(null)
  const [teachArm, setTeachArm] = useState<BotTeachArm | null>(null)
  const computerBackend = useRef<{
    botId: string
    backend: "browser" | "windows-native"
    hostId: string | undefined
    hostEpoch: string
    dataEpoch: string
  } | null>(null)
  const [inspectorGroupId, setInspectorGroupId] = useState<string | null>(null)
  const inspectorPreferenceScope = botInspectorPreferenceScope(state.host?.sharedWorkspace)
  const inspectorPreferenceCache = useRef<{
    scope: string | null
    preferences: BotInspectorPreferences
  } | null>(null)
  const inspectorPreferencesFor = useCallback((scope: string | null) => {
    const current = inspectorPreferenceCache.current
    if (current?.scope === scope) return current
    const next = { scope, preferences: botInspectorPreferences.read(scope) }
    inspectorPreferenceCache.current = next
    return next
  }, [])
  const [inspectorTab, setInspectorTab] = useState<BotInspectorTab>(
    () => inspectorPreferencesFor(inspectorPreferenceScope).preferences.fallback
  )
  const setComputerBot = (id: string | null) => {
    if (resource === "routines" && routineIntent?.mode === "view" && !setResource(null)) return
    if (computerBackend.current?.botId !== id) computerBackend.current = null
    setTeachArm(null)
    setInspectorGroupId(null)
    setInspectorTab("computer")
    setComputerBotState(id)
  }
  const showBotDetails = (id: string) => {
    if (resource === "routines" && routineIntent?.mode === "view" && !setResource(null)) return
    setTeachArm(null)
    setInspectorGroupId(null)
    setInspectorTab("details")
    setComputerBotState(id)
  }
  const [asyncBot, setAsyncBot] = useState<{ id: string; name: string } | null>(null)
  const [avatarBot, setAvatarBot] = useState<CoworkBot | null>(null)
  const [peerExchange, setPeerExchange] = useState<BotPeerExchangeLink | null>(null)
  const peerTrigger = useRef<{
    node: HTMLElement
    viewId: string
    epoch: string
  } | null>(null)
  const peerExitFocus = useRef<typeof peerTrigger.current>(null)
  const transcriptActivity = useRef({ active: false, viewId: "", epoch: "" })
  const transcriptCurrent = useCallback(() => {
    const current = useBotWorkspaceStore.getState()
    const scope = transcriptActivity.current
    return (
      scope.active &&
      current.selected === scope.viewId &&
      (current.snapshot?.dataEpoch ?? "initial") === scope.epoch
    )
  }, [])
  const [computerHelpView, setComputerHelpView] = useState<BotComputerHelpView | null>(null)
  const [historyRun, setHistoryRun] = useState<BotRunAddress | null>(null)
  const [recoveryRun, setRecoveryRun] = useState<BotRun | null>(null)
  const [showRecoveryRecords, setShowRecoveryRecords] = useState(false)
  const [cloning, setCloning] = useState(false)
  const cloneRequest = useRef<BotCloneInput | null>(null)
  const cloneBusy = useRef({ mounted: false, generation: 0, busy: false })
  useLayoutEffect(() => {
    const owner = cloneBusy.current
    owner.mounted = true
    ++owner.generation
    return () => {
      owner.mounted = false
      ++owner.generation
      owner.busy = false
    }
  }, [])
  const positionedConversation = useRef<string | null>(null)
  const [replyJump, setReplyJump] = useState<{
    conversationId: string
    id: string
  } | null>(null)
  const messageNavigation = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      const pending = messageNavigation.current
      messageNavigation.current = null
      pending?.abort()
    },
    []
  )
  const [highlightedReply, setHighlightedReply] = useState<string | null>(null)
  const recipients = state.selected ? (state.drafts[state.selected]?.recipients ?? []) : []
  const setRecipients = (next: string[] | ((current: string[]) => string[])) => {
    if (!state.selected) return
    state.recipients(state.selected, typeof next === "function" ? next(recipients) : next)
  }
  const scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const bindTranscript = useCallback((node: HTMLDivElement | null) => {
    scroll.current = node
    setScrollParent(node)
  }, [])
  const transcriptList = useRef<VirtuosoHandle | null>(null)
  const [renderedRows, setRenderedRows] = useState(0)
  const tailFrame = useRef<number | null>(null)
  const followTranscriptTail = useCallback(() => {
    if (!transcriptCurrent() || tailFrame.current !== null || !nearBottom.current) return
    tailFrame.current = requestAnimationFrame(() => {
      tailFrame.current = null
      if (transcriptCurrent() && nearBottom.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight
    })
  }, [transcriptCurrent])
  useEffect(
    () => () => {
      if (tailFrame.current !== null) cancelAnimationFrame(tailFrame.current)
    },
    []
  )
  const historyAnchor = useRef<{
    conversationId: string
    messageId: string
    offset: number
    stableFrames: number
    attempts: number
  } | null>(null)
  const requestedReveal = useRef("")
  const bots = useMemo(() => state.snapshot?.bots ?? [], [state.snapshot?.bots])
  const minimumGroupMembers = state.host?.capabilities?.includes(BOT_SINGLE_BOT_ROOM_CAPABILITY)
    ? 1
    : 2
  const inspectorRosterKey = useMemo(
    () =>
      bots
        .map((item) => item.id)
        .sort()
        .join("\n"),
    [bots]
  )
  const inspectorRosterReady = state.snapshot !== null
  useEffect(() => {
    // snapshot() lists every live Bot (including hidden); an unknown snapshot
    // cannot prove deletion. Only changed membership may prune this layout cache.
    if (!inspectorRosterReady || !inspectorPreferenceScope) return
    const cache = inspectorPreferencesFor(inspectorPreferenceScope)
    cache.preferences = botInspectorPreferences.prune(
      inspectorPreferenceScope,
      cache.preferences,
      new Set(inspectorRosterKey ? inspectorRosterKey.split("\n") : [])
    )
  }, [inspectorRosterReady, inspectorPreferenceScope, inspectorRosterKey, inspectorPreferencesFor])
  const conversations = useMemo(() => {
    const order = new Map<string, number>()
    state.snapshot?.pinnedOrder?.ids.forEach((id, index) => {
      if (!order.has(id)) order.set(id, index)
    })
    const ranks = new Map<string, number>()
    bots.forEach((item, index) => {
      if (item.pinned) ranks.set(item.id, order.get(item.id) ?? index)
    })
    return [...(state.snapshot?.conversations ?? [])].sort(
      (left, right) =>
        (left.kind === "direct"
          ? (ranks.get(left.members[0]) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER) -
          (right.kind === "direct"
            ? (ranks.get(right.members[0]) ?? Number.MAX_SAFE_INTEGER)
            : Number.MAX_SAFE_INTEGER) ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id)
    )
  }, [state.snapshot?.conversations, state.snapshot?.pinnedOrder?.ids, bots])
  const pinnedOrder = useBotPinnedOrder(query, showHidden)
  const authors = useMemo(
    () => new Map((state.snapshot?.bots ?? []).map((item) => [item.id, item])),
    [state.snapshot?.bots]
  )
  const authorConversations = useMemo(
    () =>
      new Map(
        (state.snapshot?.conversations ?? [])
          .filter((item) => item.kind === "direct")
          .map((item) => [item.members[0], item.id])
      ),
    [state.snapshot?.conversations]
  )
  const viewId = state.selected ?? ""
  useEffect(() => {
    setPeerExchange(null)
    setTeachArm(null)
  }, [viewId])
  const address = botViewAddress(viewId)
  const conversation = conversations.find((item) => item.id === address.conversationId)
  const inspectorEpoch = state.snapshot?.dataEpoch ?? "initial"
  const [inspectorSelection, setInspectorSelection] = useState(() => ({
    viewId,
    dataEpoch: inspectorEpoch
  }))
  const inspectorNavigationPending =
    inspectorSelection.viewId !== viewId || inspectorSelection.dataEpoch !== inspectorEpoch
  useLayoutEffect(() => {
    if (!inspectorNavigationPending) return
    // Keep an in-flight routine mutation or its child dialog with its original
    // owner. Cover the old computer until the existing resource guard releases.
    if (resource === "routines" && routineIntent?.mode === "view" && !setResource(null)) return
    const previous = inspectorSelection
    setInspectorSelection({ viewId, dataEpoch: inspectorEpoch })
    setTeachArm(null)
    const open = computerBot !== null || inspectorGroupId !== null
    if (!open) return
    // Restore changes authority even when a conversation ID survives. Reopening
    // is explicit, so no old input frame or Teach preparation crosses the epoch.
    if (previous.dataEpoch !== inspectorEpoch) {
      computerBackend.current = null
      setComputerBotState(null)
      setInspectorGroupId(null)
      return
    }
    const target =
      conversation?.kind === "direct"
        ? bots.find((item) => item.id === conversation.members[0])
        : undefined
    if (computerBackend.current?.botId !== target?.id) computerBackend.current = null
    setComputerBotState(target?.id ?? null)
    setInspectorGroupId(conversation?.kind === "group" ? conversation.id : null)
    if (!target) setInspectorTab("details")
    else if (target.id !== computerBot)
      setInspectorTab(
        resolveBotInspectorPreference(
          inspectorPreferencesFor(inspectorPreferenceScope).preferences,
          target.id
        )
      )
  }, [
    inspectorNavigationPending,
    resource,
    routineIntent?.mode,
    setResource,
    inspectorSelection,
    viewId,
    inspectorEpoch,
    computerBot,
    inspectorGroupId,
    conversation,
    bots,
    resourcePresentation,
    inspectorPreferenceScope,
    inspectorPreferencesFor
  ])
  const activeExchange =
    peerExchange &&
    peerTrigger.current?.epoch === inspectorEpoch &&
    conversation?.id === peerExchange.anchor.conversationId &&
    address.threadRootId === peerExchange.anchor.threadRootId
      ? peerExchange
      : null
  const normalChatActive = documentVisible && !activeExchange && !newChatActive
  const routinePanel =
    resource === "routines" &&
    routineIntent?.mode === "view" &&
    routineIntent.dataEpoch === (state.snapshot?.dataEpoch ?? "initial") &&
    Boolean(resourceBotId && resourceBotId === computerBot)
  const modalCovered = Boolean(
    computerHelpView ||
    historyRun ||
    previewFile ||
    (resource && !routinePanel) ||
    resourcePresentation.modal ||
    editor ||
    groupEditor ||
    importBot ||
    recoveryRun ||
    showRecoveryRecords ||
    (showFiles && conversation) ||
    secretBot ||
    asyncBot ||
    avatarBot ||
    showKeyboardHelp ||
    showHelp ||
    showPrimarySettings ||
    showBackups ||
    showDownloads ||
    showUsageBudget ||
    showWorkspaceMaintenance ||
    showBrowserMaintenance ||
    showComputerCheckpoints ||
    showLocalToolPermission ||
    rulesBot ||
    showStorage ||
    showSearch ||
    showPalette ||
    deleteTarget ||
    (quickCreateFeedbackOpen &&
      (quickCreate.state.notice || ["blocked", "configure"].includes(quickCreate.state.phase)))
  )
  useLayoutEffect(() => {
    transcriptActivity.current = {
      active: normalChatActive,
      viewId,
      epoch: state.snapshot?.dataEpoch ?? "initial"
    }
    if (!normalChatActive && tailFrame.current !== null) {
      cancelAnimationFrame(tailFrame.current)
      tailFrame.current = null
    }
    return () => {
      transcriptActivity.current.active = false
    }
  }, [normalChatActive, viewId, state.snapshot?.dataEpoch])
  const closePeerExchange = () => {
    const trigger = peerTrigger.current
    const current = useBotWorkspaceStore.getState()
    if (
      trigger &&
      current.selected === trigger.viewId &&
      (current.snapshot?.dataEpoch ?? "initial") === trigger.epoch
    )
      peerExitFocus.current = trigger
    setPeerExchange(null)
  }
  useLayoutEffect(() => {
    if (activeExchange) return
    const trigger = peerExitFocus.current
    peerExitFocus.current = null
    const current = useBotWorkspaceStore.getState()
    if (
      !trigger ||
      current.selected !== trigger.viewId ||
      (current.snapshot?.dataEpoch ?? "initial") !== trigger.epoch
    )
      return
    if (trigger.node.isConnected && trigger.node.getClientRects().length)
      trigger.node.focus({ preventScroll: true })
    else {
      composerFocusRequested.current = true
      workspace.current
        ?.querySelector<HTMLElement>(".bot-composer-input")
        ?.focus({ preventScroll: true })
    }
  }, [activeExchange])
  const inspectorGroup = conversations.find(
    (item) => item.id === inspectorGroupId && item.kind === "group"
  )
  const closeNewChat = () => {
    if (quickCreate.state.busy) return
    const restoreFocus = isNewChatCurrent()
    setNewChat(null)
    if (!restoreFocus) return
    if (state.selected) composerFocusRequested.current = true
    else newChatTrigger.current?.focus({ preventScroll: true })
  }
  const chooseNewChatConversation = (id: string) => {
    const current = useBotWorkspaceStore.getState(),
      session = newChatOwner.current
    if (!session || !isNewChatCurrent() || session.phase !== "editing") return
    const target = current.snapshot?.conversations.find((item) => item.id === id)
    if (
      target?.kind !== "direct" ||
      !current.snapshot?.bots.some(
        (item) => item.id === target.members[0] && item.deletedAt === null
      )
    ) {
      setNewChat({
        ...session,
        error: "这个 Bot 已不可用，请刷新列表后重试。"
      })
      return
    }
    if (handoffNewChat(session, id)) focusCreatedConversation(id)
  }
  const focusComposer = () => {
    // A keyboard selection replaces the keyed composer. Restore focus in that
    // commit, before another key can arrive; rAF leaves a frame with body focus.
    if (useBotWorkspaceStore.getState().selected !== state.selected || showPalette)
      composerFocusRequested.current = true
    else workspace.current?.querySelector<HTMLElement>(".bot-composer-input")?.focus()
  }
  const restoreComposerFocus = () => {
    if (!composerFocusRequested.current || showPalette || newChatActive) return
    const input = workspace.current?.querySelector<HTMLElement>(".bot-composer-input")
    // The rich editor mounts after the conversation commit. Keep the request
    // until onEditorReady rather than dropping keyboard focus on that boundary.
    if (!input) return
    composerFocusRequested.current = false
    input.focus()
  }
  useLayoutEffect(() => {
    if (!composerFocusRequested.current || showPalette || newChatActive) return
    const input = workspace.current?.querySelector<HTMLElement>(".bot-composer-input")
    if (input) {
      composerFocusRequested.current = false
      input.focus()
    }
  }, [state.selected, showPalette, newChatActive])
  const availableHistory = new Set(
    conversations
      .filter(
        (item) =>
          item.kind === "group" || !bots.find((member) => member.id === item.members[0])?.hidden
      )
      .map((item) => item.id)
  )
  const navigationHistory = {
    back: () => {
      state.navigateHistory("back")
      focusComposer()
    },
    forward: () => {
      state.navigateHistory("forward")
      focusComposer()
    },
    canBack: !!resolveRootShellNavigation(state.history, availableHistory, "back"),
    canForward: !!resolveRootShellNavigation(state.history, availableHistory, "forward")
  }
  const thread = state.threads[viewId]
  const viewReadState = address.threadRootId ? thread?.readState : conversation?.readState
  const returnPosition = useRef<{
    id: string
    messageId?: string
    offset: number
    scrollTop: number
  } | null>(null)
  const restoringMain = useRef(false)
  const bot =
    conversation?.kind === "direct"
      ? bots.find((item) => item.id === conversation.members[0])
      : undefined
  const userBubbleTint = useBotUserBubbleTint(conversation?.kind, bot)
  const resourceBot = resourceBotId ? bots.find((item) => item.id === resourceBotId) : bot
  const openRoutineView = (botId: string, intent: BotRoutineOpenIntent): void => {
    const current = useBotWorkspaceStore.getState()
    if (
      intent.mode !== "view" ||
      intent.dataEpoch !== (current.snapshot?.dataEpoch ?? "initial") ||
      !current.snapshot?.bots.some(
        (item) => item.id === botId && !item.hidden && item.deletedAt === null
      ) ||
      !current.snapshot?.conversations.some(
        (item) => item.kind === "direct" && item.members.includes(botId)
      )
    )
      return
    if (!setResource("routines", botId)) return
    routineReturnFocus.current = {
      node: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      epoch: intent.dataEpoch
    }
    setResourceFocus(intent.id)
    setRoutineIntent(intent)
    setInspectorGroupId(null)
    setComputerBotState(botId)
  }
  const returnRoutineDetails = (): void => {
    if (!setResource(null)) return
    setResourceFocus(undefined)
    setInspectorTab("details")
    const trigger = routineReturnFocus.current
    requestAnimationFrame(() => {
      if (
        !trigger ||
        routineReturnFocus.current !== trigger ||
        (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") !== trigger.epoch ||
        document.activeElement?.closest('[role="dialog"],[role="menu"],[role="listbox"]')
      )
        return
      const node =
        trigger.node?.closest(".bot-inspector-base") &&
        trigger.node.isConnected &&
        trigger.node.getClientRects().length
          ? trigger.node
          : workspace.current?.querySelector<HTMLElement>(
              '.bot-inspector-base [role="tab"][data-state="active"]'
            )
      node?.focus({ preventScroll: true })
    })
  }
  const openReferencedSkill = (reference: BotSkillReference) => {
    if (!bots.some((item) => item.id === reference.botId)) {
      toast.message("此技能所属的 Bot 已不可用。")
      return
    }
    if (!setResource("skills", reference.botId)) return
    setResourceFocus(reference.id)
    setReferencedSkill(reference)
  }
  const messages = state.selected
    ? (state.messages[state.selected] ?? emptyMessages)
    : emptyMessages
  const viewportLease = state.viewportLease
  const syncHistoryReading = useCallback(() => {
    const container = scroll.current
    const current = useBotWorkspaceStore.getState()
    if (
      !transcriptCurrent() ||
      !container ||
      !viewId ||
      !viewportLease ||
      current.selected !== viewId ||
      current.viewportLease !== viewportLease ||
      current.opening[viewId] ||
      current.viewportRestore ||
      restoringMain.current ||
      historyAnchor.current?.conversationId === viewId
    )
      return
    const top = container.getBoundingClientRect().top
    const first = nearBottom.current
      ? undefined
      : Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
          (node) => node.getBoundingClientRect().bottom > top
        )
    const messageId = first?.dataset.messageId
    if (
      !nearBottom.current &&
      (!messageId || !current.messages[viewId]?.some((message) => message.id === messageId))
    )
      return
    current.setHistoryFollowTail(viewId, nearBottom.current, messageId)
    current.saveViewportPosition(
      viewId,
      {
        messageId: messageId ?? null,
        offset: first ? first.getBoundingClientRect().top - top : 0,
        followTail: nearBottom.current
      },
      viewportLease
    )
  }, [viewId, viewportLease, transcriptCurrent])
  const rowsRendered = useCallback(() => {
    setRenderedRows((value) => value + 1)
    syncHistoryReading()
  }, [syncHistoryReading])
  const detachTranscript = useCallback(() => {
    messageNavigation.current?.abort()
    messageNavigation.current = null
    setReplyJump(null)
    if (tailFrame.current !== null) {
      cancelAnimationFrame(tailFrame.current)
      tailFrame.current = null
    }
    historyAnchor.current = null
    restoringMain.current = false
    positionedConversation.current = viewId
    requestedReveal.current = ""
    if (viewportLease) useBotWorkspaceStore.getState().clearViewportRestore(viewId, viewportLease)
  }, [viewId, viewportLease])
  useBotTranscriptScroll({
    scrollParent: normalChatActive ? scrollParent : null,
    viewId,
    following: nearBottom,
    onReadPosition: syncHistoryReading,
    onUserDetach: detachTranscript,
    onContentHeightChanged: followTranscriptTail
  })
  useBotReadPosition(scroll, normalChatActive ? state.selected : null, messages.length)
  useLayoutEffect(() => {
    positionedConversation.current = null
    requestedReveal.current = ""
    setReplyJump((pending) => (pending?.conversationId === state.selected ? pending : null))
  }, [state.selected])
  const followingHistory = state.historyFollowTail[viewId] !== false
  useLayoutEffect(() => {
    // Explicit latest-page loads (including send receipts) resume following;
    // paging, unread positioning and targeted reveals retain their read mode.
    nearBottom.current = followingHistory
  }, [viewId, followingHistory])
  const revealMessage = useCallback(
    (id: string, align: "start" | "center", offset = 0) => {
      if (!transcriptCurrent()) return
      const index = messages.findIndex((message) => message.id === id)
      if (index < 0 || !transcriptList.current) return
      const key = `${viewId}:${id}:${align}:${messages[0]?.id}:${messages.length}`
      if (requestedReveal.current === key) return
      requestedReveal.current = key
      transcriptList.current.scrollToIndex({
        index,
        align,
        offset,
        behavior: "auto"
      })
    },
    [messages, viewId, transcriptCurrent]
  )
  useLayoutEffect(() => {
    const saved = state.viewportRestore
    const container = scroll.current
    if (!normalChatActive || !saved || !viewportLease || !container || state.opening[viewId]) return
    if (saved.followTail || !saved.messageId) {
      nearBottom.current = saved.followTail
      positionedConversation.current = viewId
      useBotWorkspaceStore.getState().clearViewportRestore(viewId, viewportLease)
      if (saved.followTail) followTranscriptTail()
      return
    }
    nearBottom.current = false
    const node = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (item) => item.dataset.messageId === saved.messageId
    )
    if (!node) {
      if (messages.some((message) => message.id === saved.messageId))
        revealMessage(saved.messageId, "start", -saved.offset)
      return
    }
    const frame = requestAnimationFrame(() => {
      const current = useBotWorkspaceStore.getState()
      if (
        !transcriptCurrent() ||
        current.selected !== viewId ||
        current.viewportLease !== viewportLease ||
        current.viewportRestore !== saved ||
        scroll.current !== container ||
        !node.isConnected
      )
        return
      container.scrollTop +=
        node.getBoundingClientRect().top - container.getBoundingClientRect().top - saved.offset
      positionedConversation.current = viewId
      current.clearViewportRestore(viewId, viewportLease)
      syncHistoryReading()
    })
    return () => cancelAnimationFrame(frame)
  }, [
    normalChatActive,
    transcriptCurrent,
    state.viewportRestore,
    state.opening,
    viewportLease,
    viewId,
    messages,
    renderedRows,
    revealMessage,
    followTranscriptTail,
    syncHistoryReading
  ])
  useLayoutEffect(() => {
    if (
      normalChatActive &&
      restoringMain.current &&
      returnPosition.current?.id === state.selected &&
      scroll.current
    ) {
      const saved = returnPosition.current
      nearBottom.current = false
      const node = Array.from(
        scroll.current.querySelectorAll<HTMLElement>("[data-message-id]")
      ).find((item) => item.dataset.messageId === saved.messageId)
      if (!node && saved.messageId && messages.some((message) => message.id === saved.messageId)) {
        revealMessage(saved.messageId, "start", -saved.offset)
        return
      }
      if (node) {
        scroll.current.scrollTop +=
          node.getBoundingClientRect().top -
          scroll.current.getBoundingClientRect().top -
          saved.offset
      } else scroll.current.scrollTop = saved.scrollTop
      positionedConversation.current = state.selected
      restoringMain.current = false
    }
  }, [normalChatActive, state.selected, messages, renderedRows, revealMessage])
  const openThread = (rootId: string) => {
    if (!conversation || !scroll.current) return
    const top = scroll.current.getBoundingClientRect().top
    const visible = Array.from(
      scroll.current.querySelectorAll<HTMLElement>("[data-message-id]")
    ).find((node) => node.getBoundingClientRect().bottom > top)
    returnPosition.current = {
      id: viewId,
      messageId: visible?.dataset.messageId,
      offset: visible ? visible.getBoundingClientRect().top - top : 0,
      scrollTop: scroll.current.scrollTop
    }
    state.setHistoryFollowTail(viewId, false, visible?.dataset.messageId)
    state.select(botThreadView(conversation.id, rootId))
  }
  const returnToMain = () => {
    if (!conversation) return
    restoringMain.current = returnPosition.current?.id === conversation.id
    state.select(conversation.id, restoringMain.current)
  }
  const navigateToMessage = async (
    targetView: string,
    id: string,
    context?: BotSearchOpenContext
  ) => {
    messageNavigation.current?.abort()
    const controller = new AbortController()
    messageNavigation.current = controller
    const signal = context
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal
    const current = () =>
      messageNavigation.current === controller &&
      !signal.aborted &&
      (!context || context.isCurrent())
    const abort = () => {
      if (messageNavigation.current !== controller) return
      setReplyJump(null)
      requestedReveal.current = ""
    }
    signal.addEventListener("abort", abort, { once: true })
    nearBottom.current = false
    setReplyJump({ conversationId: targetView, id })
    const pending = state.jumpToMessage(targetView, id, { signal })
    const requestedLease = useBotWorkspaceStore.getState().viewportLease
    try {
      const receipt = await pending
      const next = useBotWorkspaceStore.getState()
      if (
        current() &&
        receipt &&
        next.selected === receipt.viewId &&
        next.viewportLease === receipt.lease &&
        next.messages[receipt.viewId]?.some((message) => message.id === id)
      )
        setReplyJump({ conversationId: receipt.viewId, id })
    } catch (error) {
      const next = useBotWorkspaceStore.getState()
      const failure = next.transcriptError
      if (
        current() &&
        ((next.selected === targetView && next.viewportLease === requestedLease) ||
          (failure?.targetId === id && failure.viewId === next.selected))
      ) {
        setReplyJump(null)
        throw error
      }
    } finally {
      signal.removeEventListener("abort", abort)
      if (messageNavigation.current === controller) {
        messageNavigation.current = null
        if (signal.aborted) syncHistoryReading()
      }
    }
  }
  const navigateFromLink = useEffectEvent(navigateToMessage)
  const jumpToReply = async (id: string) => {
    if (!conversation || state.opening[viewId]) return
    try {
      await navigateToMessage(viewId, id)
    } catch (error) {
      report(error)
    }
  }
  useEffect(() => {
    const navigation = state.navigation
    if (!navigation) return
    let disposed = false
    const controller = new AbortController()
    void (async () => {
      try {
        await useBotWorkspaceStore.getState().refresh()
        if (disposed) return
        const current = useBotWorkspaceStore.getState()
        if (current.navigation !== navigation) return
        if (!current.snapshot?.conversations.some((item) => item.id === navigation.conversationId))
          throw new Error("此消息在当前本机工作区中不可用，可能已删除或来自其他工作区")
        await navigateFromLink(navigation.conversationId, navigation.messageId, {
          signal: controller.signal,
          isCurrent: () => !disposed && useBotWorkspaceStore.getState().navigation === navigation
        })
      } catch (error) {
        if (!disposed) report(error)
      } finally {
        if (!disposed && useBotWorkspaceStore.getState().navigation === navigation)
          useBotWorkspaceStore.setState({ navigation: null })
      }
    })()
    return () => {
      disposed = true
      controller.abort()
    }
  }, [state.navigation])
  useLayoutEffect(() => {
    if (
      !normalChatActive ||
      !replyJump ||
      replyJump.conversationId !== state.selected ||
      !scroll.current
    )
      return
    const node = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (item) => item.dataset.messageId === replyJump.id
    )
    if (!node) {
      revealMessage(replyJump.id, "center")
      return
    }
    nearBottom.current = false
    node.scrollIntoView({ block: "center" })
    node.focus({ preventScroll: true })
    positionedConversation.current = replyJump.conversationId
    setHighlightedReply(replyJump.id)
    setReplyJump(null)
  }, [normalChatActive, messages, replyJump, state.selected, renderedRows, revealMessage])
  useEffect(() => {
    if (!highlightedReply) return
    const timer = setTimeout(() => setHighlightedReply(null), 1800)
    return () => clearTimeout(timer)
  }, [highlightedReply])
  const unreadAnchor = state.selected ? state.unreadAnchors[state.selected] : null
  const runs =
    state.snapshot?.runs.filter(
      (run) =>
        run.conversationId === address.conversationId && run.threadRootId === address.threadRootId
    ) ?? []
  const outputLengths = runs
    .map((run) => state.runOutputs[run.id]?.text.length ?? run.output?.length ?? 0)
    .join(":")
  const selectedWork = state.snapshot?.work?.selected
  const modernWork = state.snapshot?.work?.projection === "paged"
  const workCounts =
    selectedWork?.view.conversationId === address.conversationId &&
    selectedWork.view.threadRootId === address.threadRootId
      ? selectedWork.counts
      : undefined
  const pendingDescriptors = workCounts ? selectedWork!.pending : []
  const openTaskPage = useCallback(
    (open: boolean) => useBotWorkspaceStore.getState().setWorkPageOpen("tasks", open),
    []
  )
  const moveTaskPage = useCallback(
    (direction: "next" | "previous" | "first") =>
      useBotWorkspaceStore.getState().navigateWorkPage("tasks", direction),
    []
  )
  const retryWorkPage = useCallback(() => {
    void useBotWorkspaceStore.getState().refreshWorkPages()
  }, [])
  const interactions =
    state.snapshot?.interactions.filter((item) => runs.some((run) => run.id === item.runId)) ?? []
  useLayoutEffect(() => {
    const anchor = historyAnchor.current
    if (!normalChatActive || !anchor || !scroll.current) return
    if (anchor.conversationId !== state.selected) {
      historyAnchor.current = null
      return
    }
    if (state.loadingOlder[anchor.conversationId] || state.loadingNewer[anchor.conversationId])
      return
    // Reuse ChatContainer's bounded measured-anchor settlement. Virtuoso's
    // inverse paging and ResizeObserver measurements span multiple frames;
    // ending after the first write lets their later compensation move the text.
    let frame: number | null = null
    const restore = () => {
      const container = scroll.current
      if (
        !transcriptCurrent() ||
        historyAnchor.current !== anchor ||
        useBotWorkspaceStore.getState().selected !== anchor.conversationId ||
        !container
      )
        return
      const node = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
        (item) => item.dataset.messageId === anchor.messageId
      )
      if (node) {
        const delta =
          node.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
        if (Math.abs(delta) > 1) container.scrollTop += delta
        anchor.stableFrames = Math.abs(delta) <= 1 ? anchor.stableFrames + 1 : 0
        if (anchor.stableFrames >= 12) {
          historyAnchor.current = null
          syncHistoryReading()
          return
        }
      } else if (anchor.attempts === 0) {
        revealMessage(anchor.messageId, "start", -anchor.offset)
      }
      anchor.attempts++
      if (anchor.attempts <= 120) frame = requestAnimationFrame(restore)
      else {
        historyAnchor.current = null
        syncHistoryReading()
      }
    }
    frame = requestAnimationFrame(restore)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [
    normalChatActive,
    transcriptCurrent,
    messages,
    state.loadingOlder,
    state.loadingNewer,
    state.selected,
    renderedRows,
    revealMessage,
    syncHistoryReading
  ])
  const captureHistoryAnchor = () => {
    const container = scroll.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    const first = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (node) => node.getBoundingClientRect().bottom > top
    )
    if (first?.dataset.messageId)
      historyAnchor.current = {
        conversationId: viewId,
        messageId: first.dataset.messageId,
        offset: first.getBoundingClientRect().top - top,
        stableFrames: 0,
        attempts: 0
      }
    nearBottom.current = false
    useBotWorkspaceStore.getState().setHistoryFollowTail(viewId, false, first?.dataset.messageId)
    requestedReveal.current = ""
  }
  const loadEarlier = () => {
    if (!conversation || !messages.length || state.loadingOlder[viewId]) return
    captureHistoryAnchor()
    void state.loadMessages(viewId, messages[0].sequence).catch(report)
  }
  useEffect(() => {
    if (!documentVisible) return
    useBotWorkspaceStore.getState().activateTaskOutputs()
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!refreshInFlight.current) {
        refreshInFlight.current = true
        try {
          await useBotWorkspaceStore.getState().refresh()
        } catch {
          /* Connection error is shown without discarding drafts or history. */
        } finally {
          refreshInFlight.current = false
        }
      }
      if (!disposed)
        timer = setTimeout(
          () => void poll(),
          (useBotWorkspaceStore.getState().snapshot?.work?.counts.running ??
            useBotWorkspaceStore.getState().snapshot?.runs.filter((run) => run.status === "running")
              .length ??
            0) > 0
            ? 350
            : 1500
        )
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      useBotWorkspaceStore.getState().clearTaskOutputs(true)
    }
  }, [documentVisible])
  useLayoutEffect(() => {
    if (
      !normalChatActive ||
      !state.selected ||
      replyJump?.conversationId === state.selected ||
      positionedConversation.current === state.selected ||
      !messages.length ||
      !scroll.current
    )
      return
    if (restoringMain.current || state.viewportRestore) return
    const anchor = unreadAnchor
      ? scroll.current.querySelector<HTMLElement>(`[data-unread-sequence="${unreadAnchor}"]`)
      : null
    if (anchor) {
      nearBottom.current = false
      useBotWorkspaceStore.getState().setHistoryFollowTail(viewId, false)
      scroll.current.scrollTop +=
        anchor.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top
    } else if (unreadAnchor && messages.some((message) => message.sequence === unreadAnchor)) {
      nearBottom.current = false
      useBotWorkspaceStore.getState().setHistoryFollowTail(viewId, false)
      revealMessage(messages.find((message) => message.sequence === unreadAnchor)!.id, "start")
      return
    }
    positionedConversation.current = state.selected
  }, [
    normalChatActive,
    state.selected,
    state.viewportRestore,
    messages,
    unreadAnchor,
    replyJump,
    renderedRows,
    revealMessage,
    viewId
  ])
  const lastMessageId = messages.at(-1)?.id
  useEffect(() => {
    followTranscriptTail()
  }, [
    normalChatActive,
    state.selected,
    lastMessageId,
    interactions.length,
    outputLengths,
    followTranscriptTail
  ])
  const initialTranscriptLocation: FlatIndexLocationWithAlign | undefined = (() => {
    const saved =
      restoringMain.current && returnPosition.current?.id === viewId ? returnPosition.current : null
    const restored = state.viewportRestore
    if (restored?.followTail) return undefined
    const target =
      saved?.messageId ??
      (replyJump?.conversationId === viewId ? replyJump.id : restored?.messageId)
    const index = target
      ? messages.findIndex((message) => message.id === target)
      : messages.findIndex((message) => message.sequence === unreadAnchor)
    return index >= 0
      ? {
          index,
          align: saved || restored ? "start" : target ? "center" : "start",
          ...(saved || restored ? { offset: -(saved?.offset ?? restored!.offset) } : {})
        }
      : undefined
  })()
  const mutate = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
      await state.refresh()
    } catch (error) {
      report(error)
    }
  }
  const cloneBot = async () => {
    const current = useBotWorkspaceStore.getState()
    const expectedDataEpoch = state.snapshot?.dataEpoch ?? "initial"
    const owner = cloneBusy.current
    if (
      !bot ||
      !owner.mounted ||
      owner.busy ||
      !current.snapshot ||
      (current.snapshot.dataEpoch ?? "initial") !== expectedDataEpoch ||
      !current.viewportLease ||
      current.selected !== viewId
    )
      return
    if (!current.host?.capabilities?.includes("clone-epoch")) {
      report(new Error("请更新并重启 Bot 后台后再复制。"))
      return
    }
    owner.busy = true
    const generation = owner.generation
    const originView = current.selected
    const lease = current.viewportLease
    setCloning(true)
    if (
      cloneRequest.current?.id !== bot.id ||
      cloneRequest.current.expectedDataEpoch !== expectedDataEpoch
    )
      cloneRequest.current = {
        id: bot.id,
        revision: bot.revision,
        nonce: crypto.randomUUID(),
        expectedDataEpoch
      }
    const request = cloneRequest.current
    const mounted = () => owner.mounted && owner.generation === generation
    const sameEpoch = () => {
      const snapshot = useBotWorkspaceStore.getState().snapshot
      return Boolean(snapshot && (snapshot.dataEpoch ?? "initial") === request.expectedDataEpoch)
    }
    const ownsRequest = () => mounted() && cloneRequest.current === request && sameEpoch()
    try {
      const copied = await botApi.clone(request)
      if (!ownsRequest()) return
      await useBotWorkspaceStore.getState().refresh()
      if (!ownsRequest()) return
      cloneRequest.current = null
      const next = useBotWorkspaceStore.getState()
      if (next.selected === originView && next.viewportLease === lease) {
        next.select(copied.conversationId)
        toast.success("已复制 Bot")
      }
    } catch (error) {
      if (!ownsRequest()) return
      if (error instanceof Error && error.message.includes("Bot 已变化"))
        cloneRequest.current = null
      report(error)
    } finally {
      if (mounted() && sameEpoch()) {
        owner.busy = false
        setCloning(false)
      }
    }
  }
  const openSearchMatch = async (match: BotSearchMatch, context?: BotSearchOpenContext) => {
    if (context && (!context.isCurrent() || context.signal.aborted)) return
    if (!state.snapshot?.conversations.some((item) => item.id === match.conversationId))
      throw new Error("该对话已不可用，请刷新搜索结果")
    if (match.kind === "message" || match.kind === "link") {
      await navigateToMessage(match.conversationId, match.id, context)
      return
    }
    state.select(match.conversationId)
    if (match.kind === "file")
      setPreviewFile({ id: match.id, conversationId: match.conversationId })
    if (match.kind === "routine") {
      if (!setResource("routines")) return
      setResourceFocus(match.id)
    }
  }

  const sidebar = useMemo(
    () => projectBotSidebar(conversations, bots, query, showHidden),
    [conversations, bots, query, showHidden]
  )
  const visibleConversations = sidebar.conversations
  const openSearch = (scope: typeof searchScope) => {
    setSearchScope(scope)
    setShowSearch(true)
  }
  const adjacent = (direction: number) => {
    const next = resolveAdjacentAgentId(
      visibleConversations.map((item) => item.id),
      conversation?.id ?? "",
      direction < 0 ? "previous" : "next"
    )
    if (next) {
      state.select(next)
      focusComposer()
    }
  }
  const quoteSelection = () => {
    const current = useBotWorkspaceStore.getState()
    const readScope = () => ({
      viewId,
      ...address,
      dataEpoch: current.snapshot?.dataEpoch ?? "initial",
      active:
        current.selected === viewId &&
        normalChatActive &&
        !modalCovered &&
        !resourcePresentationRef.current.busy &&
        !current.sending[viewId] &&
        !current.uploading[viewId] &&
        !!current.host?.capabilities?.includes("selection-quotes-v1"),
      messages: current.messages[viewId] ?? emptyMessages
    })
    const selected = window.getSelection()
    const intent = workspace.current
      ? captureBotMessageQuote(workspace.current, selected, readScope())
      : null
    if (!intent) {
      if (selected && !selected.isCollapsed) toast.info("请在当前消息正文中选择文字后引用。")
      else focusComposer()
      return
    }
    if (
      !currentBotMessageQuote(intent, readScope()) ||
      !quoteInput.current?.insertQuote(intent.quote)
    )
      return
    if (intent.quote.truncated) toast.info("已引用前 20,000 个字符。")
  }
  const shortcuts = botShortcutActions({
    newBot: openNewChat,
    jump: () => setShowPalette(true),
    back: navigationHistory.back,
    forward: navigationHistory.forward,
    sidebar: toggleSidebar,
    tools: bot
      ? () => {
          setResourceFocus(undefined)
          setResource("skills")
        }
      : undefined,
    settings: conversation
      ? () => (bot ? setEditor(bot) : setGroupEditor(conversation))
      : undefined,
    focusInput: newChatActive
      ? () => newChatInput.current?.focus({ preventScroll: true })
      : conversation
        ? () => workspace.current?.querySelector<HTMLElement>(".bot-composer-input")?.focus()
        : undefined,
    selectionQuote:
      conversation &&
      normalChatActive &&
      !modalCovered &&
      state.host?.capabilities?.includes("selection-quotes-v1")
        ? quoteSelection
        : undefined,
    search: state.host?.capabilities?.includes("content-search")
      ? () => openSearch("workspace")
      : undefined,
    find:
      conversation && state.host?.capabilities?.includes("content-search")
        ? () => openSearch("conversation")
        : undefined,
    previous: () => adjacent(-1),
    next: () => adjacent(1),
    focus: (index) => {
      const target = visibleConversations[index]
      if (target) {
        state.select(target.id)
        focusComposer()
      }
    }
  })
  const paletteCommands: BotPaletteCommand[] = [
    {
      id: "filter-sidebar",
      label: "筛选 Bot 列表",
      keywords: ["filter", "list", "列表", "筛选"],
      run: openSidebarFilter
    },
    ...(state.host?.capabilities?.includes("content-search")
      ? [
          {
            id: "search-content",
            label: "搜索全部内容",
            keywords: ["search", "history", "搜索", "消息", "文件", "例程"],
            run: () => openSearch("workspace")
          }
        ]
      : []),
    {
      id: "local-tool-permission",
      label: "本机项目访问",
      keywords: ["permission", "local", "授权", "许可", "电脑"],
      run: () => setShowLocalToolPermission(true)
    },
    {
      id: "sidebar",
      label: compactSidebar ? "展开 Bot 列表" : "收起 Bot 列表",
      keywords: ["sidebar", "布局", "侧栏"],
      run: toggleSidebar
    },
    ...(navigationHistory.canBack
      ? [
          {
            id: "history-back",
            label: "返回上个访问的会话",
            keywords: ["back", "返回", "历史"],
            run: navigationHistory.back
          }
        ]
      : []),
    ...(navigationHistory.canForward
      ? [
          {
            id: "history-forward",
            label: "前进到下个访问的会话",
            keywords: ["forward", "前进", "历史"],
            run: navigationHistory.forward
          }
        ]
      : []),
    {
      id: "new-bot",
      label: "创建 Bot",
      keywords: ["new", "create", "新建"],
      detail: "定义职责与工作范围",
      run: createBot
    },
    ...(bots.length >= minimumGroupMembers
      ? [
          {
            id: "new-group",
            label: "创建协作群聊",
            keywords: ["group", "team", "团队"],
            run: () => {
              setNewChat(null)
              openNewChat(true)
            }
          }
        ]
      : []),
    ...(conversation
      ? [
          {
            id: "chat-settings",
            label: "当前会话设置",
            keywords: ["settings", "members", "成员"],
            detail: conversation.name,
            run: () => (bot ? setEditor(bot) : setGroupEditor(conversation))
          }
        ]
      : []),
    ...(bot
      ? [
          {
            id: "bot-tools",
            label: "当前 Bot 工具",
            keywords: ["skills", "memory", "routine", "browser", "技能", "记忆", "例程", "浏览器"],
            detail: bot.name,
            run: () => {},
            children: [
              {
                id: "skills",
                label: "管理技能",
                keywords: ["skills"],
                run: () => {
                  setResourceFocus(undefined)
                  setResource("skills")
                }
              },
              {
                id: "memory",
                label: "查看记忆",
                keywords: ["memory"],
                run: () => {
                  setResourceFocus(undefined)
                  setResource("memory")
                }
              },
              {
                id: "routines",
                label: "管理例程",
                keywords: ["routine", "schedule"],
                run: () => {
                  setResourceFocus(undefined)
                  setResource("routines")
                }
              },
              {
                id: "browser",
                label: "查看 Bot 浏览器",
                keywords: ["computer", "browser"],
                run: () => setComputerBot(bot.id)
              }
            ]
          }
        ]
      : []),
    ...(window.api.botComputerCheckpoints
      ? [
          {
            id: "computer-checkpoints",
            label: "电脑恢复点",
            keywords: ["checkpoint", "电脑", "完整恢复", "恢复点"],
            run: () => setShowComputerCheckpoints(true)
          }
        ]
      : []),
    ...(window.api.botBackups
      ? [
          {
            id: "backups",
            label: "备份与恢复",
            keywords: ["backup", "restore", "reset", "重置"],
            run: () => setShowBackups(true)
          }
        ]
      : []),
    ...(window.api.botArtifactDownloads
      ? [
          {
            id: "downloads",
            label: "下载与保存",
            keywords: ["download", "保存", "附件"],
            run: openDownloads
          }
        ]
      : []),
    ...(state.host?.capabilities?.includes("usage-budgets")
      ? [
          {
            id: "usage-budget",
            label: "用量与额度",
            keywords: ["usage", "budget", "token", "用量", "额度"],
            run: () => setShowUsageBudget(true)
          }
        ]
      : []),
    {
      id: "app-settings",
      label: "应用与模型设置",
      keywords: ["settings", "model", "模型", "连接器"],
      run: () => useAppStore.getState().setShowCustomizeView(true, "models")
    },
    {
      id: "recovery-records",
      label: "待确认的任务恢复",
      keywords: ["recovery", "receipt", "恢复", "核对", "原记录"],
      run: () => setShowRecoveryRecords(true)
    },
    {
      id: "help",
      label: "Bot 帮助与信息",
      keywords: ["help", "about", "帮助"],
      run: () => setShowHelp(true)
    },
    {
      id: "keyboard",
      label: "Bot 快捷键",
      keywords: ["keyboard", "shortcuts", "快捷键"],
      run: () => setShowKeyboardHelp(true)
    }
  ]

  const resourceContent =
    resource && resourceBot ? (
      <BotResources
        key={`resource:${resourceBot.id}:${resource}`}
        bot={resourceBot}
        tab={resource}
        focusId={resourceFocus}
        routineIntent={routineIntent}
        referencedSkill={referencedSkill}
        presentation={routinePanel ? "panel" : "dialog"}
        back={returnRoutineDetails}
        onPresentationChange={onResourcePresentationChange}
        manageSkills={() => {
          if (!setResource(null)) return
          setResourceFocus(undefined)
          useAppStore.getState().setShowCustomizeView(true, "skills")
        }}
        close={() => {
          if (!setResource(null)) return
          setResourceFocus(undefined)
          if (routinePanel) {
            composerFocusRequested.current = true
            setComputerBot(null)
          }
        }}
      />
    ) : null
  return (
    <div
      ref={workspace}
      className="bot-workspace flex min-w-0 flex-1 bg-background"
      data-testid="bot-workspace"
      data-new-chat-open={newChatActive || undefined}
      onKeyDown={(event) => {
        // React portal events bubble here too: dialog/menu keys belong to their
        // own surface. The computer panel similarly keeps all remote keys.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
        const action = resolveBotWorkspaceShortcut(event.nativeEvent, shortcuts)
        if (!action || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        action.run()
      }}
    >
      {showKeyboardHelp && (
        <BotKeyboardHelp actions={shortcuts} close={() => setShowKeyboardHelp(false)} />
      )}
      {showPrimarySettings && (
        <BotPrimarySettings
          initialMode={primarySettingsInitialMode}
          close={() => {
            setShowPrimarySettings(false)
            setPrimarySettingsInitialMode("guide")
          }}
        />
      )}
      {showHelp && (
        <BotHelp
          host={state.host}
          disconnected={!!state.error}
          refresh={state.refresh}
          close={() => setShowHelp(false)}
          openSettings={() => {
            setShowHelp(false)
            useAppStore.getState().setShowCustomizeView(true, "general")
          }}
          openKeyboard={() => {
            setShowHelp(false)
            setShowKeyboardHelp(true)
          }}
        />
      )}
      {showBackups && (
        <BotBackups
          close={() => setShowBackups(false)}
          openComputer={
            window.api.botComputerCheckpoints
              ? () => {
                  setShowBackups(false)
                  setComputerBot(null)
                  setShowComputerCheckpoints(true)
                }
              : undefined
          }
          openWorkspace={
            window.api.botWorkspaceMaintenance
              ? () => {
                  setShowBackups(false)
                  setComputerBot(null)
                  setShowWorkspaceMaintenance(true)
                }
              : undefined
          }
          openBrowser={
            window.api.botBrowserMaintenance
              ? () => {
                  setShowBackups(false)
                  setComputerBot(null)
                  setShowBrowserMaintenance(true)
                }
              : undefined
          }
        />
      )}
      {showDownloads && state.snapshot?.dataEpoch && (
        <BotDownloads
          client={botArtifactDownloadClient}
          dataEpoch={state.snapshot.dataEpoch}
          visible={documentVisible}
          close={() => setShowDownloads(false)}
        />
      )}
      {showUsageBudget && (
        <BotUsageBudget bots={state.snapshot?.bots ?? []} close={() => setShowUsageBudget(false)} />
      )}
      {showWorkspaceMaintenance && (
        <BotWorkspaceMaintenance close={() => setShowWorkspaceMaintenance(false)} />
      )}
      {showBrowserMaintenance && (
        <BotBrowserMaintenance close={() => setShowBrowserMaintenance(false)} />
      )}
      {showLocalToolPermission && (
        <BotLocalToolPermissionSettings
          supported={["local-tool-permission", "mutation-data-epoch-v2"].every((capability) =>
            state.host?.capabilities?.includes(capability)
          )}
          close={() => setShowLocalToolPermission(false)}
        />
      )}
      {showComputerCheckpoints && (
        <BotComputerCheckpoints
          close={() => setShowComputerCheckpoints(false)}
          onRestored={() => useBotWorkspaceStore.getState().refresh()}
        />
      )}
      {rulesBot && (
        <BotApprovalRules
          key={`rules:${rulesBot.id}`}
          bot={rulesBot}
          autoReview={state.host?.capabilities?.includes("auto-review")}
          denyRules={state.host?.capabilities?.includes("approval-deny-rules")}
          close={() => setRulesBot(null)}
        />
      )}
      {showStorage && state.host?.storage && (
        <BotStorage
          status={state.host.storage}
          close={() => setShowStorage(false)}
          openBackups={
            window.api.botBackups
              ? () => {
                  setShowStorage(false)
                  setShowBackups(true)
                }
              : undefined
          }
        />
      )}
      <aside
        className="bot-sidebar flex shrink-0 flex-col border-r"
        data-compact={compactSidebar || undefined}
      >
        <header className="flex items-center justify-between">
          <h1 className="bot-sidebar-title text-base font-semibold tracking-tight">Bots</h1>
          <div className="bot-sidebar-tools flex items-center gap-1">
            <Button
              ref={paletteTrigger}
              size="icon"
              variant="ghost"
              className="size-8 rounded-full"
              aria-label="搜索工作区"
              title="快速查找与操作"
              onClick={() => setShowPalette(true)}
              onKeyDown={(event) => {
                // Reuse the original Grok sidebar trigger's native key contract.
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.stopPropagation()
                  return
                }
                if (
                  event.defaultPrevented ||
                  event.key.length !== 1 ||
                  event.key === " " ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.altKey ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return
                event.preventDefault()
                setShowPalette(true)
              }}
            >
              <Search size={17} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 rounded-full"
              ref={newChatTrigger}
              aria-label="新建聊天"
              title="新建聊天"
              disabled={quickCreate.state.busy}
              onClick={() => openNewChat()}
            >
              <Plus size={19} />
            </Button>
            <BotWorkspaceMenu
              primary={
                state.host?.capabilities?.includes("primary-bot-v1")
                  ? () => setShowPrimarySettings(true)
                  : undefined
              }
              recoveryRecords={() => setShowRecoveryRecords(true)}
              group={() => openNewChat(true)}
              canGroup={bots.length >= minimumGroupMembers}
              storage={state.host?.storage ? () => setShowStorage(true) : undefined}
              backups={window.api.botBackups ? () => setShowBackups(true) : undefined}
              downloads={window.api.botArtifactDownloads ? openDownloads : undefined}
              usage={
                state.host?.capabilities?.includes("usage-budgets")
                  ? () => setShowUsageBudget(true)
                  : undefined
              }
              hidden={() => setShowHidden(!showHidden)}
              showHidden={showHidden}
              keyboard={() => setShowKeyboardHelp(true)}
              filter={showSidebarFilter ? closeSidebarFilter : openSidebarFilter}
              filtering={showSidebarFilter}
            />
          </div>
        </header>
        {(state.host?.storage?.level === "hard" || state.host?.storage?.level === "soft") && (
          <button
            type="button"
            onClick={() => setShowStorage(true)}
            aria-label={`磁盘空间${state.host.storage.level === "hard" ? "严重" : ""}不足，查看容量与清理入口`}
            title="查看磁盘容量"
            className={cn(
              "bot-storage-notice mx-3 mb-3 flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs",
              state.host.storage.level === "hard"
                ? "bg-destructive/8 text-destructive"
                : "bg-amber-500/8 text-amber-700 dark:text-amber-400"
            )}
          >
            <HardDrive size={15} className="shrink-0" />
            <span>磁盘空间{state.host.storage.level === "hard" ? "严重" : ""}不足</span>
          </button>
        )}
        {showSidebarFilter && (
          <div className="bot-sidebar-search relative mx-3 mb-3">
            <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              ref={sidebarFilterInput}
              className="h-8 pl-8 pr-9 text-xs"
              aria-label="搜索 Bot"
              placeholder="筛选 Bot 或群聊"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Escape" &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault()
                  event.stopPropagation()
                  closeSidebarFilter()
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="清除列表筛选"
              title="清除列表筛选"
              onClick={closeSidebarFilter}
              className="absolute right-1 top-1 size-6 rounded-md text-muted-foreground"
            >
              <X size={13} />
            </Button>
          </div>
        )}
        <nav className="bot-conversation-list flex-1 overflow-y-auto" aria-label="Bot 和群聊">
          <p id="bot-pinned-order-help" className="sr-only">
            可拖动置顶 Bot 调整顺序，或按 Ctrl / Command + Shift + 上下方向键移动。
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            {pinnedOrder.announcement}
          </p>
          {sidebar.entries.map((item) => {
            if (item.kind === "hidden-bots")
              return (
                <BotHiddenConversations
                  key="hidden-bots"
                  count={item.count}
                  expanded={showHidden}
                  toggle={() => setShowHidden((value) => !value)}
                />
              )
            const rowBot = item.kind === "direct" ? sidebar.byBotId.get(item.members[0]) : undefined
            const rowUpdate =
              rowBot &&
              state.host?.capabilities?.includes("bot-update-receipts") &&
              state.host.capabilities.includes("mutation-data-epoch-v2")
                ? async (patch: { pinned?: boolean; hidden?: boolean }) => {
                    const epoch = state.snapshot?.dataEpoch
                    if (useBotWorkspaceStore.getState().snapshot?.dataEpoch !== epoch) return
                    await botApi.update({
                      expectedDataEpoch: epoch,
                      nonce: crypto.randomUUID(),
                      id: rowBot.id,
                      revision: rowBot.revision,
                      ...patch
                    })
                    await useBotWorkspaceStore.getState().refresh()
                  }
                : undefined
            const pinned = !!rowBot?.pinned && !rowBot.hidden
            const work = state.snapshot?.runs.filter((run) => run.conversationId === item.id) ?? []
            const waiting = work.find(
              (run) => run.status === "waiting_input" || run.status === "needs_review"
            )
            const workCount = state.snapshot?.work?.byConversation[item.id]
            const workTotal = workCount?.total ?? work.length
            const persona = state.snapshot?.work?.personas[item.id]
            const waitingReason = workCount
              ? workCount.needsReview
                ? "需要核对现场"
                : workCount.waitingInput
                  ? "等待你处理"
                  : undefined
              : waiting
                ? statusLabel[waiting.status]
                : undefined
            const status = projectSidebarAgentStatus({
              waitingReason,
              hasUnread: !!(item.readState?.unreadCount || item.threadUnreadCount),
              isRunning: workCount
                ? workCount.running > 0
                : work.some((run) => run.status === "running")
            })
            return (
              <BotConversationRowActions
                key={item.id}
                conversationId={item.id}
                dataEpoch={state.snapshot?.dataEpoch ?? "initial"}
                name={item.name}
                bot={
                  rowBot && state.host?.capabilities?.includes("bot-update-receipts")
                    ? rowBot
                    : undefined
                }
                pinned={rowBot?.pinned}
                hidden={rowBot?.hidden}
                pinnedCard={pinned && !query.trim()}
                compact={compactSidebar}
                unread={!!(item.readState?.manuallyUnread || item.readState?.unreadCount)}
                onSettings={() => (rowBot ? setEditor(rowBot) : setGroupEditor(item))}
                onPin={rowUpdate ? (value) => rowUpdate({ pinned: value }) : undefined}
                onHidden={rowUpdate ? (value) => rowUpdate({ hidden: value }) : undefined}
                onDelete={rowBot ? () => requestDelete(rowBot) : undefined}
                onPrimary={
                  rowBot?.id === state.snapshot?.primaryBot?.botId
                    ? () => setShowPrimarySettings(true)
                    : undefined
                }
                onRead={async () => {
                  await useBotWorkspaceStore
                    .getState()
                    .markRead(
                      item.id,
                      item.readState?.latestSequence ?? 0,
                      true,
                      !item.readState?.manuallyUnread && !item.readState?.unreadCount
                    )
                }}
              >
                {(renderName, editingName) => {
                  const rowProps = {
                    "aria-current":
                      address.conversationId === item.id ? ("page" as const) : undefined,
                    className: "bot-list-row",
                    "data-pinned": pinned && !query.trim() ? true : undefined,
                    "aria-label": item.name,
                    title: item.name,
                    "data-unread":
                      !!(item.readState?.unreadCount || item.threadUnreadCount) || undefined
                  }
                  const contents = (
                    <>
                      <span className="bot-list-persona">
                        <BotAvatar
                          agentId={item.members[0] ?? item.id}
                          size="lg"
                          kind={item.kind === "group" ? "group" : "agent"}
                          memberIds={item.members}
                          state={botPersonaState(
                            persona ?? work.find((run) => run.status !== "queued") ?? work[0]
                          )}
                          isStatic={!workTotal && address.conversationId !== item.id}
                        />
                        {(pinned || rowBot?.id === state.snapshot?.primaryBot?.botId) && (
                          <span
                            className="bot-pin-badge"
                            aria-label={
                              rowBot?.id === state.snapshot?.primaryBot?.botId ? "主 Bot" : "已置顶"
                            }
                          >
                            {rowBot?.id === state.snapshot?.primaryBot?.botId ? (
                              <Star size={10} fill="currentColor" />
                            ) : (
                              <Pin size={10} />
                            )}
                          </span>
                        )}
                      </span>
                      <span className="bot-list-row-copy">
                        <span className="block truncate text-sm font-medium">{renderName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {waitingReason
                            ? waiting?.waitingForComputer
                              ? "等待归还浏览器"
                              : waitingReason
                            : state.drafts[item.id]?.prompt
                              ? `草稿 · ${grokTextPreview(state.drafts[item.id].prompt)}`
                              : status.isWorking
                                ? (persona?.activity?.description ??
                                  work.find((run) => run.status === "running")?.activity
                                    ?.description ??
                                  "工作中")
                                : workTotal
                                  ? `${workTotal} 项待办`
                                  : item.kind === "group"
                                    ? `${item.members.length} 个 Bot`
                                    : grokTextPreview(item.lastMessage?.text ?? "") ||
                                      "随时可以交办工作"}
                        </span>
                      </span>
                      <SidebarAgentStatusView
                        waitingReason={
                          waiting
                            ? waiting.waitingForComputer
                              ? "等待归还浏览器"
                              : statusLabel[waiting.status]
                            : undefined
                        }
                        hasUnread={!!(item.readState?.unreadCount || item.threadUnreadCount)}
                        isRunning={status.isWorking}
                        renderIndicator={() => (
                          <span
                            className={cn(
                              "block size-2 rounded-full",
                              waiting ? "bg-amber-500" : "bg-primary"
                            )}
                          />
                        )}
                      />
                    </>
                  )
                  return editingName ? (
                    <div {...rowProps}>{contents}</div>
                  ) : (
                    <button
                      type="button"
                      {...rowProps}
                      {...(item.kind === "direct" && !rowBot?.hidden
                        ? pinnedOrder.props(item.members[0])
                        : {})}
                      onClick={() => state.select(item.id)}
                      onDoubleClick={() => (rowBot ? setEditor(rowBot) : setGroupEditor(item))}
                    >
                      {contents}
                    </button>
                  )
                }}
              </BotConversationRowActions>
            )
          })}
        </nav>
        <footer className="bot-sidebar-footer">
          <div className="bot-sidebar-footer-actions">
            <Button
              variant="outline"
              className="bot-connect-apps"
              aria-label="连接应用"
              title="连接应用"
              onClick={() => useAppStore.getState().setShowCustomizeView(true, "connectors")}
            >
              <Plug size={16} />
              <span>连接应用</span>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-9 shrink-0 rounded-full"
              aria-label="应用设置"
              title="应用设置"
              onClick={() => useAppStore.getState().setShowCustomizeView(true, "general")}
            >
              <Settings2 size={16} />
            </Button>
          </div>
          <div className="bot-sidebar-footer-status">
            {state.errorTrays && (
              <BotErrorTrayStack
                snapshot={state.errorTrays}
                bots={bots}
                activeConversationId={conversation?.id}
                activeThreadRootId={address.threadRootId}
                onDismiss={(id, revision) =>
                  state.dismissErrorTray({
                    hostId: state.errorTrays!.hostId,
                    dataEpoch: state.errorTrays!.dataEpoch,
                    id,
                    revision
                  })
                }
                onClear={(throughRevision) =>
                  state.clearErrorTrays({
                    hostId: state.errorTrays!.hostId,
                    dataEpoch: state.errorTrays!.dataEpoch,
                    throughRevision
                  })
                }
                onOpenRun={(tray) => {
                  if (tray.runId && tray.conversationId)
                    setHistoryRun({
                      runId: tray.runId,
                      conversationId: tray.conversationId,
                      ...(tray.threadRootId ? { threadRootId: tray.threadRootId } : {})
                    })
                }}
                onRestoreFocus={() =>
                  workspace.current
                    ?.querySelector<HTMLElement>(".bot-composer-input")
                    ?.focus({ preventScroll: true })
                }
              />
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 rounded-full"
              aria-label="本机项目访问"
              title="本机项目访问"
              onClick={() => setShowLocalToolPermission(true)}
            >
              <ShieldCheck size={15} />
            </Button>
            <button
              type="button"
              className="bot-host-status"
              onClick={() => setShowHelp(true)}
              aria-label="Bot 帮助"
              title={state.error ? "后台连接中断，查看诊断" : "查看后台状态与帮助"}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  state.error
                    ? "bg-amber-500"
                    : state.host
                      ? "bg-emerald-500"
                      : "bg-muted-foreground animate-pulse motion-reduce:animate-none"
                )}
              />
              <span>{state.error ? "连接中断" : state.host ? "本机运行" : "连接中…"}</span>
            </button>
            <Button
              size="icon"
              variant="ghost"
              className="bot-sidebar-toggle size-8 rounded-full"
              aria-label={compactSidebar ? "展开 Bot 列表" : "收起 Bot 列表"}
              title={compactSidebar ? "展开 Bot 列表" : "收起 Bot 列表"}
              onClick={toggleSidebar}
            >
              {compactSidebar ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </div>
        </footer>
      </aside>
      <main className="bot-conversation relative flex min-w-0 flex-1 flex-col">
        <BotViewVisibilityContext.Provider value={normalChatActive}>
          <div
            className="bot-conversation-primary"
            data-exchange-open={!!activeExchange || undefined}
            data-new-chat-open={newChatActive || undefined}
            inert={!!activeExchange || newChatActive}
            aria-hidden={!!activeExchange || newChatActive || undefined}
          >
            {state.error && (
              <div
                className="flex items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm text-destructive"
                role="alert"
              >
                <AlertCircle size={16} />
                <BotErrorNoticeBody
                  className="flex-1"
                  notice={state.errorNotice ?? { message: state.error }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void state.refresh().catch(report)}
                >
                  <RefreshCw size={14} />
                  重连
                </Button>
              </div>
            )}
            {!conversation ? (
              <BotWelcome
                loading={!state.snapshot}
                disconnected={!!state.error}
                botCount={bots.length}
                create={createBot}
                settings={() => useAppStore.getState().setShowCustomizeView(true, "models")}
                help={() => setShowHelp(true)}
                showBots={() => {
                  setShowHidden(true)
                  setQuery("")
                  if (conversations[0]) state.select(conversations[0].id)
                }}
                primary={
                  !state.error &&
                  state.host?.capabilities?.includes("primary-bot-v1") &&
                  state.host.capabilities.includes("mutation-data-epoch-v2") &&
                  state.snapshot?.primaryBot !== undefined &&
                  state.snapshot.primaryBot.dataEpoch === state.snapshot.dataEpoch &&
                  state.snapshot.primaryBot.botId === null
                    ? (mode) => {
                        setPrimarySettingsInitialMode(mode)
                        setShowPrimarySettings(true)
                      }
                    : undefined
                }
              />
            ) : (
              <>
                <header className="bot-header">
                  <div className="bot-header-leading">
                    {!address.threadRootId &&
                      conversation.threadUnreadRootId &&
                      state.host?.capabilities?.includes("message-threads") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="查看未读分支"
                          title={`${conversation.threadUnreadCount} 条分支未读回复`}
                          className="mr-1 gap-1.5 text-xs"
                          onClick={() => openThread(conversation.threadUnreadRootId!)}
                        >
                          <GitBranch size={15} />
                          <span className="hidden sm:inline">分支未读</span>
                          <span className="rounded-full bg-primary/10 px-1.5 text-primary">
                            {conversation.threadUnreadCount}
                          </span>
                        </Button>
                      )}
                  </div>
                  <button
                    type="button"
                    className="bot-header-identity"
                    aria-label={bot ? "查看 Bot 详情" : "查看群聊详情"}
                    title={bot ? "查看 Bot 详情" : "查看群聊详情"}
                    onClick={() => {
                      if (bot) showBotDetails(bot.id)
                      else {
                        setComputerBotState(null)
                        setInspectorGroupId(conversation.id)
                      }
                    }}
                  >
                    <BotAvatar
                      agentId={bot?.id ?? conversation.id}
                      kind={conversation.kind === "group" ? "group" : "agent"}
                      memberIds={conversation.members}
                      state={botPersonaState(
                        runs.find((run) => run.status !== "queued") ?? runs[0]
                      )}
                      size="md"
                    />
                    <h2 className="truncate font-semibold">{conversation.name}</h2>
                  </button>
                  <BotActions
                    onPrimary={
                      state.host?.capabilities?.includes("primary-bot-v1")
                        ? () => setShowPrimarySettings(true)
                        : undefined
                    }
                    bot={bot}
                    notificationAction={
                      bot &&
                      state.snapshot?.dataEpoch &&
                      state.host?.capabilities?.includes("notifications") ? (
                        <BotNotificationAction
                          key={`${bot.id}:${state.snapshot.dataEpoch}`}
                          botId={bot.id}
                          dataEpoch={state.snapshot.dataEpoch}
                        />
                      ) : undefined
                    }
                    unread={!!viewReadState?.unreadCount}
                    onRead={() =>
                      void state
                        .markRead(
                          viewId,
                          viewReadState?.latestSequence ?? 0,
                          true,
                          !viewReadState?.unreadCount
                        )
                        .catch(report)
                    }
                    onClone={() => void cloneBot()}
                    cloning={cloning}
                    cloneUnavailableReason={
                      state.host?.capabilities?.includes("clone-epoch")
                        ? undefined
                        : "请更新并重启 Bot 后台后再复制。"
                    }
                    computerOpen={computerBot === bot?.id && inspectorTab === "computer"}
                    onFiles={() => setShowFiles(true)}
                    onSecrets={() => bot && setSecretBot({ id: bot.id, name: bot.name })}
                    onApprovalRules={
                      bot && state.host?.capabilities?.includes("approval-rules")
                        ? () => setRulesBot(bot)
                        : undefined
                    }
                    onAvatar={
                      bot && state.host?.capabilities?.includes("avatar-images")
                        ? () => setAvatarBot(bot)
                        : undefined
                    }
                    onComputer={() =>
                      bot &&
                      setComputerBot(
                        computerBot === bot.id && inspectorTab === "computer" ? null : bot.id
                      )
                    }
                    onResource={setResource}
                    onAsyncTasks={
                      bot && state.host?.capabilities?.includes("async-tasks")
                        ? () => setAsyncBot({ id: bot.id, name: bot.name })
                        : undefined
                    }
                    onImportContext={
                      state.host?.capabilities?.includes("context-import") && bot
                        ? () => setImportBot(bot)
                        : undefined
                    }
                    onSettings={() => (bot ? setEditor(bot) : setGroupEditor(conversation))}
                    onUpdate={(patch) => {
                      if (!bot) return
                      if (!state.host?.capabilities?.includes("mutation-data-epoch-v2")) {
                        report(new Error("请先重启最新后台，再修改 Bot。"))
                        return
                      }
                      const epoch = state.snapshot?.dataEpoch
                      if (useBotWorkspaceStore.getState().snapshot?.dataEpoch !== epoch) return
                      void mutate(() =>
                        botApi.update({
                          id: bot.id,
                          revision: bot.revision,
                          expectedDataEpoch: epoch,
                          ...patch
                        })
                      )
                    }}
                    onDelete={() => bot && requestDelete(bot)}
                  />
                </header>
                {address.threadRootId && (
                  <section aria-label="分支讨论" className="border-b bg-muted/20 px-5 py-3">
                    <div className="mx-auto flex max-w-3xl items-start gap-3">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="返回主对话"
                        title="返回主对话"
                        onClick={returnToMain}
                      >
                        <ArrowLeft size={17} />
                      </Button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <GitBranch size={15} />
                          分支讨论
                          <span className="text-xs font-normal text-muted-foreground">
                            {thread?.count ?? 0} 条回复
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                          {thread?.root.text ?? "正在加载讨论起点…"}
                        </p>
                      </div>
                    </div>
                  </section>
                )}
                {state.host && !state.host.runtimeReady && (
                  <p
                    role="status"
                    className="border-b bg-amber-500/5 px-5 py-2 text-xs text-amber-700 dark:text-amber-400"
                  >
                    {state.host.error || "执行服务尚未就绪，已提交的工作会保留在队列中。"}
                  </p>
                )}
                {state.opening[viewId] && replyJump?.conversationId === viewId && (
                  <div
                    role="status"
                    aria-label="正在定位消息"
                    aria-live="polite"
                    data-message-target={replyJump.id}
                    className="flex shrink-0 items-center justify-between border-b px-5 py-2 text-xs text-muted-foreground"
                  >
                    <span>正在定位消息…</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 rounded-full px-2 text-xs"
                      aria-label="取消消息定位"
                      onClick={() => {
                        detachTranscript()
                        syncHistoryReading()
                      }}
                    >
                      取消
                    </Button>
                  </div>
                )}
                <div ref={bindTranscript} className="bot-transcript min-h-0 flex-1 overflow-y-auto">
                  <div
                    className="bot-transcript-content"
                    style={userBubbleTint}
                    data-user-bubble-tint={!!userBubbleTint || undefined}
                  >
                    {state.transcriptError?.viewId === viewId && (
                      <section
                        role="alert"
                        aria-label="消息读取失败"
                        className="mx-auto my-8 flex max-w-lg items-start gap-3 rounded-2xl border border-border/70 bg-muted/30 p-4"
                      >
                        <AlertCircle size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <p className="text-sm font-medium">暂时无法读取消息</p>
                          <BotErrorNoticeBody notice={state.transcriptError} />
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            disabled={state.opening[viewId]}
                            onClick={() => state.retryMessages(viewId)}
                          >
                            <RefreshCw size={13} />
                            重试读取消息
                          </Button>
                        </div>
                      </section>
                    )}
                    {state.hasOlder[viewId] && (
                      <Button
                        variant="ghost"
                        className="w-full"
                        disabled={state.loadingOlder[viewId]}
                        onClick={loadEarlier}
                      >
                        {state.loadingOlder[viewId] ? "正在加载…" : "加载更早消息"}
                      </Button>
                    )}
                    {!messages.length && !state.transcriptError && (
                      <div className="bot-empty-conversation">
                        <BotAvatar
                          agentId={bot?.id ?? conversation.id}
                          kind={conversation.kind === "group" ? "group" : "agent"}
                          memberIds={conversation.members}
                          size="xl"
                          state="idle"
                          isFollowingPointer
                        />
                        <h3>{conversation.name}</h3>
                        <p>{bot?.instructions || "交办目标，并说明你希望拿到的结果。"}</p>
                        {bot && !address.threadRootId && !state.opening[viewId] && (
                          <BotFirstTask
                            hasProject={!!bot.workspacePath}
                            connectorCount={bot.connectorIds?.length ?? 0}
                            disabled={
                              !!state.error || !!state.pending[viewId] || !!state.sending[viewId]
                            }
                            suggest={(prompt) => {
                              const current = useBotWorkspaceStore.getState()
                              if (current.drafts[viewId]?.prompt.trim()) {
                                toast.info("当前已有草稿，请先发送或清空后再选择任务。")
                              } else if (!current.pending[viewId] && !current.sending[viewId]) {
                                current.draft(viewId, prompt)
                              }
                              document.getElementById("bot-composer-" + viewId)?.focus()
                            }}
                            computer={() => setComputerBot(bot.id)}
                            settings={() => setEditor(bot)}
                          />
                        )}
                      </div>
                    )}
                    <BotTranscriptList
                      viewId={viewId}
                      messages={messages}
                      scrollParent={scrollParent}
                      listRef={transcriptList}
                      initialLocation={initialTranscriptLocation}
                      onRowsRendered={rowsRendered}
                      onHeightChanged={followTranscriptTail}
                      renderMessage={(message, index) => {
                        const inlineKeys = messageInlineReferenceKeys(message)
                        const remainingRecipients = (message.recipientReferences ?? []).filter(
                          (recipient) => !inlineKeys.has(`recipient:${recipient.botId}`)
                        )
                        const remainingSkills = (message.skillReferences ?? []).filter(
                          (skill) =>
                            !inlineKeys.has(
                              botInlineReferenceIdentity({
                                ...skill,
                                kind: "skill"
                              })
                            )
                        )
                        return (
                          <Fragment key={message.id}>
                            {message.sequence === unreadAnchor && (
                              <div
                                role="separator"
                                aria-label="未读消息起点"
                                data-unread-sequence={message.sequence}
                                className="bot-unread-divider"
                              >
                                以下是未读消息
                              </div>
                            )}
                            <BotMessageTime
                              createdAt={message.createdAt}
                              previous={messages[index - 1]?.createdAt}
                            />
                            <article
                              className="bot-message"
                              data-sender={message.sender}
                              data-message-id={message.id}
                              tabIndex={-1}
                              data-message-sequence={message.sequence}
                              data-entering={message.id === messages.at(-1)?.id || undefined}
                            >
                              <div className="bot-message-meta">
                                {message.sender === "bot" ? (
                                  <BotMessageAuthor
                                    bot={authors.get(message.botId ?? "")}
                                    botId={message.botId ?? "bot"}
                                    group={conversation.kind === "group"}
                                    conversationId={authorConversations.get(message.botId ?? "")}
                                    open={(id) => {
                                      state.select(id)
                                      focusComposer()
                                    }}
                                  />
                                ) : (
                                  <span>
                                    {message.sender === "user"
                                      ? "你"
                                      : message.importedContext
                                        ? "导入的参考记录"
                                        : "任务状态"}
                                  </span>
                                )}
                                <time dateTime={new Date(message.createdAt).toISOString()}>
                                  {new Date(message.createdAt).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit"
                                  })}
                                </time>
                                {message.steering && (
                                  <span role="status" className="text-xs text-muted-foreground">
                                    {botSteeringLabels[message.steering.state]}
                                  </span>
                                )}
                              </div>
                              <BotReplyQuote
                                message={message}
                                open={(id) => void jumpToReply(id)}
                              />
                              <div
                                className="bot-message-bubble"
                                data-introduction-question={
                                  message.introductionQuestion?.status === "pending" || undefined
                                }
                                data-reply-highlight={highlightedReply === message.id || undefined}
                              >
                                {message.peerExchanges?.length &&
                                state.host?.capabilities?.includes("peer-exchange-v1") ? (
                                  <BotPeerExchangeLinks
                                    links={message.peerExchanges}
                                    open={(link, trigger) => {
                                      if (
                                        link.anchor.conversationId === conversation.id &&
                                        link.anchor.threadRootId === address.threadRootId
                                      ) {
                                        peerTrigger.current = {
                                          node: trigger,
                                          viewId,
                                          epoch: state.snapshot?.dataEpoch ?? "initial"
                                        }
                                        setPeerExchange(link)
                                      }
                                    }}
                                  />
                                ) : (
                                  message.peerDelivery && (
                                    <BotPeerExchangeHeader delivery={message.peerDelivery} />
                                  )
                                )}
                                <BotEntityReferences
                                  references={message.entityReferences?.filter(
                                    (reference) =>
                                      !inlineKeys.has(botInlineReferenceIdentity(reference))
                                  )}
                                  open={(reference) => {
                                    if (
                                      reference.conversationId &&
                                      conversations.some(
                                        (item) => item.id === reference.conversationId
                                      )
                                    )
                                      state.select(reference.conversationId)
                                  }}
                                />
                                {!!remainingRecipients.length && (
                                  <div
                                    className="mb-2 flex flex-wrap gap-1.5"
                                    aria-label="本条消息的接收者"
                                  >
                                    {remainingRecipients.map((recipient) => (
                                      <span
                                        key={recipient.botId}
                                        className="bot-skill-chip"
                                        title="发送时选择的 Bot"
                                      >
                                        <BotAvatar agentId={recipient.botId} size="xs" isStatic />@
                                        {recipient.name}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {!!remainingSkills.length && !message.skillTrial && (
                                  <div className="mb-2 flex flex-wrap gap-1.5">
                                    {remainingSkills.map((skill) => (
                                      <button
                                        type="button"
                                        key={`${skill.botId}:${skill.id}`}
                                        className="bot-skill-chip rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                        title={`${bots.find((bot) => bot.id === skill.botId)?.name ?? "Bot"} · ${message.sender === "bot" ? "保存的技能版本" : "发送时选择的技能版本"}`}
                                        aria-label={`查看技能 ${skill.name}`}
                                        onClick={() => openReferencedSkill(skill)}
                                      >
                                        /{skill.name}{" "}
                                        <span className="text-muted-foreground">
                                          v{skill.version}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {message.routineOutcome && (
                                  <BotRoutineOutcome
                                    outcome={message.routineOutcome}
                                    disabled={
                                      !routineOutcomeIntent({
                                        message,
                                        conversation,
                                        threadRootId: address.threadRootId,
                                        dataEpoch: state.snapshot?.dataEpoch ?? "initial",
                                        bots,
                                        active:
                                          normalChatActive &&
                                          !modalCovered &&
                                          !resourcePresentationRef.current.busy,
                                        capabilities: state.host?.capabilities
                                      })
                                    }
                                    open={() => {
                                      const current = useBotWorkspaceStore.getState()
                                      if (current.selected !== viewId) return
                                      const target = routineOutcomeIntent({
                                        message,
                                        conversation: current.snapshot?.conversations.find(
                                          (item) => item.id === address.conversationId
                                        ),
                                        threadRootId: address.threadRootId,
                                        dataEpoch: current.snapshot?.dataEpoch ?? "initial",
                                        bots: current.snapshot?.bots ?? [],
                                        active:
                                          normalChatActive &&
                                          !modalCovered &&
                                          !resourcePresentationRef.current.busy,
                                        capabilities: current.host?.capabilities
                                      })
                                      if (!target) return
                                      openRoutineView(target.botId, target.intent)
                                    }}
                                  />
                                )}
                                {message.routineOutcome ||
                                message.introductionQuestion ? null : message.importedContext ? (
                                  <BotImportedContext message={message} />
                                ) : message.sender === "bot" ? (
                                  <div data-bot-quote-source={message.id}>
                                    <StreamingMarkdown>{message.text}</StreamingMarkdown>
                                  </div>
                                ) : message.skillTrial ? (
                                  <BotSkillTrialMessage
                                    trial={message.skillTrial}
                                    text={message.text}
                                  />
                                ) : (
                                  <div
                                    data-bot-quote-source={
                                      message.sender !== "system" ? message.id : undefined
                                    }
                                  >
                                    <BotMessageText
                                      message={message}
                                      reveal={highlightedReply === message.id}
                                      openQuote={(id) => void jumpToReply(id)}
                                      openSkill={openReferencedSkill}
                                      conversationFor={(reference) => {
                                        if (reference.kind === "recipient")
                                          return authorConversations.get(reference.id)
                                        const target = message.entityReferences?.find(
                                          (item) =>
                                            item.kind === reference.kind && item.id === reference.id
                                        )?.conversationId
                                        return target &&
                                          conversations.some((item) => item.id === target)
                                          ? target
                                          : undefined
                                      }}
                                      open={(id) => {
                                        state.select(id)
                                        focusComposer()
                                      }}
                                    />
                                  </div>
                                )}
                                {message.introductionQuestion && (
                                  <BotIntroductionQuestion
                                    key={`${message.introductionQuestion.runId}:${state.snapshot?.dataEpoch}`}
                                    question={message.introductionQuestion}
                                  />
                                )}
                                <BotMessageLinkPreview
                                  message={message}
                                  cache={linkPreviews}
                                  active={normalChatActive}
                                  openExternal={openBotPreviewLink}
                                />
                                <BotMessageAttachments
                                  message={message}
                                  saveFile={
                                    window.api.botArtifactDownloads
                                      ? (id, artifact) =>
                                          void downloadBotFile(id, artifact, openDownloads)
                                      : undefined
                                  }
                                  openImage={(id, media, trigger, mediaGroup) =>
                                    setPreviewFile({
                                      id,
                                      conversationId: conversation.id,
                                      media,
                                      mediaGroup,
                                      trigger,
                                      viewId,
                                      epoch: state.snapshot?.dataEpoch ?? "initial"
                                    })
                                  }
                                  openFile={(id, expectedArtifact, trigger) =>
                                    setPreviewFile({
                                      id,
                                      conversationId: conversation.id,
                                      expectedArtifact,
                                      trigger,
                                      viewId,
                                      epoch: state.snapshot?.dataEpoch ?? "initial"
                                    })
                                  }
                                />
                                {message.pluginNotice && (
                                  <aside
                                    aria-label="插件任务提示"
                                    className={cn(
                                      "mt-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground",
                                      message.pluginNotice.failed && "border-amber-500/50"
                                    )}
                                  >
                                    <span className="mb-1 block font-medium">插件提示</span>
                                    {message.pluginNotice.text}
                                  </aside>
                                )}
                              </div>
                              <div className="bot-message-actions">
                                <BotReactions message={message} />
                                {message.runId &&
                                  (conversation.kind === "group" ||
                                    message.botId === conversation.members[0]) &&
                                  state.host?.capabilities?.includes("run-history") && (
                                    <button
                                      type="button"
                                      className="bot-reply-action"
                                      aria-label="查看任务记录"
                                      title="查看任务记录"
                                      onClick={() =>
                                        setHistoryRun({
                                          runId: message.runId!,
                                          conversationId: conversation.id,
                                          threadRootId: address.threadRootId
                                        })
                                      }
                                    >
                                      <Activity size={14} />
                                    </button>
                                  )}

                                {message.sender === "user" && message.text && (
                                  <button
                                    type="button"
                                    className="bot-reply-action"
                                    aria-label="复制消息全文"
                                    title="复制消息全文"
                                    onClick={() => {
                                      void navigator.clipboard
                                        .writeText(message.text)
                                        .then(() => toast.success("已复制消息全文"), report)
                                    }}
                                  >
                                    <Copy size={14} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="bot-reply-action"
                                  aria-label="复制消息链接"
                                  title="复制消息链接（当前本机工作区）"
                                  onClick={() => {
                                    void navigator.clipboard
                                      .writeText(
                                        botMessageLink({
                                          conversationId: message.conversationId,
                                          messageId: message.id
                                        })
                                      )
                                      .then(
                                        () =>
                                          toast.success("已复制消息链接，可定位到当前本机工作区"),
                                        report
                                      )
                                  }}
                                >
                                  <Link2 size={14} />
                                </button>
                                {!address.threadRootId &&
                                  state.host?.capabilities?.includes("message-threads") &&
                                  message.sender !== "system" && (
                                    <button
                                      type="button"
                                      className="bot-reply-action"
                                      aria-label="开始分支讨论"
                                      title="开始分支讨论"
                                      onClick={() => openThread(message.id)}
                                    >
                                      <GitBranch size={14} />
                                    </button>
                                  )}
                                {state.host?.capabilities?.includes("message-replies") &&
                                  message.sender !== "system" && (
                                    <button
                                      type="button"
                                      className="bot-reply-action"
                                      aria-label="回复此消息"
                                      title="回复此消息"
                                      onClick={() => {
                                        state.reply(viewId, message.id)
                                        document.getElementById(`bot-composer-${viewId}`)?.focus()
                                      }}
                                    >
                                      <Reply size={14} />
                                    </button>
                                  )}
                              </div>
                              {!address.threadRootId &&
                                !!message.threadSummary?.count &&
                                state.host?.capabilities?.includes("message-threads") &&
                                message.sender !== "system" && (
                                  <button
                                    type="button"
                                    className="mt-1 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={
                                      message.threadSummary?.count
                                        ? `查看分支 ${message.threadSummary.count} 条回复`
                                        : "开始分支讨论"
                                    }
                                    onClick={() => openThread(message.id)}
                                  >
                                    <GitBranch size={13} />
                                    {message.threadSummary?.count
                                      ? `${message.threadSummary.count} 条回复`
                                      : "分支讨论"}
                                    {!!message.threadSummary?.readState.unreadCount && (
                                      <span
                                        aria-label="分支有未读回复"
                                        className="size-1.5 rounded-full bg-primary"
                                      />
                                    )}
                                  </button>
                                )}
                            </article>
                          </Fragment>
                        )
                      }}
                    />
                    {state.hasNewer[viewId] && (
                      <Button
                        variant="ghost"
                        className="w-full"
                        disabled={state.loadingNewer[viewId]}
                        onClick={() => {
                          captureHistoryAnchor()
                          void state.loadNewer(viewId).catch(report)
                        }}
                      >
                        {state.loadingNewer[viewId] ? "正在加载…" : "加载后续消息"}
                      </Button>
                    )}
                    <BotConversationTasks
                      key={`tasks:${viewId}:${state.snapshot?.dataEpoch ?? "initial"}`}
                      scope={{
                        conversationId: conversation.id,
                        threadRootId: address.threadRootId,
                        dataEpoch: state.snapshot?.dataEpoch ?? "initial"
                      }}
                      runs={runs}
                      workCounts={workCounts}
                      serverPage={modernWork ? state.taskPage : undefined}
                      onPageOpen={modernWork ? openTaskPage : undefined}
                      onPageMove={moveTaskPage}
                      onPageRetry={retryWorkPage}
                      outputs={state.runOutputs}
                      expandedOutputId={state.expandedTaskOutputId}
                      onExpandedOutput={state.expandTaskOutput}
                      onLoadOutput={() => void state.refresh().catch(report)}
                      bots={bots}
                      conversationKind={conversation.kind}
                      canViewHistory={state.host?.capabilities?.includes("run-history") ?? false}
                      onHistory={setHistoryRun}
                      onReview={setRecoveryRun}
                      onCancel={async (id) => {
                        await botApi.cancel(id)
                        await useBotWorkspaceStore.getState().refresh()
                      }}
                    />
                    {state.host?.capabilities?.includes("plugin-panes") &&
                      conversation.members.map((botId) => (
                        <BotPluginPanes
                          key={JSON.stringify([
                            botId,
                            address.conversationId,
                            address.threadRootId,
                            state.snapshot?.dataEpoch
                          ])}
                          address={{
                            botId,
                            conversationId: conversation.id,
                            threadRootId: address.threadRootId
                          }}
                          dataEpoch={state.snapshot?.dataEpoch ?? "initial"}
                        />
                      ))}
                    {modernWork && workCounts && (
                      <PendingWorkCards
                        key={`pending:${viewId}:${state.snapshot?.dataEpoch}`}
                        descriptors={pendingDescriptors}
                        total={workCounts.pending}
                        refresh={state.refresh}
                        openComputerHelp={setComputerHelpView}
                      />
                    )}
                    {interactions.map((item) => (
                      <div key={item.id} className="mb-3">
                        {runs.find((run) => run.id === item.runId)?.workflowTask && (
                          <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
                            子任务 ·{" "}
                            {runs.find((run) => run.id === item.runId)?.workflowTask?.label}
                          </p>
                        )}
                        <InteractionCard
                          item={item}
                          run={runs.find((run) => run.id === item.runId)}
                          refresh={state.refresh}
                          openComputerHelp={setComputerHelpView}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mx-auto w-full max-w-3xl px-5 pb-4">
                  {conversation.kind === "group" && (
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">交给</span>
                      <button
                        type="button"
                        className="bot-recipient-chip"
                        aria-pressed={!recipients.length}
                        onClick={() => setRecipients([])}
                      >
                        全体 Bot
                      </button>
                      {conversation.members.map((id) => (
                        <button
                          type="button"
                          className="bot-recipient-chip"
                          aria-pressed={recipients.includes(id)}
                          key={id}
                          onClick={() =>
                            setRecipients((current) =>
                              current.includes(id)
                                ? current.filter((member) => member !== id)
                                : [...current, id]
                            )
                          }
                        >
                          <BotAvatar agentId={id} size="xs" isStatic />
                          {bots.find((b) => b.id === id)?.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <BotComposer
                    key={viewId}
                    conversationId={viewId}
                    controls={quoteInput}
                    recipients={recipients}
                    working={workCounts ? workCounts.total > 0 : runs.length > 0}
                    onTeach={(botId) => {
                      const current = useBotWorkspaceStore.getState()
                      const latest = current.snapshot?.conversations.find(
                        (item) => item.id === conversation.id
                      )
                      if (
                        current.selected !== viewId ||
                        !current.snapshot ||
                        current.snapshot.dataEpoch !== state.snapshot?.dataEpoch ||
                        !latest ||
                        latest.revision !== conversation.revision ||
                        !latest.members.includes(botId) ||
                        !current.snapshot.bots.some(
                          (bot) => bot.id === botId && bot.deletedAt === null
                        )
                      )
                        return
                      const chosen = computerBackend.current
                      const native =
                        chosen?.botId === botId &&
                        chosen.backend === "windows-native" &&
                        chosen.hostId === current.host?.hostId &&
                        chosen.hostEpoch === (current.host?.dataEpoch ?? "initial") &&
                        chosen.dataEpoch === (current.snapshot.dataEpoch ?? "initial") &&
                        current.host?.capabilities?.includes("windows-native-computer")
                      setComputerBot(botId)
                      setTeachArm({
                        ...(native ? { backend: "windows-native" as const } : {}),
                        dataEpoch: current.snapshot.dataEpoch ?? "initial",
                        viewId,
                        botId,
                        conversationId: latest.id,
                        conversationRevision: latest.revision,
                        ...(address.threadRootId ? { threadRootId: address.threadRootId } : {})
                      })
                    }}
                    onEditorReady={restoreComposerFocus}
                    onAttachmentReady={acceptNewChatFiles}
                    handoffNotice={
                      newChat?.phase === "handoff" && newChat.error && !newChat.handoff?.accepted
                        ? {
                            message: newChat.error,
                            back: () => {
                              const live = newChatOwner.current,
                                current = useBotWorkspaceStore.getState()
                              if (!live || !isNewChatCurrent() || current.uploading[viewId]) return
                              const revision = crypto.randomUUID()
                              setNewChat({
                                ...live,
                                phase: "editing",
                                handoff: undefined,
                                error: undefined,
                                originViewId: current.selected,
                                originViewportGeneration: current.viewportLease?.generation ?? null,
                                revision,
                                draft: { ...live.draft, revision }
                              })
                            }
                          }
                        : undefined
                    }
                  />
                </div>
              </>
            )}
          </div>
        </BotViewVisibilityContext.Provider>
        {newChatActive && (
          <BotNewChat
            conversations={conversations.flatMap((item) => {
              const member = item.kind === "direct" ? authors.get(item.members[0]) : undefined
              return member
                ? [
                    {
                      id: item.id,
                      name: member.name,
                      detail: member.instructions.slice(0, 400),
                      group: false,
                      hidden: !!member.hidden,
                      memberIds: item.members
                    }
                  ]
                : []
            })}
            composer={
              newChat && (
                <BotNewChatComposer
                  session={newChat}
                  covered={!documentVisible || modalCovered}
                  navigationGuard={!conversation}
                  read={() => (isNewChatCurrent() ? newChatOwner.current : null)}
                  commit={commitNewChat}
                  changedFocus={setNewChatMessageFocused}
                />
              )
            }
            listHidden={newChatMessageFocused}
            groupPane={
              newChat?.groupMode && (
                <BotNewChatGroup
                  key={newChat.openNonce}
                  bots={bots}
                  covered={!documentVisible || modalCovered}
                  inputRef={newChatInput}
                  close={closeNewChat}
                  back={() => {
                    const live = newChatOwner.current
                    if (live && isNewChatCurrent())
                      commitNewChat(live.revision, { groupMode: false })
                  }}
                  owner={newChatGroupOwner}
                />
              )
            }
            busy={quickCreate.state.busy}
            covered={!documentVisible || modalCovered}
            canGroup={bots.length >= minimumGroupMembers}
            inputRef={newChatInput}
            choose={chooseNewChatConversation}
            create={(nameHint) => {
              if (isNewChatCurrent()) void startBotCreation(nameHint)
            }}
            group={() => {
              if (
                isNewChatCurrent() &&
                (useBotWorkspaceStore.getState().snapshot?.bots.length ?? 0) >= minimumGroupMembers
              )
                openNewChat(true)
            }}
            close={closeNewChat}
          />
        )}
        {activeExchange && (
          <BotViewVisibilityContext.Provider
            value={documentVisible && !modalCovered && !newChatActive}
          >
            <BotPeerExchange
              key={botPeerExchangeKey({
                anchor: activeExchange.anchor,
                peerRunId: activeExchange.peerRunId,
                ...(activeExchange.mergedMessageId
                  ? { mergedMessageId: activeExchange.mergedMessageId }
                  : {}),
                expectedDataEpoch: state.snapshot?.dataEpoch ?? "initial"
              })}
              link={activeExchange}
              dataEpoch={state.snapshot?.dataEpoch ?? "initial"}
              presentation="workspace"
              close={closePeerExchange}
            />
          </BotViewVisibilityContext.Provider>
        )}
      </main>
      {computerHelpView && (
        <BotComputerHelpViewer
          key={computerHelpView.item.id}
          {...computerHelpView}
          refresh={state.refresh}
          close={() =>
            setComputerHelpView((current) => (current === computerHelpView ? null : current))
          }
        />
      )}
      {inspectorGroup && (
        <BotViewVisibilityContext.Provider
          value={documentVisible && !modalCovered && !newChatActive}
        >
          <BotGroupInspector
            key={`group-inspector:${inspectorGroup.id}`}
            group={inspectorGroup}
            bots={bots}
            settings={() => setGroupEditor(inspectorGroup)}
            openBot={(botId) => {
              const current = useBotWorkspaceStore.getState()
              if (current.snapshot?.dataEpoch !== state.snapshot?.dataEpoch) return
              const group = current.snapshot?.conversations.find(
                (item) => item.id === inspectorGroup.id && item.kind === "group"
              )
              const direct = current.snapshot?.conversations.find(
                (item) => item.kind === "direct" && item.members.includes(botId)
              )
              if (!group?.members.includes(botId) || !direct) return
              current.select(direct.id)
              focusComposer()
            }}
            showDownloads={openDownloads}
            onExitAutoFocus={restoreComposerFocus}
            close={() => {
              composerFocusRequested.current = true
              setInspectorGroupId(null)
            }}
          />
        </BotViewVisibilityContext.Provider>
      )}
      {computerBot && bots.some((item) => item.id === computerBot) && (
        <BotInspector
          key={`inspector:${computerBot}`}
          bot={bots.find((item) => item.id === computerBot)!}
          tab={inspectorTab}
          onTabChange={(tab) => {
            const current = useBotWorkspaceStore.getState()
            if (
              inspectorNavigationPending ||
              current.selected !== viewId ||
              botInspectorPreferenceScope(current.host?.sharedWorkspace) !==
                inspectorPreferenceScope ||
              current.snapshot?.dataEpoch !== state.snapshot?.dataEpoch ||
              !current.snapshot?.bots.some((item) => item.id === computerBot)
            )
              return
            if (tab !== "computer") setTeachArm(null)
            const scope = botInspectorPreferenceScope(current.host?.sharedWorkspace)
            const cache = inspectorPreferencesFor(scope)
            cache.preferences = botInspectorPreferences.remember(
              scope,
              cache.preferences,
              computerBot,
              tab
            )
            setInspectorTab(tab)
          }}
          teachArm={teachArm}
          onComputerBackendChange={(backend) => {
            const current = useBotWorkspaceStore.getState()
            computerBackend.current = {
              botId: computerBot,
              backend,
              hostId: current.host?.hostId,
              hostEpoch: current.host?.dataEpoch ?? "initial",
              dataEpoch: current.snapshot?.dataEpoch ?? "initial"
            }
          }}
          onTeachPrepared={() => setTeachArm((current) => (current === teachArm ? null : current))}
          cancelTeachPreparation={() =>
            setTeachArm((current) => (current === teachArm ? null : current))
          }
          onExitAutoFocus={restoreComposerFocus}
          onFullScreenExitAutoFocus={() => {
            const current = useBotWorkspaceStore.getState()
            const input = workspace.current?.querySelector<HTMLElement>(".bot-composer-input")
            if (
              current.selected !== viewId ||
              current.snapshot?.dataEpoch !== state.snapshot?.dataEpoch ||
              !input?.getClientRects().length ||
              input.closest("[inert]")
            )
              return
            input.focus({ preventScroll: true })
          }}
          conversationId={
            conversation?.members.includes(computerBot)
              ? conversation.id
              : state.snapshot!.conversations.find(
                  (item) => item.kind === "direct" && item.members.includes(computerBot)
                )!.id
          }
          threadRootId={
            conversation?.members.includes(computerBot) ? address.threadRootId : undefined
          }
          settings={() => setEditor(bots.find((item) => item.id === computerBot)!)}
          covered={modalCovered || newChatActive || inspectorNavigationPending}
          routineDetail={routinePanel ? resourceContent : undefined}
          resource={(tab, intent) => {
            const snapshot = useBotWorkspaceStore.getState().snapshot
            if (intent && (!snapshot || intent.dataEpoch !== (snapshot.dataEpoch ?? "initial")))
              return
            if (tab === "routines" && intent?.mode === "view") {
              openRoutineView(computerBot, intent)
              return
            }
            if (!setResource(tab, computerBot)) return
            setResourceFocus(intent?.id)
            setRoutineIntent(intent)
          }}
          showDownloads={openDownloads}
          close={() => {
            composerFocusRequested.current = true
            setComputerBot(null)
          }}
        />
      )}
      {asyncBot && (
        <BotAsyncTasks
          key={`async:${asyncBot.id}:${state.snapshot?.dataEpoch}`}
          bot={asyncBot}
          close={() => setAsyncBot(null)}
        />
      )}
      {avatarBot && (
        <BotAvatarEditor
          key={`avatar:${avatarBot.id}:${state.snapshot?.dataEpoch}`}
          bot={avatarBot}
          close={() => setAvatarBot(null)}
        />
      )}
      {historyRun && (
        <BotRunHistory
          key={`history:${historyRun.runId}`}
          address={historyRun}
          close={() => setHistoryRun(null)}
        />
      )}
      {recoveryRun && (
        <BotRecovery run={recoveryRun} close={() => setRecoveryRun(null)} refresh={state.refresh} />
      )}
      {showRecoveryRecords && <BotRecoveryRecords close={() => setShowRecoveryRecords(false)} />}
      {showFiles && conversation && (
        <BotFiles
          key={`files:${conversation.id}`}
          conversationId={conversation.id}
          close={() => setShowFiles(false)}
          showDownloads={openDownloads}
        />
      )}
      {previewFile && (
        <BotFilePreview
          key={`preview:${previewFile.conversationId}:${previewFile.mediaGroup ? JSON.stringify(previewFile.mediaGroup) : previewFile.id}`}
          {...previewFile}
          selectMedia={(id) => {
            const current = useBotWorkspaceStore.getState()
            if (
              current.selected !== previewFile.viewId ||
              (current.snapshot?.dataEpoch ?? "initial") !== previewFile.epoch
            )
              return
            const media = previewFile.mediaGroup?.find((image) => image.id === id)
            if (media)
              setPreviewFile((current) =>
                current === previewFile ? { ...current, id, media } : current
              )
          }}
          close={() => setPreviewFile(null)}
          showDownloads={openDownloads}
          onCloseAutoFocus={(event) => {
            if (!previewFile.trigger) return
            event.preventDefault()
            const current = useBotWorkspaceStore.getState()
            if (
              current.selected === previewFile.viewId &&
              (current.snapshot?.dataEpoch ?? "initial") === previewFile.epoch &&
              previewFile.trigger?.isConnected &&
              workspace.current?.contains(previewFile.trigger)
            )
              previewFile.trigger.focus({ preventScroll: true })
          }}
        />
      )}
      {secretBot && (
        <BotSecrets
          key={`secrets:${secretBot.id}`}
          botId={secretBot.id}
          name={secretBot.name}
          close={() => setSecretBot(null)}
        />
      )}
      <BotQuickCreateFeedback
        state={quickCreate.state}
        dataEpoch={state.snapshot?.dataEpoch ?? "initial"}
        open={quickCreateFeedbackOpen}
        close={() => {
          quickCreate.cancelReview()
          setQuickCreateFeedbackOpen(false)
        }}
        confirmReview={quickCreate.confirmReview}
        retry={() => startBotCreation()}
        repair={quickCreate.repair}
        onCloseAutoFocus={(event) => {
          const expected = creationFocus.current,
            current = useBotWorkspaceStore.getState()
          if (
            !expected ||
            current.selected !== expected.id ||
            current.snapshot?.dataEpoch !== expected.dataEpoch ||
            current.viewportLease?.generation !== expected.generation
          )
            return
          event.preventDefault()
          composerFocusRequested.current = true
          restoreComposerFocus()
          creationFocus.current = null
        }}
      />
      {editor && (
        <BotEditor
          key={`editor:${editor === "new" ? "new" : editor.id}`}
          bot={editor === "new" ? undefined : editor}
          close={() => setEditor(null)}
          created={state.select}
        />
      )}
      {groupEditor && (
        <BotGroupEditor
          key={`group-editor:${groupEditor === "new" ? "new" : groupEditor.id}`}
          group={groupEditor === "new" ? undefined : groupEditor}
          bots={bots}
          close={() => setGroupEditor(null)}
          created={(id) => {
            state.select(id)
          }}
        />
      )}
      {importBot && (
        <BotContextImport
          key={`import:${importBot.id}`}
          bot={importBot}
          close={() => setImportBot(null)}
          onImported={(conversationId, messageId) => {
            setImportBot(null)
            useBotWorkspaceStore.setState({
              navigation: { conversationId, messageId }
            })
            void state.refresh().catch(report)
          }}
        />
      )}
      {!routinePanel && resourceContent}
      {showSearch && (
        <BotSearchDialog
          conversation={conversation}
          initialKind={searchScope === "bots" ? "bot" : "message"}
          initialOnlyConversation={searchScope === "conversation"}
          close={() => setShowSearch(false)}
          open={openSearchMatch}
        />
      )}
      {showPalette && (
        <BotCommandPalette
          conversations={conversations.map((item) => {
            const member =
              item.kind === "direct"
                ? bots.find((value) => value.id === item.members[0])
                : undefined
            return {
              id: item.id,
              name: member?.name ?? item.name,
              detail: member?.instructions.slice(0, 400) ?? "协作群聊",
              group: item.kind === "group",
              hidden: !!member?.hidden,
              memberIds: item.members
            }
          })}
          commands={paletteCommands}
          searchEnabled={!!state.host?.capabilities?.includes("content-search")}
          openConversation={(id) => {
            state.select(id)
            focusComposer()
          }}
          openMatch={openSearchMatch}
          close={() => setShowPalette(false)}
        />
      )}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {deleteTarget?.name}？</DialogTitle>
            <DialogDescription>
              该 Bot
              将从工作区移除，排队任务和未来例程停止。已有记录会保留；正在执行的任务需要先停止并结算。
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            onClick={() => {
              if (deleteTarget)
                void mutate(async () => {
                  await botApi.delete({
                    id: deleteTarget.id,
                    revision: deleteTarget.revision,
                    expectedDataEpoch: deleteTarget.expectedDataEpoch
                  })
                  setDeleteTarget(null)
                })
            }}
          >
            删除 Bot
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
