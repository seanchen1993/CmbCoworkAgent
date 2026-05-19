import { ChevronLeft, ChevronRight, ExternalLink, GitCommit, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import type { DashboardCommitDetail, DashboardCommitDetailsData } from "./use-dashboard"

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || "-"
  return date.toLocaleString()
}

function repoName(item: DashboardCommitDetail): string {
  if (item.repositoryName) return item.repositoryName
  if (!item.repoPath) return "-"
  const repoPath = item.repoPath
  const parts = repoPath.replace(/\\/g, "/").split("/").filter(Boolean)
  return parts[parts.length - 1] || repoPath
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-"
  return `${(value * 100).toFixed(1)}%`
}

function formatLines(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0"
}

function SkillChips({ skills }: { skills: string[] }): React.JSX.Element {
  if (skills.length === 0) {
    return <span className="text-xs text-muted-foreground">-</span>
  }

  const visibleSkills = skills.slice(0, 2)
  const hiddenCount = skills.length - visibleSkills.length
  return (
    <div className="flex max-w-[180px] flex-wrap gap-1">
      {visibleSkills.map((skill) => (
        <span
          key={skill}
          className="max-w-[86px] truncate rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-300"
          title={skill}
        >
          {skill}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span
          className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          title={skills.join(", ")}
        >
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  )
}

function CommitRow({
  item,
  onOpenExternal
}: {
  item: DashboardCommitDetail
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const externalUrl = item.pushed ? (item.commitUrl || item.repositoryWebUrl || "") : ""
  const displayRepo = repoName(item)

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
        {externalUrl ? (
          <button
            type="button"
            className="flex max-w-full items-center gap-1 truncate font-mono text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-blue-400"
            title={item.commitUrl || item.repositoryWebUrl || item.repoPath}
            onClick={() => onOpenExternal(externalUrl)}
          >
            <span className="truncate">{displayRepo}</span>
            <ExternalLink className="size-3 shrink-0" />
          </button>
        ) : (
          <span className="block truncate font-mono text-foreground/80" title={item.repoPath}>
            {displayRepo}
          </span>
        )}
      </td>
      <td className="max-w-[150px] px-3 py-2 text-xs">
        <span className="block truncate font-mono text-muted-foreground" title={item.branch}>
          {item.branch || "-"}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
          item.pushed
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-muted text-muted-foreground"
        }`}>
          {item.pushed ? "已 Push" : "未 Push"}
        </span>
      </td>
      <td className="px-3 py-2">
        <SkillChips skills={item.usedSkills} />
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <div className="font-medium tabular-nums text-foreground">
          {formatPercent(item.codeAdoptionRate)}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {formatLines(item.codeAdoptedLines)} / {formatLines(item.codeEffectiveGeneratedLines)} 行
        </div>
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

function CommitDetailsToolbar({
  total,
  page,
  pageSize,
  pageCount,
  fromIndex,
  toIndex,
  pushedOnly,
  loading,
  canPrev,
  canNext,
  onPageChange,
  onPushedOnlyChange
}: {
  total: number
  page: number
  pageSize: number
  pageCount: number
  fromIndex: number
  toIndex: number
  pushedOnly: boolean
  loading: boolean
  canPrev: boolean
  canNext: boolean
  onPageChange: (page: number) => void
  onPushedOnlyChange: (pushedOnly: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/10 px-5 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>共 {total} 条</span>
        <span>每页 {pageSize} 条</span>
        <span>{fromIndex}-{toIndex}</span>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex h-7 items-center rounded-full bg-muted px-1 text-[11px] font-medium">
          {[
            { value: false, label: "全部" },
            { value: true, label: "已 Push" }
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              className={`h-5 rounded-full px-2.5 leading-5 transition-colors ${
                pushedOnly === option.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              disabled={loading}
              onClick={() => {
                if (pushedOnly !== option.value) onPushedOnlyChange(option.value)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            disabled={!canPrev}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="min-w-14 text-center tabular-nums">{page} / {pageCount}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            disabled={!canNext}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export function CommitDetailsDialog({
  open,
  onOpenChange,
  scopeLabel,
  data,
  loading,
  error,
  onPageChange,
  onPushedOnlyChange,
  onOpenExternal
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scopeLabel: string
  data: DashboardCommitDetailsData | null
  loading: boolean
  error: string | null
  onPageChange: (page: number) => void
  onPushedOnlyChange: (pushedOnly: boolean) => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const page = data?.page ?? 1
  const pageSize = data?.pageSize ?? 20
  const pushedOnly = data?.pushedOnly ?? false
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const fromIndex = total === 0 ? 0 : (page - 1) * pageSize + 1
  const toIndex = Math.min(total, page * pageSize)
  const canPrev = page > 1 && !loading
  const canNext = page < pageCount && !loading

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

        {loading && !data ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <CommitDetailsToolbar
              total={total}
              page={page}
              pageSize={pageSize}
              pageCount={pageCount}
              fromIndex={fromIndex}
              toIndex={toIndex}
              pushedOnly={pushedOnly}
              loading={loading}
              canPrev={canPrev}
              canNext={canNext}
              onPageChange={onPageChange}
              onPushedOnlyChange={onPushedOnlyChange}
            />
            <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
              {pushedOnly ? "该时间范围内没有已 Push 的 Commit 数据" : "该时间范围内没有 Commit 数据"}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <CommitDetailsToolbar
              total={total}
              page={page}
              pageSize={pageSize}
              pageCount={pageCount}
              fromIndex={fromIndex}
              toIndex={toIndex}
              pushedOnly={pushedOnly}
              loading={loading}
              canPrev={canPrev}
              canNext={canNext}
              onPageChange={onPageChange}
              onPushedOnlyChange={onPushedOnlyChange}
            />
            <ScrollArea className="min-h-0 flex-1">
              <div className="overflow-x-auto">
                <table className="min-w-[1060px] w-full text-left">
                  <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border text-[11px] text-muted-foreground">
                      <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">用户</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">部门</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">仓库</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">分支</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">状态</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">关联 Skill</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">采纳率</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">变更</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">Thread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <CommitRow key={item.eventId} item={item} onOpenExternal={onOpenExternal} />
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
