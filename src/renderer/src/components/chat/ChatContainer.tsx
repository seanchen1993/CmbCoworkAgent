import React, {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useState,
  useSyncExternalStore
} from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import {
  Send,
  Square,
  AlertCircle,
  X,
  FileText,
  FileSpreadsheet,
  Presentation,
  Search,
  Palette,
  FlaskConical,
  Code2,
  LayoutTemplate,
  Settings2,
  ChevronDown,
  ChevronRight,
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
  Workflow
} from "lucide-react"
import type { FileAttachment } from "@/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAppStore } from "@/lib/store"
import {
  consumePendingHarnessNextAction,
  getPendingHarnessNextAction,
  getPendingHarnessNextActionVersion,
  subscribePendingHarnessNextActions
} from "@/lib/harness-next-action"
import { cn } from "@/lib/utils"
import { useShallow } from "zustand/react/shallow"
import {
  useCurrentThread,
  useThreadStream,
  useThreadContext,
  type HookLogBucket,
  type ApiErrorDetailState
} from "@/lib/thread-context"
import {
  filterCoordinatorNoiseMessages,
  isCoordinatorNotificationPrompt
} from "@/lib/message-display-helpers"
import { isCoordinatorModeMetadata, isWorkflowModeMetadata } from "@/lib/coordinator-mode-helpers"
import { ModelSwitcher } from "./ModelSwitcher"
import { AgentModeSwitcher, type ChatAgentMode } from "./AgentModeSwitcher"
import { WorkflowRunPanel, WorkflowHistoryButton } from "./WorkflowRunPanel"
import { SandboxModeSwitcher } from "./SandboxModeSwitcher"
import { MemorySessionSwitcher } from "./MemorySessionSwitcher"
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
  HITLRequest,
  Message,
  SkillMetadata,
  Thread,
  ToolCallState,
  ToolCallStatus,
  UserInputResponse
} from "@/types"
import { MessageBubble } from "./MessageBubble"
import { ChatScrollNavigator } from "./ChatScrollNavigator"
import { ChatSearchOverlay } from "./ChatSearchOverlay"
import { SkillsByCategorySection } from "./SkillsByCategorySection"
import { SkillCreateConfirmDialog, type SkillConfirmRequest } from "./SkillCreateConfirmDialog"
import { UserInputRequestDialog, type UserInputRequestDialogLayout } from "./UserInputRequestDialog"
import { AgentGitCommitDialog, type AgentCommitOutcome } from "./AgentGitCommitDialog"
import {
  ContextReminderController,
  isContextReminderPending
} from "./ContextReminderController"
import { uploadChatData, ChatReportPayload } from "@/api"
import { marketApi, MarketItem } from "../../api/market"
import {
  buildMarketInstalledFlags,
  isMarketVersionDifferent,
  marketInstalledVersionStorage,
  MarketUpdateBadge
} from "@/components/customize/MarketPanel/MarketUpdateBadge"
import { insertLog, updateMMJUserInfo } from "../../../js/mmjUtils"
import { toast } from "sonner"
import { SlashCommandPopover } from "@/features/slash-commands/SlashCommandPopover"
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
import { splitGoalTransportPayload } from "../../../../shared/goal-slash"
import { SkillChip } from "@/features/slash-commands/skill-chip"
import { mergeChatSkills, selectSkillForSlashName } from "@/features/slash-commands/skill-merge"
import { formatSkillUseBlock, parseSkillUseBlock } from "@/features/slash-commands/skill-marker"
import { getSkillMetadataId, isSkillDisabled, normalizeSkillId } from "@/lib/skill-ids"
import { DEFAULT_SCENE_CATEGORY, SCENE_CATEGORY_OPTIONS } from "@/lib/skill-data-service"
import { formatGoalEventMessage, isVisibleCheckpointTranscriptMessage } from "@/lib/goal-transcript"
import { buildGoalPanelViewModel, goalVerdictTone } from "@/lib/goal-panel-view"
import {
  liveStreamMessageRole,
  normalizeLiveStreamMessageContent,
  stringifyMessageContentForReport,
  type LiveStreamMessage as StreamMessage
} from "@/lib/live-stream-messages"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
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
  releaseSubmitInFlightLock,
  shouldUseSubmitInFlightLock,
  tryAcquireSubmitInFlightLock
} from "@/lib/submit-in-flight-lock"
import { groupWelcomeSkills } from "./skill-grouping"
import { GitBranchSwitcher } from "./GitBranchSwitcher"
import { ProcessingDuration } from "./ProcessingDuration"
import { HookLogChip, HookLogModal } from "./HookLogViews"

const PROJECT_MODE_AGENT_TEAM_ENABLED =
  import.meta.env.VITE_PROJECT_MODE_AGENT_TEAM_ENABLED?.trim() === "1"

const MARKET_SKILLS_CACHE_TTL_MS = 10 * 60 * 1000

interface MarketSkillsSnapshot {
  allSkills: MarketItem[]
  goodSkills: MarketItem[]
  fetchedAt: number
}

// Min gap between featured-skill install passes. Throttling both success and
// failure to this interval means: market version updates are re-checked
// periodically (no permanent "done" latch), while a permanently-failing skill
// is retried at most once per interval instead of on every session entry.
const FEATURED_INSTALL_RETRY_MS = 10 * 60 * 1000

let marketSkillsSnapshot: MarketSkillsSnapshot | null = null
let marketSkillsRequest: Promise<MarketSkillsSnapshot> | null = null
let featuredSkillsInstallRequest: Promise<boolean> | null = null
// Timestamp of the last install pass (0 = never). Combined with the per-skill
// version check inside installFeaturedSkills, this re-checks for updates after
// the interval and avoids re-downloading on every mount.
let lastFeaturedInstallAttemptAt = 0

async function loadMarketSkillsSnapshot(): Promise<MarketSkillsSnapshot> {
  const now = Date.now()
  if (marketSkillsSnapshot && now - marketSkillsSnapshot.fetchedAt < MARKET_SKILLS_CACHE_TTL_MS) {
    return marketSkillsSnapshot
  }

  if (!marketSkillsRequest) {
    marketSkillsRequest = marketApi
      .getSkills()
      .then((res) => {
        const allSkills = res?.data || []
        const snapshot = {
          allSkills,
          goodSkills: allSkills.filter((it) => it.featured === "精品"),
          fetchedAt: Date.now()
        }
        marketSkillsSnapshot = snapshot
        return snapshot
      })
      .finally(() => {
        marketSkillsRequest = null
      })
  }

  return marketSkillsRequest
}

async function installFeaturedSkills(
  goodSkills: MarketItem[]
): Promise<{ changed: boolean; hadFailure: boolean }> {
  if (goodSkills.length === 0) return { changed: false, hadFailure: false }

  console.log("Starting automatic installation of good skills...")
  let skillsMetadata = await window.api.skills.list()
  let changed = false
  let hadFailure = false

  for (const skill of goodSkills) {
    try {
      const skillName = skill.name || skill.id || ""

      if (!skillName) {
        console.error("Skill name is required for installation:", skill)
        continue
      }

      console.log(`Installing skill: ${skillName}`)
      const existingSkill = skillsMetadata.find((s) => s.name === skillName)

      // 精品技能会在欢迎页初始化时自动补齐。为了避免每次进入会话都重复下载：
      // 1. 本地没有这个技能：需要安装；
      // 2. 本地有技能但没有安装版本记录：无法判断是否最新，按用户要求默认重新安装；
      // 3. 本地安装版本和市场版本不一致：需要删除旧技能后重新安装；
      // 4. 本地安装版本和市场版本一致：跳过安装，保留现有技能目录。
      const installedVersion = marketInstalledVersionStorage.getVersion(skillName, "skill")
      const shouldInstall =
        !existingSkill || !installedVersion || isMarketVersionDifferent(installedVersion, skill.version)

      if (!shouldInstall) {
        console.log(`Skill ${skillName} is already up to date, skipping install.`)
        continue
      }

      if (existingSkill) {
        console.log(`Deleting existing skill: ${existingSkill.path}`)
        try {
          await window.api.skills.delete(existingSkill.path)
          skillsMetadata = skillsMetadata.filter((s) => s.path !== existingSkill.path)
        } catch (deleteError) {
          console.warn(
            `Failed to delete existing skill ${skillName}, continuing with install:`,
            deleteError
          )
        }
      }

      const response = await marketApi.downloadItem(skillName, "skill", false)

      if (response.success) {
        marketInstalledVersionStorage.setVersion(skillName, "skill", skill.version)
        changed = true
        console.log(`Successfully installed skill: ${skillName}`)
      } else {
        hadFailure = true
        console.error(`Failed to install skill ${skillName}:`, response.error)
      }
    } catch (error) {
      hadFailure = true
      console.error(`Failed to install skill ${skill.name}:`, error)
    }
  }

  console.log("Finished automatic installation of good skills")
  return { changed, hadFailure }
}

async function installFeaturedSkillsOnce(goodSkills: MarketItem[]): Promise<boolean> {
  if (goodSkills.length === 0) return false

  // Share an already-running pass.
  if (featuredSkillsInstallRequest) return featuredSkillsInstallRequest

  // Throttle passes to one per retry window (applies to both success and
  // failure): updates are re-checked after the interval via the per-skill
  // version comparison, and a permanently-failing skill is not re-downloaded on
  // every session entry.
  const now = Date.now()
  if (
    lastFeaturedInstallAttemptAt !== 0 &&
    now - lastFeaturedInstallAttemptAt < FEATURED_INSTALL_RETRY_MS
  ) {
    return false
  }
  lastFeaturedInstallAttemptAt = now

  featuredSkillsInstallRequest = installFeaturedSkills(goodSkills)
    .then(({ changed }) => changed)
    .finally(() => {
      featuredSkillsInstallRequest = null
    })

  return featuredSkillsInstallRequest
}

type WelcomeSkillCard = {
  skill: SkillMetadata
  label: string
  icon: React.JSX.Element
  installedVersion?: string | null
  currentVersion?: string | null
  updateAvailable?: boolean
}

type WelcomeSkillSceneGroup = {
  category: string
  cards: WelcomeSkillCard[]
}

type WelcomeSkillTreeNode = {
  key: string
  label: string
  card?: WelcomeSkillCard
  children: WelcomeSkillTreeNode[]
}

function getWelcomeSkillTreePath(skill: SkillMetadata): string {
  const id = skill.id?.startsWith("plugin:") ? skill.id.split("/").slice(1).join("/") : skill.id
  return String(skill.relativePath || id || skill.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
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
      className: "text-[#23483c]"
    }
  }
  if (status === "paused") {
    return {
      label: "已暂停",
      icon: <PauseCircle className="size-4 text-amber-600" />,
      className: "text-[#51453a]"
    }
  }
  return {
    label: "进行中",
    icon: <Flag className="size-4 text-sky-600" />,
    className: "text-[#2f3f4a]"
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
            "flex items-center gap-3 rounded-2xl border border-black/[0.07] bg-white/82 px-3 py-2 shadow-[0_14px_42px_rgba(24,24,27,0.09),0_1px_0_rgba(255,255,255,0.88)_inset] backdrop-blur-2xl",
            status.className
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => onOpenChange(!open)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_6px_18px_rgba(24,24,27,0.10)] ring-1 ring-black/[0.06]">
              {status.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 text-sm font-semibold">Goal {status.label}</span>
                <span className="shrink-0 rounded-full border border-black/[0.05] bg-[#f7f7f5]/85 px-2 py-0.5 text-[11px] text-muted-foreground">
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
                  className="flex size-8 items-center justify-center rounded-full bg-[#f7f7f5]/90 text-foreground/70 ring-1 ring-black/[0.04] transition-colors hover:bg-white hover:text-foreground"
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
                    className="flex size-8 items-center justify-center rounded-full bg-[#f7f7f5]/90 text-foreground/70 ring-1 ring-black/[0.04] transition-colors hover:bg-white hover:text-foreground"
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
                    className="flex size-8 items-center justify-center rounded-full bg-[#f7f7f5]/90 text-foreground/70 ring-1 ring-black/[0.04] transition-colors hover:bg-white hover:text-foreground"
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
                  className="flex size-8 items-center justify-center rounded-full bg-[#f7f7f5]/90 text-foreground/70 ring-1 ring-black/[0.04] transition-colors hover:bg-white hover:text-foreground"
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
                  className="flex size-8 items-center justify-center rounded-full bg-[#f7f7f5]/90 text-foreground/70 ring-1 ring-black/[0.04] transition-colors hover:bg-white hover:text-foreground"
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
          <div className="fixed bottom-24 right-5 top-16 z-40 flex w-[min(480px,calc(100vw-40px))] flex-col overflow-hidden rounded-3xl border border-black/[0.08] bg-[#fbfaf8] shadow-[0_24px_80px_rgba(24,24,27,0.18)]">
            <div className="border-b border-black/[0.06] bg-white px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex size-10 items-center justify-center rounded-full bg-[#f7f7f5] shadow-sm ring-1 ring-black/[0.06]">
                      {status.icon}
                    </span>
                    <div className="text-lg font-semibold text-foreground">Goal {status.label}</div>
                    <div className="rounded-full border border-black/[0.06] bg-[#f6f5f2] px-2 py-0.5 text-xs text-muted-foreground">
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
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#f6f5f2] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenChange(false)}
                  aria-label="关闭 Goal 详情"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#eeece8]">
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
                  "min-w-0 overflow-hidden rounded-2xl border p-4 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset]",
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
                <div className="mt-3 rounded-xl bg-white/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  这里展示的是 evaluator 根据最近一轮 assistant 回复、工具结果和持久化 ledger
                  做出的判断。它解释为什么 Goal 会继续、暂停或完成。
                </div>
              </section>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-4">
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
                    <div className="border-t border-black/[0.06] pt-3">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        完成条件
                      </div>
                      <div className="whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">
                        {goal.completionCondition}
                      </div>
                    </div>
                  )}
                  {contextText && (
                    <div className="border-t border-black/[0.06] pt-3">
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

              <section className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-4">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Layers className="size-4" />
                  进展与证据
                </div>
                <div className="mb-3 text-xs leading-5 text-muted-foreground">
                  以下条目来自 evaluator 返回的 ledger_patch，是它从对话、工具结果和 assistant
                  验证摘要里提炼出的判断依据。
                </div>

                {!hasLedgerDetails ? (
                  <div className="rounded-xl border border-dashed border-black/[0.10] bg-[#fbfaf8] px-3 py-4 text-center text-xs text-muted-foreground">
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
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-[11px] font-semibold text-emerald-700">
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
                      <div className="border-t border-black/[0.06] pt-4">
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground/80">
                          <Database className="size-3.5 text-sky-600" />
                          证据
                        </div>
                        <ol className="space-y-2">
                          {allEvidenceItems.map((item, index) => (
                            <li key={`evidence-${index}`} className="flex min-w-0 gap-2 leading-5">
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-50 text-[11px] font-semibold text-sky-700">
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
                      <div className="border-t border-black/[0.06] pt-4">
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground/80">
                          <CircleAlert className="size-3.5 text-amber-600" />
                          未解决问题
                        </div>
                        <ol className="space-y-2">
                          {allBlockerItems.map((item, index) => (
                            <li key={`blocker-${index}`} className="flex min-w-0 gap-2 leading-5">
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-50 text-[11px] font-semibold text-amber-700">
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

              <section className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Clock className="size-4" />
                  最近事件
                </div>
                <div className="mb-3 rounded-xl bg-[#fbfaf8] px-3 py-2 text-xs leading-5 text-muted-foreground">
                  最近一条：{recentEventSummary}
                </div>
                <details>
                  <summary className="cursor-pointer list-none rounded-lg border border-black/[0.06] px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40">
                    展开事件历史（{latestEvents.length}）
                  </summary>
                  {latestEvents.length === 0 ? (
                    <div className="mt-3 rounded-lg bg-[#fbfaf8] px-3 py-2 text-xs text-muted-foreground">
                      暂无事件
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {latestEvents.map((event) => (
                        <div key={event.event_id} className="border-l-2 border-black/[0.10] pl-3">
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

            <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] bg-white px-5 py-3">
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
                  className="rounded-xl border border-black/[0.08] px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
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
                  className="rounded-xl border border-black/[0.08] px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
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

function buildWelcomeSkillTree(cards: WelcomeSkillCard[]): WelcomeSkillTreeNode[] {
  const root: WelcomeSkillTreeNode = { key: "root", label: "root", children: [] }
  const indexByNode = new WeakMap<WelcomeSkillTreeNode, Map<string, WelcomeSkillTreeNode>>()

  const getIndex = (node: WelcomeSkillTreeNode): Map<string, WelcomeSkillTreeNode> => {
    let index = indexByNode.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [normalizeSkillId(child.label), child]))
      indexByNode.set(node, index)
    }
    return index
  }

  for (const card of cards) {
    const segments = getWelcomeSkillTreePath(card.skill).split("/").filter(Boolean)
    const fallbackSegments = segments.length > 0 ? segments : [card.skill.name]
    let current = root

    for (const segment of fallbackSegments) {
      const normalized = normalizeSkillId(segment)
      const childIndex = getIndex(current)
      let child = childIndex.get(normalized)
      if (!child) {
        child = { key: `${current.key}/${normalized}`, label: segment, children: [] }
        current.children.push(child)
        childIndex.set(normalized, child)
      }
      current = child
    }

    current.card = card
  }

  const sortNodes = (nodes: WelcomeSkillTreeNode[]): WelcomeSkillTreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        const labelA = a.card?.label || a.label
        const labelB = b.card?.label || b.label
        return labelA.localeCompare(labelB, "zh-CN")
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }))

  return sortNodes(root.children)
}

function countWelcomeSkillTreeCards(node: WelcomeSkillTreeNode): number {
  return (
    (node.card ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countWelcomeSkillTreeCards(child), 0)
  )
}

function getWelcomeSkillTopLevelKey(skill: SkillMetadata): string {
  return normalizeSkillId(
    getWelcomeSkillTreePath(skill).split("/").filter(Boolean)[0] || skill.name
  )
}

function limitWelcomeSkillsByTopLevel(
  skills: SkillMetadata[],
  previewLimit: number
): SkillMetadata[] {
  if (previewLimit <= 0) return []
  const selectedRoots = new Set<string>()

  for (const skill of skills) {
    selectedRoots.add(getWelcomeSkillTopLevelKey(skill))
    if (selectedRoots.size >= previewLimit) break
  }

  return skills.filter((skill) => selectedRoots.has(getWelcomeSkillTopLevelKey(skill)))
}

function WelcomeSkillButton(props: {
  card: WelcomeSkillCard
  disabled?: boolean
  onUseSkill: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (name: string) => string
}): React.JSX.Element {
  const { card, disabled = false, onUseSkill, getSkillShowLabel } = props
  const label = getSkillShowLabel(card.label)

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onUseSkill(card.skill, card.label)
      }}
      className={cn(
        "group w-full rounded-xl border px-3 py-2 text-left transition-all",
        disabled
          ? "cursor-not-allowed border-border/70 bg-background/60 opacity-65"
          : "border-slate-300/90 bg-slate-50/70 shadow-[0_1px_0_rgba(15,23,42,0.05)] hover:border-slate-400/95 hover:bg-slate-100/95 hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] dark:border-slate-600/85 dark:bg-slate-900/35 dark:hover:border-slate-500/95 dark:hover:bg-slate-800/55"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={cn(
            "rounded-md border p-1.5 transition-colors",
            disabled
              ? "border-border/70 bg-background/70 text-muted-foreground"
              : "border-slate-300/90 bg-white/80 text-slate-500 group-hover:text-slate-700 dark:border-slate-600/80 dark:bg-slate-900/45 dark:text-slate-300 dark:group-hover:text-slate-100"
          )}
        >
          {card.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className={cn(
                "min-w-0 flex-1 text-xs leading-5 truncate whitespace-nowrap",
                disabled ? "text-muted-foreground line-through" : "text-foreground"
              )}
            >
              {label}
            </div>
            {/* 仅当市场版本与本地安装版本不一致时展示更新标识；具体版本差异在 tooltip 中展示。 */}
            {card.updateAvailable && (
              <MarketUpdateBadge
                typeLabel="技能"
                installedVersion={card.installedVersion}
                currentVersion={card.currentVersion}
                className="text-[10px] px-1.5 py-0"
              />
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

function WelcomeSkillTree(props: {
  cards: WelcomeSkillCard[]
  disabled?: boolean
  onUseSkill: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (name: string) => string
}): React.JSX.Element {
  const { cards, disabled = false, onUseSkill, getSkillShowLabel } = props
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildWelcomeSkillTree(cards), [cards])
  const toggleNode = useCallback((nodeKey: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }, [])

  return (
    <WelcomeSkillTreeList
      nodes={tree}
      disabled={disabled}
      nested={false}
      expandedNodes={expandedNodes}
      onToggleNode={toggleNode}
      onUseSkill={onUseSkill}
      getSkillShowLabel={getSkillShowLabel}
    />
  )
}

function WelcomeSkillTreeList(props: {
  nodes: WelcomeSkillTreeNode[]
  disabled: boolean
  nested: boolean
  expandedNodes: Set<string>
  onToggleNode: (nodeKey: string) => void
  onUseSkill: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (name: string) => string
}): React.JSX.Element {
  const { nodes, disabled, nested, expandedNodes, onToggleNode, onUseSkill, getSkillShowLabel } =
    props

  return (
    <div className={nested ? "grid grid-cols-1 gap-1.5" : "grid grid-cols-2 md:grid-cols-4 gap-2"}>
      {nodes.map((node) => {
        const childrenExpanded = expandedNodes.has(node.key)
        const childCount = node.children.reduce(
          (sum, child) => sum + countWelcomeSkillTreeCards(child),
          0
        )

        return (
          <div key={node.key} className="min-w-0 space-y-1.5">
            {node.card ? (
              <WelcomeSkillButton
                card={node.card}
                disabled={disabled}
                onUseSkill={onUseSkill}
                getSkillShowLabel={getSkillShowLabel}
              />
            ) : (
              <button
                type="button"
                onClick={() => onToggleNode(node.key)}
                className="w-full rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-left hover:bg-muted/35"
              >
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {childrenExpanded ? (
                      <ChevronDown className="size-3 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{node.label}</span>
                  </span>
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                    {childCount}
                  </Badge>
                </div>
              </button>
            )}

            {node.children.length > 0 && (
              <button
                type="button"
                onClick={() => onToggleNode(node.key)}
                className="flex min-h-7 w-full items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/15 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
              >
                {expandedNodes.has(node.key) ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">子技能</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {childCount}
                </Badge>
              </button>
            )}

            {expandedNodes.has(node.key) && (
              <div className="border-l border-border/60 pl-2">
                <WelcomeSkillTreeList
                  nodes={node.children}
                  disabled={disabled}
                  nested
                  expandedNodes={expandedNodes}
                  onToggleNode={onToggleNode}
                  onUseSkill={onUseSkill}
                  getSkillShowLabel={getSkillShowLabel}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
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
const MAX_ATTACHMENTS = 3
const MAX_TOTAL_CHARS = 24_000
const GOOD_SKILLS_PREVIEW_LIMIT = 4
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

const MESSAGE_TIMES_THREAD_VALUE_KEY = "messageTimes"
const MESSAGE_TIME_ORDER_THREAD_VALUE_KEY = "messageTimeOrder"

type MessageTimeValue = {
  start_at?: string
  end_at?: string
}

type MessageTimeMap = Record<string, MessageTimeValue>

const messageTimeOrderEntries = (
  updates: MessageTimeMap
): Array<MessageTimeValue & { id: string }> => {
  return Object.entries(updates).map(([id, time]) => ({ id, ...time }))
}

const toDate = (value: Date | string | undefined): Date | undefined => {
  if (!value) return undefined
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

const toTime = (value: Date | string | undefined): number | null => {
  const date = toDate(value)
  return date ? date.getTime() : null
}

const getMessageDisplayTime = (message: Message): number | null => {
  return toTime(message.start_at) ?? toTime(message.created_at) ?? toTime(message.end_at)
}

const sortMessagesForDisplay = (messages: Message[]): Message[] => {
  return messages
    .map((message, index) => ({
      message,
      index,
      time: getMessageDisplayTime(message)
    }))
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) {
        return a.time - b.time
      }
      return a.index - b.index
    })
    .map((entry) => entry.message)
}

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

const getMessageBubbleText = (content: Message["content"]): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

// MessageBubble renders `null` for messages with no visible content: tool-result
// messages, empty system notices, and assistant/user messages whose text is empty
// and that carry no tool calls. Such empty wrappers must NOT get content-visibility
// containment — when scrolled off-screen the intrinsic-size fallback would reserve
// phantom height (stacking across many empty tool results into a large blank gap
// between tools and text). Detection is intentionally generous: a false positive
// only skips a cheap optimization on an already-short message (harmless), while a
// false negative reintroduces the gap.
//
// Match each role to its actual render path: assistant/user bubbles render only
// `text` blocks (getMessageBubbleText), while the system branch renders via
// extractMessagePlainText, which also reads string `block.content` — so system
// must use getMessageText (same text+content logic) or a notice carried in a
// content block would be misclassified as empty.
const messageRendersNothing = (message: Message): boolean => {
  if (message.role === "tool") return true
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  if (hasToolCalls) return false
  const visibleText =
    message.role === "system"
      ? getMessageText(message.content)
      : getMessageBubbleText(message.content)
  return visibleText.trim().length === 0
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

type ChatApprovalDecision = "approve" | "approve_session" | "approve_permanent" | "reject" | "edit"

interface ChatToolResultInfo {
  content: string | unknown
  is_error?: boolean
}

interface ChatMessageFlags {
  showAssistantMeta: boolean[]
  hasUserAfterHead: boolean[]
}

interface ChatMessageListProps {
  messages: Message[]
  perMessageFlags: ChatMessageFlags
  hookLoggingEnabled: boolean
  hookLogBucketByTurnId: Map<string, HookLogBucket>
  detachedHookLogBuckets: HookLogBucket[]
  contentMessageRefs: React.RefObject<Map<string, HTMLDivElement>>
  setMessageRef: (
    messageId: string,
    role: Message["role"]
  ) => (node: HTMLDivElement | null) => void
  isLoading: boolean
  toolResults: Map<string, ChatToolResultInfo>
  toolCallStates: Map<string, ToolCallState>
  pendingApproval: HITLRequest | null
  autoApproveGitPush: boolean
  onApprovalDecision: (decision: ChatApprovalDecision) => void
  onEditUserMessage: (message: Message) => void
  onSetGoalFromMessage: (text: string) => void
  onOpenHookLogBucket: (turnId: string) => void
  threadId: string
  assistantDurationMsById: Map<string, number>
  userSendTimeLabelById: Map<string, string>
}

const ChatMessageList = React.memo(function ChatMessageList({
  messages,
  perMessageFlags,
  hookLoggingEnabled,
  hookLogBucketByTurnId,
  detachedHookLogBuckets,
  contentMessageRefs,
  setMessageRef,
  isLoading,
  toolResults,
  toolCallStates,
  pendingApproval,
  autoApproveGitPush,
  onApprovalDecision,
  onEditUserMessage,
  onSetGoalFromMessage,
  onOpenHookLogBucket,
  threadId,
  assistantDurationMsById,
  userSendTimeLabelById
}: ChatMessageListProps): React.JSX.Element {
  return (
    <>
      {messages.map((message, index) => {
        const previousMessage = index > 0 ? messages[index - 1] : null
        const isLastMessage = index === messages.length - 1
        const hasUserAfterHead = perMessageFlags.hasUserAfterHead[index]
        const showAssistantMeta = perMessageFlags.showAssistantMeta[index]

        const hookLogBucketForTurn =
          hookLoggingEnabled && message.role === "user"
            ? hookLogBucketByTurnId.get(message.id)
            : undefined
        const rendersNothing = messageRendersNothing(message)
        const hasHookLogChip = Boolean(hookLogBucketForTurn?.entries.length)
        if (rendersNothing && !hasHookLogChip) return null

        const navigatorRef = setMessageRef(message.id, message.role)
        const combinedRef = (node: HTMLDivElement | null): void => {
          navigatorRef(node)
          if (node && message.role !== "tool") {
            contentMessageRefs.current.set(message.id, node)
            return
          }
          contentMessageRefs.current.delete(message.id)
        }

        return (
          <div
            key={message.id}
            ref={combinedRef}
            data-message-role={message.role}
          >
            <MessageBubble
              message={message}
              previousMessage={previousMessage}
              isStreaming={isLastMessage && isLoading}
              showAssistantMeta={showAssistantMeta}
              toolResults={toolResults}
              toolCallStates={toolCallStates}
              pendingApproval={pendingApproval}
              autoApproveGitPush={autoApproveGitPush}
              onApprovalDecision={onApprovalDecision}
              onEditUserMessage={onEditUserMessage}
              onSetGoalFromMessage={onSetGoalFromMessage}
              threadId={threadId}
              isLoading={isLoading}
              hasUserAfterHead={hasUserAfterHead}
              assistantDurationMs={assistantDurationMsById.get(message.id)}
              userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
            />
            {hookLogBucketForTurn && hookLogBucketForTurn.entries.length > 0 && (
              <div className="mt-1 ml-12">
                <HookLogChip
                  bucket={hookLogBucketForTurn}
                  onClick={() => onOpenHookLogBucket(hookLogBucketForTurn.turnId)}
                />
              </div>
            )}
          </div>
        )
      })}

      {hookLoggingEnabled && detachedHookLogBuckets.length > 0 && (
        <div className="flex flex-wrap justify-start gap-2 mt-1">
          {detachedHookLogBuckets.map((bucket) => (
            <HookLogChip
              key={bucket.turnId}
              bucket={bucket}
              onClick={() => onOpenHookLogBucket(bucket.turnId)}
            />
          ))}
        </div>
      )}
    </>
  )
})

function SystemPromptPreviewButton({ threadId }: { threadId?: string | null }): React.JSX.Element | null {
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
  const surfaceConfig = CHAT_SURFACE_CONFIG[surface]
  const readOnly = Boolean(readOnlyReason)
  const shouldShowWelcomeHeadline = surfaceConfig.showWelcomeHeadline
  const shouldShowWelcomeSkillTabs = surfaceConfig.showWelcomeSkillTabs && !hideWelcomeSkillTabs
  const shouldShowHarnessDialogTips = surfaceConfig.showHarnessDialogTips && !readOnly
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const textareaResizeFrameRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRootRef = useRef<HTMLDivElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const contentMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const isComposingRef = useRef(false)
  const submitInFlightRef = useRef<Set<string>>(new Set())
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [disabledSkillIds, setDisabledSkillIds] = useState<Set<string>>(new Set())
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [skillsHarnessProjectId, setSkillsHarnessProjectId] = useState<string | null>(null)
  const [skillsLoadTargetProjectId, setSkillsLoadTargetProjectId] = useState<string | null>(null)
  const [skillsHarnessPreferredPlugin, setSkillsHarnessPreferredPlugin] = useState<{
    id?: string
    name?: string
  } | null>(null)
  const [showAllProgrammingSkills, setShowAllProgrammingSkills] = useState(false)
  const [showAllCustomSkills, setShowAllCustomSkills] = useState(false)
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
      : "normal"
  const [agentMode, setAgentMode] = useState<ChatAgentMode>(initialAgentMode)
  const agentModeHydratedRef = useRef(initialAgentMode !== "normal")
  const chatReportUploadTimersRef = useRef<Record<string, number>>({})
  const chatReportRetryTimersRef = useRef<Record<string, number>>({})
  const chatReportRetryQueuesRef = useRef<
    Record<string, Array<{ messages: Message[]; attempt: number }>>
  >({})
  // Get the stream data via subscription - reactive updates without re-rendering provider
  const streamData = useThreadStream(threadId)
  const stream = streamData.stream

  useEffect(() => {
    const { ipcRenderer } = window.electron

    // 主动请求版本，不依赖推送时序
    ipcRenderer
      .invoke("get-version")
      .then((ver: unknown) => {
        console.log("版本 (invoke)：", ver)
        if (ver) {
          localStorage.setItem("version", ver as string)
          updateMMJUserInfo()
        }
      })
      .catch((e: unknown) => console.warn("get-version failed:", e))

    // 保留推送监听作为备用
    const removeListener = ipcRenderer.on("version", (ver: unknown) => {
      console.log("版本 (push)：", ver)
      localStorage.setItem("version", ver as string)
      updateMMJUserInfo()
    })

    return () => {
      if (typeof removeListener === "function") removeListener()
    }
  }, [])

  useEffect(() => {
    const { ipcRenderer } = window.electron

    // 主动请求 IP，不依赖推送时序
    ipcRenderer
      .invoke("get-local-ip")
      .then((ip: unknown) => {
        console.log("local ip (invoke)：", ip)
        if (ip) {
          localStorage.setItem("localIp", ip as string)
          updateMMJUserInfo()
        }
      })
      .catch((e: unknown) => console.warn("get-local-ip failed:", e))

    // 保留推送监听作为备用（例如网络变化时主进程重新推送）
    const removeListener = ipcRenderer.on("ip", (ver: unknown) => {
      console.log("local ip (push)：", ver)
      if (ver) {
        localStorage.setItem("localIp", ver as string)
      }
    })

    return () => {
      if (typeof removeListener === "function") removeListener()
    }
  }, [])

  const {
    threads,
    models,
    createThread,
    updateThread,
    generateTitleForFirstMessage,
    setShowCustomizeView,
    rightPanelCollapsed,
    pluginVersion,
    requestOpenRightPanelSystemConstraints
  } = useAppStore()
  const currentThread = useMemo(
    () => threads.find((thread) => thread.thread_id === threadId) ?? null,
    [threadId, threads]
  )
  const harnessFeatureBinding = useMemo(
    () => getHarnessFeatureBinding(currentThread),
    [currentThread]
  )
  const isProjectModeAgentContext =
    surface === "harness-project" ||
    surface === "harness-feature-session" ||
    Boolean(harnessFeatureBinding)
  const disableCoordinatorModeOption =
    isProjectModeAgentContext && !PROJECT_MODE_AGENT_TEAM_ENABLED
  const disableWorkflowModeOption = isProjectModeAgentContext
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
        .isCoordinatorModeForced()
        .catch((error) => {
          console.warn("[ChatContainer] Failed to load environment coordinator mode:", error)
          return false
        })
      return environmentForcedCoordinator && !disableCoordinatorModeOption
        ? "coordinator"
        : "normal"
    },
    [disableCoordinatorModeOption, disableWorkflowModeOption]
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
              : "normal"
    setAgentMode(metadataDerivedMode)
    agentModeHydratedRef.current = metadataDerivedMode !== "normal"

    void loadResolvedAgentMode()
      .then((nextMode) => {
        if (cancelled) return
        agentModeHydratedRef.current = true
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

  const allSkillsRef = useRef<MarketItem[]>([])
  const [marketSkillsData, setMarketSkillsData] = useState<MarketItem[]>([])
  const [goodSkillsData, setGoodSkillsData] = useState<MarketItem[]>([])

  // Stable ref so loadSkills can read the latest harness binding without
  // invalidating its own identity (useCallback with empty deps).
  const harnessFeatureBindingRef = useRef(harnessFeatureBinding)
  harnessFeatureBindingRef.current = harnessFeatureBinding

  // Define loadSkills function at component level so it can be accessed everywhere
  const loadSkills = useCallback(async (): Promise<void> => {
    setSkillsLoading(true)
    const binding = harnessFeatureBindingRef.current
    const targetProjectId = binding?.projectId ?? null
    setSkillsLoadTargetProjectId(targetProjectId)
    try {
      const pluginSkillsPromise =
        typeof window.api.skills.listPlugins === "function"
          ? window.api.skills.listPlugins().catch((error) => {
              console.warn("[ChatContainer] Failed to load plugin skills:", error)
              return []
            })
          : Promise.resolve([])
      // Pull plugin skills alongside built-in/custom so the slash popover and
      // welcome-screen skill cards can surface them. Plugin-shipped skills go
      // through their own enable/disable lifecycle (plugin-level, not the
      // disabled-skills list), and listPlugins() already filters by
      // plugin.enabled, so we don't apply disabledSet to them here.
      const [loadedSkills, pluginSkills, disabledList] = await Promise.all([
        window.api.skills.list(),
        pluginSkillsPromise,
        window.api.skills.getDisabled()
      ])
      const disabledSet = new Set(disabledList.map(normalizeSkillId))
      setDisabledSkillIds(disabledSet)
      const availableSkills = loadedSkills.filter(
        (s) => s.source === "project" || s.source === "user"
      )

      // In harness mode, resolve the project's bound plugin so slash surfaces
      // only expose standalone skills and skills owned by that plugin.
      let preferredPlugin: { id?: string; name?: string } | null = null
      if (binding && typeof window.api.harnessBoard?.listProjects === "function") {
        try {
          const projects = await window.api.harnessBoard.listProjects()
          const project = projects.find((p) => p.projectId === binding.projectId)
          if (project) {
            preferredPlugin = {
              id: project.harnessAdapter.id,
              name: project.harnessAdapter.name
            }
          }
        } catch {
          // Non-critical: fall through without a preference.
        }
      }

      // Keep same-name standalone/plugin rows visible outside harness mode; in
      // harness mode, plugin skills are restricted to the bound plugin.
      const merged = mergeChatSkills(availableSkills, pluginSkills, disabledSet, preferredPlugin)
      setSkills([...merged].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")))
      setSkillsHarnessProjectId(targetProjectId)
      setSkillsHarnessPreferredPlugin(preferredPlugin)
    } catch (error) {
      console.error("[ChatContainer] Failed to load skills:", error)
      setSkills([])
      setSkillsHarnessProjectId(null)
      setSkillsHarnessPreferredPlugin(null)
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  const queryRemoteSkills = useCallback(async () => {
    try {
      const { allSkills, goodSkills } = await loadMarketSkillsSnapshot()
      allSkillsRef.current = allSkills
      setMarketSkillsData(allSkills)
      setGoodSkillsData(goodSkills)

      const installed = await installFeaturedSkillsOnce(goodSkills)
      if (installed) {
        await loadSkills()
      }
    } catch (error) {
      console.error("Failed to query remote skills:", error)
    }
  }, [loadSkills])

  const getSkillShowLabel = useCallback((name: string): string => {
    const target = allSkillsRef.current?.find((it) => it.name === name || it.chinese_name === name)
    return target?.chinese_name || name || ""
  }, [])

  const getTargetRemoteSkill = useCallback((name: string) => {
    const target = allSkillsRef.current?.find((it) => it.name === name || it.chinese_name === name)
    return target?.guidance || ""
  }, [])

  // Get persisted thread state and actions from context
  const {
    messages: threadMessages,
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
    coordinatorWorkers,
    workflowRun,
    scheduledTaskLoading,
    historyLoading,
    scheduledTaskId,
    modelRetry,
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
    refreshGoalUi,
    setError,
    clearError,
    clearHookInterruption,
    setContextReminder,
    setDraftInput: setInput,
    setHarnessNextActionDialogTips,
    setDraftSkill: setSelectedSkill
  } = useCurrentThread(threadId)

  const storedHarnessNextActionDialogTips = harnessNextActionDialogTips?.trim() || null
  const systemConstraintCounts = getSystemConstraintsLoadCounts(harnessAgentmdLoadStatus)
  const systemConstraintsLoadFailed = hasNoLoadedSystemConstraints(harnessAgentmdLoadStatus)
  const systemConstraintsPromptPreview = harnessAgentmdLoadStatus?.promptPreview?.trim()
  const showSystemConstraintsButton = surface === "harness-project"
  const systemConstraintsTitle =
    systemConstraintsLoadFailed
      ? `系统约束未加载 ${systemConstraintCounts.loaded}/${systemConstraintCounts.total}，点击查看详情`
      : systemConstraintCounts.total > 0
      ? `系统约束已加载 ${systemConstraintCounts.loaded}/${systemConstraintCounts.total}，点击查看详情`
      : "系统约束，点击查看详情"
  const systemConstraintsLabel =
    systemConstraintsLoadFailed
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
    if (!shouldShowHarnessDialogTips || !harnessDialogTipsProjectId || !harnessDialogTipsSlug) {
      setHarnessDialogTips(null)
      return
    }

    const nextActionDialogTips = pendingHarnessDialogTips ?? storedHarnessNextActionDialogTips
    if (nextActionDialogTips) {
      setHarnessDialogTips(nextActionDialogTips)
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
    }
  }, [
    harnessDialogTipsProjectId,
    harnessDialogTipsSlug,
    pendingHarnessDialogTips,
    shouldShowHarnessDialogTips,
    storedHarnessNextActionDialogTips
  ])

  // Hook logs live in an external store so updates don't re-render the full provider tree.
  // Per-turn buckets are keyed by the user message id that opened the turn,
  // so the chip rendered under each user message can pull its own bucket.
  const threadContext = useThreadContext()
  const hookLogBuckets = useSyncExternalStore(
    useCallback((cb) => threadContext.subscribeToHookLogs(threadId, cb), [threadContext, threadId]),
    useCallback(() => threadContext.getHookLogBuckets(threadId), [threadContext, threadId])
  )

  const hookLogBucketByTurnId = useMemo(() => {
    const map = new Map<string, HookLogBucket>()
    for (const bucket of hookLogBuckets) map.set(bucket.turnId, bucket)
    return map
  }, [hookLogBuckets])
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

  const canChangeAgentMode = !historyLoading && threadMessages.length === 0
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
      : "当前线程已有消息，执行模式已锁定，请新开线程切换。"
    : isLoading
      ? "当前请求执行中，结束后才能切换执行模式。"
      : undefined

  const handleAgentModeChange = useCallback(
    (nextMode: ChatAgentMode): void => {
      const previousMode = agentMode
      void (async () => {
        if (disableCoordinatorModeOption && nextMode === "coordinator") {
          toast.error("项目模式暂不支持子代理协同，只能使用 Solo Agent。")
          return
        }
        if (disableWorkflowModeOption && nextMode === "workflow") {
          toast.error("项目模式暂不支持 Workflow，只能使用 Solo Agent。")
          return
        }
        if (historyLoading) {
          toast.error("会话历史加载中，暂时不能切换执行模式。")
          return
        }
        if (threadMessages.length > 0) {
          toast.error("当前线程已有消息，不能再切换执行模式。请新开线程选择其他模式。")
          return
        }
        if (nextMode !== "coordinator" && !disableCoordinatorModeOption) {
          const isEnvironmentForcedCoordinator = await window.api.agent
            .isCoordinatorModeForced()
            .catch(() => false)
          if (isEnvironmentForcedCoordinator) {
            toast.error("当前环境变量强制开启 Agent Team，不能切换到其他执行模式")
            return
          }
          const [workers, hasPendingNotifications] = await Promise.all([
            window.api.agent
              .getCoordinatorWorkers(threadId, { subscribeUpdates: false })
              .catch(() => []),
            window.api.agent.hasCoordinatorWorkerNotifications(threadId).catch(() => false)
          ])
          const hasRemoteUnresolvedWorkers = workers.some(
            (worker) => worker.status === "running" || worker.notification_acknowledged === false
          )
          if (hasRemoteUnresolvedWorkers || hasPendingNotifications) {
            toast.error("仍有 Agent Team worker 在运行或结果待处理，请先处理完成后再切换执行模式")
            return
          }
        }

        agentModeHydratedRef.current = true
        setAgentMode(nextMode)
        const thread = await window.api.threads.get(threadId)
        const metadata = thread?.metadata ?? {}
        const nextMetadata: Record<string, unknown> = { ...metadata, agentMode: nextMode }
        if (nextMode !== "coordinator") {
          delete nextMetadata.coordinatorMode
        }
        await updateThread(threadId, {
          metadata: nextMetadata
        })
      })().catch((error) => {
        console.error("[ChatContainer] Failed to update agent mode:", error)
        agentModeHydratedRef.current = true
        setAgentMode(previousMode)
        toast.error("Agent 模式保存失败，请重试")
      })
    },
    [
      agentMode,
      disableCoordinatorModeOption,
      disableWorkflowModeOption,
      historyLoading,
      threadId,
      threadMessages,
      updateThread
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
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const attachmentsRef = useRef<FileAttachment[]>([])

  // Keep ref in sync with state
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const totalAttachmentChars = useMemo(
    () => attachments.reduce((sum, a) => sum + a.content.length, 0),
    [attachments]
  )

  const handleFileSelectByPath = useCallback(
    async (filePaths: string[]) => {
      if (filePaths.length === 0 || attachmentLoading) return
      setAttachmentLoading(true)
      clearError()
      try {
        const snapshot = attachmentsRef.current
        let currentCount = snapshot.length
        let currentChars = snapshot.reduce((sum, a) => sum + a.content.length, 0)
        const existingPaths = new Set(snapshot.map((a) => a.filePath))

        for (const filePath of filePaths) {
          // #7: skip duplicates
          if (existingPaths.has(filePath)) {
            const dupName = filePath.replace(/^.*[/\\]/, "") || filePath
            setError(`文件"${dupName}"已添加，跳过重复`)
            continue
          }

          // #6: check extension before calling backend
          const lastDot = filePath.lastIndexOf(".")
          const ext = lastDot >= 0 ? filePath.substring(lastDot).toLowerCase() : ""
          if (!ext || !SUPPORTED_EXTS.has(ext)) {
            const fileName = filePath.replace(/^.*[/\\]/, "") || filePath
            setError(`不支持的文件类型"${fileName}"，仅支持 txt、md、csv、docx、xlsx、xls`)
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
          const result = await window.api.file.parse(filePath, remaining)
          if (result.success && result.attachment) {
            // #12: skip empty files
            if (!result.attachment.content.trim()) {
              if (result.attachment.filename.includes(".doc")) {
                setError(
                  `文件 "${result.attachment.filename}" 内容为空，可尝试将文件用 WPS 另存为 docx 后添加`
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
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`)
      return
    }
    const result = await window.api.file.select()
    if (!result.canceled && result.filePaths.length > 0) {
      await handleFileSelectByPath(result.filePaths)
    }
  }, [handleFileSelectByPath, setError])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
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
        const paths = Array.from(files)
          .map((f) => window.api.file.getFilePath(f))
          .filter((p) => !!p)
        if (paths.length > 0) {
          await handleFileSelectByPath(paths)
        }
      }
    },
    [handleFileSelectByPath, attachmentLoading]
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
    if (!currentModel || !currentModel.startsWith("custom:")) {
      setModelContextLimit(undefined)
      return
    }
    let ignore = false
    const id = currentModel.replace("custom:", "")
    window.api.models
      .getCustomConfigs()
      .then((configs) => {
        if (ignore) return
        const match = configs.find((c) => c.id === id)
        setModelContextLimit(match?.maxTokens)
      })
      .catch(() => {
        if (!ignore) setModelContextLimit(undefined)
      })
    return () => {
      ignore = true
    }
  }, [currentModel])

  useEffect(() => {
    queryRemoteSkills()
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
  }, [queryRemoteSkills])

  const uploadLoChatDataForThread = useCallback(
    async (targetThreadId: string, msgs: Message[], attempt = 0) => {
      const lastMsg = msgs[msgs.length - 1]
      if (!lastMsg || lastMsg.role === "user") return

      let lUidx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          lUidx = i
          break
        }
      }
      if (lUidx === -1) return

      const tailMessages = msgs.slice(lUidx)
      const reservedIds = reserveChatReportMessageIds(
        targetThreadId,
        tailMessages.map((msg) => msg.id)
      )
      if (reservedIds.length === 0) return

      const payload: ChatReportPayload[] = tailMessages.map((msg) => ({
        role: msg.role,
        content: stringifyMessageContentForReport(msg.content)
      }))
      try {
        await uploadChatData(targetThreadId, payload)
        markChatReportUploadSucceeded(targetThreadId, reservedIds)
      } catch (error) {
        markChatReportUploadFailed(targetThreadId, reservedIds)
        if (attempt < CHAT_REPORT_MAX_RETRY_ATTEMPTS) {
          const retryQueue = (chatReportRetryQueuesRef.current[targetThreadId] ??= [])
          retryQueue.push({ messages: tailMessages, attempt: attempt + 1 })
          if (!chatReportRetryTimersRef.current[targetThreadId]) {
            const retryThreadId = targetThreadId
            const retryDelayMs = Math.min(CHAT_REPORT_RETRY_DELAY_MS * 2 ** attempt, 30_000)
            chatReportRetryTimersRef.current[retryThreadId] = window.setTimeout(() => {
              delete chatReportRetryTimersRef.current[retryThreadId]
              const retryItems = chatReportRetryQueuesRef.current[retryThreadId]?.splice(0) ?? []
              for (const retryItem of retryItems) {
                void uploadLoChatDataForThread(retryThreadId, retryItem.messages, retryItem.attempt)
              }
            }, retryDelayMs)
          }
        }
        console.warn("[Upload] chat数据上报失败:", error)
      }
    },
    []
  )

  const scheduleChatReportUpload = useCallback(
    (targetThreadId: string, msgs: Message[]) => {
      const existingTimer = chatReportUploadTimersRef.current[targetThreadId]
      if (existingTimer) window.clearTimeout(existingTimer)
      const messagesForUpload = msgs.slice()
      chatReportUploadTimersRef.current[targetThreadId] = window.setTimeout(() => {
        delete chatReportUploadTimersRef.current[targetThreadId]
        void uploadLoChatDataForThread(targetThreadId, messagesForUpload)
      }, CHAT_REPORT_UPLOAD_DEBOUNCE_MS)
    },
    [uploadLoChatDataForThread]
  )

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
    async (
      decision: "approve" | "approve_session" | "approve_permanent" | "reject" | "edit"
    ): Promise<void> => {
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
            configurable: { thread_id: threadId, model_id: currentModel, agent_mode: agentMode }
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
    if (
      approvalRecord._orchestratorRequestId &&
      approvalRecord.operation === "git_push"
    ) {
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
    if (isLoading) {
      setGlowVisible(true)
      return
    }
    // 兜底：如果 transitionEnd 未触发（快速切换等边界情况），3s 后强制隐藏
    const timer = setTimeout(() => setGlowVisible(false), 3000)
    return () => clearTimeout(timer)
  }, [isLoading])

  const displayMessages = useMemo(() => {
    const threadMessageIds = new Set(threadMessages.map((m) => m.id))
    const streamingMsgs: Message[] = (streamData.liveMessages || [])
      .filter((m): m is StreamMessage & { id: string } => !!m.id && !threadMessageIds.has(m.id))
      .filter((m) => !(m.type === "human" && isCoordinatorNotificationPrompt(m.content)))
      .map((streamMsg) => {
        const role = liveStreamMessageRole(streamMsg.type)

        return {
          id: streamMsg.id,
          role,
          content: normalizeLiveStreamMessageContent(streamMsg.content),
          tool_calls: streamMsg.tool_calls,
          ...(role === "tool" &&
            streamMsg.tool_call_id && { tool_call_id: streamMsg.tool_call_id }),
          ...(role === "tool" && streamMsg.name && { name: streamMsg.name }),
          ...(role === "tool" &&
            streamMsg.is_error !== undefined && { is_error: streamMsg.is_error }),
          created_at: new Date(),
          ...(streamMsg.start_at && { start_at: streamMsg.start_at }),
          ...(streamMsg.end_at && { end_at: streamMsg.end_at })
        }
      })

    // Clean up attachment XML tags in user messages for display
    const allMessages = [...threadMessages, ...streamingMsgs].filter(
      isVisibleCheckpointTranscriptMessage
    )
    const cleanedMessages = sortMessagesForDisplay(allMessages).map((msg) => {
      if (
        msg.role !== "user" ||
        typeof msg.content !== "string" ||
        !msg.content.includes("<attachment ")
      )
        return msg
      // Extract filenames and user text separately, then reorder: filenames first
      const fileNames: string[] = []
      const textOnly = msg.content
        .replace(
          /<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g,
          (_match, name) => {
            const decoded = name
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
            fileNames.push(`📎 ${decoded}`)
            return ""
          }
        )
        .trim()
      const cleaned =
        fileNames.length > 0 ? `${fileNames.join("\n")}\n\n${textOnly}`.trim() : textOnly
      return { ...msg, content: cleaned }
    })
    return filterCoordinatorNoiseMessages(cleanedMessages)
  }, [threadMessages, streamData.liveMessages])

  // Key that drives in-session search re-matching. Message count and isLoading
  // stay constant while tokens append to the SAME streaming message, so fold in
  // the last message's text length — otherwise search misses text that is still
  // being streamed until the run ends.
  const searchRecomputeKey = useMemo(() => {
    const last = displayMessages[displayMessages.length - 1]
    const lastTextLength = last ? getMessageText(last.content).length : 0
    return `${displayMessages.length}:${isLoading}:${lastTextLength}`
  }, [displayMessages, isLoading])

  const detachedHookLogBuckets = useMemo(() => {
    const userMessageIds = new Set(
      displayMessages.filter((message) => message.role === "user").map((message) => message.id)
    )
    return hookLogBuckets.filter(
      (bucket) => bucket.entries.length > 0 && !userMessageIds.has(bucket.turnId)
    )
  }, [displayMessages, hookLogBuckets])

  const lastContentMessageId = useMemo(() => {
    // Match what actually renders: empty messages are skipped from the DOM
    // (see messageRendersNothing), so they own no contentMessageRefs entry and
    // must not be returned here, or precise scroll alignment would silently fall
    // back to scroll-to-bottom.
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
      const message = displayMessages[index]
      if (!messageRendersNothing(message)) return message.id
    }
    return null
  }, [displayMessages])

  // Per-message derived flags precomputed in a single O(n) reverse pass. The
  // render loop previously recomputed these with `slice().find/some` for every
  // message, which is O(n^2) on every render (and renders fire on every
  // streaming token). Here we walk right-to-left once, tracking the nearest
  // non-tool message role and whether a later user message exists.
  const perMessageFlags = useMemo(() => {
    const n = displayMessages.length
    const showAssistantMeta: boolean[] = new Array(n)
    const hasUserAfterHead: boolean[] = new Array(n)
    let nextNonToolRole: string | null = null
    let userAfter = false
    for (let index = n - 1; index >= 0; index -= 1) {
      const message = displayMessages[index]
      hasUserAfterHead[index] = userAfter
      showAssistantMeta[index] =
        message.role !== "assistant" || nextNonToolRole === null || nextNonToolRole !== "assistant"
      if (message.role === "user") userAfter = true
      if (message.role !== "tool") nextNonToolRole = message.role
    }
    return { showAssistantMeta, hasUserAfterHead }
  }, [displayMessages])

  // Build tool results map from tool messages
  const toolResults = useMemo(() => {
    const results = new Map<string, { content: string | unknown; is_error?: boolean }>()
    for (const msg of displayMessages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        results.set(msg.tool_call_id, {
          content: msg.content,
          is_error: msg.is_error
        })
      }
    }
    return results
  }, [displayMessages])

  const { assistantDurationMsById, userSendTimeLabelById } = useMemo(
    () => buildMessageBubbleTimingMeta(displayMessages),
    [displayMessages]
  )

  const toolCallDisplayStates = useMemo(() => {
    const orderedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
    const seenToolCallIds = new Set<string>()

    for (const message of displayMessages) {
      if (!Array.isArray(message.tool_calls)) continue
      for (const toolCall of message.tool_calls) {
        if (!toolCall?.id || seenToolCallIds.has(toolCall.id)) continue
        seenToolCallIds.add(toolCall.id)
        orderedToolCalls.push(toolCall)
      }
    }

    const currentApprovalIds = new Set<string>()
    if (pendingApproval?.pendingToolCallIds?.length) {
      for (const id of pendingApproval.pendingToolCallIds) {
        if (id) currentApprovalIds.add(id)
      }
    } else if (pendingApproval?.tool_call?.id) {
      currentApprovalIds.add(pendingApproval.tool_call.id)
    }

    let activeAssigned = false
    const nextStates = new Map<string, ToolCallState>()

    for (const toolCall of orderedToolCalls) {
      const baseState = toolCallStates[toolCall.id]
      const mergedArgs = mergeToolCallArgs(baseState?.args, toolCall.args)
      const result = toolResults.get(toolCall.id)
      let status: ToolCallStatus

      if (result !== undefined) {
        status = result.is_error ? "failed" : "completed"
      } else if (isTerminalToolCallStatus(baseState?.status)) {
        status = baseState.status
      } else if (currentApprovalIds.has(toolCall.id)) {
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

      nextStates.set(toolCall.id, {
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

    return nextStates
  }, [displayMessages, isLoading, pendingApproval, toolCallStates, toolResults])

  // Get the actual scrollable viewport element from Radix ScrollArea
  const getViewport = useCallback((): HTMLDivElement | null => {
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [])

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
    if (!pendingApproval) return
    const viewport = getViewport()
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [pendingApproval, getViewport])

  useEffect(() => {
    if (!pendingUserInput || !userInputDialogLayout) return
    const viewport = getViewport()
    if (!viewport) return

    const frame = requestAnimationFrame(() => {
      const targetElement = lastContentMessageId
        ? contentMessageRefs.current.get(lastContentMessageId)
        : null
      const viewportRect = viewport.getBoundingClientRect()
      const targetBottom = Math.max(viewportRect.top + 24, userInputDialogLayout.top - 12)

      if (targetElement) {
        const targetRect = targetElement.getBoundingClientRect()
        const scrollDelta = targetRect.bottom - targetBottom
        if (Math.abs(scrollDelta) > 1) {
          viewport.scrollTop = Math.max(0, viewport.scrollTop + scrollDelta)
        }
      } else {
        viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      }
    })

    return () => cancelAnimationFrame(frame)
  }, [
    getViewport,
    lastContentMessageId,
    pendingUserInput,
    userInputDialogLayout?.height,
    userInputDialogLayout?.top
  ])


  //  滚动到底部
  // 1.初始化
  // 2.切换thread
  useEffect(() => {
    const viewport = getViewport()
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [getViewport, historyLoading, threadId])


  // stream 输出的过程中，如果用户正处于底部，那么继续保持底部
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return
    const bottomDistance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (bottomDistance <= 200) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    }
  }, [streamData, isLoading])

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

    if (!harnessFeatureBinding) return
    if (!userMessage && !slashSkill) {
      if (nextAction?.dialogTips) consumePendingHarnessNextAction(threadId)
      return
    }
    if (historyLoading) return
    if (threadMessages.length > 0 || input.trim() || selectedSkill) {
      consumePendingHarnessNextAction(threadId)
      return
    }

    let nextSkill: SkillMetadata | null = null
    if (slashSkill) {
      if (skillsLoading) return
      if (skillsLoadTargetProjectId !== harnessFeatureBinding.projectId) return
      if (skillsHarnessProjectId === harnessFeatureBinding.projectId) {
        nextSkill = selectSkillForSlashName(
          enabledSkillsForSlash,
          slashSkill,
          skillsHarnessPreferredPlugin
        )
      }
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
    skillSelected: selectedSkill !== null
  })
  const slashPopoverKind = slash.mode.kind
  const hasPendingGoalTransportPayload = attachments.length > 0 || selectedSkill !== null
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
  const effectiveComposerControlsDisabled = composerControlsDisabled || contextReminderPending || readOnly
  const inputPlaceholder = useMemo(() => {
    if (readOnlyReason) return readOnlyReason
    if (contextReminderPending) return "请先处理上下文提醒"
    const goal = goalUi.goal
    if (isLoading) {
      if (streamData.isLoading && !scheduledTaskLoading && hasActiveGoalRunning) {
        return "Goal 运行中：可输入 /goal status、/goal pause、/goal clear"
      }
      if (streamData.isLoading && !scheduledTaskLoading) {
        return "任务运行中，可先编辑草稿，完成后再发送"
      }
      return "任务运行中，可使用取消按钮停止当前任务"
    }
    if (attachments.length > 0) return "输入消息或直接发送文件..."
    if (!goal) return "向 CMBDevClaw 提问，/ 输入命令；Shift + Enter 换行"
    if (goal.status === "active") {
      return "输入新消息会暂停当前 Goal；查看详情用 /goal status"
    }
    if (goal.status === "paused") {
      return "补充说明，或点击继续 Goal"
    }
    return "输入新问题，或用 /goal <目标> 开始新的长期任务"
  }, [
    attachments.length,
    contextReminderPending,
    goalUi.goal,
    hasActiveGoalRunning,
    goalControlAllowedWhileLoading,
    isLoading,
    readOnlyReason,
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

  // Depend on the stable callback refs, not the whole `slash` object —
  // the hook returns a fresh literal every render, which would re-create
  // applySkillSelection each keystroke and cascade into popover rerenders.
  const slashResetSelection = slash.resetSelection
  const applySkillSelection = useCallback(
    (s: SkillMetadata) => {
      setSelectedSkill(s)
      setInput("")
      slashResetSelection()
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [setInput, slashResetSelection, setSelectedSkill]
  )

  const applySlashCommand = useCallback(
    (command: SlashCommandItem) => {
      const nextInput = command.insertText
      setInput(nextInput)
      slashResetSelection()
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = nextInput.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [setInput, slashResetSelection]
  )

  const appendVisibleUserMessageWithTime = useCallback(
    async (content: string, options: { persistTiming?: boolean } = {}): Promise<Message> => {
      const userStartAt = new Date()
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        created_at: userStartAt,
        start_at: userStartAt,
        end_at: userStartAt
      }
      appendMessage(userMessage)
      if (options.persistTiming === false) return userMessage

      const userMessageTime: MessageTimeMap = {
        [userMessage.id]: {
          start_at: userStartAt.toISOString(),
          end_at: userStartAt.toISOString()
        }
      }
      try {
        await window.api.threads.mergeThreadValues(threadId, {
          [MESSAGE_TIMES_THREAD_VALUE_KEY]: userMessageTime,
          [MESSAGE_TIME_ORDER_THREAD_VALUE_KEY]: messageTimeOrderEntries(userMessageTime)
        })
      } catch (error) {
        console.warn("[ChatContainer] Failed to save user message time:", error)
      }
      return userMessage
    },
    [appendMessage, getViewport, threadId]
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
      setSelectedSkill(null)
      insertLog("send: /goal resume")
      await appendVisibleUserMessageWithTime("/goal resume", { persistTiming: false })
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

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmedInput = input.trim()
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
    if (
      (!trimmedInput && attachments.length === 0 && !selectedSkill) ||
      historyLoading ||
      (isLoading && !allowSubmitWhileLoading) ||
      !stream
    )
      return

    const goalControlWithPendingTransport =
      hasPendingGoalTransportPayload &&
      isGoalSlashTransportSensitiveControlCommandInput(trimmedInput)
    if (goalControlWithPendingTransport) {
      setError(
        "附件和显式技能不会用于 /goal 控制命令。请先移除附件/技能，或改成 /goal <目标/完成条件>。"
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

    const shouldLockSubmit = shouldUseSubmitInFlightLock({ isSideChannelGoalControl })
    if (!tryAcquireSubmitInFlightLock(submitInFlightRef, shouldLockSubmit, threadId)) return

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

      // Reset both the error message and its structured detail at turn start so
      // no stale diagnostics linger into the new turn.
      if (threadError || errorDetail) {
        clearError()
      }

      if (pendingApproval || approvalQueue.length > 0) {
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

      // Snapshot the skill selection before we clear it — synchronous path, no
      // async gap, so no token/stillOurs needed.
      const skill = selectedSkill
      const rawMessage = trimmedInput
      const currentAttachments = attachments.length > 0 ? [...attachments] : undefined
      // If user only uploaded files without text, add a default prompt.
      // skill-only sends (text empty, no attachments) still fall into this branch
      // because the default prompt requires attachments — for skill-only we let
      // userText stay empty and rely on the trailing skill-use block as the signal.
      // When a skill is active we also skip the default prompt: the skill's own
      // instruction will tell the model what to do with the attachment, and a
      // generic "请分析以下文件内容" would compete with it.
      const userText = rawMessage || (currentAttachments && !skill ? "请分析以下文件内容。" : "")
      setInput("")
      setAttachments([])
      if (skill) setSelectedSkill(null)
      if (shouldOpenGoalDetailsForStatus) {
        setGoalDetailsOpen(true)
      }
      insertLog("send: " + (userText || (skill ? `[skill-only: ${skill.name}]` : "")))

      const isFirstMessage = threadMessages.length === 0
      // Keep real user intent visible in the transcript. Goal status/pause/clear
      // are side-channel controls, but `/goal <objective>` and `/goal resume`
      // are user turns and should appear immediately in live UI.
      const shouldAppendVisibleUserMessage = !bypassGoalControlValidation

      // Build the full message with attachments as XML tags (sent to model)
      let fullMessage = userText
      if (currentAttachments && currentAttachments.length > 0) {
        const attachmentTexts = currentAttachments.map((att) => {
          const truncAttr = att.truncated ? ' truncated="true"' : ""
          const pathAttr = att.filePath ? ` path="${escXml(att.filePath)}"` : ""
          const safeContent = att.content.replace(/<\/attachment>/gi, "< /attachment>")
          return `\n\n<attachment filename="${escXml(att.filename)}"${pathAttr} type="${att.mimeType}" size="${att.size}"${truncAttr}>\n${safeContent}\n</attachment>`
        })
        fullMessage = userText + attachmentTexts.join("")
      }

      // Append the skill-use block at the very end. The model is told to `read`
      // the SKILL.md on its own — we don't inline the body. Hooks/routing/memory
      // see this block verbatim; they don't need to know it's a slash command.
      // join(\n\n) on filtered parts avoids leading blank lines when the user
      // sends a skill with no text or attachments (skill-only invocation).
      const skillBlock = skill
        ? formatSkillUseBlock({
            name: skill.name,
            path: skill.path,
            description: skill.description,
            metadata: skill.metadata,
            allowedTools: skill.allowedTools
          })
        : ""
      fullMessage = [fullMessage, skillBlock].filter(Boolean).join("\n\n")

      // displayContent is what the user sees in their bubble while this run is
      // in-memory. It carries the trailing skill block so MessageBubble's
      // tail-anchored parser can render the chip and strip it back out.
      //
      // Note: the *checkpointed* version of this message is `fullMessage` (the
      // full payload sent to the model, including <attachment>…</attachment>
      // bodies), not displayContent. After a thread reload, MessageBubble
      // therefore renders chip + raw attachment XML instead of chip + 📎 names.
      // That replay-vs-live divergence is a pre-existing limitation of the
      // attachment pipeline and is not introduced by the slash-command code.
      let displayContent: string = userText
      if (currentAttachments && currentAttachments.length > 0) {
        const fileNames = currentAttachments.map((a) => `📎 ${a.filename}`).join("\n")
        displayContent = `${fileNames}\n\n${userText}`
      }
      displayContent = [displayContent, skillBlock].filter(Boolean).join("\n\n")
      if (
        /\[\[CMB_COORDINATOR_(?:WORKER_NOTIFICATION|INTERNAL_(?:CONTEXT|NOTIFICATION)_(?:START|END))\]\]/.test(
          displayContent
        )
      ) {
        displayContent = `用户输入的普通文本：\n\n${displayContent}`
      }

      const coordinatorPrefixed =
        !disableCoordinatorModeOption &&
        /^\s*(?:\[coordinator\]|#coordinator)\s*[:-]?/i.test(fullMessage)
      let submitAgentMode: ChatAgentMode = disableCoordinatorModeOption
        ? "normal"
        : coordinatorPrefixed
          ? "coordinator"
          : agentMode
      if (disableWorkflowModeOption && submitAgentMode === "workflow") {
        submitAgentMode = "normal"
      }
      if (!coordinatorPrefixed && !agentModeHydratedRef.current) {
        submitAgentMode = await loadResolvedAgentMode().catch((error) => {
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
      } else if (submitAgentMode === "coordinator" && agentMode !== "coordinator") {
        agentModeHydratedRef.current = true
        setAgentMode("coordinator")
      }

      let visibleUserMessage: Message | null = null
      if (shouldAppendVisibleUserMessage) {
        // 同步维护顺序数组，支持 app 重启后按消息顺序恢复历史耗时。user message 在前端先 append，
        // checkpoint 恢复时 id 可能不一定完全一致；因此仍需要顺序数组作为兜底。
        visibleUserMessage = await appendVisibleUserMessageWithTime(displayContent, {
          persistTiming: !isGoalSlashInput
        })
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
          const titleSource =
            (isGoalSlashInput ? goalTitleSource : userText) || (skill ? `使用 ${skill.name}` : "")
          if (titleSource) {
            generateTitleForFirstMessage(threadId, titleSource)
          }
        }
      }

      // 发送消息，滚动到底部
      const viewport = getViewport()
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
      }

      const startTime = Date.now()
      setActiveTurnStartTime(startTime)
      // A finished workflow panel belongs to the previous turn; drop it when a
      // new message goes out so it doesn't linger forever in the transcript.
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
                model_id: currentModel,
                agent_mode: submitAgentMode,
                ...(visibleUserMessage?.id ? { hook_turn_id: visibleUserMessage.id } : {})
              }
            }
          }
        )
      } finally {
        setActiveTurnStartTime(null)
      }
    } finally {
      releaseSubmitInFlightLock(submitInFlightRef, shouldLockSubmit, threadId)
    }
  }

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

    // Backspace at start of empty input removes the skill chip.
    // Skip while IME is composing — there Backspace edits the pinyin buffer,
    // not the textarea, and the user doesn't intend to drop the chip.
    if (e.key === "Backspace" && !isComposing && selectedSkill && input.length === 0) {
      e.preventDefault()
      setSelectedSkill(null)
      return
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const handleInsertNewline = useCallback((): void => {
    if (effectiveInputDisabled) return

    const textarea = inputRef.current
    const selectionStart = textarea?.selectionStart ?? input.length
    const selectionEnd = textarea?.selectionEnd ?? input.length
    const nextInput = `${input.slice(0, selectionStart)}\n${input.slice(selectionEnd)}`
    const nextCursor = selectionStart + 1

    setInput(nextInput)
    requestAnimationFrame(() => {
      const target = inputRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(nextCursor, nextCursor)
    })
  }, [effectiveInputDisabled, input, setInput])

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

  const handleCancel = async (): Promise<void> => {
    if (scheduledTaskLoading && scheduledTaskId) {
      try {
        await window.api.scheduledTasks.cancel(scheduledTaskId)
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel scheduled task:", err)
      }
    } else if (scheduledTaskLoading && threadId === "heartbeat") {
      try {
        await window.api.heartbeat.cancel()
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel heartbeat:", err)
      }
    } else if (scheduledTaskLoading) {
      // ChatX bot thread: scheduledTaskLoading is true but no scheduledTaskId
      try {
        const cancelled = await window.api.chatx.cancelByThread(threadId)
        if (!cancelled) console.warn("[ChatContainer] ChatX thread not found for cancel:", threadId)
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel ChatX thread:", err)
      }
    } else {
      // Match Claude Code coordinator semantics: the main stop button stops the
      // foreground turn only. Durable background workers are stopped explicitly
      // via the separate background-worker stop control.
      threadContext.suppressCoordinatorNotificationAutoRun(threadId)
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
  }, [loadSkills, pluginVersion, harnessFeatureBinding?.projectId])

  // Main broadcasts `skills:changed` after skill evolution writes, optimizer
  // patches, and plugin SKILL.md edits via the file editor. Subscribe so the
  // slash popover and welcome-tree get a fresh list without waiting for the
  // user to re-open `/` (which already triggers a re-fetch on its own).
  useEffect(() => {
    return window.api.skills.onChanged(() => {
      void loadSkills()
    })
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

  const getSkillSummary = useCallback(
    (skill: SkillMetadata): string => {
      const skillId = getSkillId(skill)

      // For custom skills, use the skill's name or description
      if (skill.source === "user") {
        return skill.name || skillId || "自定义技能"
      }

      // Built-in skill summaries
      const summaryMap: Record<string, string> = {
        "algorithmic-art": "生成艺术图案",
        "brand-guidelines": "统一品牌风格",
        "canvas-design": "设计视觉海报",
        docx: "编辑 Word 文档",
        "doc-coauthoring": "协作撰写文档",
        "frontend-design": "设计前端界面",
        "internal-comms": "撰写内部沟通稿",
        "mcp-builder": "搭建 MCP 服务",
        pdf: "处理 PDF 文档",
        pptx: "制作演示文稿",
        "skill-creator": "创建新技能包",
        "slack-gif-creator": "制作 Slack 动图",
        "theme-factory": "应用主题风格",
        "web-app-testing": "测试 Web 应用",
        "webapp-testing": "测试 Web 应用",
        "web-artifacts-builder": "构建交互页面",
        xlsx: "处理表格数据",
        "security-review": "安全代码审查",
        "code-review-expert": "结构化代码审查",
        "vercel-react-best-practices": "React 最佳实践",
        "audit-website": "网站安全审计",
        "supabase-postgres-best-practices": "PostgreSQL 优化",
        "typescript-advanced-types": "TS 高级类型优化",
        "api-design-principles": "API 设计原则",
        "architecture-patterns": "架构模式设计",
        "error-handling-patterns": "错误处理模式",
        "planning-with-files": "文件驱动规划",
        "scheduler-assistant": "定时任务管理"
      }
      return summaryMap[skillId] || "完成专项任务"
    },
    [getSkillId]
  )

  const getSkillIcon = useCallback(
    (skill: SkillMetadata): React.JSX.Element => {
      const skillId = getSkillId(skill)
      const iconMap: Record<string, React.JSX.Element> = {
        "algorithmic-art": <Palette className="size-4" />,
        "brand-guidelines": <Palette className="size-4" />,
        "canvas-design": <LayoutTemplate className="size-4" />,
        docx: <FileText className="size-4" />,
        "doc-coauthoring": <FileText className="size-4" />,
        "frontend-design": <LayoutTemplate className="size-4" />,
        "internal-comms": <FileText className="size-4" />,
        "mcp-builder": <Code2 className="size-4" />,
        pdf: <FileText className="size-4" />,
        pptx: <Presentation className="size-4" />,
        "skill-creator": <Settings2 className="size-4" />,
        "slack-gif-creator": <FlaskConical className="size-4" />,
        "theme-factory": <Palette className="size-4" />,
        "web-app-testing": <FlaskConical className="size-4" />,
        "webapp-testing": <FlaskConical className="size-4" />,
        "web-artifacts-builder": <LayoutTemplate className="size-4" />,
        xlsx: <FileSpreadsheet className="size-4" />,
        "security-review": <Code2 className="size-4" />,
        "code-review-expert": <Code2 className="size-4" />,
        "vercel-react-best-practices": <Code2 className="size-4" />,
        "audit-website": <ShieldCheck className="size-4" />,
        "supabase-postgres-best-practices": <Database className="size-4" />,
        "typescript-advanced-types": <Code2 className="size-4" />,
        "api-design-principles": <Layers className="size-4" />,
        "architecture-patterns": <Layers className="size-4" />,
        "error-handling-patterns": <AlertCircle className="size-4" />,
        "planning-with-files": <FileText className="size-4" />,
        "scheduler-assistant": <Clock className="size-4" />
      }
      return iconMap[skillId] || <Search className="size-4" />
    },
    [getSkillId]
  )

  const programmingSkillIds = useMemo(
    () =>
      new Set([
        "security-review",
        "code-review-expert",
        "vercel-react-best-practices",
        "audit-website",
        "supabase-postgres-best-practices",
        "typescript-advanced-types",
        "api-design-principles",
        "architecture-patterns",
        "error-handling-patterns",
        "planning-with-files",
        "mcp-builder",
        "webapp-testing",
        "frontend-design"
      ]),
    []
  )

  const isProgrammingSkill = useCallback(
    (skill: SkillMetadata): boolean => programmingSkillIds.has(getSkillId(skill)),
    [getSkillId, programmingSkillIds]
  )

  const { generalSkills, programmingSkills, enabledCustomSkills, disabledLocalSkills } =
    useMemo(() => {
      return groupWelcomeSkills(skills, goodSkillsData, isLocalSkillDisabled, isProgrammingSkill)
    }, [skills, isLocalSkillDisabled, isProgrammingSkill, goodSkillsData])

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

  const programmingSkillCards = useMemo(() => {
    const source = showAllProgrammingSkills ? programmingSkills : programmingSkills.slice(0, 8)
    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill)
    }))
  }, [showAllProgrammingSkills, programmingSkills, getSkillSummary, getSkillIcon])

  const marketSkillCategoryByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of marketSkillsData) {
      if (!item.category) continue
      map.set(item.name, item.category)
      if (item.chinese_name) map.set(item.chinese_name, item.category)
    }
    return map
  }, [marketSkillsData])

  const marketSkillUpdateByName = useMemo(() => {
    // 把市场技能列表转换成“技能名 -> 更新信息”的索引，供“我安装的技能”tab 快速匹配。
    // 同时写入英文名和中文名两种 key，是因为本地技能元数据和市场展示数据可能使用不同名称。
    const map = new Map<
      string,
      {
        installedVersion?: string
        currentVersion?: string | null
        updateAvailable: boolean
        displayName: string
      }
    >()

    for (const item of marketSkillsData) {
      // 这里复用 MarketPanel 的版本比较规则：
      // 只有本地已记录安装版本、市场也返回版本，并且两者不一致时才显示“有更新”。
      const flags = buildMarketInstalledFlags(item, "skill", true)
      const updateInfo = {
        installedVersion: flags.installedVersion,
        currentVersion: item.version,
        updateAvailable: flags.updateAvailable,
        displayName: item.chinese_name || item.name
      }
      map.set(item.name, updateInfo)
      if (item.chinese_name) map.set(item.chinese_name, updateInfo)
    }

    return map
  }, [marketSkillsData])

  const getSkillMarketUpdateInfo = useCallback(
    (skill: SkillMetadata) => {
      // 优先按本地技能名匹配市场条目；少数技能名来自目录路径时，再用 relativePath 兜底。
      return (
        marketSkillUpdateByName.get(skill.name) ||
        (skill.relativePath ? marketSkillUpdateByName.get(skill.relativePath) : undefined) ||
        null
      )
    },
    [marketSkillUpdateByName]
  )

  const getSkillSceneCategory = useCallback(
    (skill: SkillMetadata): string => {
      const category =
        skill.metadata?.category ||
        marketSkillCategoryByName.get(skill.name) ||
        DEFAULT_SCENE_CATEGORY
      return category.trim() || DEFAULT_SCENE_CATEGORY
    },
    [marketSkillCategoryByName]
  )

  const buildWelcomeSkillGroups = useCallback(
    (sourceSkills: SkillMetadata[]): WelcomeSkillSceneGroup[] => {
      const groups = new Map<string, WelcomeSkillCard[]>()
      for (const skill of sourceSkills) {
        const category = getSkillSceneCategory(skill)
        const cards = groups.get(category) ?? []
        cards.push({
          skill,
          label: getSkillSummary(skill),
          icon: getSkillIcon(skill),
          // 将市场版本信息挂到技能卡片上，树形渲染时即可决定是否展示“有更新”标识。
          ...getSkillMarketUpdateInfo(skill)
        })
        groups.set(category, cards)
      }

      const categoryOrder = new Map<string, number>(
        SCENE_CATEGORY_OPTIONS.map((category, index) => [category, index])
      )
      return [...groups.entries()]
        .sort(([a], [b]) => {
          const rankA = categoryOrder.get(a) ?? Number.MAX_SAFE_INTEGER
          const rankB = categoryOrder.get(b) ?? Number.MAX_SAFE_INTEGER
          return rankA === rankB ? a.localeCompare(b, "zh-CN") : rankA - rankB
        })
        .map(([category, cards]) => ({ category, cards }))
    },
    [getSkillIcon, getSkillMarketUpdateInfo, getSkillSceneCategory, getSkillSummary]
  )

  const enabledCustomSkillGroups = useMemo(() => {
    const source = showAllCustomSkills
      ? enabledCustomSkills
      : limitWelcomeSkillsByTopLevel(enabledCustomSkills, 8)
    return buildWelcomeSkillGroups(source)
  }, [buildWelcomeSkillGroups, enabledCustomSkills, showAllCustomSkills])

  const disabledCustomSkillGroups = useMemo(
    () => buildWelcomeSkillGroups(disabledLocalSkills),
    [buildWelcomeSkillGroups, disabledLocalSkills]
  )
  const customSkillUpdates = useMemo(
    () =>
      // 统计已启用和已禁用的用户技能中有哪些存在市场新版本，用于 tab 上显示更新数量；
      // 这里只计算数量和卡片标识，不弹 toast，避免进入会话时打扰用户。
      [...enabledCustomSkills, ...disabledLocalSkills]
        .map((skill) => ({
          skill,
          updateInfo: getSkillMarketUpdateInfo(skill)
        }))
        .filter((entry) => entry.updateInfo?.updateAvailable),
    [disabledLocalSkills, enabledCustomSkills, getSkillMarketUpdateInfo]
  )
  const customSkillUpdateCount = customSkillUpdates.length

  const helpSceneSkillIds = useMemo(() => new Set(["scheduler-assistant", "skill-creator"]), [])
  const helpSceneSkillCards = useMemo(() => {
    return generalSkills
      .filter((skill) => helpSceneSkillIds.has(getSkillId(skill)))
      .map((skill) => ({
        skill,
        label: getSkillSummary(skill),
        icon: getSkillIcon(skill)
      }))
  }, [generalSkills, helpSceneSkillIds, getSkillId, getSkillSummary, getSkillIcon])

  const handleUseSkillPrompt = useCallback(
    (skill: SkillMetadata, label?: string): void => {
      const custPrompt = label ? getTargetRemoteSkill(label) : ""
      const prompt = buildSkillPrompt(skill)
      setInput(custPrompt || prompt)
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = prompt.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [buildSkillPrompt, setInput, getTargetRemoteSkill]
  )

  const handleCopyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast.success("已复制目标链接到剪切板，请在浏览器中打开查看")
      },
      (err) => {
        console.error("Failed to copy text: ", err)
        toast.error("复制失败，请重试")
      }
    )
  }, [])

  const welcomePane = useMemo(() => {
    if (displayMessages.length !== 0 || isLoading || historyLoading) return null

    return (
      <div className="pt-6 pb-8">
        {shouldShowHarnessDialogTips && harnessDialogTips ? (
          <DialogTipsMarkdown content={harnessDialogTips} />
        ) : !shouldShowWelcomeHeadline || harnessFeatureBinding ? null : (
          <RotatingHeadline />
        )}
        {skillsLoading ? (
          <div className="text-sm text-muted-foreground text-center py-10">
            正在加载技能列表...
          </div>
        ) : skills.length === 0 ? null : (
          <div className="space-y-3">
            {programmingSkillCards.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground font-medium tracking-wider">
                  编程场景
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {programmingSkillCards.map(({ skill, label, icon }) => (
                    <button
                      key={label + skill.path}
                      type="button"
                      onClick={() => handleUseSkillPrompt(skill)}
                      className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                          {icon}
                        </div>
                        <div className="text-xs text-foreground leading-5">{label}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {programmingSkills.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllProgrammingSkills((prev) => !prev)}
                    className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                  >
                    {showAllProgrammingSkills ? (
                      <>
                        <ChevronUp className="size-3.5" />
                        <span>收起</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3.5" />
                        <span>展开更多（+{programmingSkills.length - 8}）</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
            {shouldShowWelcomeSkillTabs && (
              <Tabs defaultValue="skills-by-category" className="space-y-3">
                <TabsList className="grid h-9 w-full grid-cols-3">
                  <TabsTrigger value="skills-by-category" className="text-xs">
                    场景技能
                  </TabsTrigger>
                  <TabsTrigger value="installed-skills" className="text-xs gap-1.5">
                    我安装的技能
                    {customSkillUpdateCount > 0 && (
                      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-teal-100 px-1 text-[10px] font-semibold leading-none text-teal-700 dark:bg-teal-900/40 dark:text-teal-200">
                        {customSkillUpdateCount}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="help" className="text-xs">
                    帮助
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="skills-by-category" className="mt-0">
                  <SkillsByCategorySection
                    skills={enabledSkillsForSlash}
                    previewLimit={GOOD_SKILLS_PREVIEW_LIMIT}
                    onOpenMarketByCategory={handleOpenMarketBySecondaryCategory}
                    onOpenOrganizationSkillMarket={handleOpenOrganizationSkillMarket}
                    onOpenMarketBySkill={handleOpenMarketBySkill}
                    onUseSkillPrompt={handleUseSkillPrompt}
                  />
                </TabsContent>

                <TabsContent value="installed-skills" className="mt-0 space-y-3">
                  {enabledCustomSkillGroups.length > 0 ? (
                    <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/35 px-2 py-2 dark:border-emerald-900/40 dark:bg-emerald-950/10">
                      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                        <span>已启用技能</span>
                        <Badge
                          variant="outline"
                          className="h-5 min-w-6 justify-center px-1.5 text-[10px]"
                        >
                          {enabledCustomSkills.length}
                        </Badge>
                      </div>
                      <div className="space-y-3">
                        {enabledCustomSkillGroups.map((group) => (
                          <div key={group.category} className="space-y-2">
                            <div className="text-xs text-muted-foreground font-medium tracking-wider">
                              {group.category}
                            </div>
                            <WelcomeSkillTree
                              cards={group.cards}
                              onUseSkill={handleUseSkillPrompt}
                              getSkillShowLabel={getSkillShowLabel}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="group w-full rounded-xl border border-slate-300/90 dark:border-slate-600/85 bg-slate-50/70 dark:bg-slate-900/35 px-3 py-2 text-left shadow-[0_1px_0_rgba(15,23,42,0.05)] hover:bg-slate-100/95 dark:hover:bg-slate-800/55 hover:border-slate-400/95 dark:hover:border-slate-500/95 hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] transition-all"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="rounded-md border border-slate-300/90 dark:border-slate-600/80 bg-white/80 dark:bg-slate-900/45 p-1.5 text-slate-500 dark:text-slate-300 group-hover:text-slate-700 dark:group-hover:text-slate-100 transition-colors">
                          <CircleAlert className={"size-4"} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-foreground leading-5 truncate whitespace-nowrap">
                            暂无
                          </div>
                        </div>
                      </div>
                    </button>
                  )}

                  {enabledCustomSkills.length > 8 && (
                    <button
                      type="button"
                      onClick={() => setShowAllCustomSkills((prev) => !prev)}
                      className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                    >
                      {showAllCustomSkills ? (
                        <>
                          <ChevronUp className="size-3.5" />
                          <span>收起</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown className="size-3.5" />
                          <span>展开更多（+{enabledCustomSkills.length - 8}）</span>
                        </>
                      )}
                    </button>
                  )}

                  {disabledLocalSkills.length > 0 && (
                    <details className="rounded-lg border border-border/70 bg-muted/20 px-2 py-2">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                        <span>已禁用技能</span>
                        <Badge
                          variant="outline"
                          className="h-5 min-w-6 justify-center px-1.5 text-[10px]"
                        >
                          {disabledLocalSkills.length}
                        </Badge>
                      </summary>
                      <div className="mt-2 space-y-2">
                        {disabledCustomSkillGroups.map((group) => (
                          <div key={group.category} className="space-y-2">
                            <div className="text-xs text-muted-foreground/80 font-medium tracking-wider">
                              {group.category}
                            </div>
                            <WelcomeSkillTree
                              cards={group.cards}
                              disabled
                              onUseSkill={handleUseSkillPrompt}
                              getSkillShowLabel={getSkillShowLabel}
                            />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </TabsContent>

                <TabsContent value="help" className="mt-0 space-y-2">
                  {helpSceneSkillCards.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground font-medium tracking-wider">
                        通用场景
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {helpSceneSkillCards.map(({ skill, label, icon }) => (
                          <button
                            key={label + skill.path}
                            type="button"
                            onClick={() => handleUseSkillPrompt(skill)}
                            className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                {icon}
                              </div>
                              <div className="text-xs text-foreground leading-5">{label}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground font-medium tracking-wider">
                    帮助
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <button
                      onClick={async () => {
                        const instructionUrl = import.meta.env.VITE_INTRUCTION_URL
                        handleCopyToClipboard(instructionUrl)
                      }}
                      type="button"
                      className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                          <Notebook size={14} />
                        </div>
                        <div className="text-xs text-foreground leading-5">操作说明文档</div>
                      </div>
                    </button>
                    {/*<UpdateActionButton />*/}
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </div>
        )}
      </div>
    )
  }, [
    disabledCustomSkillGroups,
    disabledLocalSkills.length,
    displayMessages.length,
    enabledCustomSkillGroups,
    enabledCustomSkills.length,
    enabledSkillsForSlash,
    handleCopyToClipboard,
    handleOpenMarketBySecondaryCategory,
    handleOpenMarketBySkill,
    handleOpenOrganizationSkillMarket,
    handleUseSkillPrompt,
    harnessDialogTips,
    harnessFeatureBinding,
    helpSceneSkillCards,
    historyLoading,
    isLoading,
    getSkillShowLabel,
    programmingSkillCards,
    programmingSkills.length,
    shouldShowHarnessDialogTips,
    shouldShowWelcomeHeadline,
    shouldShowWelcomeSkillTabs,
    showAllCustomSkills,
    showAllProgrammingSkills,
    skills.length,
    skillsLoading,
    customSkillUpdateCount
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
      const withoutAttachmentPreview = bodyAfterSkill.replace(/^(?:📎[^\n]*\n)+(?:\n)?/u, "").trim()
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
    [extractMessageText, setInput, skills, setSelectedSkill]
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
                className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
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

  return (
    <div ref={chatRootRef} className="relative flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* In-session keyword search (Ctrl/Cmd+F) */}
      <ChatSearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        getViewport={getViewport}
        recomputeKey={searchRecomputeKey}
      />

      {/* Skill creation confirmation dialog */}
      <SkillCreateConfirmDialog
        request={skillConfirmRequest}
        onApprove={handleSkillApprove}
        onReject={handleSkillReject}
      />

      {skillIntentBanner}
      {nuxDialog}

      <ChatScrollNavigator
        messages={displayMessages}
        scrollContainerRef={scrollRef}
        rightPanelCollapsed={rightPanelCollapsed}
      >
        {({ reserveRightSpace, setMessageRef }) => (
          <>
            <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
              <div
                className={cn("p-4", reserveRightSpace && "md:pr-[20px]")}
                style={
                  userInputScrollPadding
                    ? { paddingBottom: `${userInputScrollPadding}px` }
                    : undefined
                }
              >
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
                  <ChatMessageList
                    messages={displayMessages}
                    perMessageFlags={perMessageFlags}
                    hookLoggingEnabled={hookLogConfig.enabled}
                    hookLogBucketByTurnId={hookLogBucketByTurnId}
                    detachedHookLogBuckets={detachedHookLogBuckets}
                    contentMessageRefs={contentMessageRefs}
                    setMessageRef={setMessageRef}
                    isLoading={isLoading}
                    toolResults={toolResults}
                    toolCallStates={toolCallDisplayStates}
                    pendingApproval={pendingApproval}
                    autoApproveGitPush={!yoloModeLoaded || yoloMode}
                    onApprovalDecision={handleApprovalDecision}
                    onEditUserMessage={handleEditUserMessage}
                    onSetGoalFromMessage={handleSetGoalFromMessage}
                    onOpenHookLogBucket={handleOpenHookLogBucket}
                    threadId={threadId}
                    assistantDurationMsById={assistantDurationMsById}
                    userSendTimeLabelById={userSendTimeLabelById}
                  />

                  {/*测试git diff功能*/}
                  {/*<DisplayDiffTest/>*/}

                  {/*
              Hook log chips now live under each user message above. The modal
              is mounted once at component scope below so it's not bound to a
              specific message render. Buckets without a visible user message
              (session lifecycle, worker auto-turns, older placeholders) render
              their chips in ChatMessageList.
            */}

                  {/* Orchestrator standalone approval bar moved outside ScrollArea — see below */}
                  {/* Model retry indicator — shown when the fetch layer is retrying a transient error */}
                  {modelRetry && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                      <span className="inline-block size-3 mt-0.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span>
                          模型暂时不可用（{modelRetry.reason}），正在重试 {modelRetry.attempt}/
                          {modelRetry.maxRetries}
                          {modelRetry.delayMs > 0 && (
                            <>（等待 {Math.round(modelRetry.delayMs / 100) / 10}s）</>
                          )}
                          …
                        </span>
                      </div>
                    </div>
                  )}
                  {/* Streaming indicator and inline TODOs */}
                  {isLoading && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm">
                        <div className="rainbow-spinner" />
                        <span
                          className="thinking-shimmer-text"
                          data-text={THINKING_MESSAGES[thinkingMessageIndex]}
                        >
                          {THINKING_MESSAGES[thinkingMessageIndex]}
                        </span>
                        {streamData.isLoading && (
                          <ProcessingDuration
                            key={threadId}
                            startTime={activeTurnStartTime}
                            text="已处理"
                          />
                        )}
                      </div>
                      {todos.length > 0 && <ChatTodos todos={todos} />}
                    </div>
                  )}
                  {workflowRun ? (
                    <WorkflowRunPanel threadId={threadId} run={workflowRun} />
                  ) : isWorkflowModeMetadata(currentThread?.metadata) ? (
                    <WorkflowHistoryButton threadId={threadId} />
                  ) : null}
                  {hookInterruption && !isLoading && (
                    <div className="flex items-start gap-3 rounded-md border border-amber-400/60 bg-amber-50/50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
                      <ShieldCheck className="size-5 text-amber-600 shrink-0 mt-0.5 dark:text-amber-300" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-amber-800 text-sm dark:text-amber-200">
                          {hookInterruption.event.startsWith("Failure fuse")
                            ? "工具失败熔断已停止本轮"
                            : hookInterruption.action === "halt"
                              ? "Hook 已停止本轮"
                              : "Hook 已阻断本轮"}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-700/80 dark:text-amber-200/80">
                          <span className="rounded border border-amber-400/50 px-1.5 py-0.5 font-mono">
                            {hookInterruption.event}
                          </span>
                          <span>{hookInterruption.timestamp.toLocaleTimeString()}</span>
                        </div>
                        <div className="text-sm text-amber-900/90 mt-2 break-words dark:text-amber-100/90">
                          {hookInterruption.reason}
                        </div>
                        {hookInterruption.systemMessage && (
                          <div className="text-xs text-amber-700/80 mt-2 break-words dark:text-amber-200/80">
                            {hookInterruption.systemMessage}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground mt-2">
                          {hookInterruption.event.startsWith("Failure fuse")
                            ? "这是工具失败熔断结果，不是应用崩溃。你可以调整策略后发送新消息继续对话。"
                            : "这是 Hook 策略结果，不是 Agent 运行错误。你可以发送新消息继续对话。"}
                        </div>
                      </div>
                      <button
                        onClick={clearHookInterruption}
                        className="shrink-0 rounded p-1 hover:bg-amber-500/20 transition-colors"
                        aria-label="Dismiss hook notice"
                      >
                        <X className="size-4 text-muted-foreground" />
                      </button>
                    </div>
                  )}
                  {/* Error state */}
                  {threadError && !isLoading && (
                    <ChatErrorCard
                      error={threadError}
                      detail={errorDetail}
                      onDismiss={handleDismissError}
                    />
                  )}
                </div>
              </div>
            </ScrollArea>
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
                <div className={cn("px-4 pb-2", reserveRightSpace && "md:pr-20")}>
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
                                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
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
              reserveRightSpace={reserveRightSpace}
              onHarnessSessionCreated={onHarnessSessionCreated}
            />
            {goalUi.goal && (
              <div className={cn("px-4 pb-1", reserveRightSpace && "md:pr-20")}>
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
                reserveRightSpace && "md:pr-[20px]"
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
                      className="rounded-md bg-status-warning px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-status-warning/90 disabled:cursor-not-allowed disabled:opacity-50"
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
                <SlashCommandPopover
                  mode={slash.mode}
                  selectedIdx={slash.selectedIdx}
                  onHoverIdx={slash.setSelectedIdx}
                  onSelectCommand={applySlashCommand}
                  onSelectSkill={applySkillSelection}
                  skillsLoading={skillsLoading}
                />
                <div className="flex flex-col gap-2">
                  <div className="flex items-end gap-2">
                    <div
                      ref={dropZoneRef}
                      className={cn(
                        "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border  transition-colors duration-300",
                        pendingUserInput
                          ? "border-primary/25 bg-background"
                          : glowVisible
                            ? "bg-white/80"
                            : "bg-white",
                        dragOver && "border-primary"
                      )}
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                    >
                      {/* Selected-skill chip sits above attachments and the textarea */}
                      {selectedSkill && (
                        <div className="flex items-center gap-1.5 px-3 pt-2.5">
                          <SkillChip
                            label={selectedSkill.name}
                            onRemove={() => setSelectedSkill(null)}
                          />
                        </div>
                      )}
                      {glowVisible && !pendingUserInput && (
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
                      {/* Attachment chips inside input box */}
                      {attachments.length > 0 && (
                        <div className="flex flex-col gap-1 px-3 pt-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            {attachments.map((att, idx) => (
                              <div
                                key={`${att.filename}-${idx}`}
                                className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md text-xs group"
                              >
                                <FileText className="size-3 text-muted-foreground shrink-0" />
                                <span className="truncate max-w-[160px]" title={att.filePath}>
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
                                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                >
                                  <X className="size-3" />
                                </button>
                              </div>
                            ))}
                            {attachmentLoading && (
                              <Loader2 className="size-4 animate-spin text-muted-foreground self-center" />
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground/50">
                            {attachments.length}/{MAX_ATTACHMENTS} 个文件 ·{" "}
                            {totalAttachmentChars.toLocaleString()}/
                            {MAX_TOTAL_CHARS.toLocaleString()} 字符
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
                          attachments.length > 0 && "pt-1.5"
                        )}
                        rows={3}
                        style={{ minHeight: "44px", maxHeight: "200px" }}
                      />
                      {/* Bottom bar: + button left, send button right */}
                      <div className="flex items-center justify-between px-3 pb-2 w-full">
                        <div className="flex items-center gap-1 flex-1 overflow-auto">
                          <button
                            type="button"
                            disabled={
                              effectiveComposerControlsDisabled ||
                              attachmentLoading ||
                              attachments.length >= MAX_ATTACHMENTS ||
                              totalAttachmentChars >= MAX_TOTAL_CHARS
                            }
                            onClick={handleAttachClick}
                            title="添加文件 (txt, md, csv, docx, xlsx)"
                            className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Plus className="size-4" />
                          </button>
                          <div className="w-px h-4 bg-border mx-1" />
                          <ModelSwitcher threadId={threadId} />
                          <div className="w-px h-4 bg-border mx-1" />
                          <AgentModeSwitcher
                            mode={
                              (disableCoordinatorModeOption && agentMode === "coordinator") ||
                              (disableWorkflowModeOption && agentMode === "workflow")
                                ? "normal"
                                : agentMode
                            }
                            locked={
                              isLoading || !canChangeAgentMode
                            }
                            lockedReason={agentModeSwitchDisabledReason}
                            disabledModes={
                              disableCoordinatorModeOption || disableWorkflowModeOption
                                ? {
                                    coordinator: disableCoordinatorModeOption,
                                    workflow: disableWorkflowModeOption
                                  }
                                : undefined
                            }
                            onChange={handleAgentModeChange}
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
                                  className="flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                                  (!input.trim() && attachments.length === 0 && !selectedSkill) ||
                                  (slash.mode.kind === "slash" &&
                                    !isBareGoalSlashCommandInput(input))
                                }
                                className="flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
