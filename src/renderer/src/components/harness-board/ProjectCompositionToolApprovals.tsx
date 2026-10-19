import { useEffect, useRef, useState } from "react"
import type {
  ProjectCompositionApi,
  ProjectCompositionScope,
  ProjectCompositionToolApproval
} from "../../../../shared/project-runtime/composition-api"

/** Original native requests stay bound to their hidden unit; the host resolves that identity. */
export function ProjectCompositionToolApprovals({
  scope,
  runId,
  api
}: {
  scope: ProjectCompositionScope
  runId: string
  api: ProjectCompositionApi
}) {
  const [items, setItems] = useState<ProjectCompositionToolApproval[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  const responding = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    alive.current = true
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const ticket = generation.current
      try {
        if (!responding.current) {
          const next = await api.readToolApprovals({ scope, runId })
          if (!disposed && alive.current && generation.current === ticket) {
            setItems(next)
            setError((previous) => (previous.startsWith("暂时无法") ? "" : previous))
          }
        }
      } catch {
        if (!disposed && alive.current && generation.current === ticket)
          setError("暂时无法核对原操作确认，请稍后重试。运行尚未完成。")
      } finally {
        if (!disposed && alive.current) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      disposed = true
      alive.current = false
      generation.current++
      if (timer) clearTimeout(timer)
    }
    // The parent remounts for a changed scope or run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, runId])
  const respond = async (item: ProjectCompositionToolApproval, decision: "allow" | "deny") => {
    if (responding.current || (decision === "allow" && !item.allow)) return
    responding.current = true
    generation.current++
    setBusy(true)
    setError("")
    try {
      await api.respondToolApproval({
        scope,
        runId,
        unitId: item.unitId,
        requestId: item.requestId,
        decision
      })
      if (alive.current)
        setItems((current) => current.filter((candidate) => candidate.requestId !== item.requestId))
    } catch {
      if (alive.current) setError("确认未提交，原操作可能已变化。请核对当前请求后重试。")
    } finally {
      responding.current = false
      generation.current++
      if (alive.current) setBusy(false)
    }
  }
  if (!items.length && !error) return null
  return (
    <section aria-label="原工具操作确认" className="min-w-0 space-y-3 rounded-md border p-3">
      <h4 className="font-medium">原流程需要确认操作</h4>
      <p className="text-sm">仅允许或拒绝这一次操作，不修改长期权限。</p>
      {items.map((item) => (
        <div key={item.requestId} className="min-w-0 space-y-2 rounded border p-2 text-sm">
          <p className="break-words">操作：{item.operation}</p>
          {item.filePath && <p className="break-all">文件：{item.filePath}</p>}
          <p className="break-all">工作目录：{item.cwd}</p>
          {item.command && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {item.command}
            </pre>
          )}
          {item.code && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{item.code}</pre>
          )}
          {item.reason && <p className="whitespace-pre-wrap break-words">{item.reason}</p>}
          {!item.allow && (
            <p>此操作需要原工具的专用界面，当前组合面板暂不支持确认。可拒绝本次操作后检查流程。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !item.allow}
              className="rounded border px-3 py-2 disabled:opacity-50"
              onClick={() => void respond(item, "allow")}
            >
              允许本次操作
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded border px-3 py-2 disabled:opacity-50"
              onClick={() => void respond(item, "deny")}
            >
              拒绝本次操作
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
