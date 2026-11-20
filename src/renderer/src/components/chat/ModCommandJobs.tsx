import { useEffect, useState } from "react"
import type { ModCommandJob } from "../../../../shared/mods/types"
import { Button } from "@/components/ui/button"

const labels = {
  queued: "等待会话空闲",
  running: "执行中",
  succeeded: "已完成",
  failed: "命令未完成",
  cancelled: "已取消",
  unknown: "结果待核查"
}
export function ModCommandJobs({ threadId }: { threadId: string }): React.JSX.Element | null {
  const [jobs, setJobs] = useState<ModCommandJob[]>([])
  const [error, setError] = useState("")
  useEffect(() => {
    let live = true
    let sequence = 0
    setJobs([])
    setError("")
    const refresh = (): void => {
      const current = ++sequence
      void window.api.mods.jobs(threadId).then(
        (rows) => {
          if (live && current === sequence) setJobs(rows)
        },
        () => {}
      )
    }
    const stop = window.api.mods.onJobsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    refresh()
    window.addEventListener("mods:configuration-changed", refresh)
    return () => {
      live = false
      stop()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId])
  if (!jobs.length) return null
  return (
    <details
      className="mx-auto my-2 max-w-3xl rounded border p-3 text-xs"
      open={jobs.some(
        (job) => job.presentation === "inline" || job.state === "queued" || job.state === "running"
      )}
      data-mod-jobs
    >
      <summary>Mods 命令（{jobs.length}）</summary>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="max-h-72 overflow-auto space-y-2 mt-2">
        {jobs.map((job) => (
          <section key={job.id} data-mod-job-state={job.state} className="border-t pt-2">
            <p>
              <strong>{job.command}</strong> · {labels[job.state]}
            </p>
            <p className="text-muted-foreground">{new Date(job.createdAt).toLocaleString()}</p>
            {job.result && <pre className="whitespace-pre-wrap break-words">{job.result.text}</pre>}
            {job.error && (
              <p role="status">
                {job.error === "MODS_TOOL_UNAVAILABLE"
                  ? "请先在本会话运行一次任务以建立工具上下文，再重新发起命令。"
                  : job.error}
              </p>
            )}
            {job.state === "unknown" && (
              <p>操作可能已生效。请在项目执行记录中核查，不要直接重试。</p>
            )}
            {["queued", "running"].includes(job.state) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void window.api.mods.cancelJob(threadId, job.id).catch((e) => setError(String(e)))
                }
              >
                {job.state === "queued" ? "取消排队" : "停止命令"}
              </Button>
            )}
          </section>
        ))}
      </div>
    </details>
  )
}
