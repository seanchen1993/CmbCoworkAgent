/**
 * Operations Dashboard
 *
 * 5 panels: Overview · Feedback · Model Analysis · User Analysis · Productivity
 */
import { useState, useCallback, useEffect, useRef } from "react"
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  Download,
  Search,
  X,
  User,
  Users,
  Building2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  formatTopUserOrgName,
  useDashboard,
  type DashboardCommitDetailsData,
  type DashboardSkillDetail,
  type DashboardTraceTriggerScope,
  type DashboardTraceViewMode,
  type DashboardUserDetail,
  type DashboardUserListData,
  type DashboardUserListItem,
  type Granularity,
  type TimeRange
} from "./use-dashboard"
import { OverviewPanel } from "./panels/OverviewPanel"
import { ModelPanel } from "./panels/ModelPanel"
import { UserPanel } from "./panels/UserPanel"
import { ProductivityPanel } from "./panels/ProductivityPanel"
import { FeedbackPanel } from "./panels/FeedbackPanel"
import { TraceExplorer, TraceHistoryDialog, TraceTriggerScopeToggle } from "./TraceHistoryDialog"
import { CommitDetailsDialog } from "./CommitDetailsDialog"
import { marketApi, type MarketItem } from "../../api/market"
import {
  buildMarketSkillKeySet,
  buildMarketSkillMap,
  getMarketSkillItem,
  normalizeMarketSkillKey
} from "./skill-market"
import {
  buildUploaderIdCandidates,
  normalizeUploaderProfileField,
  parseUploaderIdentity,
  type UploaderProfileInfo
} from "../../lib/skill-data-service"

// ─────────────────────────────────────────────────────────
// Time control bar
// ─────────────────────────────────────────────────────────

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "custom", label: "自定义" }
]

type SkillUploaderExportInfo = {
  sapId: string
  userName: string
  orgName: string
}

type SkillUploaderProfile = UploaderProfileInfo & {
  upperOrgLv0?: string
  upperOrgLv1?: string
}

function formatRangeLabel(from: string, to: string, granularity: Granularity): string {
  const f = new Date(from)
  const pad = (n: number): string => String(n).padStart(2, "0")
  const fmtDate = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  if (granularity === "day") return fmtDate(f)
  if (granularity === "custom") return `${fmtDate(f)} ~ ${fmtDate(new Date(to))}`
  if (granularity === "week") {
    const t = new Date(to)
    return `${fmtDate(f)} ~ ${fmtDate(t)}`
  }
  // month
  return `${f.getFullYear()}-${pad(f.getMonth() + 1)}`
}

function resolveSkillUploaderExportInfo(
  item: MarketItem | null,
  uploaderProfiles: Record<string, SkillUploaderProfile>
): SkillUploaderExportInfo {
  if (!item?.user_id) return { sapId: "", userName: "", orgName: "" }

  const parsed = parseUploaderIdentity(item.user_id)
  const profileCandidates = [
    item.user_id.trim(),
    parsed?.sapId,
    ...buildUploaderIdCandidates(parsed?.sapId || item.user_id)
  ].filter((value): value is string => Boolean(value))
  const profile = profileCandidates.map((candidate) => uploaderProfiles[candidate]).find(Boolean)

  return {
    sapId:
      normalizeUploaderProfileField(profile?.sapId) ||
      normalizeUploaderProfileField(parsed?.sapId) ||
      item.user_id.trim(),
    userName:
      normalizeUploaderProfileField(profile?.userName) ||
      normalizeUploaderProfileField(parsed?.userName),
    orgName:
      formatTopUserOrgName(
        normalizeUploaderProfileField(profile?.orgName),
        normalizeUploaderProfileField(profile?.upperOrgLv1),
        normalizeUploaderProfileField(profile?.upperOrgLv0)
      ) || normalizeUploaderProfileField(parsed?.orgName)
  }
}

function TimeControlBar({
  granularity,
  range,
  onGranularityChange,
  onNavigate,
  onCustomRange,
  onRefresh,
  onExport,
  loading,
  exporting
}: {
  granularity: Granularity
  range: { from: string; to: string }
  onGranularityChange: (g: Granularity) => void
  onNavigate: (dir: "prev" | "next") => void
  onCustomRange: (from: string, to: string) => void
  onRefresh: () => void
  onExport: () => void
  loading: boolean
  exporting: boolean
}) {
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")

  const handleCustomConfirm = (): void => {
    if (customFrom && customTo) {
      onCustomRange(
        new Date(customFrom + "T00:00:00").toISOString(),
        new Date(customTo + "T23:59:59.999").toISOString()
      )
      setShowDatePicker(false)
    }
  }

  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm">
      {/* Granularity tabs */}
      <div className="flex items-center rounded-lg border border-border overflow-hidden">
        {GRANULARITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              granularity === opt.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => {
              if (opt.value === "custom") {
                setShowDatePicker(true)
                onGranularityChange("custom")
              } else {
                setShowDatePicker(false)
                onGranularityChange(opt.value)
              }
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Navigation arrows (not for custom) */}
      {granularity !== "custom" && (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => onNavigate("prev")}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs text-foreground font-medium min-w-[140px] text-center">
            {formatRangeLabel(range.from, range.to, granularity)}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={() => onNavigate("next")}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Custom date picker */}
      {granularity === "custom" && showDatePicker && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
          />
          <span className="text-xs text-muted-foreground">~</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
          />
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleCustomConfirm}>
            确认
          </Button>
        </div>
      )}

      {granularity === "custom" && !showDatePicker && (
        <span className="text-xs text-foreground font-medium">
          {formatRangeLabel(range.from, range.to, granularity)}
          <button className="ml-2 text-primary underline" onClick={() => setShowDatePicker(true)}>
            修改
          </button>
        </span>
      )}

      {/* Spacer + Export + Refresh */}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs"
        onClick={onExport}
        disabled={exporting || loading}
      >
        {exporting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
        导出Excel
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        刷新
      </Button>
    </div>
  )
}

function OrgFilterBar({
  value,
  options,
  loading,
  onChange
}: {
  value: string[]
  options: string[]
  loading: boolean
  onChange: (orgList: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selectedSet = new Set(value)

  const toggleOrg = (org: string): void => {
    if (selectedSet.has(org)) {
      onChange(value.filter((item) => item !== org))
    } else {
      onChange([...value, org])
    }
  }

  const triggerLabel =
    value.length === 0
      ? "全部"
      : value.length === 1
        ? value[0]
        : `已选 ${value.length} 个室`

  return (
    <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border bg-background/60">
      <Building2 className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">室筛选</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-[240px] justify-between gap-1 text-xs font-normal"
            disabled={loading && options.length === 0}
          >
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {triggerLabel}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-1">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60"
            onClick={() => onChange([])}
          >
            <span className={value.length === 0 ? "font-medium text-foreground" : "text-muted-foreground"}>
              全部
            </span>
            {value.length === 0 && <Check className="size-3.5 text-primary" />}
          </button>
          <div className="my-1 h-px bg-border" />
          <ScrollArea className="max-h-64">
            <div className="pr-1">
              {options.length === 0 ? (
                <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  暂无可选室
                </div>
              ) : (
                options.map((org) => {
                  const checked = selectedSet.has(org)
                  return (
                    <button
                      key={org}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                      onClick={() => toggleOrg(org)}
                    >
                      <span className={cn("truncate", checked && "font-medium text-foreground")}>
                        {org}
                      </span>
                      {checked && <Check className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onChange([])}
        >
          <X className="size-3.5" />
          清除
        </Button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Main Dashboard View
// ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function formatPercent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toFixed(2)}%`
}

const EMPTY_SKILL_DETAIL: DashboardSkillDetail = {
  stats: {
    generatedLines: 0,
    deletedLines: 0,
    effectiveGeneratedLines: 0,
    measuredGeneratedLines: 0,
    unmeasuredGeneratedLines: 0,
    inclusiveEffectiveGeneratedLines: 0,
    adoptedLines: 0,
    pushedMeasuredGeneratedLines: 0,
    pushedEffectiveGeneratedLines: 0,
    pushedAdoptedLines: 0,
    pushedCommitCount: 0,
    measuredAdoptionRate: null,
    inclusiveAdoptionRate: null,
    pushedAdoptionRate: null,
    adoptionRate: null
  },
  traces: [],
  tracePage: 1,
  tracePageSize: 10,
  totalTraces: 0
}

const USER_LIST_PAGE_SIZE = 20
const USER_LIST_EXPORT_PAGE_SIZE = 100
const USER_LIST_EXPORT_MAX_PAGES = 100
const USER_TRACE_PAGE_SIZE = 10
const SKILL_TRACE_PAGE_SIZE = 10

type DashboardSubPage =
  | { kind: "main" }
  | { kind: "user-list" }
  | { kind: "user-detail"; sapId: string; backTo: "main" | "user-list" }

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(Math.round(tokens))
}

function formatDateTime(iso?: string): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString("zh-CN")
}

async function fetchAllActiveUsersForExport(range: TimeRange): Promise<DashboardUserListItem[]> {
  const users: DashboardUserListItem[] = []
  let afterKey: Record<string, string | number> | undefined

  for (let page = 0; page < USER_LIST_EXPORT_MAX_PAGES; page++) {
    const result = await window.api.dashboard.userList(range, {
      pageSize: USER_LIST_EXPORT_PAGE_SIZE,
      afterKey: afterKey ?? null,
      keyword: null
    })

    if (!result.success) {
      throw new Error(result.error ?? "获取活跃用户列表失败")
    }

    const data = result.data
    if (!data) break
    users.push(...data.items)

    if (!data.nextAfterKey) break
    afterKey = data.nextAfterKey
  }

  return users
}

function outcomeLabel(outcome: string): string {
  if (outcome === "success") return "成功"
  if (outcome === "error") return "错误"
  if (outcome === "cancelled") return "取消"
  return outcome || "未知"
}

function UserMetricCard({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold leading-tight text-foreground">{value}</div>
      {sub ? <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

function UserListPage({
  data,
  loading,
  error,
  canGoPrevious,
  canGoNext,
  onBack,
  onRefresh,
  onPrevious,
  onNext,
  searchValue,
  searchKeyword,
  departmentValue,
  departmentFilter,
  onSearchValueChange,
  onDepartmentValueChange,
  onSearch,
  onClearSearch,
  onClearDepartment,
  onUserClick
}: {
  data: DashboardUserListData | null
  loading: boolean
  error: string | null
  canGoPrevious: boolean
  canGoNext: boolean
  onBack: () => void
  onRefresh: () => void
  onPrevious: () => void
  onNext: () => void
  searchValue: string
  searchKeyword: string
  departmentValue: string
  departmentFilter: string
  onSearchValueChange: (value: string) => void
  onDepartmentValueChange: (value: string) => void
  onSearch: () => void
  onClearSearch: () => void
  onClearDepartment: () => void
  onUserClick: (user: DashboardUserListItem) => void
}): React.JSX.Element {
  const hasSearchKeyword = searchKeyword.trim().length > 0
  const hasDepartmentFilter = departmentFilter.trim().length > 0

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack}>
            <ChevronLeft className="size-4" />
            返回面板
          </Button>
          <div>
            <h2 className="text-sm font-semibold text-foreground">活跃用户列表</h2>
            <p className="text-xs text-muted-foreground">
              共 {formatNumber(data?.totalActiveUsers ?? 0)} 位活跃用户
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          刷新
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Users className="size-4" />
            用户明细
          </div>
          <form
            className="flex flex-1 items-center justify-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              onSearch()
            }}
          >
            <div className="relative w-full max-w-[220px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={departmentValue}
                onChange={(event) => onDepartmentValueChange(event.target.value)}
                aria-label="按 Lv1 或 Lv0 部门筛选"
                placeholder="部门查询"
                className="h-8 pl-8 pr-8 text-xs"
              />
              {departmentValue && (
                <button
                  type="button"
                  onClick={onClearDepartment}
                  className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="清空部门筛选"
                  title="清空"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <div className="relative w-full max-w-[280px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchValue}
                onChange={(event) => onSearchValueChange(event.target.value)}
                aria-label="按用户名或 ystId 查询"
                placeholder="用户查询"
                className="h-8 pl-8 pr-8 text-xs"
              />
              {searchValue && (
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="清空用户查询"
                  title="清空"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={loading}>
              查询
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPrevious}
              disabled={!canGoPrevious || loading}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={onNext}
              disabled={!canGoNext || loading}
            >
              下一页
              <ChevronRight className="size-3.5" />
            </Button>
          </form>
        </div>

        {loading && !data ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-64 items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">用户</th>
                  <th className="px-3 py-2 text-left font-medium">部门</th>
                  <th className="px-3 py-2 text-right font-medium">调用次数</th>
                  <th className="px-3 py-2 text-right font-medium">工具调用</th>
                  <th className="px-3 py-2 text-right font-medium">Token</th>
                  <th className="px-3 py-2 text-left font-medium">最近活跃</th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((user) => (
                  <tr
                    key={user.sapId}
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
                    onClick={() => onUserClick(user)}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">
                        {user.userName || user.sapId}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {user.sapId}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {user.upperOrgLv1 && user.upperOrgLv0
                        ? `${user.upperOrgLv1}/${user.upperOrgLv0}`
                        : user.orgName || "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{formatNumber(user.count)}</td>
                    <td className="px-3 py-2 text-right">{formatNumber(user.totalToolCalls)}</td>
                    <td className="px-3 py-2 text-right">
                      {formatCompactTokens(user.totalTokens)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(user.lastActiveAt)}
                    </td>
                  </tr>
                ))}
                {(data?.items ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                      {hasSearchKeyword ? "未找到匹配用户" : "当前时间范围内暂无活跃用户"}
                      {hasDepartmentFilter ? `（部门：${departmentFilter}）` : ""}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function UserDetailPage({
  data,
  loading,
  error,
  tracePage,
  traceTriggerScope,
  onBack,
  onTracePrevious,
  onTraceNext,
  onTraceTriggerScopeChange
}: {
  data: DashboardUserDetail | null
  loading: boolean
  error: string | null
  tracePage: number
  traceTriggerScope: DashboardTraceTriggerScope
  onBack: () => void
  onTracePrevious: () => void
  onTraceNext: () => void
  onTraceTriggerScopeChange: (scope: DashboardTraceTriggerScope) => void
}): React.JSX.Element {
  const tracePageSize = data?.tracePageSize ?? USER_TRACE_PAGE_SIZE
  const totalTraces = data?.totalTraces ?? data?.totalCalls ?? 0
  const canTracePrevious = tracePage > 1 && !loading
  const canTraceNext = Boolean(data) && tracePage * tracePageSize < totalTraces && !loading
  const traceTitle = `Trace 记录（第 ${tracePage} 页）`

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack}>
          <ChevronLeft className="size-4" />
          返回
        </Button>
        <div>
          <h2 className="text-sm font-semibold text-foreground">用户 Trace 分析</h2>
          <p className="text-xs text-muted-foreground">
            {data ? `${data.userName || data.sapId} · ${data.sapId}` : "加载用户信息中"}
          </p>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : data ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-violet-500">
                <User className="size-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">
                  {data.userName || data.sapId}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {data.sapId}
                  {data.ystId ? ` · ${data.ystId}` : ""}
                  {data.upperOrgLv1 || data.upperOrgLv0 || data.orgName
                    ? ` · ${data.upperOrgLv1 && data.upperOrgLv0 ? `${data.upperOrgLv1}/${data.upperOrgLv0}` : data.orgName}`
                    : ""}
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-5 gap-3">
              <UserMetricCard label="调用次数" value={formatNumber(data.totalCalls)} />
              <UserMetricCard label="平均耗时" value={formatDuration(data.avgDurationMs)} />
              <UserMetricCard label="工具调用" value={formatNumber(data.totalToolCalls)} />
              <UserMetricCard
                label="输入 Token"
                value={formatCompactTokens(data.totalInputTokens)}
              />
              <UserMetricCard
                label="输出 Token"
                value={formatCompactTokens(data.totalOutputTokens)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-xs font-medium text-muted-foreground">常用 Skill</h3>
              <div className="space-y-2">
                {data.bySkill.map((item) => (
                  <div key={item.skill} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-foreground">{item.skill}</span>
                    <span className="font-medium">{formatNumber(item.count)}</span>
                  </div>
                ))}
                {data.bySkill.length === 0 && (
                  <div className="text-xs text-muted-foreground">暂无数据</div>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-xs font-medium text-muted-foreground">常用模型</h3>
              <div className="space-y-2">
                {data.byModel.map((item) => (
                  <div key={item.model} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-foreground">{item.model}</span>
                    <span className="font-medium">{formatNumber(item.count)}</span>
                  </div>
                ))}
                {data.byModel.length === 0 && (
                  <div className="text-xs text-muted-foreground">暂无数据</div>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-xs font-medium text-muted-foreground">执行结果</h3>
              <div className="space-y-2">
                {data.byOutcome.map((item) => (
                  <div
                    key={item.outcome}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="truncate text-foreground">{outcomeLabel(item.outcome)}</span>
                    <span className="font-medium">{formatNumber(item.count)}</span>
                  </div>
                ))}
                {data.byOutcome.length === 0 && (
                  <div className="text-xs text-muted-foreground">暂无数据</div>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <TraceExplorer
              traces={data.traces}
              loading={loading}
              title={traceTitle}
              subtitle={`共 ${formatNumber(totalTraces)} 条，选择记录查看对话还原与执行树`}
              headerRight={
                <div className="flex items-center gap-2">
                  <TraceTriggerScopeToggle
                    value={traceTriggerScope}
                    onChange={onTraceTriggerScopeChange}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onTracePrevious}
                    disabled={!canTracePrevious}
                  >
                    上一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={onTraceNext}
                    disabled={!canTraceNext}
                  >
                    下一页
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              }
              emptyText="当前时间范围内没有该用户的 trace"
              showCodeStats={false}
              className="h-[560px]"
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function DashboardView(): React.JSX.Element {
  const {
    granularity,
    range,
    selectedOrgLv1List,
    orgOptions,
    loading,
    error,
    overview,
    modelStats,
    userStats,
    productivity,
    feedback,
    changeGranularity,
    navigate,
    setCustomRange,
    refresh,
    setOrgFilter,
    drillDownUserOrg,
    resetUserOrgDrilldown
  } = useDashboard()

  const [exporting, setExporting] = useState(false)
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<DashboardSkillDetail | null>(null)
  const [skillTracesLoading, setSkillTracesLoading] = useState(false)
  const [skillTracesError, setSkillTracesError] = useState<string | null>(null)
  const [skillTracePage, setSkillTracePage] = useState(1)
  const [skillTraceViewMode, setSkillTraceViewMode] = useState<DashboardTraceViewMode>("thread")
  const [skillTraceTriggerScope, setSkillTraceTriggerScope] = useState<DashboardTraceTriggerScope>("active")
  const [skillTraceExporting, setSkillTraceExporting] = useState(false)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitScopeLabel, setCommitScopeLabel] = useState("当前范围")
  const [commitDetailsRange, setCommitDetailsRange] = useState<TimeRange | null>(null)
  const [commitDetails, setCommitDetails] = useState<DashboardCommitDetailsData | null>(null)
  const [commitDetailsLoading, setCommitDetailsLoading] = useState(false)
  const [commitDetailsError, setCommitDetailsError] = useState<string | null>(null)
  const [commitDepartmentValue, setCommitDepartmentValue] = useState("")
  const [commitDepartmentFilter, setCommitDepartmentFilter] = useState("")
  const [subPage, setSubPage] = useState<DashboardSubPage>({ kind: "main" })
  const [userList, setUserList] = useState<DashboardUserListData | null>(null)
  const [userListLoading, setUserListLoading] = useState(false)
  const [userListError, setUserListError] = useState<string | null>(null)
  const [userListSearchValue, setUserListSearchValue] = useState("")
  const [userListSearchKeyword, setUserListSearchKeyword] = useState("")
  const [userListDepartmentValue, setUserListDepartmentValue] = useState("")
  const [userListDepartmentFilter, setUserListDepartmentFilter] = useState("")
  const userListScopeRef = useRef("")
  const [userListAfterKey, setUserListAfterKey] = useState<
    Record<string, string | number> | undefined
  >()
  const [userListBackStack, setUserListBackStack] = useState<
    Array<Record<string, string | number> | undefined>
  >([])
  const [userDetail, setUserDetail] = useState<DashboardUserDetail | null>(null)
  const [userDetailLoading, setUserDetailLoading] = useState(false)
  const [userDetailError, setUserDetailError] = useState<string | null>(null)
  const [userDetailTracePage, setUserDetailTracePage] = useState(1)
  const [userDetailTraceTriggerScope, setUserDetailTraceTriggerScope] =
    useState<DashboardTraceTriggerScope>("active")
  const [marketSkillKeys, setMarketSkillKeys] = useState<Set<string>>(new Set())
  const [pluginSkillKeys, setPluginSkillKeys] = useState<Set<string>>(new Set())
  const [marketSkillMap, setMarketSkillMap] = useState<Map<string, MarketItem>>(new Map())
  const [skillUploaderProfiles, setSkillUploaderProfiles] = useState<
    Record<string, SkillUploaderProfile>
  >({})

  useEffect(() => {
    let cancelled = false

    async function loadUploaderProfiles(items: MarketItem[]): Promise<void> {
      const uploaderIds = Array.from(
        new Set(
          items
            .map((item) => {
              const parsed = parseUploaderIdentity(item.user_id)
              return parsed?.sapId || item.user_id?.trim() || ""
            })
            .filter(Boolean)
            .flatMap((id) => buildUploaderIdCandidates(id))
        )
      )

      if (uploaderIds.length === 0) {
        if (!cancelled) setSkillUploaderProfiles({})
        return
      }

      if (typeof window.api?.dashboard?.userProfiles !== "function") {
        if (!cancelled) {
          setSkillUploaderProfiles(
            Object.fromEntries(
              uploaderIds.map((sapId) => [sapId, { sapId, userName: "", orgName: "" }])
            )
          )
        }
        return
      }

      try {
        const response = await window.api.dashboard.userProfiles(uploaderIds)
        if (!response.success || !response.data) {
          throw new Error(response.error || "获取上传用户信息失败")
        }

        const buckets =
          (
            response.data as {
              aggregations?: {
                by_sap?: {
                  buckets?: Array<{
                    key?: string
                    user_name?: { buckets?: Array<{ key?: string }> }
                    org_name?: { buckets?: Array<{ key?: string }> }
                    latest_user_info?: {
                      hits?: {
                        hits?: Array<{
                          _source?: {
                            userName?: string
                            orgName?: string
                            upperOrgLv0?: string
                            upperOrgLv1?: string
                          }
                        }>
                      }
                    }
                  }>
                }
              }
            }
          ).aggregations?.by_sap?.buckets ?? []

        const profileBySapId: Record<string, SkillUploaderProfile> = {}
        for (const bucket of buckets) {
          const sapId = bucket.key?.trim()
          if (!sapId) continue
          const latestUserInfo = bucket.latest_user_info?.hits?.hits?.[0]?._source
          profileBySapId[sapId] = {
            sapId,
            userName: latestUserInfo?.userName ?? bucket.user_name?.buckets?.[0]?.key ?? "",
            orgName: latestUserInfo?.orgName ?? bucket.org_name?.buckets?.[0]?.key ?? "",
            upperOrgLv0: latestUserInfo?.upperOrgLv0 ?? "",
            upperOrgLv1: latestUserInfo?.upperOrgLv1 ?? ""
          }
        }

        const profileEntries = Object.entries(profileBySapId)
        const nextMap: Record<string, SkillUploaderProfile> = {}
        for (const rawId of uploaderIds) {
          nextMap[rawId] = profileBySapId[rawId] ||
            profileEntries.find(([sapId]) => sapId.includes(rawId))?.[1] || {
              sapId: rawId,
              userName: "",
              orgName: ""
            }
        }

        if (!cancelled) setSkillUploaderProfiles(nextMap)
      } catch (error) {
        console.warn("[Dashboard] Failed to load marketplace skill uploader profiles:", error)
        if (!cancelled) {
          setSkillUploaderProfiles(
            Object.fromEntries(
              uploaderIds.map((sapId) => [sapId, { sapId, userName: "", orgName: "" }])
            )
          )
        }
      }
    }

    async function loadMarketSkills(): Promise<void> {
      try {
        const result = await marketApi.getSkills()
        if (cancelled) return
        if (result.success && result.data) {
          setMarketSkillKeys(buildMarketSkillKeySet(result.data))
          setMarketSkillMap(buildMarketSkillMap(result.data))
          void loadUploaderProfiles(result.data)
          return
        }
        console.warn("[Dashboard] Failed to load marketplace skills:", result.error)
      } catch (error) {
        if (!cancelled) {
          console.warn("[Dashboard] Failed to load marketplace skills:", error)
        }
      }
    }

    void loadMarketSkills()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadPluginSkills(): Promise<void> {
      if (typeof window.api?.skills?.listPlugins !== "function") return

      try {
        const pluginSkills = await window.api.skills.listPlugins()
        if (cancelled) return

        const keys = new Set<string>()
        const mockPluginSkills = import.meta.env.DEV
          ? [
              {
                name: "plugin-release-note",
                relativePath: "plugin-release-note",
                id: "mock-plugin/plugin-release-note"
              }
            ]
          : []
        for (const skill of [...pluginSkills, ...mockPluginSkills]) {
          const candidates = [skill.name, skill.relativePath, skill.id]
          for (const candidate of candidates) {
            const key = normalizeMarketSkillKey(candidate?.replace(/^plugin:[^/]+\//, ""))
            if (key) keys.add(key)
          }
        }
        setPluginSkillKeys(keys)
      } catch (error) {
        if (!cancelled) {
          console.warn("[Dashboard] Failed to load plugin skills:", error)
          setPluginSkillKeys(new Set())
        }
      }
    }

    void loadPluginSkills()

    return () => {
      cancelled = true
    }
  }, [])

  const handleSkillClick = useCallback(
    async (
      skill: string,
      tracePage = 1,
      traceViewMode = skillTraceViewMode,
      triggerScope = skillTraceTriggerScope
    ) => {
      setSelectedSkill(skill)
      setSkillDialogOpen(true)
      setSkillTracePage(tracePage)
      setSkillTraceViewMode(traceViewMode)
      setSkillTraceTriggerScope(triggerScope)
      if (tracePage === 1) setSkillDetail(null)
      setSkillTracesError(null)
      setSkillTracesLoading(true)
      try {
        const result = await window.api.dashboard.skillDetail(skill, range, {
          page: tracePage,
          pageSize: SKILL_TRACE_PAGE_SIZE,
          mode: traceViewMode,
          triggerScope
        })
        if (!result.success) throw new Error(result.error ?? "获取 Skill 详情失败")
        setSkillDetail(result.data ?? EMPTY_SKILL_DETAIL)
      } catch (e) {
        setSkillTracesError(e instanceof Error ? e.message : String(e))
      } finally {
        setSkillTracesLoading(false)
      }
    },
    [range, skillTraceViewMode, skillTraceTriggerScope]
  )

  const handleSkillTracePrevious = useCallback(() => {
    if (!selectedSkill || skillTracePage <= 1) return
    void handleSkillClick(selectedSkill, skillTracePage - 1, skillTraceViewMode, skillTraceTriggerScope)
  }, [handleSkillClick, selectedSkill, skillTracePage, skillTraceViewMode, skillTraceTriggerScope])

  const handleSkillTraceNext = useCallback(() => {
    if (!selectedSkill || !skillDetail) return
    const pageSize = skillDetail.tracePageSize || SKILL_TRACE_PAGE_SIZE
    if (skillTracePage * pageSize >= skillDetail.totalTraces) return
    void handleSkillClick(selectedSkill, skillTracePage + 1, skillTraceViewMode, skillTraceTriggerScope)
  }, [handleSkillClick, selectedSkill, skillDetail, skillTracePage, skillTraceViewMode, skillTraceTriggerScope])

  const handleSkillTraceViewModeChange = useCallback((mode: DashboardTraceViewMode) => {
    if (!selectedSkill) {
      setSkillTraceViewMode(mode)
      return
    }
    void handleSkillClick(selectedSkill, 1, mode, skillTraceTriggerScope)
  }, [handleSkillClick, selectedSkill, skillTraceTriggerScope])

  const handleSkillTraceTriggerScopeChange = useCallback((scope: DashboardTraceTriggerScope) => {
    if (!selectedSkill) {
      setSkillTraceTriggerScope(scope)
      return
    }
    void handleSkillClick(selectedSkill, 1, skillTraceViewMode, scope)
  }, [handleSkillClick, selectedSkill, skillTraceViewMode])

  const handleSkillTraceExport = useCallback(async () => {
    if (!selectedSkill || !skillDetail || skillDetail.traces.length === 0) return
    setSkillTraceExporting(true)
    try {
      const result = await window.api.dashboard.exportSkillTraces({
        skill: selectedSkill,
        range,
        page: skillTracePage,
        pageSize: skillDetail.tracePageSize || SKILL_TRACE_PAGE_SIZE,
        totalTraces: skillDetail.totalTraces,
        traces: skillDetail.traces
      })
      if (!result.success && !result.canceled) {
        window.alert(result.error || "导出会话记录失败")
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "导出会话记录失败")
    } finally {
      setSkillTraceExporting(false)
    }
  }, [range, selectedSkill, skillDetail, skillTracePage])

  const loadUserList = useCallback(
    async (
      afterKey?: Record<string, string | number>,
      backStack: Array<Record<string, string | number> | undefined> = [],
      keyword = "",
      upperOrgLv1 = userListDepartmentFilter
    ) => {
      setUserListLoading(true)
      setUserListError(null)
      const normalizedKeyword = keyword.trim()
      const normalizedDepartment = upperOrgLv1.trim()
      try {
        const result = await window.api.dashboard.userList(range, {
          pageSize: USER_LIST_PAGE_SIZE,
          afterKey: afterKey ?? null,
          keyword: normalizedKeyword || null,
          upperOrgLv1: normalizedDepartment || null
        })
        if (!result.success) throw new Error(result.error ?? "获取用户列表失败")
        setUserList(
          result.data ?? { items: [], pageSize: USER_LIST_PAGE_SIZE, totalActiveUsers: 0 }
        )
        userListScopeRef.current = `${range.from}|${range.to}|${normalizedKeyword}|${normalizedDepartment}`
        setUserListAfterKey(afterKey)
        setUserListBackStack(backStack)
      } catch (e) {
        setUserListError(e instanceof Error ? e.message : String(e))
      } finally {
        setUserListLoading(false)
      }
    },
    [range, userListDepartmentFilter]
  )

  const loadUserDetail = useCallback(
    async (
      sapId: string,
      tracePage = 1,
      triggerScope: DashboardTraceTriggerScope = "active"
    ) => {
      setUserDetailLoading(true)
      setUserDetailError(null)
      try {
        const result = await window.api.dashboard.userDetail(sapId, range, {
          tracePage,
          tracePageSize: USER_TRACE_PAGE_SIZE,
          triggerScope
        })
        if (!result.success) throw new Error(result.error ?? "获取用户详情失败")
        setUserDetail(result.data ?? null)
      } catch (e) {
        setUserDetailError(e instanceof Error ? e.message : String(e))
      } finally {
        setUserDetailLoading(false)
      }
    },
    [range]
  )

  const openUserList = useCallback(() => {
    setSubPage({ kind: "user-list" })
    setUserList(null)
    setUserListSearchValue("")
    setUserListSearchKeyword("")
    setUserListDepartmentValue("")
    setUserListDepartmentFilter("")
    setUserListAfterKey(undefined)
    setUserListBackStack([])
  }, [])

  const openUserDetail = useCallback(
    (sapId: string, backTo?: "main" | "user-list") => {
      const normalizedSapId = sapId.trim()
      if (!normalizedSapId) return
      const fallbackBackTo = subPage.kind === "user-list" ? "user-list" : "main"
      setSubPage({ kind: "user-detail", sapId: normalizedSapId, backTo: backTo ?? fallbackBackTo })
      setUserDetail(null)
      setUserDetailTracePage(1)
      setUserDetailTraceTriggerScope("active")
    },
    [subPage.kind]
  )

  const handleUserListNext = useCallback(() => {
    if (!userList?.nextAfterKey) return
    void loadUserList(
      userList.nextAfterKey,
      [...userListBackStack, userListAfterKey],
      userListSearchKeyword,
      userListDepartmentFilter
    )
  }, [
    loadUserList,
    userList?.nextAfterKey,
    userListAfterKey,
    userListBackStack,
    userListSearchKeyword,
    userListDepartmentFilter
  ])

  const handleUserListPrevious = useCallback(() => {
    if (userListBackStack.length === 0) return
    const nextStack = userListBackStack.slice(0, -1)
    const previousAfterKey = userListBackStack[userListBackStack.length - 1]
    void loadUserList(previousAfterKey, nextStack, userListSearchKeyword, userListDepartmentFilter)
  }, [loadUserList, userListBackStack, userListSearchKeyword, userListDepartmentFilter])

  const handleUserListSearch = useCallback(() => {
    const keyword = userListSearchValue.trim()
    const upperOrgLv1 = userListDepartmentValue.trim()
    setUserList(null)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
    if (keyword === userListSearchKeyword && upperOrgLv1 === userListDepartmentFilter) {
      void loadUserList(undefined, [], keyword, upperOrgLv1)
      return
    }
    setUserListSearchKeyword(keyword)
    setUserListDepartmentFilter(upperOrgLv1)
  }, [
    loadUserList,
    userListDepartmentFilter,
    userListDepartmentValue,
    userListSearchKeyword,
    userListSearchValue
  ])

  const handleUserListDepartmentClear = useCallback(() => {
    setUserListDepartmentValue("")
    setUserList(null)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
    if (!userListDepartmentFilter) {
      void loadUserList(undefined, [], userListSearchKeyword, "")
      return
    }
    setUserListDepartmentFilter("")
  }, [loadUserList, userListDepartmentFilter, userListSearchKeyword])

  const handleUserListSearchClear = useCallback(() => {
    setUserListSearchValue("")
    setUserList(null)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
    if (!userListSearchKeyword) {
      void loadUserList(undefined, [], "")
      return
    }
    setUserListSearchKeyword("")
  }, [loadUserList, userListSearchKeyword])

  const handleUserDetailBack = useCallback(() => {
    if (subPage.kind === "user-detail" && subPage.backTo === "user-list") {
      setSubPage({ kind: "user-list" })
      return
    }
    setSubPage({ kind: "main" })
  }, [subPage])

  const handleUserTracePrevious = useCallback(() => {
    setUserDetailTracePage((prev) => Math.max(1, prev - 1))
  }, [])

  const handleUserTraceNext = useCallback(() => {
    if (!userDetail) return
    setUserDetailTracePage((prev) => {
      const pageSize = userDetail.tracePageSize || USER_TRACE_PAGE_SIZE
      return prev * pageSize < userDetail.totalTraces ? prev + 1 : prev
    })
  }, [userDetail])

  const handleUserTraceTriggerScopeChange = useCallback(
    (scope: DashboardTraceTriggerScope) => {
      setUserDetailTraceTriggerScope(scope)
      setUserDetailTracePage(1)
    },
    []
  )

  const subPageDetailSapId = subPage.kind === "user-detail" ? subPage.sapId : null

  useEffect(() => {
    if (subPage.kind === "user-list") {
      const currentScope = `${range.from}|${range.to}|${userListSearchKeyword}|${userListDepartmentFilter}`
      if (!userList || userListScopeRef.current !== currentScope) {
        void loadUserList(undefined, [], userListSearchKeyword, userListDepartmentFilter)
      }
    } else if (subPageDetailSapId) {
      void loadUserDetail(subPageDetailSapId, userDetailTracePage, userDetailTraceTriggerScope)
    }
  }, [
    range,
    subPage.kind,
    subPageDetailSapId,
    loadUserList,
    loadUserDetail,
    userList,
    userListSearchKeyword,
    userListDepartmentFilter,
    userDetailTracePage,
    userDetailTraceTriggerScope
  ])

  const loadCommitDetails = useCallback(
    async (
      targetRange: TimeRange,
      scopeLabel: string,
      page = 1,
      pushedOnly = false,
      upperOrgLv1 = commitDepartmentFilter
    ) => {
      setCommitScopeLabel(scopeLabel)
      setCommitDetailsRange(targetRange)
      setCommitDialogOpen(true)
      setCommitDetails(null)
      setCommitDetailsError(null)
      setCommitDetailsLoading(true)
      const normalizedDepartment = upperOrgLv1.trim()
      try {
        const result = await window.api.dashboard.commitDetails(targetRange, {
          page,
          pageSize: 20,
          pushedOnly,
          upperOrgLv1: normalizedDepartment || null
        })
        if (!result.success) throw new Error(result.error ?? "获取 Commit 明细失败")
        setCommitDetails(result.data ?? { total: 0, page, pageSize: 20, pushedOnly, items: [] })
      } catch (e) {
        setCommitDetailsError(e instanceof Error ? e.message : String(e))
      } finally {
        setCommitDetailsLoading(false)
      }
    },
    [commitDepartmentFilter]
  )

  const reloadCommitDetails = useCallback(
    (page: number, pushedOnly: boolean, upperOrgLv1 = commitDepartmentFilter) => {
      if (!commitDetailsRange) return
      void loadCommitDetails(commitDetailsRange, commitScopeLabel, page, pushedOnly, upperOrgLv1)
    },
    [commitDepartmentFilter, commitDetailsRange, commitScopeLabel, loadCommitDetails]
  )

  const handleCommitDepartmentSearch = useCallback(() => {
    const upperOrgLv1 = commitDepartmentValue.trim()
    setCommitDepartmentFilter(upperOrgLv1)
    reloadCommitDetails(1, commitDetails?.pushedOnly ?? false, upperOrgLv1)
  }, [commitDepartmentValue, commitDetails?.pushedOnly, reloadCommitDetails])

  const handleCommitDepartmentClear = useCallback(() => {
    setCommitDepartmentValue("")
    setCommitDepartmentFilter("")
    reloadCommitDetails(1, commitDetails?.pushedOnly ?? false, "")
  }, [commitDetails?.pushedOnly, reloadCommitDetails])

  const handleCommitExternalOpen = useCallback((url: string) => {
    if (!url) return
    void window.electron.openExternal(url)
  }, [])

  const handleCommitTotalClick = useCallback(() => {
    setCommitDepartmentValue("")
    setCommitDepartmentFilter("")
    void loadCommitDetails(
      range,
      `当前范围 · ${formatRangeLabel(range.from, range.to, granularity)}`,
      1,
      false,
      ""
    )
  }, [loadCommitDetails, range, granularity])

  const handleCommitBucketClick = useCallback(
    (bucket: { from: string; to: string; label: string }) => {
      setCommitDepartmentValue("")
      setCommitDepartmentFilter("")
      void loadCommitDetails({ from: bucket.from, to: bucket.to }, `时间桶 · ${bucket.label}`, 1, false, "")
    },
    [loadCommitDetails]
  )

  const handleExport = useCallback(async () => {
    if (!overview && !modelStats && !userStats && !productivity) return
    setExporting(true)
    try {
      const sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }> = []

      // 1. Overview summary
      if (overview) {
        sheets.push({
          name: "使用概览",
          header: ["指标", "值"],
          rows: [
            ["调用总次数", overview.totalCalls],
            ["活跃用户数", overview.activeUsers],
            ["平均耗时", formatDuration(overview.avgDurationMs)],
            ["输入 Token", overview.inputTokens],
            ["输出 Token", overview.outputTokens],
            ["代码生成行数", overview.codeGeneratedLines],
            ["代码已测量原始生成行数", overview.codeMeasuredGeneratedLines],
            ["代码已测量有效生成行数", overview.codeEffectiveGeneratedLines],
            ["代码未提交生成行数", overview.codeUnmeasuredGeneratedLines],
            ["代码含未提交分母行数", overview.codeInclusiveEffectiveGeneratedLines],
            ["代码删除行数", overview.codeDeletedLines],
            ["代码采纳行数", overview.codeAdoptedLines],
            ["代码采纳率（含未提交）", formatPercent(overview.codeInclusiveAdoptionRate)],
            ["代码采纳率（已测量）", formatPercent(overview.codeMeasuredAdoptionRate)],
            ["代码已 Push 原始生成行数", overview.codePushedMeasuredGeneratedLines],
            ["代码已 Push 有效生成行数", overview.codePushedEffectiveGeneratedLines],
            ["代码已 Push 采纳行数", overview.codePushedAdoptedLines],
            ["代码已 Push Commit 数", overview.codePushedCommitCount],
            ["代码采纳率（已 Push）", formatPercent(overview.codePushedAdoptionRate)],
            ["Skill 种类数", overview.totalSkills],
            ["Skill 调用次数", overview.totalSkillCalls],
            ["Tool 种类数", overview.totalTools],
            ["Tool 调用次数", overview.totalToolCalls]
          ]
        })

        // Trend
        if (overview.trend.length > 0) {
          sheets.push({
            name: "调用量趋势",
            header: ["时间", "调用次数", "活跃用户"],
            rows: overview.trend.map((t) => [t.time, t.count, t.users])
          })
        }

        // Skill ranking
        const exportSkills = overview.bySkillAll.length > 0 ? overview.bySkillAll : overview.bySkill
        if (exportSkills.length > 0) {
          sheets.push({
            name: "Skill使用排行",
            header: [
              "排名",
              "Skill",
              "调用次数",
              "应用市场是否存在",
              "Skill中文名称",
              "上传用户ID",
              "上传用户名称",
              "上传用户完整机构",
              "是否精品",
              "是否认证"
            ],
            rows: [
              ["Skill 种类数", overview.totalSkills, "", "", "", "", "", "", "", ""],
              ["Skill 调用次数", overview.totalSkillCalls, "", "", "", "", "", "", "", ""],
              ["", "", "", "", "", "", "", "", "", ""],
              ...exportSkills.map((s, i) => {
                const marketItem = getMarketSkillItem(marketSkillMap, s.skill)
                const uploaderInfo = resolveSkillUploaderExportInfo(
                  marketItem,
                  skillUploaderProfiles
                )
                const existsInMarket = Boolean(marketItem)
                return [
                  i + 1,
                  s.skill,
                  s.count,
                  existsInMarket ? "是" : "否",
                  existsInMarket ? marketItem?.chinese_name?.trim() || "" : "",
                  uploaderInfo.sapId,
                  uploaderInfo.userName,
                  uploaderInfo.orgName,
                  existsInMarket ? (marketItem?.featured === "精品" ? "是" : "否") : "",
                  existsInMarket ? (marketItem?.tag === "认证" ? "是" : "否") : ""
                ]
              })
            ]
          })
        }

        // Tool ranking (filtered)
        const exportFilteredTools =
          overview.byToolFilteredAll.length > 0 ? overview.byToolFilteredAll : overview.byTool
        if (exportFilteredTools.length > 0) {
          sheets.push({
            name: "Tool使用排行(已过滤)",
            header: ["排名", "Tool", "调用次数"],
            rows: [
              ["Tool 种类数", overview.totalTools, ""],
              ["Tool 调用次数", overview.totalToolCalls, ""],
              ["", "", ""],
              ...exportFilteredTools.map((t, i) => [i + 1, t.tool, t.count])
            ]
          })
        }

        // Tool ranking (all)
        const exportAllTools =
          overview.byToolAllFull.length > 0 ? overview.byToolAllFull : overview.byToolAll
        if (exportAllTools.length > 0) {
          sheets.push({
            name: "Tool使用排行(全部)",
            header: ["排名", "Tool", "调用次数"],
            rows: [
              ["Tool 种类数", overview.totalTools, ""],
              ["Tool 调用次数", overview.totalToolCalls, ""],
              ["", "", ""],
              ...exportAllTools.map((t, i) => [i + 1, t.tool, t.count])
            ]
          })
        }
      }

      // 2. Model stats
      if (modelStats) {
        if (modelStats.byModel.length > 0) {
          sheets.push({
            name: "模型使用统计",
            header: ["模型", "调用次数", "输入Token", "输出Token", "总Token"],
            rows: modelStats.byModel.map((m) => [
              m.model,
              m.count,
              m.inputTokens,
              m.outputTokens,
              m.inputTokens + m.outputTokens
            ])
          })
        }
        if (modelStats.byTier.length > 0) {
          sheets.push({
            name: "分流统计",
            header: ["Tier", "调用次数"],
            rows: modelStats.byTier.map((t) => [t.tier, t.count])
          })
        }
        if (modelStats.byLayer.length > 0) {
          sheets.push({
            name: "路由决策层",
            header: ["决策层", "命中次数"],
            rows: modelStats.byLayer.map((l) => [l.layer, l.count])
          })
        }
      }

      // 3. User stats
      if (userStats) {
        if (userStats.topUsers.length > 0) {
          sheets.push({
            name: "用户使用排行",
            header: ["排名", "SAP ID", "用户名", "部门", "调用次数"],
            rows: userStats.topUsers.map((u, i) => [
              i + 1,
              u.sapId,
              u.userName,
              u.orgName || "—",
              u.count
            ])
          })
        }
        if (userStats.byOrg.length > 0) {
          const drilledOrg = selectedOrgLv1List.length === 1 ? selectedOrgLv1List[0] : null
          sheets.push({
            name: drilledOrg ? `${drilledOrg}下级部门分布` : "一级部门分布",
            header: ["部门", "调用次数"],
            rows: userStats.byOrg.map((o) => [o.org, o.count])
          })
        }
        if (userStats.byVersion.length > 0) {
          sheets.push({
            name: "版本分布",
            header: ["版本", "调用次数"],
            rows: userStats.byVersion.map((v) => [v.version, v.count])
          })
        }
      }

      // 4. Productivity
      if (productivity) {
        sheets.push({
          name: "生产力概览",
          header: ["指标", "值"],
          rows: [
            ["Commit 总数", productivity.totalCommits],
            ["新增行数(Agent生成)", productivity.totalInsertions],
            ["删除行数(Agent生成)", productivity.totalDeletions],
            ["文件变更数", productivity.totalFilesChanged],
            ["活跃用户数", productivity.activeUsers],
            ["人均 Commit", Number(productivity.avgCommitsPerUser.toFixed(1))]
          ]
        })
        if (productivity.commitTrend.length > 0) {
          sheets.push({
            name: "Commit趋势",
            header: ["时间", "Commit数"],
            rows: productivity.commitTrend.map((c) => [c.time, c.count])
          })
        }
      }

      const activeUsers = await fetchAllActiveUsersForExport(range)
      sheets.push({
        name: "活跃用户列表",
        header: [
          "排名",
          "SAP ID",
          "YST ID",
          "用户名",
          "部门",
          "一级部门",
          "下级部门",
          "调用次数",
          "工具调用",
          "输入Token",
          "输出Token",
          "总Token",
          "平均耗时",
          "最近活跃"
        ],
        rows: activeUsers.map((user, index) => [
          index + 1,
          user.sapId,
          user.ystId || "",
          user.userName || "",
          user.upperOrgLv1 && user.upperOrgLv0
            ? `${user.upperOrgLv1}/${user.upperOrgLv0}`
            : user.orgName || "",
          user.upperOrgLv1 || "",
          user.upperOrgLv0 || "",
          user.count,
          user.totalToolCalls,
          user.totalInputTokens,
          user.totalOutputTokens,
          user.totalTokens,
          formatDuration(user.avgDurationMs),
          formatDateTime(user.lastActiveAt)
        ])
      })

      if (sheets.length === 0) return

      const result = await window.api.dashboard.exportExcel(sheets)
      if (result.success) {
        console.log("[Dashboard] Exported to:", result.filePath)
      } else if (!result.canceled && result.error) {
        console.error("[Dashboard] Export failed:", result.error)
      }
    } finally {
      setExporting(false)
    }
  }, [
    overview,
    modelStats,
    userStats,
    productivity,
    range,
    selectedOrgLv1List,
    marketSkillMap,
    skillUploaderProfiles
  ])

  return (
    <div className="flex flex-col h-full">
      <TimeControlBar
        granularity={granularity}
        range={range}
        onGranularityChange={changeGranularity}
        onNavigate={navigate}
        onCustomRange={setCustomRange}
        onRefresh={refresh}
        onExport={handleExport}
        loading={loading}
        exporting={exporting}
      />

      {subPage.kind === "main" && (
        <OrgFilterBar
          value={selectedOrgLv1List}
          options={orgOptions}
          loading={loading}
          onChange={setOrgFilter}
        />
      )}

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {subPage.kind === "user-list" ? (
        <ScrollArea className="flex-1">
          <UserListPage
            data={userList}
            loading={userListLoading}
            error={userListError}
            canGoPrevious={userListBackStack.length > 0}
            canGoNext={Boolean(userList?.nextAfterKey)}
            onBack={() => setSubPage({ kind: "main" })}
            onRefresh={() =>
              loadUserList(
                userListAfterKey,
                userListBackStack,
                userListSearchKeyword,
                userListDepartmentFilter
              )
            }
            onPrevious={handleUserListPrevious}
            onNext={handleUserListNext}
            searchValue={userListSearchValue}
            searchKeyword={userListSearchKeyword}
            departmentValue={userListDepartmentValue}
            departmentFilter={userListDepartmentFilter}
            onSearchValueChange={setUserListSearchValue}
            onDepartmentValueChange={setUserListDepartmentValue}
            onSearch={handleUserListSearch}
            onClearSearch={handleUserListSearchClear}
            onClearDepartment={handleUserListDepartmentClear}
            onUserClick={(user) => openUserDetail(user.sapId, "user-list")}
          />
        </ScrollArea>
      ) : subPage.kind === "user-detail" ? (
        <ScrollArea className="flex-1">
          <UserDetailPage
            data={userDetail}
            loading={userDetailLoading}
            error={userDetailError}
            tracePage={userDetailTracePage}
            traceTriggerScope={userDetail?.traceTriggerScope ?? userDetailTraceTriggerScope}
            onBack={handleUserDetailBack}
            onTracePrevious={handleUserTracePrevious}
            onTraceNext={handleUserTraceNext}
            onTraceTriggerScopeChange={handleUserTraceTriggerScopeChange}
          />
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Overview */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3">使用概览</h2>
              <OverviewPanel
                data={overview}
                loading={loading}
                onSkillClick={handleSkillClick}
                onActiveUsersClick={openUserList}
                marketSkillKeys={marketSkillKeys}
                pluginSkillKeys={pluginSkillKeys}
              />
            </section>

            {/* Productivity */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3">生产力指标</h2>
              <ProductivityPanel
                data={productivity}
                loading={loading}
                onCommitTotalClick={handleCommitTotalClick}
                onCommitBucketClick={handleCommitBucketClick}
              />
            </section>

            {/* User Analysis */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3">用户分析</h2>
              <UserPanel
                data={userStats}
                loading={loading}
                onDrillDownOrg={drillDownUserOrg}
                onResetOrgDrilldown={resetUserOrgDrilldown}
                onUserClick={(sapId) => openUserDetail(sapId, "main")}
              />
            </section>

            {/* Model Analysis */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3">模型分析</h2>
              <ModelPanel data={modelStats} loading={loading} />
            </section>

            {/* Feedback */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3">点赞 / 点踩反馈</h2>
              <FeedbackPanel data={feedback} loading={loading} />
            </section>
          </div>
        </ScrollArea>
      )}
      <TraceHistoryDialog
        open={skillDialogOpen}
        onOpenChange={(open) => {
          setSkillDialogOpen(open)
          if (!open) setSkillTracePage(1)
        }}
        skill={selectedSkill}
        traces={skillDetail?.traces ?? []}
        codeStats={skillDetail?.stats ?? null}
        tracePage={skillTracePage}
        tracePageSize={skillDetail?.tracePageSize ?? SKILL_TRACE_PAGE_SIZE}
        totalTraces={skillDetail?.totalTraces ?? skillDetail?.traces.length}
        traceViewMode={skillDetail?.traceViewMode ?? skillTraceViewMode}
        traceTriggerScope={skillDetail?.traceTriggerScope ?? skillTraceTriggerScope}
        onTraceViewModeChange={handleSkillTraceViewModeChange}
        onTraceTriggerScopeChange={handleSkillTraceTriggerScopeChange}
        onTracePrevious={handleSkillTracePrevious}
        onTraceNext={handleSkillTraceNext}
        onExportPage={handleSkillTraceExport}
        exporting={skillTraceExporting}
        loading={skillTracesLoading}
        error={skillTracesError}
      />
      <CommitDetailsDialog
        open={commitDialogOpen}
        onOpenChange={setCommitDialogOpen}
        scopeLabel={commitScopeLabel}
        data={commitDetails}
        loading={commitDetailsLoading}
        error={commitDetailsError}
        onPageChange={(page) => reloadCommitDetails(page, commitDetails?.pushedOnly ?? false)}
        onPushedOnlyChange={(pushedOnly) => reloadCommitDetails(1, pushedOnly)}
        departmentValue={commitDepartmentValue}
        onDepartmentValueChange={setCommitDepartmentValue}
        onDepartmentSearch={handleCommitDepartmentSearch}
        onClearDepartment={handleCommitDepartmentClear}
        onOpenExternal={handleCommitExternalOpen}
      />
    </div>
  )
}
