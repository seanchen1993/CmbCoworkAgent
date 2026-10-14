import { useEffect, useRef, useState } from "react"
import type { ProjectActionResults as Results } from "../../../../shared/project-runtime/action-results"

export function ProjectActionResults(props: { projectId: string; operationId: string }) {
  return <ScopedResults key={JSON.stringify([props.projectId, props.operationId])} {...props} />
}
function ScopedResults({ projectId, operationId }: { projectId: string; operationId: string }) {
  const [view, setView] = useState<Results>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const sequence = useRef(0)
  const pending = useRef(false)
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      sequence.current++
    }
  }, [])
  const read = async () => {
    if (pending.current) return
    pending.current = true
    const token = ++sequence.current
    setBusy(true)
    setError(false)
    setView(undefined)
    try {
      const next = await window.api.harnessBoard.localProjects.actionResults(projectId, operationId)
      if (!live.current || token !== sequence.current) return
      if (next.projectId !== projectId || next.operationId !== operationId)
        throw Error("SCOPE_CHANGED")
      setView(next)
    } catch {
      if (live.current && token === sequence.current) setError(true)
    } finally {
      if (live.current && token === sequence.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <div className="mt-2 space-y-2">
      <button
        type="button"
        disabled={busy}
        className="underline disabled:opacity-50"
        onClick={() => void read()}
      >
        {busy ? "正在读取动作结果…" : view ? "更新公开动作结果" : "查看公开动作结果"}
      </button>
      {error && (
        <p role="alert">暂时无法核对本次动作结果。请更新任务记录后重试；未确认不代表执行失败。</p>
      )}
      {view && (
        <section className="space-y-2 rounded border p-2" aria-label="公开动作历史结果">
          <p>{view.message}</p>
          <p>
            创建任务时的模板版本：{view.packageVersion}。读取于{" "}
            {new Date(view.observedAt).toLocaleString()}。
          </p>
          {!view.flowStatus && <p>尚无本次公开动作的持久记录，不能据此确认已执行。</p>}
          {view.actions.map((action) => (
            <div key={action.id} className="space-y-1 border-t pt-2">
              <p>
                {action.plugin} · {action.id} ·{" "}
                {action.status === "passed"
                  ? "已通过"
                  : action.status === "failed"
                    ? "未通过"
                    : action.status === "not-recorded"
                      ? "尚无记录"
                      : "结果需核对"}
              </p>
              {!action.authorizedNow && (
                <p>
                  当前目录未授权此提供者，或安装版本已变化；不能直接继续执行，输出暂不显示。请通过该目录聊天的原插件入口确认授权和版本。
                </p>
              )}
              {action.summary && (
                <p className="whitespace-pre-wrap break-words">{action.summary}</p>
              )}
              {action.output !== null && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                  {action.output}
                </pre>
              )}
              {action.truncated && <p>显示内容已截断；不能把此预览当作完整结果。</p>}
              <details>
                <summary className="cursor-pointer">锁定的动作版本与数据结构</summary>
                <p className="break-all">
                  动作：{action.actionId}；提供者摘要：{action.providerDigest}
                </p>
                <p>输入结构</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                  {action.inputSchema}
                </pre>
                <p>输出结构</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                  {action.outputSchema}
                </pre>
              </details>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
