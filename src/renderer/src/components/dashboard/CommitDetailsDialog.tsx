import { GitCommit, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { DashboardCommitDetail } from "./use-dashboard"

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || "-"
  return date.toLocaleString()
}

function repoName(repoPath?: string): string {
  if (!repoPath) return "-"
  const parts = repoPath.replace(/\\/g, "/").split("/").filter(Boolean)
  return parts[parts.length - 1] || repoPath
}

function CommitRow({ item }: { item: DashboardCommitDetail }): React.JSX.Element {
  return (
    <tr className="border-b border-border/60 last:border-b-0 hover:bg-muted/20">
      <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">
        {formatTime(item.eventTime)}
      </td>
      <td className="px-3 py-2">
        <div className="text-xs font-medium text-foreground">{item.userName || "-"}</div>
        <div className="text-[10px] text-muted-foreground">{item.sapId || item.ystId || "-"}</div>
      </td>
      <td className="max-w-[120px] px-3 py-2 text-xs text-muted-foreground">
        <span className="block truncate" title={item.orgName}>{item.orgName || "-"}</span>
      </td>
      <td className="max-w-[180px] px-3 py-2 text-xs">
        <span className="block truncate font-mono text-foreground/80" title={item.repoPath}>
          {repoName(item.repoPath)}
        </span>
      </td>
      <td className="max-w-[150px] px-3 py-2 text-xs">
        <span className="block truncate font-mono text-muted-foreground" title={item.branch}>
          {item.branch || "-"}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <span className="text-muted-foreground">{item.filesChanged} 文件</span>
        <span className="ml-2 text-emerald-600 dark:text-emerald-400">+{item.insertions}</span>
        <span className="ml-1 text-rose-600 dark:text-rose-400">-{item.deletions}</span>
      </td>
      <td className="max-w-[110px] px-3 py-2 text-[11px] font-mono text-muted-foreground">
        <span className="block truncate" title={item.threadId}>{item.threadId || "-"}</span>
      </td>
    </tr>
  )
}

export function CommitDetailsDialog({
  open,
  onOpenChange,
  scopeLabel,
  data,
  loading,
  error
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scopeLabel: string
  data: { total: number; items: DashboardCommitDetail[] } | null
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const items = data?.items ?? []
  const total = data?.total ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[75vh] max-w-[1000px] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitCommit className="size-4 text-muted-foreground" />
            Commit 明细
          </DialogTitle>
          <DialogDescription>{scopeLabel}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
            该时间范围内没有 Commit 数据
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/10 px-5 py-2 text-xs text-muted-foreground">
              <span>共 {total} 条</span>
              {total > items.length && <span>仅展示最近 {items.length} 条</span>}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="overflow-x-auto">
                <table className="min-w-[760px] w-full text-left">
                  <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border text-[11px] text-muted-foreground">
                      <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">用户</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">部门</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">仓库</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">分支</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">变更</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">Thread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <CommitRow key={item.eventId} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
