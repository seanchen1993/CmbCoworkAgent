import { useEffect, useRef, useState } from "react"
import type {
  BuiltinChangeReview as Review,
  BuiltinChangeReviewBaseline
} from "../../../../shared/mods/builtin-change-review"

export function BuiltinChangeReview(props: { threadId: string; workspace?: string | null; initiallyOpen?: boolean }) {
  return <ScopedChangeReview key={JSON.stringify([props.threadId, props.workspace])} {...props} />
}

function ScopedChangeReview({
  threadId,
  workspace,
  initiallyOpen = false
}: {
  threadId: string
  workspace?: string | null
  initiallyOpen?: boolean
}) {
  const [baseline, setBaseline] = useState<BuiltinChangeReviewBaseline>("head")
  const [result, setResult] = useState<Review>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const request = useRef(0)
  useEffect(() => {
    if (initiallyOpen) void read()
    return () => { request.current++ }
    // Initial navigation reads once; later comparisons are explicit button actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function read() {
    if (!workspace || busy) return
    const sequence = ++request.current
    setBusy(true)
    setError("")
    try {
      const value = await window.api.mods.builtinChangeReview(threadId, workspace, baseline)
      if (sequence === request.current) setResult(value)
    } catch (cause) {
      if (sequence === request.current)
        setError(cause instanceof Error ? cause.message : "读取失败，请重试。")
    } finally {
      if (sequence === request.current) setBusy(false)
    }
  }
  return (
    <details open={initiallyOpen || undefined}>
      <summary className="cursor-pointer font-medium">变更审阅 · 看看文件改了什么</summary>
      <p className="mt-2 leading-5 text-muted-foreground">
        点击查看时才读取文件。已有改动也可能来自其他任务。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="比较范围"
          disabled={busy}
          value={baseline}
          className="max-w-full rounded border bg-background p-1"
          onChange={(event) => {
            setBaseline(event.target.value as BuiltinChangeReviewBaseline)
            setResult(undefined)
            setError("")
          }}
        >
          <option value="head">工作区全部改动</option>
          <option value="task">本次执行的改动</option>
          <option value="stage">本阶段的改动（含重试）</option>
          <option value="project">本项目的改动（所有阶段）</option>
        </select>
        <button
          type="button"
          disabled={busy || !workspace}
          onClick={() => void read()}
          className="underline disabled:opacity-50"
        >
          {busy ? "正在比较…" : "查看改动"}
        </button>
      </div>
      {baseline !== "head" && (
        <p className="mt-2 text-muted-foreground">
          开始执行时自动留存比较起点；普通聊天、应用重启或记录已移除时，此范围不可用。
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words text-destructive">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-2 space-y-2">
          <p>{result.message}</p>
          <p className="text-muted-foreground">{result.baselineLabel}</p>
          {result.evidence && (
            <section className="space-y-1 rounded border p-2" aria-label="关联检查记录">
              <p>
                {result.evidence.projectName} · {result.evidence.stageTitle}
              </p>
              <p className="text-muted-foreground">
                下面是本次执行留下的检查记录，未重新检查当前文件。
                {!result.evidence.matchesProjectVersion &&
                  "项目已经推进，请勿将旧结果当作当前验收。"}
              </p>
              {result.evidence.checks.length ? (
                result.evidence.checks.map((check) => (
                  <p key={check.checkId}>
                    {check.label ?? "成果检查"}：
                    {
                      {
                        passed: "当时通过",
                        failed: "当时未通过",
                        blocked: "当时无法检查",
                        unknown: "当时结果不明"
                      }[check.result]
                    }
                    {" · "}
                    {new Date(check.checkedAt).toLocaleString()}
                  </p>
                ))
              ) : (
                <p>这次执行还没有检查记录。</p>
              )}
            </section>
          )}
          {result.files.map((file) => (
            <details key={file.path} className="rounded border p-2">
              <summary className="cursor-pointer break-all">
                {file.status === "added" ? "新增" : file.status === "deleted" ? "删除" : "修改"} ·{" "}
                {file.path}
              </summary>
              {file.binary ? (
                <p className="mt-2">二进制文件内容已变化。</p>
              ) : (
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre text-[11px]">
                  {file.patch}
                </pre>
              )}
            </details>
          ))}
          <details>
            <summary className="cursor-pointer text-muted-foreground">比较范围与限制</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
              {result.limitations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </details>
  )
}
