import { useEffect, useState, type JSX } from "react"
import { Check, Copy, Eye, GitBranch, GitMerge, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { newerWorkflowWorktree, type WorkflowWorktreeView } from "@/lib/workflow-run-view"
import { cn } from "@/lib/utils"

const STATUS_LABELS: Record<WorkflowWorktreeView["status"], string> = {
  provisioning: "准备中",
  running: "执行中",
  ready: "待处理",
  recoverable: "需恢复",
  integrating: "合并恢复中",
  merged: "已合并",
  discarded: "已丢弃"
}
const WORKTREE_PAGE_SIZE = 50

function canManage(record: WorkflowWorktreeView): boolean {
  return (
    record.status === "ready" ||
    record.status === "recoverable" ||
    record.status === "merged" ||
    record.status === "discarded"
  )
}

export function WorkflowWorktreeList({
  threadId,
  runId,
  worktrees,
  manageAllowed = true,
  onRecordChange
}: {
  threadId: string
  runId: string
  worktrees: WorkflowWorktreeView[]
  manageAllowed?: boolean
  onRecordChange?: (record: WorkflowWorktreeView) => void
}): JSX.Element | null {
  const [records, setRecords] = useState(worktrees)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [visibleCount, setVisibleCount] = useState(WORKTREE_PAGE_SIZE)

  useEffect(() => {
    setRecords((current) => {
      const currentById = new Map(current.map((record) => [record.id, record]))
      return worktrees.map((record) => {
        const existing = currentById.get(record.id)
        return existing ? newerWorkflowWorktree(existing, record) : record
      })
    })
  }, [worktrees])

  if (records.length === 0) return null

  const runAction = async (
    record: WorkflowWorktreeView,
    action: "diff" | "merge" | "discard" | "cleanup"
  ): Promise<void> => {
    setBusy(`${record.id}:${action}`)
    try {
      const response = await window.api.workflows.worktreeAction(threadId, runId, record.id, action)
      const next = response.record as WorkflowWorktreeView
      setRecords((current) =>
        current.map((candidate) =>
          candidate.id === next.id ? newerWorkflowWorktree(candidate, next) : candidate
        )
      )
      onRecordChange?.(next)
      if (response.summary !== undefined) {
        setSummaries((current) => ({ ...current, [record.id]: response.summary ?? "" }))
      }
      if (action === "merge") {
        toast.success(
          response.record.cleanupPending ? "已合并，后台清理待重试" : "已安全合并并清理 worktree"
        )
      }
      if (action === "discard") {
        toast.success(
          response.record.cleanupPending ? "已丢弃，后台清理待重试" : "已丢弃并清理 worktree"
        )
      }
      if (action === "cleanup") {
        toast.success(response.record.cleanupPending ? "清理仍待重试" : "已清理 worktree")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message || "worktree 操作失败")
      try {
        const refreshed = (await window.api.workflows.getRun(threadId, runId)) as {
          worktrees?: WorkflowWorktreeView[]
        } | null
        const latest = refreshed?.worktrees?.find((candidate) => candidate.id === record.id)
        if (latest) {
          setRecords((current) =>
            current.map((candidate) =>
              candidate.id === latest.id ? newerWorkflowWorktree(candidate, latest) : candidate
            )
          )
          onRecordChange?.(latest)
        }
      } catch {
        // The original action error is the useful one; refresh is best-effort.
      }
    } finally {
      setBusy(null)
      if (action === "discard" || action === "cleanup") setConfirmDiscard(null)
    }
  }

  return (
    <div className="space-y-1.5">
      {records.slice(0, visibleCount).map((record) => {
        const manageable = manageAllowed && canManage(record)
        const isBusy = busy?.startsWith(`${record.id}:`) === true
        const summary = summaries[record.id]
        return (
          <div key={record.id} className="rounded-md border border-border/70 bg-background/70 p-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <GitBranch className="size-3.5 shrink-0 text-violet-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={record.branch}>
                {record.branch}
              </span>
              {record.dirty && (
                <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
                  未提交
                </span>
              )}
              <span
                className={cn(
                  "shrink-0 rounded px-1 py-0.5 text-[9px]",
                  record.status === "recoverable"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
                    : record.status === "merged"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {STATUS_LABELS[record.status]}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1 text-[9px] text-muted-foreground">
              <span className="truncate" title={record.directory}>
                {record.directory}
              </span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
                title="复制 worktree 根目录"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(record.directory)
                    toast.success("已复制 worktree 根目录")
                  } catch {
                    toast.error("复制 worktree 根目录失败")
                  }
                }}
              >
                <Copy className="size-2.5" />
              </button>
            </div>
            {record.error && (
              <div className="mt-1 break-words text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                {record.error}
              </div>
            )}
            {record.status !== "merged" && record.status !== "discarded" && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  disabled={isBusy || !manageable}
                  onClick={() => void runAction(record, "diff")}
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted disabled:opacity-40"
                >
                  {busy === `${record.id}:diff` ? (
                    <Loader2 className="size-2.5 animate-spin" />
                  ) : (
                    <Eye className="size-2.5" />
                  )}
                  Diff
                </button>
                <button
                  type="button"
                  disabled={isBusy || !manageable || record.dirty}
                  onClick={() => void runAction(record, "merge")}
                  className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                  title={record.dirty ? "请先在 worktree 中提交改动" : "预检无冲突后合并到原分支"}
                >
                  {busy === `${record.id}:merge` ? (
                    <Loader2 className="size-2.5 animate-spin" />
                  ) : (
                    <GitMerge className="size-2.5" />
                  )}
                  合并
                </button>
                <button
                  type="button"
                  disabled={isBusy || !manageable}
                  onClick={() => {
                    if (confirmDiscard === record.id) void runAction(record, "discard")
                    else setConfirmDiscard(record.id)
                  }}
                  className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600 hover:bg-red-100 disabled:opacity-40 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                >
                  {busy === `${record.id}:discard` ? (
                    <Loader2 className="size-2.5 animate-spin" />
                  ) : confirmDiscard === record.id ? (
                    <Check className="size-2.5" />
                  ) : (
                    <Trash2 className="size-2.5" />
                  )}
                  {confirmDiscard === record.id ? "确认丢弃" : "丢弃"}
                </button>
              </div>
            )}
            {(record.status === "merged" || record.status === "discarded") &&
              record.cleanupPending === true &&
              manageable && (
                <div className="mt-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      if (confirmDiscard === record.id) {
                        void runAction(record, "cleanup")
                      } else {
                        setConfirmDiscard(record.id)
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[9px] text-red-600 hover:bg-red-100 disabled:opacity-40 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                    title="确认后删除残留 worktree（包括 ignored 文件）"
                  >
                    {busy === `${record.id}:cleanup` ? (
                      <Loader2 className="size-2.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-2.5" />
                    )}
                    {confirmDiscard === record.id ? "确认清理" : "重试清理"}
                  </button>
                </div>
              )}
            {summary !== undefined && (
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 text-[9px] leading-4">
                {summary}
              </pre>
            )}
          </div>
        )
      })}
      {visibleCount < records.length && (
        <button
          type="button"
          className="w-full rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
          onClick={() => setVisibleCount((count) => count + WORKTREE_PAGE_SIZE)}
        >
          显示更多 ({records.length - visibleCount})
        </button>
      )}
    </div>
  )
}
