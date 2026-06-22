import { useEffect, useMemo, useState } from "react"
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileWarning,
  GitCommit,
  GitCompare,
  Info,
  Loader2,
  MessagesSquare,
  Search,
  X
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { TraceExplorer } from "./TraceHistoryDialog"
import { CommitAdoptionTraceDialog } from "./CommitAdoptionTraceDialog"
import { UncommittedCodeAnalysisPanel, type UncommittedScope } from "./UncommittedCodeDialog"
import type {
  DashboardCommitDetail,
  DashboardCommitDetailsData,
  DashboardTraceDetail
} from "./use-dashboard"

interface CommitDetailsUncommittedAnalysis {
  range: { from: string; to: string }
  scope: UncommittedScope
}

function HeaderHint({ hint }: { hint: string }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 cursor-help align-middle">
            <Info className="size-3 text-muted-foreground/70" aria-label={hint} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

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

function orgLabel(item: DashboardCommitDetail): string {
  const upperOrgLv1 = item.upperOrgLv1?.trim() ?? ""
  const upperOrgLv0 = item.upperOrgLv0?.trim() ?? ""
  if (upperOrgLv1 && upperOrgLv0) return `${upperOrgLv1}/${upperOrgLv0}`
  if (upperOrgLv1) return upperOrgLv1
  return item.orgName || "-"
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
  onOpenExternal,
  onViewThread,
  onViewTrace
}: {
  item: DashboardCommitDetail
  onOpenExternal: (url: string) => void
  onViewThread: (item: DashboardCommitDetail) => void
  onViewTrace: (item: DashboardCommitDetail) => void
}): React.JSX.Element {
  const externalUrl = item.pushed ? item.commitUrl || item.repositoryWebUrl || "" : ""
  const displayRepo = repoName(item)
  const displayOrg = orgLabel(item)

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
        <span className="block truncate" title={displayOrg}>
          {displayOrg}
        </span>
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
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            item.pushed
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {item.pushed ? "已 Push" : "未 Push"}
        </span>
      </td>
      <td className="px-3 py-2">
        <SkillChips skills={item.usedSkills} />
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <button
          type="button"
          className="group/trace -mx-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          disabled={!item.commitSha}
          title={
            item.commitSha
              ? "查看采纳溯源：该率对应的 gen / adopt 事件"
              : "无 commit 信息，无法溯源"
          }
          onClick={() => onViewTrace(item)}
        >
          <div className="flex items-center gap-1 font-medium tabular-nums text-foreground">
            {formatPercent(item.codeAdoptionRate)}
            {item.commitSha ? (
              <GitCompare className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover/trace:opacity-100" />
            ) : null}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {formatLines(item.codeAdoptedLines)} / {formatLines(item.codeEffectiveGeneratedLines)}{" "}
            行
          </div>
        </button>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <span className="text-muted-foreground">{item.filesChanged} 文件</span>
        <span className="ml-2 text-emerald-600 dark:text-emerald-400">+{item.insertions}</span>
        <span className="ml-1 text-rose-600 dark:text-rose-400">-{item.deletions}</span>
      </td>
      <td className="max-w-[130px] px-3 py-2 text-xs">
        {item.threadIds.length > 0 ? (
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground/80 transition-colors hover:border-blue-500/40 hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-300"
            title={`查看会话记录 · ${item.threadIds.join(", ")}`}
            onClick={() => onViewThread(item)}
          >
            <MessagesSquare className="size-3 shrink-0" />
            <span className="truncate">查看会话</span>
            {item.threadIds.length > 1 ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {item.threadIds.length}
              </span>
            ) : null}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </td>
    </tr>
  )
}

function CommitAdoptionSummaryBar({
  commit
}: {
  commit: DashboardCommitDetail
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/10 px-5 py-2 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1 font-medium text-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        采纳 {formatLines(commit.codeAdoptedLines)} 行
      </span>
      <span>有效生成 {formatLines(commit.codeEffectiveGeneratedLines)} 行</span>
      <span>
        采纳率{" "}
        <span className="font-medium text-foreground">
          {formatPercent(commit.codeAdoptionRate)}
        </span>
      </span>
      <span className="ml-auto">关联 {commit.threadIds.length} 个会话</span>
    </div>
  )
}

function ThreadConversationDialog({
  commit,
  threadScope = "platform",
  onOpenChange
}: {
  commit: DashboardCommitDetail | null
  threadScope?: "platform" | "project"
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const threadIds = useMemo(() => commit?.threadIds ?? [], [commit])
  const threadKey = threadIds.join("|")
  const [traces, setTraces] = useState<DashboardTraceDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (threadIds.length === 0) {
      setTraces([])
      setError(null)
      return
    }
    const api = window.api?.dashboard
    if (!api || typeof api.threadTraces !== "function") {
      setError("当前环境不支持加载会话记录")
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all(
      threadIds.map(async (id) => {
        try {
          const res = await api.threadTraces(id, { scope: threadScope })
          return res?.success && Array.isArray(res.data) ? (res.data as DashboardTraceDetail[]) : []
        } catch {
          return []
        }
      })
    )
      .then((lists) => {
        if (!cancelled) setTraces(lists.flat())
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // threadKey 是 threadIds 的稳定字符串表示，避免数组引用变化导致的重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey, threadScope])

  // 已按 threadId 分好的 trace 供 TraceExplorer 选中会话时复用，避免重复网络请求。
  const tracesByThread = useMemo(() => {
    const map = new Map<string, DashboardTraceDetail[]>()
    for (const trace of traces) {
      const id = trace.threadId || "unknown-thread"
      map.set(id, [...(map.get(id) ?? []), trace])
    }
    return map
  }, [traces])

  return (
    <Dialog open={Boolean(commit)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-[1000px] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessagesSquare className="size-4 text-muted-foreground" />
            会话记录
          </DialogTitle>
          <DialogDescription className="truncate">
            {commit?.userName ? `${commit.userName} · ` : ""}
            {commit?.repositoryName || commit?.branch || ""}
          </DialogDescription>
        </DialogHeader>
        {commit ? <CommitAdoptionSummaryBar commit={commit} /> : null}
        <TraceExplorer
          traces={traces}
          loading={loading}
          error={error}
          showCodeStats={false}
          defaultViewMode="thread"
          showViewModeToggle={false}
          loadThreadTraces={async (id) => tracesByThread.get(id) ?? []}
          title="关联会话"
          subtitle="选择会话查看对话还原"
          emptyText="该 commit 暂无可还原的会话记录"
          className="min-h-0 flex-1"
        />
      </DialogContent>
    </Dialog>
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
  departmentValue,
  userValue,
  loading,
  canPrev,
  canNext,
  onPageChange,
  onPushedOnlyChange,
  onDepartmentValueChange,
  onUserValueChange,
  onSearch,
  onClearDepartment,
  onClearUser
}: {
  total: number
  page: number
  pageSize: number
  pageCount: number
  fromIndex: number
  toIndex: number
  pushedOnly: boolean
  departmentValue: string
  userValue: string
  loading: boolean
  canPrev: boolean
  canNext: boolean
  onPageChange: (page: number) => void
  onPushedOnlyChange: (pushedOnly: boolean) => void
  onDepartmentValueChange: (value: string) => void
  onUserValueChange: (value: string) => void
  onSearch: () => void
  onClearDepartment: () => void
  onClearUser: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/10 px-5 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>共 {total} 条</span>
        <span>每页 {pageSize} 条</span>
        <span>
          {fromIndex}-{toIndex}
        </span>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
      </div>
      <div className="flex items-center gap-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch()
          }}
        >
          <div className="relative w-[180px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={departmentValue}
              onChange={(event) => onDepartmentValueChange(event.target.value)}
              aria-label="按 Lv1 或 Lv0 部门筛选 Commit"
              placeholder="部门查询"
              className="h-7 pl-8 pr-7 text-xs"
            />
            {departmentValue ? (
              <button
                type="button"
                onClick={onClearDepartment}
                className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="清空部门筛选"
                title="清空"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
          <div className="relative w-[160px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={userValue}
              onChange={(event) => onUserValueChange(event.target.value)}
              aria-label="按用户姓名或 ID 筛选 Commit"
              placeholder="用户查询"
              className="h-7 pl-8 pr-7 text-xs"
            />
            {userValue ? (
              <button
                type="button"
                onClick={onClearUser}
                className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="清空用户筛选"
                title="清空"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
          <Button type="submit" variant="outline" size="sm" className="h-7 px-2" disabled={loading}>
            查询
          </Button>
        </form>
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
          <span className="min-w-14 text-center tabular-nums">
            {page} / {pageCount}
          </span>
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
  threadScope = "platform",
  data,
  loading,
  error,
  onPageChange,
  onPushedOnlyChange,
  departmentValue,
  userValue,
  onDepartmentValueChange,
  onUserValueChange,
  onSearch,
  onClearDepartment,
  onClearUser,
  onOpenExternal,
  uncommittedAnalysis
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scopeLabel: string
  threadScope?: "platform" | "project"
  data: DashboardCommitDetailsData | null
  loading: boolean
  error: string | null
  onPageChange: (page: number) => void
  onPushedOnlyChange: (pushedOnly: boolean) => void
  departmentValue: string
  userValue: string
  onDepartmentValueChange: (value: string) => void
  onUserValueChange: (value: string) => void
  onSearch: () => void
  onClearDepartment: () => void
  onClearUser: () => void
  onOpenExternal: (url: string) => void
  uncommittedAnalysis?: CommitDetailsUncommittedAnalysis
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
  const [threadCommit, setThreadCommit] = useState<DashboardCommitDetail | null>(null)
  const [traceCommit, setTraceCommit] = useState<DashboardCommitDetail | null>(null)
  const [activeTab, setActiveTab] = useState<"commits" | "uncommitted">("commits")
  const hasUncommittedTab = Boolean(uncommittedAnalysis)
  const tabValue = hasUncommittedTab ? activeTab : "commits"
  const handleDialogOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) setActiveTab("commits")
    onOpenChange(nextOpen)
  }

  const commitContent =
    loading && !data ? (
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
          departmentValue={departmentValue}
          userValue={userValue}
          loading={loading}
          canPrev={canPrev}
          canNext={canNext}
          onPageChange={onPageChange}
          onPushedOnlyChange={onPushedOnlyChange}
          onDepartmentValueChange={onDepartmentValueChange}
          onUserValueChange={onUserValueChange}
          onSearch={onSearch}
          onClearDepartment={onClearDepartment}
          onClearUser={onClearUser}
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
          departmentValue={departmentValue}
          userValue={userValue}
          loading={loading}
          canPrev={canPrev}
          canNext={canNext}
          onPageChange={onPageChange}
          onPushedOnlyChange={onPushedOnlyChange}
          onDepartmentValueChange={onDepartmentValueChange}
          onUserValueChange={onUserValueChange}
          onSearch={onSearch}
          onClearDepartment={onClearDepartment}
          onClearUser={onClearUser}
        />
        <ScrollArea className="min-h-0 flex-1" orientation="both">
          <div className="min-w-max">
            <table className="w-full min-w-[1060px] text-left">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border text-[11px] text-muted-foreground">
                  <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">用户</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">部门</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">仓库</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">分支</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">状态</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">关联 Skill</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1">
                      采纳率
                      <HeaderHint hint="Agent 生成代码的采纳率。点击下方的数字可进行采纳溯源。" />
                    </span>
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1">
                      变更
                      <HeaderHint hint="git 提交的变更行数" />
                    </span>
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">对话记录</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <CommitRow
                    key={item.eventId}
                    item={item}
                    onOpenExternal={onOpenExternal}
                    onViewThread={setThreadCommit}
                    onViewTrace={setTraceCommit}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </ScrollArea>
      </div>
    )

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="flex h-[75vh] max-w-[1000px] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitCommit className="size-4 text-muted-foreground" />
            {hasUncommittedTab ? "采纳率下钻" : "Commit 明细"}
          </DialogTitle>
          <DialogDescription>{scopeLabel}</DialogDescription>
        </DialogHeader>
        {hasUncommittedTab ? (
          <Tabs
            value={tabValue}
            onValueChange={(value) => setActiveTab(value === "uncommitted" ? value : "commits")}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="border-b border-border px-5 py-2">
              <TabsList className="h-8">
                <TabsTrigger value="commits" className="h-6 gap-1.5 text-xs">
                  <GitCommit className="size-3.5" />
                  Commit 明细
                </TabsTrigger>
                <TabsTrigger value="uncommitted" className="h-6 gap-1.5 text-xs">
                  <FileWarning className="size-3.5" />
                  未提交分析
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="commits" className="m-0 flex min-h-0 flex-1 flex-col">
              {commitContent}
            </TabsContent>
            <TabsContent value="uncommitted" className="m-0 flex min-h-0 flex-1 flex-col">
              {uncommittedAnalysis ? (
                <UncommittedCodeAnalysisPanel
                  active={open && activeTab === "uncommitted"}
                  range={uncommittedAnalysis.range}
                  scope={uncommittedAnalysis.scope}
                />
              ) : null}
            </TabsContent>
          </Tabs>
        ) : (
          commitContent
        )}
      </DialogContent>
      <ThreadConversationDialog
        commit={threadCommit}
        threadScope={threadScope}
        onOpenChange={(next) => {
          if (!next) setThreadCommit(null)
        }}
      />
      <CommitAdoptionTraceDialog
        commit={traceCommit}
        onOpenChange={(next) => {
          if (!next) setTraceCommit(null)
        }}
        onViewThread={(threadId) => {
          // 复用既有会话还原弹窗（ThreadConversationDialog），按单个会话作用域打开。
          if (traceCommit) setThreadCommit({ ...traceCommit, threadIds: [threadId] })
        }}
      />
    </Dialog>
  )
}
