import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type {
  ProjectPreviewApi,
  ProjectPreviewDraft
} from "../../../../shared/project-runtime/development-preview"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
const LocalProjectRun = lazy(() =>
  import("../harness-board/LocalProjectsPanel").then((module) => ({
    default: module.LocalProjectRun
  }))
)

export function ProjectDevelopmentPreviewPanel(props: { threadId: string; workspace: string }) {
  const api = window.api.harnessBoard?.localProjects?.preview
  if (!api) return null
  return <ScopedPreview key={JSON.stringify(props)} {...props} api={api} />
}
function ScopedPreview({
  threadId,
  workspace,
  api
}: {
  threadId: string
  workspace: string
  api: ProjectPreviewApi
}) {
  const [drafts, setDrafts] = useState<ProjectPreviewDraft[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [goal, setGoal] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [selected, setSelected] = useState<string>()
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
    const identity = JSON.stringify(next.drafts)
    if (identity !== facts.current) setConfirmed(false)
    facts.current = identity
    setDrafts(next.drafts)
  }, [api, threadId, workspace])
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
        每次试用使用创建时的版本。修改并保存后，请先结束本次试用，再用新版本创建试用项目。
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
            我确认使用下面的版本创建独立试用项目。创建后由我开始任务，文件操作和插件功能仍需按原规则授权。
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
