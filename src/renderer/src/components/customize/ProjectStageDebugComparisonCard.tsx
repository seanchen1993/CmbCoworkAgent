import { useEffect, useRef, useState } from "react"
import type {
  ProjectStageDebugApi,
  StageDebugBranchView,
  StageDebugFileComparison
} from "../../../../shared/project-runtime/stage-debug"

const labels = { added: "新增", deleted: "删除", modified: "修改" } as const

/** Explicit read only. Never starts a run, changes a verdict, or polls a workspace. */
export function ProjectStageDebugComparisonCard({
  threadId,
  branch,
  compare,
  blocked
}: {
  threadId: string
  branch: StageDebugBranchView
  compare: NonNullable<ProjectStageDebugApi["compare"]>
  blocked: boolean
}) {
  const [result, setResult] = useState<StageDebugFileComparison>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [visible, setVisible] = useState(50)
  const live = useRef(false),
    sequence = useRef(0),
    pending = useRef(false),
    allowed = useRef(!blocked)
  allowed.current = !blocked
  useEffect(() => {
    live.current = true
    pending.current = false
    setBusy(false)
    setResult(undefined)
    setError("")
    setVisible(50)
    return () => {
      live.current = false
      sequence.current++
    }
  }, [threadId, branch.projectId, branch.snapshotId])
  const read = async () => {
    if (blocked || pending.current || !live.current) return
    pending.current = true
    setBusy(true)
    setError("")
    const ticket = ++sequence.current
    try {
      const next = await compare({ threadId, projectId: branch.projectId })
      if (!live.current || sequence.current !== ticket || !allowed.current) return
      if (next.projectId !== branch.projectId || next.snapshotId !== branch.snapshotId)
        throw Error("COMPARISON_SCOPE_CHANGED")
      setResult(next)
      setVisible(50)
    } catch {
      if (live.current && sequence.current === ticket) {
        setResult(undefined)
        setError("无法取得本分支的完整文件比较。原运行与检查结果保留，请刷新原生记录后手动重试。")
      }
    } finally {
      if (live.current && sequence.current === ticket) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section aria-label="阶段输入文件比较" className="min-w-0 space-y-2 rounded border p-3 text-xs">
      <h5 className="font-medium">阶段起点与当前文件的差异</h5>
      <p>
        比较不可变阶段输入与此分支当前文件的内容摘要。文件变化不代表业务检查通过，也不能证明改动归属；历史通过不保证当前文件仍通过。
      </p>
      <button
        type="button"
        className="rounded border px-3 py-2 disabled:opacity-50"
        disabled={blocked || busy}
        onClick={() => void read()}
      >
        {busy ? "正在读取文件比较…" : "比较阶段输入与当前文件"}
      </button>
      {blocked && <p>运行中、结果未知或其他操作进行时暂不读取，请先停止并核对原生记录。</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>
            输入快照：{new Date(result.baselineCreatedAt).toLocaleString()}；当前文件观察：
            {new Date(result.observedAt).toLocaleString()}。
          </p>
          <p className="break-all">输入快照标识：{result.snapshotId}</p>
          <p className="break-all">本分支固定候选摘要：{result.candidateDigest}</p>
          {result.diagnostics.map((message, index) => (
            <p key={index} className="break-words">
              {message}
            </p>
          ))}
          {result.status === "available" ? (
            <>
              <p role="status">
                文件内容变化：新增 {result.counts.added}，删除 {result.counts.deleted}，修改{" "}
                {result.counts.modified}，未变 {result.counts.unchanged}。
              </p>
              {!!result.files.length && (
                <div className="max-w-full overflow-x-auto">
                  <table className="w-full table-fixed text-left" aria-label="阶段输入文件变化清单">
                    <thead>
                      <tr>
                        <th>相对路径</th>
                        <th className="w-14">变化</th>
                        <th>原 SHA-256 / 字节数</th>
                        <th>现 SHA-256 / 字节数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.files.slice(0, visible).map((file) => (
                        <tr key={file.path} className="border-t align-top">
                          <td className="break-all py-2">
                            {file.path}
                            {file.binary && <span>（二进制）</span>}
                          </td>
                          <td className="py-2">{labels[file.change]}</td>
                          <td className="break-all py-2">
                            {file.beforeSha256 ?? "不存在"}
                            <br />
                            {file.beforeBytes === null ? "—" : `${file.beforeBytes} 字节`}
                          </td>
                          <td className="break-all py-2">
                            {file.afterSha256 ?? "不存在"}
                            <br />
                            {file.afterBytes === null ? "—" : `${file.afterBytes} 字节`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {visible < result.files.length && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => setVisible((count) => count + 50)}
                >
                  再显示 50 项（已显示 {Math.min(visible, result.files.length)} /{" "}
                  {result.files.length}）
                </button>
              )}
            </>
          ) : (
            <p role="status">比较不可用；未返回部分文件清单，不能据此判断文件没有变化。</p>
          )}
        </>
      )}
    </section>
  )
}
