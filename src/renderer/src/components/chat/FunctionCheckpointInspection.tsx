import { useEffect, useRef, useState } from "react"
import type { AutobizRecoveryInspection } from "../../../../shared/mods/v2/autobiz-recovery"
import { FunctionSiteLifetime } from "../../lib/function-site-lifecycle"

const guidance = {
  before:
    "两个文件仍符合提交前内容。保留未知提交记录，先核对日志；重新执行完整检查后再由宿主决定推进。",
  after:
    "两个文件符合预期写入内容。这只是当前内容核对，不确认旧操作成功，也不恢复业务 PASS；先核对日志，再重新执行完整检查。",
  mixed: "两个文件分别处于提交前后状态，可能发生部分写入。请先备份并人工核对，禁止直接重放推进。",
  changed: "状态文件存在外部修改，与提交前后内容不一致。保留当前文件，先解决状态竞争，再重新检查。",
  unavailable:
    "无法取得稳定且有界的状态文件快照。检查文件是否缺失、被占用、过大或使用链接，然后重新核对。"
}
const journalLabels = { pending: "提交待确认", unknown: "提交结果未知", committed: "已记录提交" }

export function FunctionCheckpointInspectionResult({
  value
}: {
  value: AutobizRecoveryInspection
}) {
  return (
    <div className="mt-2 space-y-1" data-checkpoint-inspection={value.state}>
      <p>
        宿主日志：{journalLabels[value.journalStatus]} · 核对时间：
        {new Date(value.observedAt).toLocaleString()}
      </p>
      <p>{guidance[value.state]}</p>
      <p>此操作只读取摘要，不修改状态文件或提交日志，不运行 validator，不自动重试。</p>
      {value.files.map((file) => (
        <details key={file.path} className="break-all text-muted-foreground">
          <summary>{file.path}</summary>
          <p>提交前：{file.before}</p>
          <p>预期写入：{file.after}</p>
          <p>本次读取：{file.current ?? "不可用"}</p>
        </details>
      ))}
    </div>
  )
}

export function FunctionCheckpointInspection({
  threadId,
  recordId
}: {
  threadId: string
  recordId: string
}) {
  const lifetime = useRef(new FunctionSiteLifetime())
  const [value, setValue] = useState<AutobizRecoveryInspection>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const current = new FunctionSiteLifetime()
    lifetime.current = current
    setValue(undefined)
    setError("")
    setBusy(false)
    return () => {
      current.close()
    }
  }, [threadId, recordId])
  const inspect = async () => {
    lifetime.current.invalidate()
    const ticket = lifetime.current.capture()
    setBusy(true)
    setValue(undefined)
    setError("")
    try {
      const result = await window.api.mods.inspectCheckpointRecovery(threadId, recordId)
      ticket.commit(() => setValue(result))
    } catch {
      if (ticket.current())
        setError("恢复核对暂不可用；请检查项目范围、模块开关及宿主日志，勿直接重试推进。")
    } finally {
      ticket.commit(() => setBusy(false))
    }
  }
  return (
    <div className="mt-2">
      <button
        type="button"
        className="rounded border px-2 py-1 disabled:opacity-50"
        disabled={busy}
        onClick={() => void inspect()}
      >
        {busy ? "正在核对…" : "核对 checkpoint 恢复证据"}
      </button>
      {error && <p role="alert">{error}</p>}
      {value && <FunctionCheckpointInspectionResult value={value} />}
    </div>
  )
}
