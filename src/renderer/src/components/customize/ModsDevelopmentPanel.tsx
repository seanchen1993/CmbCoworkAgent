import type { StageDebugReviewIntent } from "../../../../shared/mods/v2/project-stage-debug-review"
import { developmentCapabilityLabel } from "./development-capability-label"
import {
  developmentCapabilitySummary,
  developmentFailureMessage,
  developmentRepairPrompt,
  developmentNextStep
} from "./development-trial-view"
import { BookOpen, WandSparkles } from "lucide-react"
import { openApplicationUsageGuide } from "../guides/application-usage-guide"
import { AnchoredGuide } from "../guides/AnchoredGuide"
import { creatorWorkspaceGuide, creatorWorkspaceGuideSteps } from "./creator-workspace-guide"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { rememberReuseSelection } from "./development-reuse-receipts"
import type { DevelopmentSetupApi } from "./development-creation-setup"
import { enterCreatorMode } from "./creator-mode-entry"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useAppStore } from "@/lib/store"
import { hasNativeCreatorWork } from "./creator-workspace-visibility"
import type {
  DevelopmentApi,
  DevelopmentStatus,
  DevelopmentTrialStatus
} from "../../../../shared/mods/development"
import type { AuthoringDocument } from "../../../../shared/mods/authoring"
import type { DevelopmentReuseOrigin } from "./DevelopmentReusePanel"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { ProjectDevelopmentPreviewPanel } from "./ProjectDevelopmentPreviewPanel"
import { DevelopmentReusePlanCard } from "./DevelopmentReusePlanCard"
import { FunctionUserConfig } from "./FunctionUserConfig"
import { BusinessCreatorReviewCard } from "./BusinessCreatorReviewCard"
import { BusinessCreatorTrialDialog } from "./BusinessCreatorTrialDialog"
import { CreatorPlanningPanel } from "./CreatorPlanningPanel"
import { CreatorProjectDeliveryCard } from "./CreatorProjectDeliveryCard"
import { CreatorPluginModularizationCard } from "./CreatorPluginModularizationCard"
import { creatorJourneyView } from "./creator-journey-view"
import { CreatorTrialJourneyCard } from "./CreatorTrialJourneyCard"
import { CreatorWorkspaceNavigation } from "./CreatorWorkspaceNavigation"
import { isHostBusinessCreatorReview } from "./creator-project-route"

const phases: Record<DevelopmentTrialStatus["phase"], string> = {
  "needs-approval": "等待你确认能力",
  queued: "已排队，等待本轮结束或界面空闲",
  preflight: "正在检查新版本",
  retiring: "正在停止旧版本",
  active: "本会话已生效",
  stopped: "已停止试用",
  failed: "新版本试用失败",
  unknown: "结果待核对"
}
const button =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
const primaryButton = `${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`
function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("CREATOR_REPAIR_QUEUE_NOT_EMPTY"))
    return "还有待发送的消息，请先处理后再修复灵件。原输入和待发送消息都已保留。"
  if (message.includes("CREATOR_REPAIR_BUSY")) return "请先处理当前任务或待确认事项，再修复灵件。"
  if (message.includes("CREATOR_REPAIR_MODEL_REQUIRED")) return "请先选择可用模型，再修复灵件。"
  if (message.includes("CREATOR_REPAIR_EMPTY")) return "未能取得修复说明，请刷新灵件状态后重试。"
  if (/CLAW_COMPONENT_USAGE_UNAVAILABLE|CAPABILITY_USAGE_UNAVAILABLE/.test(message))
    return "此版本包含当前场景不适用的功能，无法开始试用。请调整功能的适用范围，或到对应的普通对话或项目中试用。"
  if (/CAPABILITY_CONTEXT|CAPABILITY_PROJECT/.test(message))
    return "对话或项目归属已变化，试用已暂停。请回到原场景刷新并重新核对。"
  if (/DEVELOPMENT_SETUP_PARTIAL/.test(message))
    return "部分开关可能已开启，但创作尚未确认。保留已有设置，请刷新状态后再试；不会自动关闭其它会话使用的功能。"
  if (/DEVELOPMENT_SETTINGS_RECOVERY/.test(message))
    return "项目设置需要恢复，请到“添加功能 → 我已添加”查看提示。"
  if (/DEVELOPMENT_CREATOR_UNAVAILABLE/.test(message))
    return "尚未进入创造者模式，请刷新状态后重试。"
  if (/WORKSPACE_REQUIRED|LOCAL_WORKSPACE/.test(message)) return "请先选择本地项目，再制作灵件。"
  if (/DEVELOPMENT_MODS_DISABLED/.test(message))
    return "灵件功能已关闭。请点击“开启灵件功能”恢复后，再检查试用状态。"
  if (/DEVELOPMENT_EVENT_AUTHORITY_UNVERIFIED/.test(message))
    return "事件范围无法确认。请让助手使用当前支持的精确事件名称，再检查并申请试用。"
  if (/STALE|SCOPE|REVISION|DIGEST/.test(message))
    return "会话、项目或版本已变化，请刷新状态后核对。"
  if (/BUSY/.test(message)) return "任务或版本仍在处理中，请等待停止完成后再操作。"
  if (/LIMIT/.test(message)) return "开发草稿或执行资源已达上限，请核对后再继续。"
  if (/CANCEL/.test(message)) return "操作已取消，请刷新并核对实际状态。"
  return "暂时无法确认操作结果。请刷新状态，查看是否已完成。"
}

export function ModsDevelopmentPanel({
  threadId,
  workspaceHint,
  mode = "entry",
  api = window.api.mods.development,
  onReturnToChat,
  onRequestRepair,
  onModeChange,
  onSelectWorkspaceForCreator,
  onOpenWorkbench,
  settingsApi = window.api.mods,
  onPromoted,
  onReuse,
  promotionBlocked = false
}: {
  threadId: string | null
  workspaceHint?: string | null
  mode?: "entry" | "chat"
  api?: DevelopmentApi
  onReturnToChat?: () => void
  onRequestRepair?: (message: string) => void | Promise<void>
  onModeChange?: (mode: "normal" | "creator") => void
  onSelectWorkspaceForCreator?: () => Promise<void>
  onOpenWorkbench?: () => void
  settingsApi?: DevelopmentSetupApi
  onPromoted?: (document: AuthoringDocument) => void
  onReuse?: (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => void
  promotionBlocked?: boolean
}) {
  const accountRevision = useSyncExternalStore(
    useAppStore.subscribe,
    () => useAppStore.getState().accountRevision
  )
  if (!threadId || !api || workspaceHint === null)
    return (
      <CreatorWorkspaceEntry
        key={JSON.stringify([accountRevision, threadId])}
        onSelect={threadId ? onSelectWorkspaceForCreator : undefined}
      />
    )
  return (
    <ScopedDevelopment
      key={JSON.stringify([accountRevision, threadId, workspaceHint])}
      threadId={threadId}
      workspaceHint={workspaceHint}
      api={api}
      mode={mode}
      onReturnToChat={onReturnToChat}
      onRequestRepair={onRequestRepair}
      onModeChange={onModeChange}
      onOpenWorkbench={onOpenWorkbench}
      settingsApi={settingsApi}
      onPromoted={onPromoted}
      onReuse={onReuse}
      promotionBlocked={promotionBlocked}
    />
  )
}

function CreatorWorkspaceEntry({ onSelect }: { onSelect?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="选择创作目录">
      <span className="text-muted-foreground">普通模式</span>
      <button
        type="button"
        className={button}
        disabled={busy || !onSelect}
        onClick={async () => {
          if (!onSelect || busy) return
          setBusy(true)
          setMessage("")
          try {
            await onSelect()
          } catch (error) {
            if (live.current) setMessage(publicError(error))
          } finally {
            if (live.current) setBusy(false)
          }
        }}
      >
        {busy ? "正在选择创作目录…" : "选择目录并进入创造者模式"}
      </button>
      {message && (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  )
}

function reviewTargetsProjectTrial(
  intent: StageDebugReviewIntent,
  trial: DevelopmentStatus["projectTrial"]
): boolean {
  return (
    !!trial &&
    intent.draftId === trial.draftId &&
    intent.revision === trial.revision &&
    intent.candidateDigest === trial.digest
  )
}

function ScopedDevelopment({
  threadId,
  workspaceHint,
  api,
  mode,
  onReturnToChat,
  onRequestRepair,
  onModeChange,
  onOpenWorkbench,
  settingsApi,
  onPromoted,
  onReuse,
  promotionBlocked
}: {
  threadId: string
  workspaceHint?: string | null
  api: DevelopmentApi
  mode: "entry" | "chat"
  onReturnToChat?: () => void
  onRequestRepair?: (message: string) => void | Promise<void>
  onModeChange?: (mode: "normal" | "creator") => void
  onOpenWorkbench?: () => void
  settingsApi: DevelopmentSetupApi
  onPromoted?: (document: AuthoringDocument) => void
  onReuse?: (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => void
  promotionBlocked: boolean
}) {
  const [open, setOpen] = useState(false)
  const workspaceBody = useRef<HTMLElement>(null)
  const focusChatAfterClose = useRef(false)
  const [status, setStatus] = useState<DevelopmentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const live = useRef(false),
    pending = useRef(false),
    generation = useRef(0)
  const canonical = useRef<string | null>(null)
  const modeChanged = useRef(onModeChange)
  const account = useRef(useAppStore.getState().accountRevision)
  modeChanged.current = onModeChange
  const announcedApproval = useRef("")
  const announcedTrialAttention = useRef("")
  const announcedCompositionFailure = useRef("")
  const announcedReuse = useRef("")
  const [projectPreviewOpen, setProjectPreviewOpen] = useState(false)
  const [stageDebugReview, setStageDebugReview] = useState<StageDebugReviewIntent>()
  const [creatorOptionsOpen, setCreatorOptionsOpen] = useState(false)
  const [businessTrialOpen, setBusinessTrialOpen] = useState(false)
  const accept = useCallback(
    (next: DevelopmentStatus) => {
      if (account.current !== useAppStore.getState().accountRevision)
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      if (
        next.threadId !== threadId ||
        !next.workspace ||
        (workspaceHint !== undefined &&
          normalizeWorkspacePathKey(next.workspace) !== normalizeWorkspacePathKey(workspaceHint)) ||
        (canonical.current !== null &&
          normalizeWorkspacePathKey(canonical.current) !==
            normalizeWorkspacePathKey(next.workspace))
      ) {
        setStatus(null)
        modeChanged.current?.("normal")
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
      canonical.current = next.workspace
      setStatus(next)
      modeChanged.current?.(next.mode ?? (next.enabled ? "creator" : "normal"))
    },
    [threadId, workspaceHint]
  )
  const read = useCallback(
    async (clearError = true) => {
      if (pending.current) return
      const ticket = ++generation.current
      try {
        const next = await api.status({ threadId })
        if (
          !live.current ||
          generation.current !== ticket ||
          account.current !== useAppStore.getState().accountRevision
        )
          return
        accept(next)
        if (clearError) setMessage("")
      } catch (error) {
        if (live.current && generation.current === ticket) setMessage(publicError(error))
      }
    },
    [api, threadId, accept]
  )
  useEffect(() => {
    live.current = true
    pending.current = false
    setBusy(false)
    modeChanged.current?.("normal")
    void read()
    const unsubscribe = api.onChanged((event) => {
      if (event.threadId === threadId) void read()
    })
    return () => {
      live.current = false
      generation.current++
      unsubscribe()
    }
  }, [api, threadId, read])
  const operate = async <T,>(
    call: (workspace: string, assertCurrent: () => void) => Promise<T>,
    done: (value: T) => void | Promise<void>
  ) => {
    if (pending.current || !canonical.current) return
    pending.current = true
    const ticket = ++generation.current
    setBusy(true)
    setMessage("")
    try {
      const workspace = canonical.current
      const assertCurrent = () => {
        if (
          !live.current ||
          ticket !== generation.current ||
          canonical.current !== workspace ||
          account.current !== useAppStore.getState().accountRevision
        )
          throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
      assertCurrent()
      const result = await call(workspace, assertCurrent)
      assertCurrent()
      await done(result)
    } catch (error) {
      if (live.current && ticket === generation.current) setMessage(publicError(error))
    } finally {
      if (live.current && ticket === generation.current) {
        pending.current = false
        setBusy(false)
        await read(false)
      }
    }
  }
  const changeMode = (nextMode: "normal" | "creator") =>
    void operate(
      async (expectedWorkspace, assertCurrent) => {
        if (nextMode === "creator") {
          return enterCreatorMode(settingsApi, api, threadId, expectedWorkspace, assertCurrent)
        }
        const next = await api.setMode({ threadId, expectedWorkspace, mode: nextMode })
        assertCurrent()
        return next
      },
      (next) => {
        accept(next)
        if (mode === "chat" && open) focusChatAfterClose.current = true
        setOpen(false)
        onReturnToChat?.()
      }
    )
  const stopCreation = () =>
    void operate(
      (expectedWorkspace) => api.setEnabled({ threadId, expectedWorkspace, enabled: false }),
      (next) => {
        accept(next)
        focusChatAfterClose.current = true
        setOpen(false)
      }
    )
  const creatorMode = status?.mode === "creator" || (status?.mode === undefined && status?.enabled)
  const creatorReady = !!status?.enabled && !!creatorMode
  const inlineStageDebugReview =
    stageDebugReview && reviewTargetsProjectTrial(stageDebugReview, status?.projectTrial)
      ? stageDebugReview
      : undefined
  const independentStageDebugReview = inlineStageDebugReview ? undefined : stageDebugReview
  const workspaceVisible = !!creatorMode && (hasNativeCreatorWork(status) || !!stageDebugReview)
  useEffect(() => {
    const reviewApi = window.api.mods.stageDebugReview
    if (!creatorMode || !status?.workspace || !reviewApi) {
      setStageDebugReview(undefined)
      return
    }
    let cancelled = false
    const workspace = status.workspace
    let observed = ""
    const refreshReview = async () => {
      try {
        // Read back from the native ephemeral ledger. Event JSON alone never selects a plan.
        const intent = await reviewApi.current(threadId)
        if (
          cancelled ||
          !intent ||
          intent.threadId !== threadId ||
          intent.expiresAt <= Date.now() ||
          normalizeWorkspacePathKey(intent.workspace) !== normalizeWorkspacePathKey(workspace) ||
          intent.id === observed
        )
          return
        observed = intent.id
        setStageDebugReview(intent)
        setProjectPreviewOpen(!reviewTargetsProjectTrial(intent, status?.projectTrial))
        setOpen(true)
        requestAnimationFrame(() =>
          workspaceBody.current
            ?.querySelector<HTMLElement>("[data-creator-stage-debug-review]")
            ?.scrollIntoView({ block: "start" })
        )
      } catch {
        if (!cancelled) setStageDebugReview(undefined)
      }
    }
    const stop = reviewApi.onRequested((intent) => {
      if (intent.threadId === threadId) void refreshReview()
    })
    void refreshReview()
    return () => {
      cancelled = true
      stop()
    }
  }, [
    threadId,
    status?.workspace,
    creatorMode,
    status?.projectTrial?.draftId,
    status?.projectTrial?.revision,
    status?.projectTrial?.digest
  ])
  const awaitingApproval =
    status?.trials.filter((row) => row.phase === "needs-approval").length ?? 0
  const active = status?.trials.some(
    (row) => row.activeRevision !== undefined && row.phase !== "stopped"
  )
  const failed = status?.trials.some((row) => row.phase === "failed")
  const uncertain = status?.trials.some(
    (row) => row.phase === "unknown" || (row.diagnostics?.unknownRequests ?? 0) > 0
  )
  const trialAttentionKey = JSON.stringify(
    status?.trials
      .filter(
        (row) =>
          ["failed", "unknown"].includes(row.phase) || (row.diagnostics?.unknownRequests ?? 0) > 0
      )
      .map((row) => [row.componentId, row.revision, row.compiledDigest, row.phase, row.error]) ?? []
  )
  useEffect(() => {
    if (
      trialAttentionKey !== "[]" &&
      mode === "chat" &&
      announcedTrialAttention.current !== trialAttentionKey
    ) {
      announcedTrialAttention.current = trialAttentionKey
      setOpen(true)
    }
    if (trialAttentionKey === "[]") announcedTrialAttention.current = ""
  }, [mode, trialAttentionKey])
  const composition = status?.composition
  const undoBusy = status?.undo?.phase === "queued" || status?.undo?.phase === "applying"
  const reuse = status?.reuse
  const reuseDraft = status?.drafts.find((draft) => draft.id === reuse?.draftId)
  const reuseCurrent =
    !!reuse &&
    !!reuseDraft &&
    reuseDraft.revision === reuse.revision &&
    reuseDraft.digest === reuse.sourceDigest
  const reuseKey =
    reuse && ["needs-approval", "failed", "unknown"].includes(reuse.phase)
      ? JSON.stringify([reuse.planId, reuse.phase, reuse.sourceDigest, reuse.compiledDigest])
      : ""
  useEffect(() => {
    if (mode === "chat" && reuseKey && announcedReuse.current !== reuseKey) {
      announcedReuse.current = reuseKey
      setOpen(true)
    }
    if (!reuseKey) announcedReuse.current = ""
  }, [mode, reuseKey])
  const compositionRuntimeUnconfirmed =
    composition?.phase === "failed" && composition.error === "COMPOSITION_RUNTIME_UNCONFIRMED"
  const compositionUnconfirmed =
    compositionRuntimeUnconfirmed ||
    (composition?.phase === "failed" && composition.error === "MODS_COMPOSITION_APPLY_UNCONFIRMED")
  const compositionFailureKey =
    composition?.phase === "failed"
      ? JSON.stringify([composition.name, composition.pluginNames, composition.error])
      : ""
  useEffect(() => {
    if (
      mode === "chat" &&
      compositionFailureKey &&
      announcedCompositionFailure.current !== compositionFailureKey
    ) {
      announcedCompositionFailure.current = compositionFailureKey
      setOpen(true)
    }
    if (!compositionFailureKey) announcedCompositionFailure.current = ""
  }, [mode, compositionFailureKey])
  const configurationId = status?.configuration?.id
  const announcedConfiguration = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (mode === "chat" && configurationId && announcedConfiguration.current !== configurationId) {
      announcedConfiguration.current = configurationId
      setOpen(true)
    }
  }, [mode, configurationId])
  const projectTrialId = status?.projectTrial?.id
  const projectJourney = status?.projectTrial
    ? creatorJourneyView(status.projectTrial.journey, {
        threadId,
        digest: status.projectTrial.digest
      })
    : undefined
  const announcedProjectTrial = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (mode === "chat" && projectTrialId && announcedProjectTrial.current !== projectTrialId) {
      announcedProjectTrial.current = projectTrialId
      setOpen(true)
    }
  }, [mode, projectTrialId])
  const businessReview = status?.business?.review
  const hostBusinessReview = isHostBusinessCreatorReview(status?.projectTrial, businessReview)
  const useProjectCandidate = !!status?.projectTrial && (!businessReview || hostBusinessReview)
  const modularization = status?.business?.modularization
  const announcedModularization = useRef("")
  useEffect(() => {
    if (
      mode === "chat" &&
      modularization?.phase === "needs-confirmation" &&
      announcedModularization.current !== modularization.requestId
    ) {
      announcedModularization.current = modularization.requestId
      setOpen(true)
    }
  }, [mode, modularization?.phase, modularization?.requestId])
  const projectCreation = !!businessReview || !!status?.projectTrial
  const businessTrialDiagnostic = hostBusinessReview ? undefined : status?.business?.trialDiagnostic
  const businessTrial =
    hostBusinessReview || businessTrialDiagnostic ? undefined : status?.business?.trial
  useEffect(() => {
    if (businessTrialOpen && hostBusinessReview) {
      setBusinessTrialOpen(false)
      if (mode === "chat") setOpen(true)
    }
  }, [businessTrialOpen, hostBusinessReview, mode])
  const businessJourney = businessTrial
    ? creatorJourneyView(businessTrial.journey, { threadId, digest: businessTrial.digest })
    : undefined
  const announcedBusinessTrial = useRef("")
  const businessTrialAttention =
    businessTrial && ["needs-confirmation", "failed", "unknown"].includes(businessTrial.phase)
      ? JSON.stringify([businessTrial.id, businessTrial.phase])
      : ""
  useEffect(() => {
    if (businessTrialAttention && announcedBusinessTrial.current !== businessTrialAttention) {
      announcedBusinessTrial.current = businessTrialAttention
      setBusinessTrialOpen(true)
      setOpen(false)
    }
  }, [businessTrialAttention])
  const businessReviewKey = businessReview
    ? JSON.stringify([businessReview.planId, businessReview.phase])
    : ""
  const announcedBusinessReview = useRef("")
  useEffect(() => {
    if (
      mode === "chat" &&
      businessReviewKey &&
      announcedBusinessReview.current !== businessReviewKey
    ) {
      announcedBusinessReview.current = businessReviewKey
      if (!businessTrialAttention && !businessTrialOpen) setOpen(true)
    }
  }, [mode, businessReviewKey, businessTrialAttention, businessTrialOpen])
  const approvalKey = JSON.stringify(
    status?.trials
      .filter((row) => row.phase === "needs-approval")
      .map((row) => [row.componentId, row.revision, row.bundleDigest, row.compiledDigest]) ?? []
  )
  useEffect(() => {
    if (mode === "chat" && awaitingApproval && announcedApproval.current !== approvalKey) {
      announcedApproval.current = approvalKey
      setOpen(true)
    }
    if (!awaitingApproval) announcedApproval.current = ""
  }, [mode, awaitingApproval, approvalKey])
  const label =
    modularization?.phase === "needs-confirmation"
      ? "确认插件模块化"
      : hostBusinessReview
        ? (projectJourney?.label ?? "确认项目真实试用")
        : businessTrialDiagnostic
          ? "业务试用记录待核对"
          : businessTrial?.phase === "unknown"
            ? "业务试用结果待核对"
            : businessTrial && ["needs-configuration", "ready"].includes(businessTrial.phase)
              ? "配置业务试用"
              : businessTrial?.phase === "running"
                ? "业务插件试用中"
                : businessJourney?.passed
                  ? "整轮试用已通过"
                  : businessTrial?.phase === "completed"
                    ? "试用已结束，核对验收"
                    : businessTrial?.phase === "failed"
                      ? "业务试用失败，查看诊断"
                      : businessReview
                        ? businessReview.phase === "unknown"
                          ? "插件结果待核对"
                          : "业务插件组装"
                        : projectTrialId
                          ? (projectJourney?.label ?? "确认项目真实试用")
                          : configurationId
                            ? "填写插件参数"
                            : undoBusy
                              ? "正在撤销修改"
                              : status?.undo?.phase === "failed"
                                ? "撤销结果待核对"
                                : reuse?.phase === "needs-approval"
                                  ? "确认跨聊天复用"
                                  : reuse?.phase === "unknown"
                                    ? "复用结果待核对"
                                    : reuse?.phase === "failed"
                                      ? "跨聊天复用未完成"
                                      : reuse && ["preparing", "applying"].includes(reuse.phase)
                                        ? "正在准备跨聊天复用"
                                        : compositionRuntimeUnconfirmed
                                          ? "组合运行待核对"
                                          : compositionUnconfirmed
                                            ? "组合切换待核对"
                                            : uncertain
                                              ? "试用结果待核对"
                                              : awaitingApproval
                                                ? "确认灵件试用"
                                                : failed
                                                  ? "试用失败 · 查看处理"
                                                  : composition?.phase === "failed"
                                                    ? "组合应用失败 · 查看处理"
                                                    : composition &&
                                                        ["queued", "applying"].includes(
                                                          composition.phase
                                                        )
                                                      ? "正在应用组合"
                                                      : active
                                                        ? "灵件试用中"
                                                        : status?.trials.some((row) =>
                                                              [
                                                                "queued",
                                                                "preflight",
                                                                "retiring"
                                                              ].includes(row.phase)
                                                            )
                                                          ? "正在准备试用"
                                                          : composition?.phase === "active"
                                                            ? "组合已应用"
                                                            : reuse?.phase === "active"
                                                              ? "已保存跨聊天复用"
                                                              : "创作工作区"
  const saveForReuse =
    onReuse ??
    (onOpenWorkbench
      ? (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => {
          rememberReuseSelection(JSON.stringify([threadId, workspaceHint]), { document, origin })
          setOpen(false)
          onOpenWorkbench()
        }
      : undefined)
  const continueModularization = async (next: DevelopmentStatus) => {
    const prepared = next.business?.modularization
    if (prepared?.phase !== "ready" || !prepared.inspectionId || !onRequestRepair) return
    await onRequestRepair(
      `原始插件“${prepared.sourceName}”的首次模块化已由我确认，来源摘要 ${prepared.sourceDigest}，已准备的 inspectionId 为 ${prepared.inspectionId}。请先通过 mod_business inspect 读取这一 inspectionId 的真实模块目录、资源、Hooks 和配置契约，再根据原需求继续组合、准备候选并请求试用。不要重新猜测原始接口，不把模块化准备成功当作业务验收通过。`
    )
    if (!live.current) return
    focusChatAfterClose.current = true
    setOpen(false)
    if (mode === "entry") onReturnToChat?.()
  }
  const showNavigation = projectCreation || !status?.trials.length
  const nextWorkspaceStep =
    modularization?.phase === "needs-confirmation"
      ? "create"
      : (useProjectCandidate && projectJourney?.passed) || businessJourney?.passed
        ? "delivery"
        : useProjectCandidate &&
            ["failed", "unknown", "needs-transition"].includes(
              status?.projectTrial?.journey?.phase ?? ""
            )
          ? "acceptance"
          : businessTrial && ["completed", "failed", "unknown"].includes(businessTrial.phase)
            ? "acceptance"
            : projectCreation
              ? "trial"
              : "create"
  const navigate = (target: "create" | "trial" | "acceptance" | "delivery") => {
    if (target === "create" && onReturnToChat) {
      focusChatAfterClose.current = true
      setOpen(false)
      if (mode === "entry") onReturnToChat()
      return
    }
    workspaceBody.current
      ?.querySelector<HTMLElement>(`[data-creator-section="${target}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
  const content = (
    <section
      aria-label="灵件对话创作"
      ref={workspaceBody}
      className={
        mode === "chat"
          ? "min-w-0 space-y-5 text-sm"
          : "mx-auto max-w-5xl space-y-5 rounded-xl border bg-card p-4"
      }
    >
      <div
        data-creator-guide="overview"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <h2 className="font-semibold">
          {mode === "chat" ? "当前创作" : "在所选聊天使用创造者模式"}
        </h2>
        <AnchoredGuide
          active={workspaceVisible && (mode === "entry" || open)}
          config={creatorWorkspaceGuide}
          steps={creatorWorkspaceGuideSteps}
          rootRef={workspaceBody}
        />
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          disabled={busy}
          onClick={() => {
            setMessage("")
            void read()
          }}
        >
          刷新状态
        </button>
      </div>
      {status && !creatorReady && (
        <section
          aria-label="重新进入创造者模式"
          className="space-y-3 rounded-xl border bg-muted/30 p-4"
        >
          <h3 className="font-medium">本次创作控制尚未开启</h3>
          <p className="text-sm leading-6 text-muted-foreground">
            当前处于普通模式，或应用重启后尚未重新进入创造者模式。项目候选与阶段调试历史需要重新进入后读取；没有显示记录，不表示候选、阶段快照或试用历史已丢失。
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            请明确重新进入后查看原候选与阶段调试历史。重新进入只建立本次创作控制，历史文件与检查记录保留；不会恢复旧分支的运行授权或工具批准，也不会把历史通过结果计为新执行的验收。新的执行须重新确认。
          </p>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => changeMode("creator")}
          >
            重新进入创造者模式
          </button>
        </section>
      )}
      {(!awaitingApproval || projectCreation) && (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-4" aria-label="创作流程导航">
          <p className="text-sm font-medium">
            {hostBusinessReview && status?.projectTrial
              ? `${status.projectTrial.name} · 版本 ${status.projectTrial.revision}`
              : businessReview
                ? `${businessReview.name} · v${businessReview.version}`
                : status?.projectTrial
                  ? `${status.projectTrial.name} · 版本 ${status.projectTrial.revision}`
                  : creatorReady
                    ? "从需求到可复用插件"
                    : "重新进入后查看原会话的持久创作记录"}
          </p>
          {useProjectCandidate && projectJourney && (
            <div role="status" className="space-y-1 text-sm">
              <p className="font-medium">{projectJourney.label}</p>
              <p className="text-xs text-muted-foreground">下一步：{projectJourney.nextStep}</p>
            </div>
          )}
          {businessTrial && (
            <p role="status" className="text-xs text-muted-foreground">
              {businessJourney?.passed
                ? "本轮原生检查与推进凭据已确认通过。请再核对业务效果，然后保存为新插件。"
                : businessTrial.phase === "completed"
                  ? "原运行已结束。请先查看整轮原检查点、产物与反馈，再选择保存为新插件。"
                  : businessTrial.phase === "running"
                    ? "本轮试用进行中，所有阶段会话在同一轮记录中查看。"
                    : businessTrial.phase === "failed"
                      ? "本轮未完成。请查看未通过的检查和诊断，再回原聊天修改。"
                      : "下一步：打开本轮试用，核对候选、参数与权限后运行。"}
            </p>
          )}
          {projectCreation && (
            <p className="text-xs leading-5 text-muted-foreground">
              需求和修改始终在原聊天中进行。独立项目和阶段会话是同一轮试用的执行记录，
              请在这里核对整轮结果，再保存或导出插件。
            </p>
          )}
          {mode === "entry" && showNavigation && (
            <CreatorWorkspaceNavigation onNavigate={navigate} currentStep={nextWorkspaceStep} />
          )}
          {onReturnToChat && (
            <button
              type="button"
              className={button}
              data-creator-guide="chat"
              onClick={() => {
                focusChatAfterClose.current = true
                setOpen(false)
                if (mode === "entry") onReturnToChat()
              }}
            >
              返回原聊天继续创作
            </button>
          )}
        </div>
      )}
      {status?.planning?.diagnostic && (
        <p role="status" className="text-xs text-muted-foreground">
          {status.planning.diagnostic}
        </p>
      )}
      {businessTrialDiagnostic && (
        <p role="alert" className="text-sm text-destructive">
          隔离试用记录暂不可用：{businessTrialDiagnostic}。请核对原记录；这里不会启动或重放试用。
        </p>
      )}
      {modularization && (
        <CreatorPluginModularizationCard
          status={modularization}
          busy={busy}
          onConfirm={
            api.approveModularization
              ? () =>
                  void operate(
                    async (expectedWorkspace, assertCurrent) => {
                      await enterCreatorMode(
                        settingsApi,
                        api,
                        threadId,
                        expectedWorkspace,
                        assertCurrent
                      )
                      assertCurrent()
                      return api.approveModularization!({
                        threadId,
                        expectedWorkspace,
                        requestId: modularization.requestId,
                        sourceDigest: modularization.sourceDigest
                      })
                    },
                    async (next) => {
                      accept(next)
                      await continueModularization(next)
                    }
                  )
              : undefined
          }
          onContinue={
            onRequestRepair
              ? () =>
                  void operate(
                    (expectedWorkspace, assertCurrent) =>
                      enterCreatorMode(
                        settingsApi,
                        api,
                        threadId,
                        expectedWorkspace,
                        assertCurrent
                      ),
                    async (next) => {
                      accept(next)
                      await continueModularization(next)
                    }
                  )
              : undefined
          }
        />
      )}
      {(projectCreation || !!status?.configuration || !status?.trials.length) && (
        <>
          <section
            data-creator-section="trial"
            aria-label="试用当前候选"
            className="scroll-mt-4 space-y-3"
          >
            <h3 className="font-semibold">运行试用与核对结果</h3>
            {creatorReady && !businessReview && !status?.projectTrial && (
              <p className="text-sm text-muted-foreground">
                还没有准备好项目候选。回到原聊天提出需求，助手准备好当前版本后，将在这里显示试用入口。
              </p>
            )}
            {businessReview && !hostBusinessReview && (
              <div className="space-y-2 rounded-xl border bg-card p-4">
                <p className="font-medium">
                  {businessReview.name} · v{businessReview.version}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  试用保留原插件，运行与本次创作关联。查看整轮记录和各阶段校验后，再决定是否保存为新插件。
                </p>
                {api.businessTrial && !businessTrialDiagnostic && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={busy}
                    onClick={() => {
                      setOpen(false)
                      setBusinessTrialOpen(true)
                    }}
                  >
                    {businessTrial ? "继续查看本轮试用与验收" : "配置并试用此版本"}
                  </button>
                )}
              </div>
            )}
            {status?.projectTrial && (
              <article
                className="space-y-3 rounded-xl border bg-card p-3"
                aria-label="项目真实试用请求"
                data-creator-stage-debug-review={inlineStageDebugReview ? true : undefined}
              >
                {!useProjectCandidate && (
                  <p className="text-xs font-medium text-muted-foreground">
                    其他项目试用记录 · 与当前组装来源不同
                  </p>
                )}
                <p className="text-sm font-medium">
                  {status.projectTrial.name} · 版本 {status.projectTrial.revision}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  此候选使用原项目运行器试用。各阶段分别执行，但归属于下面同一轮试用；
                  产物和校验统一汇总。修改源码后需准备新版本，不会改动正在运行的任务。
                </p>
                <ProjectDevelopmentPreviewPanel
                  key={status.projectTrial.id}
                  threadId={threadId}
                  workspace={status.workspace}
                  request={status.projectTrial}
                  showJourney={!useProjectCandidate}
                  stageDebugReview={inlineStageDebugReview}
                  onRequestRepair={onRequestRepair}
                  onReturnToChat={() => {
                    focusChatAfterClose.current = true
                    setOpen(false)
                    if (mode === "entry") onReturnToChat?.()
                  }}
                />
              </article>
            )}
            {status?.configuration && (
              <article
                className="space-y-3 rounded-xl border bg-card p-3"
                aria-label="插件参数填写请求"
              >
                <p className="text-sm font-medium">
                  {status.configuration.plugin} · {status.configuration.label}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  请在原生参数表单中选择或填写。敏感内容不会交给助手；参数保存在当前项目，
                  同一项目使用此插件的聊天共享。保存后，正在执行的任务继续使用原设置，结束后应用。
                  此表单不批准插件代码或扩大权限。
                </p>
                <FunctionUserConfig
                  key={status.configuration.id}
                  threadId={threadId}
                  pluginId={status.configuration.pluginId}
                  expectedWorkspace={status.workspace}
                  expectedDigest={status.configuration.digest}
                  focusKey={status.configuration.key}
                  initiallyOpen
                  onSaved={() => void read(false)}
                />
              </article>
            )}
          </section>
          <section
            data-creator-section="acceptance"
            aria-label="创作验收入口"
            className="scroll-mt-4 space-y-3 rounded-xl border p-4"
          >
            <h3 className="font-semibold">验收整轮试用</h3>
            <p className="text-sm text-muted-foreground">
              会话结束、代码检查通过和插件安装成功分别代表不同结果。业务通过需要原流程的阶段、必需产物、校验及人工确认凭据。
            </p>
            {useProjectCandidate && status?.projectTrial && (
              <CreatorTrialJourneyCard
                threadId={threadId}
                digest={status.projectTrial.digest}
                journey={status.projectTrial.journey}
              />
            )}
            {businessReview &&
            !hostBusinessReview &&
            api.businessTrial &&
            !businessTrialDiagnostic ? (
              <button
                type="button"
                className={button}
                onClick={() => {
                  setOpen(false)
                  setBusinessTrialOpen(true)
                }}
              >
                查看本轮阶段和验收记录
              </button>
            ) : (
              creatorReady &&
              !status?.projectTrial && (
                <p className="text-xs text-muted-foreground">
                  项目候选准备后将在这里显示逐阶段校验；缺少凭据时显示待核对。
                </p>
              )
            )}
          </section>
          <section
            data-creator-section="delivery"
            aria-label="保存插件交付"
            className="scroll-mt-4 space-y-3"
          >
            <h3 className="font-semibold">保存为插件并复用</h3>
            {status && (status.projectDelivery || (useProjectCandidate && status.projectTrial)) && (
              <CreatorProjectDeliveryCard
                threadId={threadId}
                workspace={status.workspace}
                request={useProjectCandidate ? status.projectTrial : undefined}
                delivery={status.projectDelivery}
                api={api}
                onStatus={accept}
              />
            )}
            {businessReview ? (
              <BusinessCreatorReviewCard
                review={businessReview}
                busy={busy}
                startUseScope={status ? { threadId, workspace: status.workspace } : undefined}
                presentation={hostBusinessReview ? "source" : "delivery"}
                onTrial={
                  !hostBusinessReview && api.businessTrial && !businessTrialDiagnostic
                    ? () => {
                        setOpen(false)
                        setBusinessTrialOpen(true)
                      }
                    : undefined
                }
                onApprove={() =>
                  void operate(
                    (expectedWorkspace) =>
                      api.approveBusiness({
                        threadId,
                        expectedWorkspace,
                        planId: businessReview.planId,
                        digest: businessReview.digest
                      }),
                    accept
                  )
                }
                onExport={() =>
                  void operate(
                    (expectedWorkspace) =>
                      api.exportBusiness({
                        threadId,
                        expectedWorkspace,
                        planId: businessReview.planId,
                        digest: businessReview.digest
                      }),
                    accept
                  )
                }
                onRead={() =>
                  void (businessReview.canReconcile
                    ? operate(
                        (expectedWorkspace) =>
                          api.reconcileBusiness({
                            threadId,
                            expectedWorkspace,
                            planId: businessReview.planId,
                            digest: businessReview.digest
                          }),
                        accept
                      )
                    : read())
                }
              />
            ) : (
              !status?.projectTrial && (
                <p className="text-sm text-muted-foreground">
                  项目插件准备完成后，将在这里确认安装为独立插件或导出 ZIP；当前聊天中的单个 Mod
                  可在下方保存复用。
                </p>
              )
            )}
          </section>
        </>
      )}
      <details
        data-creator-section="create"
        className="scroll-mt-4 space-y-3 rounded-xl border p-4"
        open={
          (!businessReview && !status?.projectTrial) ||
          awaitingApproval > 0 ||
          failed ||
          uncertain ||
          (!!independentStageDebugReview && projectPreviewOpen)
        }
      >
        <summary className="cursor-pointer font-semibold">Mod 组件、聊天组合与高级制作设置</summary>
        <p className="text-xs leading-5 text-muted-foreground">
          这里管理当前聊天中的 Mod。项目试用、整轮验收和插件交付分别在上方独立区域查看。
        </p>
        {reuse && (
          <DevelopmentReusePlanCard
            plan={reuse}
            save={status?.save}
            current={reuseCurrent}
            busy={busy}
            onApprove={() => {
              if (
                !reuse.planId ||
                !reuse.compiledDigest ||
                !reuse.targetProfileDigest ||
                !reuseCurrent
              )
                return
              void operate(
                (expectedWorkspace) =>
                  api.approveReuse({
                    threadId,
                    expectedWorkspace,
                    planId: reuse.planId!,
                    sourceDigest: reuse.sourceDigest,
                    compiledDigest: reuse.compiledDigest!,
                    targetProfileDigest: reuse.targetProfileDigest!
                  }),
                accept
              )
            }}
            onPrepare={
              reuseDraft
                ? () =>
                    void operate(
                      (expectedWorkspace) =>
                        api.requestReuse({
                          threadId,
                          expectedWorkspace,
                          id: reuseDraft.id,
                          revision: reuseDraft.revision
                        }),
                      accept
                    )
                : undefined
            }
            onRead={() => void read()}
          />
        )}
        {status?.undo && (
          <div role="status" className="rounded-lg bg-muted/50 p-3 text-xs">
            {status.undo.phase === "active"
              ? "撤销已完成。请核对当前聊天显示与操作效果。"
              : status.undo.phase === "failed"
                ? "撤销尚未确认完成，请先刷新状态核对当前运行版本，不要重复执行。"
                : "已准备撤销，正在等待当前操作结束并恢复运行状态。"}
          </div>
        )}
        {composition && (
          <article aria-label="Mod 组合状态" className="space-y-2 rounded-xl border bg-card p-3">
            <p className="break-words font-medium">{composition.name}</p>
            <p className="break-words text-xs text-muted-foreground">
              包含：{composition.pluginNames.join("、") || "未选择 Mod"}
            </p>
            <p
              role="status"
              className={
                compositionUnconfirmed
                  ? "text-xs text-amber-700 dark:text-amber-400"
                  : composition.phase === "failed"
                    ? "text-xs text-destructive"
                    : "text-xs"
              }
            >
              {composition.phase === "active"
                ? "组合已应用到当前聊天，普通模式下也会继续使用。"
                : compositionRuntimeUnconfirmed
                  ? "组合选择仍保留，组件运行状态待核对。请先核对当前运行状态，不要重复应用。"
                  : compositionUnconfirmed
                    ? "组合已保存，运行切换结果待核对。请先核对当前运行状态，不要重复应用。"
                    : composition.phase === "failed"
                      ? "组合未能应用。请让助手检查当前权限和功能可用状态后重试。"
                      : composition.phase === "cancelled"
                        ? "已取消这次组合变更，原有设置继续使用。"
                        : composition.phase === "applying"
                          ? "正在应用组合，完成后会更新这里的状态。"
                          : "组合已准备好，本轮任务结束且聊天空闲后自动应用。"}
            </p>
            {composition.savedName && (
              <p className="text-xs text-muted-foreground">
                已保存组合“{composition.savedName}”，可在其他聊天选择使用。
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {composition.canCancel && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) => api.cancelComposition({ threadId, expectedWorkspace }),
                      accept
                    )
                  }
                >
                  取消排队
                </button>
              )}
              {composition.canUndo && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) => api.undoComposition({ threadId, expectedWorkspace }),
                      accept
                    )
                  }
                >
                  撤销这次组合
                </button>
              )}
            </div>
          </article>
        )}
        {mode === "entry" && !creatorMode && (
          <div className="space-y-3 rounded-lg bg-muted/50 p-3">
            <p className="text-sm">
              进入创造者模式，一句话描述想创建、修改或组合的 Mod，助手完成配置并应用。
            </p>
            <p className="text-xs text-muted-foreground">
              会开启应用和此项目的灵件功能，已有授权的灵件可能恢复运行。
            </p>
            <button
              type="button"
              className={primaryButton}
              disabled={busy || !status}
              onClick={() => changeMode("creator")}
            >
              进入创造者模式
            </button>
          </div>
        )}
        {creatorMode && !status?.drafts.length && (
          <p className="text-sm">
            直接在聊天描述需求，例如：“组合工具调用统计和失败重试，并在这段聊天应用”。助手会选择现有
            Mod 或创建所需功能，新增权限时再请你确认。
          </p>
        )}
        {creatorMode && status?.request && (
          <p className="text-xs text-muted-foreground">
            {"error" in status.request
              ? "本次制作预算无法核对，已停止继续提交。草稿和当前功能仍保留。"
              : `${status.request.groupId ? "当前目标累计" : "最近一次需求"}已检查 ${status.request.candidates}/3 个候选；重新打开界面不会重置修复次数。`}
            {!("error" in status.request) && status.request.model && (
              <span className="block">
                模型实际请求 {status.request.model.attempts}/{status.request.model.attemptLimit}{" "}
                次（含重试）； 用量已上报 {status.request.model.usageReportedAttempts} 次
                {status.request.model.coverage === "partial" ? "，其余用量待核对" : ""}。
                {status.request.model.recordedModelCalls !== undefined
                  ? ` 原运行记录：模型调用 ${status.request.model.recordedModelCalls} 次、工具调用 ${status.request.model.recordedToolCalls} 次${status.request.model.traceCoverage === "partial" ? "（覆盖不完整）" : ""}。`
                  : " 原运行调用记录待核对。"}
                {status.request.model.inputTokens !== undefined
                  ? ` 已上报输入 ${status.request.model.inputTokens}、输出 ${status.request.model.outputTokens} Token。`
                  : " Token 用量未知。"}
                费用未知：未配置可信价格，不能保证硬费用上限。
                {status.request.model.historicalUsageUnknown
                  ? " 历史模型次数未知，已停止自动续跑；草稿保留，可提出新的需求。"
                  : ""}
              </span>
            )}
          </p>
        )}
        {status?.trials.map((row) => {
          const key = JSON.stringify([
            row.componentId,
            row.revision,
            row.compiledDigest,
            row.bundleDigest,
            row.validation,
            row.capabilities
          ])
          const name =
            status.drafts.find((draft) => draft.id === row.draftId)?.name ?? row.componentId
          return (
            <article
              key={row.componentId}
              aria-label={`组件试用 ${row.componentId}`}
              className="space-y-3 rounded-xl border bg-card p-3 text-sm shadow-sm"
            >
              <p className="break-all font-medium">
                {name}{" "}
                <span className="text-xs font-normal text-muted-foreground">· v{row.revision}</span>
              </p>
              {row.purpose && (
                <p className="line-clamp-2 break-words text-xs" title={row.purpose}>
                  用途：{row.purpose}
                </p>
              )}
              <p
                className={`text-xs font-medium ${row.phase === "failed" ? "text-destructive" : row.phase === "needs-approval" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                role="status"
              >
                {row.phase === "queued" && row.waitingReason === "turn-interrupted"
                  ? "制作已中断，待继续"
                  : row.phase === "active" && row.validation === "authorized-real"
                    ? "版本已生效，真实结果待核对"
                    : phases[row.phase]}
              </p>
              <p className="text-xs">下一步：{developmentNextStep(row)}</p>
              {row.phase === "active" &&
                (!reuse || reuse.draftId !== row.draftId || !reuseCurrent) && (
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void operate(
                        (expectedWorkspace) =>
                          api.requestReuse({
                            threadId,
                            expectedWorkspace,
                            id: row.draftId,
                            revision: row.revision
                          }),
                        accept
                      )
                    }
                  >
                    保存并在其他聊天复用…
                  </button>
                )}
              {row.canUndo && (
                <button
                  type="button"
                  className={button}
                  disabled={busy || undoBusy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.undoTrial({
                          threadId,
                          expectedWorkspace
                        }),
                      accept
                    )
                  }
                >
                  撤销这次修改
                </button>
              )}
              {["unknown", "stopped"].includes(row.phase) && onRequestRepair && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace, assertCurrent) =>
                        enterCreatorMode(
                          settingsApi,
                          api,
                          threadId,
                          expectedWorkspace,
                          assertCurrent
                        ),
                      async (next) => {
                        accept(next)
                        await onRequestRepair(
                          `请核对并恢复这段聊天保存的灵件“${name}”。先读取当前草稿、试用状态与实际运行结果；未知操作不要重放。确认没有旧实例运行后，检查最新源码并重新 request_trial，在当前聊天恢复运行；无需正式安装或跨聊天复用。`
                        )
                        focusChatAfterClose.current = true
                        setOpen(false)
                      }
                    )
                  }
                >
                  恢复这个灵件
                </button>
              )}
              {row.phase === "failed" && (
                <div className="space-y-3 rounded-lg bg-destructive/5 p-3">
                  <p>{developmentFailureMessage(row.error)}</p>
                  {row.activeRevision === undefined && (
                    <p className="text-xs text-muted-foreground">
                      此灵件还没有在这段聊天生效，无需再次寻找批准按钮。
                    </p>
                  )}
                  {(onRequestRepair || onReturnToChat) && (
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={busy}
                      onClick={() => {
                        if (!onRequestRepair) {
                          setOpen(false)
                          onReturnToChat?.()
                          return
                        }
                        void operate(
                          async (expectedWorkspace, assertCurrent) => {
                            const next = await enterCreatorMode(
                              settingsApi,
                              api,
                              threadId,
                              expectedWorkspace,
                              assertCurrent
                            )
                            assertCurrent()
                            await onRequestRepair(developmentRepairPrompt(name, row))
                            return next
                          },
                          (next) => {
                            accept(next)
                            focusChatAfterClose.current = true
                            setOpen(false)
                          }
                        )
                      }}
                    >
                      {busy
                        ? "正在提交修复…"
                        : onRequestRepair
                          ? "修复并重新检查"
                          : "回聊天继续修改"}
                    </button>
                  )}
                </div>
              )}
              {row.phase === "queued" && (
                <p className="text-xs">
                  {row.waitingReason === "turn-interrupted"
                    ? "本轮制作被停止或未完成，请回到聊天继续制作，再试用新版本。"
                    : row.waitingReason === "turn-finishing"
                      ? "正在等待本轮制作结束，完成后会切换到新版本。"
                      : row.waitingReason === "conversation-busy"
                        ? "当前聊天还有任务或界面操作，请结束后再检查试用。"
                        : "已获批准，等待安全切换到新版本。"}
                </p>
              )}
              {row.phase === "queued" && row.waitingReason !== "turn-interrupted" && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.approve({
                          threadId,
                          expectedWorkspace,
                          id: row.componentId,
                          revision: row.revision,
                          digest: row.compiledDigest,
                          sourceDigest: row.bundleDigest
                        }),
                      accept
                    )
                  }
                >
                  重新检查试用
                </button>
              )}
              {row.activeRevision !== undefined &&
                (row.phase !== "active" || row.activeRevision !== row.revision) && (
                  <p>正在使用：v{row.activeRevision}。新版本尚未替换它。</p>
                )}
              {row.phase === "needs-approval" && (
                <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <p className="font-medium">允许这个灵件：</p>
                  {!!row.addedCapabilities?.length && row.activeRevision !== undefined && (
                    <p className="text-xs">
                      本次新增权限：{developmentCapabilitySummary(row.addedCapabilities).join("；")}
                    </p>
                  )}
                  <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                    {developmentCapabilitySummary(row.capabilities).map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    仅在这段聊天试用，不会自动安装。同范围更新自动应用，新增权限会再请你确认。
                  </p>
                  <p className="text-xs">点击下方按钮，即表示同意以上用途与权限范围。</p>
                  <button
                    type="button"
                    className={`${primaryButton} w-full`}
                    disabled={busy}
                    onClick={() =>
                      void operate(
                        (expectedWorkspace) =>
                          api.approve({
                            threadId,
                            expectedWorkspace,
                            id: row.componentId,
                            revision: row.revision,
                            digest: row.compiledDigest,
                            sourceDigest: row.bundleDigest
                          }),
                        accept
                      )
                    }
                  >
                    确认并应用到这段聊天
                  </button>
                </div>
              )}
              <details
                key={`${key}:${row.phase}`}
                className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              >
                <summary className="cursor-pointer">制作详情与完整权限</summary>
                <p className="mt-2">
                  源码保存在这段聊天，重启后需确认恢复。
                  {row.validation === "authorized-real"
                    ? "真实操作仍经过原有权限。"
                    : "本聊天生效不代表外部能力已验证。"}
                </p>
                {row.error &&
                  /^(MODS_|DEVELOPMENT_|AUTHORING_|CLAW_)[A-Z0-9_]+$/.test(row.error) && (
                    <p className="mt-2 break-all">诊断代码：{row.error}</p>
                  )}
                <ul className="mt-2 max-h-40 list-inside list-disc overflow-y-auto space-y-1">
                  {row.capabilities.map((capability) => (
                    <li key={capability} className="break-all">
                      {developmentCapabilityLabel(capability)}
                    </li>
                  ))}
                </ul>
                {!row.capabilities.length && <p>这个版本没有申请额外权限。</p>}
                <p className="mt-2 break-all">
                  目标聊天：{status.threadId}
                  <br />
                  项目：{status.workspace}
                  <br />
                  {row.purpose ? (
                    <>
                      用途：{row.purpose}
                      <br />
                    </>
                  ) : null}
                  源码摘要：{row.bundleDigest}
                  <br />
                  编译摘要：{row.compiledDigest}
                  <br />
                  能力标识：{row.capabilities.join("、") || "无"}
                </p>
                {row.diagnostics && (
                  <p className="mt-2" aria-label="宿主资源诊断">
                    当前聊天组合的宿主核对：业务能力 {row.diagnostics.providers ?? "未知"}，订阅{" "}
                    {row.diagnostics.subscriptions ?? "未知"}， 调用中{" "}
                    {row.diagnostics.inFlight ?? "未知"}，结果未知{" "}
                    {row.diagnostics.unknownRequests ?? "未知"}， 后台资源{" "}
                    {row.diagnostics.backgroundResources ?? "未知"}，页面{" "}
                    {row.diagnostics.pages ?? "未知"}。
                  </p>
                )}
                <p className="mt-2">
                  关闭此制作面板不停止任务。停止试用、撤权、删除或退出应用会结束当前运行；重启先核对状态与权限，不会自动重放真实操作。
                </p>
              </details>
              {row.phase !== "stopped" && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.stop({ threadId, expectedWorkspace, id: row.componentId }),
                      accept
                    )
                  }
                >
                  停止此组件试用
                </button>
              )}
              {row.phase === "unknown" && (
                <p>尚未确认是否停止。请先刷新状态；确认停止前不会开始新的试用。</p>
              )}
              {row.error && row.phase !== "failed" && (
                <p role="status">
                  {row.phase === "queued" && row.error === "MODS_DEVELOPMENT_BUSY"
                    ? "等待当前界面操作结束；已生效的旧版仍保留。"
                    : publicError(new Error(row.error))}
                </p>
              )}
            </article>
          )
        })}
        {status?.enabled && (
          <details
            className="rounded-lg border px-3 py-2 text-xs text-muted-foreground"
            onToggle={(event) => setCreatorOptionsOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer">创作选项</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              {onReturnToChat && (
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    setOpen(false)
                    onReturnToChat()
                  }}
                >
                  去这段聊天继续描述
                </button>
              )}
              <button type="button" className={button} disabled={busy} onClick={stopCreation}>
                结束创作并停止本会话试用
              </button>
            </div>
            <p className="mt-2">结束创作会停止这段聊天的灵件试用。项目试用请从任务页面停止。</p>
            {creatorOptionsOpen && (
              <CreatorPlanningPanel api={api} threadId={threadId} workspace={status.workspace} />
            )}
          </details>
        )}
        {status?.enabled && (
          <details
            data-creator-guide="project-preview"
            className="rounded-lg border px-3 py-2 text-xs text-muted-foreground"
            open={projectPreviewOpen}
            onToggle={(event) => setProjectPreviewOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer">高级：独立项目试用</summary>
            {projectPreviewOpen && (
              <div data-creator-stage-debug-review>
                <ProjectDevelopmentPreviewPanel
                  threadId={threadId}
                  workspace={status.workspace}
                  stageDebugReview={independentStageDebugReview}
                />
              </div>
            )}
          </details>
        )}
        {!!status?.drafts.length &&
          !reuse &&
          !status.trials.some((row) => row.phase === "active") && (
            <div className="flex flex-wrap gap-2">
              {status.drafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.requestReuse({
                          threadId,
                          expectedWorkspace,
                          id: draft.id,
                          revision: draft.revision
                        }),
                      accept
                    )
                  }
                >
                  保存“{draft.name}”并在其他聊天复用…
                </button>
              ))}
            </div>
          )}
        {(onPromoted || saveForReuse) && !!status?.drafts.length && (
          <details className="space-y-2 rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">高级：源码与手动复用</summary>
            <p className="text-xs text-muted-foreground">
              先保存，再确认安装。不会自动启用到其他聊天。
            </p>
            {status.drafts.map((draft) => (
              <div key={draft.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="break-all">
                  {draft.name} · v{draft.revision}
                </span>
                {onPromoted && (
                  <button
                    type="button"
                    className={button}
                    disabled={busy || promotionBlocked}
                    onClick={() =>
                      void operate(
                        (expectedWorkspace) =>
                          api.promote({
                            threadId,
                            expectedWorkspace,
                            id: draft.id,
                            revision: draft.revision
                          }),
                        (value) => {
                          if (value.workspace !== canonical.current)
                            throw Error("DEVELOPMENT_SCOPE_CHANGED")
                          onPromoted(value)
                        }
                      )
                    }
                  >
                    保存复用并打开源码
                  </button>
                )}
                {saveForReuse && (
                  <button
                    type="button"
                    className={button}
                    disabled={busy || promotionBlocked}
                    onClick={() =>
                      void operate(
                        (expectedWorkspace) =>
                          api.promote({
                            threadId,
                            expectedWorkspace,
                            id: draft.id,
                            revision: draft.revision
                          }),
                        (value) => {
                          if (
                            value.workspace !== canonical.current ||
                            value.source.digest !== draft.digest
                          )
                            throw Error("DEVELOPMENT_SCOPE_CHANGED")
                          saveForReuse(value, {
                            id: draft.id,
                            revision: draft.revision,
                            digest: draft.digest
                          })
                        }
                      )
                    }
                  >
                    保存并复用…
                  </button>
                )}
              </div>
            ))}
            {promotionBlocked && (
              <p className="text-xs">请先保存或取消当前高级源码编辑，再打开另一份开发草稿。</p>
            )}
          </details>
        )}
      </details>
      {busy && (
        <p role="status" className="text-sm">
          正在确认操作结果…
        </p>
      )}
      {message && (
        <div role="status" className="space-y-2 rounded-lg bg-muted p-3 text-sm">
          <p>{message}</p>
          {message.includes("灵件功能已关闭") && (
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => changeMode("creator")}
            >
              开启灵件功能
            </button>
          )}
        </div>
      )}
      {onOpenWorkbench && (
        <button
          type="button"
          className={button}
          onClick={() => {
            setOpen(false)
            onOpenWorkbench()
          }}
        >
          打开灵件管理
        </button>
      )}
    </section>
  )
  const businessTrialDialog = !hostBusinessReview &&
    !businessTrialDiagnostic &&
    businessReview &&
    status?.workspace &&
    api.businessTrial && (
      <BusinessCreatorTrialDialog
        open={businessTrialOpen}
        onOpenChange={(next) => {
          setBusinessTrialOpen(next)
        }}
        threadId={threadId}
        workspace={status.workspace}
        review={businessReview}
        trial={businessTrial}
        api={api.businessTrial}
        onStatus={accept}
        onRequestRepair={onRequestRepair}
        onReturnToCreator={() => {
          setBusinessTrialOpen(false)
          setOpen(false)
          onReturnToChat?.()
        }}
        onOpenDelivery={() => {
          setBusinessTrialOpen(false)
          setOpen(true)
          requestAnimationFrame(() =>
            workspaceBody.current
              ?.querySelector<HTMLElement>('[data-creator-section="delivery"]')
              ?.scrollIntoView({ block: "start" })
          )
        }}
      />
    )
  if (mode === "entry")
    return workspaceVisible ? (
      <>
        {content}
        {businessTrialDialog}
      </>
    ) : (
      <section aria-label="会话创作入口" className="space-y-3 rounded-xl border p-4 text-sm">
        <p>
          {creatorMode
            ? "已进入创造者模式，请回到原聊天描述要制作、修改或组合的插件。"
            : "在原聊天直接切换创造者模式，再描述插件需求。"}
        </p>
        {!creatorMode && (
          <button
            type="button"
            className={button}
            disabled={busy || !status}
            onClick={() => changeMode("creator")}
          >
            进入创造者模式
          </button>
        )}
        {onReturnToChat && (
          <button type="button" className={button} onClick={onReturnToChat}>
            返回原聊天
          </button>
        )}
      </section>
    )
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="聊天模式与 Mod 状态">
      <div
        className="inline-flex rounded-lg border border-border/70 bg-background/80 p-0.5"
        role="group"
        aria-label="聊天模式"
      >
        <button
          type="button"
          aria-pressed={!creatorMode}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${!creatorMode ? "bg-muted font-medium" : "text-muted-foreground"}`}
          title="处理日常任务，已应用的 Mod 继续运行"
          disabled={busy || !status}
          onClick={() => {
            if (creatorMode) changeMode("normal")
          }}
        >
          普通模式
        </button>
        <button
          type="button"
          data-app-guide="creator"
          aria-pressed={!!creatorMode}
          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${creatorMode ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground"}`}
          title="开启此项目的 Mod 功能，直接描述创建、修改或组合需求"
          disabled={busy || !status}
          onClick={() => {
            if (!creatorMode) changeMode("creator")
          }}
        >
          <WandSparkles className="size-3.5 shrink-0" aria-hidden="true" />
          创造者模式
        </button>
      </div>
      {creatorMode && (
        <button
          type="button"
          title="查看应用图标、创造者模式、工作区与任务进展的位置"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          onClick={openApplicationUsageGuide}
        >
          <BookOpen className="size-3.5" aria-hidden="true" />
          使用指引
        </button>
      )}
      {workspaceVisible && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-app-guide="workspace"
              aria-label={`${label}${awaitingApproval ? `，${awaitingApproval} 项待确认` : ""}`}
            >
              {label}
              {awaitingApproval > 0 && (
                <span
                  role="status"
                  className="rounded bg-amber-100 px-1.5 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
                >
                  {awaitingApproval} 项待确认
                </span>
              )}
              {message && <span className="text-amber-700 dark:text-amber-400">需核对</span>}
            </button>
          </DialogTrigger>
          <DialogContent
            onCloseAutoFocus={(event) => {
              if (focusChatAfterClose.current) {
                focusChatAfterClose.current = false
                if (onReturnToChat) {
                  event.preventDefault()
                  onReturnToChat()
                }
              }
            }}
            className="h-[92vh] w-[calc(100vw-1rem)] max-w-6xl overflow-hidden p-4 sm:p-6"
            style={{
              gridTemplateRows: showNavigation
                ? "auto auto auto minmax(0,1fr)"
                : "auto auto minmax(0,1fr)",
              // Viewport changes must reflow immediately; open/close keyframe animations remain intact.
              transitionProperty: "none"
            }}
          >
            <DialogTitle>插件创作工作区</DialogTitle>
            <DialogDescription>
              原聊天负责需求和修改，工作区负责试用、验收和保存交付。
            </DialogDescription>
            {showNavigation && (
              <CreatorWorkspaceNavigation onNavigate={navigate} currentStep={nextWorkspaceStep} />
            )}
            <div className="min-h-0 overflow-y-auto pr-1">{content}</div>
          </DialogContent>
        </Dialog>
      )}
      {workspaceVisible && businessTrialDialog}
    </div>
  )
}
