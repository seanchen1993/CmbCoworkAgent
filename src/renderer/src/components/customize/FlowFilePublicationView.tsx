import { useEffect, useRef, useState } from "react"
import type { FlowRun } from "../../../../shared/mods/flows/types"
import type { FlowFileReview } from "../../../../shared/mods/flows/file-publication"

export function FlowFilePublicationView({ run }: { run: FlowRun }) {
  if (
    run.flow.definition.schemaVersion !== 2 ||
    run.flow.definition.execution.profile !== "workspace-files-v1"
  )
    return null
  return <Publication key={`${run.threadId}:${run.id}:${run.finishedAt ?? "active"}`} run={run} />
}
function Publication({ run }: { run: FlowRun }) {
  const [review, setReview] = useState<FlowFileReview>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const alive = useRef(true),
    working = useRef(false),
    request = useRef<string | undefined>(undefined)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (request.current)
        void window.api.mods.flowFileCancel(run.threadId, request.current).catch(() => {})
    }
  }, [run.threadId])
  const perform = async (action: () => Promise<void>) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setMessage("")
    try {
      await action()
    } catch {
      if (alive.current)
        setMessage(
          "操作未确认。请重新读取发布记录；发生冲突或中断时不要重复写回，先核对保留的原文件。"
        )
    } finally {
      if (alive.current) {
        setBusy(false)
        working.current = false
      }
    }
  }
  const inspect = () =>
    perform(async () => {
      const value = await window.api.mods.flowFileReview(run.threadId, run.id)
      if (!alive.current) return
      setReview(value)
      setConfirmed(false)
    })
  const publish = (kind: "export" | "publish") =>
    perform(async () => {
      if (!review || (kind === "publish" && !confirmed)) return
      const requestId = crypto.randomUUID()
      request.current = requestId
      try {
        const result = await window.api.mods.flowFilePublish({
          threadId: run.threadId,
          runId: run.id,
          runDigest: review.runDigest,
          reviewDigest: review.reviewDigest,
          requestId,
          kind
        })
        if (!alive.current || !result) return
        setMessage(
          result.state === "exported"
            ? "补丁已导出，项目文件未改变。"
            : "已写回审阅内容，并保留替换前原文件。此记录不证明随后外部编辑器没有再修改项目。"
        )
        const updated = await window.api.mods.flowFileReview(run.threadId, run.id)
        if (!alive.current) return
        setReview(updated)
        setConfirmed(false)
      } finally {
        request.current = undefined
      }
    })
  const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"
  return (
    <section className="space-y-3 rounded border p-3" aria-label="虚拟文件成果发布">
      <p className="text-sm">文件步骤在宿主虚拟副本中执行。流程完成和人工验收不会自动修改项目。</p>
      <button
        className={button}
        disabled={busy || run.status !== "complete"}
        onClick={() => void inspect()}
      >
        读取成果与发布记录
      </button>
      {review && (
        <>
          <p className="text-sm">
            {review.state === "published"
              ? "已有历史写回记录"
              : review.state === "unknown"
                ? "有待核对的发布记录，已阻止重复写回"
                : "尚未写回项目"}{" "}
            · {review.changeCount} 个文件变更
          </p>
          {review.changes.map((change) => (
            <details key={change.path} className="text-sm">
              <summary className="break-all">
                {change.kind === "add" ? "新增" : "替换"} {change.path} · {change.bytes} 字节
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                {change.preview}
              </pre>
            </details>
          ))}
          <p className="text-xs">
            内容预览每文件最多 1000 字符。
            {review.limited
              ? "仅显示前 64 个文件，请先导出完整补丁审阅。"
              : "导出补丁包含全部内容与前后摘要。"}
          </p>
          {review.operations.map((operation) => (
            <p className="break-all text-xs" key={operation.id}>
              {operation.kind} · {operation.state} · {operation.id}
              {operation.recoveryDirectory && (
                <>
                  <br />
                  恢复目录：{operation.recoveryDirectory}
                </>
              )}
            </p>
          ))}
          <button
            className={button}
            disabled={busy || review.state !== "unpublished"}
            onClick={() => void publish("export")}
          >
            导出完整补丁
          </button>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || review.state !== "unpublished"}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已审阅全部变更，确认写回当前项目；原内容会保留在恢复目录，冲突或中断需人工核对。
          </label>
          <button
            className={button}
            disabled={busy || !confirmed || !review.canPublish || review.state !== "unpublished"}
            onClick={() => void publish("publish")}
          >
            确认写回项目
          </button>
          {!review.canPublish && (
            <p className="text-xs">此平台暂不支持句柄保护写回，可导出完整补丁。</p>
          )}
        </>
      )}
      {busy && request.current && (
        <button
          className={button}
          onClick={() => {
            void window.api.mods.flowFileCancel(run.threadId, request.current!).catch(() => {
              if (alive.current) setMessage("取消未确认，请等待当前操作停止后重新读取发布记录。")
            })
          }}
        >
          取消并等待清理
        </button>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  )
}
