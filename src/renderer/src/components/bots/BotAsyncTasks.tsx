import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useState, useSyncExternalStore } from "react"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GitBranch,
  RefreshCw,
  Workflow,
  Terminal
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type {
  BotAsyncTask,
  BotAsyncTasksPage,
  BotAsyncTasksRequest
} from "../../../../shared/bot-async-tasks"
import type { BotRunStatus } from "../../../../shared/bot-types"
import { BotRunHistory } from "./BotRunHistory"
import { BotShellJob } from "./BotShellJob"
import { DEFAULT_ASYNC_TASKS_CLOCK } from "./upstream/grok-async-clock"
import { formatAsyncTaskTime } from "./upstream/grok-async-time"

const labels: Record<BotRunStatus, string> = {
  queued: "等待执行",
  running: "运行中",
  waiting_input: "等待处理",
  cancelling: "正在停止",
  needs_review: "待核对",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止"
}
const idleClockSubscription = () => () => {}

/** Grok's live async-task rows, backed by Cmb's persisted execution identities. */
export function BotAsyncTasks({
  bot,
  close
}: {
  bot: { id: string; name: string }
  close(): void
}) {
  const viewVisible = useBotViewVisibility()
  const [cursors, setCursors] = useState<NonNullable<BotAsyncTasksRequest["before"]>[]>([])
  const [page, setPage] = useState<BotAsyncTasksPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<BotAsyncTask | null>(null)
  const now = useSyncExternalStore(
    viewVisible && !selected ? DEFAULT_ASYNC_TASKS_CLOCK.subscribe : idleClockSubscription,
    DEFAULT_ASYNC_TASKS_CLOCK.now,
    DEFAULT_ASYNC_TASKS_CLOCK.now
  )
  const before = cursors.at(-1)
  useEffect(() => {
    if (!viewVisible || selected) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      setBusy(true)
      try {
        const next = await botApi.asyncTasks({ botId: bot.id, before, limit: 20 })
        if (!disposed) {
          setPage(next)
          setError(null)
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "后台任务读取失败")
      } finally {
        if (!disposed) {
          setBusy(false)
          timer = setTimeout(() => void read(), 2000)
        }
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [bot.id, before, retry, selected, viewVisible])
  const move = (next: typeof cursors) => {
    setPage(null)
    setError(null)
    setCursors(next)
  }
  if (selected?.kind === "shell" && selected.jobId)
    return (
      <BotShellJob
        address={{ ...selected.address, jobId: selected.jobId }}
        close={close}
        back={() => {
          setSelected(null)
          setRetry((value) => value + 1)
        }}
      />
    )
  if (selected)
    return (
      <BotRunHistory
        address={selected.address}
        close={close}
        back={() => {
          setSelected(null)
          setRetry((value) => value + 1)
        }}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock3 size={18} />
            后台任务 · {bot.name}
          </DialogTitle>
          <DialogDescription>查看运行进度、待处理事项和子任务结果。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            第 {cursors.length + 1} 页 · 自动更新
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={14} className={busy ? "motion-safe:animate-spin" : ""} />
            刷新
          </Button>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
            {page ? "；保留上次读取的任务，请刷新核对。" : ""}
          </p>
        )}
        <div className="min-h-0 overflow-y-auto">
          {!page && !error && (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              正在读取后台任务…
            </p>
          )}
          {page?.items.length === 0 && (
            <div className="space-y-3 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
              <Clock3 className="mx-auto" size={26} strokeWidth={1.5} />
              <p className="text-sm">{before ? "这一页的任务已结束" : "当前没有后台任务"}</p>
              <p className="text-xs">已完成任务的结果和执行记录保留在对应对话中。</p>
              {before && (
                <Button variant="outline" size="sm" onClick={() => move([])}>
                  <ArrowLeft size={14} />
                  返回第一页
                </Button>
              )}
            </div>
          )}
          <ul className="space-y-2" aria-label="后台任务列表">
            {page?.items.map((task) => (
              <li key={task.key}>
                <button
                  type="button"
                  onClick={() => setSelected(task)}
                  className="flex w-full items-start gap-3 rounded-xl border border-border/70 bg-background/40 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 size-1.5 shrink-0 rounded-full ${task.status === "running" ? "bg-emerald-500 motion-safe:animate-pulse" : task.status === "needs_review" || task.status === "waiting_input" ? "bg-amber-500" : "bg-muted-foreground/50"}`}
                  />
                  {task.kind === "child" ? (
                    <GitBranch className="mt-0.5 shrink-0 text-muted-foreground" size={17} />
                  ) : task.kind === "shell" ? (
                    <Terminal className="mt-0.5 shrink-0 text-muted-foreground" size={17} />
                  ) : (
                    <Workflow className="mt-0.5 shrink-0 text-muted-foreground" size={17} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{task.label}</span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {task.kind === "child"
                        ? "子任务"
                        : task.kind === "shell"
                          ? "后台命令"
                          : "后台工作流"}{" "}
                      · {labels[task.status]}
                      {task.phase ? ` · ${task.phase}` : ""}
                    </span>
                  </span>
                  <time
                    title={new Date(task.createdAt).toLocaleString()}
                    dateTime={new Date(task.createdAt).toISOString()}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {formatAsyncTaskTime(task.createdAt, now)}
                  </time>
                  <ChevronRight className="shrink-0 text-muted-foreground" size={15} />
                </button>
              </li>
            ))}
          </ul>
        </div>
        {(before || page?.next) && (
          <div className="flex items-center justify-between border-t pt-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={!before || busy}
              onClick={() => move(cursors.slice(0, -1))}
            >
              <ChevronLeft size={14} />
              上一页
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!page?.next || busy}
              onClick={() => page?.next && move([...cursors, page.next])}
            >
              下一页
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
