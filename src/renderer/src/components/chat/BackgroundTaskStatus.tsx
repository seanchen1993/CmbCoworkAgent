import type { WorkflowRunView } from "@/lib/workflow-run-view"

/** Bot conversations show task state; the existing execution toggle reveals diagnostics. */
export function BackgroundTaskStatus({ status }: { status: WorkflowRunView["status"] }) {
  const label = {
    running: "正在处理后台任务",
    completed: "后台任务已执行结束",
    aborted: "后台任务已停止",
    error: "后台任务未完成，可查看执行过程"
  }[status]
  return (
    <div role="status" className="py-2 text-xs text-muted-foreground">
      {label}
    </div>
  )
}
