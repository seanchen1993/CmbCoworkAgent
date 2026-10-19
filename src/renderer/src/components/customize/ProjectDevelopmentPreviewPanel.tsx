import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type {
  ProjectPreviewApi,
  ProjectPreviewDraft
} from "../../../../shared/project-runtime/development-preview"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import type { DevelopmentProjectTrialRequest } from "../../../../shared/mods/development"
const LocalProjectRun = lazy(() =>
  import("../harness-board/LocalProjectsPanel").then((module) => ({
    default: module.LocalProjectRun
  }))
)

export function ProjectDevelopmentPreviewPanel(props: {
  threadId: string
  workspace: string
  request?: DevelopmentProjectTrialRequest
}) {
  const api = window.api.harnessBoard?.localProjects?.preview
  if (!api) return null
  return <ScopedPreview key={JSON.stringify(props)} {...props} api={api} />
}
function ScopedPreview({
  threadId,
  workspace,
  api,
  request
}: {
  threadId: string
  workspace: string
  api: ProjectPreviewApi
  request?: DevelopmentProjectTrialRequest
}) {
  const [drafts, setDrafts] = useState<ProjectPreviewDraft[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [goal, setGoal] = useState(request?.goal ?? "")
  const [confirmed, setConfirmed] = useState(false)
  const [selected, setSelected] = useState<string>()
  const requestDraftId = request?.draftId
  const requestRevision = request?.revision
  const requestDigest = request?.digest
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
  return (
    <section className="space-y-3 rounded border p-3" aria-label="项目模板隔离试用">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-medium">在独立项目中试用</h3>
        <button type="button" className="underline" disabled={busy} onClick={() => void act(read)}>
          刷新项目草稿
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        新试用使用独立空文件夹，保留以往产物。重启后可重新核对并恢复原项目，恢复本身不执行阶段。
      </p>
      {!drafts.length && (
        <p className="text-sm">
          先在当前聊天描述需要两个阶段完成的项目，让助手准备试用，再刷新这里的列表。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {!!drafts.length && (
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
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对下面的版本与目标。创建或恢复后由我开始任务，文件操作和插件功能仍需按原规则授权。
          </label>
        </>
      )}
      {drafts.map((draft) => (
        <article key={draft.id} className="space-y-2 border-t pt-2 text-sm">
          <p>
            {draft.name} · 版本 {draft.revision}
          </p>
          {draft.development && (
            <>
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
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {draft.projectId ? (
              <>
                <button
                  type="button"
                  className="underline"
                  onClick={() => setSelected(draft.projectId)}
                >
                  打开试用项目
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
                  {draft.recovery.status === "draft-changed"
                    ? "草稿已改变，不能将新代码替换进原试用。可保留文件并结束旧试用，再创建新版本。"
                    : draft.recovery.status === "missing"
                      ? "未找到已创建项目，可清除未完成的创建记录；文件仍保留。"
                      : draft.recovery.status === "completed"
                        ? "原项目已完成，可结束试用并保留项目记录与产物。"
                        : "尚未恢复执行权限。重新核对会检查原项目、源码版本和当前授权；原来尚未执行的任务须重新准备与确认。"}
                  {draft.recovery.hasUnconfirmedEffects
                    ? " 原任务结果尚未确认。恢复后请在原执行记录中核对结果，不能直接重跑或结束试用。"
                    : ""}
                </p>
                {draft.recovery.status === "needs-confirmation" && (
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
                        setSelected(projectId)
                        setConfirmed(false)
                        await read()
                      })
                    }
                  >
                    核对并恢复原试用
                  </button>
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
                className="rounded border px-3 py-2 disabled:opacity-50"
                disabled={
                  busy ||
                  !confirmed ||
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
                    setSelected(projectId)
                    setConfirmed(false)
                    await read()
                  })
                }
              >
                创建试用项目（稍后开始任务）
              </button>
            )}
          </div>
        </article>
      ))}
      {selected && (
        <Suspense fallback={<p>正在打开试用项目…</p>}>
          <LocalProjectRun key={selected} projectId={selected} onChanged={() => void act(read)} />
        </Suspense>
      )}
    </section>
  )
}
