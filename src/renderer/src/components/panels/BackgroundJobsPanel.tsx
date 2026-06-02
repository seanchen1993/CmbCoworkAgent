import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from "lucide-react"
import type { BackgroundJobStatus, BackgroundJobStatusRecord } from "../../../../shared/plugin-model-jobs"
import { cn } from "@/lib/utils"

interface BackgroundJobsPanelProps {
  workspacePath: string | null
}

const STATUS_LABEL: Record<BackgroundJobStatus, string> = {
  pending: "等待中",
  rejected: "已拒绝",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  cancelled: "已取消",
  interrupted: "已中断"
}

function statusClass(status: BackgroundJobStatus): string {
  if (status === "completed") return "text-green-600 dark:text-green-400"
  if (status === "running" || status === "pending") return "text-sky-600 dark:text-sky-400"
  if (status === "rejected" || status === "failed" || status === "timeout") return "text-destructive"
  return "text-muted-foreground"
}

function StatusIcon({ status }: { status: BackgroundJobStatus }): React.JSX.Element {
  if (status === "completed") return <CheckCircle2 className="size-4" />
  if (status === "running" || status === "pending") return <Loader2 className="size-4 animate-spin" />
  if (status === "failed" || status === "rejected" || status === "timeout") return <XCircle className="size-4" />
  return <Clock className="size-4" />
}

function formatTime(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-"
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function getSortTime(job: BackgroundJobStatusRecord): number {
  return Date.parse(job.startedAt ?? job.acceptedAt ?? job.createdAt) || 0
}

export function BackgroundJobsPanel({ workspacePath }: BackgroundJobsPanelProps): React.JSX.Element {
  const [jobs, setJobs] = useState<BackgroundJobStatusRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadJobs = useCallback(async () => {
    if (!workspacePath) {
      setJobs([])
      setError(null)
      return
    }
    setLoading(true)
    try {
      const result = await window.api.pluginJobs.list({ workspace: workspacePath, limit: 50 })
      setJobs(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void loadJobs()
  }, [loadJobs])

  useEffect(() => {
    const cleanup = window.api.pluginJobs.onUpdated((event) => {
      if (!workspacePath || event.workspace !== workspacePath) return
      void loadJobs()
    })
    return cleanup
  }, [loadJobs, workspacePath])

  const sortedJobs = useMemo(() => [...jobs].sort((a, b) => getSortTime(b) - getSortTime(a)), [jobs])
  const runningCount = jobs.filter((job) => job.status === "running" || job.status === "pending").length

  if (!workspacePath) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        当前线程未关联工作目录
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="text-xs text-muted-foreground">
          最近 {sortedJobs.length} 条{runningCount > 0 ? ` · ${runningCount} 个运行中` : ""}
        </div>
        <button
          type="button"
          onClick={() => void loadJobs()}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background-interactive hover:text-foreground"
          title="刷新"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {error && (
        <div className="m-3 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto right-panel-scroll p-2">
        {sortedJobs.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
            暂无后台任务
          </div>
        ) : (
          <div className="space-y-2">
            {sortedJobs.map((job) => (
              <div key={job.jobKey} className="rounded-lg border border-border/70 bg-background-elevated/40 p-3">
                <div className="flex items-start gap-2">
                  <div className={cn("mt-0.5", statusClass(job.status))}>
                    <StatusIcon status={job.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{job.type}</span>
                      <span className={cn("shrink-0 text-xs font-medium", statusClass(job.status))}>
                        {STATUS_LABEL[job.status]}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {job.pluginId} · {job.jobId}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>开始：{formatTime(job.startedAt ?? job.acceptedAt ?? job.createdAt)}</span>
                      <span>耗时：{formatDuration(job.durationMs)}</span>
                      <span>输出：{job.outputFiles.length}</span>
                      <span>尝试：{job.attempt}</span>
                    </div>
                    {job.outputFiles.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {job.outputFiles.slice(0, 3).map((file) => (
                          <div key={file} className="truncate rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                            {file}
                          </div>
                        ))}
                      </div>
                    )}
                    {job.error?.message && (
                      <div className="mt-2 rounded border border-destructive/20 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                        {job.error.code}: {job.error.message}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
