import { useEffect, useState } from "react"
import { CheckCircle2, CircleAlert, Loader2, Square } from "lucide-react"
import type { ProjectAgentRunState } from "./use-project-agent-run"

const duration = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)} 秒`
export function ProjectAgentRunProgress({
  state,
  fallback = "正在读取数据并准备分析…"
}: {
  state: ProjectAgentRunState
  fallback?: string
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (state.outcome !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state.outcome, state.startedAt])
  if (!state.startedAt) return null
  const current = state.steps.findLast((step) => step.status === "running") ?? state.steps.at(-1)
  const models = state.steps.filter((step) => step.kind === "model").length
  const queries = state.steps.filter((step) => step.kind === "tool").length
  const status =
    state.outcome === "running"
      ? (current?.title ?? fallback)
      : { completed: "本次运行完成", failed: "本次运行未完成", cancelled: "本次运行已停止" }[
          state.outcome
        ]
  return (
    <section
      aria-label="Agent 运行过程"
      className="min-w-0 rounded-md border border-border bg-muted/25 p-2.5 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="status" className="flex min-w-0 items-center gap-2">
          {state.outcome === "running" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : state.outcome === "completed" ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
          ) : (
            <CircleAlert className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="break-words">{status}</span>
        </div>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {duration((state.finishedAt ?? now) - state.startedAt)}
        </span>
      </div>
      {state.outcome === "running" && current?.detail && (
        <p aria-live="off" className="mt-1 pl-5 text-muted-foreground">
          {current.detail}
        </p>
      )}
      <details className="mt-2 min-w-0">
        <summary className="cursor-pointer text-muted-foreground">
          运行明细 · {models} 次模型调用 · {queries} 次工具查询
        </summary>
        <ol className="mt-2 max-h-24 space-y-2 overflow-y-auto sm:max-h-48 overscroll-contain pr-1">
          {!state.steps.length && <li className="text-muted-foreground">等待后端返回运行进度…</li>}
          {state.steps.map((step) => (
            <li key={step.id} className="min-w-0 rounded border bg-background p-2">
              <div className="flex items-start gap-2">
                {step.status === "running" ? (
                  <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" />
                ) : step.status === "completed" ? (
                  <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-primary" />
                ) : (
                  <Square className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{step.title}</span>
                  <p className="mt-0.5 break-words text-muted-foreground">{step.detail}</p>
                </div>
                {step.elapsedMs !== undefined && (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {duration(step.elapsedMs)}
                  </span>
                )}
              </div>
              {(step.input || step.output) && (
                <details className="mt-1 min-w-0 pl-5">
                  <summary className="cursor-pointer text-primary">查询参数与结果预览</summary>
                  {step.input && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">
                      {step.input}
                    </pre>
                  )}
                  {step.output && (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">
                      {step.output}
                    </pre>
                  )}
                </details>
              )}
            </li>
          ))}
        </ol>
      </details>
    </section>
  )
}
