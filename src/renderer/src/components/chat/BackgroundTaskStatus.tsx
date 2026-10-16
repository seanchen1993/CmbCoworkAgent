import type { WorkflowRunView } from "@/lib/workflow-run-view"
import { isBotBackgroundStatusVisible } from "@/lib/bot-background-task-status"

/** Bot conversations show task state; the existing execution toggle reveals diagnostics. */
export function BackgroundTaskStatus({
  run,
  latestUserTime
}: {
  run: Pick<WorkflowRunView, "status" | "startedAtMs">
  latestUserTime: number | null
}) {
  if (!isBotBackgroundStatusVisible(run, latestUserTime)) return null
  const label = {
    running: "正在处理后台任务",
    completed: "后台任务已执行结束",
    aborted: "后台任务已停止",
    error: "后台任务未完成，可查看执行过程"
  }[run.status]
  return (
    <div role="status" className="py-2 text-xs text-muted-foreground">
      {label}
    </div>
  )
}
