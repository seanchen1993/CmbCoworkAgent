import type { StageDebugReviewIntent } from "../../../../shared/mods/v2/project-stage-debug-review"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ProjectPreviewApi,
  ProjectPreviewDraft
} from "../../../../shared/project-runtime/development-preview"
import type {
  ProjectStageDebugApi,
  StageDebugPreparation
} from "../../../../shared/project-runtime/stage-debug"
import { ProjectStageDebugComparisonCard } from "./ProjectStageDebugComparisonCard"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { projectRuntimeRecoveryMessage } from "../harness-board/project-runtime-message"

const statusLabels = {
  ready: "待原生确认并执行",
  running: "正在隔离执行",
  passed: "本次调试范围的检查已通过",
  failed: "本次调试失败",
  unknown: "结果尚未确认，须先核对"
} as const

type DebugList = Awaited<ReturnType<ProjectStageDebugApi["list"]>>

function stageDebugErrorMessage(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : String(cause)
  if (/PROJECT_STAGE_DEBUG_(READONLY_ADAPTER_REQUIRED|CHECK_INPUT_UNSUPPORTED|CHECK_EFFECT_UNSUPPORTED)|PROJECT_READONLY_CHECK_/.test(code))
    return projectRuntimeRecoveryMessage(code)!
  const original = "原项目、产物和检查要求均保留，请继续使用原项目入口。"
  if (/RECOVERY_APPROVAL_REQUIRED/.test(code))
    return "本次 Hooks 恢复需要重新核对命令与外部副作用。请重新准备方案，阅读说明并单独勾选确认；旧方案的确认不会继承。"
  if (/SOURCE_UNSETTLED|DEV_RUNNING|OPERATION_ACTIVE|WORKSPACE_BUSY/.test(code))
    return "原试用仍占用输入或执行权限。请先打开原试用记录：正在运行时先停止并核对，结果未知时先核对；确认已停止后使用上方“结束本次试用”释放占用，再刷新准备。无须先完成整个项目。"
  if (/HOOKS?_UNSUPPORTED|SKILL_HOOKS_/.test(code))
    return `此阶段依赖项目或技能 Hooks，当前尚缺 Hooks 的隔离适配，不能跳过原业务校验进行调试。${original}`
  if (/MCP_UNSUPPORTED/.test(code))
    return `此阶段依赖 MCP 或外部服务，当前尚缺外部依赖的隔离适配。${original}`
  if (/CONTEXT_UNSUPPORTED/.test(code))
    return `此阶段依赖动态上下文或知识加载，当前尚缺上下文的隔离适配，不能省略这些输入。${original}`
  if (/CONFIGURATION_UNSUPPORTED/.test(code))
    return `此阶段的用户配置依赖尚不能安全迁移到调试分支，当前尚缺配置的隔离适配。${original}`
  if (/ACTIONS_UNSUPPORTED/.test(code))
    return `此阶段包含插件动作，当前尚缺动作及其外部副作用的隔离适配。${original}`
  if (/SHARED_MODS_UNSUPPORTED|MODS_UNSUPPORTED/.test(code))
    return `此阶段依赖共享 Mods 或运行拦截，当前尚缺这些扩展的隔离适配；不能通过关闭其他 Mods 绕过原规则。${original}`
  if (/CHECK_EFFECT/.test(code))
    return `此阶段的检查可能产生外部副作用，当前尚缺校验器的隔离适配，不能删除检查来运行。${original}`
  if (/CONTRACT_CHANGED/.test(code))
    return "阶段、输入产物或校验契约已改变，旧快照不能证明新阶段输入兼容。原项目与记录保留；请选择更早的阶段起点，或重新进行完整试用，再准备并确认新调试方案。"
  if (/PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED|INPUT_SOURCE_CHANGED|SOURCE_CHANGED/.test(code))
    return "源码或共享输入文件已变化，刚才的调试确认已失效。原项目与记录保留；请刷新当前候选并重新准备、确认。若修改影响前序输入，请选择更早的阶段起点，或重新进行完整试用。"
  if (/SINGLE_STAGE_ONLY/.test(code))
    return "此分支只允许调试所选阶段，不能直接推进后续阶段。原项目与记录保留；如需验证下游，请重新准备“从所选阶段开始，重新验证后续阶段”的分支并确认。"
  if (/RECONFIRMATION_REQUIRED/.test(code))
    return "此调试分支的执行授权已失效，历史记录保留但不能直接恢复旧授权。请刷新阶段快照和当前候选，重新准备并确认新分支；原项目入口仍可查看原运行。"
  if (/CHANGED|STALE/.test(code))
    return "源码、输入或权限已变化，刚才的确认已失效。原项目与记录保留，请刷新并重新准备、确认。若已提交创建，请先核对分支记录，避免重复创建。"
  return "阶段调试请求未能完成，原项目与记录保留。请刷新核对分支与原生记录；结果未知时不要直接重跑。"
}

export function ProjectStageDebugPanel(props: {
  threadId: string
  workspace: string
  draftId?: string
  preview: ProjectPreviewApi
  stageDebugReview?: StageDebugReviewIntent
  selectedProjectId?: string
  onOpenProject: (projectId: string) => void
  onFinishProject?: (projectId: string) => void
  onOpenSource?: (projectId: string) => void
  onRequestRepair?: (message: string) => void | Promise<void>
  onReturnToChat?: () => void
}) {
  if (!props.preview.stageDebug) return null
  return (
    <ScopedStageDebug
      key={JSON.stringify([props.threadId, props.workspace, props.draftId])}
      {...props}
      api={props.preview.stageDebug}
    />
  )
}

function ScopedStageDebug({
  threadId,
  workspace,
  draftId,
  preview,
  api,
  stageDebugReview,
  selectedProjectId,
  onOpenProject,
  onFinishProject,
  onOpenSource,
  onRequestRepair,
  onReturnToChat
}: {
  threadId: string
  workspace: string
  draftId?: string
  preview: ProjectPreviewApi
  api: ProjectStageDebugApi
  stageDebugReview?: StageDebugReviewIntent
  selectedProjectId?: string
  onOpenProject: (projectId: string) => void
  onFinishProject?: (projectId: string) => void
  onOpenSource?: (projectId: string) => void
  onRequestRepair?: (message: string) => void | Promise<void>
  onReturnToChat?: () => void
}) {
  const [data, setData] = useState<DebugList>({ snapshots: [], branches: [], diagnostics: [] })
  const [drafts, setDrafts] = useState<ProjectPreviewDraft[]>([])
  const [allDrafts, setAllDrafts] = useState<ProjectPreviewDraft[]>([])
  const [snapshotId, setSnapshotId] = useState("")
  const [candidateId, setCandidateId] = useState("")
  const [mode, setMode] = useState<"stage" | "downstream">("stage")
  const [preparation, setPreparation] = useState<StageDebugPreparation>()
  const [confirmed, setConfirmed] = useState(false)
  const [recoveryApproval, setRecoveryApproval] = useState<{
    preparationId: string
    policyDigest: string
  }>()
  const [feedback, setFeedback] = useState("")
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [hookInspection, setHookInspection] = useState<{
    projectId: string
    remaining: number
    diagnostics: string[]
    requiresNetworkInspection?: true
  }>()
  const [hookNetworkApproval, setHookNetworkApproval] = useState("")
  const live = useRef(false),
    locked = useRef(false),
    readSequence = useRef(0)
  const reviewedIntent = useRef("")
  const latestIntentId = useRef(stageDebugReview?.id ?? "")
  latestIntentId.current = stageDebugReview?.id ?? ""
  const [reviewReadId, setReviewReadId] = useState("")
  const identity = useRef("")
  const epoch = useRef(0)
  const snapshot = data.snapshots.find((item) => item.id === snapshotId)
  const candidate = drafts.find((item) => item.id === candidateId)
  const recoveryApproved = !preparation?.recovery?.requiresNetworkApproval || (
    recoveryApproval?.preparationId === preparation.id &&
    recoveryApproval.policyDigest === preparation.recovery.policyDigest
  )
  const invalidate = () => {
    epoch.current++
    setPreparation(undefined)
    setConfirmed(false)
    setRecoveryApproval(undefined)
  }
  const read = useCallback(async () => {
    const sequence = ++readSequence.current
    const intentId = latestIntentId.current
    const [facts, source] = await Promise.all([api.list(threadId), preview.list(threadId)])
    if (!live.current || sequence !== readSequence.current) return
    if (source.threadId !== threadId || !isSameWorkspacePath(source.workspace, workspace))
      throw Error("PROJECT_STAGE_DEBUG_SCOPE_CHANGED")
    const candidates = source.drafts.filter((item) => !draftId || item.id === draftId)
    const nextIdentity = JSON.stringify([
      facts.snapshots,
      candidates.map((item) => [item.id, item.revision, item.digest])
    ])
    if (identity.current !== nextIdentity) {
      identity.current = nextIdentity
      epoch.current++
      setPreparation(undefined)
      setConfirmed(false)
    }
    setData(facts)
    setAllDrafts(source.drafts)
    setDrafts(candidates)
    setReviewReadId(intentId)
    setSnapshotId((current) =>
      facts.snapshots.some((item) => item.id === current) ? current : (facts.snapshots[0]?.id ?? "")
    )
    setCandidateId((current) =>
      candidates.some((item) => item.id === current) ? current : (candidates[0]?.id ?? "")
    )
  }, [api, preview, threadId, workspace, draftId])
  const act = async (work: () => Promise<void>) => {
    if (locked.current || !live.current) return
    locked.current = true
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (cause) {
      if (live.current) {
        setPreparation(undefined)
        setConfirmed(false)
        setError(stageDebugErrorMessage(cause))
      }
    } finally {
      locked.current = false
      if (live.current) setBusy(false)
    }
  }
  useEffect(() => {
    live.current = true
    void read().catch(() => {
      if (live.current) setError("无法读取阶段调试记录，请刷新重试。")
    })
    const unsubscribe = window.api.mods?.development?.onChanged?.((event) => {
      if (event.threadId === threadId) void read().catch(() => {})
    })
    return () => {
      live.current = false
      readSequence.current++
      epoch.current++
      unsubscribe?.()
    }
  }, [read, threadId])
  useEffect(() => {
    if (!stageDebugReview) return
    epoch.current++
    setPreparation(undefined)
    setConfirmed(false)
    void read().catch(() => {
      if (live.current) setError("无法读取 Mod 建议对应的当前来源，请刷新后重新核对。")
    })
  }, [stageDebugReview?.id, read])
  useEffect(() => {
    const intent = stageDebugReview
    if (!intent || reviewedIntent.current === intent.id || !identity.current || reviewReadId !== intent.id) return
    reviewedIntent.current = intent.id
    if (intent.threadId !== threadId || !isSameWorkspacePath(intent.workspace, workspace) || intent.expiresAt <= Date.now()) {
      setError("Mod 的调试建议已过期或不属于本创作会话，不能沿用；请在当前会话手动重新选择并准备。")
      return
    }
    const source = drafts.find(draft => draft.id === intent.draftId && draft.revision === intent.revision && draft.digest === intent.candidateDigest)
    if (!source || !data.snapshots.some(snapshot => snapshot.id === intent.snapshotId)) {
      setError("Mod 建议所指的候选版本或快照已变化。建议不构成授权，请刷新来源并手动重新准备。")
      return
    }
    epoch.current++
    setSnapshotId(intent.snapshotId); setCandidateId(source.id); setMode(intent.mode)
    setPreparation(undefined); setConfirmed(false)
  }, [stageDebugReview, threadId, workspace, drafts, data.snapshots, reviewReadId])
  const running = data.branches.some((item) => item.status === "running")
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void read().catch(() => {})
    }, 2500)
    return () => clearInterval(timer)
  }, [running, read])
  return (
    <section aria-label="阶段隔离调试" className="min-w-0 space-y-3 rounded border p-3 text-sm">
      <div className="flex flex-wrap justify-between gap-2">
        <h4 className="font-medium">从阶段输入快照继续调试</h4>
        <button type="button" className="underline" disabled={busy} onClick={() => void act(read)}>
          刷新阶段调试记录
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        选择原生保存的阶段起点，在原聊天修改插件，再使用最新候选创建隔离分支。原项目与原产物保留，旧授权和旧通过结果不会转为新分支的授权或验收结果。
      </p>
      {stageDebugReview && <aside aria-label="Mod 提交的阶段调试建议" className="space-y-1 rounded border p-2 text-xs">
        <p>建议来自 Mod：{stageDebugReview.caller.name}</p>
        <p className="break-all">Mod 版本摘要：{stageDebugReview.caller.digest}</p>
        <p>此建议只预选输入快照、候选与范围，尚未授予执行权限。请重新点击“准备阶段调试方案”，核对原生读取的当前来源后再勾选并创建。</p>
      </aside>}
      {error && <p role="alert">{error}</p>}
      {data.diagnostics.map((message, index) => (
        <p key={index} className="break-words text-xs">
          {message}
        </p>
      ))}
      {!data.snapshots.length && (
        <p>尚无可用的阶段输入快照。先运行原项目阶段；未保存的历史输入不能从当前产物反推。</p>
      )}
      {!!data.snapshots.length && (
        <>
          <label className="grid gap-1">
            选择阶段输入快照
            <select
              aria-label="选择阶段输入快照"
              className="min-w-0 max-w-full rounded border bg-background p-2"
              value={snapshotId}
              disabled={busy}
              onChange={(event) => {
                setSnapshotId(event.target.value)
                invalidate()
              }}
            >
              {data.snapshots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.stageTitle} · {new Date(item.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {snapshot && (
            <div className="space-y-1 rounded bg-muted/30 p-2 text-xs">
              <p>
                原阶段：{snapshot.stageTitle} · 输入文件 {snapshot.fileCount} 个，共{" "}
                {snapshot.totalBytes} 字节
              </p>
              <p className="break-all">来源项目：{snapshot.projectId}</p>
              <p className="break-all">原源码摘要：{snapshot.sourceDigest}</p>
              <p>
                准备分支前须结束仍占用权限的原试用；正在运行或结果未知时先在原生记录中停止并核对，不要求先跑完整个项目。
              </p>
              {onOpenSource && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => onOpenSource(snapshot.projectId)}
                >
                  查看快照所属原试用
                </button>
              )}
            </div>
          )}
          {onRequestRepair && (
            <>
              <label className="grid gap-1">
                此阶段希望如何修改
                <textarea
                  className="min-h-20 rounded border bg-background p-2"
                  value={feedback}
                  maxLength={8000}
                  onChange={(event) => {
                    setFeedback(event.target.value)
                    setFeedbackSent(false)
                  }}
                />
              </label>
              <button
                type="button"
                className="rounded border px-3 py-2 disabled:opacity-50"
                disabled={busy || !snapshot || !feedback.trim()}
                onClick={() =>
                  void act(async () => {
                    const submitted = feedback
                    await onRequestRepair(
                      `请在本原创作会话修改项目插件。阶段 ${snapshot!.stageId}（${snapshot!.stageTitle}），输入快照 ${snapshot!.id}，原项目 ${snapshot!.projectId}，原源码摘要 ${snapshot!.sourceDigest}。我的要求：${submitted.trim()}。请保存新候选，保留原阶段输入和原检查契约；不要直接修改原项目状态或重放未知操作，调试分支须经用户原生确认后创建。`
                    )
                    if (!live.current) return
                    setFeedback((current) => (current === submitted ? "" : current))
                    setFeedbackSent(true)
                  })
                }
              >
                将阶段修改要求发送到原聊天
              </button>
              {feedbackSent && (
                <p role="status">
                  修改要求已发送到原聊天。待助手保存新候选后刷新，再准备隔离调试。
                </p>
              )}
            </>
          )}
          {onReturnToChat && (
            <button type="button" className="underline" onClick={onReturnToChat}>
              回原聊天修改阶段
            </button>
          )}
          <label className="grid gap-1">
            选择已保存的最新候选
            <select
              aria-label="选择已保存的最新候选"
              className="min-w-0 max-w-full rounded border bg-background p-2"
              value={candidateId}
              disabled={busy}
              onChange={(event) => {
                setCandidateId(event.target.value)
                invalidate()
              }}
            >
              {!drafts.length && <option value="">尚无已保存候选</option>}
              {drafts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · 修订 {item.revision}
                </option>
              ))}
            </select>
          </label>
          {candidate && (
            <p className="break-all text-xs">
              当前候选摘要：{candidate.digest ?? "未提供，不能准备调试"}
            </p>
          )}
          <label className="grid gap-1">
            调试范围
            <select
              aria-label="调试范围"
              className="rounded border bg-background p-2"
              value={mode}
              disabled={busy}
              onChange={(event) => {
                setMode(event.target.value as "stage" | "downstream")
                invalidate()
              }}
            >
              <option value="stage">只调试所选阶段</option>
              <option value="downstream">从所选阶段开始，重新验证后续阶段</option>
            </select>
          </label>
          <button
            type="button"
            className="rounded border px-3 py-2 disabled:opacity-50"
            disabled={busy || !snapshot || !candidate?.digest}
            onClick={() =>
              void act(async () => {
                const ticket = epoch.current
                setPreparation(undefined)
                setConfirmed(false)
                const next = await api.prepare({
                  threadId,
                  snapshotId,
                  draftId: candidate!.id,
                  revision: candidate!.revision,
                  expectedDigest: candidate!.digest!,
                  mode
                })
                if (!live.current) return
                if (
                  ticket !== epoch.current ||
                  next.snapshotId !== snapshotId ||
                  next.sourceProjectId !== snapshot!.projectId ||
                  next.stageId !== snapshot!.stageId ||
                  next.mode !== mode ||
                  next.candidateDigest !== candidate!.digest
                )
                  throw Error("PROJECT_STAGE_DEBUG_SOURCE_CHANGED")
                setPreparation(next)
              })
            }
          >
            准备阶段调试方案
          </button>
          {preparation && (
            <section aria-label="阶段调试原生确认" className="space-y-2 rounded border p-3">
              <h5 className="font-medium">核对隔离调试方案</h5>
              <p>
                将复制所选阶段的输入快照，使用当前候选创建独立项目，不回退或覆盖原项目。快照之外的外部系统状态不会随文件自动回退。
              </p>
              <p className="break-words">
                本次须重新验证：{preparation.affectedStageIds.join("、") || "未提供阶段，不能确认"}
              </p>
              <p>
                阶段修改可能影响下游。单阶段通过不代表完整插件通过；保存与安装仍按原交付流程核对。
              </p>
              {preparation.diagnostics.map((message, index) => (
                <p key={index} className="break-words text-xs">
                  {message}
                </p>
              ))}
              {preparation.recovery?.requiresNetworkApproval && (
                <div className="space-y-2 rounded border border-amber-500/50 p-3 text-sm">
                  <p>
                    本方案包含命令 Hooks。Windows 文件隔离限制其写入范围，但不保证阻断所有网络访问；
                    Hook 对外部系统产生的影响不会随文件快照自动回退。原 Hooks 与必需检查仍会执行。
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={recoveryApproved}
                      disabled={busy || !preparation.canCreate}
                      onChange={(event) => setRecoveryApproval(event.target.checked ? {
                        preparationId: preparation.id,
                        policyDigest: preparation.recovery!.policyDigest
                      } : undefined)}
                    />
                    我已核对本次命令 Hooks 的网络与外部副作用，并同意为此方案重新确认。
                  </label>
                </div>
              )}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || !preparation.canCreate}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对输入、候选和范围；新分支的工具、插件功能及人工阶段仍须重新授权。
              </label>
              <button
                type="button"
                className="rounded border px-3 py-2 disabled:opacity-50"
                disabled={
                  busy ||
                  !confirmed ||
                  !recoveryApproved ||
                  !preparation.canCreate ||
                  !preparation.affectedStageIds.length
                }
                onClick={() =>
                  void act(async () => {
                    if (!recoveryApproved) throw Error("PROJECT_STAGE_DEBUG_RECOVERY_APPROVAL_REQUIRED")
                    const ticket = epoch.current
                    const created = await api.create({
                      threadId,
                      preparationId: preparation.id,
                      expectedDigest: preparation.candidateDigest,
                      ...(preparation.recovery?.requiresNetworkApproval ? {
                        recoveryApproval: {
                          policyDigest: preparation.recovery.policyDigest,
                          allowNetworkSideEffects: true as const
                        }
                      } : {})
                    })
                    if (!live.current) return
                    if (ticket !== epoch.current) throw Error("PROJECT_STAGE_DEBUG_SOURCE_CHANGED")
                    setPreparation(undefined)
                    setConfirmed(false)
                    onOpenProject(created.projectId)
                    await read()
                  })
                }
              >
                确认创建隔离调试分支（尚不执行）
              </button>
            </section>
          )}
        </>
      )}
      {!!data.branches.length && (
        <details
          className="space-y-2 rounded bg-muted/30 p-3"
          open={data.branches.some((branch) => branch.projectId === selectedProjectId)}
        >
          <summary className="cursor-pointer font-medium">
            隔离调试结果与来源对照（{data.branches.length}）
          </summary>
          <p className="mt-2 text-xs">
            以下仅反映各分支调试范围，不能替代原试用的整轮验收。实际产物和检查收据请打开原生阶段操作核对。
          </p>
          <ul className="space-y-3">
            {data.branches.map((branch) => {
              const owner = allDrafts.find(
                (draft) =>
                  draft.projectId === branch.projectId ||
                  draft.recovery?.projectId === branch.projectId
              )
              const selected = selectedProjectId === branch.projectId
              const unsettled =
                branch.status === "running" ||
                branch.status === "unknown" ||
                !!owner?.recovery?.hasUnconfirmedEffects
              return (
                <li key={branch.id} className="space-y-1 border-t pt-2">
                  <p>
                    {branch.stageId} · {branch.mode === "stage" ? "单阶段" : "含后续阶段"} ·{" "}
                    {statusLabels[branch.status]}
                  </p>
                  <p className="break-all text-xs">固定候选摘要：{branch.candidateDigest}</p>
                  <p className="text-xs">{branch.currentCandidateMatches
                    ? "此分支对应当前候选版本；调试范围结果仍不能替代整轮验收。"
                    : "此分支属于历史候选，当前候选已变化或不可读取；历史结果不能代表当前版本通过。"}</p>
                  <p className="break-all text-xs">
                    来源项目 {branch.sourceProjectId} · 输入快照 {branch.snapshotId}
                  </p>
                  {branch.diagnostics.map((message, index) => (
                    <p key={index} className="break-words text-xs">
                      {message}
                    </p>
                  ))}
                  {branch.status === "unknown" && api.reconcileHooks && (
                    <section aria-label="核对本分支 Hooks 结果" className="space-y-2 rounded border p-2">
                      <p className="text-xs">
                        先核对宿主记录的 Hooks 真实终态，不重跑命令。核对 Hooks 不等于阶段通过；
                        随后仍须在原生阶段操作区核对执行与产物，结束旧试用后再确认新分支。
                      </p>
                      {hookInspection?.projectId === branch.projectId && (
                        <div role="status" className="space-y-1 text-xs">
                          <p>仍待核实的 Hook：{hookInspection.remaining}</p>
                          {hookInspection.diagnostics.map((message, index) => <p key={index}>{message}</p>)}
                        </div>
                      )}
                      {hookInspection?.projectId === branch.projectId &&
                        hookInspection.requiresNetworkInspection && (
                        <label className="flex items-start gap-2 text-xs">
                          <input type="checkbox" disabled={busy}
                            checked={hookNetworkApproval === branch.projectId}
                            onChange={event => setHookNetworkApproval(event.target.checked ? branch.projectId : "")} />
                          我同意本次原生恢复检查器核对外部结果；这不会批准重跑原 Hook 或自动回滚外部系统。
                        </label>
                      )}
                      <button type="button" className="rounded border px-3 py-2 text-xs disabled:opacity-50"
                        disabled={busy || (hookInspection?.projectId === branch.projectId &&
                          hookInspection.requiresNetworkInspection === true && hookNetworkApproval !== branch.projectId)}
                        onClick={() => void act(async () => {
                          const next = await api.reconcileHooks!({ threadId, projectId: branch.projectId,
                            ...(hookNetworkApproval === branch.projectId ? { approveNetworkInspection: true as const } : {}) })
                          if (!live.current) return
                          setHookInspection({ projectId: branch.projectId, ...next })
                          setHookNetworkApproval("")
                          await read()
                        })}>
                        核对 Hooks 真实结果
                      </button>
                    </section>
                  )}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onOpenProject(branch.projectId)}
                  >
                    查看此隔离分支的阶段操作
                  </button>
                  {selected && (
                    <section
                      aria-label="当前调试分支结束操作"
                      className="space-y-2 rounded border p-2"
                    >
                      <p className="text-xs">
                        当前查看的分支：<span className="break-all">{branch.projectId}</span>
                        。结束仅释放此分支的试用占用，原文件、检查结果与来源快照保留。
                      </p>
                      {api.compare && <ProjectStageDebugComparisonCard key={branch.projectId}
                        threadId={threadId} branch={branch} compare={api.compare} blocked={busy || unsettled} />}
                      {owner ? (
                        <>
                          {unsettled && (
                            <p className="text-xs">
                              分支仍在运行或结果尚未确认，请先在原生阶段操作中停止并核对；现在不能结束或重跑。
                            </p>
                          )}
                          <button
                            type="button"
                            className="rounded border px-3 py-2 disabled:opacity-50"
                            disabled={busy || unsettled}
                            onClick={() =>
                              void act(async () => {
                                await preview.finish({
                                  threadId,
                                  projectId: branch.projectId,
                                  ...(owner.recovery?.projectId === branch.projectId
                                    ? { draftId: owner.id }
                                    : {})
                                })
                                if (!live.current) return
                                setPreparation(undefined)
                                setConfirmed(false)
                                onFinishProject?.(branch.projectId)
                                await read()
                              })
                            }
                          >
                            结束此隔离调试分支（保留文件与结果）
                          </button>
                        </>
                      ) : (
                        <p className="text-xs">
                          此分支当前仅保留历史记录，没有需要结束的试用占用。
                        </p>
                      )}
                    </section>
                  )}
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </section>
  )
}
