import { developmentCapabilityLabel } from "./development-capability-label"
import {
  developmentCapabilitySummary,
  developmentFailureMessage,
  developmentRepairPrompt,
  developmentNextStep
} from "./development-trial-view"
import { WandSparkles } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { rememberReuseSelection } from "./development-reuse-receipts"
import type { DevelopmentSetupApi } from "./development-creation-setup"
import { enterCreatorMode } from "./creator-mode-entry"
import { useCallback, useEffect, useRef, useState } from "react"
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
  if (message.includes("CREATOR_REPAIR_BUSY"))
    return "请先处理当前任务或待确认事项，再修复灵件。"
  if (message.includes("CREATOR_REPAIR_MODEL_REQUIRED"))
    return "请先选择可用模型，再修复灵件。"
  if (message.includes("CREATOR_REPAIR_EMPTY"))
    return "未能取得修复说明，请刷新灵件状态后重试。"
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
  if (!threadId || !api || workspaceHint === null)
    return <CreatorWorkspaceEntry key={threadId ?? "unselected"} onSelect={threadId ? onSelectWorkspaceForCreator : undefined} />
  return (
    <ScopedDevelopment
      key={JSON.stringify([threadId, workspaceHint])}
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
    return () => { live.current = false }
  }, [])
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="选择创作目录">
      <span className="text-muted-foreground">普通模式</span>
      <button type="button" className={button} disabled={busy || !onSelect}
        onClick={async () => {
          if (!onSelect || busy) return
          setBusy(true)
          setMessage("")
          try { await onSelect() }
          catch (error) { if (live.current) setMessage(publicError(error)) }
          finally { if (live.current) setBusy(false) }
        }}>
        {busy ? "正在选择创作目录…" : "选择目录并进入创造者模式"}
      </button>
      {message && <p role="status" className="text-muted-foreground">{message}</p>}
    </div>
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
  const focusChatAfterClose = useRef(false)
  const [status, setStatus] = useState<DevelopmentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const live = useRef(false),
    pending = useRef(false),
    generation = useRef(0)
  const canonical = useRef<string | null>(null)
  const modeChanged = useRef(onModeChange)
  modeChanged.current = onModeChange
  const announcedApproval = useRef("")
  const announcedTrialAttention = useRef("")
  const announcedCompositionFailure = useRef("")
  const announcedReuse = useRef("")
  const [projectPreviewOpen, setProjectPreviewOpen] = useState(false)
  const accept = useCallback(
    (next: DevelopmentStatus) => {
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
  const read = useCallback(async (clearError = true) => {
    if (pending.current) return
    const ticket = ++generation.current
    try {
      const next = await api.status({ threadId })
      if (!live.current || generation.current !== ticket) return
      accept(next)
      if (clearError) setMessage("")
    } catch (error) {
      if (live.current && generation.current === ticket) setMessage(publicError(error))
    }
  }, [api, threadId, accept])
  useEffect(() => {
    live.current = true
    pending.current = false
    setBusy(false)
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
        if (!live.current || ticket !== generation.current || canonical.current !== workspace)
          throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
      const result = await call(workspace, assertCurrent)
      if (!live.current || ticket !== generation.current) return
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
      accept
    )
  const creatorMode = status?.mode === "creator" || (status?.mode === undefined && status?.enabled)
  const awaitingApproval =
    status?.trials.filter((row) => row.phase === "needs-approval").length ?? 0
  const active = status?.trials.some(
    (row) => row.activeRevision !== undefined && row.phase !== "stopped"
  )
  const failed = status?.trials.some((row) => row.phase === "failed")
  const uncertain = status?.trials.some((row) => row.phase === "unknown" ||
    (row.diagnostics?.unknownRequests ?? 0) > 0)
  const trialAttentionKey = JSON.stringify(status?.trials
    .filter(row => ["failed", "unknown"].includes(row.phase) ||
      (row.diagnostics?.unknownRequests ?? 0) > 0)
    .map(row => [row.componentId, row.revision, row.compiledDigest, row.phase, row.error]) ?? [])
  useEffect(() => {
    if (trialAttentionKey !== "[]" && mode === "chat" &&
      announcedTrialAttention.current !== trialAttentionKey) {
      announcedTrialAttention.current = trialAttentionKey
      setOpen(true)
    }
    if (trialAttentionKey === "[]") announcedTrialAttention.current = ""
  }, [mode, trialAttentionKey])
  const composition = status?.composition
  const undoBusy = status?.undo?.phase === "queued" || status?.undo?.phase === "applying"
  const reuse = status?.reuse
  const reuseDraft = status?.drafts.find((draft) => draft.id === reuse?.draftId)
  const reuseCurrent = !!reuse && !!reuseDraft && reuseDraft.revision === reuse.revision &&
    reuseDraft.digest === reuse.sourceDigest
  const reuseKey = reuse && ["needs-approval", "failed", "unknown"].includes(reuse.phase)
    ? JSON.stringify([reuse.planId, reuse.phase, reuse.sourceDigest, reuse.compiledDigest]) : ""
  useEffect(() => {
    if (mode === "chat" && reuseKey && announcedReuse.current !== reuseKey) {
      announcedReuse.current = reuseKey
      setOpen(true)
    }
    if (!reuseKey) announcedReuse.current = ""
  }, [mode, reuseKey])
  const compositionRuntimeUnconfirmed = composition?.phase === "failed" &&
    composition.error === "COMPOSITION_RUNTIME_UNCONFIRMED"
  const compositionUnconfirmed = compositionRuntimeUnconfirmed || composition?.phase === "failed" &&
    composition.error === "MODS_COMPOSITION_APPLY_UNCONFIRMED"
  const compositionFailureKey = composition?.phase === "failed"
    ? JSON.stringify([composition.name, composition.pluginNames, composition.error]) : ""
  useEffect(() => {
    if (mode === "chat" && compositionFailureKey &&
      announcedCompositionFailure.current !== compositionFailureKey) {
      announcedCompositionFailure.current = compositionFailureKey
      setOpen(true)
    }
    if (!compositionFailureKey) announcedCompositionFailure.current = ""
  }, [mode, compositionFailureKey])
  const approvalKey = JSON.stringify(status?.trials.filter((row) => row.phase === "needs-approval")
    .map((row) => [row.componentId, row.revision, row.bundleDigest, row.compiledDigest]) ?? [])
  useEffect(() => {
    if (mode === "chat" && awaitingApproval && announcedApproval.current !== approvalKey) {
      announcedApproval.current = approvalKey
      setOpen(true)
    }
    if (!awaitingApproval) announcedApproval.current = ""
  }, [mode, awaitingApproval, approvalKey])
  const label = undoBusy ? "正在撤销修改"
    : status?.undo?.phase === "failed" ? "撤销结果待核对"
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
          : composition && ["queued", "applying"].includes(composition.phase)
            ? "正在应用组合"
            : active
              ? "灵件试用中"
              : status?.trials.some((row) => ["queued", "preflight", "retiring"].includes(row.phase))
                ? "正在准备试用"
                : composition?.phase === "active" ? "组合已应用"
                  : reuse?.phase === "active" ? "已保存跨聊天复用" : "Mod 状态"
  const saveForReuse =
    onReuse ??
    (onOpenWorkbench
      ? (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => {
          rememberReuseSelection(JSON.stringify([threadId, workspaceHint]), { document, origin })
          setOpen(false)
          onOpenWorkbench()
        }
      : undefined)
  const content = (
    <section
      aria-label="灵件对话创作"
      className={
        mode === "chat"
          ? "space-y-3 text-sm"
          : "mx-auto max-w-3xl space-y-3 rounded-xl border bg-card p-4"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{mode === "chat" ? "Mod 状态" : "在所选聊天使用创造者模式"}</h2>
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
      {reuse && (
        <DevelopmentReusePlanCard plan={reuse} current={reuseCurrent} busy={busy}
          onApprove={() => {
            if (!reuse.planId || !reuse.compiledDigest || !reuse.targetProfileDigest || !reuseCurrent) return
            void operate((expectedWorkspace) => api.approveReuse({
              threadId, expectedWorkspace, planId: reuse.planId!,
              sourceDigest: reuse.sourceDigest, compiledDigest: reuse.compiledDigest!,
              targetProfileDigest: reuse.targetProfileDigest!
            }), accept)
          }}
          onPrepare={reuseDraft ? () => void operate((expectedWorkspace) => api.requestReuse({
            threadId, expectedWorkspace, id: reuseDraft.id, revision: reuseDraft.revision
          }), accept) : undefined}
          onRead={() => void read()} />
      )}
      {status?.undo && <div role="status" className="rounded-lg bg-muted/50 p-3 text-xs">
        {status.undo.phase === "active" ? "撤销已完成。请核对当前聊天显示与操作效果。"
          : status.undo.phase === "failed" ? "撤销尚未确认完成，请先刷新状态核对当前运行版本，不要重复执行。"
            : "已准备撤销，正在等待当前操作结束并恢复运行状态。"}
      </div>}
      {composition && (
        <article aria-label="Mod 组合状态" className="space-y-2 rounded-xl border bg-card p-3">
          <p className="break-words font-medium">{composition.name}</p>
          <p className="break-words text-xs text-muted-foreground">
            包含：{composition.pluginNames.join("、") || "未选择 Mod"}
          </p>
          <p role="status" className={compositionUnconfirmed
            ? "text-xs text-amber-700 dark:text-amber-400"
            : composition.phase === "failed" ? "text-xs text-destructive" : "text-xs"}>
            {composition.phase === "active" ? "组合已应用到当前聊天，普通模式下也会继续使用。"
              : compositionRuntimeUnconfirmed ? "组合选择仍保留，组件运行状态待核对。请先核对当前运行状态，不要重复应用。"
                : compositionUnconfirmed ? "组合已保存，运行切换结果待核对。请先核对当前运行状态，不要重复应用。"
                : composition.phase === "failed" ? "组合未能应用。请让助手检查当前权限和功能可用状态后重试。"
                : composition.phase === "cancelled" ? "已取消这次组合变更，原有设置继续使用。"
                : composition.phase === "applying" ? "正在应用组合，完成后会更新这里的状态。"
                  : "组合已准备好，本轮任务结束且聊天空闲后自动应用。"}
          </p>
          {composition.savedName && <p className="text-xs text-muted-foreground">
            已保存组合“{composition.savedName}”，可在其他聊天选择使用。
          </p>}
          <div className="flex flex-wrap gap-2">
            {composition.canCancel && <button type="button" className={button} disabled={busy}
              onClick={() => void operate((expectedWorkspace) =>
                api.cancelComposition({ threadId, expectedWorkspace }), accept)}>
              取消排队
            </button>}
            {composition.canUndo && <button type="button" className={button} disabled={busy}
              onClick={() => void operate((expectedWorkspace) =>
                api.undoComposition({ threadId, expectedWorkspace }), accept)}>
              撤销这次组合
            </button>}
          </div>
        </article>
      )}
      {mode === "entry" && !creatorMode && (
        <div className="space-y-3 rounded-lg bg-muted/50 p-3">
          <p className="text-sm">进入创造者模式，一句话描述想创建、修改或组合的 Mod，助手完成配置并应用。</p>
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
          直接在聊天描述需求，例如：“组合工具调用统计和失败重试，并在这段聊天应用”。助手会选择现有 Mod 或创建所需功能，新增权限时再请你确认。
        </p>
      )}
      {creatorMode && status?.request && (
        <p className="text-xs text-muted-foreground">
          {"error" in status.request
            ? "本次制作预算无法核对，已停止继续提交。草稿和当前功能仍保留。"
            : `${status.request.groupId ? "当前目标累计" : "最近一次需求"}已检查 ${status.request.candidates}/3 个候选；重新打开界面不会重置修复次数。`}
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
            {row.purpose && <p className="line-clamp-2 break-words text-xs" title={row.purpose}>用途：{row.purpose}</p>}
            <p
              className={`text-xs font-medium ${row.phase === "failed" ? "text-destructive" : row.phase === "needs-approval" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
              role="status"
            >
              {row.phase === "queued" && row.waitingReason === "turn-interrupted"
                ? "制作已中断，待继续"
                : row.phase === "active" && row.validation === "authorized-real"
                  ? "版本已生效，真实结果待核对" : phases[row.phase]}
            </p>
            <p className="text-xs">下一步：{developmentNextStep(row)}</p>
            {row.phase === "active" && (!reuse || reuse.draftId !== row.draftId || !reuseCurrent) && (
              <button type="button" className={button} disabled={busy}
                onClick={() => void operate((expectedWorkspace) => api.requestReuse({
                  threadId, expectedWorkspace, id: row.draftId, revision: row.revision
                }), accept)}>
                保存并在其他聊天复用…
              </button>
            )}
            {row.canUndo && <button type="button" className={button} disabled={busy || undoBusy}
              onClick={() => void operate((expectedWorkspace) => api.undoTrial({
                threadId, expectedWorkspace
              }), accept)}>
              撤销这次修改
            </button>}
            {["unknown", "stopped"].includes(row.phase) && onRequestRepair && (
              <button type="button" className={button} disabled={busy}
                onClick={() => void operate((expectedWorkspace, assertCurrent) =>
                  enterCreatorMode(settingsApi, api, threadId, expectedWorkspace, assertCurrent),
                async (next) => {
                  accept(next)
                  await onRequestRepair(`请核对并恢复这段聊天保存的灵件“${name}”。先读取当前草稿、试用状态与实际运行结果；未知操作不要重放。确认没有旧实例运行后，检查最新源码并重新 request_trial，在当前聊天恢复运行；无需正式安装或跨聊天复用。`)
                  focusChatAfterClose.current = true
                  setOpen(false)
                })}>
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
                      if (!onRequestRepair) { setOpen(false); onReturnToChat?.(); return }
                      void operate(async (expectedWorkspace, assertCurrent) => {
                        const next = await enterCreatorMode(settingsApi, api, threadId,
                          expectedWorkspace, assertCurrent)
                        assertCurrent()
                        await onRequestRepair(developmentRepairPrompt(name, row))
                        return next
                      }, next => {
                        accept(next)
                        focusChatAfterClose.current = true
                        setOpen(false)
                      })
                    }}
                  >
                    {busy ? "正在提交修复…" : onRequestRepair ? "修复并重新检查" : "回聊天继续修改"}
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
                  <p className="text-xs">本次新增权限：{developmentCapabilitySummary(row.addedCapabilities).join("；")}</p>
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
              <p className="mt-2">源码保存在这段聊天，重启后需确认恢复。
                {row.validation === "authorized-real" ? "真实操作仍经过原有权限。" : "本聊天生效不代表外部能力已验证。"}</p>
              {row.error && /^(MODS_|DEVELOPMENT_|AUTHORING_|CLAW_)[A-Z0-9_]+$/.test(row.error) &&
                <p className="mt-2 break-all">诊断代码：{row.error}</p>}
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
                {row.purpose ? <>用途：{row.purpose}<br /></> : null}
                源码摘要：{row.bundleDigest}
                <br />
                编译摘要：{row.compiledDigest}
                <br />
                能力标识：{row.capabilities.join("、") || "无"}
              </p>
              {row.diagnostics && (
                <p className="mt-2" aria-label="宿主资源诊断">
                  当前聊天组合的宿主核对：业务能力 {row.diagnostics.providers ?? "未知"}，订阅 {row.diagnostics.subscriptions ?? "未知"}，
                  调用中 {row.diagnostics.inFlight ?? "未知"}，结果未知 {row.diagnostics.unknownRequests ?? "未知"}，
                  后台资源 {row.diagnostics.backgroundResources ?? "未知"}，页面 {row.diagnostics.pages ?? "未知"}。
                </p>
              )}
              <p className="mt-2">关闭此制作面板不停止任务。停止试用、撤权、删除或退出应用会结束当前运行；重启先核对状态与权限，不会自动重放真实操作。</p>
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
        <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
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
        </details>
      )}
      {status?.enabled && (
        <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground"
          onToggle={(event) => setProjectPreviewOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer">高级：独立项目试用</summary>
          {projectPreviewOpen && <ProjectDevelopmentPreviewPanel threadId={threadId} workspace={status.workspace} />}
        </details>
      )}
      {!!status?.drafts.length && !reuse && !status.trials.some((row) => row.phase === "active") && (
        <div className="flex flex-wrap gap-2">
          {status.drafts.map((draft) => <button key={draft.id} type="button" className={button}
            disabled={busy} onClick={() => void operate((expectedWorkspace) => api.requestReuse({
              threadId, expectedWorkspace, id: draft.id, revision: draft.revision
            }), accept)}>
            保存“{draft.name}”并在其他聊天复用…
          </button>)}
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
  if (mode === "entry") return content
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="聊天模式与 Mod 状态">
      <div className="inline-flex rounded-lg border border-border/70 bg-background/80 p-0.5" role="group" aria-label="聊天模式">
        <button
          type="button"
          aria-pressed={!creatorMode}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${!creatorMode ? "bg-muted font-medium" : "text-muted-foreground"}`}
          title="处理日常任务，已应用的 Mod 继续运行"
          disabled={busy || !status}
          onClick={() => { if (creatorMode) changeMode("normal") }}
        >
          普通模式
        </button>
        <button
          type="button"
          aria-pressed={!!creatorMode}
          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${creatorMode ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground"}`}
          title="开启此项目的 Mod 功能，直接描述创建、修改或组合需求"
          disabled={busy || !status}
          onClick={() => { if (!creatorMode) changeMode("creator") }}
        >
          <WandSparkles className="size-3.5 shrink-0" aria-hidden="true" />
          创造者模式
        </button>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      </PopoverTrigger>
      <PopoverContent
        onCloseAutoFocus={(event) => {
          if (focusChatAfterClose.current) {
            focusChatAfterClose.current = false
            if (onReturnToChat) {
              event.preventDefault()
              onReturnToChat()
            }
          }
        }}
        align="start"
        side="top"
        className="max-h-[min(70vh,640px)] w-[min(420px,calc(100vw-24px))] overflow-y-auto"
      >
        {content}
      </PopoverContent>
      </Popover>
    </div>
  )
}
