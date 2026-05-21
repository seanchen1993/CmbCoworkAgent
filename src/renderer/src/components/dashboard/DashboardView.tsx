/**
 * Operations Dashboard
 *
 * Operations overview and skill evaluation dashboard.
 */
import { memo, useState, useCallback, useEffect, useMemo } from "react"
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  User,
  Users
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatRelativeTime, truncate } from "@/lib/utils"
import {
  formatTopUserOrgName,
  useDashboard,
  type DashboardCommitDetailsData,
  type DashboardSkillEvalRun,
  type DashboardSkillEvalSummary,
  type DashboardSkillDetail,
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
import { TraceExplorer, TraceHistoryDialog } from "./TraceHistoryDialog"
import { CommitDetailsDialog } from "./CommitDetailsDialog"
import { marketApi, type MarketItem } from "../../api/market"
import { buildMarketSkillKeySet, buildMarketSkillMap, getMarketSkillItem } from "./skill-market"
import {
  buildUploaderIdCandidates,
  getUploaderIdCandidates,
  normalizeUploaderProfileField,
  parseUploaderIdentity,
  type UploaderProfileInfo
} from "../../lib/skill-data-service"

type UserInfoLite = {
  sapId?: string
  ystId?: string
}

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
  const profileCandidates = getUploaderIdCandidates(item.user_id)
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

function isUploadedByCurrentUser(item: MarketItem, currentUserCandidates: Set<string>): boolean {
  if (!item.user_id || currentUserCandidates.size === 0) return false
  return getUploaderIdCandidates(item.user_id).some((candidate) => currentUserCandidates.has(candidate))
}

function getMarketSkillQueryNames(item: MarketItem): string[] {
  return [item.name, item.filename]
    .map((value) => value?.trim() || "")
    .filter(Boolean)
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
  total: 0,
  page: 1,
  pageSize: 10
}

const USER_LIST_PAGE_SIZE = 20
const SKILL_TRACE_PAGE_SIZE = 10

type DashboardSubPage =
  | { kind: "main" }
  | { kind: "user-list" }
  | { kind: "user-detail"; sapId: string; backTo: "main" | "user-list" }

type DashboardMainTab = "overview" | "skill-eval"

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(Math.round(tokens))
}

function formatSkillEvalTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return `${Math.round(value)}`
}

function formatSkillEvalPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatDateTime(iso?: string): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString("zh-CN")
}

function formatDateOnly(iso?: string): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString("zh-CN")
}

function outcomeLabel(outcome: string): string {
  if (outcome === "success") return "成功"
  if (outcome === "error") return "失败"
  if (outcome === "cancelled") return "已取消"
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
  onUserClick: (user: DashboardUserListItem) => void
}): React.JSX.Element {
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
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Users className="size-4" />
            用户明细
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onPrevious}
              disabled={!canGoPrevious || loading}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={onNext}
              disabled={!canGoNext || loading}
            >
              下一页
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
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
                      当前时间范围内暂无活跃用户
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
  onBack
}: {
  data: DashboardUserDetail | null
  loading: boolean
  error: string | null
  onBack: () => void
}): React.JSX.Element {
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
              title="最近 10 条 Trace 记录"
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

function DashboardTabBar({
  activeTab,
  onChange
}: {
  activeTab: DashboardMainTab
  onChange: (tab: DashboardMainTab) => void
}): React.JSX.Element {
  const tabs: Array<{ id: DashboardMainTab; label: string }> = [
    { id: "overview", label: "经营概览" },
    { id: "skill-eval", label: "技能评估" }
  ]

  return (
    <div className="flex items-center gap-1 border-b border-border px-6 pt-4">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === tab.id
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

const SkillEvalStatTile = memo(function SkillEvalStatTile({
  label,
  value
}: {
  label: string
  value: string | number
}): React.JSX.Element {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  )
})

function skillEvalVersionLabel(skillName: string, skillVersion?: string): string {
  return skillVersion ? `${skillName} ${skillVersion}` : `${skillName} 未标版本`
}

function skillEvalKey(skillName: string, skillVersion?: string): string {
  return `${skillName}:${skillVersion ?? ""}`
}

function skillEvalTimeValue(iso?: string): number {
  if (!iso) return 0
  const value = new Date(iso).getTime()
  return Number.isNaN(value) ? 0 : value
}

function getLatestSkillEvalKey(data: DashboardSkillEvalSummary | null): string | null {
  if (!data) return null

  if (data.skills.length > 0) {
    const latestSkill = data.skills.reduce((latest, current) =>
      skillEvalTimeValue(current.lastRunAt) > skillEvalTimeValue(latest.lastRunAt) ? current : latest
    )
    return skillEvalKey(latestSkill.skillName, latestSkill.skillVersion)
  }

  const latestRun = data.recent[0]
  return latestRun ? skillEvalKey(latestRun.skillName, latestRun.skillVersion) : null
}

function skillEvalFilterForKey(
  skillByKey: Map<string, DashboardSkillEvalSummary["skills"][number]>,
  key: string | null
): { skillName?: string; skillVersion?: string } | undefined {
  if (!key) return undefined
  const skill = skillByKey.get(key)
  if (!skill) return undefined
  return {
    skillName: skill.skillName,
    ...(skill.skillVersion ? { skillVersion: skill.skillVersion } : {})
  }
}

const SkillEvalSkillRow = memo(function SkillEvalSkillRow({
  skill,
  active,
  skillKey,
  onSelect
}: {
  skill: DashboardSkillEvalSummary["skills"][number]
  active: boolean
  skillKey: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  const handleClick = useCallback(() => {
    onSelect(skillKey)
  }, [onSelect, skillKey])

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`grid w-full grid-cols-[4px_minmax(96px,1fr)_42px_50px_48px_48px_54px] items-center gap-2 border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-muted/35 ${
        active ? "bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.22)]" : ""
      }`}
      aria-current={active ? "true" : undefined}
    >
      <span className={`h-8 rounded-full ${active ? "bg-primary" : "bg-transparent"}`} />
      <div className="min-w-0">
        <div className={`truncate font-medium ${active ? "text-foreground" : "text-foreground"}`}>
          {skill.skillName}
        </div>
        <div className={`mt-0.5 text-[11px] ${active ? "text-foreground/70" : "text-muted-foreground"}`}>
          {skill.skillVersion ?? "未标版本"} · {formatRelativeTime(skill.lastRunAt)}
        </div>
      </div>
      <div className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}>{formatNumber(skill.runs)}</div>
      <div className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
        {formatSkillEvalPercent(skill.passRate)}
      </div>
      <div className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
        {formatSkillEvalPercent(skill.averageOutcomeScore)}
      </div>
      <div className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
        {formatSkillEvalPercent(skill.averageScore)}
      </div>
      <div className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
        {formatSkillEvalTokens(skill.averageTotalTokens)}
      </div>
    </button>
  )
})

const SkillEvalRunRow = memo(function SkillEvalRunRow({
  run,
  onOpenTrace
}: {
  run: DashboardSkillEvalRun
  onOpenTrace: (run: DashboardSkillEvalRun) => void
}): React.JSX.Element {
  const warnings = useMemo(
    () => [...run.warnings, ...run.outcomeWarnings, ...run.resultWarnings].slice(0, 2),
    [run.outcomeWarnings, run.resultWarnings, run.warnings]
  )
  const checks = useMemo(
    () => [...run.checks, ...run.outcomeChecks],
    [run.checks, run.outcomeChecks]
  )
  const cacheTokens = run.cacheReadTokens + run.cacheCreationTokens
  const handleClick = useCallback(() => {
    onOpenTrace(run)
  }, [onOpenTrace, run])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/35"
    >
      <div className="flex items-start gap-3">
        {run.pass ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-nominal" />
        ) : (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-critical" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{run.skillName}</span>
            {run.skillVersion && <Badge variant="outline">{run.skillVersion}</Badge>}
            <Badge variant={run.pass ? "nominal" : "critical"}>
              {formatSkillEvalPercent(run.score)}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(run.startedAt)}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground" title={run.userMessage}>
            {truncate(run.userMessage, 140)}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>工具 {run.totalToolCalls}</span>
            <span>模型调用 {run.modelCallCount}</span>
            <span title="非缓存输入 Token">输入 {formatSkillEvalTokens(run.totalInputTokens)}</span>
            {cacheTokens > 0 && (
              <span title="缓存读取 + 缓存写入 Token">缓存输入 {formatSkillEvalTokens(cacheTokens)}</span>
            )}
            <span title="输入 + 缓存读取 + 缓存写入">
              Prompt {formatSkillEvalTokens(run.promptInputTokens)}
            </span>
            <span>输出 {formatSkillEvalTokens(run.totalOutputTokens)}</span>
            <span title="单次模型调用看到的最大输入 Token">
              峰值输入 {formatSkillEvalTokens(run.peakInputTokens)}
            </span>
            <span>错误 {run.errorCount}</span>
            <span>{formatDuration(run.durationMs)}</span>
            <span>{outcomeLabel(run.outcome)}</span>
            <span title={run.traceId}>链路 {run.traceId.slice(0, 8)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="normal-case tracking-normal">
              过程 {formatSkillEvalPercent(run.processScore)}
            </Badge>
            <Badge
              variant={run.outcomePass === false ? "warning" : "nominal"}
              className="normal-case tracking-normal"
            >
              结束 {formatSkillEvalPercent(run.outcomeScore)}
            </Badge>
            <Badge
              variant={run.resultGenerated ? (run.resultPass ? "nominal" : "warning") : "outline"}
              className="normal-case tracking-normal"
            >
              结果 {run.resultGenerated ? formatSkillEvalPercent(run.resultScore) : "待生成"}
            </Badge>
            <Badge variant="outline" className="normal-case tracking-normal">
              Token {formatSkillEvalTokens(run.totalTokens)}
            </Badge>
          </div>
          {warnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-warning">
              <AlertCircle className="size-3.5" />
              <span>{warnings.join(" · ")}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {checks.map((check) => (
              <Badge
                key={check.name}
                variant={check.ok ? "nominal" : "warning"}
                className="normal-case tracking-normal"
              >
                {check.label}
              </Badge>
            ))}
            {run.resultChecks.map((check) => (
              <Badge
                key={`result:${check.name}`}
                variant={check.ok ? "nominal" : "warning"}
                className="normal-case tracking-normal"
              >
                结果: {check.label}
              </Badge>
            ))}
          </div>
          {run.resultGenerated ? (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span>最终响应 {run.evidence.finalResponseLength} 字</span>
              <span>产物信号 {run.evidence.artifactSignals}</span>
              <span>改动文件 {run.evidence.changedFiles}</span>
              <span>验证动作 {run.evidence.validationCommands}</span>
              {run.evidence.subagentRuns > 0 && (
                <>
                  <span>子 agent {run.evidence.subagentRuns}</span>
                  <span>子结果 {run.evidence.subagentResultLength} 字</span>
                  <span>子失败 {run.evidence.subagentFailed}</span>
                </>
              )}
              <span>风险命令 {run.evidence.dangerousCommands}</span>
              <span>结果错误 {run.evidence.toolResultErrors}</span>
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-muted-foreground">
              通用结果评估会在新运行结束后异步生成
            </div>
          )}
          {run.resultIssues.length > 0 && (
            <div className="mt-2 text-[11px] text-status-critical">
              {run.resultIssues.slice(0, 3).join(" · ")}
            </div>
          )}
          {run.resultArtifacts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {run.resultArtifacts.slice(0, 6).map((artifact, index) => (
                <Badge
                  key={`${artifact.type}:${artifact.path ?? artifact.url ?? index}`}
                  variant="outline"
                  className="normal-case tracking-normal"
                  title={artifact.path ?? artifact.url ?? JSON.stringify(artifact.detail ?? {})}
                >
                  {artifact.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-[11px] text-muted-foreground" title={run.traceId}>
          详情
        </div>
      </div>
    </button>
  )
})

const SkillEvalRunSummary = memo(function SkillEvalRunSummary({
  run
}: {
  run: DashboardSkillEvalRun
}): React.JSX.Element {
  const warnings = useMemo(
    () => [...run.warnings, ...run.outcomeWarnings, ...run.resultWarnings].slice(0, 3),
    [run.outcomeWarnings, run.resultWarnings, run.warnings]
  )
  const checks = useMemo(
    () => [...run.checks, ...run.outcomeChecks],
    [run.checks, run.outcomeChecks]
  )
  const cacheTokens = run.cacheReadTokens + run.cacheCreationTokens

  return (
    <div className="border-b border-border bg-background px-5 py-4">
      <div className="flex items-start gap-3">
        {run.pass ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-nominal" />
        ) : (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-critical" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{run.skillName}</span>
            {run.skillVersion && <Badge variant="outline">{run.skillVersion}</Badge>}
            <Badge variant={run.pass ? "nominal" : "critical"}>
              {formatSkillEvalPercent(run.score)}
            </Badge>
            <span className="text-[11px] text-muted-foreground">{formatRelativeTime(run.startedAt)}</span>
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground" title={run.userMessage}>
            {truncate(run.userMessage, 180)}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>工具 {run.totalToolCalls}</span>
            <span>模型调用 {run.modelCallCount}</span>
            <span title="非缓存输入 Token">输入 {formatSkillEvalTokens(run.totalInputTokens)}</span>
            {cacheTokens > 0 && (
              <span title="缓存读取 + 缓存写入 Token">缓存输入 {formatSkillEvalTokens(cacheTokens)}</span>
            )}
            <span title="输入 + 缓存读取 + 缓存写入">Prompt {formatSkillEvalTokens(run.promptInputTokens)}</span>
            <span>输出 {formatSkillEvalTokens(run.totalOutputTokens)}</span>
            <span title="单次模型调用看到的最大输入 Token">峰值输入 {formatSkillEvalTokens(run.peakInputTokens)}</span>
            <span>错误 {run.errorCount}</span>
            <span>{formatDuration(run.durationMs)}</span>
            <span>{outcomeLabel(run.outcome)}</span>
            <span title={run.traceId}>链路 {run.traceId.slice(0, 8)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="normal-case tracking-normal">
              过程 {formatSkillEvalPercent(run.processScore)}
            </Badge>
            <Badge
              variant={run.outcomePass === false ? "warning" : "nominal"}
              className="normal-case tracking-normal"
            >
              结束 {formatSkillEvalPercent(run.outcomeScore)}
            </Badge>
            <Badge
              variant={run.resultGenerated ? (run.resultPass ? "nominal" : "warning") : "outline"}
              className="normal-case tracking-normal"
            >
              结果 {run.resultGenerated ? formatSkillEvalPercent(run.resultScore) : "待生成"}
            </Badge>
            <Badge variant="outline" className="normal-case tracking-normal">
              Token {formatSkillEvalTokens(run.totalTokens)}
            </Badge>
          </div>
          {warnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-warning">
              <AlertCircle className="size-3.5" />
              <span>{warnings.join(" · ")}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {checks.map((check) => (
              <Badge
                key={check.name}
                variant={check.ok ? "nominal" : "warning"}
                className="normal-case tracking-normal"
              >
                {check.label}
              </Badge>
            ))}
            {run.resultChecks.map((check) => (
              <Badge
                key={`result:${check.name}`}
                variant={check.ok ? "nominal" : "warning"}
                className="normal-case tracking-normal"
              >
                结果: {check.label}
              </Badge>
            ))}
          </div>
          {run.resultGenerated ? (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span>最终响应 {run.evidence.finalResponseLength} 字</span>
              <span>产物信号 {run.evidence.artifactSignals}</span>
              <span>改动文件 {run.evidence.changedFiles}</span>
              <span>验证动作 {run.evidence.validationCommands}</span>
              {run.evidence.subagentRuns > 0 && (
                <>
                  <span>子 agent {run.evidence.subagentRuns}</span>
                  <span>子结果 {run.evidence.subagentResultLength} 字</span>
                  <span>子失败 {run.evidence.subagentFailed}</span>
                </>
              )}
              <span>风险命令 {run.evidence.dangerousCommands}</span>
              <span>结果错误 {run.evidence.toolResultErrors}</span>
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-muted-foreground">
              通用结果评估会在新运行结束后异步生成
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

const SkillEvalDashboardPanel = memo(function SkillEvalDashboardPanel({
  data,
  loading,
  range,
  mineOnly,
  mineSkillCount,
  mineSkillsLoading,
  onRecentPageChange,
  onMineOnlyChange,
  onOpenTrace,
  selectedSkillKey,
  onSelectedSkillKeyChange
}: {
  data: DashboardSkillEvalSummary | null
  loading: boolean
  range: TimeRange
  mineOnly: boolean
  mineSkillCount: number
  mineSkillsLoading: boolean
  onRecentPageChange: (page: number, key: string | null) => void
  onMineOnlyChange: (mineOnly: boolean) => void
  onOpenTrace: (run: DashboardSkillEvalRun) => void
  selectedSkillKey: string | null
  onSelectedSkillKeyChange: (key: string | null) => void
}): React.JSX.Element {
  const skillByKey = useMemo(
    () => new Map((data?.skills ?? []).map((skill) => [
      skillEvalKey(skill.skillName, skill.skillVersion),
      skill
    ])),
    [data]
  )

  const handleAllRunsClick = useCallback(() => {
    onSelectedSkillKeyChange(null)
    onRecentPageChange(1, null)
  }, [onRecentPageChange, onSelectedSkillKeyChange])

  const handleSkillSelect = useCallback((key: string) => {
    onSelectedSkillKeyChange(key)
    onRecentPageChange(1, key)
  }, [onRecentPageChange, onSelectedSkillKeyChange])

  if ((loading || mineSkillsLoading) && !data) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {mineSkillsLoading ? "正在加载我的技能列表..." : "加载中..."}
      </div>
    )
  }
  if (!data) return <div className="py-8 text-center text-sm text-muted-foreground">暂无评估数据</div>

  const recentPage = Math.max(1, data.recentPage)
  const recentPageSize = Math.max(1, data.recentPageSize)
  const recentTotal = Math.max(0, data.recentTotal)
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / recentPageSize))
  const canGoPrevious = recentPage > 1
  const canGoNext = recentPage < recentTotalPages
  const selectedSkill = selectedSkillKey ? skillByKey.get(selectedSkillKey) ?? null : null
  const filteredRuns = data.recent
  const selectedRunTotal = selectedSkill?.runs ?? data.totalRuns
  const selectedTotalTokens = selectedSkill
    ? selectedSkill.averageTotalTokens * selectedSkill.runs
    : data.totalTokens
  const selectedResultRecords = selectedSkill
    ? selectedSkill.runs
    : data.totalRuns
  const selectedTotalLabel = selectedSkill
    ? `采样 ${formatNumber(selectedRunTotal)} 条`
    : `实际最近 ${formatNumber(recentTotal)} 条`
  const selectedAverageToolCalls = selectedSkill?.averageToolCalls ?? data.averageToolCalls
  const selectedAverageModelCalls = selectedSkill?.averageModelCalls ?? data.averageModelCalls
  const selectedAverageTotalTokens = selectedSkill?.averageTotalTokens ?? data.averageTotalTokens
  const selectedAverageDurationMs = selectedSkill?.averageDurationMs ?? data.averageDurationMs
  const scopeLabel = mineOnly ? "我的技能" : "全部技能"

  return (
    <div className="grid min-h-[720px] grid-cols-[minmax(420px,520px)_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <aside className="flex min-h-0 flex-col border-r border-border">
        <div className="grid grid-cols-2 gap-2 border-b border-border p-4">
          <div className="col-span-2 rounded-md border border-border bg-muted/25 px-3 py-2">
            <div className="text-[10px] text-muted-foreground">当前统计口径</div>
            <div className="mt-0.5 truncate text-xs font-medium text-foreground">
              {selectedSkill
                ? `${skillEvalVersionLabel(selectedSkill.skillName, selectedSkill.skillVersion)} · ${scopeLabel} · 采样统计`
                : `${scopeLabel} · 采样统计`}
            </div>
          </div>
          <SkillEvalStatTile label="采样运行" value={selectedRunTotal} />
          <SkillEvalStatTile label="采样技能" value={selectedSkill ? 1 : data.totalSkills} />
          <SkillEvalStatTile label="通过率" value={formatSkillEvalPercent(selectedSkill?.passRate ?? data.passRate)} />
          <SkillEvalStatTile label="平均分" value={formatSkillEvalPercent(selectedSkill?.averageScore ?? data.averageScore)} />
          <SkillEvalStatTile label="过程分" value={formatSkillEvalPercent(selectedSkill?.averageProcessScore ?? data.averageProcessScore ?? data.averageScore)} />
          <SkillEvalStatTile label="结束分" value={formatSkillEvalPercent(selectedSkill?.averageOutcomeScore ?? data.averageOutcomeScore ?? data.averageScore)} />
          <SkillEvalStatTile label="结果分" value={formatSkillEvalPercent(selectedSkill?.averageResultScore ?? data.averageResultScore)} />
          <SkillEvalStatTile label="结果记录" value={selectedResultRecords} />
          <SkillEvalStatTile label="总 Token" value={formatSkillEvalTokens(selectedTotalTokens)} />
          <SkillEvalStatTile label="平均峰值输入" value={formatSkillEvalTokens(selectedSkill?.averagePeakInputTokens ?? data.averagePeakInputTokens)} />
        </div>
        <div className="grid grid-cols-[4px_minmax(96px,1fr)_42px_50px_48px_48px_54px] gap-2 border-b border-border px-4 py-2 text-[11px] font-medium text-muted-foreground">
          <span />
          <span>技能</span>
          <span className="text-right">次数</span>
          <span className="text-right">通过率</span>
          <span className="text-right">结束</span>
          <span className="text-right">分数</span>
          <span className="text-right">Token</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="border-b border-border p-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onMineOnlyChange(false)}
                className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                  !mineOnly
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/35"
                }`}
              >
                全部技能
              </button>
              <button
                type="button"
                onClick={() => onMineOnlyChange(true)}
                className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                  mineOnly
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/35"
                }`}
              >
                我的技能
              </button>
            </div>
            {mineOnly ? (
              <div className="mt-2 truncate text-[11px] text-muted-foreground">
                {mineSkillsLoading
                  ? "正在加载我的技能列表..."
                  : mineSkillCount === 0
                    ? "您还没有上传过技能"
                    : `已按我上传的 ${formatNumber(mineSkillCount)} 个技能查询`}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleAllRunsClick}
            className={`w-full border-b border-border px-4 py-2 text-left text-xs transition-colors hover:bg-muted/35 ${
              selectedSkillKey === null
                ? "bg-primary/12 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.22)]"
                : "text-muted-foreground"
            }`}
            aria-current={selectedSkillKey === null ? "true" : undefined}
          >
            全部运行
          </button>
          {data.skills.map((skill) => {
            const key = skillEvalKey(skill.skillName, skill.skillVersion)
            return (
              <SkillEvalSkillRow
                key={key}
                skill={skill}
                active={selectedSkillKey === key}
                skillKey={key}
                onSelect={handleSkillSelect}
              />
            )
          })}
        </ScrollArea>
      </aside>

      <main className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-medium text-foreground">
              {selectedSkill
                ? skillEvalVersionLabel(selectedSkill.skillName, selectedSkill.skillVersion)
                : "最近运行"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              共 {selectedTotalLabel} · 当前页 {formatNumber(filteredRuns.length)} 条 · 第 {formatNumber(recentPage)} / {formatNumber(recentTotalPages)} 页
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              查询范围：{formatDateOnly(range.from)} ~ {formatDateOnly(range.to)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-2 text-[11px] text-muted-foreground">
              <span>平均工具 {selectedAverageToolCalls.toFixed(1)}</span>
              <span>平均模型调用 {selectedAverageModelCalls.toFixed(1)}</span>
              <span>平均 Token {formatSkillEvalTokens(selectedAverageTotalTokens)}</span>
              <span>平均耗时 {formatDuration(selectedAverageDurationMs)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onRecentPageChange(recentPage - 1, selectedSkillKey)}
                disabled={!canGoPrevious || loading}
              >
                <ChevronLeft className="size-3.5" />
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onRecentPageChange(recentPage + 1, selectedSkillKey)}
                disabled={!canGoNext || loading}
              >
                下一页
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {loading || mineSkillsLoading ? (
            <div className="flex h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {mineSkillsLoading ? "正在加载我的技能列表" : "加载中"}
            </div>
          ) : filteredRuns.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              暂无评估记录
            </div>
          ) : (
            filteredRuns.map((run) => (
              <SkillEvalRunRow
                key={`${run.traceId}:${run.rawSkillName}`}
                run={run}
                onOpenTrace={onOpenTrace}
              />
            ))
          )}
        </ScrollArea>
      </main>
    </div>
  )
})

export function DashboardView(): React.JSX.Element {
  const {
    granularity,
    range,
    selectedUpperOrgLv1,
    loading,
    userStatsLoading,
    skillEvalLoading,
    error,
    overview,
    modelStats,
    userStats,
    productivity,
    feedback,
    skillEval,
    changeGranularity,
    navigate,
    setCustomRange,
    refresh,
    fetchSkillEvalPage,
    clearSkillEval,
    drillDownUserOrg,
    resetUserOrgDrilldown
  } = useDashboard()

  const [exporting, setExporting] = useState(false)
  const [activeMainTab, setActiveMainTab] = useState<DashboardMainTab>("overview")
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<DashboardSkillDetail | null>(null)
  const [skillTracePage, setSkillTracePage] = useState(1)
  const [skillTracesLoading, setSkillTracesLoading] = useState(false)
  const [skillTracesError, setSkillTracesError] = useState<string | null>(null)
  const [skillEvalTraceRun, setSkillEvalTraceRun] = useState<DashboardSkillEvalRun | null>(null)
  const [skillEvalSelectedSkillKey, setSkillEvalSelectedSkillKey] = useState<
    string | null | undefined
  >(undefined)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitScopeLabel, setCommitScopeLabel] = useState("当前范围")
  const [commitDetailsRange, setCommitDetailsRange] = useState<TimeRange | null>(null)
  const [commitDetails, setCommitDetails] = useState<DashboardCommitDetailsData | null>(null)
  const [commitDetailsLoading, setCommitDetailsLoading] = useState(false)
  const [commitDetailsError, setCommitDetailsError] = useState<string | null>(null)
  const [subPage, setSubPage] = useState<DashboardSubPage>({ kind: "main" })
  const [userList, setUserList] = useState<DashboardUserListData | null>(null)
  const [userListLoading, setUserListLoading] = useState(false)
  const [userListError, setUserListError] = useState<string | null>(null)
  const [userListAfterKey, setUserListAfterKey] = useState<
    Record<string, string | number> | undefined
  >()
  const [userListBackStack, setUserListBackStack] = useState<
    Array<Record<string, string | number> | undefined>
  >([])
  const [userDetail, setUserDetail] = useState<DashboardUserDetail | null>(null)
  const [userDetailLoading, setUserDetailLoading] = useState(false)
  const [userDetailError, setUserDetailError] = useState<string | null>(null)
  const [marketSkillKeys, setMarketSkillKeys] = useState<Set<string>>(new Set())
  const [marketSkillMap, setMarketSkillMap] = useState<Map<string, MarketItem>>(new Map())
  const [skillUploaderProfiles, setSkillUploaderProfiles] = useState<
    Record<string, SkillUploaderProfile>
  >({})
  const [marketSkillsLoading, setMarketSkillsLoading] = useState(true)
  const [currentUserUploadCandidatesLoading, setCurrentUserUploadCandidatesLoading] = useState(true)
  const [currentUserUploadCandidates, setCurrentUserUploadCandidates] = useState<string[]>([])
  const [skillEvalMineOnly, setSkillEvalMineOnly] = useState(false)
  const currentUserUploadCandidateSet = useMemo(
    () => new Set(currentUserUploadCandidates),
    [currentUserUploadCandidates]
  )
  const myUploadedSkillEvalScope = useMemo(
    () => {
      const names = new Set<string>()
      let count = 0

      for (const item of marketSkillMap.values()) {
        if (!isUploadedByCurrentUser(item, currentUserUploadCandidateSet)) continue
        count += 1
        for (const name of getMarketSkillQueryNames(item)) {
          names.add(name)
        }
      }

      return {
        names: Array.from(names),
        count
      }
    },
    [currentUserUploadCandidateSet, marketSkillMap]
  )
  const myUploadedSkillNames = myUploadedSkillEvalScope.names
  const myUploadedSkillCount = myUploadedSkillEvalScope.count
  const myUploadedSkillNamesKey = useMemo(
    () => myUploadedSkillNames.join("\u0001"),
    [myUploadedSkillNames]
  )
  const skillEvalScopeKey = skillEvalMineOnly ? `mine:${myUploadedSkillNamesKey}` : "all"
  const skillEvalSkillByKey = useMemo(
    () => new Map((skillEval?.skills ?? []).map((skill) => [
      skillEvalKey(skill.skillName, skill.skillVersion),
      skill
    ])),
    [skillEval]
  )
  const latestSkillEvalKey = useMemo(
    () => getLatestSkillEvalKey(skillEval),
    [skillEval]
  )
  const mineSkillsLoading = skillEvalMineOnly && (marketSkillsLoading || currentUserUploadCandidatesLoading)
  const effectiveSkillEvalSelectedSkillKey =
    skillEvalSelectedSkillKey === undefined ? latestSkillEvalKey : skillEvalSelectedSkillKey

  useEffect(() => {
    setSkillEvalSelectedSkillKey(undefined)
    clearSkillEval()
  }, [clearSkillEval, range.from, range.to, skillEvalScopeKey])

  useEffect(() => {
    if (skillEvalSelectedSkillKey === undefined || skillEvalSelectedSkillKey === null || !skillEval) return
    const selectedSkillStillExists = skillEvalSkillByKey.has(skillEvalSelectedSkillKey)
    if (!selectedSkillStillExists) {
      setSkillEvalSelectedSkillKey(undefined)
    }
  }, [skillEval, skillEvalSelectedSkillKey, skillEvalSkillByKey])

  useEffect(() => {
    if (activeMainTab !== "skill-eval" || skillEval || skillEvalLoading || mineSkillsLoading) return
    void fetchSkillEvalPage(1, {
      defaultRecentToLatestSkill: true,
      ...(skillEvalMineOnly ? { skillNames: myUploadedSkillNames } : {})
    })
  }, [
    activeMainTab,
    fetchSkillEvalPage,
    mineSkillsLoading,
    myUploadedSkillNamesKey,
    skillEval,
    skillEvalLoading,
    skillEvalMineOnly
  ])

  useEffect(() => {
    if (
      activeMainTab !== "skill-eval" ||
      skillEvalSelectedSkillKey !== undefined ||
      !effectiveSkillEvalSelectedSkillKey ||
      !skillEval
    ) {
      return
    }
    setSkillEvalSelectedSkillKey(effectiveSkillEvalSelectedSkillKey)
  }, [
    activeMainTab,
    effectiveSkillEvalSelectedSkillKey,
    skillEval,
    skillEvalSelectedSkillKey
  ])

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
      if (!cancelled) setMarketSkillsLoading(true)
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
      } finally {
        if (!cancelled) setMarketSkillsLoading(false)
      }
    }

    void loadMarketSkills()

    return () => {
      cancelled = true
    }
  }, [])

  const loadSkillDetailPage = useCallback(
    async (skill: string, page: number) => {
      setSelectedSkill(skill)
      setSkillDialogOpen(true)
      setSkillTracePage(page)
      setSkillTracesError(null)
      setSkillTracesLoading(true)
      try {
        const result = await window.api.dashboard.skillDetail(skill, range, {
          page,
          pageSize: SKILL_TRACE_PAGE_SIZE
        })
        if (!result.success) throw new Error(result.error ?? "获取 Skill 详情失败")
        setSkillDetail(result.data ?? EMPTY_SKILL_DETAIL)
      } catch (e) {
        setSkillTracesError(e instanceof Error ? e.message : String(e))
      } finally {
        setSkillTracesLoading(false)
      }
    },
    [range]
  )

  const handleSkillClick = useCallback(
    async (skill: string) => {
      setSkillDetail(null)
      await loadSkillDetailPage(skill, 1)
    },
    [loadSkillDetailPage]
  )

  const handleSkillTracePageChange = useCallback(
    (page: number) => {
      if (!selectedSkill) return
      void loadSkillDetailPage(selectedSkill, page)
    },
    [loadSkillDetailPage, selectedSkill]
  )

  const handleSkillEvalTraceOpen = useCallback((run: DashboardSkillEvalRun) => {
    setSkillEvalTraceRun(run)
  }, [])

  const skillEvalTraceExplorerTraces = useMemo<DashboardSkillDetail["traces"]>(() => {
    if (!skillEvalTraceRun) return []
    return [
      skillEvalTraceRun.traceDetail ?? {
        traceId: skillEvalTraceRun.traceId,
        threadId: skillEvalTraceRun.threadId,
        startedAt: skillEvalTraceRun.startedAt,
        endedAt: skillEvalTraceRun.endedAt,
        durationMs: skillEvalTraceRun.durationMs,
        userMessage: skillEvalTraceRun.userMessage,
        outcome: skillEvalTraceRun.outcome,
        totalToolCalls: skillEvalTraceRun.totalToolCalls,
        totalInputTokens: skillEvalTraceRun.totalInputTokens,
        totalOutputTokens: skillEvalTraceRun.totalOutputTokens,
        totalTokens: skillEvalTraceRun.totalTokens,
        usedSkills: [skillEvalTraceRun.rawSkillName],
        rawAvailable: false,
        rawError: "该评估记录缺少完整 trace 详情"
      }
    ]
  }, [skillEvalTraceRun])

  const getSkillEvalFilterForKey = useCallback(
    (key: string | null) => {
      const filter = skillEvalFilterForKey(skillEvalSkillByKey, key) ?? {}
      return {
        ...filter,
        ...(skillEvalMineOnly ? { skillNames: myUploadedSkillNames } : {})
      }
    },
    [myUploadedSkillNamesKey, skillEvalMineOnly, skillEvalSkillByKey]
  )

  const handleSkillEvalPageChange = useCallback(
    (page: number, key: string | null) => {
      const filter = getSkillEvalFilterForKey(key)
      void fetchSkillEvalPage(page, {
        ...filter,
        ...(filter.skillName ? { recentOnly: true } : {})
      })
    },
    [fetchSkillEvalPage, getSkillEvalFilterForKey]
  )

  const handleSkillEvalMineOnlyChange = useCallback((mineOnly: boolean) => {
    setSkillEvalMineOnly(mineOnly)
  }, [])

  const handleRefresh = useCallback(() => {
    refresh()
    if (activeMainTab === "skill-eval") {
      setSkillEvalSelectedSkillKey(undefined)
      clearSkillEval()
    }
  }, [activeMainTab, clearSkillEval, refresh])

  useEffect(() => {
    let cancelled = false

    async function loadCurrentUserUploadCandidates(): Promise<void> {
      if (!cancelled) setCurrentUserUploadCandidatesLoading(true)
      try {
        if (typeof window.api?.models?.getUserInfo !== "function") {
          if (!cancelled) setCurrentUserUploadCandidates([])
          return
        }
        const userInfo = (await window.api.models.getUserInfo()) as UserInfoLite | null
        const normalizedIds = [userInfo?.sapId, userInfo?.ystId]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
        const candidates = Array.from(new Set(normalizedIds.flatMap((id) => buildUploaderIdCandidates(id))))
        if (!cancelled) setCurrentUserUploadCandidates(candidates)
      } catch (error) {
        console.warn("[Dashboard] Failed to load current user upload candidates:", error)
        if (!cancelled) setCurrentUserUploadCandidates([])
      } finally {
        if (!cancelled) setCurrentUserUploadCandidatesLoading(false)
      }
    }

    void loadCurrentUserUploadCandidates()
    const unsubscribeLogin = window.electron?.ipcRenderer?.on?.("notify-login-msg", () => {
      void loadCurrentUserUploadCandidates()
    })

    return () => {
      cancelled = true
      unsubscribeLogin?.()
    }
  }, [])

  const loadUserList = useCallback(
    async (
      afterKey?: Record<string, string | number>,
      backStack: Array<Record<string, string | number> | undefined> = []
    ) => {
      setUserListLoading(true)
      setUserListError(null)
      try {
        const result = await window.api.dashboard.userList(range, {
          pageSize: USER_LIST_PAGE_SIZE,
          afterKey: afterKey ?? null
        })
        if (!result.success) throw new Error(result.error ?? "获取用户列表失败")
        setUserList(
          result.data ?? { items: [], pageSize: USER_LIST_PAGE_SIZE, totalActiveUsers: 0 }
        )
        setUserListAfterKey(afterKey)
        setUserListBackStack(backStack)
      } catch (e) {
        setUserListError(e instanceof Error ? e.message : String(e))
      } finally {
        setUserListLoading(false)
      }
    },
    [range]
  )

  const loadUserDetail = useCallback(
    async (sapId: string) => {
      setUserDetailLoading(true)
      setUserDetailError(null)
      try {
        const result = await window.api.dashboard.userDetail(sapId, range, { traceLimit: 10 })
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
  }, [])

  const openUserDetail = useCallback(
    (sapId: string, backTo?: "main" | "user-list") => {
      const normalizedSapId = sapId.trim()
      if (!normalizedSapId) return
      const fallbackBackTo = subPage.kind === "user-list" ? "user-list" : "main"
      setSubPage({ kind: "user-detail", sapId: normalizedSapId, backTo: backTo ?? fallbackBackTo })
      setUserDetail(null)
    },
    [subPage.kind]
  )

  const handleUserListNext = (): void => {
    if (!userList?.nextAfterKey) return
    void loadUserList(userList.nextAfterKey, [...userListBackStack, userListAfterKey])
  }

  const handleUserListPrevious = (): void => {
    if (userListBackStack.length === 0) return
    const nextStack = userListBackStack.slice(0, -1)
    const previousAfterKey = userListBackStack[userListBackStack.length - 1]
    void loadUserList(previousAfterKey, nextStack)
  }

  const handleUserDetailBack = useCallback(() => {
    if (subPage.kind === "user-detail" && subPage.backTo === "user-list") {
      setSubPage({ kind: "user-list" })
      return
    }
    setSubPage({ kind: "main" })
  }, [subPage])

  const subPageDetailSapId = subPage.kind === "user-detail" ? subPage.sapId : null

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (subPage.kind === "user-list") {
        void loadUserList(undefined, [])
      } else if (subPageDetailSapId) {
        void loadUserDetail(subPageDetailSapId)
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [range, subPage.kind, subPageDetailSapId, loadUserList, loadUserDetail])

  const loadCommitDetails = useCallback(
    async (targetRange: TimeRange, scopeLabel: string, page = 1, pushedOnly = false) => {
      setCommitScopeLabel(scopeLabel)
      setCommitDetailsRange(targetRange)
      setCommitDialogOpen(true)
      setCommitDetails(null)
      setCommitDetailsError(null)
      setCommitDetailsLoading(true)
      try {
        const result = await window.api.dashboard.commitDetails(targetRange, {
          page,
          pageSize: 20,
          pushedOnly
        })
        if (!result.success) throw new Error(result.error ?? "获取 Commit 明细失败")
        setCommitDetails(result.data ?? { total: 0, page, pageSize: 20, pushedOnly, items: [] })
      } catch (e) {
        setCommitDetailsError(e instanceof Error ? e.message : String(e))
      } finally {
        setCommitDetailsLoading(false)
      }
    },
    []
  )

  const reloadCommitDetails = useCallback(
    (page: number, pushedOnly: boolean) => {
      if (!commitDetailsRange) return
      void loadCommitDetails(commitDetailsRange, commitScopeLabel, page, pushedOnly)
    },
    [commitDetailsRange, commitScopeLabel, loadCommitDetails]
  )

  const handleCommitExternalOpen = useCallback((url: string) => {
    if (!url) return
    void window.electron.openExternal(url)
  }, [])

  const handleCommitTotalClick = useCallback(() => {
    void loadCommitDetails(
      range,
      `当前范围 · ${formatRangeLabel(range.from, range.to, granularity)}`
    )
  }, [loadCommitDetails, range, granularity])

  const handleCommitBucketClick = useCallback(
    (bucket: { from: string; to: string; label: string }) => {
      void loadCommitDetails({ from: bucket.from, to: bucket.to }, `时间桶 · ${bucket.label}`)
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
          sheets.push({
            name:
              selectedUpperOrgLv1 === null
                ? "一级部门分布"
                : `${selectedUpperOrgLv1 || "未知"}下级部门分布`,
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
            ["新增行数", productivity.totalInsertions],
            ["删除行数", productivity.totalDeletions],
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
    selectedUpperOrgLv1,
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
        onRefresh={handleRefresh}
        onExport={handleExport}
        loading={loading}
        exporting={exporting}
      />

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {subPage.kind === "main" && (
        <DashboardTabBar activeTab={activeMainTab} onChange={setActiveMainTab} />
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
            onRefresh={() => loadUserList(userListAfterKey, userListBackStack)}
            onPrevious={handleUserListPrevious}
            onNext={handleUserListNext}
            onUserClick={(user) => openUserDetail(user.sapId, "user-list")}
          />
        </ScrollArea>
      ) : subPage.kind === "user-detail" ? (
        <ScrollArea className="flex-1">
          <UserDetailPage
            data={userDetail}
            loading={userDetailLoading}
            error={userDetailError}
            onBack={handleUserDetailBack}
          />
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1">
          {activeMainTab === "skill-eval" ? (
            <div className="space-y-6 p-6">
              <SkillEvalDashboardPanel
                data={skillEval}
                loading={skillEvalLoading}
                range={range}
                mineOnly={skillEvalMineOnly}
                mineSkillCount={myUploadedSkillCount}
                mineSkillsLoading={mineSkillsLoading}
                onRecentPageChange={handleSkillEvalPageChange}
                onMineOnlyChange={handleSkillEvalMineOnlyChange}
                onOpenTrace={handleSkillEvalTraceOpen}
                selectedSkillKey={effectiveSkillEvalSelectedSkillKey}
                onSelectedSkillKeyChange={setSkillEvalSelectedSkillKey}
              />
            </div>
          ) : (
            <div className="space-y-6 p-6">
              {/* Overview */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">使用概览</h2>
                <OverviewPanel
                  data={overview}
                  loading={loading}
                  onSkillClick={handleSkillClick}
                  onActiveUsersClick={openUserList}
                  marketSkillKeys={marketSkillKeys}
                />
              </section>

              {/* Productivity */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">生产力指标</h2>
                <ProductivityPanel
                  data={productivity}
                  loading={loading}
                  onCommitTotalClick={handleCommitTotalClick}
                  onCommitBucketClick={handleCommitBucketClick}
                />
              </section>

              {/* User Analysis */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">用户分析</h2>
                <UserPanel
                  data={userStats}
                  loading={loading || userStatsLoading}
                  onDrillDownOrg={drillDownUserOrg}
                  onResetOrgDrilldown={resetUserOrgDrilldown}
                  onUserClick={(sapId) => openUserDetail(sapId, "main")}
                />
              </section>

              {/* Model Analysis */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">模型分析</h2>
                <ModelPanel data={modelStats} loading={loading} />
              </section>

              {/* Feedback */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">点赞 / 点踩反馈</h2>
                <FeedbackPanel data={feedback} loading={loading} />
              </section>
            </div>
          )}
        </ScrollArea>
      )}
      <TraceHistoryDialog
        open={skillDialogOpen}
        onOpenChange={setSkillDialogOpen}
        skill={selectedSkill}
        traces={skillDetail?.traces ?? []}
        codeStats={skillDetail?.stats ?? null}
        total={skillDetail?.total ?? 0}
        page={skillDetail?.page ?? skillTracePage}
        pageSize={skillDetail?.pageSize ?? SKILL_TRACE_PAGE_SIZE}
        loading={skillTracesLoading}
        error={skillTracesError}
        onPageChange={handleSkillTracePageChange}
      />
      <Dialog open={Boolean(skillEvalTraceRun)} onOpenChange={(open) => {
        if (!open) setSkillEvalTraceRun(null)
      }}>
        <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="truncate text-base">
              技能评估详情 · {skillEvalTraceRun ? skillEvalVersionLabel(skillEvalTraceRun.skillName, skillEvalTraceRun.skillVersion) : "-"}
            </DialogTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {skillEvalTraceRun ? `${formatRelativeTime(skillEvalTraceRun.startedAt)} · 链路 ${skillEvalTraceRun.traceId}` : ""}
            </p>
          </DialogHeader>
          {skillEvalTraceRun && <SkillEvalRunSummary run={skillEvalTraceRun} />}
          <TraceExplorer
            traces={skillEvalTraceExplorerTraces}
            codeStats={null}
            title="执行步骤详情"
            emptyText="该评估记录没有可展示的 trace 步骤"
            showCodeStats={false}
          />
        </DialogContent>
      </Dialog>
      <CommitDetailsDialog
        open={commitDialogOpen}
        onOpenChange={setCommitDialogOpen}
        scopeLabel={commitScopeLabel}
        data={commitDetails}
        loading={commitDetailsLoading}
        error={commitDetailsError}
        onPageChange={(page) => reloadCommitDetails(page, commitDetails?.pushedOnly ?? false)}
        onPushedOnlyChange={(pushedOnly) => reloadCommitDetails(1, pushedOnly)}
        onOpenExternal={handleCommitExternalOpen}
      />
    </div>
  )
}
