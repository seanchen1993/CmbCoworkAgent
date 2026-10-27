import type { StageDebugReviewIntent } from "../../../../shared/mods/v2/project-stage-debug-review"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type {
  ProjectPreviewApi,
  ProjectPreviewDraft
} from "../../../../shared/project-runtime/development-preview"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import type { DevelopmentProjectTrialRequest } from "../../../../shared/mods/development"
import { CreatorTrialJourneyCard } from "./CreatorTrialJourneyCard"
import { ProjectStageDebugPanel } from "./ProjectStageDebugPanel"
const LocalProjectRun = lazy(() =>
  import("../harness-board/LocalProjectsPanel").then((module) => ({
    default: module.LocalProjectRun
  }))
)

export function ProjectDevelopmentPreviewPanel(props: {
  threadId: string
  workspace: string
  request?: DevelopmentProjectTrialRequest
  onRequestRepair?: (message: string) => void | Promise<void>
  onReturnToChat?: () => void
  stageDebugReview?: StageDebugReviewIntent
  showJourney?: boolean
}) {
  const api = window.api.harnessBoard?.localProjects?.preview
  if (!api) return null
  return (
    <ScopedPreview
      key={JSON.stringify([props.threadId, props.workspace, props.request?.id])}
      {...props}
      api={api}
    />
  )
}
function ScopedPreview({
  threadId,
  workspace,
  api,
  request,
  onRequestRepair,
  onReturnToChat,
  stageDebugReview,
  showJourney = true
}: {
  threadId: string
  workspace: string
  api: ProjectPreviewApi
  request?: DevelopmentProjectTrialRequest
  onRequestRepair?: (message: string) => void | Promise<void>
  onReturnToChat?: () => void
  stageDebugReview?: StageDebugReviewIntent
  showJourney?: boolean
}) {
  const [drafts, setDrafts] = useState<ProjectPreviewDraft[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [goal, setGoal] = useState(request?.goal ?? "")
  const [confirmed, setConfirmed] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [selectedDebug, setSelectedDebug] = useState(false)
  const [debugOpen, setDebugOpen] = useState(!!stageDebugReview)
  const [feedback, setFeedback] = useState("")
  const [feedbackSaved, setFeedbackSaved] = useState(false)
  const requestDraftId = request?.draftId
  const requestRevision = request?.revision
  const requestDigest = request?.digest
  const openedByReview = useRef(!!stageDebugReview)
  const debugOpenRef = useRef(debugOpen)
  debugOpenRef.current = debugOpen
  useEffect(() => {
    if (stageDebugReview) {
      if (!debugOpenRef.current) openedByReview.current = true
      setDebugOpen(true)
    } else if (openedByReview.current) {
      openedByReview.current = false
      setDebugOpen(false)
    }
  }, [stageDebugReview?.id])
  const facts = useRef("")
  const live = useRef(false),
    sequence = useRef(0),
    pending = useRef(false),
    operation = useRef(0)
  const read = useCallback(async () => {
    const token = ++sequence.current
    const next = await api.list(threadId)
    if (!live.current || token !== sequence.current) return
    if (next.threadId !== threadId || !isSameWorkspacePath(next.workspace, workspace))
      throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    const matching = requestDraftId
      ? next.drafts.filter(
          (draft) =>
            draft.id === requestDraftId &&
            ((draft.revision === requestRevision && draft.digest === requestDigest) ||
              !!draft.recovery)
        )
      : next.drafts
    const identity = JSON.stringify(matching)
    if (identity !== facts.current) setConfirmed(false)
    facts.current = identity
    setDrafts(matching)
  }, [api, threadId, workspace, requestDraftId, requestRevision, requestDigest])
  const act = useCallback(async (work: () => Promise<void>) => {
    if (pending.current) return
    const token = ++operation.current
    pending.current = true
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (cause) {
      if (live.current && token === operation.current)
        setError(
          cause instanceof Error && /UNSETTLED|RUNNING/.test(cause.message)
            ? "试用还在运行，或结果尚未确认。请先停止任务并核对结果，再结束试用或重新运行。"
            : "试用、文件或权限已变化。请刷新列表，再检查草稿。"
        )
    } finally {
      if (live.current && token === operation.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }, [])
  const invalidate = useCallback(() => {
    sequence.current++
    operation.current++
  }, [])
  useEffect(() => {
    live.current = true
    void act(read)
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.api.mods?.development?.onChanged?.((event) => {
      if (event.threadId !== threadId) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (live.current) void read().catch(() => {})
      }, 50)
    })
    return () => {
      live.current = false
      invalidate()
      pending.current = false
      clearTimeout(timer)
      unsubscribe?.()
    }
  }, [act, read, threadId, invalidate])
  const running = drafts.some((draft) => draft.journey?.phase === "running")
  useEffect(() => {
    const projectId = drafts.find((draft) => draft.projectId)?.projectId
    if (!selected && projectId) setSelected(projectId)
  }, [drafts, selected])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      if (live.current && !pending.current) void read().catch(() => {})
    }, 2500)
    return () => clearInterval(timer)
  }, [running, read])
  return (
    <section className="space-y-3" aria-label="项目模板隔离试用">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-medium">试用</h3>
        <button type="button" className="underline" disabled={busy} onClick={() => void act(read)}>
          刷新
        </button>
      </div>
      {!drafts.length && <p className="text-sm">请回到聊天继续描述需求，准备好后即可试用。</p>}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {drafts.some((draft) => !draft.projectId && !draft.recovery) && (
        <>
          <label className="grid gap-1 text-sm">
            这次试用希望完成什么
            <textarea
              className="w-full rounded border p-2"
              value={goal}
              maxLength={8000}
              onChange={(event) => {
                setGoal(event.target.value)
                setConfirmed(false)
              }}
            />
          </label>
        </>
      )}
      {drafts.map((draft) => (
        <article key={draft.id} className="space-y-2 border-t pt-2 text-sm">
          <p>
            {draft.name} · 版本 {draft.revision}
          </p>
          {draft.development && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">版本详情</summary>
              <p>
                已准备的版本 {draft.development.currentRevision}
                {draft.development.pendingRevision
                  ? `；新版本 ${draft.development.pendingRevision} 等待本次试用结束后再使用`
                  : ""}
                {draft.development.updateState === "blocked"
                  ? "；最新修改未通过检查，请修复并保存"
                  : ""}
                。
              </p>
              <p className="break-all text-xs text-muted-foreground">
                试用文件夹：{draft.development.workspace}
              </p>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {draft.projectId ? (
              <>
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setSelectedDebug(false)
                    setSelected(draft.projectId)
                  }}
                >
                  查看试用
                </button>
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.finish({ threadId, projectId: draft.projectId! })
                      if (!live.current) return
                      setSelected(undefined)
                      await read()
                    })
                  }
                >
                  结束本次试用
                </button>
              </>
            ) : draft.recovery ? (
              <div className="space-y-2">
                <p>保留的试用 · 版本 {draft.recovery.revision}</p>
                <p className="whitespace-pre-wrap">
                  原目标：{draft.recovery.goal || "项目尚未创建"}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  原试用文件夹：{draft.recovery.workspace}
                </p>
                <p className="text-xs text-muted-foreground">
                  {draft.recovery.debugBranch
                    ? "调试分支仅保留历史记录，请结束保留试用，再从原阶段快照准备新分支。旧执行授权不会恢复，原文件和检查记录保留。"
                    : draft.recovery.status === "draft-changed"
                      ? "草稿已改变，不能将新代码替换进原试用。可保留文件并结束旧试用，再创建新版本。"
                      : draft.recovery.status === "missing"
                        ? "未找到已创建项目，可清除未完成的创建记录；文件仍保留。"
                        : draft.recovery.status === "completed"
                          ? "原项目已完成，可结束试用并保留项目记录与产物。"
                          : "尚未恢复执行权限。重新核对会检查原项目、源码版本和当前授权；原来尚未执行的任务须重新准备与确认。"}
                  {draft.recovery.hasUnconfirmedEffects
                    ? draft.recovery.debugBranch
                      ? " 原任务结果尚未确认。请先查看保留的执行记录并核对实际结果，不能直接重跑或结束试用。"
                      : " 原任务结果尚未确认。恢复后请在原执行记录中核对结果，不能直接重跑或结束试用。"
                    : ""}
                </p>
                {draft.recovery.debugBranch && draft.recovery.status !== "missing" && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setSelectedDebug(true)
                      setSelected(draft.recovery!.projectId)
                    }}
                  >
                    查看调试分支历史与待核对结果
                  </button>
                )}
                {!draft.recovery.debugBranch && draft.recovery.status === "needs-confirmation" && (
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      恢复此版本的试用记录
                    </label>
                    <button
                      type="button"
                      className="rounded border px-3 py-2 disabled:opacity-50"
                      disabled={busy || !confirmed || !api.recover}
                      onClick={() =>
                        void act(async () => {
                          const saved = draft.recovery!
                          const projectId = await api.recover({
                            threadId,
                            draftId: draft.id,
                            projectId: saved.projectId,
                            revision: saved.revision,
                            expectedDigest: saved.digest,
                            expectedProjectVersion: saved.projectVersion!
                          })
                          if (!live.current) return
                          setSelectedDebug(false)
                          setSelected(projectId)
                          setConfirmed(false)
                          await read()
                        })
                      }
                    >
                      核对并恢复原试用
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="underline"
                  disabled={busy || draft.recovery.hasUnconfirmedEffects}
                  onClick={() =>
                    void act(async () => {
                      await api.finish({
                        threadId,
                        projectId: draft.recovery!.projectId,
                        draftId: draft.id
                      })
                      if (!live.current) return
                      setSelected(undefined)
                      setConfirmed(false)
                      await read()
                    })
                  }
                >
                  {draft.recovery.status === "missing"
                    ? "清除未创建记录（保留文件）"
                    : "结束保留的试用（保留文件）"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                disabled={
                  busy ||
                  !goal.trim() ||
                  !!draft.development?.activeRuns ||
                  draft.development?.updateState === "blocked"
                }
                onClick={() =>
                  void act(async () => {
                    const projectId = await api.create({
                      threadId,
                      draftId: draft.id,
                      revision: draft.revision,
                      expectedDigest: draft.digest,
                      goal
                    })
                    if (!live.current) return
                    setSelectedDebug(false)
                    setSelected(projectId)
                    setConfirmed(false)
                    await read()
                  })
                }
              >
                开始试用
              </button>
            )}
          </div>
          {showJourney &&
            (draft.projectId || draft.recovery || draft.journey || request?.journey) && (
              <CreatorTrialJourneyCard
                threadId={threadId}
                digest={draft.digest}
                journey={draft.journey ?? request?.journey}
              />
            )}
        </article>
      ))}
      {api.stageDebug && (
        <details
          data-creator-guide="stage-debug"
          className="rounded-xl border p-3"
          open={debugOpen}
          onToggle={(event) => setDebugOpen(event.currentTarget.open)}
        >
          <summary
            className="cursor-pointer text-sm font-medium"
            onClick={() => {
              openedByReview.current = false
            }}
          >
            按阶段修改与隔离调试
          </summary>
          {debugOpen && (
            <div className="mt-3">
              <ProjectStageDebugPanel
                threadId={threadId}
                workspace={workspace}
                draftId={stageDebugReview?.draftId ?? requestDraftId}
                preview={api}
                stageDebugReview={stageDebugReview}
                selectedProjectId={selected}
                onOpenProject={(projectId) => {
                  setSelectedDebug(true)
                  setSelected(projectId)
                }}
                onFinishProject={(projectId) =>
                  setSelected((current) => (current === projectId ? undefined : current))
                }
                onOpenSource={(projectId) => {
                  setSelectedDebug(false)
                  setSelected(projectId)
                }}
                onRequestRepair={onRequestRepair}
                onReturnToChat={onReturnToChat}
              />
            </div>
          )}
        </details>
      )}
      {selected && (
        <section aria-label="本轮试用项目执行" className="min-w-0 space-y-3 rounded-xl border p-3">
          {selectedDebug && <h4 className="font-medium">隔离调试分支的阶段操作</h4>}
          <Suspense fallback={<p>正在打开试用项目…</p>}>
            <LocalProjectRun key={selected} projectId={selected} onChanged={() => void act(read)} />
          </Suspense>
        </section>
      )}
      {request && (onRequestRepair || onReturnToChat) && (
        <details aria-label="回原创作对话优化" className="space-y-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">需要调整？</summary>
          {onRequestRepair && (
            <>
              <label className="grid gap-1 text-sm">
                希望如何改进
                <textarea
                  value={feedback}
                  maxLength={8000}
                  className="min-h-20 rounded border bg-background p-2"
                  onChange={(event) => {
                    setFeedback(event.target.value)
                    setFeedbackSaved(false)
                  }}
                />
              </label>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm disabled:opacity-50"
                disabled={busy || !feedback.trim()}
                onClick={() =>
                  void act(async () => {
                    const submittedFeedback = feedback
                    await read()
                    if (!live.current) return
                    await onRequestRepair(
                      `请继续优化原聊天中准备的项目插件“${request.name}”。本次试用请求 ${request.id}，草稿 ${request.draftId}，版本 ${request.revision}，候选摘要 ${request.digest}。请先读取原试用的整轮阶段、产物和校验记录；结果未知的操作不要重放。我的修改要求：${submittedFeedback.trim()}。修改后准备新候选和新的试用，不修改正在运行的版本。`
                    )
                    if (!live.current) return
                    setFeedback((current) => (current === submittedFeedback ? "" : current))
                    setFeedbackSaved(true)
                  })
                }
              >
                提交到原聊天继续优化
              </button>
            </>
          )}
          {feedbackSaved && (
            <p role="status" className="text-sm">
              刚才提交的修改需求已发送到原创造者聊天，可返回查看并继续讨论。
              {feedback && "输入框中保留的新内容尚未提交。"}
            </p>
          )}
          {onReturnToChat && (
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm"
              onClick={onReturnToChat}
            >
              返回原创造者聊天
            </button>
          )}
        </details>
      )}
    </section>
  )
}
