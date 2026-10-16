import { useEffect, useState } from "react"
import type { FlowRun } from "../../../../shared/mods/flows/types"

const labels = {
  running: "正在执行",
  passed: "已完成",
  failed: "未完成",
  waiting: "等你确认",
  skipped: "已跳过",
  unknown: "需要核对"
}
const toolLabels: Record<string, string> = {
  read_file: "正在读取文件",
  write_file: "正在写入文件",
  edit_file: "正在修改文件",
  execute: "正在执行命令",
  grep: "正在搜索内容",
  glob: "正在查找文件"
}

/** The latest real attempt is the source of progress; retries do not inflate completion. */
export function FlowStepProgress({ run }: { run: FlowRun }) {
  const active = ["queued", "running", "waiting"].includes(run.status)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, run.id])
  const steps = run.flow.definition.steps.filter((step) => step.enabled)
  const latest = new Map(
    run.attempts.filter((item) => !item.invalidated).map((item) => [item.stepId, item])
  )
  const current = run.currentStepId && latest.get(run.currentStepId)
  const currentName = steps.find((step) => step.id === run.currentStepId)?.name ?? "最终检查"
  const completed = steps.filter((step) => latest.get(step.id)?.status === "passed").length
  const seconds = current
    ? Math.max(0, Math.floor(((current.finishedAt ?? now) - current.startedAt) / 1000))
    : 0
  const progress = current && current.progress
  const issue =
    !active && [...latest.values()].find((item) => ["failed", "unknown"].includes(item.status))
  return (
    <div className="space-y-3" data-flow-progress>
      {active && !run.pendingApproval && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3" role="status">
          <p className="text-sm font-medium">
            {run.status === "waiting"
              ? "等你确认"
              : current
                ? `正在进行：${currentName}`
                : "正在准备流程"}
          </p>
          {current && (
            <p className="mt-1 text-xs text-muted-foreground">
              本步已用{" "}
              {seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}
            </p>
          )}
          {progress && (
            <div className="mt-2 space-y-1 text-xs" data-flow-live-progress>
              <p className="text-muted-foreground">
                {progress.phase === "tool"
                  ? (toolLabels[progress.toolName ?? ""] ?? "正在处理工具操作")
                  : "正在生成本步内容"}
              </p>
              {progress.text && (
                <p className="whitespace-pre-wrap break-words">
                  {progress.text.slice(-400)}
                  {progress.text.length > 400 ? "（完整内容见步骤详情）" : ""}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        已完成 {completed} / {steps.length} 步
      </p>
      {issue && (
        <div className="space-y-1 text-sm text-destructive" role="status">
          {issue.reason && (
            <p className="whitespace-pre-wrap break-words">{issue.reason.slice(0, 800)}</p>
          )}
          {issue.result?.summary && (
            <p className="whitespace-pre-wrap break-words">{issue.result.summary.slice(0, 800)}</p>
          )}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm">查看全部 {steps.length} 步与结果</summary>
        <ol aria-label="当前步骤进度" className="mt-3 space-y-2">
          {steps.map((step, index) => {
            const attempt = latest.get(step.id)
            const focused = active && step.id === run.currentStepId
            const issue = attempt?.status === "failed" || attempt?.status === "unknown"
            return (
              <li
                key={step.id}
                className={`rounded-lg border p-3 text-sm ${focused ? "border-primary/40 bg-primary/5" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-words font-medium">
                    {index + 1}. {step.name}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${issue ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {attempt
                      ? !active && ["running", "waiting"].includes(attempt.status)
                        ? "已停止，需核对"
                        : labels[attempt.status]
                      : active
                        ? "待执行"
                        : "未执行"}
                  </span>
                </div>
                {issue && attempt.reason && (
                  <p className="mt-2 whitespace-pre-wrap break-words text-destructive">
                    {attempt.reason}
                  </p>
                )}
                {focused && attempt?.progress?.text && (
                  <p className="mt-2 whitespace-pre-wrap break-words">{attempt.progress.text}</p>
                )}
                {attempt?.result?.summary && (
                  <details className="mt-2" open={issue}>
                    <summary className="cursor-pointer text-xs">查看本步结果</summary>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                      {attempt.result.summary}
                    </p>
                  </details>
                )}
              </li>
            )
          })}
        </ol>
      </details>
    </div>
  )
}
