import React, {
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useState,
  useSyncExternalStore
} from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import type { VirtuosoHandle } from "react-virtuoso"
import {
  Send,
  Square,
  AlertCircle,
  X,
  FileText,
  Code2,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Info,
  Database,
  Layers,
  Clock,
  Notebook,
  Zap,
  Sparkles,
  Wrench,
  CircleAlert,
  FilePenLine,
  Plus,
  Loader2,
  CornerDownLeft,
  Flag,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  Trash2,
  Copy,
  Workflow,
  GitFork,
  FolderOpen,
  Paperclip,
  CornerDownRight,
  MoreHorizontal,
  GripVertical,
  Pencil,
  ListEnd,
  Check
} from "lucide-react"
import type { FileAttachment, QueuedMessage } from "@/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { useAppStore } from "@/lib/store"
import {
  consumePendingHarnessNextAction,
  getPendingHarnessNextAction,
  getPendingHarnessNextActionVersion,
  subscribePendingHarnessNextActions
} from "@/lib/harness-next-action"
import { cn } from "@/lib/utils"
import {
  getAppleIntelligenceGlowEnabled,
  subscribeAppleIntelligenceGlow
} from "@/lib/apple-intelligence-glow"
import { useShallow } from "zustand/react/shallow"
import {
  useCurrentThread,
  useThreadStream,
  useThreadContext,
  type ApiErrorDetailState
} from "@/lib/thread-context"
import { filterCoordinatorNoiseMessages } from "@/lib/message-display-helpers"
import { canChangeThreadAgentMode } from "@/lib/agent-mode-switch-availability"
import { getWorkerToolUiKey } from "@/lib/worker-tool-result-key"
import {
  messageHasVisibleRow,
  normalizeVisibleReasoningText
} from "@/lib/message-display-visibility"
import {
  isCoordinatorModeMetadata,
  isMultiModeMetadata,
  isWorkflowModeMetadata
} from "@/lib/coordinator-mode-helpers"
import { ModelSwitcher } from "./ModelSwitcher"
import { AgentModeSwitcher, type ChatAgentMode } from "./AgentModeSwitcher"
import { WorkflowRunPanel, WorkflowHistoryButton } from "./WorkflowRunPanel"
import { SandboxModeSwitcher } from "./SandboxModeSwitcher"
import { MemorySessionSwitcher } from "./MemorySessionSwitcher"
import { ThreadRemoteAccessSwitcher } from "./ThreadRemoteAccessSwitcher"
import { OutputStyleSwitcher } from "./OutputStyleSwitcher"
import { WorkspacePicker } from "./WorkspacePicker"
import { ChatTodos } from "./ChatTodos"
import { ContextUsageIndicator } from "./ContextUsageIndicator"
import {
  getSystemConstraintsLoadCounts,
  hasNoLoadedSystemConstraints,
  SystemConstraintsPreviewPopover
} from "@/components/panels/SystemConstraintsPanel"
import type {
  GoalUiState,
  ForkableCheckpoint,
  HarnessHumanGateSnapshot,
  Message,
  SkillMetadata,
  Thread,
  ThreadForkOverrides,
  ToolCallState,
  ToolCallStatus,
  UserInputResponse
} from "@/types"
import {
  CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD,
  ChatMessageVirtualList,
  shouldVirtualizeChatMessageList,
  type ChatApprovalDecision
} from "./ChatMessageVirtualList"
import { ChatScrollNavigator } from "./ChatScrollNavigator"
import { ChatScrollToBottomButton } from "./ChatScrollToBottomButton"
import {
  ChatSearchOverlay,
  type DurableChatSearchOptions,
  type DurableChatSearchMatch,
  type DurableChatSearchPage
} from "./ChatSearchOverlay"
import { chatScrollSessionStore, type ChatScrollSessionAnchor } from "./chat-scroll-session-store"
import { WelcomeSkills } from "./WelcomeSkills"
import { SkillCreateConfirmDialog, type SkillConfirmRequest } from "./SkillCreateConfirmDialog"
import { UserInputRequestDialog, type UserInputRequestDialogLayout } from "./UserInputRequestDialog"
import { AgentGitCommitDialog, type AgentCommitOutcome } from "./AgentGitCommitDialog"
import { ContextReminderController, isContextReminderPending } from "./ContextReminderController"
import { uploadChatData } from "@/api"
import { insertLog } from "../../../js/mmjUtils"
import { toast } from "sonner"
import { SlashCommandPopover } from "@/features/slash-commands/SlashCommandPopover"
import { formatHookClockTime, HOOK_TIME_ZONE_LABEL } from "../../../../shared/hook-time"
import {
  getBuiltinBrowserTitleSource,
  isBuiltinBrowserCommandSelection,
  parseBuiltinBrowserEditDraft,
  resolveBuiltinBrowserVisibleUserText,
  shouldRemoveBuiltinBrowserChipWithBackspace
} from "@/features/builtin-browser/chat-integration"
import {
  isBareGoalSlashCommandInput,
  isGoalSlashControlCommandInput,
  isGoalSlashResumeCommandInput,
  isGoalSlashTransportSensitiveControlCommandInput,
  isGoalTerminatingControlCommandInput,
  resolveGoalRuntimeComposerState,
  useSlashCommands,
  type SlashCommandItem
} from "@/features/slash-commands/useSlashCommands"
import {
  removeAtFileTokenFromInput,
  useAtFileMentions,
  type AtFileSuggestion
} from "@/features/mentions/useAtFileMentions"
import { AtFileMentionPopover } from "@/features/mentions/AtFileMentionPopover"
import {
  readBoundedWorkspaceMentionFile,
  retainMentionedWorkspaceFilesForWorkspace,
  resolveAtFileAttachments,
  resolveAtFileSelection,
  type MentionedWorkspaceFile
} from "@/features/mentions/atFileAttachments"
import { MentionFileChip } from "@/features/mentions/MentionFileChip"
import { DEFAULT_IM_CHANNEL_ID } from "../../../../shared/im-gateway-contract"
import { splitGoalTransportPayload } from "../../../../shared/goal-slash"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  type SelectedAttachmentFileGrant
} from "../../../../shared/file-attachment"
import { cleanUserAttachmentContentForDisplay } from "../../../../shared/user-attachment-display"
import { getCollapsedToolCallSummary } from "../../../../shared/tool-call-summary"
import { projectVisibleChatSearchContent } from "../../../../shared/chat-search-visible-content"
import { stripThinkBlocksForDisplay } from "../../../../shared/think-block-display"
import { resolveChatSearchContiguousTailStart } from "@/lib/chat-search-gap-boundary"
import { createMessageIdIndexLookup, type MessageIdIndexLookup } from "@/lib/lazy-message-id-index"
import { BuiltinBrowserChip } from "@/features/builtin-browser/BuiltinBrowserChip"
import { SkillChip } from "@/features/slash-commands/skill-chip"
import { selectSkillForSlashName } from "@/features/slash-commands/skill-merge"
import { formatSkillUseBlock, parseSkillUseBlock } from "@/features/slash-commands/skill-marker"
import {
  ensureDisabledSkillsChangedInvalidationSource,
  ensureSkillsChangedInvalidationSource,
  isSkillCatalogFresh,
  projectChatSkillCatalog,
  readSkillCatalogCache,
  revalidateSkillCatalog,
  subscribeSkillCatalogInvalidation,
  type ChatSkillCatalogProjection
} from "@/lib/app-catalog-cache"
import { readHarnessBoardCatalogCache } from "@/components/harness-board/harness-board-cache"
import {
  getQueuedModelContent,
  getQueuedDisplayContent,
  getQueuedPreview,
  guardCoordinatorPlainText,
  canClaimQueuedMessage,
  classifyGuidedMessage
} from "@/lib/queued-message-content"
import { getSkillMetadataId, isSkillDisabled } from "@/lib/skill-ids"
import { formatGoalEventMessage, isVisibleCheckpointTranscriptMessage } from "@/lib/goal-transcript"
import { buildGoalPanelViewModel, goalVerdictTone } from "@/lib/goal-panel-view"
import { buildLatestChatReportBatch, type ChatReportBatch } from "@/lib/chat-report-batch"
import {
  markChatReportUploadFailed,
  markChatReportUploadSucceeded,
  reserveChatReportMessageIds
} from "@/lib/chat-report-upload-cache"
import {
  resolveGoalControlSubmitRoute,
  shouldClearPendingApprovalAfterGoalControl
} from "@/lib/goal-control-submit"
import {
  getSubmitInFlightReleaseVersion,
  releaseSubmitInFlightLock,
  shouldQueueBehindInFlightSubmit,
  shouldUseSubmitInFlightLock,
  subscribeSubmitInFlightRelease,
  tryAcquireSubmitInFlightLock,
  type SubmitInFlightLockRef
} from "@/lib/submit-in-flight-lock"
import { GitBranchSwitcher } from "./GitBranchSwitcher"
import { ProcessingDuration } from "./ProcessingDuration"
import { ContextCompactionCard } from "./ContextCompactionCard"
import { HookLogModal } from "./HookLogViews"
import {
  shouldHydrateDurableSearchMatch,
  type ChatSearchCorpus,
  type ChatSearchDocument
} from "@/lib/chat-search-matches"
import { createChatMessageProjector } from "@/lib/chat-message-projection"
import { getChatThreadProjectionRuntime } from "@/lib/chat-thread-projection-cache"
import {
  chatScrollTailMessageIdentity,
  classifyChatScrollTailChange,
  shouldMarkChatTailContentGrowth
} from "@/lib/chat-scroll-tail-change"
import {
  buildBoundedChatSearchText,
  CHAT_SEARCH_DOCUMENT_TEXT_LIMIT
} from "@/lib/bounded-chat-search-text"
import { buildStreamingMarkdownPreview } from "@/lib/streaming-markdown-schedule"
import { continueWorkspaceFilesDeduped, loadWorkspaceFilesDeduped } from "@/lib/workspace-file-load"
import {
  createChatScrollState,
  isChatScrollDetached,
  mergeChatScrollEffects,
  shouldFollowChatOutput,
  transitionChatScroll,
  type ChatScrollEffect,
  type ChatScrollEvent,
  type ChatScrollState,
  type ChatScrollTransition
} from "../../../../shared/chat-scroll-controller"
import {
  isProjectModeAgentTeamEnabled,
  isProjectModeAgentTeamSelectionDisabled
} from "../../../../shared/project-mode-agent-team"

const PROJECT_MODE_AGENT_TEAM_ENABLED = isProjectModeAgentTeamEnabled(
  import.meta.env.VITE_PROJECT_MODE_AGENT_TEAM_ENABLED
)
const REMOTE_THREAD_TIP_DISMISSALS_STORAGE_KEY = "chat:remote-thread-tip-dismissals"

function loadRemoteThreadTipDismissals(): Set<string> {
  try {
    const raw = sessionStorage.getItem(REMOTE_THREAD_TIP_DISMISSALS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((threadId): threadId is string => typeof threadId === "string"))
  } catch {
    return new Set()
  }
}

function persistRemoteThreadTipDismissals(threadIds: Set<string>): void {
  try {
    sessionStorage.setItem(REMOTE_THREAD_TIP_DISMISSALS_STORAGE_KEY, JSON.stringify([...threadIds]))
  } catch {
    // Tip dismissal is a best-effort, renderer-session-only preference.
  }
}
const CHAT_AT_BOTTOM_THRESHOLD_PX = 32
const CHAT_SCROLL_UP_DETACH_DELTA_PX = 1
const CHAT_USER_SCROLL_INTENT_WINDOW_MS = 350
const CHAT_BOTTOM_SETTLE_MAX_FRAMES = 60
const CHAT_FOLLOW_SETTLE_MAX_FRAMES = 12
const CHAT_HISTORY_ANCHOR_MAX_FRAMES = 120
const CHAT_HISTORY_ANCHOR_STABLE_FRAMES = 12
const CHAT_SESSION_ANCHOR_STABLE_FRAMES = 2
const CHAT_LOCAL_SEARCH_HISTORY_LIMIT = 500
const CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT = 4 * 1024 * 1024

function awaitWorkspaceMentionLoad<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const error = new Error("Workspace mention load was cancelled")
    error.name = "AbortError"
    return Promise.reject(error)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort)
      const error = new Error("Workspace mention load was cancelled")
      error.name = "AbortError"
      reject(error)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

interface PendingDurableHistoryAnchor {
  threadId: string
  generation: number
  messageId: string
  viewportTop: number
  previousMessageCount: number
  previousLoadedMessageCount: number
  attempt: number
  stableFrames: number
}

interface PendingChatSessionAnchor extends ChatScrollSessionAnchor {
  threadId: string
  attempt: number
  stableFrames: number
}

function interruptionNoticeCopy(
  event: string,
  action: string
): {
  title: string
  explanation: string
} {
  if (event.startsWith("Failure fuse")) {
    return {
      title: "工具失败熔断已停止本轮",
      explanation: "这是工具失败熔断结果，不是应用崩溃。你可以调整策略后发送新消息继续对话。"
    }
  }
  if (event.startsWith("Tool-call loop")) {
    return {
      title: "重复工具调用熔断已停止本轮",
      explanation:
        "这是重复工具调用熔断结果，不是 Hook 策略或应用崩溃。你可以调整策略后发送新消息继续对话。"
    }
  }
  return {
    title: action === "halt" ? "Hook 已停止本轮" : "Hook 已阻断本轮",
    explanation: "这是 Hook 策略结果，不是 Agent 运行错误。你可以发送新消息继续对话。"
  }
}

function formatGoalDuration(createdAt: number, updatedAt: number, active: boolean): string {
  const end = active ? Date.now() : updatedAt
  const seconds = Math.max(0, Math.round((end - createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

function goalStatusView(status: "active" | "paused" | "complete"): {
  label: string
  icon: React.JSX.Element
  className: string
} {
  if (status === "complete") {
    return {
      label: "已完成",
      icon: <CheckCircle2 className="size-4 text-emerald-600" />,
      className: "text-status-nominal"
    }
  }
  if (status === "paused") {
    return {
      label: "已暂停",
      icon: <PauseCircle className="size-4 text-amber-600" />,
      className: "text-status-warning"
    }
  }
  return {
    label: "进行中",
    icon: <Flag className="size-4 text-sky-600" />,
    className: "text-status-info"
  }
}

function goalEventTimeLabel(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : ""
}

function GoalStatusPanel({
  goalUi,
  open,
  onOpenChange,
  onCommand,
  onEditGoal
}: {
  goalUi: GoalUiState
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommand: (command: string) => void
  onEditGoal: () => void
}): React.JSX.Element | null {
  const goal = goalUi.goal
  if (!goal) return null

  const status = goalStatusView(goal.status)
  const panel = buildGoalPanelViewModel(goalUi)
  if (!panel) return null
  const {
    latestEvents,
    canPause,
    canResume,
    progressPercent,
    contextText,
    progressItems: allProgressItems,
    evidenceItems: allEvidenceItems,
    blockerItems: allBlockerItems,
    hasLedgerDetails,
    verdictLabel,
    evaluatorReason,
    recentEventSummary
  } = panel
  const duration = formatGoalDuration(goal.createdAt, goal.updatedAt, goal.status === "active")

  return (
    <TooltipProvider delayDuration={180}>
      <div className="relative mx-auto mb-2 max-w-3xl">
        <div
          className={cn(
            "flex items-center gap-3 rounded-2xl border border-border bg-background-elevated/90 px-3 py-2 shadow-[0_14px_42px_rgba(0,0,0,0.12)] backdrop-blur-2xl dark:shadow-[0_16px_42px_rgba(0,0,0,0.28)]",
            status.className
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => onOpenChange(!open)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background-interactive shadow-[0_6px_18px_rgba(0,0,0,0.10)] ring-1 ring-border">
              {status.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 text-sm font-semibold">Goal {status.label}</span>
                <span className="shrink-0 rounded-full border border-border bg-background-interactive/85 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {duration} · {goal.turnsUsed}/{goal.maxTurns} 轮
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs opacity-80">{goal.objective}</span>
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full bg-background-interactive/90 text-foreground/70 ring-1 ring-border transition-colors hover:bg-secondary hover:text-foreground"
                  onClick={onEditGoal}
                  aria-label="编辑 Goal"
                >
                  <FilePenLine className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>编辑目标</TooltipContent>
            </Tooltip>
            {canPause && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded-full bg-background-interactive/90 text-foreground/70 ring-1 ring-border transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => onCommand("/goal pause")}
                    aria-label="暂停 Goal"
                  >
                    <PauseCircle className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>暂停</TooltipContent>
              </Tooltip>
            )}
            {canResume && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded-full bg-background-interactive/90 text-foreground/70 ring-1 ring-border transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => onCommand("/goal resume")}
                    aria-label="继续 Goal"
                  >
                    <PlayCircle className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>继续</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full bg-background-interactive/90 text-foreground/70 ring-1 ring-border transition-colors hover:bg-secondary hover:text-foreground"
                  onClick={() => onOpenChange(!open)}
                  aria-label="查看 Goal 详情"
                >
                  <Info className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>详情</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full bg-background-interactive/90 text-foreground/70 ring-1 ring-border transition-colors hover:bg-secondary hover:text-foreground"
                  onClick={() => onCommand("/goal clear")}
                  aria-label="清除 Goal"
                >
                  <Trash2 className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>清除</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {open && (
          <div className="fixed bottom-24 right-5 top-16 z-40 flex w-[min(480px,calc(100vw-40px))] flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-[0_24px_80px_rgba(0,0,0,0.22)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
            <div className="border-b border-border bg-background-elevated px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex size-10 items-center justify-center rounded-full bg-background-interactive shadow-sm ring-1 ring-border">
                      {status.icon}
                    </span>
                    <div className="text-lg font-semibold text-foreground">Goal {status.label}</div>
                    <div className="rounded-full border border-border bg-background-interactive px-2 py-0.5 text-xs text-muted-foreground">
                      {duration} · {goal.turnsUsed}/{goal.maxTurns} 轮
                    </div>
                    <div
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium",
                        goalVerdictTone(goal.lastVerdict)
                      )}
                    >
                      最近判断：{verdictLabel}
                    </div>
                  </div>
                  <div className="mt-3 line-clamp-2 text-sm leading-6 text-foreground/80">
                    {goal.objective}
                  </div>
                </div>
                <button
                  type="button"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background-interactive text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenChange(false)}
                  aria-label="关闭 Goal 详情"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-background-interactive">
                <div
                  className={cn(
                    "h-full rounded-full",
                    goal.status === "complete"
                      ? "bg-emerald-500"
                      : goal.status === "paused"
                        ? "bg-amber-500"
                        : "bg-sky-500"
                  )}
                  style={{ width: `${Math.max(4, progressPercent)}%` }}
                />
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-5 py-4 text-sm break-words [overflow-wrap:anywhere]">
              <section
                className={cn(
                  "min-w-0 overflow-hidden rounded-2xl border p-4 shadow-[inset_0_1px_0_var(--border)]",
                  goalVerdictTone(goal.lastVerdict)
                )}
              >
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <Sparkles className="size-4" />
                  Evaluator 最近判断
                </div>
                <div className="whitespace-pre-wrap break-words text-base leading-7 text-foreground/90 [overflow-wrap:anywhere]">
                  {evaluatorReason}
                </div>
                <div className="mt-3 rounded-xl bg-background-interactive/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  这里展示的是 evaluator 根据最近一轮 assistant 回复、工具结果和持久化 ledger
                  做出的判断。它解释为什么 Goal 会继续、暂停或完成。
                </div>
              </section>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-background-elevated p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Flag className="size-4" />
                  目标与完成标准
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      当前目标
                    </div>
                    <div className="whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">
                      {goal.objective}
                    </div>
                  </div>
                  {goal.completionCondition !== goal.objective && (
                    <div className="border-t border-border pt-3">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        完成条件
                      </div>
                      <div className="whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">
                        {goal.completionCondition}
                      </div>
                    </div>
                  )}
                  {contextText && (
                    <div className="border-t border-border pt-3">
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        <Notebook className="size-3.5" />
                        启动上下文
                      </div>
                      <div className="whitespace-pre-wrap break-words leading-6 text-foreground/80 [overflow-wrap:anywhere]">
                        {contextText}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-background-elevated p-4">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Layers className="size-4" />
                  进展与证据
                </div>
                <div className="mb-3 text-xs leading-5 text-muted-foreground">
                  以下条目来自 evaluator 返回的 ledger_patch，是它从对话、工具结果和 assistant
                  验证摘要里提炼出的判断依据。
                </div>

                {!hasLedgerDetails ? (
                  <div className="rounded-xl border border-dashed border-border bg-background-interactive/70 px-3 py-4 text-center text-xs text-muted-foreground">
                    暂无 ledger 条目。下一轮评估后会在这里记录进展、证据或阻塞。
                  </div>
                ) : (
                  <div className="space-y-4">
                    {allProgressItems.length > 0 && (
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground/80">
                          <CheckCircle2 className="size-3.5 text-emerald-600" />
                          已确认进展
                        </div>
                        <ol className="space-y-2">
                          {allProgressItems.map((item, index) => (
                            <li key={`progress-${index}`} className="flex min-w-0 gap-2 leading-5">
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-status-nominal/10 text-[11px] font-semibold text-status-nominal">
                                {index + 1}
                              </span>
                              <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/85 [overflow-wrap:anywhere]">
                                {item}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {allEvidenceItems.length > 0 && (
                      <div className="border-t border-border pt-4">
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground/80">
                          <Database className="size-3.5 text-sky-600" />
                          证据
                        </div>
                        <ol className="space-y-2">
                          {allEvidenceItems.map((item, index) => (
                            <li key={`evidence-${index}`} className="flex min-w-0 gap-2 leading-5">
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-status-info/10 text-[11px] font-semibold text-status-info">
                                {index + 1}
                              </span>
                              <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/85 [overflow-wrap:anywhere]">
                                {item}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {allBlockerItems.length > 0 && (
                      <div className="border-t border-border pt-4">
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground/80">
                          <CircleAlert className="size-3.5 text-amber-600" />
                          未解决问题
                        </div>
                        <ol className="space-y-2">
                          {allBlockerItems.map((item, index) => (
                            <li key={`blocker-${index}`} className="flex min-w-0 gap-2 leading-5">
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-status-warning/10 text-[11px] font-semibold text-status-warning">
                                {index + 1}
                              </span>
                              <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/85 [overflow-wrap:anywhere]">
                                {item}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-background-elevated p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Clock className="size-4" />
                  最近事件
                </div>
                <div className="mb-3 rounded-xl bg-background-interactive/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  最近一条：{recentEventSummary}
                </div>
                <details>
                  <summary className="cursor-pointer list-none rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40">
                    展开事件历史（{latestEvents.length}）
                  </summary>
                  {latestEvents.length === 0 ? (
                    <div className="mt-3 rounded-lg bg-background-interactive/70 px-3 py-2 text-xs text-muted-foreground">
                      暂无事件
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {latestEvents.map((event) => (
                        <div
                          key={event.event_id}
                          className="border-l-2 border-border-emphasis pl-3"
                        >
                          <div className="mb-1 text-[11px] text-muted-foreground">
                            {goalEventTimeLabel(event.created_at)}
                          </div>
                          <div className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground/80 [overflow-wrap:anywhere]">
                            {formatGoalEventMessage(event.message)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              </section>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border bg-background-elevated px-5 py-3">
              <button
                type="button"
                className="rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
                onClick={() => onCommand("/goal")}
              >
                刷新状态
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                  onClick={onEditGoal}
                >
                  编辑
                </button>
                {canPause && (
                  <button
                    type="button"
                    className="rounded-xl bg-foreground px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
                    onClick={() => onCommand("/goal pause")}
                  >
                    暂停
                  </button>
                )}
                {canResume && (
                  <button
                    type="button"
                    className="rounded-xl bg-foreground px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
                    onClick={() => onCommand("/goal resume")}
                  >
                    继续
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-xl border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                  onClick={() => onCommand("/goal clear")}
                >
                  清除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

interface AgentStreamValues {
  todos?: Array<{ id?: string; content?: string; status?: string }>
}

export type ChatSurface = "default" | "harness-project" | "harness-feature-session"

interface ChatSurfaceConfig {
  showWelcomeHeadline: boolean
  showWelcomeSkillTabs: boolean
  showHarnessDialogTips: boolean
}

const CHAT_SURFACE_CONFIG: Record<ChatSurface, ChatSurfaceConfig> = {
  default: {
    showWelcomeHeadline: true,
    showWelcomeSkillTabs: true,
    showHarnessDialogTips: false
  },
  "harness-project": {
    showWelcomeHeadline: false,
    showWelcomeSkillTabs: true,
    showHarnessDialogTips: true
  },
  "harness-feature-session": {
    showWelcomeHeadline: false,
    showWelcomeSkillTabs: false,
    showHarnessDialogTips: false
  }
}

interface ChatContainerProps {
  threadId: string
  showGitChangeNotice?: boolean
  surface?: ChatSurface
  hideWelcomeSkillTabs?: boolean
  readOnlyReason?: string | null
  onOpenGitPanel?: () => void
  onDismissGitChangeNotice?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
  onHarnessSessionCreated?: (threadId: string) => void
}

interface SkillIntentBannerRequest {
  requestId: string
  summary: string
  toolCallCount: number
  turnCount: number
  mode: "mode_a_rule" | "mode_b_llm"
  recommendationReason?: string
  /** Opaque context — cached so the retry button can replay generation without a new threshold. */
  context: unknown
}

function mergeToolCallArgs(
  baseArgs?: Record<string, unknown>,
  liveArgs?: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(baseArgs || {}),
    ...(liveArgs || {})
  }
}

function getToolCallFilePath(args?: Record<string, unknown>): string | undefined {
  const path = args?.path ?? args?.file_path
  return typeof path === "string" && path.trim() ? path : undefined
}

function getToolCallCommand(args?: Record<string, unknown>): string | undefined {
  return typeof args?.command === "string" && args.command.trim() ? args.command : undefined
}

function getToolCallCode(args?: Record<string, unknown>): string | undefined {
  return typeof args?.code === "string" && args.code.trim() ? args.code : undefined
}

function getToolCallTimeout(args?: Record<string, unknown>): number | undefined {
  return typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined
}

function isTerminalToolCallStatus(status?: ToolCallStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "rejected"
  )
}

const THINKING_MESSAGES = [
  "我先想想...",
  "让我捋一捋...",
  "我去翻翻代码...",
  "我来找线索...",
  "先做个判断...",
  "我再核对一下...",
  "先把思路摊开...",
  "我来拼一下答案...",
  "我再压一遍细节...",
  "先看下上下文...",
  "我再过一遍日志...",
  "我来换个角度...",
  "先把重点抓出来...",
  "让我算一轮...",
  "我再确认一下...",
  "我先试条路...",
  "我去查个依据...",
  "我先把话说准...",
  "我再补一刀...",
  "我来收个尾...",
  "先别急，快到了...",
  "差最后一段了...",
  "我再润一润...",
  "再给我两秒...",
  "我来给你个稳妥版...",
  "我先把坑绕开...",
  "我再压压风险...",
  "先把答案打磨下...",
  "马上给你结果...",
  "就快好了..."
]

const SUPPORTED_EXTS = new Set([".txt", ".md", ".csv", ".docx", ".xlsx", ".xls"])
const ATTACH_FILE_POPOVER_CONTENT = (
  <div className="space-y-1">
    <div>1. 添加文件 (txt, md, csv, docx, xlsx)</div>
    <div>2. doc文件：不要直接改后缀，在文件系统“另存为”docx之后，再选择上传。</div>
  </div>
)
const DOC_SAVE_AS_DOCX_HINT = "doc文件不要直接改后缀，在文件系统“另存为”docx之后上传。"
const MAX_ATTACHMENTS = 3
const MAX_TOTAL_CHARS = 24_000
const AT_FILE_PREVIEW_LANE = "chat-at-file-submit"
/** 输入框正文硬上限(字符数)。超过则拒绝发送并提示,防止病态超长输入。
 * 取值与附件总字符上限(MAX_TOTAL_CHARS)一致,均为 24000。 */
const MAX_INPUT_CHARS = 24_000

type PendingAttachmentInput =
  | ({ kind: "selected" } & SelectedAttachmentFileGrant)
  | { kind: "bytes"; fileName: string; bytes: ArrayBuffer }

// Module-level (not a component-local useRef): TabbedPanel unmounts ChatContainer
// entirely when switching to a file tab (`isAgentTab ? <ChatContainer> : <FileViewer>`)
// — a component-local ref would silently reset to an empty Set on remount, the
// same class of bug queueAutoDrainSuppressed had before it moved to thread-context.
// This lock's synchronous acquire-then-immediately-read semantics (see
// submit-in-flight-lock.ts) don't fit React state (setState isn't synchronously
// readable in the same tick), so instead of moving it into ThreadState like
// queueAutoDrainSuppressed, it stays a plain mutable object — just hoisted to
// module scope so it survives remounts. Keyed by threadId internally (every
// caller already passes threadId as the lock key), so sharing one Set across
// all ChatContainer instances is safe: different threads never collide, and if
// two instances ever pointed at the SAME thread, sharing the lock is the
// correct behavior anyway.
const submitInFlightLockStore: SubmitInFlightLockRef = { current: new Set<string>() }
// Distinguishes a live Enter/send that is still preparing its payload from other
// users of the shared submit lock (notably the queue pump). A second Enter during
// this preparation window is a duplicate gesture and must be rejected; a genuinely
// new message racing a pump before isLoading updates should still be queued.
const liveSubmitPreparingThreads = new Set<string>()
// Busy sends bypass the long-lived run lock so they can be parked while a turn
// is active. This short-lived guard atomically claims the current composer
// payload while @file attachments are being resolved.
const queuedDraftPreparingThreads = new Set<string>()
/**
 * Temporarily hide the current-run "引导" action from the queue UI.
 *
 * The underlying main-process queue, durable acknowledgement, reconciliation,
 * and IPC plumbing are intentionally retained so the implementation can be
 * repaired without rebuilding the feature. The action remains disabled because
 * a guided message can currently produce incorrect live transcript boundaries
 * in Team/Coordinator mode (for example, duplicating or attaching assistant
 * output to the wrong visible turn). Ordinary FIFO queueing and automatic
 * post-run draining do not depend on this control and remain available.
 *
 * Re-enable only after the guided user turn and its following assistant turn are
 * rendered as separate, non-duplicated messages in Solo, Team, and Workflow,
 * including persistence/reload verification for the same transcript.
 */
const CURRENT_RUN_GUIDE_UI_ENABLED = false
const QUEUE_MODEL_REQUIRED_ERROR = "请先在下方选择模型后再发送消息。"
const QUEUE_MODEL_MISSING_ERROR = "当前线程模型不存在，请重新选择模型。"
const QUEUE_MODEL_UNAVAILABLE_ERROR = "当前模型不可用，请先在模型配置中设置 API 密钥。"
const QUEUE_WORKSPACE_REQUIRED_ERROR = "请先选择一个工作区文件夹再发送消息。"
const RECOVERABLE_QUEUE_ERRORS = new Set([
  QUEUE_MODEL_REQUIRED_ERROR,
  QUEUE_MODEL_MISSING_ERROR,
  QUEUE_MODEL_UNAVAILABLE_ERROR,
  QUEUE_WORKSPACE_REQUIRED_ERROR
])
const CHAT_REPORT_UPLOAD_DEBOUNCE_MS = 250
const CHAT_REPORT_RETRY_DELAY_MS = 1_000
const CHAT_REPORT_MAX_RETRY_ATTEMPTS = 3
const escXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const ROTATING_WORDS = [
  "编写代码",
  "调试问题",
  "创建技能",
  "管理任务",
  "重构项目",
  "解答疑惑",
  "审查代码",
  "优化性能",
  "编写测试",
  "设计方案",
  "分析日志",
  "部署上线"
]

const getMessageText = (content: Message["content"]): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? ""
      if (typeof block.content === "string") return block.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function cleanUserAttachmentMarkupForDisplay(message: Message): Message {
  if (
    message.role !== "user" ||
    typeof message.content !== "string" ||
    !message.content.includes("<attachment ")
  ) {
    return message
  }

  const content = cleanUserAttachmentContentForDisplay(message.content)
  return { ...message, content }
}

interface ThreadDisplayBaselineCacheEntry {
  contentVersion: number
  sourceLength: number
  sourceTailSnapshot: Message | undefined
  sourceTailProjected: boolean
  baseline: Message[]
}

const threadDisplayBaselineCache = new WeakMap<
  readonly Message[],
  ThreadDisplayBaselineCacheEntry
>()

function getThreadDisplayBaseline(messages: readonly Message[], contentVersion: number): Message[] {
  const cached = threadDisplayBaselineCache.get(messages)
  if (cached?.contentVersion === contentVersion) return cached.baseline
  const sourceTail = messages.at(-1)
  if (
    cached &&
    cached.sourceLength === messages.length &&
    cached.sourceTailSnapshot &&
    sourceTail &&
    cached.sourceTailSnapshot.id === sourceTail.id &&
    cached.sourceTailSnapshot.role === sourceTail.role &&
    cached.sourceTailSnapshot.tool_call_id === sourceTail.tool_call_id
  ) {
    const projectedTail = filterCoordinatorNoiseMessages(
      isVisibleCheckpointTranscriptMessage(sourceTail)
        ? [cleanUserAttachmentMarkupForDisplay(sourceTail)]
        : []
    )
    if (!cached.sourceTailProjected && projectedTail.length === 0) {
      cached.contentVersion = contentVersion
      cached.sourceTailSnapshot = sourceTail
      return cached.baseline
    }
    if (
      cached.sourceTailProjected &&
      projectedTail.length === 1 &&
      cached.baseline.at(-1)?.id === sourceTail.id
    ) {
      cached.baseline[cached.baseline.length - 1] = projectedTail[0]
      cached.contentVersion = contentVersion
      cached.sourceTailSnapshot = sourceTail
      return cached.baseline
    }
  }
  const baseline = filterCoordinatorNoiseMessages(
    messages.filter(isVisibleCheckpointTranscriptMessage).map(cleanUserAttachmentMarkupForDisplay)
  )
  threadDisplayBaselineCache.set(messages, {
    contentVersion,
    sourceLength: messages.length,
    sourceTailSnapshot: sourceTail,
    sourceTailProjected: Boolean(sourceTail && baseline.at(-1)?.id === sourceTail.id),
    baseline
  })
  return baseline
}

type ForkDestinationMode = "local" | "workspace"

interface MessageForkDialogTarget {
  sourceThreadId: string
  sourceWorkspacePath: string | null
  message: Message
  checkpoint: ForkableCheckpoint
}

interface RemoteThreadDisplayInfo {
  kind: "inbox" | "feature"
  historical: boolean
  featureLabel?: string
}

function getRemoteThreadDisplayInfo(thread: Thread | null): RemoteThreadDisplayInfo | null {
  const metadata = thread?.metadata
  if (!metadata || (metadata.targetKind !== "inbox" && metadata.targetKind !== "feature")) {
    return null
  }
  const delivery = metadata.imDeliveryContext
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null
  const context = delivery as Record<string, unknown>
  if (context.provider !== DEFAULT_IM_CHANNEL_ID || typeof context.conversationKey !== "string") {
    return null
  }
  if (metadata.targetKind === "inbox") {
    return { kind: "inbox", historical: metadata.remoteState === "historical" }
  }
  const harnessFeature = metadata.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object" || Array.isArray(harnessFeature)) {
    return null
  }
  const feature = harnessFeature as Record<string, unknown>
  if (typeof feature.projectId !== "string" || typeof feature.slug !== "string") return null
  return {
    kind: "feature",
    historical: metadata.remoteState === "historical",
    featureLabel: feature.slug
  }
}

function getForkWorkspacePath(thread: Thread | null): string | null {
  const workspacePath = thread?.metadata?.workspacePath
  return typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : null
}

function getForkWorkspaceLabel(path: string | null): string {
  if (!path) return "未关联工作区"
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || path
}

function formatForkCheckpointTime(value?: string): string {
  if (!value) return "未知时间"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getForkMessagePreview(message: Message): string {
  const text = getMessageText(message.content).replace(/\s+/g, " ").trim()
  if (!text) return "这条消息没有可预览文本"
  return text.length > 180 ? `${text.slice(0, 180)}...` : text
}

const MESSAGE_FORK_CHECKPOINT_HINT = "可在左侧会话列表右键该会话，选择“从 checkpoint fork”。"

function getMessageForkCheckpointHint(errorMessage?: string): string {
  const message = errorMessage?.trim()
  if (!message)
    return `该消息附近没有可精确 fork 的稳定 checkpoint。${MESSAGE_FORK_CHECKPOINT_HINT}`
  return `${message} ${MESSAGE_FORK_CHECKPOINT_HINT}`
}

function RotatingHeadline() {
  const [wordIndex, setWordIndex] = useState(0)
  const [displayed, setDisplayed] = useState("")
  const [phase, setPhase] = useState<"typing" | "showing" | "erasing">("typing")

  useEffect(() => {
    const word = ROTATING_WORDS[wordIndex]
    let timer: ReturnType<typeof setTimeout> | undefined

    if (phase === "typing") {
      if (displayed.length < word.length) {
        timer = setTimeout(() => setDisplayed(word.slice(0, displayed.length + 1)), 150)
      } else {
        timer = setTimeout(() => setPhase("showing"), 0)
      }
    } else if (phase === "showing") {
      timer = setTimeout(() => setPhase("erasing"), 2000)
    } else if (phase === "erasing") {
      if (displayed.length > 0) {
        timer = setTimeout(() => setDisplayed(displayed.slice(0, -1)), 80)
      } else {
        timer = setTimeout(() => {
          setWordIndex((i) => (i + 1) % ROTATING_WORDS.length)
          setPhase("typing")
        }, 0)
      }
    }

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [displayed, phase, wordIndex])

  return (
    <div className="mb-6 flex items-center justify-start">
      <div className="text-2xl md:text-3xl font-bold tracking-tight leading-none">
        <span className="text-foreground">为你</span>
        <span className="text-[#D97757] mx-3">{">"}</span>
        <span className="text-[#D97757]">{displayed}</span>
      </div>
    </div>
  )
}

interface HarnessFeatureBinding {
  projectId: string
  slug: string
}

function getHarnessFeatureBinding(thread: Thread | null | undefined): HarnessFeatureBinding | null {
  const harnessFeature = thread?.metadata?.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object") {
    return null
  }

  const metadata = harnessFeature as Record<string, unknown>
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId.trim() : ""
  const slug = typeof metadata.slug === "string" ? metadata.slug.trim() : ""
  return projectId && slug ? { projectId, slug } : null
}

type HarnessPreferredPlugin = { id?: string; name?: string } | null

function getCachedHarnessPreferredPlugin(projectId: string): HarnessPreferredPlugin {
  const project = readHarnessBoardCatalogCache()?.projects.find(
    (candidate) => candidate.projectId === projectId
  )
  return project ? { id: project.harnessAdapter.id, name: project.harnessAdapter.name } : null
}

interface InitialChatSkillCatalogState {
  projection: ChatSkillCatalogProjection | null
  loading: boolean
  targetProjectId: string | null
  resolvedProjectId: string | null
  preferredPlugin: HarnessPreferredPlugin
}

function createInitialChatSkillCatalogState(
  threadId: string,
  surface: ChatSurface
): InitialChatSkillCatalogState {
  const store = useAppStore.getState()
  const binding = getHarnessFeatureBinding(
    store.threads.find((thread) => thread.thread_id === threadId)
  )
  const targetProjectId = binding?.projectId ?? null
  const harnessScoped = surface !== "default" || Boolean(binding)
  const preferredPlugin = binding ? getCachedHarnessPreferredPlugin(binding.projectId) : null
  const harnessCatalogReady = !binding || preferredPlugin !== null
  const snapshot = readSkillCatalogCache()
  const projection = snapshot
    ? projectChatSkillCatalog(snapshot, {
        harnessScoped,
        preferredPlugin
      })
    : null

  return {
    projection,
    loading: !isSkillCatalogFresh(snapshot, store.pluginVersion) || !harnessCatalogReady,
    targetProjectId,
    resolvedProjectId: harnessCatalogReady ? targetProjectId : null,
    preferredPlugin
  }
}

function getSafeHttpUrl(href: unknown): string | null {
  if (typeof href !== "string") return null
  try {
    const url = new URL(href)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

const dialogTipsMarkdownComponents: Components = {
  p({ children }) {
    return <p className="my-1 leading-6 first:mt-0 last:mb-0">{children}</p>
  },
  ul({ children }) {
    return <ul className="my-1 ml-4 list-disc space-y-1 leading-6">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-1 ml-4 list-decimal space-y-1 leading-6">{children}</ol>
  },
  li({ children }) {
    return <li className="pl-1">{children}</li>
  },
  a({ href, children }) {
    const safeHref = getSafeHttpUrl(href)
    if (!safeHref) return <span>{children}</span>
    return (
      <a
        href={safeHref}
        className="font-medium text-primary underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault()
          void window.electron.openExternal(safeHref)
        }}
      >
        {children}
      </a>
    )
  },
  code({ children }) {
    return (
      <code className="rounded border border-border/70 bg-background/80 px-1 py-0.5 font-mono text-[0.92em] text-foreground">
        {children}
      </code>
    )
  },
  pre() {
    return null
  },
  img() {
    return null
  },
  table() {
    return null
  },
  h1({ children }) {
    return <p className="my-1 font-semibold leading-6 text-foreground">{children}</p>
  },
  h2({ children }) {
    return <p className="my-1 font-semibold leading-6 text-foreground">{children}</p>
  },
  h3({ children }) {
    return <p className="my-1 font-semibold leading-6 text-foreground">{children}</p>
  }
}

class DialogTipsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  render(): React.ReactNode {
    return this.state.hasError ? null : this.props.children
  }
}

function DialogTipsMarkdown({ content }: { content: string }): React.JSX.Element | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  return (
    <DialogTipsErrorBoundary key={trimmed}>
      <div className="mb-6 max-w-3xl rounded-md border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground shadow-sm">
        <ReactMarkdown remarkPlugins={[remarkBreaks]} components={dialogTipsMarkdownComponents}>
          {trimmed}
        </ReactMarkdown>
      </div>
    </DialogTipsErrorBoundary>
  )
}

/**
 * Error card shown when a turn fails. Renders a friendly summary (status label +
 * real reason + hint) with an expandable "显示详情" section carrying the
 * diagnostics needed to locate the cause: status code, error code, request id
 * (copyable), failover chain, and the raw response body.
 */
function ChatErrorCard({
  error,
  detail,
  onDismiss
}: {
  error: string
  detail: ApiErrorDetailState | null
  onDismiss: () => void
}): React.JSX.Element {
  const [showDetails, setShowDetails] = useState(false)

  const title = detail?.statusLabel
    ? `${detail.statusLabel}${detail.status ? `（${detail.status}）` : ""}`
    : "代理出错"
  const reason = (detail?.reason || error || "").trim()
  const hint = detail?.hint
  const displayedModel = detail?.modelDisplayName || detail?.model || detail?.modelName
  const apiModelName = detail?.modelName
  const hasDetails = Boolean(
    detail &&
    (detail.status != null ||
      detail.requestId ||
      detail.code ||
      displayedModel ||
      apiModelName ||
      detail.modelId ||
      (detail.failover && detail.failover.length > 0) ||
      detail.rawBody)
  )

  const copy = (text: string): void => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success("已复制"),
      () => toast.error("复制失败")
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-4">
      <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-destructive text-sm">{title}</div>
        {reason && (
          <div className="text-sm text-muted-foreground mt-1 break-words whitespace-pre-wrap">
            {reason}
          </div>
        )}
        {hint && <div className="text-xs text-muted-foreground/90 mt-1">{hint}</div>}

        {hasDetails && (
          <>
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showDetails ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {showDetails ? "隐藏详情" : "显示详情"}
            </button>

            {showDetails && (
              <div className="mt-2 space-y-1.5 rounded border border-border/60 bg-background/40 p-2 text-xs text-muted-foreground">
                {detail?.status != null && (
                  <div className="flex gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">状态码</span>
                    <span className="font-mono">{detail.status}</span>
                  </div>
                )}
                {detail?.code && (
                  <div className="flex gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">错误码</span>
                    <span className="font-mono break-all">{detail.code}</span>
                  </div>
                )}
                {detail?.requestId && (
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">请求 ID</span>
                    <span className="font-mono break-all flex-1 min-w-0">{detail.requestId}</span>
                    <button
                      onClick={() => copy(detail.requestId!)}
                      className="shrink-0 rounded p-0.5 hover:bg-muted transition-colors"
                      aria-label="Copy request id"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                )}
                {displayedModel && (
                  <div className="flex gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">模型</span>
                    <span className="font-mono break-all">{displayedModel}</span>
                  </div>
                )}
                {apiModelName && apiModelName !== displayedModel && (
                  <div className="flex gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">Model</span>
                    <span className="font-mono break-all">{apiModelName}</span>
                  </div>
                )}
                {detail?.modelId && detail.modelId !== displayedModel && (
                  <div className="flex gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">配置标识</span>
                    <span className="font-mono break-all">{detail.modelId}</span>
                  </div>
                )}
                {detail?.failover && detail.failover.length > 0 && (
                  <div className="flex gap-2">
                    <span className="shrink-0 w-16 text-muted-foreground/70">故障转移</span>
                    <ul className="flex-1 min-w-0 space-y-0.5">
                      {detail.failover.map((f, i) => (
                        <li key={`${f.modelId}-${i}`} className="break-words">
                          <span className="font-mono">
                            {f.modelDisplayName
                              ? `${f.modelDisplayName} (${f.modelId})`
                              : f.modelName
                                ? `${f.modelName} (${f.modelId})`
                                : f.modelId}
                          </span>
                          ：{f.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {detail?.rawBody && (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground/70">原始响应</span>
                      <button
                        onClick={() => copy(detail.rawBody!)}
                        className="rounded p-0.5 hover:bg-muted transition-colors"
                        aria-label="Copy raw response body"
                      >
                        <Copy className="size-3" />
                      </button>
                    </div>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono text-[11px]">
                      {detail.rawBody}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="text-xs text-muted-foreground mt-2">你可以尝试发送新消息继续对话。</div>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded p-1 hover:bg-destructive/20 transition-colors"
        aria-label="Dismiss error"
      >
        <X className="size-4 text-muted-foreground" />
      </button>
    </div>
  )
}

function SystemPromptPreviewButton({
  threadId
}: {
  threadId?: string | null
}): React.JSX.Element | null {
  const [allowed, setAllowed] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.agent
      .canPreviewSystemPrompt()
      .then((nextAllowed) => {
        if (!cancelled) setAllowed(nextAllowed)
      })
      .catch(() => {
        if (!cancelled) setAllowed(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loadPreview = useCallback(async () => {
    if (!threadId || loading) return
    setLoading(true)
    try {
      const preview = await window.api.agent.getSystemPromptPreview(threadId)
      setPrompt(preview.prompt)
      setUpdatedAt(preview.updatedAt)
    } catch {
      setPrompt(null)
      setUpdatedAt(null)
    } finally {
      setLoading(false)
    }
  }, [loading, threadId])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 120)
  }, [clearCloseTimer])

  useEffect(() => {
    return () => clearCloseTimer()
  }, [clearCloseTimer])

  useEffect(() => {
    setOpen(false)
    setPrompt(null)
    setUpdatedAt(null)
  }, [threadId])

  if (!allowed || !threadId) return null

  const updatedAtLabel = updatedAt ? new Date(updatedAt).toLocaleString() : "暂无"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => {
            clearCloseTimer()
            setOpen(true)
            void loadPreview()
          }}
          onMouseLeave={scheduleClose}
          className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          title="系统提示词预览"
          aria-label="系统提示词预览"
        >
          <FileText className="size-3.5" />
          <span>系统提示词预览</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        onMouseEnter={() => {
          clearCloseTimer()
          setOpen(true)
        }}
        onMouseLeave={scheduleClose}
        className="w-[720px] max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {loading ? "加载中..." : `更新时间：${updatedAtLabel}`}
        </div>
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5">
          {prompt || "暂无系统提示词；请先运行一次当前会话。"}
        </pre>
      </PopoverContent>
    </Popover>
  )
}

export function ChatContainer({
  threadId,
  showGitChangeNotice = false,
  surface = "default",
  hideWelcomeSkillTabs = false,
  readOnlyReason = null,
  onOpenGitPanel,
  onDismissGitChangeNotice,
  onThreadGitStatusChange,
  onHarnessSessionCreated
}: ChatContainerProps): React.JSX.Element {
  const remoteThread = useAppStore(
    (state) => state.threads.find((thread) => thread.thread_id === threadId) ?? null
  )
  const remoteThreadInfo = useMemo(() => getRemoteThreadDisplayInfo(remoteThread), [remoteThread])
  const resolvedReadOnlyReason =
    readOnlyReason ??
    (remoteThreadInfo?.historical
      ? "设备接管前的远程历史 Thread 仅可查看"
      : remoteThreadInfo?.kind === "inbox"
        ? "远程收件箱在桌面仅可查看；请从招乎继续发送消息"
        : null)
  const surfaceConfig = CHAT_SURFACE_CONFIG[surface]
  const [threadProjectionRuntime] = useState(() => getChatThreadProjectionRuntime(threadId))
  const [initialChatScrollView] = useState(() => chatScrollSessionStore.open(threadId))
  const initialChatScrollSession = initialChatScrollView.session
  const chatScrollSessionLeaseRef = useRef(initialChatScrollView.lease)
  const initialPendingDurableRevealMessageId = initialChatScrollView.pendingRevealMessageId
  const readOnly = Boolean(resolvedReadOnlyReason)
  const shouldShowWelcomeHeadline = surfaceConfig.showWelcomeHeadline
  const shouldShowWelcomeSkillTabs = surfaceConfig.showWelcomeSkillTabs && !hideWelcomeSkillTabs
  const shouldShowHarnessDialogTips = surfaceConfig.showHarnessDialogTips && !readOnly
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const textareaResizeFrameRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRootRef = useRef<HTMLDivElement>(null)
  const [dismissedRemoteTipThreadIds, setDismissedRemoteTipThreadIds] = useState(
    loadRemoteThreadTipDismissals
  )
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const chatScrollStateRef = useRef<ChatScrollState | null>(initialChatScrollSession?.state ?? null)
  if (chatScrollStateRef.current === null) {
    chatScrollStateRef.current = createChatScrollState(threadId)
  }
  const pendingChatSessionAnchorRef = useRef<PendingChatSessionAnchor | null>(
    initialChatScrollSession?.anchor
      ? {
          ...initialChatScrollSession.anchor,
          threadId,
          attempt: 0,
          stableFrames: 0
        }
      : null
  )
  const [chatScrollUiState, setChatScrollUiState] = useState(() => ({
    generation: chatScrollStateRef.current?.generation ?? 0,
    mode: chatScrollStateRef.current?.mode ?? "initializing",
    hasUnread: chatScrollStateRef.current?.hasUnread ?? false,
    unreadCount: chatScrollStateRef.current?.unreadCount ?? 0
  }))
  const pendingBottomScrollEffectRef = useRef<ChatScrollEffect | null>(null)
  const bottomScrollFrameRef = useRef<number | null>(null)
  const bottomSettleAttemptRef = useRef(0)
  const bottomSettleEffectKeyRef = useRef("")
  const lastVisibleMessageIndexRef = useRef(-1)
  const messageVirtualizationEnabledRef = useRef(false)
  const lastObservedScrollTopRef = useRef(0)
  const upwardUserScrollIntentUntilRef = useRef(0)
  const downwardUserScrollIntentUntilRef = useRef(0)
  const scrollbarUserIntentActiveRef = useRef(false)
  const chatContentSnapshotRef = useRef<{
    threadId: string
    visibleCount: number
    lastMessageId: string | null
    lastMessageIdentity: string | null
    loadedMessageCount: number
    contentVersion: number
    structureVersion: number
  } | null>(initialChatScrollSession?.contentSnapshot ?? null)
  const pendingDurableHistoryAnchorRef = useRef<PendingDurableHistoryAnchor | null>(null)
  const pendingDurableSearchRevealIdRef = useRef<string | null>(
    initialPendingDurableRevealMessageId
  )
  const durableMessageWindowGenerationRef = useRef(0)
  const chatViewMountedRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const contentMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const isComposingRef = useRef(false)
  // Alias, not a fresh useRef — see submitInFlightLockStore's module-level
  // declaration above for why this must survive ChatContainer remounts.
  const submitInFlightRef = submitInFlightLockStore
  const [initialSkillCatalogState] = useState(() =>
    createInitialChatSkillCatalogState(threadId, surface)
  )
  const [skills, setSkills] = useState<SkillMetadata[]>(
    () => initialSkillCatalogState.projection?.skills ?? []
  )
  const [disabledSkillIds, setDisabledSkillIds] = useState<Set<string>>(
    () => initialSkillCatalogState.projection?.disabledSkillIds ?? new Set()
  )
  const [skillsLoading, setSkillsLoading] = useState(initialSkillCatalogState.loading)
  const [skillsHarnessProjectId, setSkillsHarnessProjectId] = useState<string | null>(
    initialSkillCatalogState.resolvedProjectId
  )
  const [skillsLoadTargetProjectId, setSkillsLoadTargetProjectId] = useState<string | null>(
    initialSkillCatalogState.targetProjectId
  )
  const [skillsHarnessPreferredPlugin, setSkillsHarnessPreferredPlugin] = useState<{
    id?: string
    name?: string
  } | null>(initialSkillCatalogState.preferredPlugin)
  const skillsLoadRequestIdRef = useRef(0)
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0)
  const [userInputDialogLayout, setUserInputDialogLayout] =
    useState<UserInputRequestDialogLayout | null>(null)
  const [goalDetailsOpen, setGoalDetailsOpen] = useState(false)
  // Skill creation human-confirmation state
  const [skillConfirmRequest, setSkillConfirmRequest] = useState<SkillConfirmRequest | null>(null)
  // Skill intent banner state ("Want to save as a skill?")
  const [skillIntentRequest, setSkillIntentRequest] = useState<SkillIntentBannerRequest | null>(
    null
  )

  // Skill generation state stored globally so RightPanel can render the virtual subagent card
  const { setSkillGenerationPhase, appendSkillGenerationToken, setSkillRetryContext } = useAppStore(
    useShallow((s) => ({
      setSkillGenerationPhase: s.setSkillGenerationPhase,
      appendSkillGenerationToken: s.appendSkillGenerationToken,
      setSkillRetryContext: s.setSkillRetryContext
    }))
  )
  const [yoloMode, setYoloMode] = useState(false)
  const [yoloModeLoaded, setYoloModeLoaded] = useState(false)
  const [glowVisible, setGlowVisible] = useState(false)
  const appleIntelligenceGlowEnabled = useSyncExternalStore(
    subscribeAppleIntelligenceGlow,
    getAppleIntelligenceGlowEnabled,
    () => false
  )
  // NUX (first-run sandbox setup)
  const [showNux, setShowNux] = useState<boolean>(false)
  const [nuxLoading, setNuxLoading] = useState(false)
  const [nuxError, setNuxError] = useState<string | null>(null)
  const [nuxLoadingStep, setNuxLoadingStep] = useState(0)

  const NUX_LOADING_STEPS: string[] = [
    "正在准备沙箱环境...",
    "等待管理员授权，请在弹出的窗口中点击「是」...",
    "正在创建沙箱隔离用户...",
    "正在配置目录访问权限...",
    "即将完成，请稍候..."
  ]
  const nuxLoadingMessage = NUX_LOADING_STEPS[nuxLoadingStep] ?? NUX_LOADING_STEPS[0]
  const thinkingCycleRef = useRef(-1)
  const wasLoadingRef = useRef(false)
  const loadingMessageCountRef = useRef(0)
  const [modelContextLimit, setModelContextLimit] = useState<number | undefined>(undefined)
  const initialThreadMetadata = useAppStore
    .getState()
    .threads.find((thread) => thread.thread_id === threadId)?.metadata
  const initialAgentMode: ChatAgentMode = isWorkflowModeMetadata(initialThreadMetadata)
    ? "workflow"
    : isCoordinatorModeMetadata(initialThreadMetadata)
      ? "coordinator"
      : isMultiModeMetadata(initialThreadMetadata)
        ? "multi"
        : "normal"
  const [agentMode, setAgentMode] = useState<ChatAgentMode>(initialAgentMode)
  const agentModeHydratedRef = useRef(
    initialAgentMode === "coordinator" || initialAgentMode === "workflow"
  )
  const persistedAgentModeRef = useRef<ChatAgentMode>(initialAgentMode)
  const agentModeChangeRequestRef = useRef(0)
  const agentModeChangeChainRef = useRef<Promise<void>>(Promise.resolve())
  const agentModeSaveRef = useRef<Promise<void>>(Promise.resolve())
  // Draft-queue UI state: inline edit, drag-reorder, and a retry tick for
  // authoritative handoff reconciliation.
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = useState("")
  const [draggingQueueId, setDraggingQueueId] = useState<string | null>(null)
  const queuedEditRequestRef = useRef(0)
  const guidingQueuedMessageIdsRef = useRef(new Set<string>())
  const [queuePumpTick, setQueuePumpTick] = useState(0)
  const subscribeToSubmitRelease = useCallback(
    (listener: () => void) => subscribeSubmitInFlightRelease(submitInFlightRef, threadId, listener),
    [submitInFlightRef, threadId]
  )
  const getSubmitReleaseVersion = useCallback(
    () => getSubmitInFlightReleaseVersion(submitInFlightRef, threadId),
    [submitInFlightRef, threadId]
  )
  const submitReleaseVersion = useSyncExternalStore(
    subscribeToSubmitRelease,
    getSubmitReleaseVersion,
    getSubmitReleaseVersion
  )
  const chatReportUploadTimersRef = useRef<Record<string, number>>({})
  const chatReportRetryTimersRef = useRef<Record<string, number>>({})
  const chatReportRetryBatchesRef = useRef<
    Record<string, { batch: ChatReportBatch; attempt: number } | undefined>
  >({})
  const chatReportPendingBatchesRef = useRef<
    Record<string, { batch: ChatReportBatch; attempt: number } | undefined>
  >({})
  const chatReportAbortControllersRef = useRef<Record<string, AbortController | undefined>>({})
  const chatReportDisposedRef = useRef(false)
  // Get the stream data via subscription - reactive updates without re-rendering provider
  const streamData = useThreadStream(threadId)
  const stream = streamData.stream

  const {
    threads,
    models,
    createThread,
    forkThread,
    patchThreadMetadata,
    generateTitleForFirstMessage,
    setShowCustomizeView,
    rightPanelCollapsed,
    pluginVersion,
    requestOpenRightPanelSystemConstraints
  } = useAppStore(
    useShallow((state) => ({
      threads: state.threads,
      models: state.models,
      createThread: state.createThread,
      forkThread: state.forkThread,
      patchThreadMetadata: state.patchThreadMetadata,
      generateTitleForFirstMessage: state.generateTitleForFirstMessage,
      setShowCustomizeView: state.setShowCustomizeView,
      rightPanelCollapsed: state.rightPanelCollapsed,
      pluginVersion: state.pluginVersion,
      requestOpenRightPanelSystemConstraints: state.requestOpenRightPanelSystemConstraints
    }))
  )
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null)
  const currentThread = useMemo(
    () => threads.find((thread) => thread.thread_id === threadId) ?? null,
    [threadId, threads]
  )
  const currentForkWorkspacePath = useMemo(
    () => getForkWorkspacePath(currentThread),
    [currentThread]
  )
  const [messageForkTarget, setMessageForkTarget] = useState<MessageForkDialogTarget | null>(null)
  const currentThreadIdRef = useRef(threadId)
  const messageForkRequestIdRef = useRef(0)
  currentThreadIdRef.current = threadId
  const [forkDestinationMode, setForkDestinationMode] = useState<ForkDestinationMode>("local")
  const [forkWorkspacePath, setForkWorkspacePath] = useState<string | null>(null)
  const [selectingForkWorkspace, setSelectingForkWorkspace] = useState(false)
  const harnessFeatureBinding = useMemo(
    () => getHarnessFeatureBinding(currentThread),
    [currentThread]
  )
  const isProjectModeAgentContext =
    surface === "harness-project" ||
    surface === "harness-feature-session" ||
    Boolean(harnessFeatureBinding)
  const [humanGate, setHumanGate] = useState<HarnessHumanGateSnapshot | null>(null)
  const [humanGateDecisionBusy, setHumanGateDecisionBusy] = useState<"approve" | "reject" | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    void window.api.harnessBoard.getHumanGateForThread(threadId).then((gate) => {
      if (cancelled) return
      setHumanGate(gate ?? null)
    })
    const unsubscribe = window.api.harnessBoard.onHumanGateChanged((event) => {
      if (event.sourceThreadId !== threadId) return
      setHumanGate(event.humanGate ?? null)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [threadId])

  const decideHumanGate = useCallback(
    async (decision: "approve" | "reject"): Promise<void> => {
      if (!humanGate || humanGateDecisionBusy) return
      setHumanGateDecisionBusy(decision)
      try {
        const input = {
          projectId: humanGate.projectId,
          featureId: humanGate.featureId,
          gateId: humanGate.gateId
        }
        const changed =
          decision === "approve"
            ? await window.api.harnessBoard.approveHumanGate(input)
            : await window.api.harnessBoard.rejectHumanGate(input)
        if (!changed) toast.error("Human Gate 已发生变化，请刷新后重试")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setHumanGateDecisionBusy(null)
      }
    },
    [humanGate, humanGateDecisionBusy]
  )
  const disableCoordinatorModeOption = isProjectModeAgentTeamSelectionDisabled(
    currentThread?.metadata,
    isProjectModeAgentContext,
    PROJECT_MODE_AGENT_TEAM_ENABLED
  )
  const disableWorkflowModeOption = false
  const pendingHarnessNextActionVersion = useSyncExternalStore(
    subscribePendingHarnessNextActions,
    getPendingHarnessNextActionVersion,
    getPendingHarnessNextActionVersion
  )
  const pendingHarnessNextAction = useMemo(
    () => getPendingHarnessNextAction(threadId),
    [pendingHarnessNextActionVersion, threadId]
  )
  const pendingHarnessDialogTips = pendingHarnessNextAction?.dialogTips?.trim() || null

  const resolveAgentMode = useCallback(
    async (metadata: Record<string, unknown>): Promise<ChatAgentMode> => {
      if (
        (disableCoordinatorModeOption && isCoordinatorModeMetadata(metadata)) ||
        (disableWorkflowModeOption && isWorkflowModeMetadata(metadata))
      ) {
        return "normal"
      }
      if (isWorkflowModeMetadata(metadata)) {
        return "workflow"
      }
      if (isCoordinatorModeMetadata(metadata)) {
        return "coordinator"
      }
      const environmentForcedCoordinator = await window.api.agent
        .isCoordinatorModeForced(threadId)
        .catch((error) => {
          console.warn("[ChatContainer] Failed to load environment coordinator mode:", error)
          return false
        })
      if (environmentForcedCoordinator && !disableCoordinatorModeOption) {
        return "coordinator"
      }
      return isMultiModeMetadata(metadata) ? "multi" : "normal"
    },
    [disableCoordinatorModeOption, disableWorkflowModeOption, threadId]
  )

  const loadResolvedAgentMode = useCallback(async (): Promise<ChatAgentMode> => {
    const currentThread = useAppStore
      .getState()
      .threads.find((thread) => thread.thread_id === threadId)
    if (currentThread) {
      return resolveAgentMode(currentThread.metadata ?? {})
    }
    const thread = await window.api.threads.get(threadId)
    return resolveAgentMode(thread?.metadata ?? {})
  }, [resolveAgentMode, threadId])

  useEffect(() => {
    let cancelled = false
    const currentThread = threads.find((thread) => thread.thread_id === threadId)
    const metadataDerivedMode: ChatAgentMode =
      disableCoordinatorModeOption && isCoordinatorModeMetadata(currentThread?.metadata)
        ? "normal"
        : disableWorkflowModeOption && isWorkflowModeMetadata(currentThread?.metadata)
          ? "normal"
          : isWorkflowModeMetadata(currentThread?.metadata)
            ? "workflow"
            : isCoordinatorModeMetadata(currentThread?.metadata)
              ? "coordinator"
              : isMultiModeMetadata(currentThread?.metadata)
                ? "multi"
                : "normal"
    setAgentMode(metadataDerivedMode)
    persistedAgentModeRef.current = metadataDerivedMode
    agentModeHydratedRef.current =
      metadataDerivedMode === "coordinator" || metadataDerivedMode === "workflow"

    void loadResolvedAgentMode()
      .then((nextMode) => {
        if (cancelled) return
        agentModeHydratedRef.current = true
        persistedAgentModeRef.current = nextMode
        setAgentMode(nextMode)
      })
      .catch((error) => {
        console.warn("[ChatContainer] Failed to load agent mode:", error)
      })
    return () => {
      cancelled = true
    }
  }, [
    threadId,
    threads,
    loadResolvedAgentMode,
    disableCoordinatorModeOption,
    disableWorkflowModeOption
  ])

  // Stable ref so loadSkills can read the latest harness binding without
  // invalidating its own identity (useCallback with empty deps).
  const harnessFeatureBindingRef = useRef(harnessFeatureBinding)
  harnessFeatureBindingRef.current = harnessFeatureBinding
  const chatSurfaceRef = useRef(surface)
  chatSurfaceRef.current = surface

  // Keep a stable callback for both plugin-version effects and the application-level
  // skills:changed bridge. The shared cache makes concurrent Chat/RightPanel reads one request.
  const loadSkills = useCallback(async (): Promise<void> => {
    const requestId = ++skillsLoadRequestIdRef.current
    const binding = harnessFeatureBindingRef.current
    const harnessScoped = chatSurfaceRef.current !== "default" || Boolean(binding)
    const targetProjectId = binding?.projectId ?? null
    setSkillsLoadTargetProjectId(targetProjectId)
    const pluginVersion = useAppStore.getState().pluginVersion

    const applySnapshot = (
      snapshot: NonNullable<ReturnType<typeof readSkillCatalogCache>>,
      preferredPlugin: HarnessPreferredPlugin
    ): void => {
      if (requestId !== skillsLoadRequestIdRef.current) return
      const projection = projectChatSkillCatalog(snapshot, {
        harnessScoped,
        preferredPlugin
      })
      setSkills(projection.skills)
      setDisabledSkillIds(projection.disabledSkillIds)
      setSkillsHarnessProjectId(targetProjectId)
      setSkillsHarnessPreferredPlugin(preferredPlugin)
      setSkillsLoading(false)
    }

    const cachedSkills = readSkillCatalogCache()
    const cachedHarnessCatalog = readHarnessBoardCatalogCache()
    const cachedHarnessPreferredPlugin = binding
      ? getCachedHarnessPreferredPlugin(binding.projectId)
      : null
    if (cachedSkills) {
      const preferredPlugin = binding ? getCachedHarnessPreferredPlugin(binding.projectId) : null
      const cachedProjection = projectChatSkillCatalog(cachedSkills, {
        harnessScoped,
        preferredPlugin
      })
      setSkills(cachedProjection.skills)
      setDisabledSkillIds(cachedProjection.disabledSkillIds)
      setSkillsHarnessPreferredPlugin(preferredPlugin)
      setSkillsHarnessProjectId(!binding || cachedHarnessPreferredPlugin ? targetProjectId : null)
    }
    if (
      isSkillCatalogFresh(cachedSkills, pluginVersion) &&
      (!binding || cachedHarnessPreferredPlugin)
    ) {
      applySnapshot(cachedSkills, cachedHarnessPreferredPlugin)
      return
    }

    setSkillsLoading(true)
    try {
      const skillCatalogPromise = revalidateSkillCatalog(pluginVersion)
      const harnessCatalogPromise = !binding
        ? Promise.resolve(null)
        : cachedHarnessPreferredPlugin && cachedHarnessCatalog
          ? Promise.resolve(cachedHarnessCatalog)
          : window.api.harnessBoard
              .catalogPage({
                requestScope: "chat-binding",
                projectId: binding.projectId,
                projectLimit: 1,
                includeRegistry: false
              })
              .catch((error) => {
                console.warn("[ChatContainer] Failed to resolve harness skill binding:", error)
                return null
              })
      const [snapshot, harnessCatalog] = await Promise.all([
        skillCatalogPromise,
        harnessCatalogPromise
      ])
      const project = binding
        ? harnessCatalog?.projects.find((candidate) => candidate.projectId === binding.projectId)
        : null
      const preferredPlugin = project
        ? { id: project.harnessAdapter.id, name: project.harnessAdapter.name }
        : null
      applySnapshot(snapshot, preferredPlugin)
    } catch (error) {
      console.error("[ChatContainer] Failed to load skills:", error)
      if (requestId === skillsLoadRequestIdRef.current) setSkillsLoading(false)
    }
  }, [])

  // Get persisted thread state and actions from context
  const {
    messages: threadMessages,
    messagesContentVersion,
    queuedMessages,
    queueAutoDrainSuppressed,
    toolCallStates,
    pendingApprovals,
    goalUi,
    pendingApproval,
    approvalQueue,
    pendingUserInput,
    todos,
    error: threadError,
    errorDetail,
    hookInterruption,
    workspacePath,
    tokenUsage,
    contextReminder,
    harnessAgentmdLoadStatus,
    currentModel,
    draftInput: input,
    harnessNextActionDialogTips,
    draftSkill: selectedSkill,
    workspaceFiles,
    coordinatorWorkers,
    workflowRun,
    scheduledTaskLoading,
    historyLoading,
    historyPageLoading,
    historyHasMore,
    historyWindowGap,
    historyMessageTotal,
    historyConversationPresence,
    historyLoadedMessageCount,
    scheduledTaskId,
    modelRetry,
    contextCompaction,
    activeTurnStartTime,
    setToolCallState,
    setTodos,
    clearPendingApprovals,
    removePendingApproval,
    setPendingApproval,
    setPendingUserInput,
    setActiveTurnStartTime,
    clearFinishedWorkflowRun,
    appendMessage,
    syncDurableTranscript,
    loadEarlierMessages,
    loadMessageWindowAround,
    loadReleasedMessageWindow,
    restoreLatestMessageWindow,
    cancelMessageWindowLoad,
    removeLocalMessage,
    addQueuedMessage,
    prependQueuedMessage,
    getQueuedMessage,
    updateQueuedMessage,
    deleteQueuedMessage,
    reorderQueuedMessages,
    promoteQueuedMessage,
    setQueueAutoDrainSuppressed,
    refreshGoalUi,
    setError,
    clearError,
    clearHookInterruption,
    setContextReminder,
    setDraftInput: setInput,
    setHarnessNextActionDialogTips,
    setDraftSkill: setSelectedSkill,
    draftBuiltinBrowser: selectedBuiltinBrowser,
    setDraftBuiltinBrowser: setSelectedBuiltinBrowser
  } = useCurrentThread(threadId)
  const workspacePathRef = useRef(workspacePath)
  workspacePathRef.current = workspacePath

  const storedHarnessNextActionDialogTips = harnessNextActionDialogTips?.trim() || null
  const nextActionDialogTips = pendingHarnessDialogTips ?? storedHarnessNextActionDialogTips
  const shouldShowNextActionDialogTips = Boolean(nextActionDialogTips) && !readOnly
  const systemConstraintCounts = getSystemConstraintsLoadCounts(harnessAgentmdLoadStatus)
  const systemConstraintsLoadFailed = hasNoLoadedSystemConstraints(harnessAgentmdLoadStatus)
  const systemConstraintsPromptPreview = harnessAgentmdLoadStatus?.promptPreview?.trim()
  const showSystemConstraintsButton = surface === "harness-project"
  const systemConstraintsTitle = systemConstraintsLoadFailed
    ? `系统约束未加载 ${systemConstraintCounts.loaded}/${systemConstraintCounts.total}，点击查看详情`
    : systemConstraintCounts.total > 0
      ? `系统约束已加载 ${systemConstraintCounts.loaded}/${systemConstraintCounts.total}，点击查看详情`
      : "系统约束，点击查看详情"
  const systemConstraintsLabel = systemConstraintsLoadFailed
    ? "系统约束未全部加载"
    : systemConstraintCounts.loaded > 0
      ? "系统约束已加载"
      : "系统约束"
  const handleOpenSystemConstraints = useCallback((): void => {
    requestOpenRightPanelSystemConstraints(threadId)
  }, [requestOpenRightPanelSystemConstraints, threadId])
  const harnessDialogTipsProjectId = harnessFeatureBinding?.projectId ?? null
  const harnessDialogTipsSlug = harnessFeatureBinding?.slug ?? null
  const [harnessDialogTips, setHarnessDialogTips] = useState<string | null>(null)

  useEffect(() => {
    if (!pendingHarnessDialogTips) return
    setHarnessNextActionDialogTips(pendingHarnessDialogTips)
  }, [pendingHarnessDialogTips, setHarnessNextActionDialogTips])

  useEffect(() => {
    if (shouldShowNextActionDialogTips && nextActionDialogTips) {
      setHarnessDialogTips(nextActionDialogTips)
      return
    }

    if (!shouldShowHarnessDialogTips || !harnessDialogTipsProjectId || !harnessDialogTipsSlug) {
      setHarnessDialogTips(null)
      return
    }

    let cancelled = false
    setHarnessDialogTips(null)
    window.api.harnessBoard
      .getDialogTips(harnessDialogTipsProjectId, harnessDialogTipsSlug)
      .then((tips) => {
        if (!cancelled) setHarnessDialogTips(tips?.trim() || null)
      })
      .catch((error) => {
        console.warn("[ChatContainer] Failed to load harness dialog tips:", error)
        if (!cancelled) setHarnessDialogTips(null)
      })

    return () => {
      cancelled = true
      void window.api.harnessBoard.cancelDialogTips().catch(() => undefined)
    }
  }, [
    harnessDialogTipsProjectId,
    harnessDialogTipsSlug,
    nextActionDialogTips,
    shouldShowHarnessDialogTips,
    shouldShowNextActionDialogTips
  ])

  // Hook logs live in an external store so updates don't re-render the full provider tree.
  // Per-turn buckets are keyed by the user message id that opened the turn,
  // so the chip rendered under each user message can pull its own bucket.
  const threadContext = useThreadContext()
  const hookLogBuckets = useSyncExternalStore(
    useCallback((cb) => threadContext.subscribeToHookLogs(threadId, cb), [threadContext, threadId]),
    useCallback(() => threadContext.getHookLogBuckets(threadId), [threadContext, threadId])
  )

  const hookLogBucketByTurnId = threadProjectionRuntime.projectHookLogBucketMap(hookLogBuckets)
  const [hookLogConfig, setHookLogConfig] = useState<{ enabled: boolean; diagnostic: boolean }>({
    enabled: false,
    diagnostic: false
  })
  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.api.hooks.logging.onChanged((cfg) => {
      if (!cancelled) setHookLogConfig(cfg)
    })
    void window.api.hooks.logging
      .get()
      .then((cfg) => {
        if (!cancelled) setHookLogConfig(cfg)
      })
      .catch(() => {
        /* default already off */
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  const [openHookLogBucketId, setOpenHookLogBucketId] = useState<string | null>(null)
  const openHookLogBucket = openHookLogBucketId
    ? (hookLogBucketByTurnId.get(openHookLogBucketId) ?? null)
    : null
  const handleOpenHookLogBucket = useCallback((turnId: string): void => {
    setOpenHookLogBucketId(turnId)
  }, [])
  const handleOpenSandboxSettings = useCallback((): void => {
    setShowCustomizeView(true, "sandbox")
  }, [setShowCustomizeView])
  const handleOpenMemorySettings = useCallback((): void => {
    setShowCustomizeView(true, "memory")
  }, [setShowCustomizeView])
  const handleOpenRobotSettings = useCallback((): void => {
    setShowCustomizeView(true, "robot")
  }, [setShowCustomizeView])

  const canChangeAgentMode = canChangeThreadAgentMode({
    historyLoading,
    conversationPresence: historyConversationPresence,
    residentMessageCount: threadMessages.length
  })
  const queuedApprovalCount = Math.max(0, pendingApprovals.length - 1)

  useEffect(() => {
    if (!goalUi.goal) {
      setGoalDetailsOpen(false)
    }
  }, [goalUi.goal])

  const hasRunningCoordinatorWorker = coordinatorWorkers.some(
    (worker) => worker.status === "running"
  )
  const isLoading = streamData.isLoading || scheduledTaskLoading
  const isHarnessContextReminderEnabled =
    surface === "harness-project" && Boolean(harnessFeatureBinding) && !readOnly
  const agentModeSwitchDisabledReason = !canChangeAgentMode
    ? historyLoading
      ? "会话历史加载中，暂时不能切换执行模式。"
      : historyConversationPresence === "unknown"
        ? "会话消息状态尚未确认，请稍后重试。"
        : "当前线程已有消息，执行模式已锁定，请新开线程切换。"
    : isLoading
      ? "当前请求执行中，结束后才能切换执行模式。"
      : undefined

  const handleAgentModeChange = useCallback(
    (nextMode: ChatAgentMode): void => {
      if (submitInFlightRef.current.has(threadId)) {
        toast.message("消息正在提交，请稍后切换执行模式")
        return
      }
      const requestId = ++agentModeChangeRequestRef.current
      const operation = agentModeChangeChainRef.current.then(async () => {
        if (disableCoordinatorModeOption && nextMode === "coordinator") {
          toast.error("项目模式暂不支持 Agent Team。")
          return
        }
        if (disableWorkflowModeOption && nextMode === "workflow") {
          toast.error("项目模式暂不支持 Workflow。")
          return
        }
        if (historyLoading) {
          toast.error("会话历史加载中，暂时不能切换执行模式。")
          return
        }
        if (
          !canChangeThreadAgentMode({
            historyLoading,
            conversationPresence: historyConversationPresence,
            residentMessageCount: threadMessages.length
          })
        ) {
          if (historyConversationPresence === "unknown") {
            toast.error("会话消息状态尚未确认，请稍后重试。")
            return
          }
          toast.error("当前线程已有消息，不能再切换执行模式。请新开线程选择其他模式。")
          return
        }
        if (nextMode !== "coordinator" && !disableCoordinatorModeOption) {
          const isEnvironmentForcedCoordinator = await window.api.agent
            .isCoordinatorModeForced(threadId)
            .catch(() => false)
          if (requestId !== agentModeChangeRequestRef.current) return
          if (isEnvironmentForcedCoordinator) {
            toast.error("当前环境变量强制开启 Agent Team，不能切换到其他执行模式")
            return
          }
          const workers = await window.api.agent
            .getCoordinatorWorkers(threadId, { subscribeUpdates: false })
            .catch(() => [])
          if (requestId !== agentModeChangeRequestRef.current) return
          const hasPendingNotifications = await window.api.agent
            .hasCoordinatorWorkerNotifications(threadId)
            .catch(() => false)
          if (requestId !== agentModeChangeRequestRef.current) return
          const hasRemoteUnresolvedWorkers = workers.some(
            (worker) => worker.status === "running" || worker.notification_acknowledged === false
          )
          if (hasRemoteUnresolvedWorkers || hasPendingNotifications) {
            toast.error("仍有 Agent Team worker 在运行或结果待处理，请先处理完成后再切换执行模式")
            return
          }
        }

        if (requestId !== agentModeChangeRequestRef.current) return
        agentModeHydratedRef.current = true
        setAgentMode(nextMode)
        const set: Record<string, unknown> = {
          agentMode: nextMode === "multi" ? "normal" : nextMode
        }
        const remove: string[] = []
        if (nextMode === "normal" || nextMode === "multi") {
          set.subagentsEnabled = nextMode === "multi"
        } else {
          remove.push("subagentsEnabled")
        }
        if (nextMode !== "coordinator") {
          remove.push("coordinatorMode")
        }
        await patchThreadMetadata(threadId, { set, remove })
        persistedAgentModeRef.current = nextMode
      })
      // Serialize writes so an older request can never finish after a newer one
      // and overwrite thread metadata with the wrong execution mode.
      agentModeSaveRef.current = operation
      agentModeChangeChainRef.current = operation.catch(() => undefined)
      void operation
        .catch((error) => {
          if (requestId !== agentModeChangeRequestRef.current) return
          console.error("[ChatContainer] Failed to update agent mode:", error)
          agentModeHydratedRef.current = true
          setAgentMode(persistedAgentModeRef.current)
          toast.error("Agent 模式保存失败，请重试")
        })
        .finally(() => {
          if (agentModeSaveRef.current === operation) {
            agentModeSaveRef.current = Promise.resolve()
          }
        })
    },
    [
      disableCoordinatorModeOption,
      disableWorkflowModeOption,
      historyLoading,
      historyConversationPresence,
      threadId,
      threadMessages,
      patchThreadMetadata
    ]
  )
  const userInputScrollPadding = pendingUserInput
    ? Math.ceil((userInputDialogLayout?.height ?? 320) + 24)
    : undefined

  const handleUserInputDialogLayoutChange = useCallback(
    (layout: UserInputRequestDialogLayout | null): void => {
      setUserInputDialogLayout((prev) => {
        if (!layout) return prev === null ? prev : null

        const next = {
          height: Math.ceil(layout.height),
          top: Math.round(layout.top),
          bottom: Math.round(layout.bottom)
        }
        if (
          prev &&
          prev.height === next.height &&
          prev.top === next.top &&
          prev.bottom === next.bottom
        ) {
          return prev
        }
        return next
      })
    },
    []
  )

  // ── File attachments state ──
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [mentionedFiles, setMentionedFiles] = useState<MentionedWorkspaceFile[]>([])
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const attachmentsRef = useRef<FileAttachment[]>([])
  const mentionedFilesRef = useRef<MentionedWorkspaceFile[]>([])
  const activeAtFilePreviewTokensRef = useRef(new Set<string>())

  // Keep ref in sync with state
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    mentionedFilesRef.current = mentionedFiles
  }, [mentionedFiles])
  useEffect(() => {
    setMentionedFiles((current) => {
      const retained = retainMentionedWorkspaceFilesForWorkspace(current, workspacePath)
      if (retained.length === current.length) return current
      mentionedFilesRef.current = retained
      return retained
    })
  }, [workspacePath])
  useEffect(
    () => () => {
      for (const requestToken of activeAtFilePreviewTokensRef.current) {
        void window.api.workspace.cancelFilePreview({
          lanePrefix: AT_FILE_PREVIEW_LANE,
          requestToken
        })
      }
      activeAtFilePreviewTokensRef.current.clear()
    },
    []
  )

  const totalAttachmentChars = useMemo(
    () => attachments.reduce((sum, a) => sum + a.content.length, 0),
    [attachments]
  )
  const totalMentionedFileChars = useMemo(
    () => mentionedFiles.reduce((sum, file) => sum + (file.contentChars ?? 0), 0),
    [mentionedFiles]
  )
  const totalPendingFileChars = totalAttachmentChars + totalMentionedFileChars
  const totalPendingFileCount = attachments.length + mentionedFiles.length
  const hasPendingFilePayload = totalPendingFileCount > 0

  const handleAttachmentInputs = useCallback(
    async (inputs: PendingAttachmentInput[]) => {
      if (inputs.length === 0 || attachmentLoading) return
      setAttachmentLoading(true)
      clearError()
      try {
        const snapshot = attachmentsRef.current
        let currentCount = snapshot.length + mentionedFilesRef.current.length
        let currentChars = snapshot.reduce((sum, a) => sum + a.content.length, 0)
        const existingPaths = new Set([
          ...snapshot.map((a) => a.filePath),
          ...mentionedFilesRef.current.map((item) => item.absolutePath)
        ])

        for (const input of inputs) {
          const displayIdentity = input.kind === "selected" ? input.filePath : input.fileName
          // #7: skip duplicates
          if (existingPaths.has(displayIdentity)) {
            const dupName = displayIdentity.replace(/^.*[/\\]/, "") || displayIdentity
            setError(`文件"${dupName}"已添加，跳过重复`)
            continue
          }

          // #6: check extension before calling backend
          const lastDot = displayIdentity.lastIndexOf(".")
          const ext = lastDot >= 0 ? displayIdentity.substring(lastDot).toLowerCase() : ""
          if (!ext || !SUPPORTED_EXTS.has(ext)) {
            const fileName = displayIdentity.replace(/^.*[/\\]/, "") || displayIdentity
            if (ext === ".doc") {
              setError(`不支持的文件类型"${fileName}"；${DOC_SAVE_AS_DOCX_HINT}`)
            } else {
              setError(`不支持的文件类型"${fileName}"，仅支持 txt、md、csv、docx、xlsx、xls`)
            }
            continue
          }

          if (currentCount >= MAX_ATTACHMENTS) {
            setError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`)
            break
          }

          const remaining = MAX_TOTAL_CHARS - currentChars
          if (remaining <= 0) {
            setError(`附件总内容已达上限（${MAX_TOTAL_CHARS.toLocaleString()} 字符）`)
            break
          }
          const result =
            input.kind === "selected"
              ? await window.api.file.parseSelected({
                  grant: input.grant,
                  filePath: input.filePath,
                  maxLength: remaining
                })
              : await window.api.file.parseBytes({
                  fileName: input.fileName,
                  bytes: input.bytes,
                  maxLength: remaining
                })
          if (result.success && result.attachment) {
            // #12: skip empty files
            if (!result.attachment.content.trim()) {
              if (result.attachment.filename.toLowerCase().endsWith(".docx")) {
                setError(
                  `文件 "${result.attachment.filename}" 内容为空；若原始文件为 doc，请${DOC_SAVE_AS_DOCX_HINT}`
                )
              } else {
                setError(`文件 "${result.attachment.filename}" 内容为空`)
              }
              continue
            }
            setAttachments((prev) => [...prev, result.attachment!])
            existingPaths.add(result.attachment.filePath)
            currentCount++
            currentChars += result.attachment.content.length
          } else {
            setError(result.error || "文件解析失败")
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "文件处理异常")
      } finally {
        setAttachmentLoading(false)
      }
    },
    [setError, clearError, attachmentLoading]
  )

  const handleAttachClick = useCallback(async () => {
    if (attachmentsRef.current.length + mentionedFilesRef.current.length >= MAX_ATTACHMENTS) {
      setError(`最多只能添加 ${MAX_ATTACHMENTS} 个文件`)
      return
    }
    const result = await window.api.file.select()
    if (result.error) setError(result.error)
    if (!result.canceled && result.files.length > 0) {
      await handleAttachmentInputs(
        result.files.map((file) => ({ kind: "selected" as const, ...file }))
      )
    }
  }, [handleAttachmentInputs, setError])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])
  const removeMentionedFile = useCallback((index: number) => {
    setMentionedFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const dropZoneRef = useRef<HTMLDivElement>(null)

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      if (attachmentLoading) return
      const files = e.dataTransfer.files
      if (files.length > 0) {
        const availableSlots = Math.max(
          0,
          MAX_ATTACHMENTS - attachmentsRef.current.length - mentionedFilesRef.current.length
        )
        const inputs: PendingAttachmentInput[] = []
        for (const file of Array.from(files).slice(0, availableSlots)) {
          const lastDot = file.name.lastIndexOf(".")
          const ext = lastDot >= 0 ? file.name.substring(lastDot).toLowerCase() : ""
          if (!SUPPORTED_EXTS.has(ext)) {
            setError(`不支持的文件类型"${file.name}"，仅支持 txt、md、csv、docx、xlsx、xls`)
            continue
          }
          if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
            setError(`文件"${file.name}"过大，单文件不超过 5MB`)
            continue
          }
          inputs.push({ kind: "bytes", fileName: file.name, bytes: await file.arrayBuffer() })
        }
        if (inputs.length > 0) {
          await handleAttachmentInputs(inputs)
        }
      }
    },
    [handleAttachmentInputs, attachmentLoading, setError]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only show drag indicator if dragging files (not text)
    if (e.dataTransfer.types.includes("Files")) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only clear if leaving the drop zone (not entering a child element)
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setDragOver(false)
    }
  }, [])

  // Prevent Electron from navigating to dropped files (default browser behavior)
  // Use capture phase so it runs before React's synthetic events
  useEffect(() => {
    const preventNav = (e: DragEvent): void => {
      // Allow events on our drop zone to propagate to React handlers
      if (dropZoneRef.current?.contains(e.target as Node)) return
      e.preventDefault()
    }
    document.addEventListener("dragover", preventNav, true)
    document.addEventListener("drop", preventNav, true)
    return () => {
      document.removeEventListener("dragover", preventNav, true)
      document.removeEventListener("drop", preventNav, true)
    }
  }, [])

  // ── End file attachments ──

  // 从模型配置中获取用户设置的上下文窗口大小
  useEffect(() => {
    if (!currentModel) {
      setModelContextLimit(undefined)
      return
    }
    const match = models.find((model) => model.id === currentModel)
    setModelContextLimit(match?.maxTokens)
  }, [currentModel, models])

  useEffect(() => {
    const fetchYoloMode = (): void => {
      window.api.sandbox
        .getYoloMode()
        .then((nextYoloMode) => {
          setYoloMode(nextYoloMode)
          setYoloModeLoaded(true)
        })
        .catch((e) => {
          setYoloModeLoaded(true)
          console.warn("[YoloMode] Failed to fetch:", e)
        })
    }
    fetchYoloMode()
    return window.api.sandbox.onChanged(fetchYoloMode)
  }, [])

  const uploadLoChatDataForThread = useCallback(
    async (targetThreadId: string, batch: ChatReportBatch, attempt = 0) => {
      if (chatReportDisposedRef.current) return
      if (chatReportAbortControllersRef.current[targetThreadId]) {
        // Per thread, retain only the newest pending report while one bounded request is active.
        chatReportPendingBatchesRef.current[targetThreadId] = { batch, attempt }
        return
      }
      const reservedIds = reserveChatReportMessageIds(targetThreadId, batch.messageIds)
      if (reservedIds.length === 0) return

      const controller = new AbortController()
      chatReportAbortControllersRef.current[targetThreadId] = controller
      try {
        await uploadChatData(targetThreadId, batch.payload, controller.signal)
        markChatReportUploadSucceeded(targetThreadId, reservedIds)
      } catch (error) {
        markChatReportUploadFailed(targetThreadId, reservedIds)
        if (
          !controller.signal.aborted &&
          !chatReportDisposedRef.current &&
          attempt < CHAT_REPORT_MAX_RETRY_ATTEMPTS
        ) {
          chatReportRetryBatchesRef.current[targetThreadId] = {
            batch,
            attempt: attempt + 1
          }
          if (!chatReportRetryTimersRef.current[targetThreadId]) {
            const retryThreadId = targetThreadId
            const retryDelayMs = Math.min(CHAT_REPORT_RETRY_DELAY_MS * 2 ** attempt, 30_000)
            chatReportRetryTimersRef.current[retryThreadId] = window.setTimeout(() => {
              delete chatReportRetryTimersRef.current[retryThreadId]
              if (chatReportDisposedRef.current) return
              const retryItem = chatReportRetryBatchesRef.current[retryThreadId]
              delete chatReportRetryBatchesRef.current[retryThreadId]
              if (
                retryItem &&
                !chatReportAbortControllersRef.current[retryThreadId] &&
                !chatReportPendingBatchesRef.current[retryThreadId]
              ) {
                void uploadLoChatDataForThread(retryThreadId, retryItem.batch, retryItem.attempt)
              }
            }, retryDelayMs)
          }
        }
        console.warn("[Upload] chat数据上报失败:", error)
      } finally {
        if (chatReportAbortControllersRef.current[targetThreadId] === controller) {
          delete chatReportAbortControllersRef.current[targetThreadId]
        }
        if (!chatReportDisposedRef.current) {
          const pending = chatReportPendingBatchesRef.current[targetThreadId]
          delete chatReportPendingBatchesRef.current[targetThreadId]
          if (pending) {
            const retryTimer = chatReportRetryTimersRef.current[targetThreadId]
            if (retryTimer) window.clearTimeout(retryTimer)
            delete chatReportRetryTimersRef.current[targetThreadId]
            delete chatReportRetryBatchesRef.current[targetThreadId]
            void uploadLoChatDataForThread(targetThreadId, pending.batch, pending.attempt)
          }
        }
      }
    },
    []
  )

  const scheduleChatReportUpload = useCallback(
    (targetThreadId: string, msgs: Message[]) => {
      const batch = buildLatestChatReportBatch(msgs)
      if (!batch) return
      const existingTimer = chatReportUploadTimersRef.current[targetThreadId]
      if (existingTimer) window.clearTimeout(existingTimer)
      chatReportUploadTimersRef.current[targetThreadId] = window.setTimeout(() => {
        delete chatReportUploadTimersRef.current[targetThreadId]
        if (chatReportDisposedRef.current) return
        void uploadLoChatDataForThread(targetThreadId, batch)
      }, CHAT_REPORT_UPLOAD_DEBOUNCE_MS)
    },
    [uploadLoChatDataForThread]
  )

  useEffect(() => {
    chatReportDisposedRef.current = false
    return () => {
      chatReportDisposedRef.current = true
      for (const timer of Object.values(chatReportUploadTimersRef.current)) {
        window.clearTimeout(timer)
      }
      for (const timer of Object.values(chatReportRetryTimersRef.current)) {
        window.clearTimeout(timer)
      }
      for (const controller of Object.values(chatReportAbortControllersRef.current)) {
        controller?.abort(new DOMException("Chat surface disposed", "AbortError"))
      }
      chatReportUploadTimersRef.current = {}
      chatReportRetryTimersRef.current = {}
      chatReportRetryBatchesRef.current = {}
      chatReportPendingBatchesRef.current = {}
      chatReportAbortControllersRef.current = {}
    }
  }, [])

  // Check if sandbox NUX is needed. The main process currently defaults sandbox mode to
  // "none", so this remains dormant unless the setup flow is re-enabled later.
  useEffect(() => {
    window.api.sandbox
      .isNuxNeeded()
      .then((needed) => {
        if (!needed) return
        setShowNux(true)
        setNuxLoading(true)
        setNuxError(null)
        window.api.sandbox
          .completeNux("elevated")
          .then(() => setShowNux(false))
          .catch(() => {
            // Elevated failed but main process already fell back to unelevated — just close NUX
            setShowNux(false)
          })
      })
      .catch((e) => console.warn("[NUX] Failed to check:", e))
  }, [])

  // Cycle loading step messages while NUX is configuring
  useEffect(() => {
    if (!nuxLoading) {
      setNuxLoadingStep(0)
      return
    }
    const timers = [
      setTimeout(() => setNuxLoadingStep(1), 3_000),
      setTimeout(() => setNuxLoadingStep(2), 12_000),
      setTimeout(() => setNuxLoadingStep(3), 30_000),
      setTimeout(() => setNuxLoadingStep(4), 60_000)
    ]
    return () => timers.forEach(clearTimeout)
  }, [nuxLoading])

  // Thinking messages: loading 时轮换提示语
  useEffect(() => {
    const currentMessageCount = streamData.messages.length

    if (!isLoading) {
      wasLoadingRef.current = false
      loadingMessageCountRef.current = 0
      return
    }

    // First entering loading for this turn.
    if (!wasLoadingRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      loadingMessageCountRef.current = currentMessageCount
      wasLoadingRef.current = true
      return
    }

    // During the same turn, if new streamed messages arrive (e.g. tool round-trip),
    // switch to next slogan once to mimic "stage changed" feedback.
    if (currentMessageCount > loadingMessageCountRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      loadingMessageCountRef.current = currentMessageCount
    }
  }, [isLoading, streamData.messages.length])

  useEffect(() => {
    if (historyLoading) return
    if (!isLoading) {
      scheduleChatReportUpload(threadId, threadMessages)
    }
  }, [historyLoading, isLoading, scheduleChatReportUpload, threadId, threadMessages])

  // Guards against a rapid double-click on the git_push approve button firing two
  // workspace:pushWorktree calls before the pending approval is cleared on re-render.
  const gitPushInFlightRef = useRef<Set<string>>(new Set())
  const handleApprovalDecision = useCallback(
    async (decision: ChatApprovalDecision): Promise<void> => {
      if (!pendingApproval) return

      // Check if this is an orchestrator-sourced approval (has requestId)
      const approvalAny = pendingApproval as unknown as Record<string, unknown>
      if (approvalAny._orchestratorRequestId) {
        const requestId = approvalAny._orchestratorRequestId as string
        const toolCallId = pendingApproval.tool_call?.id || ""
        const isApprove =
          decision === "approve" ||
          decision === "approve_session" ||
          decision === "approve_permanent"

        // git_push → the renderer performs the push via workspace:pushWorktree (the same
        // path as the Git Panel) and reports the outcome back, instead of the orchestrator
        // running the raw (sandboxed, timeout-prone) command.
        if (approvalAny.operation === "git_push" && isApprove) {
          // Re-entry guard: ignore a second click for the same push while it is in flight.
          if (gitPushInFlightRef.current.has(requestId)) return
          gitPushInFlightRef.current.add(requestId)
          setToolCallState(toolCallId, { status: "running" })
          removePendingApproval(pendingApproval.id)
          try {
            const res = await window.api.workspace.pushWorktree(threadId, {
              worktreePath:
                typeof approvalAny.suggestedGitWorktreePath === "string"
                  ? approvalAny.suggestedGitWorktreePath
                  : undefined
            })
            if (!res.success) {
              setToolCallState(toolCallId, {
                status: "failed",
                reason: res.error || "推送失败"
              })
            }
            window.api.sandbox.sendApprovalDecision({
              requestId,
              type: res.success ? "approve" : "error",
              tool_call_id: toolCallId,
              pushResult: { success: res.success, error: res.error }
            })
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : "推送失败"
            setToolCallState(toolCallId, {
              status: "failed",
              reason: errorMessage
            })
            window.api.sandbox.sendApprovalDecision({
              requestId,
              type: "error",
              tool_call_id: toolCallId,
              pushResult: { success: false, error: errorMessage }
            })
          } finally {
            gitPushInFlightRef.current.delete(requestId)
          }
          return
        }

        // Send decision to main process via the orchestrator's IPC channel
        window.api.sandbox.sendApprovalDecision({
          requestId,
          type: decision === "edit" ? "reject" : decision,
          tool_call_id: toolCallId
        })
        setToolCallState(pendingApproval.tool_call?.id || "", {
          status:
            decision === "approve" ||
            decision === "approve_session" ||
            decision === "approve_permanent"
              ? "running"
              : "rejected"
        })
        removePendingApproval(pendingApproval.id)
        return
      }

      // Legacy HITL approval path (non-execute tools)
      if (!stream) {
        setToolCallState(pendingApproval.tool_call?.id || "", { status: "rejected" })
        removePendingApproval(pendingApproval.id)
        return
      }
      setToolCallState(pendingApproval.tool_call?.id || "", {
        status:
          decision === "approve" ||
          decision === "approve_session" ||
          decision === "approve_permanent"
            ? "running"
            : "rejected"
      })
      removePendingApproval(pendingApproval.id)

      try {
        const legacyDecision =
          decision === "approve_session" || decision === "approve_permanent" ? "approve" : decision
        await stream.submit(null, {
          command: {
            resume: {
              decision: legacyDecision,
              pendingCount: pendingApproval.pendingCount,
              allowRuntimeRestoredCheckpointResume:
                pendingApproval.allowRuntimeRestoredCheckpointResume === true
            }
          },
          config: {
            configurable: {
              thread_id: threadId,
              model_id: currentModel,
              agent_mode: agentMode === "multi" ? "normal" : agentMode
            }
          }
        })
      } catch (err) {
        console.error("[ChatContainer] Resume command failed:", err)
      }
    },
    [
      currentModel,
      agentMode,
      pendingApproval,
      setToolCallState,
      removePendingApproval,
      stream,
      threadId
    ]
  )

  useEffect(() => {
    if (!yoloModeLoaded || !yoloMode || !pendingApproval) return
    const approvalRecord = pendingApproval as unknown as Record<string, unknown>
    if (approvalRecord._orchestratorRequestId && approvalRecord.operation === "git_push") {
      void handleApprovalDecision("approve")
    }
  }, [handleApprovalDecision, pendingApproval, yoloMode, yoloModeLoaded])

  // The pending git_commit approval (agent ran `git commit` → task-card dialog), if any.
  const agentCommitApproval = useMemo(() => {
    const approval = pendingApproval as unknown as
      | (Record<string, unknown> & {
          id?: string
          operation?: string
          suggestedCommitMessage?: string
          suggestedCommitFilePaths?: string[]
          suggestedCommitFileBasePath?: string
          suggestedGitWorktreePath?: string
          suggestedGitRepositories?: Array<{
            path: string
            displayPath: string
            gitRoot: string
          }>
          suggestedCommitFileSelectionSource?: "pathspec" | "staged"
        })
      | null
    return approval?.operation === "git_commit" ? approval : null
  }, [pendingApproval])

  // The renderer already performed the commit via commitWorktree; resolve the agent's
  // approval with the outcome so the orchestrator returns the result to the agent.
  const handleAgentCommitCommitted = useCallback(
    (outcome: AgentCommitOutcome): void => {
      if (!pendingApproval) return
      const approvalRecord = pendingApproval as unknown as Record<string, unknown>
      // Use only the orchestrator's request id — it is the key the main process resolves on.
      // No fallback: if it is missing the back-end invariant is broken, and silently
      // substituting another id could ACK the wrong request after the commit already ran.
      const requestId = approvalRecord._orchestratorRequestId as string | undefined
      const toolCallId = pendingApproval.tool_call?.id || ""
      if (!requestId) {
        console.error("[AgentGitCommit] missing _orchestratorRequestId after commit", {
          approvalId: pendingApproval.id,
          toolCallId
        })
        setToolCallState(toolCallId, {
          status: "failed",
          reason: "提交已执行，但审批回执缺少 requestId，无法通知 Agent。"
        })
        return
      }
      window.api.sandbox.sendApprovalDecision({
        requestId,
        type: "approve",
        tool_call_id: toolCallId,
        commitResult: outcome
      })
      setToolCallState(toolCallId, { status: "running" })
      removePendingApproval(pendingApproval.id)
    },
    [pendingApproval, setToolCallState, removePendingApproval]
  )

  const handleAgentCommitCancel = useCallback((): void => {
    if (!pendingApproval) return
    const approvalRecord = pendingApproval as unknown as Record<string, unknown>
    // Only the orchestrator's request id is a valid resolve key — see the commit path above.
    const requestId = approvalRecord._orchestratorRequestId as string | undefined
    const toolCallId = pendingApproval.tool_call?.id || ""
    if (!requestId) {
      console.error("[AgentGitCommit] missing _orchestratorRequestId while cancelling", {
        approvalId: pendingApproval.id,
        toolCallId
      })
      setToolCallState(toolCallId, {
        status: "failed",
        reason: "取消提交时缺少 requestId，无法通知 Agent。"
      })
      return
    }
    window.api.sandbox.sendApprovalDecision({
      requestId,
      type: "reject",
      tool_call_id: toolCallId
    })
    setToolCallState(toolCallId, { status: "rejected" })
    removePendingApproval(pendingApproval.id)
  }, [pendingApproval, setToolCallState, removePendingApproval])

  const handleUserInputSubmit = useCallback(
    (response: UserInputResponse): void => {
      window.api.userInput.sendResponse(response)
      setPendingUserInput(null)
      setUserInputDialogLayout(null)
    },
    [setPendingUserInput]
  )

  const agentValues = stream?.values as AgentStreamValues | undefined

  // Approval listeners are now registered globally in ThreadProvider for ALL active threads,
  // so approval requests are received even when this ChatContainer is not mounted (user viewing another tab).

  const streamTodos = agentValues?.todos
  useEffect(() => {
    if (Array.isArray(streamTodos)) {
      setTodos(
        streamTodos.map((t) => ({
          id: t.id || crypto.randomUUID(),
          content: t.content || "",
          status: (t.status || "pending") as "pending" | "in_progress" | "completed" | "cancelled"
        }))
      )
    }
  }, [streamTodos, setTodos])

  // Apple Intelligence glow: loading 时显示，淡出由 CSS animation + onAnimationEnd 控制
  useEffect(() => {
    if (!appleIntelligenceGlowEnabled) {
      setGlowVisible(false)
      return
    }
    if (isLoading) {
      setGlowVisible(true)
      return
    }
    // 兜底：如果 transitionEnd 未触发（快速切换等边界情况），3s 后强制隐藏
    const timer = setTimeout(() => setGlowVisible(false), 3000)
    return () => clearTimeout(timer)
  }, [appleIntelligenceGlowEnabled, isLoading])

  const threadDisplayBaseline = useMemo(
    () => getThreadDisplayBaseline(threadMessages, messagesContentVersion),
    [messagesContentVersion, threadMessages]
  )
  const liveDisplayProjection = threadProjectionRuntime.projectLiveDisplayMessages(
    threadMessages,
    streamData.liveMessages || []
  )
  const liveDisplayMessages = liveDisplayProjection.messages
  let projectChatMessages = threadProjectionRuntime.chatMessageProjectors.get(threadDisplayBaseline)
  if (!projectChatMessages) {
    projectChatMessages = createChatMessageProjector()
    threadProjectionRuntime.chatMessageProjectors.set(threadDisplayBaseline, projectChatMessages)
  }
  const displayMessageProjection = projectChatMessages(
    threadDisplayBaseline,
    liveDisplayMessages,
    streamData.messages,
    messagesContentVersion,
    liveDisplayProjection
  )
  const displayMessages = displayMessageProjection.messages
  const streamingSearchMessageIdRef = useRef<string | null>(null)
  streamingSearchMessageIdRef.current = isLoading
    ? (displayMessages.findLast((message) =>
        messageHasVisibleRow(
          message,
          Boolean(hookLogBucketByTurnId.get(message.id)?.entries.length)
        )
      )?.id ?? null)
    : null
  const displayMessagesContentVersion = displayMessageProjection.contentVersion
  const displayMessagesStructureVersion = displayMessageProjection.structureVersion
  const chatScrollQuestionStructureRevision =
    threadProjectionRuntime.projectChatScrollQuestionRevision({
      scopeKey: threadId,
      messages: displayMessages,
      structureVersion: displayMessagesStructureVersion,
      changedMessages: displayMessageProjection.changedMessages
    })
  const stableMessageIndexProjection = threadProjectionRuntime.projectStableMessageIndexes({
    baseline: threadDisplayBaseline,
    indexById: displayMessageProjection.indexById,
    structureVersion: displayMessagesStructureVersion,
    hookLogBucketByTurnId,
    hookLogEnabled: hookLogConfig.enabled
  })
  const orderedStableVisibleMessageIndexes = stableMessageIndexProjection.visibleIndexes
  const hasHookLogChipForMessage = useCallback(
    (message: Message): boolean =>
      Boolean(
        hookLogConfig.enabled &&
        message.role === "user" &&
        hookLogBucketByTurnId.get(message.id)?.entries.length
      ),
    [hookLogBucketByTurnId, hookLogConfig.enabled]
  )
  const dynamicVisibilityProjection = threadProjectionRuntime.projectDynamicLiveVisibility({
    live: liveDisplayProjection,
    displayMessages,
    displayIndexById: displayMessageProjection.indexById,
    displayContentVersion: displayMessagesContentVersion,
    displayStructureVersion: displayMessagesStructureVersion,
    hasHookLogChip: hasHookLogChipForMessage
  })
  const dynamicVisibilityByIndex = dynamicVisibilityProjection.byIndex
  const orderedDynamicVisibleMessageIndexes = dynamicVisibilityProjection.orderedVisibleIndexes
  const liveLastUserMessageIndex = liveDisplayProjection.lastUserMessageId
    ? displayMessageProjection.indexById.get(liveDisplayProjection.lastUserMessageId)
    : undefined
  const lastUserMessageIndex = Math.max(
    stableMessageIndexProjection.lastUserIndex,
    liveLastUserMessageIndex ?? -1
  )

  const chatScrollNavigatorMessages = displayMessages

  // Keep closed search off the token hot path. The content projector already exposes a cheap
  // scalar version, so search can refresh live text without re-joining block-array content here.
  const searchRecomputeKey = useMemo(() => {
    if (!searchOpen) return "closed"
    return `${displayMessagesContentVersion}:${displayMessages.length}:${isLoading}`
  }, [displayMessages.length, displayMessagesContentVersion, isLoading, searchOpen])

  const detachedHookLogBuckets = threadProjectionRuntime.projectDetachedHookLogBuckets({
    displayMessages,
    structureVersion: displayMessagesStructureVersion,
    hookLogBuckets
  })

  const visibleMessageIndexes = threadProjectionRuntime.projectVisibleMessageIndexes({
    stableIndexes: orderedStableVisibleMessageIndexes,
    dynamicVisibilityByIndex,
    orderedDynamicIndexes: orderedDynamicVisibleMessageIndexes,
    dynamicVersion: dynamicVisibilityProjection.version
  })
  const historyGapBeforeVisibleMessageId = useMemo(() => {
    if (!historyWindowGap) return null
    const boundaryIndex = displayMessageProjection.indexById.get(historyWindowGap.beforeMessageId)
    if (boundaryIndex === undefined) return null
    const visibleBoundaryIndex = visibleMessageIndexes.find((index) => index >= boundaryIndex)
    return visibleBoundaryIndex === undefined
      ? null
      : (displayMessages[visibleBoundaryIndex]?.id ?? null)
  }, [
    displayMessageProjection.indexById,
    displayMessages,
    displayMessagesStructureVersion,
    historyWindowGap,
    visibleMessageIndexes
  ])
  const lastVisibleMessageIndex = visibleMessageIndexes[visibleMessageIndexes.length - 1]
  const lastContentMessageId =
    lastVisibleMessageIndex === undefined
      ? null
      : (displayMessages[lastVisibleMessageIndex]?.id ?? null)

  // Ordinary assistant tokens update only the changed display slot. Keep the
  // tool projection stable and replace a slot only when that changed row is
  // itself tool-relevant.
  const toolDerivationProjection = threadProjectionRuntime.projectToolDerivationMessages(
    displayMessages,
    displayMessageProjection.changedMessages,
    displayMessagesStructureVersion
  )
  const toolDerivationMessages = toolDerivationProjection.messages
  const toolResults = threadProjectionRuntime.projectToolResults(
    toolDerivationMessages,
    toolDerivationProjection.version
  )

  const { assistantDurationMsById, userSendTimeLabelById } =
    threadProjectionRuntime.projectTimingMeta(displayMessages, displayMessagesStructureVersion)

  const { toolCallDisplayStates, pendingApprovalToolCallKeys } =
    threadProjectionRuntime.projectToolCallDisplayState({
      messages: toolDerivationMessages,
      projectionVersion: toolDerivationProjection.version,
      toolResults,
      toolCallStates,
      pendingApproval,
      isLoading,
      compute: () => {
        const orderedToolCalls: Array<{
          key: string
          call: { id: string; name: string; args: Record<string, unknown> }
        }> = []

        for (const message of toolDerivationMessages) {
          if (!Array.isArray(message.tool_calls)) continue
          message.tool_calls.forEach((toolCall, index) => {
            if (!toolCall?.id) return
            orderedToolCalls.push({
              key: getWorkerToolUiKey(message.id, toolCall.id, index),
              call: toolCall
            })
          })
        }

        const lastOccurrenceKeyByCallId = new Map<string, string>()
        for (const { key, call } of orderedToolCalls) lastOccurrenceKeyByCallId.set(call.id, key)

        const currentApprovalIds = new Set<string>()
        if (pendingApproval?.pendingToolCallIds?.length) {
          for (const id of pendingApproval.pendingToolCallIds) {
            if (id) currentApprovalIds.add(id)
          }
        } else if (pendingApproval?.tool_call?.id) {
          currentApprovalIds.add(pendingApproval.tool_call.id)
        }
        const approvalKeys = new Set<string>()
        for (const id of currentApprovalIds) {
          const key = lastOccurrenceKeyByCallId.get(id)
          if (key) approvalKeys.add(key)
        }

        let activeAssigned = false
        const nextStates = new Map<string, ToolCallState>()

        for (const { key, call: toolCall } of orderedToolCalls) {
          const baseState =
            lastOccurrenceKeyByCallId.get(toolCall.id) === key
              ? toolCallStates[toolCall.id]
              : undefined
          const mergedArgs = mergeToolCallArgs(baseState?.args, toolCall.args)
          const result = toolResults.get(key)
          let status: ToolCallStatus

          if (result !== undefined) {
            status = result.is_error ? "failed" : "completed"
          } else if (isTerminalToolCallStatus(baseState?.status)) {
            status = baseState!.status
          } else if (approvalKeys.has(key)) {
            status = "awaiting_approval"
            activeAssigned = true
          } else if (!isLoading) {
            status = "interrupted"
          } else if (!activeAssigned) {
            status = "running"
            activeAssigned = true
          } else {
            status = "queued"
          }

          nextStates.set(key, {
            id: toolCall.id,
            status,
            name: toolCall.name || baseState?.name,
            args: mergedArgs,
            command: getToolCallCommand(mergedArgs) || baseState?.command,
            filePath: getToolCallFilePath(mergedArgs) || baseState?.filePath,
            reason: baseState?.reason,
            operation: baseState?.operation,
            code: getToolCallCode(mergedArgs) || baseState?.code,
            timeoutMs: getToolCallTimeout(mergedArgs) ?? baseState?.timeoutMs,
            updatedAt: baseState?.updatedAt ?? new Date()
          })
        }

        return {
          toolCallDisplayStates: nextStates,
          pendingApprovalToolCallKeys: approvalKeys
        }
      }
    })

  const buildSearchDocument = useCallback(
    (message: Message, sortIndex: number): ChatSearchDocument | null => {
      const hookLogBucket =
        hookLogConfig.enabled && message.role === "user"
          ? hookLogBucketByTurnId.get(message.id)
          : undefined
      const hasHookLogChip = Boolean(hookLogBucket?.entries.length)
      if (!messageHasVisibleRow(message, hasHookLogChip)) return null

      // Reasoning and Hook details are folded into controls/modals and have no highlightable text
      // in the transcript row. Search only content that reveal can actually expose in this row.
      let displayContent =
        message.role === "user" && typeof message.content === "string"
          ? cleanUserAttachmentContentForDisplay(message.content)
          : message.content
      const hasVisibleReasoning =
        message.role === "assistant" && Boolean(normalizeVisibleReasoningText(message.reasoning))
      if (hasVisibleReasoning) {
        if (typeof displayContent === "string") {
          displayContent = stripThinkBlocksForDisplay(displayContent)
        } else if (Array.isArray(displayContent)) {
          displayContent = displayContent.map((block) =>
            block.type === "text" && block.text
              ? { ...block, text: stripThinkBlocksForDisplay(block.text) }
              : block
          )
        }
      }
      let visibleContent: string
      if (
        message.role === "assistant" &&
        message.id === streamingSearchMessageIdRef.current &&
        (typeof displayContent === "string" || Array.isArray(displayContent))
      ) {
        const textBlocks =
          typeof displayContent === "string"
            ? [displayContent]
            : displayContent.flatMap((block) =>
                block.type === "text" && block.text ? [block.text] : []
              )
        visibleContent = textBlocks
          .flatMap((block) => {
            const preview = buildStreamingMarkdownPreview(block)
            return [preview.head, preview.tail].filter(Boolean)
          })
          .map((part) => projectVisibleChatSearchContent(message.role, part))
          .join("\n")
      } else {
        visibleContent = projectVisibleChatSearchContent(message.role, displayContent)
      }
      const parts: unknown[] = [visibleContent]
      for (const toolCall of message.tool_calls ?? []) {
        parts.push(getCollapsedToolCallSummary(toolCall))
      }
      const text = buildBoundedChatSearchText(parts)
      return {
        messageId: message.id,
        text,
        truncated: text.length >= CHAT_SEARCH_DOCUMENT_TEXT_LIMIT,
        durableAuthoritative: hasVisibleReasoning,
        sortIndex
      }
    },
    [hookLogBucketByTurnId, hookLogConfig.enabled]
  )
  const stableSearchDocumentsRef = useRef<{
    baseline: readonly Message[]
    baselineIndexLookup: MessageIdIndexLookup
    rawMessages: readonly Message[]
    indexById: ReadonlyMap<string, number>
    buildDocument: typeof buildSearchDocument
    gapBeforeMessageId: string | null
    contentVersion: number
    startIndex: number
    textUnits: number
    documents: ChatSearchDocument[]
    documentIndexById: Map<string, number>
  } | null>(null)
  const dynamicSearchDocumentsRef = useRef<{
    liveStructureVersion: number
    liveContentVersion: number
    displayIndexById: ReadonlyMap<string, number>
    buildDocument: typeof buildSearchDocument
    documents: ChatSearchDocument[]
    documentIndexById: Map<string, number>
  } | null>(null)
  const getSearchCorpus = useCallback((): ChatSearchCorpus => {
    let cached = stableSearchDocumentsRef.current
    let stableDocuments = cached?.documents
    const stableIdentityMatches =
      cached &&
      cached.baseline === threadDisplayBaseline &&
      cached.rawMessages === threadMessages &&
      cached.indexById === displayMessageProjection.indexById &&
      cached.buildDocument === buildSearchDocument &&
      cached.gapBeforeMessageId === (historyWindowGap?.beforeMessageId ?? null)
    if (cached && stableIdentityMatches && cached.contentVersion !== messagesContentVersion) {
      let requiresRebuild = false
      let textUnits = cached.textUnits
      const nextDocuments = [...cached.documents]
      for (const changedMessage of displayMessageProjection.changedMessages) {
        const cachedDocumentIndex = cached.documentIndexById.get(changedMessage.id)
        const baselineIndex = cached.baselineIndexLookup.findFirstIndex(changedMessage.id)
        const belongsToCachedWindow =
          baselineIndex >= cached.startIndex && baselineIndex < threadDisplayBaseline.length
        if (cachedDocumentIndex === undefined) {
          if (
            belongsToCachedWindow &&
            buildSearchDocument(
              changedMessage,
              displayMessageProjection.indexById.get(changedMessage.id) ?? baselineIndex
            )
          ) {
            requiresRebuild = true
            break
          }
          continue
        }
        const nextDocument = buildSearchDocument(
          changedMessage,
          displayMessageProjection.indexById.get(changedMessage.id) ?? baselineIndex
        )
        if (!nextDocument) {
          requiresRebuild = true
          break
        }
        textUnits += nextDocument.text.length - nextDocuments[cachedDocumentIndex].text.length
        nextDocuments[cachedDocumentIndex] = nextDocument
      }
      if (requiresRebuild) {
        stableSearchDocumentsRef.current = null
        cached = null
      } else {
        while (nextDocuments.length > 1 && textUnits > CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT) {
          textUnits -= nextDocuments.shift()?.text.length ?? 0
        }
        cached.documents = nextDocuments
        cached.documentIndexById = new Map(
          nextDocuments.map((document, index) => [document.messageId, index] as const)
        )
        cached.textUnits = textUnits
        cached.contentVersion = messagesContentVersion
        stableDocuments = nextDocuments
      }
    }
    if (
      !cached ||
      cached.baseline !== threadDisplayBaseline ||
      cached.rawMessages !== threadMessages ||
      cached.indexById !== displayMessageProjection.indexById ||
      cached.buildDocument !== buildSearchDocument ||
      cached.gapBeforeMessageId !== (historyWindowGap?.beforeMessageId ?? null)
    ) {
      // The durable search API covers the complete persisted transcript. Keep the renderer-side
      // corpus bounded to the already-visible recent page so opening search after paging through a
      // very long task cannot synchronously stringify and index the entire hydrated history.
      const documents: ChatSearchDocument[] = []
      let textUnits = 0
      // A resident gap makes the in-memory array non-contiguous. Index only the latest side of
      // that gap locally; durable results provide the omitted prefix in database order. Otherwise
      // merging "old resident prefix + durable gap + latest tail" could advertise a false order.
      const contiguousTailStartIndex = resolveChatSearchContiguousTailStart(
        threadMessages,
        threadDisplayBaseline,
        historyWindowGap?.beforeMessageId ?? null
      )
      const startIndex = Math.max(
        contiguousTailStartIndex,
        threadDisplayBaseline.length - CHAT_LOCAL_SEARCH_HISTORY_LIMIT
      )
      for (
        let messageIndex = threadDisplayBaseline.length - 1;
        messageIndex >= startIndex;
        messageIndex -= 1
      ) {
        const message = threadDisplayBaseline[messageIndex]
        const sortIndex = displayMessageProjection.indexById.get(message.id)
        if (sortIndex === undefined) continue
        const document = buildSearchDocument(message, sortIndex)
        if (!document) continue
        if (
          documents.length > 0 &&
          textUnits + document.text.length > CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT
        ) {
          break
        }
        documents.push(document)
        textUnits += document.text.length
        if (textUnits >= CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT) break
      }
      stableDocuments = documents.sort(
        (left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0)
      )
      stableSearchDocumentsRef.current = {
        baseline: threadDisplayBaseline,
        baselineIndexLookup: createMessageIdIndexLookup(threadDisplayBaseline),
        rawMessages: threadMessages,
        indexById: displayMessageProjection.indexById,
        buildDocument: buildSearchDocument,
        gapBeforeMessageId: historyWindowGap?.beforeMessageId ?? null,
        contentVersion: messagesContentVersion,
        startIndex,
        textUnits,
        documents: stableDocuments,
        documentIndexById: new Map(
          stableDocuments.map((document, index) => [document.messageId, index] as const)
        )
      }
    }
    let dynamicCache = dynamicSearchDocumentsRef.current
    const rebuildDynamicDocuments = (): typeof dynamicCache => {
      const documents: ChatSearchDocument[] = []
      let textUnits = 0
      const startIndex = Math.max(0, liveDisplayMessages.length - CHAT_LOCAL_SEARCH_HISTORY_LIMIT)
      for (
        let liveIndex = liveDisplayMessages.length - 1;
        liveIndex >= startIndex;
        liveIndex -= 1
      ) {
        const liveMessage = liveDisplayMessages[liveIndex]
        const sortIndex = displayMessageProjection.indexById.get(liveMessage.id)
        if (sortIndex === undefined) continue
        const message = displayMessages[sortIndex]
        const document = message ? buildSearchDocument(message, sortIndex) : null
        if (!document) continue
        if (
          documents.length > 0 &&
          textUnits + document.text.length > CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT
        ) {
          break
        }
        documents.push(document)
        textUnits += document.text.length
        if (textUnits >= CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT) break
      }
      documents.sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0))
      dynamicCache = {
        liveStructureVersion: liveDisplayProjection.structureVersion,
        liveContentVersion: liveDisplayProjection.contentVersion,
        displayIndexById: displayMessageProjection.indexById,
        buildDocument: buildSearchDocument,
        documents,
        documentIndexById: new Map(documents.map((document, index) => [document.messageId, index]))
      }
      dynamicSearchDocumentsRef.current = dynamicCache
      return dynamicCache
    }
    if (
      !dynamicCache ||
      dynamicCache.liveStructureVersion !== liveDisplayProjection.structureVersion ||
      dynamicCache.displayIndexById !== displayMessageProjection.indexById ||
      dynamicCache.buildDocument !== buildSearchDocument
    ) {
      dynamicCache = rebuildDynamicDocuments()
    } else if (dynamicCache.liveContentVersion !== liveDisplayProjection.contentVersion) {
      let requiresRebuild = false
      for (const liveMessage of liveDisplayProjection.changedMessages) {
        const sortIndex = displayMessageProjection.indexById.get(liveMessage.id)
        if (sortIndex === undefined) {
          requiresRebuild = true
          break
        }
        const message = displayMessages[sortIndex]
        const document = message ? buildSearchDocument(message, sortIndex) : null
        const documentIndex = dynamicCache.documentIndexById.get(liveMessage.id)
        if (!document || documentIndex === undefined) {
          requiresRebuild = true
          break
        }
        dynamicCache.documents[documentIndex] = document
      }
      if (requiresRebuild) {
        dynamicCache = rebuildDynamicDocuments()
      } else {
        dynamicCache.liveContentVersion = liveDisplayProjection.contentVersion
      }
    }
    return {
      stableDocuments: stableDocuments ?? [],
      dynamicDocuments: dynamicCache?.documents ?? [],
      dynamicMessageIds: liveDisplayProjection.messageIds
    }
  }, [
    buildSearchDocument,
    displayMessageProjection.indexById,
    displayMessages,
    displayMessagesContentVersion,
    liveDisplayProjection,
    liveDisplayMessages,
    historyWindowGap,
    messagesContentVersion,
    threadMessages,
    threadDisplayBaseline
  ])
  const setPendingDurableRevealMessageId = useCallback(
    (messageId: string | null): void => {
      pendingDurableSearchRevealIdRef.current = messageId
      const lease = chatScrollSessionLeaseRef.current
      if (lease.threadId !== threadId) return
      chatScrollSessionStore.setPendingRevealMessageId(lease, messageId)
    },
    [threadId]
  )
  const invalidateDurableMessageReveal = useCallback((): void => {
    durableMessageWindowGenerationRef.current += 1
    setPendingDurableRevealMessageId(null)
    cancelMessageWindowLoad()
  }, [cancelMessageWindowLoad, setPendingDurableRevealMessageId])
  const closeSearch = useCallback((): void => {
    invalidateDurableMessageReveal()
    stableSearchDocumentsRef.current = null
    dynamicSearchDocumentsRef.current = null
    setSearchOpen(false)
  }, [invalidateDurableMessageReveal])

  // Get the actual scrollable viewport element from Radix ScrollArea
  const getViewport = useCallback((): HTMLDivElement | null => {
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [])

  useLayoutEffect(() => {
    setScrollParent(getViewport())
  }, [getViewport, threadId])

  const applyChatScrollEvent = useCallback(
    (event: ChatScrollEvent): ChatScrollTransition => {
      const current = chatScrollStateRef.current ?? createChatScrollState(threadId)
      const transition = transitionChatScroll(current, event)
      chatScrollStateRef.current = transition.state
      setChatScrollUiState((previous) => {
        if (
          previous.generation === transition.state.generation &&
          previous.mode === transition.state.mode &&
          previous.hasUnread === transition.state.hasUnread &&
          previous.unreadCount === transition.state.unreadCount
        ) {
          return previous
        }
        return {
          generation: transition.state.generation,
          mode: transition.state.mode,
          hasUnread: transition.state.hasUnread,
          unreadCount: transition.state.unreadCount
        }
      })
      return transition
    },
    [threadId]
  )

  useLayoutEffect(() => {
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current)
      bottomScrollFrameRef.current = null
    }
    if (chatScrollStateRef.current?.threadId !== threadId) {
      const opened = chatScrollSessionStore.open(threadId)
      chatScrollSessionLeaseRef.current = opened.lease
      const restored = opened.session
      const nextState = restored?.state ?? createChatScrollState(threadId)
      chatScrollStateRef.current = nextState
      pendingChatSessionAnchorRef.current = restored?.anchor
        ? { ...restored.anchor, threadId, attempt: 0, stableFrames: 0 }
        : null
      chatContentSnapshotRef.current = restored?.contentSnapshot ?? null
      pendingDurableSearchRevealIdRef.current = opened.pendingRevealMessageId
      setChatScrollUiState({
        generation: nextState.generation,
        mode: nextState.mode,
        hasUnread: nextState.hasUnread,
        unreadCount: nextState.unreadCount
      })
    }
    pendingBottomScrollEffectRef.current = null
    bottomSettleAttemptRef.current = 0
    bottomSettleEffectKeyRef.current = ""
    lastObservedScrollTopRef.current = 0
    upwardUserScrollIntentUntilRef.current = 0
    downwardUserScrollIntentUntilRef.current = 0
    scrollbarUserIntentActiveRef.current = false
  }, [threadId])

  useEffect(() => {
    if (scrollParent || !scrollRef.current) return
    setScrollParent(getViewport())
  }, [getViewport, scrollParent])

  const visibleMessageIndexById = useMemo(() => {
    const indexById = new Map<string, number>()
    visibleMessageIndexes.forEach((messageIndex, visibleIndex) => {
      const message = displayMessages[messageIndex]
      if (message) indexById.set(message.id, visibleIndex)
    })
    return indexById
  }, [displayMessages, displayMessagesStructureVersion, visibleMessageIndexes])
  const isMessageVirtualizationEnabled = shouldVirtualizeChatMessageList(
    visibleMessageIndexes.length
  )
  lastVisibleMessageIndexRef.current = visibleMessageIndexes.length - 1
  messageVirtualizationEnabledRef.current = isMessageVirtualizationEnabled
  useEffect(() => {
    pendingDurableHistoryAnchorRef.current = null
  }, [threadId])

  const scheduleBottomScrollEffect = useCallback(
    (effect: ChatScrollEffect): void => {
      pendingBottomScrollEffectRef.current = mergeChatScrollEffects(
        pendingBottomScrollEffectRef.current,
        effect
      )
      if (bottomScrollFrameRef.current !== null) return

      const run = (): void => {
        bottomScrollFrameRef.current = null
        const pending = pendingBottomScrollEffectRef.current
        pendingBottomScrollEffectRef.current = null
        const state = chatScrollStateRef.current
        if (!pending || !state || pending.generation !== state.generation) return

        const viewport = getViewport()
        const lastVisibleIndex = lastVisibleMessageIndexRef.current
        if (!viewport || lastVisibleIndex < 0) {
          applyChatScrollEvent({
            type:
              pending.reason === "content-appended" || pending.reason === "content-grown"
                ? "PROGRAMMATIC_SCROLL_END"
                : "SCROLL_TO_BOTTOM_FAILED",
            generation: pending.generation
          })
          return
        }

        if (messageVirtualizationEnabledRef.current && virtuosoRef.current) {
          virtuosoRef.current.scrollToIndex({
            index: lastVisibleIndex,
            align: "end",
            behavior: "auto"
          })
        }
        // The Virtuoso footer lives after the last indexed message (queued rows, loading state,
        // approvals, user-input cards). scrollToIndex mounts/measures the last row; this final
        // bounded write includes the footer and is skipped when the viewport is already settled.
        const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        if (Math.abs(viewport.scrollTop - bottom) > 1) {
          viewport.scrollTo({ top: bottom, behavior: "auto" })
        }

        const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
        if (distanceToBottom <= CHAT_AT_BOTTOM_THRESHOLD_PX) {
          bottomSettleAttemptRef.current = 0
          applyChatScrollEvent({
            type: "BOTTOM_CONFIRMED",
            generation: pending.generation
          })
          return
        }

        const longSettle =
          pending.reason === "initial-position" ||
          pending.reason === "return-to-bottom" ||
          pending.reason === "restore-complete"
        const settleKey = `${pending.generation}:${pending.reason}`
        if (bottomSettleEffectKeyRef.current !== settleKey) {
          bottomSettleEffectKeyRef.current = settleKey
          bottomSettleAttemptRef.current = 0
        }
        const settleLimit = longSettle
          ? CHAT_BOTTOM_SETTLE_MAX_FRAMES
          : CHAT_FOLLOW_SETTLE_MAX_FRAMES
        if (bottomSettleAttemptRef.current < settleLimit) {
          bottomSettleAttemptRef.current += 1
          pendingBottomScrollEffectRef.current = mergeChatScrollEffects(
            pendingBottomScrollEffectRef.current,
            pending
          )
          bottomScrollFrameRef.current = window.requestAnimationFrame(run)
          return
        }

        bottomSettleAttemptRef.current = 0
        bottomSettleEffectKeyRef.current = ""
        applyChatScrollEvent({
          type: longSettle ? "SCROLL_TO_BOTTOM_FAILED" : "PROGRAMMATIC_SCROLL_END",
          generation: pending.generation
        })
      }

      bottomScrollFrameRef.current = window.requestAnimationFrame(run)
    },
    [applyChatScrollEvent, getViewport]
  )

  const runChatScrollTransition = useCallback(
    (transition: ChatScrollTransition): ChatScrollState => {
      if (transition.state.mode === "restoring" || isChatScrollDetached(transition.state)) {
        pendingBottomScrollEffectRef.current = null
        if (bottomScrollFrameRef.current !== null) {
          window.cancelAnimationFrame(bottomScrollFrameRef.current)
          bottomScrollFrameRef.current = null
        }
      }
      for (const effect of transition.effects) scheduleBottomScrollEffect(effect)
      return transition.state
    },
    [scheduleBottomScrollEffect]
  )

  const dispatchChatScrollEvent = useCallback(
    (event: ChatScrollEvent): ChatScrollState => {
      let nextState = runChatScrollTransition(applyChatScrollEvent(event))
      // A real user gesture during page-anchor restoration owns the viewport. Cancel the restore
      // session immediately so its next animation frame cannot pull the reader back to the old
      // anchor after wheel/touch/keyboard navigation.
      if (event.type === "USER_DETACH" && pendingDurableHistoryAnchorRef.current) {
        pendingDurableHistoryAnchorRef.current = null
        nextState = runChatScrollTransition(
          applyChatScrollEvent({ type: "RESTORE_END", generation: nextState.generation })
        )
      }
      return nextState
    },
    [applyChatScrollEvent, runChatScrollTransition]
  )

  const waitForTranscriptCommit = useCallback(
    (): Promise<void> =>
      new Promise((resolve) => {
        window.requestAnimationFrame(() => resolve())
      }),
    []
  )

  const scrollToConversationBottom = useCallback((): void => {
    const revealGeneration = durableMessageWindowGenerationRef.current + 1
    durableMessageWindowGenerationRef.current = revealGeneration
    setPendingDurableRevealMessageId(null)
    cancelMessageWindowLoad()
    pendingChatSessionAnchorRef.current = null
    // Persist the user's intent before waiting for disk. If the chat unmounts while the latest
    // page is loading (for example, a file tab opens), cleanup must save `following`, not the
    // detached state that existed before the click.
    dispatchChatScrollEvent({ type: "RETURN_TO_BOTTOM" })

    void (async () => {
      if (historyWindowGap || historyPageLoading) {
        const restored = await restoreLatestMessageWindow()
        if (
          !chatViewMountedRef.current ||
          durableMessageWindowGenerationRef.current !== revealGeneration
        ) {
          return
        }
        if (!restored) {
          toast.error("恢复最新消息失败，请稍后重试")
          return
        }
        await waitForTranscriptCommit()
      }
      if (
        !chatViewMountedRef.current ||
        durableMessageWindowGenerationRef.current !== revealGeneration
      ) {
        return
      }
      dispatchChatScrollEvent({ type: "RETURN_TO_BOTTOM" })
    })()
  }, [
    cancelMessageWindowLoad,
    dispatchChatScrollEvent,
    historyPageLoading,
    historyWindowGap,
    restoreLatestMessageWindow,
    setPendingDurableRevealMessageId,
    waitForTranscriptCommit
  ])

  useLayoutEffect(() => {
    chatViewMountedRef.current = true
    const sessionLease = chatScrollSessionLeaseRef.current
    return () => {
      chatViewMountedRef.current = false
      durableMessageWindowGenerationRef.current += 1
      const state = chatScrollStateRef.current
      if (state?.threadId === threadId) {
        const viewport = getViewport()
        let anchor: ChatScrollSessionAnchor | null = null
        // A durable reveal that is still loading owns the remount destination. Saving the old
        // viewport anchor here would race it and pull the reopened chat back to stale content.
        if (viewport && isChatScrollDetached(state) && !pendingDurableSearchRevealIdRef.current) {
          const viewportTop = viewport.getBoundingClientRect().top
          let closestDistance = Number.POSITIVE_INFINITY
          for (const candidate of viewport.querySelectorAll<HTMLElement>(
            "[data-chat-message-id]"
          )) {
            const messageId = candidate.dataset.chatMessageId
            if (!messageId) continue
            const offsetFromViewportTop = candidate.getBoundingClientRect().top - viewportTop
            const distance = Math.abs(offsetFromViewportTop)
            if (distance >= closestDistance) continue
            closestDistance = distance
            anchor = { messageId, offsetFromViewportTop }
          }
        }
        chatScrollSessionStore.save(sessionLease, {
          state,
          anchor,
          contentSnapshot: chatContentSnapshotRef.current
        })
      }
      pendingBottomScrollEffectRef.current = null
      if (bottomScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollFrameRef.current)
        bottomScrollFrameRef.current = null
      }
    }
  }, [getViewport, threadId])
  const searchDurableMessages = useCallback(
    (query: string, options: DurableChatSearchOptions): Promise<DurableChatSearchPage> => {
      return window.api.threads.searchMessages(threadId, query, options)
    },
    [threadId]
  )
  const revealDurableMessage = useCallback(
    async (match: DurableChatSearchMatch): Promise<void> => {
      if (!shouldHydrateDurableSearchMatch(match.messageId, visibleMessageIndexById)) {
        // The overlay's common reveal path mounts/centers this resident virtual row immediately.
        return
      }
      const revealGeneration = durableMessageWindowGenerationRef.current + 1
      durableMessageWindowGenerationRef.current = revealGeneration
      pendingChatSessionAnchorRef.current = null
      setPendingDurableRevealMessageId(match.messageId)
      dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
      const loaded = await loadMessageWindowAround(match)
      if (
        !chatViewMountedRef.current ||
        durableMessageWindowGenerationRef.current !== revealGeneration
      ) {
        throw new Error("Durable chat reveal was superseded")
      }
      if (!loaded) {
        setPendingDurableRevealMessageId(null)
        throw new Error("Unable to hydrate durable chat search result")
      }
      await waitForTranscriptCommit()
    },
    [
      dispatchChatScrollEvent,
      loadMessageWindowAround,
      setPendingDurableRevealMessageId,
      visibleMessageIndexById,
      waitForTranscriptCommit
    ]
  )

  useEffect(() => {
    if (!scrollParent) return
    lastObservedScrollTopRef.current = scrollParent.scrollTop

    const confirmOrDetachFromScroll = (): void => {
      const previousTop = lastObservedScrollTopRef.current
      const nextTop = scrollParent.scrollTop
      const distanceToBottom = scrollParent.scrollHeight - nextTop - scrollParent.clientHeight
      lastObservedScrollTopRef.current = nextTop

      if (
        nextTop < previousTop - CHAT_SCROLL_UP_DETACH_DELTA_PX &&
        performance.now() <= upwardUserScrollIntentUntilRef.current
      ) {
        upwardUserScrollIntentUntilRef.current = 0
        dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
        return
      }
      if (distanceToBottom <= CHAT_AT_BOTTOM_THRESHOLD_PX) {
        const state = chatScrollStateRef.current
        // Explicit wheel/touch/keyboard/scrollbar handlers own detachment. Do not let the scroll
        // event immediately re-attach a detached reader while the viewport is still moving up
        // inside the at-bottom threshold. Downward movement to the bottom still re-attaches.
        if (
          state &&
          isChatScrollDetached(state) &&
          (nextTop <= previousTop + CHAT_SCROLL_UP_DETACH_DELTA_PX ||
            (performance.now() > downwardUserScrollIntentUntilRef.current &&
              !scrollbarUserIntentActiveRef.current))
        ) {
          return
        }
        dispatchChatScrollEvent({ type: "BOTTOM_CONFIRMED" })
      }
    }
    const cancelPendingHistoryAnchorFromUserGesture = (): void => {
      pendingChatSessionAnchorRef.current = null
      invalidateDurableMessageReveal()
      const anchor = pendingDurableHistoryAnchorRef.current
      if (!anchor) return
      dispatchChatScrollEvent({
        type: "USER_DETACH",
        source: "user-input",
        generation: anchor.generation
      })
    }
    const detachFromExplicitWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        downwardUserScrollIntentUntilRef.current = 0
        upwardUserScrollIntentUntilRef.current =
          performance.now() + CHAT_USER_SCROLL_INTENT_WINDOW_MS
        cancelPendingHistoryAnchorFromUserGesture()
      } else if (event.deltaY > 0) {
        upwardUserScrollIntentUntilRef.current = 0
        downwardUserScrollIntentUntilRef.current =
          performance.now() + CHAT_USER_SCROLL_INTENT_WINDOW_MS
        cancelPendingHistoryAnchorFromUserGesture()
      }
    }
    const scrollRoot = scrollRef.current
    const detachFromScrollbarPointer = (event: PointerEvent): void => {
      if (
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof HTMLElement && target.hasAttribute("data-scroll-area-scrollbar")
          )
      ) {
        scrollbarUserIntentActiveRef.current = true
        cancelPendingHistoryAnchorFromUserGesture()
        dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
      }
    }
    const clearScrollbarPointerIntent = (): void => {
      scrollbarUserIntentActiveRef.current = false
    }
    let lastTouchY: number | null = null
    const rememberTouchPosition = (event: TouchEvent): void => {
      lastTouchY = event.touches[0]?.clientY ?? null
    }
    const detachFromTouchScroll = (event: TouchEvent): void => {
      const nextTouchY = event.touches[0]?.clientY ?? null
      if (lastTouchY !== null && nextTouchY !== null && nextTouchY > lastTouchY + 1) {
        downwardUserScrollIntentUntilRef.current = 0
        upwardUserScrollIntentUntilRef.current =
          performance.now() + CHAT_USER_SCROLL_INTENT_WINDOW_MS
        cancelPendingHistoryAnchorFromUserGesture()
      } else if (lastTouchY !== null && nextTouchY !== null && nextTouchY < lastTouchY - 1) {
        upwardUserScrollIntentUntilRef.current = 0
        downwardUserScrollIntentUntilRef.current =
          performance.now() + CHAT_USER_SCROLL_INTENT_WINDOW_MS
        cancelPendingHistoryAnchorFromUserGesture()
      }
      lastTouchY = nextTouchY
    }
    const detachFromKeyboardScroll = (event: KeyboardEvent): void => {
      if (!chatRootRef.current || chatRootRef.current.offsetParent === null) return
      if (
        !chatRootRef.current.contains(document.activeElement) &&
        document.activeElement !== document.body
      ) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        downwardUserScrollIntentUntilRef.current = 0
        upwardUserScrollIntentUntilRef.current =
          performance.now() + CHAT_USER_SCROLL_INTENT_WINDOW_MS
        cancelPendingHistoryAnchorFromUserGesture()
      } else if (
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        event.key === "End" ||
        (event.key === " " && !event.shiftKey)
      ) {
        upwardUserScrollIntentUntilRef.current = 0
        downwardUserScrollIntentUntilRef.current =
          performance.now() + CHAT_USER_SCROLL_INTENT_WINDOW_MS
        cancelPendingHistoryAnchorFromUserGesture()
      }
    }

    scrollParent.addEventListener("scroll", confirmOrDetachFromScroll, { passive: true })
    scrollParent.addEventListener("wheel", detachFromExplicitWheel, { passive: true })
    scrollRoot?.addEventListener("pointerdown", detachFromScrollbarPointer, {
      capture: true,
      passive: true
    })
    scrollParent.addEventListener("touchstart", rememberTouchPosition, { passive: true })
    scrollParent.addEventListener("touchmove", detachFromTouchScroll, { passive: true })
    window.addEventListener("keydown", detachFromKeyboardScroll, true)
    window.addEventListener("pointerup", clearScrollbarPointerIntent, true)
    window.addEventListener("pointercancel", clearScrollbarPointerIntent, true)
    window.addEventListener("blur", clearScrollbarPointerIntent)
    confirmOrDetachFromScroll()
    return () => {
      scrollParent.removeEventListener("scroll", confirmOrDetachFromScroll)
      scrollParent.removeEventListener("wheel", detachFromExplicitWheel)
      scrollRoot?.removeEventListener("pointerdown", detachFromScrollbarPointer, true)
      scrollParent.removeEventListener("touchstart", rememberTouchPosition)
      scrollParent.removeEventListener("touchmove", detachFromTouchScroll)
      window.removeEventListener("keydown", detachFromKeyboardScroll, true)
      window.removeEventListener("pointerup", clearScrollbarPointerIntent, true)
      window.removeEventListener("pointercancel", clearScrollbarPointerIntent, true)
      window.removeEventListener("blur", clearScrollbarPointerIntent)
    }
  }, [dispatchChatScrollEvent, invalidateDurableMessageReveal, scrollParent])

  const scrollToMessageById = useCallback(
    (messageId: string): void => {
      const index = visibleMessageIndexById.get(messageId)
      if (index === undefined) return
      invalidateDurableMessageReveal()
      dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
      const targetElement = contentMessageRefs.current.get(messageId)
      const viewport = getViewport()
      if (targetElement && viewport) {
        const viewportRect = viewport.getBoundingClientRect()
        const targetRect = targetElement.getBoundingClientRect()
        viewport.scrollTo({
          top: Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top - 8),
          behavior: "smooth"
        })
        return
      }
      virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: "smooth" })
    },
    [dispatchChatScrollEvent, getViewport, invalidateDurableMessageReveal, visibleMessageIndexById]
  )
  const revealMessage = useCallback(
    (messageId: string): void => {
      const index = visibleMessageIndexById.get(messageId)
      if (index === undefined) return
      invalidateDurableMessageReveal()
      dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
      const targetElement = contentMessageRefs.current.get(messageId)
      if (targetElement) return
      virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "auto" })
    },
    [dispatchChatScrollEvent, invalidateDurableMessageReveal, visibleMessageIndexById]
  )
  const handleScrollToQuestion = useCallback((): void => {
    invalidateDurableMessageReveal()
    dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
  }, [dispatchChatScrollEvent, invalidateDurableMessageReveal])

  const handleInitialVirtualItemsRendered = useCallback((): void => {
    if (historyLoading) return
    dispatchChatScrollEvent({
      type: "DATA_READY",
      generation: chatScrollUiState.generation,
      messageCount: visibleMessageIndexes.length
    })
  }, [
    chatScrollUiState.generation,
    dispatchChatScrollEvent,
    historyLoading,
    visibleMessageIndexes.length
  ])

  const handleContentHeightChanged = useCallback((): void => {
    const state = chatScrollStateRef.current
    if (
      visibleMessageIndexes.length === 0 ||
      !state ||
      state.generation !== chatScrollUiState.generation ||
      !shouldFollowChatOutput(state)
    ) {
      return
    }
    dispatchChatScrollEvent({
      type: "CONTENT_GROWN",
      generation: chatScrollUiState.generation
    })
  }, [chatScrollUiState.generation, dispatchChatScrollEvent, visibleMessageIndexes.length])

  const handleVirtualAtBottomStateChange = useCallback(
    (atBottom: boolean): void => {
      const state = chatScrollStateRef.current
      // Virtuoso may report `true` when a row collapses or a late measurement shortens content.
      // That is layout, not proof that a detached reader intentionally returned to the bottom.
      // Manual downward scrolling is confirmed by the viewport scroll listener; the button changes
      // mode to following before its programmatic settle, so both intentional paths still work.
      if (atBottom && state && !isChatScrollDetached(state)) {
        dispatchChatScrollEvent({
          type: "BOTTOM_CONFIRMED",
          generation: chatScrollUiState.generation
        })
      }
    },
    [chatScrollUiState.generation, dispatchChatScrollEvent]
  )

  useLayoutEffect(() => {
    const messageId = pendingDurableSearchRevealIdRef.current
    if (!messageId || historyPageLoading) return
    const index = visibleMessageIndexById.get(messageId)
    if (index === undefined) {
      setPendingDurableRevealMessageId(null)
      return
    }
    setPendingDurableRevealMessageId(null)
    virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "auto" })
  }, [historyPageLoading, setPendingDurableRevealMessageId, visibleMessageIndexById])

  useLayoutEffect(() => {
    const anchor = pendingChatSessionAnchorRef.current
    if (
      !anchor ||
      anchor.threadId !== threadId ||
      historyLoading ||
      historyPageLoading ||
      !scrollParent
    ) {
      return
    }
    const visibleIndex = visibleMessageIndexById.get(anchor.messageId)
    if (visibleIndex === undefined) {
      pendingChatSessionAnchorRef.current = null
      return
    }

    let frame: number | null = null
    const finish = (): void => {
      if (pendingChatSessionAnchorRef.current === anchor) {
        pendingChatSessionAnchorRef.current = null
      }
    }
    const restore = (): void => {
      if (pendingChatSessionAnchorRef.current !== anchor) return
      const viewport = getViewport()
      const target =
        contentMessageRefs.current.get(anchor.messageId) ??
        Array.from(viewport?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? []).find(
          (candidate) => candidate.dataset.chatMessageId === anchor.messageId
        )
      if (viewport && target) {
        const viewportTop = viewport.getBoundingClientRect().top
        const currentOffset = target.getBoundingClientRect().top - viewportTop
        const delta = currentOffset - anchor.offsetFromViewportTop
        if (Math.abs(delta) > 1) viewport.scrollTop += delta
        anchor.stableFrames = Math.abs(delta) <= 1 ? anchor.stableFrames + 1 : 0
        if (anchor.stableFrames >= CHAT_SESSION_ANCHOR_STABLE_FRAMES) {
          finish()
          return
        }
      } else if (anchor.attempt === 0) {
        virtuosoRef.current?.scrollToIndex({
          index: visibleIndex,
          align: "start",
          behavior: "auto"
        })
      }

      anchor.attempt += 1
      if (anchor.attempt <= CHAT_HISTORY_ANCHOR_MAX_FRAMES) {
        frame = window.requestAnimationFrame(restore)
      } else {
        finish()
      }
    }
    frame = window.requestAnimationFrame(restore)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [
    getViewport,
    historyLoading,
    historyPageLoading,
    scrollParent,
    threadId,
    visibleMessageIndexById
  ])

  useEffect(() => {
    if (historyLoading || !scrollParent) return
    dispatchChatScrollEvent({
      type: "DATA_READY",
      generation: chatScrollUiState.generation,
      messageCount: visibleMessageIndexes.length
    })
  }, [
    chatScrollUiState.generation,
    dispatchChatScrollEvent,
    historyLoading,
    scrollParent,
    threadId,
    visibleMessageIndexes.length
  ])

  const loadEarlierHistoryPage = useCallback(async (): Promise<void> => {
    if (historyPageLoading || !historyHasMore) return
    const generation = chatScrollStateRef.current?.generation
    dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input", generation })
    dispatchChatScrollEvent({ type: "RESTORE_BEGIN", generation })
    const viewport = getViewport()
    const viewportTop = viewport?.getBoundingClientRect().top ?? 0
    let anchor: HTMLElement | null = null
    let anchorDistance = Number.POSITIVE_INFINITY
    for (const candidate of viewport?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ??
      []) {
      const distance = Math.abs(candidate.getBoundingClientRect().top - viewportTop)
      if (distance < anchorDistance) {
        anchor = candidate
        anchorDistance = distance
      }
    }
    const anchorId = anchor?.dataset.chatMessageId
    const request =
      anchorId && anchor
        ? {
            threadId,
            generation: generation ?? 0,
            messageId: anchorId,
            viewportTop: anchor.getBoundingClientRect().top,
            previousMessageCount: displayMessages.length,
            previousLoadedMessageCount: historyLoadedMessageCount,
            attempt: 0,
            stableFrames: 0
          }
        : null
    pendingDurableHistoryAnchorRef.current = request
    try {
      const prependedCount = await loadEarlierMessages()
      if (prependedCount === 0 || !request) {
        if (pendingDurableHistoryAnchorRef.current === request) {
          pendingDurableHistoryAnchorRef.current = null
        }
        dispatchChatScrollEvent({ type: "RESTORE_END", generation })
      }
    } catch (error) {
      if (pendingDurableHistoryAnchorRef.current === request) {
        pendingDurableHistoryAnchorRef.current = null
      }
      dispatchChatScrollEvent({ type: "RESTORE_END", generation })
      toast.error(error instanceof Error ? error.message : "加载更早消息失败")
    }
  }, [
    dispatchChatScrollEvent,
    displayMessages.length,
    getViewport,
    historyLoadedMessageCount,
    historyHasMore,
    historyPageLoading,
    loadEarlierMessages,
    threadId
  ])
  const loadReleasedHistoryWindow = useCallback(async (): Promise<void> => {
    const targetMessageId = historyWindowGap?.reloadTargetMessageId
    if (!targetMessageId || historyPageLoading) return
    const revealGeneration = durableMessageWindowGenerationRef.current + 1
    durableMessageWindowGenerationRef.current = revealGeneration
    pendingChatSessionAnchorRef.current = null
    setPendingDurableRevealMessageId(targetMessageId)
    dispatchChatScrollEvent({ type: "USER_DETACH", source: "user-input" })
    try {
      const loaded = await loadReleasedMessageWindow()
      if (
        !chatViewMountedRef.current ||
        durableMessageWindowGenerationRef.current !== revealGeneration
      ) {
        return
      }
      if (!loaded) {
        setPendingDurableRevealMessageId(null)
        toast.error("继续加载中间消息失败，请稍后重试")
        return
      }
      await waitForTranscriptCommit()
    } catch (error) {
      if (
        chatViewMountedRef.current &&
        durableMessageWindowGenerationRef.current === revealGeneration
      ) {
        setPendingDurableRevealMessageId(null)
        toast.error(error instanceof Error ? error.message : "继续加载中间消息失败")
      }
    }
  }, [
    dispatchChatScrollEvent,
    historyPageLoading,
    historyWindowGap?.reloadTargetMessageId,
    loadReleasedMessageWindow,
    setPendingDurableRevealMessageId,
    waitForTranscriptCommit
  ])
  const historyRemainingCount = Math.max(0, historyMessageTotal - historyLoadedMessageCount)

  useLayoutEffect(() => {
    const anchor = pendingDurableHistoryAnchorRef.current
    if (!anchor || anchor.threadId !== threadId || historyPageLoading) return
    if (
      displayMessages.length <= anchor.previousMessageCount &&
      historyLoadedMessageCount <= anchor.previousLoadedMessageCount
    ) {
      return
    }
    let frame: number | null = null
    const finishRestore = (): void => {
      if (pendingDurableHistoryAnchorRef.current !== anchor) return
      pendingDurableHistoryAnchorRef.current = null
      dispatchChatScrollEvent({ type: "RESTORE_END", generation: anchor.generation })
    }
    const restoreAnchor = (): void => {
      if (pendingDurableHistoryAnchorRef.current !== anchor) return
      const viewport = getViewport()
      const target =
        contentMessageRefs.current.get(anchor.messageId) ??
        Array.from(viewport?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? []).find(
          (candidate) => candidate.dataset.chatMessageId === anchor.messageId
        )
      if (viewport && target) {
        const delta = target.getBoundingClientRect().top - anchor.viewportTop
        if (Math.abs(delta) > 1) viewport.scrollTop += delta
        anchor.stableFrames = Math.abs(delta) <= 1 ? anchor.stableFrames + 1 : 0
        if (anchor.stableFrames >= CHAT_HISTORY_ANCHOR_STABLE_FRAMES) {
          finishRestore()
          return
        }
      }
      const visibleIndex = visibleMessageIndexById.get(anchor.messageId)
      if (!target && anchor.attempt === 0 && visibleIndex !== undefined) {
        virtuosoRef.current?.scrollToIndex({
          index: visibleIndex,
          align: "start",
          behavior: "auto"
        })
      }
      anchor.attempt += 1
      if (anchor.attempt <= CHAT_HISTORY_ANCHOR_MAX_FRAMES) {
        frame = window.requestAnimationFrame(restoreAnchor)
      } else {
        finishRestore()
      }
    }
    frame = window.requestAnimationFrame(restoreAnchor)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [
    dispatchChatScrollEvent,
    displayMessages.length,
    getViewport,
    historyLoadedMessageCount,
    historyPageLoading,
    threadId,
    visibleMessageIndexById
  ])

  useEffect(() => {
    const lastVisibleMessageIndex = visibleMessageIndexes.at(-1)
    const lastVisibleMessage =
      lastVisibleMessageIndex === undefined ? undefined : displayMessages[lastVisibleMessageIndex]
    const nextSnapshot = {
      threadId,
      visibleCount: visibleMessageIndexes.length,
      lastMessageId: lastVisibleMessage?.id ?? null,
      lastMessageIdentity: chatScrollTailMessageIdentity(lastVisibleMessage),
      loadedMessageCount: historyLoadedMessageCount,
      contentVersion: displayMessagesContentVersion,
      structureVersion: displayMessagesStructureVersion
    }
    const previous = chatContentSnapshotRef.current
    if (historyLoading) return
    chatContentSnapshotRef.current = nextSnapshot
    if (!previous || previous.threadId !== threadId) return

    const tailChange = classifyChatScrollTailChange({
      previous,
      current: nextSnapshot,
      displayMessages,
      visibleMessageIndexes,
      visibleMessageIndexById
    })

    if (tailChange.appendedMessageCount > 0) {
      dispatchChatScrollEvent({
        type: "CONTENT_APPENDED",
        unreadMessages: tailChange.unreadMessageCount
      })
      return
    }
    if (
      shouldMarkChatTailContentGrowth({
        change: tailChange,
        currentTail: lastVisibleMessage,
        contentVersionChanged: nextSnapshot.contentVersion !== previous.contentVersion,
        structureVersionChanged: nextSnapshot.structureVersion !== previous.structureVersion,
        changedTail: displayMessageProjection.changedMessages.some(
          (message) => message.id === nextSnapshot.lastMessageId
        )
      })
    ) {
      const state = chatScrollStateRef.current
      if (state && isChatScrollDetached(state)) {
        dispatchChatScrollEvent({ type: "CONTENT_GROWN", generation: state.generation })
      }
    }
  }, [
    dispatchChatScrollEvent,
    displayMessageProjection.changedMessages,
    displayMessages,
    displayMessagesContentVersion,
    displayMessagesStructureVersion,
    historyLoadedMessageCount,
    historyLoading,
    threadId,
    visibleMessageIndexById,
    visibleMessageIndexes,
    visibleMessageIndexes.length
  ])

  // Ctrl/Cmd+F opens in-session search. Listen on window (capture phase) so it
  // fires regardless of where focus is — a root-scoped listener missed the common
  // case where focus sits on <body> after clicking the transcript. The visibility
  // guard (offsetParent) means a backgrounded panel in a split view stays inert;
  // only one ChatContainer is mounted per panel (keyed + conditionally rendered).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F"))) return
      const root = chatRootRef.current
      if (!root || root.offsetParent === null) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [])

  useEffect(() => {
    const state = chatScrollStateRef.current
    if (!pendingApproval || !state || !shouldFollowChatOutput(state)) return
    dispatchChatScrollEvent({ type: "CONTENT_GROWN", generation: state.generation })
  }, [dispatchChatScrollEvent, pendingApproval])

  useEffect(() => {
    const state = chatScrollStateRef.current
    if (!pendingUserInput || !userInputDialogLayout || !state || !shouldFollowChatOutput(state)) {
      return
    }
    const viewport = getViewport()
    if (!viewport) return
    const generation = state.generation
    dispatchChatScrollEvent({ type: "PROGRAMMATIC_SCROLL_BEGIN", generation })

    const frame = requestAnimationFrame(() => {
      const currentState = chatScrollStateRef.current
      if (
        !currentState ||
        currentState.generation !== generation ||
        !shouldFollowChatOutput(currentState)
      ) {
        dispatchChatScrollEvent({ type: "PROGRAMMATIC_SCROLL_END", generation })
        return
      }
      const targetElement = lastContentMessageId
        ? contentMessageRefs.current.get(lastContentMessageId)
        : null
      const viewportRect = viewport.getBoundingClientRect()
      const targetBottom = Math.max(viewportRect.top + 24, userInputDialogLayout.top - 12)

      if (targetElement) {
        const targetRect = targetElement.getBoundingClientRect()
        const scrollDelta = targetRect.bottom - targetBottom
        if (Math.abs(scrollDelta) > 1) {
          viewport.scrollBy({ top: scrollDelta, behavior: "auto" })
        }
      } else {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" })
      }
      dispatchChatScrollEvent({ type: "PROGRAMMATIC_SCROLL_END", generation })
    })

    return () => {
      cancelAnimationFrame(frame)
      dispatchChatScrollEvent({ type: "PROGRAMMATIC_SCROLL_END", generation })
    }
  }, [
    dispatchChatScrollEvent,
    getViewport,
    lastContentMessageId,
    pendingUserInput,
    userInputDialogLayout?.height,
    userInputDialogLayout?.top
  ])
  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [threadId])

  const handleDismissError = (): void => {
    clearError()
  }

  const isLocalSkillDisabled = useCallback(
    (skill: SkillMetadata): boolean => !skill.pluginId && isSkillDisabled(skill, disabledSkillIds),
    [disabledSkillIds]
  )

  const enabledSkillsForSlash = useMemo(
    () => skills.filter((skill) => !isLocalSkillDisabled(skill)),
    [skills, isLocalSkillDisabled]
  )

  useEffect(() => {
    const nextAction = pendingHarnessNextAction
    const userMessage = nextAction?.userMessage?.trim() ?? ""
    const slashSkill = nextAction?.slashSkill?.trim() ?? ""
    const pendingPreferredPlugin = nextAction?.preferredPlugin ?? null

    if (!harnessFeatureBinding && !pendingPreferredPlugin) return
    if (!userMessage && !slashSkill) {
      if (nextAction?.dialogTips) consumePendingHarnessNextAction(threadId)
      return
    }
    if (historyLoading) return
    if (threadMessages.length > 0 || input.trim() || selectedSkill || selectedBuiltinBrowser) {
      consumePendingHarnessNextAction(threadId)
      return
    }

    let nextSkill: SkillMetadata | null = null
    if (slashSkill) {
      if (skillsLoading) return
      const expectedProjectId = harnessFeatureBinding?.projectId ?? null
      if (skillsLoadTargetProjectId !== expectedProjectId) return
      if (skillsHarnessProjectId !== expectedProjectId) return
      nextSkill = selectSkillForSlashName(
        enabledSkillsForSlash,
        slashSkill,
        harnessFeatureBinding ? skillsHarnessPreferredPlugin : pendingPreferredPlugin
      )
    }

    if (userMessage) setInput(userMessage)
    if (nextSkill) setSelectedSkill(nextSkill)
    consumePendingHarnessNextAction(threadId)
  }, [
    enabledSkillsForSlash,
    harnessFeatureBinding,
    historyLoading,
    input,
    pendingHarnessNextAction,
    selectedSkill,
    setInput,
    setSelectedSkill,
    selectedBuiltinBrowser,
    setSelectedBuiltinBrowser,
    skillsHarnessPreferredPlugin,
    skillsHarnessProjectId,
    skillsLoadTargetProjectId,
    skillsLoading,
    threadId,
    threadMessages.length
  ])

  const slash = useSlashCommands({
    input,
    skills: enabledSkillsForSlash,
    skillSelected: selectedSkill !== null,
    browserSelected: selectedBuiltinBrowser
  })
  const loadMoreWorkspaceMentionFiles = useCallback(
    async (signal: AbortSignal) => {
      if (!workspacePath) return null
      let result: Awaited<ReturnType<typeof continueWorkspaceFilesDeduped>> | null
      try {
        // Do not bind the shared bounded scan to one transient keystroke. A
        // superseded query stops awaiting it, while the completed segment is
        // still published for the next query and the Files panel.
        result = await awaitWorkspaceMentionLoad(
          continueWorkspaceFilesDeduped(threadId, workspacePath),
          signal
        )
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error
        }
        result = null
      }

      // Continuation cursors intentionally expire after an idle window. Reopen
      // one bounded initial scan so @ search can recover without requiring the
      // user to mount or refresh the Files panel first.
      if (!result?.success) {
        result = await awaitWorkspaceMentionLoad(
          loadWorkspaceFilesDeduped(threadId, workspacePath),
          signal
        )
      }
      if (!result.success) return null
      return {
        files: result.files,
        continuationAvailable: result.continuationAvailable === true
      }
    },
    [threadId, workspacePath]
  )
  const atFileMentions = useAtFileMentions({
    input,
    cursorOffset: inputRef.current?.selectionStart ?? input.length,
    workspaceFiles,
    loadMoreWorkspaceFiles: loadMoreWorkspaceMentionFiles,
    disabled: slash.mode.kind === "slash" || !workspacePath
  })
  const slashPopoverKind = slash.mode.kind
  const hasPendingGoalTransportPayload =
    hasPendingFilePayload || selectedSkill !== null || selectedBuiltinBrowser
  const hasActiveGoalRunning = goalUi.goal?.status === "active"
  const goalControlAllowedWhileLoading =
    streamData.isLoading && !scheduledTaskLoading && hasActiveGoalRunning

  const {
    inputDisabled,
    composerControlsDisabled,
    canSubmitGoalCommandWhileLoading,
    allowSubmitWhileLoading,
    goalSendButtonDisabledWhileLoading
  } = resolveGoalRuntimeComposerState({
    input,
    isLoading,
    historyLoading,
    slashModeKind: slashPopoverKind,
    hasActiveGoal: hasActiveGoalRunning,
    hasPendingTransportPayload: hasPendingGoalTransportPayload,
    goalControlAllowedWhileLoading
  })
  const contextReminderPending = isContextReminderPending(
    isHarnessContextReminderEnabled,
    contextReminder
  )
  // 项目已删除时，会话仅可查看历史：禁用输入框与编辑器控件。
  const effectiveInputDisabled = inputDisabled || contextReminderPending || readOnly
  const effectiveComposerControlsDisabled =
    composerControlsDisabled || contextReminderPending || readOnly
  const inputPlaceholder = useMemo(() => {
    if (resolvedReadOnlyReason) return resolvedReadOnlyReason
    if (contextReminderPending) return "请先处理上下文提醒"
    const goal = goalUi.goal
    if (isLoading) {
      if (streamData.isLoading && !scheduledTaskLoading && hasActiveGoalRunning) {
        return "Goal 运行中：可输入 /goal status、/goal pause、/goal clear"
      }
      if (streamData.isLoading && !scheduledTaskLoading) {
        return "任务运行中，输入消息按回车加入队列，完成后自动发送"
      }
      return "任务运行中，可使用取消按钮停止当前任务"
    }
    if (hasPendingFilePayload) return "输入消息或直接发送文件..."
    if (!goal) return "向 CMBDevClaw 提问，/ 输入命令；@ 引用文件；Shift + Enter 换行"
    if (goal.status === "active") {
      return "输入新消息会暂停当前 Goal；查看详情用 /goal status"
    }
    if (goal.status === "paused") {
      return "补充说明，或点击继续 Goal"
    }
    return "输入新问题，或用 /goal <目标> 开始新的长期任务"
  }, [
    contextReminderPending,
    goalUi.goal,
    hasPendingFilePayload,
    hasActiveGoalRunning,
    goalControlAllowedWhileLoading,
    isLoading,
    resolvedReadOnlyReason,
    scheduledTaskLoading,
    streamData.isLoading
  ])
  // Refresh skill list whenever the popover opens so customize-panel
  // enable/disable changes reflect without an app restart.
  useEffect(() => {
    if (slashPopoverKind === "slash") {
      void loadSkills()
    }
  }, [slashPopoverKind, loadSkills])

  const insertTextAtCursor = useCallback(
    (text: string, replaceRange?: { start: number; end: number }) => {
      const textarea = inputRef.current
      const selectionStart = replaceRange?.start ?? textarea?.selectionStart ?? input.length
      const selectionEnd = replaceRange?.end ?? textarea?.selectionEnd ?? input.length
      const nextInput = `${input.slice(0, selectionStart)}${text}${input.slice(selectionEnd)}`
      const nextCursor = selectionStart + text.length

      setInput(nextInput)
      requestAnimationFrame(() => {
        const target = inputRef.current
        if (!target) return
        target.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [input, setInput]
  )

  // Depend on the stable callback refs, not the whole `slash` object —
  // the hook returns a fresh literal every render, which would re-create
  // applySkillSelection each keystroke and cascade into popover rerenders.
  const slashResetSelection = slash.resetSelection
  const applySkillSelection = useCallback(
    (s: SkillMetadata) => {
      setSelectedSkill(s)
      setSelectedBuiltinBrowser(false)
      setInput("")
      slashResetSelection()
    },
    [setInput, setSelectedBuiltinBrowser, setSelectedSkill, slashResetSelection]
  )

  const applySlashCommand = useCallback(
    (command: SlashCommandItem) => {
      if (isBuiltinBrowserCommandSelection(command)) {
        setSelectedSkill(null)
        setSelectedBuiltinBrowser(true)
        setInput("")
        slashResetSelection()
        return
      }

      const nextInput = command.insertText
      setInput(nextInput)
      slashResetSelection()
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        const cursor = nextInput.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [setInput, setSelectedBuiltinBrowser, setSelectedSkill, slashResetSelection]
  )

  const applyAtFileMention = useCallback(
    (file: AtFileSuggestion) => {
      if (atFileMentions.mode.kind !== "at-file" || !workspacePath) return

      try {
        const selection = resolveAtFileSelection({
          file,
          workspacePath,
          attachments: attachmentsRef.current,
          mentionedFiles: mentionedFilesRef.current,
          maxAttachments: MAX_ATTACHMENTS
        })
        if (selection.kind === "duplicate") {
          setError(`文件"${selection.filename}"已添加，跳过重复`)
          return
        }
        if (selection.kind === "limit") {
          setError(`最多只能添加 ${MAX_ATTACHMENTS} 个文件`)
          return
        }
        if (selection.kind === "unsupported") {
          // 这里直接拦住不支持类型，避免它进入 chip 之后又在发送时悄悄失效。
          setError(`@文件暂不支持 "${selection.filename}" 这种类型`)
          return
        }

        clearError()
        setMentionedFiles((prev) => {
          if (
            prev.some(
              (candidate) => candidate.absolutePath === selection.mentionedFile.absolutePath
            )
          ) {
            return prev
          }
          const next = [...prev, selection.mentionedFile]
          mentionedFilesRef.current = next
          return next
        })

        const { nextInput, nextCursor } = removeAtFileTokenFromInput(input, {
          startPos: atFileMentions.mode.startPos,
          endPos: atFileMentions.mode.endPos
        })

        setInput(nextInput)
        requestAnimationFrame(() => {
          const textarea = inputRef.current
          if (!textarea) return
          textarea.setSelectionRange(nextCursor, nextCursor)
        })
      } catch {
        setError("@文件暂时不可用，请直接发送消息或改用普通附件。")
      }
    },
    [atFileMentions.mode, clearError, input, setError, setInput, workspacePath]
  )

  const appendVisibleUserMessageWithTime = useCallback(
    async (content: string, options: { id?: string } = {}): Promise<Message> => {
      const userStartAt = new Date()
      const userMessage: Message = {
        id: options.id ?? crypto.randomUUID(),
        role: "user",
        content,
        created_at: userStartAt,
        start_at: userStartAt,
        end_at: userStartAt
      }
      appendMessage(userMessage)
      return userMessage
    },
    [appendMessage]
  )

  const showGoalControlNotice = useCallback((rawMessage?: string): void => {
    const message = formatGoalEventMessage(rawMessage ?? "").trim()
    if (!message) return
    if (message.startsWith("✓ Goal 已完成") || message.startsWith("Goal 已完成")) {
      toast.success(message)
      return
    }
    if (
      message.startsWith("Goal 已暂停") ||
      message.startsWith("Ⅱ Goal 已暂停") ||
      message.startsWith("Goal 等待补充信息")
    ) {
      toast.warning(message)
      return
    }
    toast.info(message)
  }, [])

  const submitGoalResumeCommand = useCallback(async (): Promise<void> => {
    if (!stream || historyLoading || isLoading || scheduledTaskLoading) return
    if (!tryAcquireSubmitInFlightLock(submitInFlightRef, true, threadId)) return
    try {
      const pendingApprovalRecord = pendingApproval as unknown as Record<string, unknown> | null
      if (pendingApproval && !pendingApprovalRecord?._orchestratorRequestId) {
        setError("当前有待审批操作，请先处理审批卡片，再发送 /goal resume。")
        return
      }
      if (threadError) {
        clearError()
      }
      if (!currentModel) {
        setError("请先在下方选择模型后再继续 goal。")
        return
      }
      const selectedModel = models.find((m) => m.id === currentModel)
      if (!selectedModel) {
        setError("当前线程模型不存在，请重新选择模型。")
        return
      }
      if (!selectedModel.available) {
        setError("当前模型不可用，请先在模型配置中设置 API 密钥。")
        return
      }
      if (!workspacePath) {
        setError("请先选择一个工作区文件夹再继续 goal。")
        return
      }
      setInput("")
      setAttachments([])
      setMentionedFiles([])
      setSelectedSkill(null)
      insertLog("send: /goal resume")
      await appendVisibleUserMessageWithTime("/goal resume")
      await stream.submit(
        {
          messages: [{ type: "human", content: "/goal resume" }]
        },
        {
          config: {
            configurable: { thread_id: threadId, model_id: currentModel }
          }
        }
      )
    } finally {
      releaseSubmitInFlightLock(submitInFlightRef, true, threadId)
    }
  }, [
    clearError,
    currentModel,
    historyLoading,
    isLoading,
    models,
    pendingApproval,
    scheduledTaskLoading,
    setError,
    setAttachments,
    setInput,
    setSelectedSkill,
    appendVisibleUserMessageWithTime,
    stream,
    threadError,
    threadId,
    workspacePath
  ])

  const applyGoalPanelCommand = useCallback(
    (command: string) => {
      if (historyLoading) {
        toast.warning("线程历史正在恢复，请稍后再操作 Goal。")
        return
      }
      if (command === "/goal resume") {
        if (isLoading || scheduledTaskLoading) {
          toast.warning("当前任务运行中，请等待完成后再继续 Goal。")
          return
        }
        void submitGoalResumeCommand()
        return
      }
      if (isLoading && !goalControlAllowedWhileLoading) {
        toast.warning("当前任务运行中，请等待完成后再操作 Goal。")
        return
      }
      void (async () => {
        const route = resolveGoalControlSubmitRoute({
          isGoalControlCommand: true,
          isLoading,
          historyLoading,
          hasActiveGoal: hasActiveGoalRunning,
          goalControlAllowedWhileLoading
        })
        if (!route.shouldUseGoalControlPlane) {
          toast.warning("当前任务运行中，请等待完成后再操作 Goal。")
          return
        }
        const shouldLockGoalControl = route.shouldUseSubmitLock
        if (!tryAcquireSubmitInFlightLock(submitInFlightRef, shouldLockGoalControl, threadId)) {
          return
        }
        try {
          if (threadError) {
            clearError()
          }
          insertLog("send: " + command)
          const result = await window.api.agent.goalControl(threadId, command)
          if (command === "/goal" || command === "/goal status") {
            setGoalDetailsOpen(true)
          }
          if (!route.isSideChannelGoalControl) {
            showGoalControlNotice(
              (command === "/goal" || command === "/goal status") && result.notice?.goalId
                ? "Goal 状态已刷新。"
                : result.notice?.message
            )
          }
          void refreshGoalUi({ includeEvents: true })
          if (
            pendingApproval &&
            isGoalTerminatingControlCommandInput(command) &&
            result.terminatedCurrentRun
          ) {
            const approvalAny = pendingApproval as unknown as Record<string, unknown>
            if (approvalAny._orchestratorRequestId) {
              window.api.sandbox.sendApprovalDecision({
                requestId: approvalAny._orchestratorRequestId as string,
                type: "reject",
                tool_call_id: pendingApproval.tool_call?.id || ""
              })
            }
            setPendingApproval(null)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Goal 控制命令执行失败。"
          setError(message)
        } finally {
          releaseSubmitInFlightLock(submitInFlightRef, shouldLockGoalControl, threadId)
        }
      })()
    },
    [
      clearError,
      hasActiveGoalRunning,
      goalControlAllowedWhileLoading,
      historyLoading,
      isLoading,
      pendingApproval,
      refreshGoalUi,
      setError,
      setPendingApproval,
      showGoalControlNotice,
      submitGoalResumeCommand,
      scheduledTaskLoading,
      threadError,
      threadId
    ]
  )

  const handleSubmit = async (e: React.FormEvent, defaultText = ""): Promise<void> => {
    e.preventDefault()
    const trimmedInput = defaultText || input.trim()
    const isGoalSlashInput = /^\/goal(?:\s|$)/i.test(trimmedInput)
    const shouldOpenGoalDetailsForStatus = /^\/goal(?:\s+status)?\s*$/i.test(trimmedInput)
    // Defense-in-depth: every current trigger already short-circuits while the
    // popover is open — the send button is disabled, and handleKeyDown's
    // popover branch returns before reaching handleSubmit. Kept here so any
    // future invoker (hotkey, programmatic call) can't accidentally ship the
    // literal "/xxx" text as a message.
    if (slash.mode.kind === "slash" && !isBareGoalSlashCommandInput(trimmedInput)) return
    if (readOnly) return
    if (contextReminderPending) return
    // A plain (non-/goal) message submitted while the thread is busy — running,
    // or a tool approval is pending — is parked in the draft queue instead of
    // being blocked (running) or interrupting the run (approval). Every /goal
    // input keeps its existing routing, so goals mode is untouched.
    //
    // A pump-held lock counts as busy before isLoading updates, so a genuinely new
    // message queues behind it. A normal live submit preparing @file attachments
    // does not: a rapid second Enter still sees the original input and must hit the
    // shared lock below instead of enqueuing a duplicate draft.
    const shouldQueueBehindSubmit = shouldQueueBehindInFlightSubmit({
      hasInFlightSubmit: submitInFlightRef.current.has(threadId),
      isLiveSubmitPreparing: liveSubmitPreparingThreads.has(threadId)
    })
    const willEnqueueWhileBusy =
      !isGoalSlashInput &&
      (isLoading || Boolean(pendingApproval) || approvalQueue.length > 0 || shouldQueueBehindSubmit)
    if (
      (!trimmedInput && !hasPendingFilePayload && !selectedSkill && !selectedBuiltinBrowser) ||
      historyLoading ||
      (isLoading && !allowSubmitWhileLoading && !willEnqueueWhileBusy) ||
      !stream
    )
      return

    // 硬上限:正文超过 MAX_INPUT_CHARS 字符时拒绝发送并提示,保留输入不清空。
    if (trimmedInput.length > MAX_INPUT_CHARS) {
      setError(
        `消息长度 ${trimmedInput.length.toLocaleString()} 字符,超过上限 ${MAX_INPUT_CHARS.toLocaleString()} 字符。请精简后再发送,或将长内容作为文件上传。`
      )
      return
    }

    const goalControlWithPendingTransport =
      hasPendingGoalTransportPayload &&
      isGoalSlashTransportSensitiveControlCommandInput(trimmedInput)
    if (goalControlWithPendingTransport) {
      setError(
        "附件、显式技能和内置浏览器模式不会用于 /goal 控制命令。请先移除它们，或改成 /goal <目标/完成条件>。"
      )
      return
    }

    const bypassGoalControlValidation = isGoalSlashControlCommandInput(trimmedInput)
    const goalControlRoute = resolveGoalControlSubmitRoute({
      isGoalControlCommand: bypassGoalControlValidation,
      isLoading,
      historyLoading,
      hasActiveGoal: hasActiveGoalRunning,
      goalControlAllowedWhileLoading
    })
    const isSideChannelGoalControl = goalControlRoute.isSideChannelGoalControl

    if (goalControlRoute.shouldUseGoalControlPlane) {
      const shouldLockGoalControl = goalControlRoute.shouldUseSubmitLock
      if (!tryAcquireSubmitInFlightLock(submitInFlightRef, shouldLockGoalControl, threadId)) return
      try {
        if (threadError) {
          clearError()
        }
        setInput("")
        if (shouldOpenGoalDetailsForStatus) {
          setGoalDetailsOpen(true)
        }
        insertLog("send: " + trimmedInput)
        const goalControlResult = await window.api.agent.goalControl(threadId, trimmedInput)
        if (!isSideChannelGoalControl) {
          showGoalControlNotice(
            shouldOpenGoalDetailsForStatus && goalControlResult.notice?.goalId
              ? "Goal 状态已刷新。"
              : goalControlResult.notice?.message
          )
        }
        void refreshGoalUi({ includeEvents: true })
        if (
          shouldClearPendingApprovalAfterGoalControl({
            hasPendingApproval: Boolean(pendingApproval),
            isTerminatingControlCommand: isGoalTerminatingControlCommandInput(trimmedInput),
            terminatedCurrentRun: goalControlResult.terminatedCurrentRun
          })
        ) {
          const approval = pendingApproval
          if (!approval) return
          const approvalAny = approval as unknown as Record<string, unknown>
          if (approvalAny._orchestratorRequestId) {
            window.api.sandbox.sendApprovalDecision({
              requestId: approvalAny._orchestratorRequestId as string,
              type: "reject",
              tool_call_id: approval.tool_call?.id || ""
            })
          }
          setPendingApproval(null)
        }
      } finally {
        releaseSubmitInFlightLock(submitInFlightRef, shouldLockGoalControl, threadId)
      }
      return
    }

    // The submit-in-flight lock is held for the ENTIRE duration of the active run
    // (stream.submit resolves only when the run ends). Enqueuing a draft doesn't
    // call stream.submit, so it must NOT contend for that lock — otherwise a draft
    // submitted mid-run can never acquire it and is silently dropped. (This mirrors
    // how side-channel /goal control commands also bypass the lock.)
    const shouldLockSubmit =
      shouldUseSubmitInFlightLock({ isSideChannelGoalControl }) && !willEnqueueWhileBusy
    if (!tryAcquireSubmitInFlightLock(submitInFlightRef, shouldLockSubmit, threadId)) return
    if (shouldLockSubmit) liveSubmitPreparingThreads.add(threadId)
    const shouldLockQueuedDraftPreparation = willEnqueueWhileBusy
    if (shouldLockQueuedDraftPreparation && queuedDraftPreparingThreads.has(threadId)) {
      releaseSubmitInFlightLock(submitInFlightRef, shouldLockSubmit, threadId)
      return
    }
    if (shouldLockQueuedDraftPreparation) queuedDraftPreparingThreads.add(threadId)

    try {
      const pendingApprovalRecord = pendingApproval as unknown as Record<string, unknown> | null
      if (
        pendingApproval &&
        !pendingApprovalRecord?._orchestratorRequestId &&
        isGoalSlashResumeCommandInput(trimmedInput)
      ) {
        setError("当前有待审批操作，请先处理审批卡片，再发送 /goal resume。")
        return
      }

      if (!bypassGoalControlValidation) {
        if (!currentModel) {
          setError("请先在下方选择模型后再发送消息。")
          return
        }

        const selectedModel = models.find((m) => m.id === currentModel)
        if (!selectedModel) {
          setError("当前线程模型不存在，请重新选择模型。")
          return
        }

        if (!selectedModel.available) {
          setError("当前模型不可用，请先在模型配置中设置 API 密钥。")
          return
        }

        if (!workspacePath) {
          setError("请先选择一个工作区文件夹再发送消息。")
          return
        }
      }

      // Solo/Multi differ only in thread metadata. Wait before claiming and
      // clearing the composer so a failed mode save cannot send under the old
      // policy or lose the user's draft.
      const pendingModeSave = agentModeSaveRef.current
      try {
        await pendingModeSave
      } catch {
        toast.error("Agent 模式保存失败，消息未发送；再次发送将使用原模式")
        return
      }
      // Reset both the error message and its structured detail at turn start so
      // no stale diagnostics linger into the new turn.
      if (threadError || errorDetail) {
        clearError()
      }

      // When parking a draft mid-approval we deliberately do NOT reject the
      // pending approval — the run stays alive and the draft drains/steers later.
      if (!willEnqueueWhileBusy && (pendingApproval || approvalQueue.length > 0)) {
        // P0 fix: notify main process to reject the pending approval instead of silently dropping it.
        // Otherwise the orchestrator's Promise hangs until the 5-minute timeout.
        for (const approval of [pendingApproval, ...approvalQueue].filter(Boolean)) {
          const approvalAny = approval as unknown as Record<string, unknown>
          if (approvalAny._orchestratorRequestId) {
            window.api.sandbox.sendApprovalDecision({
              requestId: approvalAny._orchestratorRequestId as string,
              type: "reject",
              tool_call_id: approval?.tool_call?.id || ""
            })
          }
        }
        if (pendingApproval) {
          setToolCallState(pendingApproval.tool_call?.id || "", { status: "rejected" })
        }
        clearPendingApprovals()
      }

      // Claim the current composer payload before @file IO. A second Enter sees
      // the preparation guard, while text typed during the await goes into a
      // fresh composer and is not cleared when this draft is enqueued.
      const skill = selectedSkill
      const browser = selectedBuiltinBrowser
      const claimedAttachments = attachments
      const claimedMentionedFiles = mentionedFiles
      let rawMessage = trimmedInput
      setInput("")
      setAttachments([])
      setMentionedFiles([])
      if (skill) setSelectedSkill(null)
      // The original composer payload is now atomically claimed. Any later
      // Enter belongs to newly typed input and should queue behind this submit
      // while @file IO is still running, rather than being silently ignored.
      if (shouldLockSubmit) liveSubmitPreparingThreads.delete(threadId)
      // 统一在 helper 里完成 @文件解析、内容读取、附件去重和文本清洗，
      // 这里仅消费结果，避免发送流程继续堆积细节分支。
      const atFileRequestToken = crypto.randomUUID()
      const atFileWorkspaceKey = normalizeWorkspacePathKey(workspacePath)
      activeAtFilePreviewTokensRef.current.add(atFileRequestToken)
      const cancelAtFileReads = (): void => {
        void window.api.workspace.cancelFilePreview({
          lanePrefix: AT_FILE_PREVIEW_LANE,
          requestToken: atFileRequestToken
        })
      }
      let atFileResolution: Awaited<ReturnType<typeof resolveAtFileAttachments>>
      try {
        atFileResolution = await resolveAtFileAttachments({
          rawMessage,
          attachments: claimedAttachments,
          mentionedFiles: claimedMentionedFiles,
          workspacePath,
          workspaceFiles,
          maxAttachments: MAX_ATTACHMENTS,
          maxTotalChars: MAX_TOTAL_CHARS,
          readWorkspaceFile: async (filePath, maxChars) => {
            // A workspace can still change before the first user turn is
            // committed. Fence both sides of the async read so content from a
            // newly selected workspace is never attached under the old chip path.
            if (normalizeWorkspacePathKey(workspacePathRef.current) !== atFileWorkspaceKey) {
              return { success: false }
            }
            const result = await readBoundedWorkspaceMentionFile({
              maxChars,
              readPage: (offset) =>
                window.api.workspace.readFilePreview({
                  source: { threadId, filePath },
                  offset,
                  lane: AT_FILE_PREVIEW_LANE,
                  requestToken: atFileRequestToken
                })
            })
            return normalizeWorkspacePathKey(workspacePathRef.current) === atFileWorkspaceKey
              ? result
              : { success: false }
          },
          cancelWorkspaceFileReads: cancelAtFileReads
        })
      } finally {
        activeAtFilePreviewTokensRef.current.delete(atFileRequestToken)
        cancelAtFileReads()
      }
      const {
        cleanedMessage,
        attachments: resolvedAttachments,
        mentionCountLimitHit,
        mentionAttachmentLimitHit,
        warningMessage: atFileWarningMessage
      } = atFileResolution
      rawMessage = cleanedMessage

      // These are delivery warnings, not run failures. A thread error blocks the
      // queue pump, so keep the degraded send non-blocking in both live and busy paths.
      if (mentionCountLimitHit) {
        toast.warning(`@文件最多只会带入前 ${MAX_ATTACHMENTS} 个附件`)
      } else if (mentionAttachmentLimitHit) {
        toast.warning(`@文件内容总量已达上限（${MAX_TOTAL_CHARS.toLocaleString()} 字符）`)
      } else if (atFileWarningMessage) {
        // 非致命失败只做提示，不中断后面的普通发送流程。
        toast.warning(atFileWarningMessage)
      }

      // A stale chip may have been the only composer payload. Once it is
      // rejected, do not emit an empty user turn merely because the pre-read
      // validation originally saw a pending file chip.
      if (!rawMessage && resolvedAttachments.length === 0 && !skill && !browser) return

      const attachmentPayload = resolvedAttachments.length > 0 ? resolvedAttachments : undefined
      const fallbackUserText = attachmentPayload && !skill ? "请分析以下文件内容。" : ""
      const visibleUserText = resolveBuiltinBrowserVisibleUserText({
        browserSelected: browser,
        fallbackUserText,
        rawMessage
      })
      // If user only uploaded files without text, add a default prompt.
      // skill-only sends (text empty, no attachments) still fall into this branch
      // because the default prompt requires attachments — for skill-only we let
      // userText stay empty and rely on the trailing skill-use block as the signal.
      // When a skill is active we also skip the default prompt: the skill's own
      // instruction will tell the model what to do with the attachment, and a
      // generic "请分析以下文件内容" would compete with it.
      const userText = rawMessage || (attachmentPayload && !skill ? "请分析以下文件内容。" : "")
      if (browser) setSelectedBuiltinBrowser(false)
      if (shouldOpenGoalDetailsForStatus) {
        setGoalDetailsOpen(true)
      }
      insertLog(
        (willEnqueueWhileBusy ? "queue: " : "send: ") +
          (visibleUserText || (skill ? `[skill-only: ${skill.name}]` : ""))
      )

      const isFirstMessage = threadMessages.length === 0
      // Keep real user intent visible in the transcript. Goal status/pause/clear
      // are side-channel controls, but `/goal <objective>` and `/goal resume`
      // are user turns and should appear immediately in live UI.
      const shouldAppendVisibleUserMessage = !bypassGoalControlValidation

      // Compose the message parts (text / attachment XML / display prefix / skill
      // block) into a QueuedMessage-shaped draft. The exact same shape is either
      // sent now or parked in the draft queue, so a drained draft is byte-identical
      // to sending it live. Attachment XML is what the model sees; the "📎 name"
      // prefix is what the user's bubble shows.
      let attachmentModelBlocks = ""
      let attachmentDisplayPrefix = ""
      if (attachmentPayload && attachmentPayload.length > 0) {
        const attachmentTexts = attachmentPayload.map((att) => {
          const truncAttr = att.truncated ? ' truncated="true"' : ""
          const pathAttr = att.filePath ? ` path="${escXml(att.filePath)}"` : ""
          const safeContent = att.content.replace(/<\/attachment>/gi, "< /attachment>")
          return `\n\n<attachment filename="${escXml(att.filename)}"${pathAttr} type="${att.mimeType}" size="${att.size}"${truncAttr}>\n${safeContent}\n</attachment>`
        })
        attachmentModelBlocks = attachmentTexts.join("")
        attachmentDisplayPrefix = attachmentPayload.map((a) => `📎 ${a.filename}`).join("\n")
      }

      // Skill-use block, appended last. The model is told to `read` the SKILL.md
      // itself — we don't inline the body. Hooks/routing/memory see it verbatim.
      const skillBlock = skill
        ? formatSkillUseBlock({
            name: skill.name,
            path: skill.path,
            description: skill.description,
            metadata: skill.metadata,
            allowedTools: skill.allowedTools
          })
        : ""

      const composedDraft: QueuedMessage = {
        id: crypto.randomUUID(),
        text: userText,
        attachmentModelBlocks,
        attachmentDisplayPrefix,
        skillBlock,
        builtinBrowser: browser,
        modelId: currentModel,
        created_at: new Date(),
        updated_at: new Date()
      }

      // Busy → park the draft and stop. The auto-drain effect sends it once the
      // thread is idle again, or the user can steer it into the running turn.
      if (willEnqueueWhileBusy) {
        addQueuedMessage(composedDraft)
        // An actual enqueue is unambiguous renewed intent to keep going — lift
        // any Stop-driven pause so this (and any earlier still-queued) draft can
        // auto-drain once idle. Cleared here (not merely "past the guards") so a
        // FAILED submit attempt right after Stop can't accidentally un-suppress.
        setQueueAutoDrainSuppressed(false)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
        })
        return
      }

      // fullMessage is the model payload (attachment XML inlined); displayContent
      // is the user's bubble (📎 names). Note: the *checkpointed* message is
      // fullMessage, so after a reload MessageBubble renders raw attachment XML
      // rather than 📎 names — a pre-existing attachment-pipeline limitation.
      const fullMessage = getQueuedModelContent(composedDraft)
      const displayContent = guardCoordinatorPlainText(getQueuedDisplayContent(composedDraft))

      const coordinatorPrefixed =
        !disableCoordinatorModeOption &&
        canChangeAgentMode &&
        /^\s*(?:\[coordinator\]|#coordinator)\s*[:-]?/i.test(fullMessage)
      let submitAgentMode: ChatAgentMode = disableCoordinatorModeOption
        ? "normal"
        : coordinatorPrefixed
          ? "coordinator"
          : persistedAgentModeRef.current
      if (disableWorkflowModeOption && submitAgentMode === "workflow") {
        submitAgentMode = "normal"
      }
      if (!coordinatorPrefixed && !agentModeHydratedRef.current) {
        submitAgentMode = await loadResolvedAgentMode()
          .then((resolvedMode) => {
            persistedAgentModeRef.current = resolvedMode
            return resolvedMode
          })
          .catch((error) => {
            console.warn("[ChatContainer] Failed to resolve submit agent mode:", error)
            return agentMode
          })
        if (disableWorkflowModeOption && submitAgentMode === "workflow") {
          submitAgentMode = "normal"
        }
        agentModeHydratedRef.current = true
        if (submitAgentMode !== agentMode) {
          setAgentMode(submitAgentMode)
        }
      }
      if (
        (disableCoordinatorModeOption && agentMode === "coordinator") ||
        (disableWorkflowModeOption && agentMode === "workflow")
      ) {
        agentModeHydratedRef.current = true
        setAgentMode("normal")
      } else if (
        !coordinatorPrefixed &&
        submitAgentMode === "coordinator" &&
        agentMode !== "coordinator"
      ) {
        agentModeHydratedRef.current = true
        setAgentMode("coordinator")
      }

      let visibleUserMessage: Message | null = null
      if (shouldAppendVisibleUserMessage) {
        // 同步维护顺序数组，支持 app 重启后按消息顺序恢复历史耗时。user message 在前端先 append，
        // checkpoint 恢复时 id 可能不一定完全一致；因此仍需要顺序数组作为兜底。
        const visibleUserMessagePromise = appendVisibleUserMessageWithTime(displayContent)
        visibleUserMessage = await visibleUserMessagePromise
      }

      const shouldGenerateTitleForGoalSet =
        isGoalSlashInput &&
        !isGoalSlashControlCommandInput(userText) &&
        !isGoalSlashResumeCommandInput(userText)
      const shouldGenerateTitleForFirstMessage =
        isFirstMessage &&
        shouldAppendVisibleUserMessage &&
        (!isGoalSlashInput || shouldGenerateTitleForGoalSet)

      if (shouldGenerateTitleForFirstMessage) {
        const currentThread = threads.find((t) => t.thread_id === threadId)
        const hasDefaultTitle = currentThread?.title?.startsWith("Thread ")
        if (hasDefaultTitle) {
          // skill-only sends have empty userText. Fall back to the skill name so
          // the sidebar shows something meaningful instead of the raw thread id.
          const goalTitleSource = isGoalSlashInput
            ? splitGoalTransportPayload(userText)
                .commandText.replace(/^\/goal\b/i, "")
                .trim()
            : ""
          let titleSource = isGoalSlashInput ? goalTitleSource : visibleUserText
          if (!titleSource && skill) {
            titleSource = `使用 ${skill.name}`
          }
          if (!titleSource) {
            titleSource = getBuiltinBrowserTitleSource(browser)
          }
          if (titleSource) {
            generateTitleForFirstMessage(threadId, titleSource)
          }
        }
      }

      const startTime = Date.now()
      setActiveTurnStartTime(startTime)
      // A finished workflow panel belongs to the previous turn; drop it when a
      // new message goes out so it doesn't linger forever in the transcript.
      clearFinishedWorkflowRun()
      // Every validation above (length, lock, model, workspace) has passed and
      // we're committed to sending — this is the actual "renewed intent" signal
      // that should lift a Stop-driven pause, not merely having reached past the
      // early-return guards (a later failed attempt, e.g. MAX_INPUT_CHARS or a
      // held lock, would otherwise un-suppress without anything having sent).
      setQueueAutoDrainSuppressed(false)
      // Payload preparation and the optimistic bubble are committed. A later
      // Enter is now new input and should queue behind the held run lock even
      // before useStream propagates isLoading.
      if (shouldLockSubmit) liveSubmitPreparingThreads.delete(threadId)
      try {
        await stream.submit(
          {
            messages: [{ type: "human", content: fullMessage }]
          },
          {
            config: {
              configurable: {
                thread_id: threadId,
                model_id: currentModel,
                agent_mode: submitAgentMode === "multi" ? "normal" : submitAgentMode,
                ...(visibleUserMessage?.id ? { hook_turn_id: visibleUserMessage.id } : {})
              }
            }
          }
        )
      } finally {
        setActiveTurnStartTime(null)
      }
    } finally {
      if (shouldLockSubmit) liveSubmitPreparingThreads.delete(threadId)
      if (shouldLockQueuedDraftPreparation) queuedDraftPreparingThreads.delete(threadId)
      // `done` can flip isLoading to false before stream.submit's promise
      // continuation releases this mutable lock. The idle-rendered pump then
      // observes the lock, returns, and otherwise has no reactive reason to
      // try again. Publish a wake only after the lock is actually gone.
      releaseSubmitInFlightLock(submitInFlightRef, shouldLockSubmit, threadId)
    }
  }

  const startEditingQueuedMessage = useCallback((message: QueuedMessage): void => {
    setEditingQueueId(message.id)
    setEditingQueueText(message.text)
  }, [])

  const cancelEditingQueuedMessage = useCallback((): void => {
    setEditingQueueId(null)
    setEditingQueueText("")
  }, [])

  const saveEditingQueuedMessage = useCallback(async (): Promise<void> => {
    if (!editingQueueId) return
    const message = getQueuedMessage(editingQueueId)
    if (!message) {
      setEditingQueueId(null)
      setEditingQueueText("")
      return
    }
    if (guidingQueuedMessageIdsRef.current.has(message.id)) {
      toast.message("该消息正在提交引导，请稍后再编辑")
      return
    }
    const nextText = editingQueueText.trim()
    // Allow an empty text only when the draft still carries an attachment or skill
    // block; otherwise a blank save would produce an unsendable empty message.
    const hasNonTextPayload =
      Boolean(message.attachmentModelBlocks?.trim()) || Boolean(message.skillBlock?.trim())
    if (!nextText && !hasNonTextPayload) return
    // Mirror handleSubmit's hard cap. A freshly-composed draft is already checked
    // there before it can enter the queue, but the edit textarea has no length
    // limit of its own — without this, editing an already-queued draft is the one
    // path that could push arbitrarily long text past the limit and into the model.
    // Uses a toast, not setError: a queued draft is typically being edited WHILE
    // the thread is busy, and the error card is gated on !isLoading — setError
    // here would be invisible until the run ends, and threadError also gates the
    // auto-drain pump (see below), so a stale error from this purely local
    // validation would silently stall the ENTIRE queue (not just this item) once
    // the thread goes idle, until the user notices and dismisses it.
    if (nextText.length > MAX_INPUT_CHARS) {
      toast.error(
        `消息长度 ${nextText.length.toLocaleString()} 字符，超过上限 ${MAX_INPUT_CHARS.toLocaleString()} 字符。请精简后再保存。`
      )
      return
    }
    const updatedMessage = { ...message, text: nextText }
    setEditingQueueId(null)
    setEditingQueueText("")

    if (!message.handoffRequestedAt) {
      updateQueuedMessage(message.id, { text: nextText })
      return
    }

    const requestId = ++queuedEditRequestRef.current
    const originalUpdatedAt = message.updated_at.getTime()
    const isCurrentRequest = (): boolean => requestId === queuedEditRequestRef.current
    const getUnchangedGuidedMessage = (): QueuedMessage | undefined => {
      const current = getQueuedMessage(message.id)
      return current?.handoffRequestedAt && current.updated_at.getTime() === originalUpdatedAt
        ? current
        : undefined
    }
    const reconcile = (): Promise<{
      pendingIds: string[]
      injectedIds: string[]
      durableIds: string[]
    }> => window.api.agent.reconcileCurrentRunQueuedMessages(threadId, [message.id])
    const finishDurable = (durableIds: string[]): boolean => {
      if (!durableIds.includes(message.id)) return false
      if (!threadMessages.some((item) => item.id === message.id)) {
        appendMessage({
          id: message.id,
          role: "user",
          content: guardCoordinatorPlainText(getQueuedDisplayContent(message)),
          created_at: new Date()
        })
      }
      deleteQueuedMessage(message.id)
      toast.message("该消息已被模型接收，编辑未生效，已从队列移除")
      return true
    }

    try {
      const beforeEdit = await reconcile()
      if (!isCurrentRequest() || !getUnchangedGuidedMessage()) return
      if (finishDurable(beforeEdit.durableIds)) return

      if (classifyGuidedMessage(message.id, beforeEdit) === "unconsumed") {
        updateQueuedMessage(message.id, { text: nextText, handoffRequestedAt: undefined })
        return
      }

      const result = await window.api.agent.queueCurrentRunMessage(threadId, {
        id: message.id,
        content: getQueuedModelContent(updatedMessage),
        displayContent: guardCoordinatorPlainText(getQueuedDisplayContent(updatedMessage))
      })
      if (!isCurrentRequest() || !getUnchangedGuidedMessage()) return
      if (result.queued) {
        updateQueuedMessage(message.id, { text: nextText })
        return
      }

      // The run can finish between reconciliation and the update IPC. Reconcile
      // again before deciding whether this is an unconsumed draft or an already
      // durable user turn; never downgrade from handoff based on no_active_run.
      const afterRejection = await reconcile()
      if (!isCurrentRequest() || !getUnchangedGuidedMessage()) return
      if (finishDurable(afterRejection.durableIds)) return
      if (classifyGuidedMessage(message.id, afterRejection) === "unconsumed") {
        updateQueuedMessage(message.id, { text: nextText, handoffRequestedAt: undefined })
      } else {
        toast.error("该引导消息正在提交，暂时无法编辑")
      }
    } catch (err) {
      console.error("[ChatContainer] Failed to reconcile edited guided message:", err)
      // Ambiguous transport failure is not evidence that the run rejected the
      // message. Preserve the original handoff to prevent a duplicate fresh turn.
      if (isCurrentRequest() && getUnchangedGuidedMessage()) {
        toast.error("无法确认引导消息状态，原消息保持不变")
      }
    }
  }, [
    appendMessage,
    deleteQueuedMessage,
    editingQueueId,
    editingQueueText,
    getQueuedMessage,
    threadId,
    threadMessages,
    updateQueuedMessage
  ])

  const moveQueuedMessage = useCallback(
    (sourceId: string, targetId: string, placement: "before" | "after"): void => {
      if (sourceId === targetId) return
      const source = getQueuedMessage(sourceId)
      const target = getQueuedMessage(targetId)
      if (!source || !target || source.handoffRequestedAt || target.handoffRequestedAt) return
      const ids = queuedMessages.map((message) => message.id)
      const sourceIndex = ids.indexOf(sourceId)
      const targetIndex = ids.indexOf(targetId)
      if (sourceIndex < 0 || targetIndex < 0) return
      ids.splice(sourceIndex, 1)
      const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
      ids.splice(placement === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex, 0, sourceId)
      reorderQueuedMessages(ids)
    },
    [getQueuedMessage, queuedMessages, reorderQueuedMessages]
  )

  const handleDeleteQueuedMessage = useCallback(
    (message: QueuedMessage): void => {
      // Main only needs a withdrawal tombstone for a handoff that is queued or
      // still inside async hook preparation. Ordinary local drafts never entered
      // main and deleting them must not poison the same id in another window.
      if (message.handoffRequestedAt || guidingQueuedMessageIdsRef.current.has(message.id)) {
        void window.api.agent.deleteCurrentRunQueuedMessage(threadId, message.id)
      }
      deleteQueuedMessage(message.id)
    },
    [deleteQueuedMessage, threadId]
  )

  const handleGuideQueuedMessage = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (hasActiveGoalRunning) {
        toast.message("Active Goal 运行中，请先暂停 Goal 再引导消息")
        return
      }
      const current = getQueuedMessage(message.id)
      if (!current || current.handoffRequestedAt) return
      // Claim ownership before crossing the IPC boundary. This synchronously
      // blocks local editing, reordering, and auto-drain while main is deciding
      // whether it can accept the steer.
      guidingQueuedMessageIdsRef.current.add(current.id)
      updateQueuedMessage(current.id, { handoffRequestedAt: new Date() })
      try {
        const result = await window.api.agent.queueCurrentRunMessage(threadId, {
          id: current.id,
          content: getQueuedModelContent(current),
          displayContent: guardCoordinatorPlainText(getQueuedDisplayContent(current))
        })
        if (result.queued) {
          toast.success("已提交给当前运行，会在下一次模型调用前接收")
          return
        }
        // The user can delete the draft while its async hook preparation is in
        // flight. Main records a withdrawal tombstone; no fallback UI is needed.
        if (!getQueuedMessage(current.id)) return
        if (result.reason === "withdrawn") {
          deleteQueuedMessage(current.id)
          return
        }
        if (result.reason === "already_injected") {
          // Main is authoritative: this id already reached the model loop and
          // was durably persisted before injection. Never clear the handoff or
          // promote it into the ordinary queue, which would submit it twice.
          try {
            const reconciliation = await window.api.agent.reconcileCurrentRunQueuedMessages(
              threadId,
              [current.id]
            )
            if (classifyGuidedMessage(current.id, reconciliation) === "durable") {
              if (!threadMessages.some((item) => item.id === current.id)) {
                appendMessage({
                  id: current.id,
                  role: "user",
                  content: guardCoordinatorPlainText(getQueuedDisplayContent(current)),
                  created_at: new Date()
                })
              }
              deleteQueuedMessage(current.id)
            }
          } catch (error) {
            console.warn("[ChatContainer] Failed to reconcile already-injected draft:", error)
          }
          toast.message("该消息已由当前运行接收，正在同步记录")
          return
        }
        if (getQueuedMessage(current.id)?.handoffRequestedAt) {
          updateQueuedMessage(current.id, { handoffRequestedAt: undefined })
        }
        if (result.reason === "active_goal") {
          toast.message("Active Goal 运行中，请先暂停 Goal 再引导消息")
          return
        }
        if (result.reason === "hook_blocked") {
          toast.error(result.message || "该消息被 Hook 策略拦截，已保留在队列中")
          return
        }
        if (result.reason === "run_not_ready") {
          toast.message("当前运行仍在准备中，请稍后重试引导")
          return
        }
        // No steerable foreground run (e.g. background workflow/worker) — surface
        // it to the front of the queue so it drains first once the thread is idle.
        // Clicking 引导 is explicit renewed intent, so it must also resume a
        // Stop-paused queue; the pump's normal idle/goal/approval gates still
        // decide when it may actually submit.
        setQueueAutoDrainSuppressed(false)
        promoteQueuedMessage(current.id)
        toast.message("当前没有可插队的运行，已提到队首")
      } catch (err) {
        console.error("[ChatContainer] Failed to guide queued message:", err)
        if (getQueuedMessage(current.id)?.handoffRequestedAt) {
          updateQueuedMessage(current.id, { handoffRequestedAt: undefined })
        }
        setQueueAutoDrainSuppressed(false)
        promoteQueuedMessage(current.id)
        toast.error("插队失败，已提到队首")
      } finally {
        guidingQueuedMessageIdsRef.current.delete(current.id)
      }
    },
    [
      appendMessage,
      deleteQueuedMessage,
      getQueuedMessage,
      hasActiveGoalRunning,
      promoteQueuedMessage,
      setQueueAutoDrainSuppressed,
      threadMessages,
      threadId,
      updateQueuedMessage
    ]
  )

  const submitQueuedMessage = useCallback(
    async (queued: QueuedMessage): Promise<void> => {
      if (!stream) return
      const fullMessage = getQueuedModelContent(queued)
      if (!fullMessage.trim()) {
        deleteQueuedMessage(queued.id)
        return
      }
      // A persisted draft can outlive its selected model, credentials, or
      // workspace. Keep it queued and surface the same local validation as a
      // live send instead of creating an optimistic bubble that can only fail
      // in the backend.
      const queuedModel = queued.modelId
        ? models.find((model) => model.id === queued.modelId)
        : undefined
      const currentSelectedModel = currentModel
        ? models.find((model) => model.id === currentModel)
        : undefined
      const selectedModel = queuedModel?.available
        ? queuedModel
        : currentSelectedModel?.available
          ? currentSelectedModel
          : undefined
      if (!selectedModel) {
        if (!queued.modelId && !currentModel) {
          setError(QUEUE_MODEL_REQUIRED_ERROR)
        } else if (queuedModel || currentSelectedModel) {
          setError(QUEUE_MODEL_UNAVAILABLE_ERROR)
        } else {
          setError(QUEUE_MODEL_MISSING_ERROR)
        }
        return
      }
      const queuedModelId = selectedModel.id
      if (!workspacePath) {
        // The draft remains queued on this validation return, so persist a
        // successful stale-model fallback now. In the send path the draft is
        // claimed and removed instead; its failure handler re-parks it with the
        // same resolved model id.
        if (queued.modelId !== queuedModelId) {
          updateQueuedMessage(queued.id, { modelId: queuedModelId })
        }
        setError(QUEUE_WORKSPACE_REQUIRED_ERROR)
        return
      }
      const displayContent = guardCoordinatorPlainText(getQueuedDisplayContent(queued))
      // A queued message is a fresh turn: resolve agent_mode from the user's
      // current selection (plus a [coordinator] text prefix), matching handleSubmit
      // exactly — including the async hydration below. A draft can auto-drain before
      // the live send path ever ran (e.g. the very first turn on a coordinator/workflow
      // thread was composed, queued while busy, and the run finishes before the user
      // ever hits a live send), so `agentModeHydratedRef` may still be unresolved here.
      // Skipping this hydration would route that turn through the wrong mode.
      const pendingModeSave = agentModeSaveRef.current
      try {
        await pendingModeSave
      } catch {
        return
      }
      const coordinatorPrefixed =
        !disableCoordinatorModeOption &&
        canChangeAgentMode &&
        /^\s*(?:\[coordinator\]|#coordinator)\s*[:-]?/i.test(fullMessage)
      let submitAgentMode: ChatAgentMode = disableCoordinatorModeOption
        ? "normal"
        : coordinatorPrefixed
          ? "coordinator"
          : persistedAgentModeRef.current
      if (disableWorkflowModeOption && submitAgentMode === "workflow") {
        submitAgentMode = "normal"
      }
      if (!coordinatorPrefixed && !agentModeHydratedRef.current) {
        submitAgentMode = await loadResolvedAgentMode()
          .then((resolvedMode) => {
            persistedAgentModeRef.current = resolvedMode
            return resolvedMode
          })
          .catch((error) => {
            console.warn("[ChatContainer] Failed to resolve queued draft agent mode:", error)
            return agentMode
          })
        if (disableWorkflowModeOption && submitAgentMode === "workflow") {
          submitAgentMode = "normal"
        }
        agentModeHydratedRef.current = true
        if (submitAgentMode !== agentMode) {
          setAgentMode(submitAgentMode)
        }
      }
      if (
        (disableCoordinatorModeOption && agentMode === "coordinator") ||
        (disableWorkflowModeOption && agentMode === "workflow")
      ) {
        agentModeHydratedRef.current = true
        setAgentMode("normal")
      } else if (
        !coordinatorPrefixed &&
        submitAgentMode === "coordinator" &&
        agentMode !== "coordinator"
      ) {
        agentModeHydratedRef.current = true
        setAgentMode("coordinator")
      }
      // Agent-mode hydration above is asynchronous. The user may edit, delete,
      // or guide this draft while it is awaiting that result. Claim it only if
      // the authoritative queue still contains the exact same version and it
      // has not been handed to the active run. No await occurs between this
      // check and deletion, so the claim is atomic on the renderer event loop.
      const currentQueued = getQueuedMessage(queued.id)
      if (!canClaimQueuedMessage(queued, currentQueued)) return
      const isFirstMessage = threadMessages.length === 0
      deleteQueuedMessage(queued.id)
      // Reuse the draft's own id for the optimistic bubble. If stream.submit below
      // throws, the catch re-parks this same draft and the pump retries it — without
      // a stable id, each retry would call appendMessage with a FRESH uuid and leave
      // a new orphaned "ghost" user bubble behind every attempt (appendMessage upserts
      // by id, so re-using queued.id makes a retry replace the same bubble instead).
      const visibleUserMessage = await appendVisibleUserMessageWithTime(displayContent, {
        id: queued.id
      })
      if (isFirstMessage) {
        const currentThread = threads.find((t) => t.thread_id === threadId)
        const hasDefaultTitle = currentThread?.title?.startsWith("Thread ")
        const titleSource = queued.text.trim() || (queued.skillBlock ? "使用技能" : "")
        if (hasDefaultTitle && titleSource) {
          generateTitleForFirstMessage(threadId, titleSource)
        }
      }
      const startTime = Date.now()
      setActiveTurnStartTime(startTime)
      clearFinishedWorkflowRun()
      try {
        await stream.submit(
          {
            messages: [{ type: "human", content: fullMessage }]
          },
          {
            config: {
              configurable: {
                thread_id: threadId,
                model_id: queuedModelId,
                agent_mode: submitAgentMode === "multi" ? "normal" : submitAgentMode,
                ...(visibleUserMessage?.id ? { hook_turn_id: visibleUserMessage.id } : {})
              }
            }
          }
        )
      } finally {
        setActiveTurnStartTime(null)
      }
    },
    [
      agentMode,
      appendVisibleUserMessageWithTime,
      canChangeAgentMode,
      clearFinishedWorkflowRun,
      currentModel,
      deleteQueuedMessage,
      disableCoordinatorModeOption,
      disableWorkflowModeOption,
      generateTitleForFirstMessage,
      getQueuedMessage,
      loadResolvedAgentMode,
      models,
      setActiveTurnStartTime,
      setError,
      stream,
      threadId,
      threadMessages.length,
      threads,
      updateQueuedMessage,
      workspacePath
    ]
  )

  // Queue validation errors are recoverable configuration prompts. Once the
  // selected model and workspace are usable, clear only those known errors so
  // the parked draft can resume; unrelated run failures still block auto-drain.
  useEffect(() => {
    if (!threadError || !RECOVERABLE_QUEUE_ERRORS.has(threadError)) return
    const selectedModel = currentModel
      ? models.find((model) => model.id === currentModel)
      : undefined
    if (selectedModel?.available && workspacePath) clearError()
  }, [clearError, currentModel, models, threadError, workspacePath])

  // Reconcile handed-off drafts against main-process state instead of guessing
  // from an idle transition. Durable messages leave the draft queue, messages
  // still owned by the run stay handed off, and only unconsumed messages return
  // to normal auto-drain. This also repairs a lost injection event or reload.
  useEffect(() => {
    if (isLoading || pendingApproval || historyLoading) return
    const handedOff = queuedMessages.filter((queued) => queued.handoffRequestedAt)
    if (handedOff.length === 0) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRetry = (): void => {
      retryTimer = setTimeout(() => {
        if (!cancelled) setQueuePumpTick((tick) => tick + 1)
      }, 1000)
    }
    void window.api.agent
      .reconcileCurrentRunQueuedMessages(
        threadId,
        handedOff.map((queued) => queued.id)
      )
      .then(async ({ pendingIds, injectedIds, durableIds }) => {
        if (cancelled) return
        const pending = new Set([...pendingIds, ...injectedIds])
        const durable = new Set(durableIds)
        const visibleIds = new Set(threadMessages.map((message) => message.id))
        const missingDurableIds = handedOff
          .filter((queued) => durable.has(queued.id) && !visibleIds.has(queued.id))
          .map((queued) => queued.id)
        const missingDurableIdSet = new Set(missingDurableIds)
        if (missingDurableIds.length > 0) {
          const synced = await syncDurableTranscript(missingDurableIds)
          if (cancelled) return
          if (!synced) {
            scheduleRetry()
            return
          }
        }
        let shouldRetry = false
        for (const queued of handedOff) {
          if (durable.has(queued.id)) {
            // Missing durable messages and their handed-off drafts are committed
            // atomically by syncDurableTranscript. A separately queued delete
            // could otherwise run after its lifecycle fence became stale.
            if (!missingDurableIdSet.has(queued.id)) deleteQueuedMessage(queued.id)
          } else if (pending.has(queued.id)) {
            shouldRetry = true
          } else {
            updateQueuedMessage(queued.id, { handoffRequestedAt: undefined })
          }
        }
        // A renderer reload can lose the original queue IPC callback while main
        // is still inside a slow Hook. Poll only while main still owns a handoff;
        // auto-drain remains blocked until it becomes durable or unconsumed.
        if (shouldRetry) scheduleRetry()
      })
      .catch((error) => {
        if (cancelled) return
        console.warn("[ChatContainer] Failed to reconcile guided drafts:", error)
        // A transient IPC failure must not strand an ambiguous handoff forever.
        // Keep it blocked from auto-drain, then retry authoritative reconciliation.
        scheduleRetry()
      })

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [
    deleteQueuedMessage,
    historyLoading,
    isLoading,
    pendingApproval,
    queuePumpTick,
    queuedMessages,
    syncDurableTranscript,
    threadId,
    threadMessages,
    updateQueuedMessage
  ])

  // Auto-drain the queue head once the thread is idle. Gated on !hasActiveGoalRunning
  // so a draft never slips into the gap between two goal legs (it waits for the goal
  // to complete/pause). Serializes on submitInFlightRef — the SAME lock handleSubmit's
  // live-send path uses (see willEnqueueWhileBusy above) — rather than a second,
  // pump-only ref: the pump holds this lock for the duration of its own submit
  // (below), so checking it here covers BOTH "another live send is in flight" and
  // "the pump itself is already mid-flight" with one shared source of truth. This is
  // a UX ordering guard, not a data-safety one — useStream's own client-side queue
  // already fully serializes submit() calls on this stream instance (see the longer
  // note by willEnqueueWhileBusy), so nothing is ever lost either way. What a second,
  // uncoordinated lock WOULD produce: a live "/goal resume" (unconditionally excluded
  // from willEnqueueWhileBusy — goal commands must never be silently parked in the
  // queue) could slip in ahead of the pump's own stream.submit and end up silently
  // queued behind it inside the SDK with no visible indication why, while the pump's
  // optimistic UI (bubble already appended, draft already removed from the queue)
  // sits there looking "sent." Failing fast here avoids that. The shared release
  // version forces a re-check after each settle, including across component remounts.
  useEffect(() => {
    if (queueAutoDrainSuppressed) return
    if (submitInFlightRef.current.has(threadId)) return
    if (isLoading || pendingApproval || threadError || !stream) return
    if (historyLoading || readOnly || contextReminderPending) return
    if (hasActiveGoalRunning) return
    // Reconciliation owns transcript ordering for every handed-off draft, not
    // only the queue head. Draining any ordinary item first could append it
    // before a previously injected guided turn whose acknowledgement is late.
    if (queuedMessages.some((queued) => queued.handoffRequestedAt)) return
    const next = queuedMessages[0]
    if (!next) return

    if (!tryAcquireSubmitInFlightLock(submitInFlightRef, true, threadId)) return
    submitQueuedMessage(next)
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        let durable: boolean | undefined
        try {
          const reconciliation = await window.api.agent.reconcileCurrentRunQueuedMessages(
            threadId,
            [next.id]
          )
          durable = reconciliation.durableIds.includes(next.id)
        } catch (reconcileError) {
          console.warn(
            "[ChatContainer] Failed to reconcile queued submission after stream error:",
            reconcileError
          )
        }
        // Main may have durably accepted the user turn before the model/runtime
        // failed. Keep that failed turn visible and never retry its side effects.
        if (durable === true) return

        // No durable turn exists, or transport failure made that ambiguous. Remove
        // the optimistic bubble and restore the draft. Ambiguous drafts are marked
        // handed-off so normal drain waits for the existing reconcile effect.
        removeLocalMessage(next.id)
        // Restore the failed head at the front so transient failures do not
        // reorder a FIFO queue (A,B must not become B,A).
        const savedModelStillAvailable = models.some(
          (model) => model.id === next.modelId && model.available
        )
        const currentModelAvailable = models.some(
          (model) => model.id === currentModel && model.available
        )
        prependQueuedMessage({
          ...next,
          ...(!savedModelStillAvailable && currentModelAvailable && currentModel
            ? { modelId: currentModel }
            : {}),
          ...(durable === undefined ? { handoffRequestedAt: new Date() } : {}),
          updated_at: new Date()
        })
      })
      .finally(() => {
        releaseSubmitInFlightLock(submitInFlightRef, true, threadId)
      })
  }, [
    contextReminderPending,
    currentModel,
    hasActiveGoalRunning,
    historyLoading,
    isLoading,
    models,
    pendingApproval,
    prependQueuedMessage,
    queueAutoDrainSuppressed,
    queuePumpTick,
    queuedMessages,
    readOnly,
    removeLocalMessage,
    setError,
    stream,
    submitReleaseVersion,
    submitQueuedMessage,
    submitInFlightRef,
    threadError,
    threadId
  ])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // IME composing (Chinese/Japanese/Korean) should not trigger submit on Enter
    const isComposing = e.nativeEvent.isComposing || isComposingRef.current
    if (isComposing) return

    // Slash popover nav takes over keys while open.
    if (slash.mode.kind === "slash") {
      if (e.key === "Enter" && !e.shiftKey && isBareGoalSlashCommandInput(input)) {
        e.preventDefault()
        const form = (e.currentTarget as HTMLTextAreaElement).form
        form?.requestSubmit()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        slash.moveSelection(1)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        slash.moveSelection(-1)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setInput("")
        return
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const command = slash.mode.commands[slash.selectedIdx]
        if (command) {
          e.preventDefault()
          applySlashCommand(command)
          return
        }

        const skillIdx = slash.selectedIdx - slash.mode.commands.length
        const s = slash.mode.skills[skillIdx]
        if (s) {
          e.preventDefault()
          applySkillSelection(s)
          return
        }
        // No match: swallow. Letting "/xxx" submit as literal text is almost
        // never what the user meant when they opened the picker.
        e.preventDefault()
        return
      }
    }

    if (atFileMentions.mode.kind === "at-file") {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        atFileMentions.moveSelection(1)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        atFileMentions.moveSelection(-1)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        atFileMentions.dismiss()
        return
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const selected = atFileMentions.mode.suggestions[atFileMentions.selectedIdx]
        if (selected) {
          e.preventDefault()
          applyAtFileMention(selected)
          return
        }
      }
    }

    // Backspace at start of empty input removes the selected skill/browser chip.
    // Skip while IME is composing — there Backspace edits the pinyin buffer,
    // not the textarea, and the user doesn't intend to drop the chip.
    if (e.key === "Backspace" && !isComposing && input.length === 0 && mentionedFiles.length > 0) {
      e.preventDefault()
      setMentionedFiles((prev) => prev.slice(0, -1))
      return
    }

    if (e.key === "Backspace" && !isComposing && selectedSkill && input.length === 0) {
      e.preventDefault()
      setSelectedSkill(null)
      return
    }

    if (
      shouldRemoveBuiltinBrowserChipWithBackspace({
        browserSelected: selectedBuiltinBrowser,
        inputLength: input.length,
        isComposing,
        key: e.key
      })
    ) {
      e.preventDefault()
      setSelectedBuiltinBrowser(false)
      return
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const handleInsertNewline = useCallback((): void => {
    if (effectiveInputDisabled) return
    insertTextAtCursor("\n")
  }, [effectiveInputDisabled, insertTextAtCursor])

  // Auto-resize textarea based on content
  const adjustTextareaHeight = useCallback((): void => {
    const textarea = inputRef.current
    if (textarea) {
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [])

  useEffect(() => {
    if (textareaResizeFrameRef.current !== null) {
      cancelAnimationFrame(textareaResizeFrameRef.current)
    }
    textareaResizeFrameRef.current = requestAnimationFrame(() => {
      textareaResizeFrameRef.current = null
      adjustTextareaHeight()
    })
    return () => {
      if (textareaResizeFrameRef.current !== null) {
        cancelAnimationFrame(textareaResizeFrameRef.current)
        textareaResizeFrameRef.current = null
      }
    }
  }, [adjustTextareaHeight, input])

  const handleCancel = async (e): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()

    if (scheduledTaskLoading && scheduledTaskId) {
      try {
        await window.api.scheduledTasks.cancel(scheduledTaskId)
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel scheduled task:", err)
      }
      // 取消是发信号等收敛;若主进程实际无任务在跑(渲染态因丢 done 冻结),
      // 上面的调用是空操作且不会再有事件回来解锁——立即用权威态校正自愈。
      threadContext.reconcileScheduledRunStates()
    } else if (scheduledTaskLoading && threadId === "heartbeat") {
      try {
        await window.api.heartbeat.cancel()
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel heartbeat:", err)
      }
      threadContext.reconcileScheduledRunStates()
    } else if (scheduledTaskLoading) {
      // Passive remote streams are owned by IM. Desktop must not cross-source
      // cancel them; use /停止 from the originating conversation instead.
      return
    } else {
      // Match Claude Code coordinator semantics: the main stop button stops the
      // foreground turn only. Durable background workers are stopped explicitly
      // via the separate background-worker stop control.
      threadContext.suppressCoordinatorNotificationAutoRun(threadId)
      // Stop must actually stop: don't let a queued draft immediately fire a new
      // run right behind the one being cancelled. Lives in thread-context (not a
      // local ref) because TabbedPanel unmounts ChatContainer entirely when the
      // user switches to a file tab — a local ref would silently reset to false
      // the moment they glance at an open file and back, undoing the suppression.
      setQueueAutoDrainSuppressed(true)
      try {
        await Promise.all([stream?.stop(), window.api.agent.cancel(threadId)])
      } finally {
        if (goalUi.goal) {
          void refreshGoalUi({ includeEvents: true })
        }
      }
    }
  }

  const handleCancelBackgroundWorkers = async (): Promise<void> => {
    try {
      await window.api.agent.cancel(threadId, { cancelWorkers: true })
    } catch (err) {
      console.error("[ChatContainer] Failed to cancel coordinator workers:", err)
    }
  }

  useEffect(() => {
    void loadSkills()
    return () => {
      skillsLoadRequestIdRef.current += 1
      void window.api.harnessBoard.cancelCatalogRequests("chat-binding").catch(() => undefined)
    }
  }, [loadSkills, pluginVersion, harnessFeatureBinding?.projectId, surface])

  // One application-lifetime bridge translates skills:changed into one cache
  // revision. ChatContainer and RightPanel then share the same refresh promise.
  useEffect(() => {
    const unsubscribe = subscribeSkillCatalogInvalidation(() => {
      void loadSkills()
    })
    ensureSkillsChangedInvalidationSource((listener) => window.api.skills.onChanged(listener))
    ensureDisabledSkillsChangedInvalidationSource((listener) =>
      window.api.hooks.onChanged(listener)
    )
    return unsubscribe
  }, [loadSkills])

  // ── Skill creation human-confirmation listener ──────────
  useEffect(() => {
    console.log("[ChatContainer] Registering skill confirm listener")
    const cleanup = window.api.skillEvolution.onConfirmRequest((req) => {
      // Ignore events that belong to a different thread (stale background run)
      if (req.threadId && req.threadId !== useAppStore.getState().currentThreadId) return
      console.log("[ChatContainer] Received skill confirm request:", req.requestId, req.name)
      setSkillConfirmRequest(req)
      // Mark generation as done — RightPanel will switch the card to "completed"
      setSkillGenerationPhase("done")
    })
    return cleanup
  }, [setSkillGenerationPhase])

  const handleSkillApprove = useCallback((requestId: string, content: string): void => {
    console.log("[ChatContainer] Approving skill confirm request:", requestId)
    void window.api.skillEvolution.confirmResponse(requestId, true, content)
    setSkillConfirmRequest(null)
  }, [])

  const handleSkillReject = useCallback((requestId: string): void => {
    console.log("[ChatContainer] Rejecting skill confirm request:", requestId)
    void window.api.skillEvolution.confirmResponse(requestId, false)
    setSkillConfirmRequest(null)
  }, [])

  // ── Skill intent banner listener (Mode A: "Want to save as skill?") ──
  useEffect(() => {
    console.log("[ChatContainer] Registering skill intent listener")
    const cleanup = window.api.skillEvolution.onIntentRequest((req) => {
      // Ignore events that belong to a different thread (stale background run)
      if (req.threadId && req.threadId !== useAppStore.getState().currentThreadId) return
      console.log(
        "[ChatContainer] Received skill intent request:",
        req.requestId,
        req.mode,
        req.turnCount,
        req.toolCallCount
      )
      setSkillIntentRequest(req)
    })
    return cleanup
  }, [])

  const handleSkillIntentYes = useCallback((): void => {
    if (!skillIntentRequest) return
    console.log("[ChatContainer] Accepting skill intent request:", skillIntentRequest.requestId)
    // Cache the proposal context so the user can retry if generation hangs or fails
    setSkillRetryContext({
      context: skillIntentRequest.context,
      intentMode: skillIntentRequest.mode
    })
    setSkillGenerationPhase("generating")
    setSkillIntentRequest(null)
    void window.api.skillEvolution.intentResponse(skillIntentRequest.requestId, true)
  }, [skillIntentRequest, setSkillGenerationPhase, setSkillRetryContext])

  const handleSkillIntentNo = useCallback((): void => {
    if (!skillIntentRequest) return
    console.log("[ChatContainer] Skipping skill intent request:", skillIntentRequest.requestId)
    setSkillIntentRequest(null)
    void window.api.skillEvolution.intentResponse(skillIntentRequest.requestId, false)
  }, [skillIntentRequest])

  // ── Skill generation streaming progress — update global store so RightPanel shows progress ──
  useEffect(() => {
    const cleanup = window.api.skillEvolution.onGenerating((evt) => {
      // Ignore events that belong to a different thread (stale background run)
      if (evt.threadId && evt.threadId !== useAppStore.getState().currentThreadId) return
      if (evt.phase === "start") {
        setSkillGenerationPhase("generating")
      } else if (evt.phase === "token") {
        appendSkillGenerationToken(evt.text)
      } else if (evt.phase === "done") {
        // confirmRequest will arrive shortly — keep phase as "generating" until then
      } else if (evt.phase === "error") {
        setSkillGenerationPhase("error", evt.text || "生成失败")
      }
    })
    return cleanup
  }, [setSkillGenerationPhase, appendSkillGenerationToken])
  // ────────────────────────────────────────────────────────

  const getSkillId = useCallback((skill: SkillMetadata): string => {
    const idSegments = getSkillMetadataId(skill).split("/").filter(Boolean)
    const fromId = idSegments.length > 0 ? idSegments[idSegments.length - 1] : undefined
    const fromPath = skill?.path?.replace(/\\/g, "/").split("/").slice(-2, -1)[0]
    return (fromId || fromPath || skill.name || "").toLowerCase()
  }, [])

  const buildSkillPrompt = useCallback(
    (skill: SkillMetadata): string => {
      const skillId = getSkillId(skill)

      // For custom skills, use the skill's description if available
      if (skill.source === "user") {
        const skillName = skill.name || skillId
        return [
          `请使用 ${skillName} 技能帮我处理相关任务。`,
          "需求说明：<请补充>",
          "输出：结果、关键改动、验证方式。"
        ].join("\n")
      }

      // Existing prompt mapping for built-in skills
      const promptMap: Record<string, string> = {
        "algorithmic-art": [
          "请帮我生成一套算法艺术方案。",
          "主题与风格：<请补充>",
          "输出：创意说明、实现步骤、可直接运行的代码。"
        ].join("\n"),
        "brand-guidelines": [
          "请按品牌规范统一这份内容的视觉风格。",
          "品牌调性：<请补充>",
          "输出：改造方案、关键规范、最终可用结果。"
        ].join("\n"),
        "canvas-design": [
          "请设计一张视觉海报。",
          "场景与受众：<请补充>",
          "输出：版式思路、配色建议、成稿方案。"
        ].join("\n"),
        docx: [
          "请帮我处理 Word 文档。",
          "具体需求：<新建/修改/排版/提取内容>",
          "输出：处理结果与修改要点。"
        ].join("\n"),
        "doc-coauthoring": [
          "请和我一起协作完善这份文档。",
          "文档类型与目标：<请补充>",
          "输出：结构优化建议和可直接使用的正文。"
        ].join("\n"),
        "frontend-design": [
          "请帮我设计并实现前端界面。",
          "页面目标与风格：<请补充>",
          "输出：页面方案、关键代码、验证方式。"
        ].join("\n"),
        "internal-comms": [
          "请帮我撰写内部沟通稿。",
          "沟通对象与目的：<请补充>",
          "输出：清晰版本正文与可选精简版。"
        ].join("\n"),
        "mcp-builder": [
          "请帮我搭建一个 MCP 服务。",
          "目标能力与外部系统：<请补充>",
          "输出：实现步骤、核心代码、联调说明。"
        ].join("\n"),
        pdf: [
          "请帮我处理 PDF 文档。",
          "具体操作：<提取/合并/拆分/转换/校对>",
          "输出：处理结果与关键说明。"
        ].join("\n"),
        pptx: [
          "请帮我制作或优化演示文稿。",
          "主题与页数预期：<请补充>",
          "输出：大纲、页面建议、可交付稿件。"
        ].join("\n"),
        "skill-creator": [
          "请使用skill-creator技能帮我创建一个新技能包。",
          "技能用途与触发场景：<请补充>",
          "输出：技能结构、说明文档、示例。"
        ].join("\n"),
        "slack-gif-creator": [
          "请帮我制作一个用于 Slack 的动图。",
          "内容主题：<请补充>",
          "输出：制作方案、参数建议、成品要求。"
        ].join("\n"),
        "theme-factory": [
          "请帮我应用统一主题风格。",
          "应用对象：<文档/页面/演示稿>",
          "输出：主题方案与落地结果。"
        ].join("\n"),
        "web-app-testing": [
          "请帮我测试这个 Web 应用。",
          "重点流程：<请补充>",
          "输出：测试步骤、问题清单、修复建议。"
        ].join("\n"),
        "webapp-testing": [
          "请帮我测试这个 Web 应用。",
          "重点流程：<请补充>",
          "输出：测试步骤、问题清单、修复建议。"
        ].join("\n"),
        "security-review": [
          "请使用 security-review 技能对当前分支变更做安全审查。",
          "要求：仅输出高置信度（>=8/10）的中高危漏洞，避免误报。",
          "输出：按 漏洞标题/严重级别/影响文件与位置/利用路径/修复建议 的结构化报告。"
        ].join("\n"),
        "web-artifacts-builder": [
          "请帮我构建一个交互页面。",
          "功能目标：<请补充>",
          "输出：页面结构、实现代码、使用说明。"
        ].join("\n"),
        xlsx: [
          "请帮我处理表格数据。",
          "任务内容：<清洗/计算/格式化/分析>",
          "输出：处理结果、公式或规则说明。"
        ].join("\n"),
        "code-review-expert": [
          "请使用 code-review-expert 技能对当前 git 变更做结构化代码审查。",
          "审查范围：SOLID 原则、安全漏洞、性能问题、错误处理、边界条件。",
          "输出：按 P0-P3 严重级别分类的结构化报告，完成后询问是否修复。"
        ].join("\n"),
        "vercel-react-best-practices": [
          "请基于 React 最佳实践审查/优化当前组件代码。",
          "关注点：渲染性能、组合模式、状态管理、异步处理、打包优化。",
          "输出：问题列表、优化建议、改造代码。"
        ].join("\n"),
        "audit-website": [
          "请对以下网站做全面安全审计。",
          "目标网址：<请补充>",
          "输出：漏洞清单、风险等级、修复建议。"
        ].join("\n"),
        "supabase-postgres-best-practices": [
          "请基于 PostgreSQL 最佳实践审查当前数据库设计或查询。",
          "关注点：索引优化、RLS 安全策略、连接池、N+1 查询、分区策略。",
          "输出：问题诊断、优化建议、改进 SQL。"
        ].join("\n"),
        "typescript-advanced-types": [
          "请帮我优化 TypeScript 类型定义，运用高级类型技巧。",
          "目标文件或模块：<请补充>",
          "输出：类型改进方案、重构代码、类型安全提升说明。"
        ].join("\n"),
        "api-design-principles": [
          "请基于 API 设计原则审查/设计当前接口。",
          "API 类型：<REST / GraphQL>",
          "输出：设计规范建议、接口定义、示例代码。"
        ].join("\n"),
        "architecture-patterns": [
          "请基于架构模式对当前项目结构提出改进方案。",
          "关注点：Clean Architecture、六边形架构、DDD 领域驱动设计。",
          "输出：架构诊断、重构方案、目录结构建议。"
        ].join("\n"),
        "error-handling-patterns": [
          "请审查当前代码的错误处理策略并提出改进。",
          "关注点：异常层次、重试机制、熔断器、优雅降级。",
          "输出：问题清单、模式建议、改进代码。"
        ].join("\n"),
        "planning-with-files": [
          "请使用文件驱动规划方式管理当前复杂任务。",
          "任务目标：<请补充>",
          "输出：task_plan.md、findings.md、progress.md 三份规划文档。"
        ].join("\n"),
        "scheduler-assistant": [
          "请帮我设置一个定时提醒或周期任务。",
          '需求：<请补充，如"5分钟后提醒我喝水"、"每天早上9点提醒我看邮件">',
          "输出：任务创建结果、下次执行时间。"
        ].join("\n")
      }
      return (
        promptMap[skillId] ||
        [
          "请帮我处理该技能相关任务。",
          "需求说明：<请补充>",
          "输出：结果、关键改动、验证方式。"
        ].join("\n")
      )
    },
    [getSkillId]
  )

  const handleOpenMarketBySecondaryCategory = useCallback(
    (secondaryCategory: string): void => {
      useAppStore.setState({
        marketInitialSkillCategory: secondaryCategory,
        marketInitialSkillFilters: ["featured", "certified"],
        marketInitialSkillSearchQuery: null,
        marketInitialSkillDetailName: null
      })
      setShowCustomizeView(true, "market")
    },
    [setShowCustomizeView]
  )

  const handleOpenMarketBySkill = useCallback(
    (skillName: string): void => {
      useAppStore.setState({
        marketInitialSkillCategory: null,
        marketInitialSkillFilters: null,
        marketInitialSkillSearchQuery: null,
        marketInitialSkillDetailName: skillName
      })
      setShowCustomizeView(true, "market")
    },
    [setShowCustomizeView]
  )

  const handleOpenOrganizationSkillMarket = useCallback(
    (skillName?: string): void => {
      useAppStore.setState({
        marketInitialTab: "orgSkill",
        marketInitialSkillCategory: null,
        marketInitialSkillFilters: null,
        marketInitialSkillSearchQuery: null,
        marketInitialSkillDetailName: skillName || null
      })
      setShowCustomizeView(true, "market")
    },
    [setShowCustomizeView]
  )

  const handleUseSkillPrompt = useCallback(
    (skill: SkillMetadata, customPrompt?: string): void => {
      const prompt = buildSkillPrompt(skill)
      const nextInput = customPrompt || prompt
      setInput(nextInput)
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = nextInput.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [buildSkillPrompt, setInput]
  )

  const welcomePane = useMemo(() => {
    if (displayMessages.length !== 0 || isLoading || historyLoading) return null

    return (
      <div className="pt-6">
        {(shouldShowHarnessDialogTips || shouldShowNextActionDialogTips) && harnessDialogTips ? (
          <DialogTipsMarkdown content={harnessDialogTips} />
        ) : !shouldShowWelcomeHeadline || harnessFeatureBinding ? null : (
          <RotatingHeadline />
        )}
      </div>
    )
  }, [
    displayMessages.length,
    harnessDialogTips,
    harnessFeatureBinding,
    historyLoading,
    isLoading,
    shouldShowHarnessDialogTips,
    shouldShowNextActionDialogTips,
    shouldShowWelcomeHeadline
  ])

  const extractMessageText = useCallback((content: Message["content"]): string => {
    return getMessageText(content)
  }, [])

  const handleEditUserMessage = useCallback(
    (message: Message): void => {
      const original = extractMessageText(message.content)
      // Strip the trailing <CMBDEVCLAW-SKILL-USE-V1> block first so the raw tag
      // doesn't leak into the composer. Restore the chip by looking the skill
      // up in the current skills list — if the skill was removed since that
      // message was sent, drop the chip and surface a notice; sending the raw
      // name as text is never useful.
      const skillParsed = parseSkillUseBlock(original)
      const bodyAfterSkill = skillParsed ? skillParsed.rest : original
      const browserParsed = parseBuiltinBrowserEditDraft(bodyAfterSkill)
      const bodyAfterBrowser = browserParsed.visibleText
      let missingSkillName: string | null = null
      // Only touch selectedSkill when the edited message itself carried a skill
      // ref. Editing an unrelated old message must NOT silently wipe whatever
      // skill the user has currently picked in the composer — that's user
      // intent for the next send, unrelated to the message being edited.
      if (skillParsed) {
        // Match by path first, fall back to name. Path is the more stable
        // identifier when a plugin and a custom skill happen to share a name —
        // without it we'd silently restore the chip to "the wrong foo".
        const hit =
          skills.find((s) => s.path === skillParsed.skillPath) ??
          skills.find((s) => s.name === skillParsed.skillName)
        if (hit) {
          setSelectedSkill(hit)
        } else {
          setSelectedSkill(null)
          missingSkillName = skillParsed.skillName
        }
      }
      if (browserParsed.browserSelected) {
        setSelectedSkill(null)
        setSelectedBuiltinBrowser(true)
      }
      const withoutAttachmentPreview = bodyAfterBrowser
        .replace(/^(?:📎[^\n]*\n)+(?:\n)?/u, "")
        .trim()
      // For attachment-only messages (no real text), `withoutAttachmentPreview`
      // is empty. Fallback to "" rather than `bodyAfterSkill` — refilling the
      // 📎 line previews into the composer would have them re-sent as literal
      // text on the next submit (the user is expected to re-add attachments).
      const nextInput = withoutAttachmentPreview
      setInput(nextInput)

      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = nextInput.length
        textarea.setSelectionRange(cursor, cursor)
      })
      if (missingSkillName) {
        toast.warning(`原消息使用的技能「${missingSkillName}」当前不可用，已从草稿中移除`)
      } else {
        toast.success("已填充到输入框，编辑后可重新发送")
      }
    },
    [extractMessageText, setInput, setSelectedBuiltinBrowser, skills, setSelectedSkill]
  )

  const handleSetGoalFromMessage = useCallback(
    (text: string): void => {
      const body = text.trim()
      if (!body) {
        toast.error("这条消息没有可设置为 Goal 的内容")
        return
      }
      const nextInput = /^\/goal(?:\s|$)/i.test(body) ? body : `/goal ${body}`
      setInput(nextInput)
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(nextInput.length, nextInput.length)
      })
      toast.success("已填入 Goal 草稿，确认后发送")
    },
    [setInput]
  )

  const handleForkFromMessage = useCallback(
    async (message: Message): Promise<void> => {
      if (isLoading || forkingMessageId) return
      const sourceThreadId = threadId
      const requestId = messageForkRequestIdRef.current + 1
      messageForkRequestIdRef.current = requestId
      setForkingMessageId(message.id)
      try {
        const checkpoint = await window.api.threads.resolveForkCheckpointForMessage({
          threadId: sourceThreadId,
          messageId: message.id,
          message: {
            id: message.id,
            role: message.role,
            content: message.content,
            tool_calls: message.tool_calls
          }
        })
        if (
          messageForkRequestIdRef.current !== requestId ||
          currentThreadIdRef.current !== sourceThreadId
        ) {
          return
        }
        if (!checkpoint) {
          toast.error(getMessageForkCheckpointHint())
          return
        }
        setForkDestinationMode("local")
        setForkWorkspacePath(null)
        setMessageForkTarget({
          sourceThreadId,
          sourceWorkspacePath: currentForkWorkspacePath,
          message,
          checkpoint
        })
      } catch (error) {
        if (
          messageForkRequestIdRef.current !== requestId ||
          currentThreadIdRef.current !== sourceThreadId
        ) {
          return
        }
        toast.error(
          getMessageForkCheckpointHint(
            error instanceof Error ? error.message : "读取 fork checkpoint 失败"
          )
        )
      } finally {
        if (messageForkRequestIdRef.current === requestId) {
          setForkingMessageId(null)
        }
      }
    },
    [currentForkWorkspacePath, forkingMessageId, isLoading, threadId]
  )

  const handleSelectForkWorkspace = useCallback(async (): Promise<string | null> => {
    if (selectingForkWorkspace) return forkWorkspacePath
    setSelectingForkWorkspace(true)
    try {
      const path = await window.api.workspace.select()
      if (path) {
        setForkDestinationMode("workspace")
        setForkWorkspacePath(path)
      }
      return path
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择工作区失败")
      return null
    } finally {
      setSelectingForkWorkspace(false)
    }
  }, [forkWorkspacePath, selectingForkWorkspace])

  const resetMessageForkDialog = useCallback((): void => {
    messageForkRequestIdRef.current += 1
    setMessageForkTarget(null)
    setForkDestinationMode("local")
    setForkWorkspacePath(null)
    setSelectingForkWorkspace(false)
  }, [])

  useEffect(() => {
    messageForkRequestIdRef.current += 1
    setMessageForkTarget(null)
    setForkingMessageId(null)
    setForkDestinationMode("local")
    setForkWorkspacePath(null)
    setSelectingForkWorkspace(false)
  }, [threadId])

  const handleConfirmMessageFork = useCallback(async (): Promise<void> => {
    if (!messageForkTarget || forkingMessageId) return
    if (messageForkTarget.sourceThreadId !== currentThreadIdRef.current) {
      toast.error("当前会话已切换，请回到目标会话后重新点击 fork。")
      resetMessageForkDialog()
      return
    }

    let selectedWorkspacePath = forkWorkspacePath
    if (forkDestinationMode === "workspace" && !selectedWorkspacePath) {
      selectedWorkspacePath = await handleSelectForkWorkspace()
      if (!selectedWorkspacePath) return
    }

    const overrides: ThreadForkOverrides | undefined =
      forkDestinationMode === "workspace" ? { workspacePath: selectedWorkspacePath } : undefined

    const resolvedMessageId =
      messageForkTarget.checkpoint.messageForkMode === "checkpoint"
        ? undefined
        : (messageForkTarget.checkpoint.resolvedMessageId ?? messageForkTarget.message.id)
    const preserveHarnessView = surface !== "default"
    setForkingMessageId(messageForkTarget.message.id)
    try {
      const forkedThread = await forkThread(
        {
          sourceThreadId: messageForkTarget.sourceThreadId,
          checkpointId: messageForkTarget.checkpoint.checkpointId,
          ...(resolvedMessageId ? { messageId: resolvedMessageId } : {}),
          overrides
        },
        preserveHarnessView ? { preserveView: true } : undefined
      )
      if (preserveHarnessView) {
        onHarnessSessionCreated?.(forkedThread.thread_id)
      }
      toast.success("已从这条消息创建新会话")
      resetMessageForkDialog()
    } catch (error) {
      toast.error(
        getMessageForkCheckpointHint(error instanceof Error ? error.message : "Fork 会话失败")
      )
    } finally {
      setForkingMessageId(null)
    }
  }, [
    forkDestinationMode,
    forkThread,
    forkWorkspacePath,
    forkingMessageId,
    handleSelectForkWorkspace,
    messageForkTarget,
    onHarnessSessionCreated,
    resetMessageForkDialog,
    surface
  ])

  const handleEditGoal = useCallback((): void => {
    const objective = goalUi.goal?.objective?.trim()
    if (!objective) return
    const nextInput = `/goal ${objective}`
    setInput(nextInput)
    setGoalDetailsOpen(false)
    requestAnimationFrame(() => {
      const textarea = inputRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextInput.length, nextInput.length)
    })
    toast.success("已填入当前 Goal，可编辑后重新设置")
  }, [goalUi.goal?.objective, setInput])
  // Inlined as JSX (not components) to avoid React remounting on every parent render —
  // declaring a component inside the parent creates a new function reference each render,
  // which causes children to lose focus/animation state.
  const skillIntentBanner = !skillIntentRequest ? null : (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-violet-500/10 border-b border-violet-500/20 text-xs">
      <Sparkles className="size-3.5 text-violet-500 shrink-0" />
      <div className="flex-1 text-violet-700 dark:text-violet-300 leading-snug">
        {skillIntentRequest.mode === "mode_b_llm" ? (
          <>
            <div>
              大模型判断这段流程具有复用价值，建议将它沉淀为可复用的技能。本次累计{" "}
              <strong>{skillIntentRequest.turnCount}</strong> 轮对话、{" "}
              <strong>{skillIntentRequest.toolCallCount}</strong> 次工具调用。
            </div>
            {skillIntentRequest.recommendationReason ? (
              <div className="mt-0.5 text-[11px] text-violet-600/80 dark:text-violet-200/80">
                推荐依据：{skillIntentRequest.recommendationReason}
              </div>
            ) : null}
          </>
        ) : (
          <div>
            本次累计 <strong>{skillIntentRequest.turnCount}</strong> 轮对话、{" "}
            <strong>{skillIntentRequest.toolCallCount}</strong>{" "}
            次工具调用，是否将它沉淀为可复用的技能？
          </div>
        )}
      </div>
      <button
        className="shrink-0 rounded px-2.5 py-1 bg-violet-500 text-white hover:bg-violet-600 transition-colors font-medium"
        onClick={handleSkillIntentYes}
      >
        创建技能
      </button>
      <button
        className="shrink-0 rounded px-2.5 py-1 text-muted-foreground hover:text-foreground transition-colors"
        onClick={handleSkillIntentNo}
      >
        跳过
      </button>
    </div>
  )

  const nuxDialog = !showNux ? null : (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
      <div className="bg-background border border-border rounded-xl shadow-2xl p-6 max-w-md w-full mx-4 space-y-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          <h2 className="text-lg font-bold">设置 Agent 沙箱环境</h2>
        </div>

        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-700 dark:text-amber-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <span>当前默认关闭沙箱。需要隔离执行时，可在设置中手动启用沙箱模式。</span>
        </div>

        {nuxLoading ? (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="relative size-14">
              <div className="absolute inset-0 size-14 rounded-full border-4 border-primary/15" />
              <div className="absolute inset-0 size-14 rounded-full border-4 border-primary border-t-transparent animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <ShieldCheck className="size-5 text-primary" />
              </div>
            </div>
            <div className="text-center space-y-1.5">
              <div className="text-sm font-medium transition-all duration-500">
                {nuxLoadingMessage}
              </div>
              <div className="text-xs text-muted-foreground">
                首次配置可能需要 1&ndash;3 分钟，请勿关闭窗口
              </div>
            </div>
            <div className="flex gap-1.5">
              {NUX_LOADING_STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`size-1.5 rounded-full transition-all duration-500 ${
                    i <= nuxLoadingStep ? "bg-primary" : "bg-primary/20"
                  }`}
                />
              ))}
            </div>
          </div>
        ) : null}

        {nuxError ? (
          <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400 space-y-2">
            <p className="font-medium">强隔离沙箱配置失败</p>
            <p className="text-xs opacity-80">{nuxError}</p>
            <p className="text-xs">可重试或选择受限沙箱模式继续使用。</p>
            <div className="flex gap-2 mt-1">
              <button
                className="px-3 py-1.5 text-xs bg-button text-button-foreground rounded-md hover:bg-button/90 transition-colors"
                onClick={() => {
                  setNuxError(null)
                  setNuxLoading(true)
                  window.api.sandbox
                    .completeNux("elevated")
                    .then(() => setShowNux(false))
                    .catch(() => {
                      setShowNux(false)
                    })
                }}
              >
                重试强隔离模式
              </button>
              <button
                className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors"
                onClick={() => {
                  window.api.sandbox
                    .completeNux("unelevated")
                    .then(() => setShowNux(false))
                    .catch(() => setShowNux(false))
                }}
              >
                使用受限沙箱模式
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )

  const isMessageForkBusy =
    Boolean(messageForkTarget && forkingMessageId === messageForkTarget.message.id) ||
    selectingForkWorkspace
  const messageForkPreview = messageForkTarget
    ? getForkMessagePreview(messageForkTarget.message)
    : ""
  const messageForkUsesCheckpointBoundary =
    messageForkTarget?.checkpoint.messageForkMode === "checkpoint"
  const messageForkSourceWorkspacePath =
    messageForkTarget?.sourceWorkspacePath ?? currentForkWorkspacePath
  const currentForkWorkspaceLabel = getForkWorkspaceLabel(messageForkSourceWorkspacePath)
  const selectedForkWorkspaceLabel = getForkWorkspaceLabel(forkWorkspacePath)
  const remoteLifecycleState = remoteThread?.metadata?.remoteState
  const remoteThreadStatus = pendingApproval
    ? "等待桌面审批"
    : pendingUserInput
      ? "等待桌面补充输入"
      : remoteLifecycleState === "historical"
        ? "接管前历史"
        : remoteLifecycleState === "waiting_desktop"
          ? "等待桌面处理"
          : remoteLifecycleState === "suspended"
            ? "绑定已暂停"
            : remoteLifecycleState === "outcome_unknown"
              ? "执行结果未知"
              : remoteLifecycleState === "rejected"
                ? "远程能力不支持"
                : remoteLifecycleState === "failed"
                  ? "执行失败"
                  : isLoading
                    ? "任务执行中"
                    : remoteThread?.status === "error"
                      ? "执行失败"
                      : remoteThread?.status === "interrupted"
                        ? "已中止"
                        : "空闲"
  const interruptionNotice = hookInterruption
    ? interruptionNoticeCopy(hookInterruption.event, hookInterruption.action)
    : null
  const remoteThreadTipLabel = remoteThreadInfo?.kind === "inbox" ? "远程收件箱" : "远程会话"
  const handleDismissRemoteThreadTip = useCallback(() => {
    setDismissedRemoteTipThreadIds((current) => {
      const next = new Set(current)
      next.add(threadId)
      persistRemoteThreadTipDismissals(next)
      return next
    })
  }, [threadId])
  const chatMessageListFooter = (
    <div
      className="space-y-4 pt-4 pb-4"
      style={userInputScrollPadding ? { paddingBottom: `${userInputScrollPadding}px` } : undefined}
    >
      {contextCompaction && <ContextCompactionCard compaction={contextCompaction} />}
      {modelRetry && (
        <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-status-warning-foreground">
          <span className="mt-0.5 inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-status-warning border-t-transparent" />
          <div className="min-w-0 flex-1">
            <span>
              模型暂时不可用（{modelRetry.reason}），正在重试 {modelRetry.attempt}/
              {modelRetry.maxRetries}
              {modelRetry.delayMs > 0 && <>（等待 {Math.round(modelRetry.delayMs / 100) / 10}s）</>}
              …
            </span>
          </div>
        </div>
      )}
      {isLoading && (
        <div className="space-y-3">
          {contextCompaction?.phase !== "started" && (
            <div className="flex items-center gap-2 text-sm">
              <div className="rainbow-spinner" />
              <span
                className="thinking-shimmer-text"
                data-text={THINKING_MESSAGES[thinkingMessageIndex]}
              >
                {THINKING_MESSAGES[thinkingMessageIndex]}
              </span>
              {streamData.isLoading && (
                <ProcessingDuration key={threadId} startTime={activeTurnStartTime} text="已处理" />
              )}
            </div>
          )}
          {todos.length > 0 && <ChatTodos todos={todos} />}
        </div>
      )}
      {workflowRun ? (
        <WorkflowRunPanel threadId={threadId} run={workflowRun} />
      ) : isWorkflowModeMetadata(currentThread?.metadata) ? (
        <WorkflowHistoryButton threadId={threadId} />
      ) : null}
      {hookInterruption && !isLoading && (
        <div className="flex items-start gap-3 rounded-md border border-status-warning/30 bg-status-warning/10 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-status-warning-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-status-warning-foreground">
              {interruptionNotice?.title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-status-warning-foreground/80">
              <span className="rounded border border-status-warning/40 px-1.5 py-0.5 font-mono">
                {hookInterruption.event}
              </span>
              <span title={HOOK_TIME_ZONE_LABEL}>
                {formatHookClockTime(hookInterruption.timestamp) ?? "时间无效"}
              </span>
            </div>
            <div className="mt-2 break-words text-sm text-status-warning-foreground">
              {hookInterruption.reason}
            </div>
            {hookInterruption.systemMessage && (
              <div className="mt-2 break-words text-xs text-status-warning-foreground/80">
                {hookInterruption.systemMessage}
              </div>
            )}
            <div className="mt-2 text-xs text-muted-foreground">
              {interruptionNotice?.explanation}
            </div>
          </div>
          <button
            onClick={clearHookInterruption}
            className="shrink-0 rounded p-1 transition-colors hover:bg-status-warning/20"
            aria-label="Dismiss hook notice"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>
      )}
      {threadError && !isLoading && (
        <ChatErrorCard error={threadError} detail={errorDetail} onDismiss={handleDismissError} />
      )}
    </div>
  )

  return (
    <div ref={chatRootRef} className="relative flex flex-1 flex-col min-h-0 overflow-hidden">
      {remoteThreadInfo && !dismissedRemoteTipThreadIds.has(threadId) ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-blue-500/20 bg-blue-500/5 px-4 py-2 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0 text-blue-500" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-700 dark:text-blue-300">
                {remoteThreadInfo.kind === "inbox" ? "远程收件箱" : "远程会话"}
              </span>
              {remoteThreadInfo.kind === "feature" && remoteThreadInfo.featureLabel ? (
                <span className="font-medium">{remoteThreadInfo.featureLabel}</span>
              ) : null}
              <span className="text-muted-foreground">{remoteThreadStatus}</span>
            </div>
            <p className="text-muted-foreground">
              {remoteThreadInfo.kind === "inbox"
                ? remoteThreadInfo.historical
                  ? "此 Thread 已停用，仅保留历史，不会接收新消息。"
                  : "桌面仅用于查看历史和运行状态；请从招乎继续聊天。"
                : remoteThreadInfo.historical
                  ? "此远程会话已停用，仅保留历史；请重新绑定。"
                  : isLoading
                    ? "当前任务占用远程运行租约，结束后可在桌面继续。"
                    : "可在桌面继续处理。"}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissRemoteThreadTip}
            className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-blue-500/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
            aria-label={`关闭${remoteThreadTipLabel}提示`}
            title="关闭提示"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {/* In-session keyword search (Ctrl/Cmd+F) */}
      <ChatSearchOverlay
        open={searchOpen}
        onClose={closeSearch}
        getViewport={getViewport}
        getSearchCorpus={getSearchCorpus}
        onRevealMessage={revealMessage}
        searchDurableMessages={searchDurableMessages}
        onRevealDurableMessage={revealDurableMessage}
        onCancelDurableReveal={invalidateDurableMessageReveal}
        recomputeKey={searchRecomputeKey}
      />

      {/* Skill creation confirmation dialog */}
      <SkillCreateConfirmDialog
        request={skillConfirmRequest}
        onApprove={handleSkillApprove}
        onReject={handleSkillReject}
      />

      <Dialog
        open={!!messageForkTarget}
        onOpenChange={(open) => {
          if (!open && !isMessageForkBusy) resetMessageForkDialog()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">
              {messageForkUsesCheckpointBoundary ? "从 checkpoint fork" : "Fork 这条消息"}
            </DialogTitle>
            <DialogDescription>
              {messageForkUsesCheckpointBoundary
                ? "创建一个新会话，历史保留到最近的稳定 checkpoint。"
                : "创建一个新会话，历史只保留到这条消息所在节点。"}
            </DialogDescription>
          </DialogHeader>
          {messageForkTarget ? (
            <div className="space-y-4">
              <div className="rounded-sm border border-border bg-muted/25 px-3 py-2">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    checkpoint {formatForkCheckpointTime(messageForkTarget.checkpoint.createdAt)}
                  </span>
                  <span>{messageForkTarget.checkpoint.messageCount} 条消息</span>
                </div>
                <div className="line-clamp-3 text-sm text-foreground">{messageForkPreview}</div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={isMessageForkBusy}
                  onClick={() => setForkDestinationMode("local")}
                  className={cn(
                    "rounded-sm border px-3 py-2 text-left transition-colors",
                    forkDestinationMode === "local"
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <div className="text-sm font-medium">派生到本地</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {currentForkWorkspaceLabel}
                  </div>
                </button>
                <button
                  type="button"
                  disabled={isMessageForkBusy}
                  onClick={() => setForkDestinationMode("workspace")}
                  className={cn(
                    "rounded-sm border px-3 py-2 text-left transition-colors",
                    forkDestinationMode === "workspace"
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <div className="text-sm font-medium">派生到其他工作区</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {forkWorkspacePath ? selectedForkWorkspaceLabel : "选择一个本地工作区路径"}
                  </div>
                </button>
              </div>

              {forkDestinationMode === "workspace" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isMessageForkBusy}
                  onClick={() => void handleSelectForkWorkspace()}
                  className="w-full justify-start"
                >
                  {selectingForkWorkspace ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FolderOpen className="size-4" />
                  )}
                  {forkWorkspacePath ? forkWorkspacePath : "选择工作区文件夹"}
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isMessageForkBusy}
              onClick={resetMessageForkDialog}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={isMessageForkBusy || !messageForkTarget}
              onClick={() => void handleConfirmMessageFork()}
            >
              {isMessageForkBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GitFork className="size-4" />
              )}
              {isMessageForkBusy
                ? selectingForkWorkspace
                  ? "选择中"
                  : "正在 fork"
                : forkDestinationMode === "workspace" && !forkWorkspacePath
                  ? "选择工作区并 Fork"
                  : "Fork"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {skillIntentBanner}
      {nuxDialog}
      {visibleMessageIndexes.length > CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD && (
        <TooltipProvider delayDuration={180}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label="虚拟列表已启用"
                className="pointer-events-auto absolute right-4 top-4 z-20 block size-2.5 rounded-full bg-emerald-500 ring-2 ring-background shadow-[0_0_0_1px_rgb(16_185_129/0.3)]"
              />
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8}>
              虚拟列表已启用
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      <ChatScrollNavigator
        messages={chatScrollNavigatorMessages}
        questionStructureRevision={chatScrollQuestionStructureRevision}
        historyGapBeforeMessageId={historyGapBeforeVisibleMessageId}
        canLoadReleasedHistory={Boolean(historyWindowGap?.reloadTargetMessageId)}
        onLoadReleasedHistoryWindow={loadReleasedHistoryWindow}
        onRevealMessage={revealMessage}
        scrollContainerRef={scrollRef}
        rightPanelCollapsed={rightPanelCollapsed}
        onScrollToQuestion={handleScrollToQuestion}
        scrollToMessageById={scrollToMessageById}
      >
        {({ reserveLeftSpace, setMessageRef, virtualRangeRef }) => (
          <>
            <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
              <div className={cn("px-4 pt-4", reserveLeftSpace && "md:pl-[20px]")}>
                <div className="max-w-3xl mx-auto space-y-4">
                  {historyLoading && displayMessages.length === 0 && (
                    <div
                      className="flex min-h-[42vh] items-center justify-center px-4"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <div className="flex flex-col items-center gap-3 text-center">
                        <div className="history-loading-icon">
                          <Clock className="size-5" />
                        </div>
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-foreground">
                            正在加载会话历史
                          </div>
                          <div className="text-xs text-muted-foreground">
                            内容较多时可能需要几秒钟...
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {welcomePane}
                  {displayMessages.length === 0 && !isLoading && !historyLoading && (
                    <WelcomeSkills
                      skills={skills}
                      skillsLoading={skillsLoading}
                      enabledSkillsForSlash={enabledSkillsForSlash}
                      shouldShowWelcomeSkillTabs={shouldShowWelcomeSkillTabs}
                      isLocalSkillDisabled={isLocalSkillDisabled}
                      onSkillsInstalled={loadSkills}
                      onUseSkillPrompt={handleUseSkillPrompt}
                      onOpenMarketByCategory={handleOpenMarketBySecondaryCategory}
                      onOpenOrganizationSkillMarket={handleOpenOrganizationSkillMarket}
                      onOpenMarketBySkill={handleOpenMarketBySkill}
                    />
                  )}
                  <ChatMessageVirtualList
                    messages={displayMessages}
                    visibleMessageIndexes={visibleMessageIndexes}
                    lastUserMessageIndex={lastUserMessageIndex}
                    contentVersion={displayMessagesContentVersion}
                    onLoadEarlierHistoryPage={loadEarlierHistoryPage}
                    historyHasMore={historyHasMore}
                    historyPageLoading={historyPageLoading}
                    historyRemainingCount={historyRemainingCount}
                    historyGapBeforeMessageId={historyGapBeforeVisibleMessageId}
                    canLoadReleasedHistory={Boolean(historyWindowGap?.reloadTargetMessageId)}
                    onLoadReleasedHistoryWindow={loadReleasedHistoryWindow}
                    onRestoreLatestHistoryWindow={scrollToConversationBottom}
                    hookLoggingEnabled={hookLogConfig.enabled}
                    hookLogBucketByTurnId={hookLogBucketByTurnId}
                    detachedHookLogBuckets={detachedHookLogBuckets}
                    contentMessageRefs={contentMessageRefs}
                    setMessageRef={setMessageRef}
                    isLoading={isLoading}
                    toolResults={toolResults}
                    toolCallStates={toolCallDisplayStates}
                    pendingApprovalToolCallKeys={pendingApprovalToolCallKeys}
                    pendingApproval={pendingApproval}
                    autoApproveGitPush={!yoloModeLoaded || yoloMode}
                    onApprovalDecision={handleApprovalDecision}
                    onEditUserMessage={handleEditUserMessage}
                    onSetGoalFromMessage={handleSetGoalFromMessage}
                    onForkFromMessage={handleForkFromMessage}
                    forkingMessageId={forkingMessageId}
                    onOpenHookLogBucket={handleOpenHookLogBucket}
                    threadId={threadId}
                    assistantDurationMsById={assistantDurationMsById}
                    userSendTimeLabelById={userSendTimeLabelById}
                    customScrollParent={scrollParent}
                    virtuosoRef={virtuosoRef}
                    navigatorVirtualRangeRef={virtualRangeRef}
                    initialTopMostItemIndex={
                      chatScrollUiState.mode === "initializing" ||
                      chatScrollUiState.mode === "following"
                        ? { index: "LAST", align: "end", behavior: "auto" }
                        : undefined
                    }
                    onInitialVirtualItemsRendered={handleInitialVirtualItemsRendered}
                    onContentHeightChanged={handleContentHeightChanged}
                    onAtBottomStateChange={handleVirtualAtBottomStateChange}
                    footer={chatMessageListFooter}
                  />
                </div>
              </div>
            </ScrollArea>
            {humanGate && (
              <div className={cn("px-4 pb-2", reserveLeftSpace && "md:pl-[20px]")}>
                <div className="mx-auto flex w-full max-w-3xl items-center gap-3 rounded-md border border-amber-400/60 bg-amber-50/70 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10">
                  <PauseCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      等待人工确认
                    </div>
                    <div className="truncate text-xs text-amber-800/80 dark:text-amber-200/80">
                      {humanGate.message}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={Boolean(humanGateDecisionBusy)}
                    onClick={() => void decideHumanGate("reject")}
                  >
                    拒绝
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(humanGateDecisionBusy)}
                    onClick={() => void decideHumanGate("approve")}
                  >
                    批准推进
                  </Button>
                </div>
              </div>
            )}
            {/* Orchestrator approval bar — placed outside ScrollArea so it's always visible */}
            {pendingApproval &&
              Boolean(
                (pendingApproval as unknown as Record<string, unknown>)._orchestratorRequestId
              ) &&
              (pendingApproval as unknown as Record<string, unknown>).operation !== "git_commit" &&
              !(
                (!yoloModeLoaded || yoloMode) &&
                (pendingApproval as unknown as Record<string, unknown>).operation === "git_push"
              ) && (
                <div className={cn("px-4 pb-2", reserveLeftSpace && "md:pl-[20px]")}>
                  {(() => {
                    const approval = pendingApproval as unknown as Record<string, unknown>
                    const operation = approval.operation
                    const isFileApproval = operation === "write_file" || operation === "edit_file"
                    const isCodeExecApproval = operation === "code_exec"
                    const isSaveCodeExecToolApproval = operation === "save_code_exec_tool"
                    // Dynamic workflow launch approval: the backend sends
                    // tool_call.name="workflow" with name/description/phases/
                    // scriptPreview/argsPreview in args (no `operation`/`command`),
                    // so without a dedicated branch it falls through to the generic
                    // "command" card and shows nothing useful.
                    const isWorkflowApproval = pendingApproval.tool_call?.name === "workflow"
                    const workflowArgs = (pendingApproval.tool_call?.args ?? {}) as Record<
                      string,
                      unknown
                    >
                    // Backend sends phases as a string[] (meta.phases.map(p =>
                    // p.title)); tolerate an object form too in case that changes.
                    const workflowPhases: string[] = Array.isArray(workflowArgs.phases)
                      ? (workflowArgs.phases as unknown[]).map((phase, phaseIndex) =>
                          typeof phase === "string"
                            ? phase
                            : String(
                                (phase as Record<string, unknown> | null)?.title ??
                                  `phase ${phaseIndex + 1}`
                              )
                        )
                      : []
                    const approvalParams =
                      approval.params ?? pendingApproval.tool_call?.args?.params ?? {}
                    const hasApprovalParams =
                      approvalParams &&
                      typeof approvalParams === "object" &&
                      !Array.isArray(approvalParams) &&
                      Object.keys(approvalParams as Record<string, unknown>).length > 0
                    const approvalTypes = Array.isArray(approval._approvalTypes)
                      ? (approval._approvalTypes as Array<
                          "approve" | "approve_session" | "approve_permanent" | "reject"
                        >)
                      : ["approve", "approve_session", "approve_permanent", "reject"]

                    return (
                      <div
                        className={`max-w-3xl mx-auto rounded-lg border-2 p-4 space-y-3 ${
                          isFileApproval
                            ? "border-blue-500/50 bg-blue-500/5"
                            : isCodeExecApproval || isSaveCodeExecToolApproval
                              ? "border-emerald-500/50 bg-emerald-500/5"
                              : isWorkflowApproval
                                ? "border-violet-500/50 bg-violet-500/5"
                                : "border-amber-500/50 bg-amber-500/5"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {isFileApproval ? (
                            <FilePenLine className="size-4 text-blue-500" />
                          ) : isCodeExecApproval ? (
                            <Code2 className="size-4 text-emerald-500" />
                          ) : isSaveCodeExecToolApproval ? (
                            <Wrench className="size-4 text-emerald-500" />
                          ) : isWorkflowApproval ? (
                            <Workflow className="size-4 text-violet-500" />
                          ) : (
                            <ShieldCheck className="size-4 text-amber-500" />
                          )}
                          <span className="text-sm font-medium">
                            {operation === "write_file"
                              ? "写入文件需要审批"
                              : operation === "edit_file"
                                ? "编辑文件需要审批"
                                : isCodeExecApproval
                                  ? "编程式工具调用"
                                  : isSaveCodeExecToolApproval
                                    ? "编程式工具调用"
                                    : isWorkflowApproval
                                      ? "运行动态工作流需要审批"
                                      : "命令需要审批"}
                          </span>
                          {queuedApprovalCount > 0 && (
                            <span className="text-xs text-muted-foreground">
                              还有 {queuedApprovalCount} 条待审批
                            </span>
                          )}
                        </div>
                        {isCodeExecApproval || isSaveCodeExecToolApproval ? (
                          <>
                            {isSaveCodeExecToolApproval && (
                              <div className="grid gap-2 md:grid-cols-2">
                                <div className="rounded-md bg-muted/30 px-3 py-2 text-xs overflow-auto">
                                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                                    工具 ID
                                  </div>
                                  <div className="font-mono break-all">
                                    {String(
                                      approval.savedToolId ||
                                        pendingApproval.tool_call?.args?.toolId ||
                                        "-"
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                            <div className="overflow-hidden rounded-md border border-border bg-background shadow-sm">
                              <div className="border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                                脚本内容
                              </div>
                              <div className="max-h-36 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
                                {String(
                                  approval.code || pendingApproval.tool_call?.args?.code || ""
                                )}
                              </div>
                            </div>
                            {hasApprovalParams && (
                              <div className="rounded-md bg-muted/30 px-3 py-2 text-xs overflow-auto">
                                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                                  params
                                </div>
                                <pre className="whitespace-pre-wrap break-all font-mono">
                                  {JSON.stringify(approvalParams, null, 2)}
                                </pre>
                              </div>
                            )}
                          </>
                        ) : isWorkflowApproval ? (
                          <div className="space-y-2">
                            <div className="rounded-md bg-muted/30 px-3 py-2 text-xs">
                              <div className="font-medium break-all">
                                {String(workflowArgs.name ?? "(unnamed workflow)")}
                              </div>
                              {Boolean(workflowArgs.description) && (
                                <div className="mt-0.5 text-muted-foreground break-all">
                                  {String(workflowArgs.description)}
                                </div>
                              )}
                            </div>
                            {workflowPhases.length > 0 && (
                              <div className="rounded-md bg-muted/30 px-3 py-2 text-xs">
                                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                                  阶段（{workflowPhases.length}）
                                </div>
                                <ul className="space-y-0.5">
                                  {workflowPhases.map((phase, phaseIndex) => (
                                    <li key={phaseIndex} className="font-mono break-all">
                                      {phase}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {Boolean(workflowArgs.scriptPreview) && (
                              <div className="overflow-hidden rounded-md border border-border bg-background shadow-sm">
                                <div className="border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                                  脚本预览
                                </div>
                                <div className="max-h-36 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
                                  {String(workflowArgs.scriptPreview)}
                                </div>
                              </div>
                            )}
                            {Boolean(workflowArgs.argsPreview) &&
                              String(workflowArgs.argsPreview) !== "(none)" && (
                                <div className="overflow-auto rounded-md bg-muted/30 px-3 py-2 text-xs">
                                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                                    args
                                  </div>
                                  <pre className="whitespace-pre-wrap break-all font-mono">
                                    {String(workflowArgs.argsPreview)}
                                  </pre>
                                </div>
                              )}
                          </div>
                        ) : (
                          <pre className="rounded-md bg-muted/50 px-3 py-2 font-mono text-sm whitespace-pre-wrap break-words overflow-auto max-h-40">
                            {isFileApproval
                              ? `${operation === "write_file" ? "写入" : "编辑"}: ${String(approval.filePath || pendingApproval.tool_call?.args?.filePath || "unknown")}`
                              : approval.command
                                ? String(approval.command)
                                : pendingApproval.tool_call?.args?.command
                                  ? String(pendingApproval.tool_call.args.command)
                                  : "unknown command"}
                          </pre>
                        )}
                        {Boolean(approval._retryReason) && (
                          <div className="text-xs text-amber-600 dark:text-amber-400">
                            {String(approval._retryReason)}
                          </div>
                        )}
                        {Boolean(approval.reason) && (
                          <div className="text-xs text-muted-foreground">
                            {`原因：${String(approval.reason)}`}
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          {approval._retryReason ? (
                            <>
                              <button
                                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-700"
                                onClick={() => handleApprovalDecision("approve")}
                              >
                                无沙箱重试
                              </button>
                              <button
                                className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/15"
                                onClick={() => handleApprovalDecision("reject")}
                              >
                                拒绝
                              </button>
                            </>
                          ) : (
                            <>
                              {approvalTypes.includes("approve") && (
                                <button
                                  className="rounded-md bg-button px-4 py-2 text-sm font-semibold text-button-foreground shadow-sm transition-colors hover:bg-button/90"
                                  onClick={() => handleApprovalDecision("approve")}
                                >
                                  {isFileApproval
                                    ? "允许"
                                    : isCodeExecApproval
                                      ? "执行脚本"
                                      : isSaveCodeExecToolApproval
                                        ? "保存草稿"
                                        : isWorkflowApproval
                                          ? "运行工作流"
                                          : "运行"}
                                </button>
                              )}
                              {approvalTypes.includes("approve_session") && (
                                <button
                                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
                                  onClick={() => handleApprovalDecision("approve_session")}
                                >
                                  本会话允许
                                </button>
                              )}
                              {approvalTypes.includes("approve_permanent") && (
                                <button
                                  className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-green-700"
                                  onClick={() => handleApprovalDecision("approve_permanent")}
                                >
                                  始终允许
                                </button>
                              )}
                              {approvalTypes.includes("reject") && (
                                <button
                                  className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/15"
                                  onClick={() => handleApprovalDecision("reject")}
                                >
                                  拒绝
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}
            <ContextReminderController
              enabled={isHarnessContextReminderEnabled}
              isLoading={isLoading}
              historyLoading={historyLoading}
              hasPendingApproval={Boolean(pendingApproval)}
              hasQueuedApprovals={approvalQueue.length > 0}
              hasPendingUserInput={Boolean(pendingUserInput)}
              tokenUsage={tokenUsage}
              currentModel={currentModel}
              modelContextLimit={modelContextLimit}
              contextReminder={contextReminder}
              setContextReminder={setContextReminder}
              harnessFeatureBinding={harnessFeatureBinding}
              workspacePath={workspacePath}
              currentThreadMetadata={currentThread?.metadata}
              createThread={createThread}
              reserveLeftSpace={reserveLeftSpace}
              onHarnessSessionCreated={onHarnessSessionCreated}
            />
            {goalUi.goal && (
              <div className={cn("px-4 pb-1", reserveLeftSpace && "md:pl-[20px]")}>
                <GoalStatusPanel
                  goalUi={goalUi}
                  open={goalDetailsOpen}
                  onOpenChange={setGoalDetailsOpen}
                  onCommand={applyGoalPanelCommand}
                  onEditGoal={handleEditGoal}
                />
              </div>
            )}
            {/* Input */}
            <div
              className={cn(
                "px-4 pb-4",
                goalUi.goal ? "pt-1" : "pt-4",
                reserveLeftSpace && "md:pl-[20px]"
              )}
            >
              {showGitChangeNotice && (
                <div className="max-w-3xl mx-auto mb-2 flex items-center justify-between gap-3 rounded-xl border border-status-warning/40 bg-status-warning/10 px-3 py-2">
                  <div className="min-w-0 flex items-center gap-2 text-[12px] text-foreground">
                    <AlertCircle className="size-3.5 shrink-0 text-status-warning" />
                    <span className="truncate">检测到文件变更，可打开 Git 面板查看。</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={onOpenGitPanel}
                      disabled={!onOpenGitPanel}
                      className="rounded-md bg-status-warning/15 px-2.5 py-1 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      onClick={onDismissGitChangeNotice}
                      disabled={!onDismissGitChangeNotice}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-status-warning/15 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="关闭文件变更提示"
                      title="关闭"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}
              <form onSubmit={handleSubmit} className="max-w-3xl mx-auto relative">
                <ChatScrollToBottomButton
                  visible={chatScrollUiState.mode === "detached"}
                  hasUnread={chatScrollUiState.hasUnread}
                  unreadCount={chatScrollUiState.unreadCount}
                  onScrollToBottom={scrollToConversationBottom}
                />
                <SlashCommandPopover
                  mode={slash.mode}
                  selectedIdx={slash.selectedIdx}
                  onHoverIdx={slash.setSelectedIdx}
                  onSelectCommand={applySlashCommand}
                  onSelectSkill={applySkillSelection}
                  skillsLoading={skillsLoading}
                />
                <AtFileMentionPopover
                  mode={atFileMentions.mode}
                  selectedIdx={atFileMentions.selectedIdx}
                  onHoverIdx={atFileMentions.setSelectedIdx}
                  onSelectFile={applyAtFileMention}
                />
                <div className="flex flex-col gap-2">
                  {queuedMessages.length > 0 && (
                    <div className="px-1 py-1">
                      <div className="flex items-center gap-2 pb-1 text-[11px] text-muted-foreground">
                        <ListEnd className="size-3.5" />
                        <span>排队中 {queuedMessages.length} 条</span>
                      </div>
                      <div className="space-y-1.5">
                        {queuedMessages.map((queued) => {
                          const isEditing = editingQueueId === queued.id
                          const isGuided = Boolean(queued.handoffRequestedAt)
                          return (
                            <div
                              key={queued.id}
                              draggable={!isEditing && !isGuided}
                              onDragStart={() => {
                                if (!isGuided) setDraggingQueueId(queued.id)
                              }}
                              onDragOver={(e) => {
                                if (!isGuided) e.preventDefault()
                              }}
                              onDrop={(e) => {
                                e.preventDefault()
                                if (isGuided) {
                                  setDraggingQueueId(null)
                                  return
                                }
                                if (draggingQueueId) {
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  const placement =
                                    e.clientY > rect.top + rect.height / 2 ? "after" : "before"
                                  moveQueuedMessage(draggingQueueId, queued.id, placement)
                                }
                                setDraggingQueueId(null)
                              }}
                              onDragEnd={() => setDraggingQueueId(null)}
                              className={cn(
                                "rounded-xl bg-status-warning/5 px-2.5 py-2 transition-colors",
                                draggingQueueId === queued.id && "opacity-50",
                                !isEditing && "hover:bg-status-warning/10"
                              )}
                            >
                              {isEditing ? (
                                <div className="space-y-2">
                                  <textarea
                                    value={editingQueueText}
                                    onChange={(e) => setEditingQueueText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault()
                                        saveEditingQueuedMessage()
                                      }
                                      if (e.key === "Escape") {
                                        e.preventDefault()
                                        cancelEditingQueuedMessage()
                                      }
                                    }}
                                    className="min-h-20 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                    autoFocus
                                  />
                                  <div className="flex justify-end gap-1.5">
                                    <button
                                      type="button"
                                      onClick={cancelEditingQueuedMessage}
                                      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"
                                    >
                                      <X className="size-3.5" />
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      onClick={saveEditingQueuedMessage}
                                      className="flex h-7 items-center gap-1 rounded-md bg-button px-2 text-xs text-button-foreground hover:bg-button/90"
                                    >
                                      <Check className="size-3.5" />
                                      保存
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/50" />
                                  <CornerDownRight className="size-4 shrink-0 text-muted-foreground/70" />
                                  <div className="min-w-0 flex-1 truncate text-sm text-foreground/80">
                                    {getQueuedPreview(queued)}
                                  </div>
                                  {CURRENT_RUN_GUIDE_UI_ENABLED && (
                                    <button
                                      type="button"
                                      onClick={() => void handleGuideQueuedMessage(queued)}
                                      disabled={isGuided}
                                      aria-disabled={isGuided || hasActiveGoalRunning}
                                      title={
                                        isGuided
                                          ? "已提交给当前运行"
                                          : hasActiveGoalRunning
                                            ? "Active Goal 运行中，请先暂停 Goal 再引导消息"
                                            : "提交给当前运行，下次模型调用前接收"
                                      }
                                      className={cn(
                                        "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-60",
                                        hasActiveGoalRunning && "opacity-60"
                                      )}
                                    >
                                      <CornerDownRight className="size-3.5" />
                                      {isGuided ? "已引导" : "引导"}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteQueuedMessage(queued)}
                                    title="删除"
                                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                  >
                                    <Trash2 className="size-3.5" />
                                  </button>
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        type="button"
                                        title="更多"
                                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        <MoreHorizontal className="size-4" />
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent align="end" className="w-40 p-1">
                                      <button
                                        type="button"
                                        onClick={() => startEditingQueuedMessage(queued)}
                                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                                      >
                                        <Pencil className="size-4" />
                                        编辑消息
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteQueuedMessage(queued)}
                                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        <ListEnd className="size-4" />
                                        关闭排队
                                      </button>
                                    </PopoverContent>
                                  </Popover>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <div
                      ref={dropZoneRef}
                      className={cn(
                        "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border  transition-colors duration-300",
                        pendingUserInput
                          ? "border-primary/25 bg-background"
                          : appleIntelligenceGlowEnabled && glowVisible
                            ? "bg-background-elevated/80"
                            : "bg-background-elevated",
                        dragOver && "border-primary"
                      )}
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                    >
                      {/* Selected chips sit above the textarea inside the composer shell. */}
                      {selectedSkill && (
                        <div className="flex items-center gap-1.5 px-3 pt-2.5">
                          <SkillChip
                            label={selectedSkill.name}
                            onRemove={() => setSelectedSkill(null)}
                          />
                        </div>
                      )}
                      {selectedBuiltinBrowser && (
                        <div className="flex items-center gap-1.5 px-3 pt-2.5">
                          <BuiltinBrowserChip onRemove={() => setSelectedBuiltinBrowser(false)} />
                        </div>
                      )}
                      {appleIntelligenceGlowEnabled && glowVisible && !pendingUserInput && (
                        <div
                          className={cn(
                            "siri-bg-glow rounded-xl",
                            !isLoading && "siri-bg-glow-out"
                          )}
                          onAnimationEnd={(e) => {
                            if (
                              e.animationName === "siri-fade-out" &&
                              e.target === e.currentTarget &&
                              !isLoading
                            )
                              setGlowVisible(false)
                          }}
                        />
                      )}
                      {dragOver && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5">
                          <span className="text-sm text-primary">拖放文件到这里</span>
                        </div>
                      )}
                      {/* File chips inside input box */}
                      {(mentionedFiles.length > 0 || attachments.length > 0) && (
                        <div className="flex flex-col gap-1 px-3 pt-2.5">
                          <ul className="flex flex-wrap gap-1.5">
                            {mentionedFiles.map((file, idx) => (
                              <li key={file.absolutePath}>
                                <MentionFileChip
                                  label={file.displayPath}
                                  popoverText={file.absolutePath}
                                  onRemove={() => removeMentionedFile(idx)}
                                />
                              </li>
                            ))}
                            {attachments.map((att, idx) => (
                              <li
                                key={`${att.filename}-${idx}`}
                                className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs group cursor-default"
                              >
                                <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                                <span className="max-w-[160px] truncate" title={att.filePath}>
                                  {att.filename}
                                </span>
                                {att.truncated && (
                                  <span className="text-amber-500" title="内容已截取">
                                    ⚠
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeAttachment(idx)}
                                  className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                  aria-label={`移除附件 ${att.filename}`}
                                >
                                  <X className="size-3" />
                                </button>
                              </li>
                            ))}
                            {attachmentLoading && (
                              <li>
                                <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />
                              </li>
                            )}
                          </ul>
                          <div className="text-[10px] text-muted-foreground/50">
                            {totalPendingFileCount}/{MAX_ATTACHMENTS} 个文件
                            {hasPendingFilePayload && (
                              <>
                                {" · "}
                                {totalPendingFileChars.toLocaleString()}/
                                {MAX_TOTAL_CHARS.toLocaleString()} 字符
                              </>
                            )}
                          </div>
                        </div>
                      )}
                      {/* Textarea */}
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onCompositionStart={() => {
                          isComposingRef.current = true
                        }}
                        onCompositionEnd={() => {
                          isComposingRef.current = false
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder={inputPlaceholder}
                        disabled={effectiveInputDisabled}
                        className={cn(
                          "relative z-[1] w-full resize-none bg-transparent overflow-y-auto",
                          "p-4 text-sm placeholder:text-muted-foreground",
                          "focus:outline-none disabled:opacity-70",
                          hasPendingFilePayload && "pt-1.5"
                        )}
                        rows={3}
                        style={{ minHeight: "44px", maxHeight: "200px" }}
                      />
                      {/* Bottom bar: + button left, send button right */}
                      <div className="flex items-center justify-between px-3 pb-2 w-full">
                        <div className="flex items-center gap-1 flex-1 overflow-auto">
                          <IconPopoverButton
                            icon={<Plus className="size-4" />}
                            popoverContent={ATTACH_FILE_POPOVER_CONTENT}
                            popoverClassName="max-w-64 leading-relaxed"
                            disabled={
                              effectiveComposerControlsDisabled ||
                              attachmentLoading ||
                              totalPendingFileCount >= MAX_ATTACHMENTS ||
                              totalPendingFileChars >= MAX_TOTAL_CHARS
                            }
                            aria-label="添加文件"
                            className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
                            onClick={handleAttachClick}
                          />
                          <div className="w-px h-4 bg-border mx-1" />
                          <ModelSwitcher threadId={threadId} />
                          <div className="w-px h-4 bg-border mx-1" />
                          <AgentModeSwitcher
                            showWorkflow
                            mode={
                              (disableCoordinatorModeOption && agentMode === "coordinator") ||
                              (disableWorkflowModeOption && agentMode === "workflow")
                                ? "normal"
                                : agentMode
                            }
                            locked={isLoading || !canChangeAgentMode}
                            lockedReason={agentModeSwitchDisabledReason}
                            disabledModes={
                              disableCoordinatorModeOption || disableWorkflowModeOption
                                ? {
                                    coordinator: disableCoordinatorModeOption,
                                    workflow: disableWorkflowModeOption
                                  }
                                : undefined
                            }
                            disabledModeReasons={
                              disableCoordinatorModeOption || disableWorkflowModeOption
                                ? {
                                    coordinator: disableCoordinatorModeOption
                                      ? "项目模式暂不支持 Agent Team。"
                                      : undefined,
                                    workflow: disableWorkflowModeOption
                                      ? "项目模式暂不支持 Workflow。"
                                      : undefined
                                  }
                                : undefined
                            }
                            onChange={handleAgentModeChange}
                          />
                          <ThreadRemoteAccessSwitcher
                            threadId={threadId}
                            onOpenSettings={handleOpenRobotSettings}
                          />
                          <div className="w-px h-4 bg-border mx-1" />
                          <WorkspacePicker
                            threadId={threadId}
                            onGitStatusChange={onThreadGitStatusChange}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <TooltipProvider delayDuration={180}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  disabled={effectiveInputDisabled}
                                  onClick={handleInsertNewline}
                                  aria-label="换行"
                                  className="cursor-pointer flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <CornerDownLeft className="size-3.5" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" sideOffset={6}>
                                Shift + Enter 换行
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          {isLoading ? (
                            <>
                              {canSubmitGoalCommandWhileLoading && (
                                <button
                                  type="submit"
                                  disabled={goalSendButtonDisabledWhileLoading}
                                  aria-label="发送 goal 命令"
                                  className="flex items-center justify-center size-7 rounded-md bg-button text-button-foreground hover:bg-button/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <Send className="size-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={handleCancel}
                                aria-label="停止生成"
                                title="停止生成"
                                className="flex items-center justify-center size-7 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                              >
                                <Square className="size-3 fill-current" />
                              </button>
                            </>
                          ) : (
                            <>
                              {hasRunningCoordinatorWorker && (
                                <TooltipProvider delayDuration={0}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        onClick={handleCancelBackgroundWorkers}
                                        aria-label="停止后台子代理"
                                        className="flex items-center justify-center size-7 rounded-md border border-red-300 bg-red-50 text-red-600 shadow-sm transition-colors hover:border-red-400 hover:bg-red-100 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300 dark:hover:border-red-800 dark:hover:bg-red-950/55 dark:hover:text-red-200"
                                      >
                                        <Square className="size-3 fill-current" />
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" sideOffset={6}>
                                      停止后台子代理
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              <button
                                type="submit"
                                disabled={
                                  effectiveInputDisabled ||
                                  (!input.trim() &&
                                    !hasPendingFilePayload &&
                                    !selectedSkill &&
                                    !selectedBuiltinBrowser) ||
                                  (slash.mode.kind === "slash" &&
                                    !isBareGoalSlashCommandInput(input))
                                }
                                className="flex items-center justify-center size-7 rounded-md bg-button text-button-foreground hover:bg-button/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Send className="size-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <UserInputRequestDialog
                        request={pendingUserInput}
                        onSubmit={handleUserInputSubmit}
                        onLayoutChange={handleUserInputDialogLayoutChange}
                      />
                      <AgentGitCommitDialog
                        key={agentCommitApproval?.id ?? "agent-commit-idle"}
                        open={Boolean(agentCommitApproval)}
                        threadId={threadId}
                        workspacePath={workspacePath}
                        suggestedMessage={agentCommitApproval?.suggestedCommitMessage}
                        suggestedFilePaths={agentCommitApproval?.suggestedCommitFilePaths}
                        suggestedFileBasePath={agentCommitApproval?.suggestedCommitFileBasePath}
                        suggestedGitWorktreePath={agentCommitApproval?.suggestedGitWorktreePath}
                        suggestedGitRepositories={agentCommitApproval?.suggestedGitRepositories}
                        suggestedFileSelectionSource={
                          agentCommitApproval?.suggestedCommitFileSelectionSource
                        }
                        onCommitted={handleAgentCommitCommitted}
                        onCancel={handleAgentCommitCancel}
                      />
                    </div>
                  </div>
                  {/*chat container bottom panel */}
                  <div className={"flex items-center justify-between"}>
                    <div className={"flex items-center gap-2"}>
                      {yoloMode && (
                        <button
                          type="button"
                          title="点击打开设置"
                          onClick={() => setShowCustomizeView(true, "sandbox")}
                          className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer"
                        >
                          <Zap className="size-3" />
                          YOLO
                        </button>
                      )}
                      <MemorySessionSwitcher onOpenSettings={handleOpenMemorySettings} />
                      {(agentMode === "normal" || agentMode === "multi") && (
                        <OutputStyleSwitcher threadId={threadId} disabled={isLoading} />
                      )}
                      <SystemPromptPreviewButton threadId={threadId} />
                      <SandboxModeSwitcher onOpenSettings={handleOpenSandboxSettings} />
                      {tokenUsage && (
                        <ContextUsageIndicator
                          tokenUsage={tokenUsage}
                          modelId={currentModel}
                          contextLimit={modelContextLimit}
                        />
                      )}
                      {showSystemConstraintsButton && (
                        <SystemConstraintsPreviewPopover
                          preview={systemConstraintsPromptPreview}
                          align="start"
                          side="top"
                          sideOffset={8}
                        >
                          <button
                            type="button"
                            className={cn(
                              "flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs transition-colors hover:opacity-80",
                              systemConstraintsLoadFailed
                                ? "bg-amber-500/20 text-amber-600 dark:text-amber-300"
                                : "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300"
                            )}
                            title={systemConstraintsTitle}
                            aria-label={systemConstraintsTitle}
                            onClick={handleOpenSystemConstraints}
                          >
                            <ShieldCheck className="size-3.5" />
                            <span>{systemConstraintsLabel}</span>
                          </button>
                        </SystemConstraintsPreviewPopover>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <GitBranchSwitcher workspacePath={workspacePath} />
                    </div>
                  </div>
                </div>
              </form>
            </div>
          </>
        )}
      </ChatScrollNavigator>
      <HookLogModal
        bucket={openHookLogBucket}
        open={openHookLogBucketId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenHookLogBucketId(null)
        }}
      />
    </div>
  )
}
