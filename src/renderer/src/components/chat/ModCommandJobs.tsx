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
const errorMessages: Record<string, string> = {
  MODS_TOOL_UNAVAILABLE: "当前会话未提供该工具，请检查插件使用的工具名称和会话配置。",
  MODS_TOOL_ARGUMENTS: "工具参数不符合当前接口，请检查插件的工具调用。",
  MODS_WRITE_REQUIRES_USER_ACTION: "写操作需要由普通命令或交互动作发起，即时查询不能写入。",
  MODS_FS_OUTSIDE_PROJECT: "无法读取项目目录之外的文件。请使用本项目内的路径。",
  MODS_FS_ROOT_CHANGED: "项目目录已变更，请重新打开项目后再试。",
  MODS_FS_NOT_FOUND: "文件不存在，请检查路径。",
  MODS_FS_ACCESS_DENIED: "系统未允许读取这个文件。",
  MODS_FS_PATH: "文件路径无效，请检查名称。",
  MODS_FS_READ_LIMIT: "文件超过当前插件读取上限（512 KiB）。",
  MODS_FS_ENTRY_LIMIT: "目录超过当前插件列举上限（1024 项）。",
  MODS_FS_CHANGED: "文件在读取期间发生变化，请重新读取。",
  MODS_FS_FAILED: "无法读取文件或目录，请检查文件类型和访问权限。",
  MODS_COMMAND_TURN_HELD: "当前命令不能等待另一条命令，请调整插件实现。"
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
            {job.error && <p role="status">{errorMessages[job.error] ?? job.error}</p>}
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
