import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts"
import {
  Boxes,
  Layers,
  Activity,
  MessagesSquare,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  Plug,
  Code2,
  Gauge,
  GitCommit,
  Info,
  Search,
  X
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { marketApi, type MarketItem } from "@/api/market"
import { buildUploaderIdCandidates } from "@/lib/skill-data-service"
import codeEfficiencyModel from "@/assets/code-efficiency-model.png"
import {
  CodeAdoptionFunnel,
  GeneratedLinesTooltip,
  InclusiveAdoptionTooltip,
  InclusivePushedAdoptionTooltip,
  MeasuredAdoptionTooltip,
  PushedAdoptionTooltip,
  SkillRankingPanel,
  ToolRankingPanel,
  type CodeAdoptionFunnelData
} from "./dashboard-shared"
import type {
  DashboardProjectModeData,
  DashboardProjectModeAdapter,
  DashboardProjectModeAnalytics,
  DashboardProjectModeFeature,
  DashboardProjectModeFeatureNode,
  DashboardProjectModeNodeStatus,
  DashboardProjectModeOrgDistributionItem,
  DashboardProjectModeProject,
  DashboardProjectModeProjectCounts,
  DashboardProjectModeProjectPageData,
  DashboardProjectModeProjectPageOptions,
  DashboardProjectModeProjectSortKey,
  DashboardProjectModeProjectSortOrder,
  DashboardProjectModeProjectStatus,
  DashboardProjectModeSkillCount,
  DashboardProjectModeToolUsage,
  DashboardCodeStats,
  DashboardStageBuckets,
  DashboardStageBucketStat
} from "../use-dashboard"
import { formatTopUserOrgName } from "../use-dashboard"
import {
  STAGE_BUCKET_HINTS,
  STAGE_BUCKET_LABELS,
  type StageBucket
} from "../../../../../shared/harness-stage-bucket"

const EMPTY_FUNNEL_DATA: CodeAdoptionFunnelData = {
  inclusiveEffectiveGeneratedLines: 0,
  effectiveGeneratedLines: 0,
  pushedEffectiveGeneratedLines: 0,
  adoptedLines: 0,
  pushedAdoptedLines: 0,
  inclusiveAdoptionRate: null,
  measuredAdoptionRate: null,
  pushedAdoptionRate: null,
  inclusivePushedAdoptionRate: null
}

const EMPTY_TOOL_USAGE: DashboardProjectModeToolUsage = {
  byTool: [],
  byToolAll: [],
  byToolFilteredAll: [],
  byToolAllFull: [],
  totalTools: 0,
  totalToolCalls: 0
}

// 「生产效能代码指标」source 下拉哨兵。CODE_SOURCE_NATIVE 必须与主进程
// src/main/ipc/dashboard.ts 的 NATIVE_CODE_SOURCE 字面量保持一致。
const CODE_SOURCE_ALL = "__all__"
const CODE_SOURCE_NATIVE = "__native__"

const PROJECT_CHART_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#f97316",
  "#6366f1",
  "#14b8a6",
  "#e11d48"
]

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatLineCount(value: number): string {
  return formatCompact(value)
}

function formatPieLabel(name: unknown, percent?: number): string {
  const label = String(name ?? "未知")
  const shortLabel = label.length > 6 ? `${label.slice(0, 6)}...` : label
  return `${shortLabel} ${((percent ?? 0) * 100).toFixed(0)}%`
}

function ProjectModePieTooltip({
  active,
  payload
}: {
  active?: boolean
  payload?: { name?: unknown; value?: unknown }[]
}): React.JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null
  const item = payload[0]
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="max-w-[220px] break-words font-medium text-foreground">
        {String(item.name ?? "未知")}
      </div>
      <div className="mt-0.5 text-muted-foreground">
        项目数：{formatNumber(Number(item.value) || 0)}
      </div>
    </div>
  )
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
  hint,
  tag
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
  hint?: React.ReactNode
  /** 口径标签：底部小药丸，如「总量口径 · 入库」。 */
  tag?: string
}): React.JSX.Element {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="truncate whitespace-nowrap">{label}</span>
          {hint ? <InfoHint hint={hint} /> : null}
        </div>
        <div className="text-lg font-bold leading-tight text-foreground">{value}</div>
        {sub && <div className="whitespace-nowrap text-[10px] text-muted-foreground">{sub}</div>}
        {tag && (
          <div className="mt-1.5 inline-block whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {tag}
          </div>
        )}
      </div>
    </div>
  )
}

function ProjectModePieCard({
  title,
  data,
  nameKey,
  helperText,
  action,
  onSliceClick
}: {
  title: string
  data: Record<string, unknown>[]
  nameKey: string
  helperText?: string
  action?: React.ReactNode
  onSliceClick?: (entry: Record<string, unknown>) => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex min-h-[42px] items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
          {helperText ? (
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{helperText}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey={nameKey}
              cx="50%"
              cy="50%"
              outerRadius={76}
              label={({ name, percent }) => formatPieLabel(name, percent)}
              labelLine={false}
              fontSize={9}
              onClick={
                onSliceClick
                  ? (entry) => onSliceClick(entry as unknown as Record<string, unknown>)
                  : undefined
              }
              style={onSliceClick ? { cursor: "pointer" } : undefined}
            >
              {data.map((_, index) => (
                <Cell
                  key={index}
                  fill={PROJECT_CHART_COLORS[index % PROJECT_CHART_COLORS.length]}
                />
              ))}
            </Pie>
            <RechartsTooltip content={<ProjectModePieTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[240px] items-center justify-center text-xs text-muted-foreground">
          暂无数据
        </div>
      )}
    </div>
  )
}

function ProjectModeUserAnalysisCard({
  users,
  onUserClick
}: {
  users: DashboardProjectModeAnalytics["topUsers"]
  onUserClick?: (sapId: string) => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-medium text-muted-foreground">用户分析</h3>
      <div className="max-h-[260px] overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="px-2 py-2 text-left font-medium">#</th>
              <th className="px-2 py-2 text-left font-medium">用户</th>
              <th className="px-2 py-2 text-left font-medium">部门</th>
              <th className="px-2 py-2 text-right font-medium">对话数</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user, index) => {
              const canClick = Boolean(onUserClick && user.sapId)
              return (
                <tr
                  key={user.sapId || user.ystId || `${user.userName}-${index}`}
                  className={`border-b border-border/50 transition-colors hover:bg-muted/30 ${
                    canClick ? "cursor-pointer" : ""
                  }`}
                  onClick={canClick ? () => onUserClick?.(user.sapId) : undefined}
                >
                  <td className="px-2 py-1.5 text-muted-foreground">{index + 1}</td>
                  <td className="px-2 py-1.5 text-foreground">
                    <div className="font-medium">{user.userName || user.sapId || "—"}</div>
                    {user.sapId || user.ystId ? (
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {user.sapId || user.ystId}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{user.orgName || "—"}</td>
                  <td className="px-2 py-1.5 text-right font-medium text-foreground">
                    {formatNumber(user.count)}
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProjectModeDepartmentChart({
  items
}: {
  items: DashboardProjectModeOrgDistributionItem[]
}): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState("")
  const selected = items.find((item) => item.key === selectedKey)
  const data = selected ? selected.children : items
  const canDrillDown = !selected

  return (
    <ProjectModePieCard
      title={selected ? `${selected.org}下级分布` : "项目部门分布"}
      data={data as unknown as Record<string, unknown>[]}
      nameKey="org"
      helperText={selected ? "按项目创建人下级部门统计项目数。" : "按项目创建人部门统计项目数。"}
      action={
        selected ? (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setSelectedKey("")}
          >
            <ChevronLeft className="size-3.5" />
            返回上级
          </button>
        ) : null
      }
      onSliceClick={
        canDrillDown
          ? (entry) => {
              const key = typeof entry.key === "string" ? entry.key : ""
              const target = items.find((item) => item.key === key)
              if (target && target.children.length > 0) setSelectedKey(key)
            }
          : undefined
      }
    />
  )
}

function ProjectModeAnalyticsSection({
  analytics,
  onUserClick
}: {
  analytics?: DashboardProjectModeAnalytics | null
  onUserClick?: (sapId: string) => void
}): React.JSX.Element {
  const data = analytics ?? { topUsers: [], byOrg: [], byAdapter: [] }
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-foreground">项目分析</h2>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <ProjectModeUserAnalysisCard users={data.topUsers} onUserClick={onUserClick} />
        <ProjectModeDepartmentChart items={data.byOrg} />
        <ProjectModePieCard
          title="插件占比"
          data={data.byAdapter as unknown as Record<string, unknown>[]}
          nameKey="name"
          helperText="按项目数统计，已合并不同插件版本。"
        />
      </div>
    </section>
  )
}

function lifecycleLabel(status?: string): string {
  switch (status) {
    case "active":
      return "进行中"
    case "paused":
      return "已暂停"
    case "archived":
      return "已归档"
    case "completed":
      return "已完成"
    default:
      return status || "—"
  }
}

function formatProjectCreatorDepartment(project: DashboardProjectModeProject): string {
  if (project.creatorUpperOrgLv1 && project.creatorUpperOrgLv0) {
    return `${project.creatorUpperOrgLv1}/${project.creatorUpperOrgLv0}`
  }
  if (project.creatorUpperOrgLv1) return project.creatorUpperOrgLv1
  return project.creatorOrgName || "—"
}

/** 小 i 提示，hover 显示说明文案。 */
function InfoHint({ hint }: { hint: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 cursor-help align-middle">
            <Info className="size-3 text-muted-foreground/70" aria-label="查看说明" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** 小 i 按钮：点击弹出「生产效能代码指标」口径示意大图。 */
function CodeEfficiencyModelInfo(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground"
              aria-label="查看口径说明大图"
              onClick={() => setOpen(true)}
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>点击查看口径说明示意图</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[92vw] max-w-[1720px]">
          <DialogHeader>
            <DialogTitle>生产效能代码指标 · 口径说明</DialogTitle>
          </DialogHeader>
          <div className="max-h-[82vh] overflow-auto">
            <img
              src={codeEfficiencyModel}
              alt="生产效能代码指标口径说明示意图"
              className="h-auto w-full"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Per-feature code-adoption line: 原始生成行数 / 有效生成行数 / 已Commit·已Push 采纳率（含行数明细）。 */
function FeatureCodeStatsLine({
  codeStats,
  compact = false
}: {
  codeStats?: DashboardCodeStats | null
  /** 紧凑模式：隐藏「原始/有效生成行数」首行，提交口径 + 总量口径合并为一行。 */
  compact?: boolean
}): React.JSX.Element {
  if (!codeStats) {
    return <div className="text-[11px] text-muted-foreground/80">暂无代码生成数据</div>
  }
  const commitDenom = formatLineCount(codeStats.effectiveGeneratedLines)
  const pushDenom = formatLineCount(codeStats.pushedEffectiveGeneratedLines)
  const totalDenom = formatLineCount(codeStats.inclusiveEffectiveGeneratedLines)
  const adopted = formatLineCount(codeStats.adoptedLines)
  const pushedAdopted = formatLineCount(codeStats.pushedAdoptedLines)
  const commitGroup = (
    <>
      <span className="text-muted-foreground/70">提交口径</span>
      <span>
        提交{" "}
        <span className="font-medium text-foreground">
          {formatPercent(codeStats.measuredAdoptionRate)}
        </span>
        <span className="ml-1 text-muted-foreground/80">
          ({adopted} / {commitDenom} 行)
        </span>
      </span>
      <span>
        入库{" "}
        <span className="font-medium text-foreground">
          {formatPercent(codeStats.pushedAdoptionRate)}
        </span>
        <span className="ml-1 text-muted-foreground/80">
          ({pushedAdopted} / {pushDenom} 行)
        </span>
      </span>
    </>
  )
  const totalGroup = (
    <>
      <span className="text-muted-foreground/70">总量口径</span>
      <span>
        提交{" "}
        <span className="font-medium text-foreground">
          {formatPercent(codeStats.inclusiveAdoptionRate)}
        </span>
        <span className="ml-1 text-muted-foreground/80">
          ({adopted} / {totalDenom} 行)
        </span>
      </span>
      <span>
        入库{" "}
        <span className="font-medium text-foreground">
          {formatPercent(codeStats.inclusivePushedAdoptionRate)}
        </span>
        <span className="ml-1 text-muted-foreground/80">
          ({pushedAdopted} / {totalDenom} 行)
        </span>
      </span>
    </>
  )
  if (compact) {
    // 紧凑：两口径合并到一行（flex-wrap，窄屏才换行）。
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        {commitGroup}
        {totalGroup}
      </div>
    )
  }
  return (
    <div className="space-y-1 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          原始生成行数{" "}
          <span className="font-medium text-foreground">
            {formatLineCount(codeStats.generatedLines)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1">
          有效生成行数{" "}
          <span className="font-medium text-foreground">
            {formatLineCount(codeStats.effectiveGeneratedLines)}
          </span>
          <InfoHint hint="Agent 原始生成行数扣除被Agent后续修改覆盖、回退或删除的行后，真正纳入采纳率分母的有效产出。" />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{commitGroup}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{totalGroup}</div>
    </div>
  )
}

/** 表格内一条「label X% (采纳/生成)」采纳率，按口径分组的列里上下各一条；有数据时可点击采纳溯源。 */
function AdoptionRateLine({
  label,
  rate,
  detail,
  clickable,
  onActivate,
  title
}: {
  label: string
  rate: number | null
  detail: string
  clickable: boolean
  onActivate: () => void
  title: string
}): React.JSX.Element {
  const body = (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground/70">{label}</span>{" "}
      <span className="font-medium underline-offset-2 group-hover:underline">
        {formatPercent(rate)}
      </span>
      <span className="ml-1 text-[10px] text-muted-foreground">{detail}</span>
    </span>
  )
  if (clickable) {
    return (
      <button
        type="button"
        className="group block w-full text-right transition-colors hover:text-primary"
        title={title}
        onClick={(event) => {
          event.stopPropagation()
          onActivate()
        }}
      >
        {body}
      </button>
    )
  }
  return <div className="text-right">{body}</div>
}

/** Status-at-turn-time sub-breakdown rows（进行中/已完成 等）。空则不渲染。表头/边框由 NodeBreakdownTabs 提供。 */
function StageStatusRows({
  byStatus,
  onOpenStatusTraces
}: {
  byStatus: DashboardProjectModeNodeStatus[]
  /** 可选：查看该「阶段+状态」的对话；不传则不显示按钮（如插件聚合无单项目 trace）。 */
  onOpenStatusTraces?: (status: string) => void
}): React.JSX.Element | null {
  if (byStatus.length === 0) return null
  return (
    <div className="space-y-2">
      {byStatus.map((s) => (
        <div key={s.status} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-foreground/80">
                {s.status}
              </span>
              <span>{formatNumber(s.conversationCount)} 对话</span>
            </span>
            {onOpenStatusTraces ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 text-[10px] text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                disabled={s.conversationCount === 0}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenStatusTraces(s.status)
                }}
              >
                <MessagesSquare className="size-3" />
                查看对话
              </button>
            ) : null}
          </div>
          {/* 紧凑：提交口径 + 总量口径合并为一行，含 (采纳/分母 行)。 */}
          <FeatureCodeStatsLine codeStats={s.codeStats} compact />
        </div>
      ))}
    </div>
  )
}

/** Ordered, color-coded descriptors for the stage×skill buckets. */
const STAGE_BUCKET_VIEW: ReadonlyArray<{
  key: keyof DashboardStageBuckets
  bucket: StageBucket
  dot: string
}> = [
  { key: "pluginConstrained", bucket: "plugin_constrained", dot: "bg-emerald-500" },
  { key: "vibecoding", bucket: "vibecoding", dot: "bg-violet-500" },
  { key: "unattributed", bucket: "unattributed", dot: "bg-muted-foreground/40" }
]

/** True when every bucket is empty (no conversations and no generated lines). */
function isStageBucketsEmpty(buckets: DashboardStageBuckets): boolean {
  return STAGE_BUCKET_VIEW.every(({ key }) => {
    const stat = buckets[key]
    return stat.conversationCount === 0 && (stat.codeStats?.generatedLines ?? 0) === 0
  })
}

/**
 * 流程阶段口径完整说明，复用 shared 的桶标签 / 含义常量，保证口径单一来源。
 * 三桶定义 + 每格指标图例，作为列表内「流程阶段口径」小 i 的权威说明。
 */
function StageBucketCaliberHint(): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div>按每轮对话开始时的工作流阶段状态 × 是否调用插件 Skill 交叉拆分为三类：</div>
      {STAGE_BUCKET_VIEW.map(({ bucket }) => (
        <div key={bucket}>
          <span className="font-medium">{STAGE_BUCKET_LABELS[bucket]}</span>：
          {STAGE_BUCKET_HINTS[bucket]}
        </div>
      ))}
      <div className="opacity-80">每格依次为「对话数 · 生成行数 · 总量口径提交采纳率」。</div>
    </div>
  )
}

/**
 * Stage×skill 三桶拆分：插件约束（Harness）/ VibeCoding / 未归因。
 * 列表行内紧凑一行展示；全空则不渲染。
 */
function StageBucketSplit({
  buckets
}: {
  buckets: DashboardStageBuckets
}): React.JSX.Element | null {
  if (isStageBucketsEmpty(buckets)) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      {STAGE_BUCKET_VIEW.map(({ key, bucket, dot }) => {
        const stat = buckets[key]
        const lines = stat.codeStats?.generatedLines ?? 0
        return (
          <span key={bucket} className="flex items-center gap-1">
            <span className={`size-1.5 rounded-full ${dot}`} />
            <span className="text-foreground/80">{STAGE_BUCKET_LABELS[bucket]}</span>
            <InfoHint hint={STAGE_BUCKET_HINTS[bucket]} />
            <span>
              {formatNumber(stat.conversationCount)} 对话 · {formatLineCount(lines)} 行 ·{" "}
              {formatPercent(stat.codeStats?.inclusiveAdoptionRate)} 采纳
            </span>
          </span>
        )
      })}
    </div>
  )
}

/** 流程阶段三桶分行展示（插件约束（Harness）/ VibeCoding / 未归因），与状态细分同款紧凑口径。空则不渲染。 */
function StageBucketRows({
  buckets,
  onOpenBucketTraces
}: {
  buckets: DashboardStageBuckets
  /** 可选：按桶查看对话；不传则不显示按钮（如插件聚合无单项目 trace）。 */
  onOpenBucketTraces?: (bucket: StageBucket) => void
}): React.JSX.Element | null {
  if (isStageBucketsEmpty(buckets)) return null
  return (
    <div className="space-y-2">
      {STAGE_BUCKET_VIEW.map(({ key, bucket, dot }) => {
        const stat = buckets[key]
        return (
          <div key={bucket} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-foreground/80">
                  <span className={`size-1.5 rounded-full ${dot}`} />
                  {STAGE_BUCKET_LABELS[bucket]}
                </span>
                <span>{formatNumber(stat.conversationCount)} 对话</span>
              </span>
              {onOpenBucketTraces ? (
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 text-[10px] text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                  disabled={stat.conversationCount === 0}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenBucketTraces(bucket)
                  }}
                >
                  <MessagesSquare className="size-3" />
                  查看对话
                </button>
              ) : null}
            </div>
            {/* 紧凑：提交口径 + 总量口径合并为一行，含 (采纳/分母 行)。 */}
            <FeatureCodeStatsLine codeStats={stat.codeStats} compact />
          </div>
        )
      })}
    </div>
  )
}

const NODE_STATUS_BREAKDOWN_HINT =
  "按每轮对话开始时该节点的状态（进行中/已完成等）细分；多数对话发生在当前进行中的节点，故「进行中」通常占多数。"

/**
 * 节点（阶段）内的子拆分，两个 tab 切换：
 *  - 状态细分：按节点状态（进行中/已完成…）；
 *  - 插件约束（Harness） vs VibeCoding：按 stage×skill 三桶。
 * 两侧都无数据则整体不渲染；仅一侧有数据时默认落在该 tab。
 */
function NodeBreakdownTabs({
  byStatus,
  stageBuckets,
  onOpenStatusTraces,
  onOpenBucketTraces
}: {
  byStatus: DashboardProjectModeNodeStatus[]
  stageBuckets: DashboardStageBuckets
  onOpenStatusTraces?: (status: string) => void
  onOpenBucketTraces?: (bucket: StageBucket) => void
}): React.JSX.Element | null {
  const hasStatus = byStatus.length > 0
  const hasBuckets = !isStageBucketsEmpty(stageBuckets)
  const [tab, setTab] = useState<"status" | "buckets">(hasStatus ? "status" : "buckets")
  if (!hasStatus && !hasBuckets) return null

  const tabButton = (id: "status" | "buckets", label: string): React.JSX.Element => (
    <button
      type="button"
      className={`rounded px-1.5 py-0.5 transition-colors ${
        tab === id
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground/70 hover:text-foreground"
      }`}
      onClick={(event) => {
        event.stopPropagation()
        setTab(id)
      }}
    >
      {label}
    </button>
  )

  // 仅一侧有数据时按那侧落 tab，避免点到空 tab 看到空白。
  const activeTab: "status" | "buckets" = tab === "buckets" && hasBuckets ? "buckets" : "status"

  return (
    <div className="space-y-2 border-t border-border/40 pt-1.5">
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        {hasStatus && tabButton("status", "状态细分")}
        {hasBuckets && tabButton("buckets", "插件约束（Harness） vs VibeCoding")}
        <InfoHint
          hint={activeTab === "status" ? NODE_STATUS_BREAKDOWN_HINT : <StageBucketCaliberHint />}
        />
      </div>
      {activeTab === "status" ? (
        <StageStatusRows byStatus={byStatus} onOpenStatusTraces={onOpenStatusTraces} />
      ) : (
        <StageBucketRows buckets={stageBuckets} onOpenBucketTraces={onOpenBucketTraces} />
      )}
    </div>
  )
}

function FeatureStageBreakdown({
  feature,
  loadNodes,
  onOpenNodeTraces
}: {
  feature: DashboardProjectModeFeature
  loadNodes: (feature: DashboardProjectModeFeature) => Promise<DashboardProjectModeFeatureNode[]>
  onOpenNodeTraces: (
    feature: DashboardProjectModeFeature,
    node: DashboardProjectModeFeatureNode,
    status?: string,
    stageBucket?: StageBucket
  ) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [nodes, setNodes] = useState<DashboardProjectModeFeatureNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 展开时按当前面板时间范围拉取；range（→ loadNodes）变化且仍展开时自动重拉，
  // 与插件聚合的 AdapterStageBreakdown 同款，保证刷新/改日期后阶段细分同步更新。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const result = await loadNodes(feature)
        if (!cancelled) {
          setError(null)
          setNodes(result)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, feature, loadNodes])

  // 首次展开（无缓存、无错误）显示加载态；range 变化重拉时沿用旧数据直到新数据到达。
  const loading = open && nodes === null && error === null

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        阶段细分
        <InfoHint hint="按工作流节点（阶段）拆分该特性的对话与代码采纳。" />
      </button>
      {open && (
        <div className="space-y-1.5 rounded-md border border-border/60 bg-background/60 p-2">
          {loading && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              加载阶段数据…
            </div>
          )}
          {error && <div className="text-[11px] text-destructive">{error}</div>}
          {!loading && !error && nodes && nodes.length === 0 && (
            <div className="text-[11px] text-muted-foreground">暂无阶段数据</div>
          )}
          {!loading &&
            !error &&
            nodes?.map((node) => (
              <div
                key={node.nodeName}
                className="space-y-1 rounded border border-border/50 px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      阶段
                    </span>
                    <span className="font-medium">{node.nodeName}</span>
                    {node.nodeName === STAGE_BUCKET_LABELS.unattributed && (
                      <InfoHint hint={STAGE_BUCKET_HINTS.unattributed} />
                    )}
                    <span className="text-muted-foreground">
                      · {formatNumber(node.conversationCount)} 对话
                    </span>
                  </span>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                    disabled={node.conversationCount === 0}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenNodeTraces(feature, node)
                    }}
                  >
                    <MessagesSquare className="size-3.5" />
                    查看对话
                  </button>
                </div>
                <FeatureCodeStatsLine codeStats={node.codeStats} />
                <NodeBreakdownTabs
                  byStatus={node.byStatus}
                  stageBuckets={node.stageBuckets}
                  onOpenStatusTraces={(status) => onOpenNodeTraces(feature, node, status)}
                  onOpenBucketTraces={(bucket) =>
                    onOpenNodeTraces(feature, node, undefined, bucket)
                  }
                />
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function ProjectRow({
  project,
  expanded,
  onToggle,
  onOpenTraces,
  onOpenFeatureCommits,
  onOpenProjectCommits,
  loadFeatureNodes
}: {
  project: DashboardProjectModeProject
  expanded: boolean
  onToggle: () => void
  onOpenTraces: (
    feature?: DashboardProjectModeFeature,
    node?: DashboardProjectModeFeatureNode,
    status?: string,
    stageBucket?: StageBucket
  ) => void
  onOpenFeatureCommits: (feature: DashboardProjectModeFeature) => void
  onOpenProjectCommits: (pushedOnly?: boolean) => void
  loadFeatureNodes: (
    feature: DashboardProjectModeFeature
  ) => Promise<DashboardProjectModeFeatureNode[]>
}): React.JSX.Element {
  const codeStats = project.codeStats
  const hasCommitAdoption = Boolean(codeStats && codeStats.effectiveGeneratedLines > 0)
  const hasPushedAdoption = Boolean(codeStats && codeStats.pushedEffectiveGeneratedLines > 0)
  const adopted = codeStats ? formatLineCount(codeStats.adoptedLines) : "—"
  const pushedAdopted = codeStats ? formatLineCount(codeStats.pushedAdoptedLines) : "—"
  const commitDetail = codeStats
    ? `${adopted}/${formatLineCount(codeStats.effectiveGeneratedLines)}`
    : "—"
  const pushDetail = codeStats
    ? `${pushedAdopted}/${formatLineCount(codeStats.pushedEffectiveGeneratedLines)}`
    : "—"
  const totalDetail = codeStats
    ? `${adopted}/${formatLineCount(codeStats.inclusiveEffectiveGeneratedLines)}`
    : "—"
  const totalPushDetail = codeStats
    ? `${pushedAdopted}/${formatLineCount(codeStats.inclusiveEffectiveGeneratedLines)}`
    : "—"
  const commitTraceTitle = "查看采纳溯源：该项目关联的 commit 明细"
  const pushTraceTitle = "查看采纳溯源：该项目已 Push 的 commit 明细"
  const creatorName = project.creatorUserName || project.creatorSapId || project.creatorYstId || "—"
  const creatorId = project.creatorSapId || project.creatorYstId || ""
  const creatorDepartment = formatProjectCreatorDepartment(project)

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-foreground">{project.name}</span>
              </div>
              {project.systemName && (
                <div className="truncate text-[10px] text-muted-foreground">
                  {project.systemName}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {project.adapterName ? (
            <span>
              {project.adapterName}
              {project.adapterVersion ? (
                <span className="text-[10px] text-muted-foreground/70">
                  {" "}
                  {project.adapterVersion}
                </span>
              ) : null}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {lifecycleLabel(project.lifecycleStatus)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(project.featureCount)}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">
          {formatNumber(project.conversationCount)}
        </td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">
          {formatLineCount(codeStats?.generatedLines ?? 0)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <div className="flex flex-col items-end gap-0.5">
            <AdoptionRateLine
              label="提交"
              rate={codeStats?.measuredAdoptionRate ?? null}
              detail={commitDetail}
              clickable={hasCommitAdoption}
              onActivate={() => onOpenProjectCommits(false)}
              title={commitTraceTitle}
            />
            <AdoptionRateLine
              label="入库"
              rate={codeStats?.pushedAdoptionRate ?? null}
              detail={pushDetail}
              clickable={hasPushedAdoption}
              onActivate={() => onOpenProjectCommits(true)}
              title={pushTraceTitle}
            />
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <div className="flex flex-col items-end gap-0.5">
            <AdoptionRateLine
              label="提交"
              rate={codeStats?.inclusiveAdoptionRate ?? null}
              detail={totalDetail}
              clickable={hasCommitAdoption}
              onActivate={() => onOpenProjectCommits(false)}
              title={commitTraceTitle}
            />
            <AdoptionRateLine
              label="入库"
              rate={codeStats?.inclusivePushedAdoptionRate ?? null}
              detail={totalPushDetail}
              clickable={hasPushedAdoption}
              onActivate={() => onOpenProjectCommits(true)}
              title={pushTraceTitle}
            />
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="font-medium text-foreground">{creatorName}</div>
          {creatorId && creatorId !== creatorName ? (
            <div className="font-mono text-[10px] text-muted-foreground">{creatorId}</div>
          ) : null}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{creatorDepartment}</td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            disabled={project.conversationCount === 0}
            onClick={(event) => {
              event.stopPropagation()
              onOpenTraces()
            }}
          >
            <MessagesSquare className="size-3.5" />
            查看对话
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={11} className="px-3 py-3">
            <div className="space-y-3">
              {/* 常用技能（生成行数 / 采纳率已下沉到各特性行） */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">常用技能：</span>
                {project.topSkills.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <SkillChips skills={project.topSkills} />
                )}
              </div>

              {/* 流程阶段口径：插件约束（Harness）/ VibeCoding / 未归因 */}
              {!isStageBucketsEmpty(project.stageBuckets) && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span>流程阶段口径：插件约束（Harness） vs VibeCoding</span>
                    <InfoHint hint={<StageBucketCaliberHint />} />
                  </div>
                  <StageBucketSplit buckets={project.stageBuckets} />
                </div>
              )}

              {/* 特性状态 + 各特性采纳明细 + 关联 commit */}
              {project.features.length === 0 ? (
                <div className="text-xs text-muted-foreground">该项目暂无特性记录</div>
              ) : (
                <div className="space-y-2">
                  {project.features.map((feature) => (
                    <div
                      key={feature.slug || feature.title}
                      className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{feature.title}</span>
                          {feature.statusLabel && (
                            <Badge variant="outline" className="normal-case tracking-normal">
                              {feature.statusLabel}
                            </Badge>
                          )}
                          {feature.currentNodeStatusLabel && (
                            <span className="text-muted-foreground">
                              当前节点：{feature.currentNodeStatusLabel}
                            </span>
                          )}
                          {feature.summary && (
                            <span
                              className="truncate text-muted-foreground"
                              title={feature.summary}
                            >
                              · {feature.summary}
                            </span>
                          )}
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-3">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                            disabled={!feature.slug}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenFeatureCommits(feature)
                            }}
                          >
                            <GitCommit className="size-3.5" />
                            Commit 记录
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                            disabled={!feature.slug}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenTraces(feature)
                            }}
                          >
                            <MessagesSquare className="size-3.5" />
                            查看对话
                          </button>
                        </div>
                      </div>
                      <FeatureCodeStatsLine codeStats={feature.codeStats} />
                      {feature.slug && (
                        <FeatureStageBreakdown
                          feature={feature}
                          loadNodes={loadFeatureNodes}
                          onOpenNodeTraces={(f, node, status, stageBucket) =>
                            onOpenTraces(f, node, status, stageBucket)
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function SkillChips({ skills }: { skills: DashboardProjectModeSkillCount[] }): React.JSX.Element {
  return (
    <>
      {skills.map((item) => (
        <Badge key={item.skill} variant="outline" className="normal-case tracking-normal">
          {item.skill} · {formatNumber(item.count)}
        </Badge>
      ))}
    </>
  )
}

const PROJECT_PAGE_SIZE = 10
const ADAPTER_PAGE_SIZE = 10
const ALL_ADAPTERS_VALUE = "__all_adapters__"

type ProjectListTab = "active" | "archived"

function ProjectListSearchInput({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn("relative w-full", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-md border-border bg-background pl-8 pr-8 text-xs"
      />
      {value ? (
        <button
          type="button"
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => onChange("")}
          aria-label={`清空${placeholder}`}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/** 可排序表头单元格：未启用时退化为普通 <th>，启用时显示排序箭头并响应点击。 */
function SortableTh({
  label,
  sortKey,
  activeKey,
  order,
  enabled,
  onSort,
  title
}: {
  label: string
  sortKey: DashboardProjectModeProjectSortKey
  activeKey: DashboardProjectModeProjectSortKey | null
  order: DashboardProjectModeProjectSortOrder
  enabled: boolean
  onSort: (key: DashboardProjectModeProjectSortKey) => void
  title?: string
}): React.JSX.Element {
  if (!enabled) {
    return (
      <th className="px-3 py-2 text-right font-medium" title={title}>
        {label}
      </th>
    )
  }
  const active = activeKey === sortKey
  const Icon = active ? (order === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className="px-3 py-2 text-right font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title ?? `按${label}排序`}
        className={cn(
          "ml-auto inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span>{label}</span>
        <Icon className={cn("size-3", active ? "opacity-100" : "opacity-40")} />
      </button>
    </th>
  )
}

/**
 * 项目列表：进行中 / 已归档双 tab + 项目名搜索 + 后端分页。
 * 默认随项目模式总览返回「进行中」第一页，已归档 tab 首次切换时懒加载。
 */
function ProjectListSection({
  projectCounts,
  projectPages,
  adapterOptions,
  pageLoading,
  pageError,
  loading,
  onPageChange,
  onOpenTraces,
  onOpenFeatureCommits,
  onOpenProjectCommits,
  loadFeatureNodes,
  lockedAdapterName
}: {
  projectCounts?: DashboardProjectModeProjectCounts
  projectPages: Partial<
    Record<DashboardProjectModeProjectStatus, DashboardProjectModeProjectPageData>
  >
  adapterOptions: string[]
  pageLoading: Record<DashboardProjectModeProjectStatus, boolean>
  pageError: Partial<Record<DashboardProjectModeProjectStatus, string>>
  loading: boolean
  onPageChange: (
    status: DashboardProjectModeProjectStatus,
    page: number,
    keyword: string,
    pageSize: number,
    adapterName: string,
    creatorKeyword: string,
    creatorOrgKeyword: string,
    sortBy?: DashboardProjectModeProjectSortKey | null,
    sortOrder?: DashboardProjectModeProjectSortOrder
  ) => void
  onOpenTraces: (
    project: DashboardProjectModeProject,
    feature?: DashboardProjectModeFeature,
    node?: DashboardProjectModeFeatureNode,
    status?: string,
    stageBucket?: StageBucket
  ) => void
  onOpenFeatureCommits: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => void
  onOpenProjectCommits: (project: DashboardProjectModeProject, pushedOnly?: boolean) => void
  loadFeatureNodes: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => Promise<DashboardProjectModeFeatureNode[]>
  /** 嵌入模式：锁定到该插件名（隐藏标题与插件下拉，强制按此插件过滤）。用于插件「项目数」弹窗。 */
  lockedAdapterName?: string
}): React.JSX.Element {
  const embedded = lockedAdapterName != null
  const [tab, setTab] = useState<ProjectListTab>("active")
  const [query, setQuery] = useState("")
  const [creatorQuery, setCreatorQuery] = useState("")
  const [departmentQuery, setDepartmentQuery] = useState("")
  const [adapterName, setAdapterName] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // null = 用所在 tab 的默认排序；非空 = 用户显式选择。
  const [sortBy, setSortBy] = useState<DashboardProjectModeProjectSortKey | null>(null)
  const [sortOrder, setSortOrder] = useState<DashboardProjectModeProjectSortOrder>("desc")

  const trimmed = query.trim()
  const creatorKeyword = creatorQuery.trim()
  const creatorOrgKeyword = departmentQuery.trim()
  const rawSelectedAdapter = adapterName.trim()
  const selectedAdapter = embedded
    ? (lockedAdapterName ?? "")
    : adapterOptions.includes(rawSelectedAdapter)
      ? rawSelectedAdapter
      : ""
  // 对话数 / 原始生成行数 排序仅在「进行中」开放（归档项目量大，按指标全量排序代价高）。
  const metricSortAllowed = tab === "active"
  // 各 tab 默认排序：进行中→对话数降序；已归档→归档时间降序。
  const tabDefaultSort: {
    key: DashboardProjectModeProjectSortKey
    order: DashboardProjectModeProjectSortOrder
  } =
    tab === "archived"
      ? { key: "archivedAt", order: "desc" }
      : { key: "conversationCount", order: "desc" }
  const sortKeyApplicable = (key: DashboardProjectModeProjectSortKey): boolean =>
    key === "featureCount" ? true : key === "archivedAt" ? tab === "archived" : metricSortAllowed
  const useExplicitSort = sortBy !== null && sortKeyApplicable(sortBy)
  const effectiveSortBy = useExplicitSort ? sortBy : tabDefaultSort.key
  const effectiveSortOrder = useExplicitSort ? sortOrder : tabDefaultSort.order
  const pageData = projectPages[tab]
  const currentError = pageError[tab]
  const tabCount =
    tab === "archived" ? (projectCounts?.archived ?? 0) : (projectCounts?.active ?? 0)
  const pageMatchesQuery = pageData?.keyword === trimmed
  const pageMatchesAdapter = (pageData?.adapterName ?? "") === selectedAdapter
  const pageMatchesCreator = (pageData?.creatorKeyword ?? "") === creatorKeyword
  const pageMatchesCreatorOrg = (pageData?.creatorOrgKeyword ?? "") === creatorOrgKeyword
  const pageMatchesSort =
    (pageData?.sortBy ?? null) === effectiveSortBy &&
    (pageData?.sortOrder ?? "desc") === effectiveSortOrder
  const pageMatchesFilter =
    pageMatchesQuery &&
    pageMatchesAdapter &&
    pageMatchesCreator &&
    pageMatchesCreatorOrg &&
    pageMatchesSort
  const pageItems = pageMatchesFilter ? (pageData?.projects ?? []) : []
  const total = pageMatchesFilter ? (pageData?.total ?? 0) : 0
  const totalPages = Math.max(1, Math.ceil(total / PROJECT_PAGE_SIZE))
  const currentPage = Math.min(pageData?.page ?? 1, totalPages)
  const effectiveLoading =
    loading ||
    pageLoading[tab] ||
    (!pageData && tabCount > 0) ||
    Boolean(pageData && !pageMatchesFilter)
  const hasTextFilter = Boolean(trimmed || creatorKeyword || creatorOrgKeyword)
  const emptyText = hasTextFilter
    ? "未找到匹配的项目"
    : selectedAdapter
      ? "暂无该插件的项目"
      : tab === "archived"
        ? "暂无已归档项目"
        : "暂无进行中项目"

  useEffect(() => {
    // keyword / adapter / creator / department / pageSize 已匹配即视为同步；不再要求停在第 1 页，
    // 否则用户翻到第 2 页后 pageData 变化会触发本 effect 把页码弹回第 1 页。
    if (
      pageData &&
      pageData.keyword === trimmed &&
      (pageData.adapterName ?? "") === selectedAdapter &&
      (pageData.creatorKeyword ?? "") === creatorKeyword &&
      (pageData.creatorOrgKeyword ?? "") === creatorOrgKeyword &&
      pageData.pageSize === PROJECT_PAGE_SIZE &&
      (pageData.sortBy ?? null) === effectiveSortBy &&
      (pageData.sortOrder ?? "desc") === effectiveSortOrder
    ) {
      return
    }
    if (pageLoading[tab]) return
    const timer = window.setTimeout(() => {
      setExpandedId(null)
      onPageChange(
        tab,
        1,
        trimmed,
        PROJECT_PAGE_SIZE,
        selectedAdapter,
        creatorKeyword,
        creatorOrgKeyword,
        effectiveSortBy,
        effectiveSortOrder
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [
    creatorKeyword,
    creatorOrgKeyword,
    effectiveSortBy,
    effectiveSortOrder,
    onPageChange,
    pageData,
    pageLoading,
    selectedAdapter,
    tab,
    trimmed
  ])

  const switchTab = (next: ProjectListTab): void => {
    // 不重置排序态：归档 tab 由 effectiveSortBy 自动忽略指标排序，
    // 切回进行中时仍恢复原排序（含默认的对话数降序）。
    setTab(next)
    setExpandedId(null)
  }
  const changeQuery = (value: string): void => {
    setQuery(value)
  }
  const changeAdapterName = (value: string): void => {
    setAdapterName(value === ALL_ADAPTERS_VALUE ? "" : value)
  }
  const requestPage = (nextPage: number): void => {
    setExpandedId(null)
    onPageChange(
      tab,
      nextPage,
      trimmed,
      PROJECT_PAGE_SIZE,
      selectedAdapter,
      creatorKeyword,
      creatorOrgKeyword,
      effectiveSortBy,
      effectiveSortOrder
    )
  }
  // 点击表头切换排序：未生效→降序；降序→升序；升序→取消（回到该 tab 默认排序）。
  const cycleSort = (key: DashboardProjectModeProjectSortKey): void => {
    setExpandedId(null)
    if (effectiveSortBy !== key) {
      setSortBy(key)
      setSortOrder("desc")
      return
    }
    if (effectiveSortOrder === "desc") {
      setSortBy(key)
      setSortOrder("asc")
      return
    }
    setSortBy(null)
    setSortOrder("desc")
  }

  const tabs: Array<{ id: ProjectListTab; label: string; count: number }> = [
    { id: "active", label: "进行中", count: projectCounts?.active ?? 0 },
    { id: "archived", label: "已归档", count: projectCounts?.archived ?? 0 }
  ]

  return (
    <section>
      {!embedded && (
        <>
          <h2 className="mb-1 text-sm font-semibold text-foreground">项目列表</h2>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            项目、插件、项目状态、特性数为当前状态；对话数、原始生成行数、提交、总量两口径采纳率，以及展开行的技能、各特性采纳明细与关联
            Commit 按所选时间范围统计。
          </p>
        </>
      )}

      {pageData?.truncated && pageMatchesFilter && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            匹配的项目数量过多，已超过单次统计上限。列表排序与「对话数 /
            原始生成行数」等指标仅基于上限内的项目，可能不完整。请用上方的项目名称、创建人、部门或插件筛选缩小范围后再查看。
          </span>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2 overflow-x-auto px-1 py-1">
        <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              onClick={() => switchTab(t.id)}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        {!embedded && (
          <Select value={selectedAdapter || ALL_ADAPTERS_VALUE} onValueChange={changeAdapterName}>
            <SelectTrigger className="h-8 w-[180px] shrink-0 rounded-md border-border bg-background text-xs">
              <SelectValue placeholder="按插件筛选" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ADAPTERS_VALUE}>全部插件</SelectItem>
              {adapterOptions.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ProjectListSearchInput
            value={query}
            onChange={changeQuery}
            placeholder="搜索项目名称"
            className="w-[220px] shrink-0"
          />
          <ProjectListSearchInput
            value={creatorQuery}
            onChange={setCreatorQuery}
            placeholder="搜索创建人"
            className="w-[180px] shrink-0"
          />
          <ProjectListSearchInput
            value={departmentQuery}
            onChange={setDepartmentQuery}
            placeholder="搜索部门"
            className="w-[180px] shrink-0"
          />
        </div>
      </div>

      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card",
          effectiveLoading && "opacity-70"
        )}
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">项目</th>
              <th className="px-3 py-2 text-left font-medium">插件</th>
              <th className="px-3 py-2 text-left font-medium">项目状态</th>
              <SortableTh
                label="特性数"
                sortKey="featureCount"
                activeKey={effectiveSortBy}
                order={sortOrder}
                enabled
                onSort={cycleSort}
              />
              <SortableTh
                label="对话数"
                sortKey="conversationCount"
                activeKey={effectiveSortBy}
                order={sortOrder}
                enabled={metricSortAllowed}
                onSort={cycleSort}
              />
              <SortableTh
                label="原始生成行数"
                sortKey="generatedLines"
                activeKey={effectiveSortBy}
                order={sortOrder}
                enabled={metricSortAllowed}
                onSort={cycleSort}
                title="Agent 原始生成行数（未经去重/抵消的原始产出）"
              />
              <th className="px-3 py-2 text-right font-medium">提交口径采纳率</th>
              <th className="px-3 py-2 text-right font-medium">总量口径采纳率</th>
              <th className="px-3 py-2 text-left font-medium">创建人</th>
              <th className="px-3 py-2 text-left font-medium">部门</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((project) => (
              <ProjectRow
                key={project.projectId}
                project={project}
                expanded={expandedId === project.projectId}
                onToggle={() =>
                  setExpandedId((prev) => (prev === project.projectId ? null : project.projectId))
                }
                onOpenTraces={(feature, node, status, stageBucket) =>
                  onOpenTraces(project, feature, node, status, stageBucket)
                }
                onOpenFeatureCommits={(feature) => onOpenFeatureCommits(project, feature)}
                onOpenProjectCommits={(pushedOnly) => onOpenProjectCommits(project, pushedOnly)}
                loadFeatureNodes={(feature) => loadFeatureNodes(project, feature)}
              />
            ))}
            {effectiveLoading && pageItems.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    加载项目中...
                  </span>
                </td>
              </tr>
            )}
            {!effectiveLoading && currentError && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-destructive">
                  {currentError}
                </td>
              </tr>
            )}
            {pageItems.length > 0 &&
              Array.from({ length: PROJECT_PAGE_SIZE - pageItems.length }).map((_, i) => (
                <tr key={`filler-${i}`} aria-hidden className="border-b border-border/50">
                  <td colSpan={11} className="h-[49px]" />
                </tr>
              ))}
            {!effectiveLoading && !currentError && pageItems.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!effectiveLoading && !currentError && total > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span>共 {formatNumber(total)} 个</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={currentPage <= 1}
                onClick={() => requestPage(currentPage - 1)}
              >
                上一页
              </button>
              <span>
                第 {currentPage} / {totalPages} 页
              </span>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={currentPage >= totalPages}
                onClick={() => requestPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

type AdapterListMode = "byName" | "byVersion"

function adoptionRate(adopted: number, generated: number): number | null {
  return generated > 0 ? adopted / generated : null
}

/** 合并同名插件不同版本的代码采纳明细，按行数累加后重算采纳率。 */
function mergeCodeStats(
  items: Array<DashboardCodeStats | null | undefined>
): DashboardCodeStats | null {
  const valid = items.filter((s): s is DashboardCodeStats => Boolean(s))
  if (valid.length === 0) return null
  const sum = (pick: (s: DashboardCodeStats) => number): number =>
    valid.reduce((acc, s) => acc + pick(s), 0)
  const generatedLines = sum((s) => s.generatedLines)
  const deletedLines = sum((s) => s.deletedLines)
  const effectiveGeneratedLines = sum((s) => s.effectiveGeneratedLines)
  const measuredGeneratedLines = sum((s) => s.measuredGeneratedLines)
  const unmeasuredGeneratedLines = sum((s) => s.unmeasuredGeneratedLines)
  const inclusiveEffectiveGeneratedLines = sum((s) => s.inclusiveEffectiveGeneratedLines)
  const adoptedLines = sum((s) => s.adoptedLines)
  const pushedMeasuredGeneratedLines = sum((s) => s.pushedMeasuredGeneratedLines)
  const pushedEffectiveGeneratedLines = sum((s) => s.pushedEffectiveGeneratedLines)
  const pushedAdoptedLines = sum((s) => s.pushedAdoptedLines)
  const pushedCommitCount = sum((s) => s.pushedCommitCount)
  const measuredAdoptionRate = adoptionRate(adoptedLines, effectiveGeneratedLines)
  return {
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    unmeasuredGeneratedLines,
    inclusiveEffectiveGeneratedLines,
    adoptedLines,
    pushedMeasuredGeneratedLines,
    pushedEffectiveGeneratedLines,
    pushedAdoptedLines,
    pushedCommitCount,
    measuredAdoptionRate,
    inclusiveAdoptionRate: adoptionRate(adoptedLines, inclusiveEffectiveGeneratedLines),
    pushedAdoptionRate: adoptionRate(pushedAdoptedLines, pushedEffectiveGeneratedLines),
    inclusivePushedAdoptionRate: adoptionRate(pushedAdoptedLines, inclusiveEffectiveGeneratedLines),
    adoptionRate: measuredAdoptionRate
  }
}

/** 合并多份 stage×skill 三桶：逐桶累加对话数、合并代码采纳明细。 */
function mergeStageBuckets(items: DashboardStageBuckets[]): DashboardStageBuckets {
  const mergeOne = (
    pick: (b: DashboardStageBuckets) => DashboardStageBucketStat
  ): DashboardStageBucketStat => ({
    conversationCount: items.reduce((acc, b) => acc + pick(b).conversationCount, 0),
    codeStats: mergeCodeStats(items.map((b) => pick(b).codeStats))
  })
  return {
    pluginConstrained: mergeOne((b) => b.pluginConstrained),
    vibecoding: mergeOne((b) => b.vibecoding),
    unattributed: mergeOne((b) => b.unattributed)
  }
}

/** 按插件名聚合：累加项目/特性/对话数，合并代码采纳明细与流程阶段三桶。 */
function aggregateAdaptersByName(
  adapters: DashboardProjectModeAdapter[]
): DashboardProjectModeAdapter[] {
  const map = new Map<string, DashboardProjectModeAdapter[]>()
  for (const adapter of adapters) {
    const list = map.get(adapter.name)
    if (list) list.push(adapter)
    else map.set(adapter.name, [adapter])
  }
  const result: DashboardProjectModeAdapter[] = []
  for (const [name, group] of map) {
    result.push({
      name,
      version: undefined,
      projectCount: group.reduce((acc, a) => acc + a.projectCount, 0),
      featureCount: group.reduce((acc, a) => acc + a.featureCount, 0),
      conversationCount: group.reduce((acc, a) => acc + a.conversationCount, 0),
      codeStats: mergeCodeStats(group.map((a) => a.codeStats)),
      stageBuckets: mergeStageBuckets(group.map((a) => a.stageBuckets))
    })
  }
  return result
}

/** 插件市场补充信息：场景（category）、负责人、负责人部门，均来自市场 API。 */
interface PluginMarketInfo {
  useScenario: string
  managerName: string
  managerDepartment: string
}

const OTHER_ADAPTER_SCENARIO = "其他类别"

/** DEV mock：本地市场 API 不可达，按 makeMockProjectMode 的插件名提供示例市场信息，便于联调展示。 */
const DEV_MOCK_PLUGIN_MARKET_INFO: Record<string, PluginMarketInfo> = {
  "claude-code": {
    useScenario: "研发类场景/应用类研发",
    managerName: "张三",
    managerDepartment: "信息研发部/架构组"
  },
  codex: {
    useScenario: "通用场景",
    managerName: "李四",
    managerDepartment: "零售金融部/渠道研发组"
  }
}

/**
 * 用 item.user_id（上传者 SAP id）到全量用户目录解析 {负责人, 部门}。
 * 负责人/部门并不在插件列表响应里——应用市场与 Harness 看板都是靠 user_id 二次查
 * queryAllUser 拿到的，这里复用同一口径（queryAllUser + buildUploaderIdCandidates）。
 */
async function resolvePluginUploaderProfiles(
  items: MarketItem[]
): Promise<Map<string, { userName: string; orgName: string }>> {
  const result = new Map<string, { userName: string; orgName: string }>()
  const rawUserIds = Array.from(
    new Set(items.map((item) => item.user_id?.trim() || "").filter(Boolean))
  )
  if (rawUserIds.length === 0) return result
  if (typeof window.api?.dashboard?.queryAllUser !== "function") return result
  try {
    const response = await window.api.dashboard.queryAllUser()
    if (!response.success || !response.data) return result
    const allUsers = response.data.filter((user) => user.sapId?.trim())
    for (const rawUserId of rawUserIds) {
      const lookupIds = buildUploaderIdCandidates(rawUserId)
      const target = allUsers.find((user) =>
        lookupIds.some((lookupId) => user.sapId.includes(lookupId))
      )
      if (!target) continue
      result.set(rawUserId, {
        userName: target.userName,
        orgName: formatTopUserOrgName(
          target.orgName || "",
          target.upperOrgLv1 || "",
          target.upperOrgLv0 || ""
        )
      })
    }
    return result
  } catch (error) {
    console.warn("[ProjectModePanel] Failed to resolve plugin uploader profiles:", error)
    return result
  }
}

/** 拉取一次市场插件信息，按插件名建立 name → {场景, 负责人, 部门} 映射。市场不可用时静默降级为空。 */
function usePluginMarketInfo(): Map<string, PluginMarketInfo> {
  const [infoMap, setInfoMap] = useState<Map<string, PluginMarketInfo>>(new Map())
  useEffect(() => {
    let cancelled = false
    // DEV：市场 API 通常不可达，直接使用 mock，无需发请求。
    if (import.meta.env.DEV) {
      setInfoMap(new Map(Object.entries(DEV_MOCK_PLUGIN_MARKET_INFO)))
      return
    }
    void (async () => {
      const res = await marketApi
        .getPlugins({ allowMockOnError: false, silent: true })
        .catch(() => null)
      if (cancelled || !res?.success || !res.data) return
      // 负责人/部门要靠 user_id 二次解析，场景（category）则直接来自列表响应。
      const profiles = await resolvePluginUploaderProfiles(res.data)
      if (cancelled) return
      const next = new Map<string, PluginMarketInfo>()
      for (const item of res.data) {
        const name = item.name?.trim()
        if (!name) continue
        const profile = item.user_id ? profiles.get(item.user_id.trim()) : undefined
        next.set(name, {
          useScenario: item.category?.trim() || OTHER_ADAPTER_SCENARIO,
          managerName: profile?.userName || "",
          managerDepartment: profile?.orgName || ""
        })
      }
      setInfoMap(next)
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return infoMap
}

/**
 * 插件行内「阶段细分」：懒加载该插件跨用户的按阶段（工作流节点）对话数 + 代码采纳，
 * 跟随面板所选时间范围（range 改变 → loadAggregate 标识变化，展开中会自动重拉）。
 * 已在项目运营概览内（已具备项目模式权限），无需再做权限门禁。阶段归因前向生效，
 * 更早会话不带 nodeId。
 */
function AdapterStageBreakdown({
  adapterName,
  loadAggregate
}: {
  adapterName: string
  loadAggregate: (adapterName: string) => Promise<DashboardProjectModeFeatureNode[]>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [nodes, setNodes] = useState<DashboardProjectModeFeatureNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 展开时按当前面板时间范围拉取；range（→ loadAggregate）变化且仍展开时自动重拉。
  // 不在首个 await 前 setState（满足 react-hooks/set-state-in-effect）；loading 由状态派生。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const result = await loadAggregate(adapterName)
        if (!cancelled) {
          setError(null)
          setNodes(result)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, adapterName, loadAggregate])

  // 首次展开（无缓存、无错误）显示加载态；range 变化重拉时沿用旧数据直到新数据到达。
  const loading = open && nodes === null && error === null

  return (
    <div className="space-y-1.5 pl-5">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        阶段细分
        <InfoHint hint="按工作流节点（阶段）拆分该插件的对话与代码采纳，跨用户，跟随面板所选时间范围。" />
      </button>
      {open && (
        <div className="space-y-1.5 rounded-md border border-border/60 bg-background/60 p-2">
          {loading && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              加载阶段数据…
            </div>
          )}
          {error && <div className="text-[11px] text-destructive">{error}</div>}
          {!loading && !error && nodes && nodes.length === 0 && (
            <div className="text-[11px] text-muted-foreground">暂无阶段数据</div>
          )}
          {!loading &&
            !error &&
            nodes?.map((node) => (
              <div
                key={node.nodeName}
                className="space-y-1 rounded border border-border/50 px-2 py-1.5"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    阶段
                  </span>
                  <span className="font-medium">{node.nodeName}</span>
                  <span className="text-muted-foreground">
                    · {formatNumber(node.conversationCount)} 对话
                  </span>
                </span>
                <FeatureCodeStatsLine codeStats={node.codeStats} />
                <NodeBreakdownTabs byStatus={node.byStatus} stageBuckets={node.stageBuckets} />
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function AdapterListSection({
  adapters,
  loadPluginAggregate,
  fetchAdapterProjectPage,
  onOpenTraces,
  onOpenFeatureCommits,
  onOpenProjectCommits,
  loadFeatureNodes
}: {
  adapters: DashboardProjectModeAdapter[]
  loadPluginAggregate: (adapterName: string) => Promise<DashboardProjectModeFeatureNode[]>
  fetchAdapterProjectPage: (
    options: DashboardProjectModeProjectPageOptions
  ) => Promise<DashboardProjectModeProjectPageData>
  onOpenTraces: (
    project: DashboardProjectModeProject,
    feature?: DashboardProjectModeFeature,
    node?: DashboardProjectModeFeatureNode,
    status?: string,
    stageBucket?: StageBucket
  ) => void
  onOpenFeatureCommits: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => void
  onOpenProjectCommits: (project: DashboardProjectModeProject, pushedOnly?: boolean) => void
  loadFeatureNodes: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => Promise<DashboardProjectModeFeatureNode[]>
}): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [mode, setMode] = useState<AdapterListMode>("byName")
  // 点击插件「项目数」弹出的项目列表对应的插件（含版本，byName 模式 version 为空 = 全部版本）；null = 关闭。
  const [projectsForAdapter, setProjectsForAdapter] = useState<AdapterProjectsTarget | null>(null)
  const marketInfo = usePluginMarketInfo()
  // 过滤掉对话数与生成代码行数都为 0 的插件（无实际使用，不展示）。
  const hasAdapterActivity = (a: DashboardProjectModeAdapter): boolean =>
    a.conversationCount > 0 || (a.codeStats?.generatedLines ?? 0) > 0
  const versionList = adapters.filter(hasAdapterActivity)
  const aggregatedByName = aggregateAdaptersByName(adapters).filter(hasAdapterActivity)
  const versionCount = versionList.length
  const baseList = mode === "byName" ? aggregatedByName : versionList
  // 优先展示能在插件市场匹配上的插件（marketInfo 命中），其次再按项目数降序。
  const sortedAdapters = [...baseList].sort((a, b) => {
    const aMatched = marketInfo.has(a.name) ? 1 : 0
    const bMatched = marketInfo.has(b.name) ? 1 : 0
    return (
      bMatched - aMatched ||
      b.projectCount - a.projectCount ||
      b.conversationCount - a.conversationCount ||
      a.name.localeCompare(b.name) ||
      (a.version ?? "").localeCompare(b.version ?? "")
    )
  })
  const totalPages = Math.max(1, Math.ceil(sortedAdapters.length / ADAPTER_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = sortedAdapters.slice(
    (currentPage - 1) * ADAPTER_PAGE_SIZE,
    currentPage * ADAPTER_PAGE_SIZE
  )

  const modeTabs: Array<{ id: AdapterListMode; label: string; count: number }> = [
    { id: "byName", label: "按插件", count: aggregatedByName.length },
    { id: "byVersion", label: "按版本", count: versionCount }
  ]

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-foreground">插件列表</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {mode === "byName"
          ? "按插件名聚合同名插件的多个版本；优先展示能在插件市场匹配的插件，再按项目数降序排列，项目数为当前状态，对话数、提交、总量两口径采纳率按所选时间范围统计。"
          : "按插件版本展开；优先展示能在插件市场匹配的插件，再按项目数降序排列，项目数为当前状态，对话数、提交、总量两口径采纳率按所选时间范围统计。"}
      </p>
      <div className="mb-3 flex items-center overflow-hidden rounded-md border border-border w-fit">
        {modeTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              mode === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => {
              setMode(t.id)
              setPage(1)
            }}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card">
        {sortedAdapters.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无数据</div>
        ) : (
          <>
            <div className="divide-y divide-border">
              {pageItems.map((adapter) => {
                const info = marketInfo.get(adapter.name)
                return (
                  <div
                    key={`${adapter.name}@${adapter.version ?? ""}`}
                    className="space-y-2 px-4 py-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium text-foreground">
                            {adapter.name}
                          </span>
                          {adapter.version && (
                            <Badge variant="outline" className="normal-case tracking-normal">
                              {adapter.version}
                            </Badge>
                          )}
                          {info?.useScenario && (
                            <Badge
                              variant="secondary"
                              className="shrink-0 normal-case tracking-normal"
                            >
                              {info.useScenario}
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-5 text-[11px] text-muted-foreground">
                          <span>负责人：{info?.managerName || "—"}</span>
                          <span>部门：{info?.managerDepartment || "—"}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                        {adapter.projectCount > 0 ? (
                          <button
                            type="button"
                            className="group -mx-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-primary/10"
                            title="查看该插件下的项目列表"
                            onClick={(event) => {
                              event.stopPropagation()
                              setProjectsForAdapter({
                                name: adapter.name,
                                version: adapter.version,
                                projectCount: adapter.projectCount
                              })
                            }}
                          >
                            <span className="text-muted-foreground">项目</span>
                            <span className="font-semibold text-primary underline decoration-dotted underline-offset-2 group-hover:decoration-solid">
                              {formatNumber(adapter.projectCount)}
                            </span>
                            <ChevronRight className="size-3 text-primary/70 transition-transform group-hover:translate-x-0.5" />
                          </button>
                        ) : (
                          <span>
                            项目{" "}
                            <span className="font-medium text-foreground">
                              {formatNumber(adapter.projectCount)}
                            </span>
                          </span>
                        )}
                        <span>
                          特性{" "}
                          <span className="font-medium text-foreground">
                            {formatNumber(adapter.featureCount)}
                          </span>
                        </span>
                        <span>
                          对话{" "}
                          <span className="font-medium text-foreground">
                            {formatNumber(adapter.conversationCount)}
                          </span>
                        </span>
                        <span>
                          <span className="text-muted-foreground/70">提交口径</span> 提交{" "}
                          <span className="font-medium text-foreground">
                            {formatPercent(adapter.codeStats?.measuredAdoptionRate)}
                          </span>{" "}
                          · 入库{" "}
                          <span className="font-medium text-foreground">
                            {formatPercent(adapter.codeStats?.pushedAdoptionRate)}
                          </span>
                        </span>
                        <span>
                          <span className="text-muted-foreground/70">总量口径</span> 提交{" "}
                          <span className="font-medium text-foreground">
                            {formatPercent(adapter.codeStats?.inclusiveAdoptionRate)}
                          </span>{" "}
                          · 入库{" "}
                          <span className="font-medium text-foreground">
                            {formatPercent(adapter.codeStats?.inclusivePushedAdoptionRate)}
                          </span>
                        </span>
                      </div>
                    </div>
                    {/* 流程阶段口径：插件约束（Harness）/ VibeCoding / 未归因 */}
                    {!isStageBucketsEmpty(adapter.stageBuckets) && (
                      <div className="border-t border-border/40 pt-2">
                        <StageBucketSplit buckets={adapter.stageBuckets} />
                      </div>
                    )}
                    <AdapterStageBreakdown
                      adapterName={adapter.name}
                      loadAggregate={loadPluginAggregate}
                    />
                  </div>
                )
              })}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <span>共 {formatNumber(sortedAdapters.length)} 个</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  上一页
                </button>
                <span>
                  第 {currentPage} / {totalPages} 页
                </span>
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <AdapterProjectsDialog
        target={projectsForAdapter}
        onClose={() => setProjectsForAdapter(null)}
        fetchPage={fetchAdapterProjectPage}
        onOpenTraces={onOpenTraces}
        onOpenFeatureCommits={onOpenFeatureCommits}
        onOpenProjectCommits={onOpenProjectCommits}
        loadFeatureNodes={loadFeatureNodes}
      />
    </section>
  )
}

interface AdapterProjectsTarget {
  name: string
  version?: string
  /** 该插件（或版本）当前项目总数，用于弹窗首屏加载态与 tab 计数兜底。 */
  projectCount: number
}

interface AdapterProjectsDialogHandlers {
  fetchPage: (
    options: DashboardProjectModeProjectPageOptions
  ) => Promise<DashboardProjectModeProjectPageData>
  onOpenTraces: (
    project: DashboardProjectModeProject,
    feature?: DashboardProjectModeFeature,
    node?: DashboardProjectModeFeatureNode,
    status?: string,
    stageBucket?: StageBucket
  ) => void
  onOpenFeatureCommits: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => void
  onOpenProjectCommits: (project: DashboardProjectModeProject, pushedOnly?: boolean) => void
  loadFeatureNodes: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => Promise<DashboardProjectModeFeatureNode[]>
}

/**
 * 点击插件「项目数」弹出的弹窗：直接复用「项目列表」（ProjectListSection）锁定到该插件，
 * 功能与上方主列表一致（双 tab / 搜索 / 排序 / 分页 / 展开行的特性·阶段·Commit·查看对话）。
 */
function AdapterProjectsDialog({
  target,
  onClose,
  ...handlers
}: {
  /** 当前点击的插件（含版本）；null = 关闭。byName 模式 version 为空 = 全部版本。 */
  target: AdapterProjectsTarget | null
  onClose: () => void
} & AdapterProjectsDialogHandlers): React.JSX.Element {
  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-[95vw] max-w-[1400px] flex-col">
        <DialogHeader>
          <DialogTitle>
            插件「{target?.name}」
            {target?.version ? (
              <span className="text-muted-foreground">@{target.version}</span>
            ) : null}{" "}
            关联项目
          </DialogTitle>
        </DialogHeader>
        {target ? (
          // 按「插件名@版本」重挂，切换插件/版本时彻底重置内部 tab/搜索/分页与本地缓存。
          <AdapterProjectsDialogBody
            key={`${target.name}@${target.version ?? ""}`}
            target={target}
            {...handlers}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** 弹窗内容：自管整页缓存 + 锁定插件的 onPageChange，渲染嵌入式 ProjectListSection。 */
function AdapterProjectsDialogBody({
  target,
  fetchPage,
  onOpenTraces,
  onOpenFeatureCommits,
  onOpenProjectCommits,
  loadFeatureNodes
}: { target: AdapterProjectsTarget } & AdapterProjectsDialogHandlers): React.JSX.Element {
  const [pages, setPages] = useState<
    Partial<Record<DashboardProjectModeProjectStatus, DashboardProjectModeProjectPageData>>
  >({})
  const [pageLoading, setPageLoading] = useState<
    Record<DashboardProjectModeProjectStatus, boolean>
  >({ active: false, archived: false })
  const [pageError, setPageError] = useState<
    Partial<Record<DashboardProjectModeProjectStatus, string>>
  >({})

  const handlePageChange = useCallback(
    (
      status: DashboardProjectModeProjectStatus,
      page: number,
      keyword: string,
      pageSize: number,
      _adapterName: string,
      creatorKeyword: string,
      creatorOrgKeyword: string,
      sortBy?: DashboardProjectModeProjectSortKey | null,
      sortOrder?: DashboardProjectModeProjectSortOrder
    ) => {
      setPageLoading((prev) => ({ ...prev, [status]: true }))
      setPageError((prev) => ({ ...prev, [status]: undefined }))
      // 锁定到该插件 + 版本（忽略组件传入的 _adapterName，恒用 target）。
      fetchPage({
        status,
        page,
        pageSize,
        keyword,
        adapterName: target.name,
        adapterVersion: target.version,
        creatorKeyword,
        creatorOrgKeyword,
        sortBy,
        sortOrder
      })
        .then((data) => setPages((prev) => ({ ...prev, [status]: data })))
        .catch((e) =>
          setPageError((prev) => ({
            ...prev,
            [status]: e instanceof Error ? e.message : String(e)
          }))
        )
        .finally(() => setPageLoading((prev) => ({ ...prev, [status]: false })))
    },
    [fetchPage, target.name, target.version]
  )

  // tab 计数：已加载用整页 total，未加载兜底用插件项目总数（保证首屏显示加载态而非空表）。
  const projectCounts: DashboardProjectModeProjectCounts = {
    total: target.projectCount,
    active: pages.active?.total ?? target.projectCount,
    archived: pages.archived?.total ?? 0,
    totalFeatureCount: 0,
    activeFeatureCount: 0,
    archivedFeatureCount: 0
  }

  return (
    <div className="-mx-1 min-h-0 flex-1 overflow-auto px-1">
      <ProjectListSection
        projectCounts={projectCounts}
        projectPages={pages}
        adapterOptions={[]}
        pageLoading={pageLoading}
        pageError={pageError}
        loading={false}
        onPageChange={handlePageChange}
        onOpenTraces={onOpenTraces}
        onOpenFeatureCommits={onOpenFeatureCommits}
        onOpenProjectCommits={onOpenProjectCommits}
        loadFeatureNodes={loadFeatureNodes}
        lockedAdapterName={target.name}
      />
    </div>
  )
}

export function ProjectModePanel({
  data,
  loading,
  error,
  codeSource,
  codeStatsOverride,
  codeStatsLoading,
  onCodeSourceChange,
  headerAction,
  projectPages,
  projectPageLoading,
  projectPageError,
  onProjectPageChange,
  onOpenTraces,
  onOpenFeatureCommits,
  onOpenProjectCommits,
  loadFeatureNodes,
  loadPluginAggregate,
  fetchAdapterProjectPage,
  onSkillClick,
  onUserClick,
  onFunnelFirstStageClick,
  onSkillFunnelFirstStageClick,
  marketSkillKeys = new Set(),
  pluginSkillKeys = new Set()
}: {
  data: DashboardProjectModeData | null
  loading: boolean
  error: string | null
  /** 「生产效能代码指标」当前选中的 source（null = 全部来源，用 data 自带口径）。 */
  codeSource: string | null
  /** 选了具体来源/原生时按 source 换数得到的代码采纳覆盖值；null 表示用 data 自带口径。 */
  codeStatsOverride: {
    codeStats: DashboardCodeStats | null
    skillCodeStats: DashboardCodeStats | null
  } | null
  /** source 换数请求在途。 */
  codeStatsLoading: boolean
  /** 切换 source 下拉（null = 全部来源）。 */
  onCodeSourceChange: (source: string | null) => void
  headerAction?: ReactNode
  projectPages: Partial<
    Record<DashboardProjectModeProjectStatus, DashboardProjectModeProjectPageData>
  >
  projectPageLoading: Record<DashboardProjectModeProjectStatus, boolean>
  projectPageError: Partial<Record<DashboardProjectModeProjectStatus, string>>
  onProjectPageChange: (
    status: DashboardProjectModeProjectStatus,
    page: number,
    keyword: string,
    pageSize: number,
    adapterName: string,
    creatorKeyword: string,
    creatorOrgKeyword: string,
    sortBy?: DashboardProjectModeProjectSortKey | null,
    sortOrder?: DashboardProjectModeProjectSortOrder
  ) => void
  onOpenTraces: (
    project: DashboardProjectModeProject,
    feature?: DashboardProjectModeFeature,
    node?: DashboardProjectModeFeatureNode,
    status?: string,
    stageBucket?: StageBucket
  ) => void
  onOpenFeatureCommits: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => void
  onOpenProjectCommits: (project: DashboardProjectModeProject, pushedOnly?: boolean) => void
  loadFeatureNodes: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => Promise<DashboardProjectModeFeatureNode[]>
  loadPluginAggregate: (adapterName: string) => Promise<DashboardProjectModeFeatureNode[]>
  /** 插件「项目数」弹窗复用项目列表所需的分页拉取器（按当前时间范围，调用方注入插件名/版本）。 */
  fetchAdapterProjectPage: (
    options: DashboardProjectModeProjectPageOptions
  ) => Promise<DashboardProjectModeProjectPageData>
  onSkillClick?: (skill: string) => void
  onUserClick?: (sapId: string) => void
  onFunnelFirstStageClick?: () => void
  onSkillFunnelFirstStageClick?: () => void
  marketSkillKeys?: Set<string>
  pluginSkillKeys?: Set<string>
}): React.JSX.Element {
  const adapters = useMemo(() => data?.adapters ?? [], [data?.adapters])
  const adapterOptions = useMemo(
    () =>
      Array.from(new Set(adapters.map((adapter) => adapter.name.trim()).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "zh-CN", { numeric: true })
      ),
    [adapters]
  )

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  const summary = data?.summary
  // 「生产效能代码指标」按 source 局部换数：选了具体来源/原生（codeStatsOverride 非空）时
  // 用 override，否则用 data 自带的整体口径。只影响该区两个子模块与漏斗。
  const codeStats = codeStatsOverride ? codeStatsOverride.codeStats : (summary?.codeStats ?? null)
  const skillCodeStats = codeStatsOverride
    ? codeStatsOverride.skillCodeStats
    : (summary?.skillCodeStats ?? null)
  const availableSources = data?.availableSources ?? []
  const funnelData: CodeAdoptionFunnelData = codeStats ?? EMPTY_FUNNEL_DATA
  const skillFunnelData: CodeAdoptionFunnelData = skillCodeStats ?? EMPTY_FUNNEL_DATA
  const topSkills = data?.topSkills ?? []
  const bySkillAdoption = data?.bySkillAdoption ?? []
  const tools = data?.tools ?? EMPTY_TOOL_USAGE
  const projectCounts = data?.projectCounts
  const archivedCount = projectCounts?.archived ?? 0
  const archivedFeatureCount = projectCounts?.archivedFeatureCount ?? 0

  return (
    <div className="space-y-6">
      {/* 概览卡片（左）+ 代码采纳漏斗（右），与平台运营概览一致 */}
      <section>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">项目运营概览</h2>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
        {data?.leanTruncated && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              「仅精益项目」命中的项目数量已超过单次统计上限，下方汇总指标（对话数、代码采纳等）可能不完整。请缩小时间范围或叠加部门
              / 室筛选后再查看。
            </span>
          </div>
        )}
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">项目总数 / 特性总数</span>{" "}
          为当前状态（项目快照实时统计，不随时间范围变化）；其余指标按
          <span className="font-medium text-foreground">所选时间范围</span>统计。
        </p>
        <div className="grid grid-cols-2 gap-3 content-start md:grid-cols-3 xl:grid-cols-6">
          <StatCard
            icon={Boxes}
            label="项目总数"
            value={formatNumber(summary?.projectCount ?? 0)}
            sub={archivedCount > 0 ? `当前状态 · 含 ${archivedCount} 已归档` : "当前状态"}
            color="bg-blue-500"
          />
          <StatCard
            icon={Layers}
            label="特性总数"
            value={formatNumber(summary?.featureCount ?? 0)}
            sub={
              archivedFeatureCount > 0 ? `当前状态 · 含 ${archivedFeatureCount} 已归档` : "当前状态"
            }
            color="bg-indigo-500"
          />
          <StatCard
            icon={Activity}
            label="活跃项目"
            value={formatNumber(summary?.activeProjectCount ?? 0)}
            sub="时间范围内有对话"
            color="bg-emerald-500"
          />
          <StatCard
            icon={MessagesSquare}
            label="项目对话数"
            value={formatNumber(summary?.conversationCount ?? 0)}
            color="bg-violet-500"
          />
          <StatCard
            icon={ArrowDownToLine}
            label="输入 Token"
            value={formatCompact(summary?.totalInputTokens ?? 0)}
            color="bg-amber-500"
          />
          <StatCard
            icon={ArrowUpFromLine}
            label="输出 Token"
            value={formatCompact(summary?.totalOutputTokens ?? 0)}
            color="bg-rose-500"
          />
        </div>
      </section>

      {/* 生成效能代码指标：项目模式总量 + AutoBizDevOps 约束生成，两个子模块各含卡片与独立漏斗 */}
      <section className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">生产效能代码指标</h2>
            <CodeEfficiencyModelInfo />
          </div>
          {/* source 筛选：始终展示，仅收窄本区两个子模块。 */}
          <div className="flex items-center gap-2">
            {codeStatsLoading && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            <span className="text-[11px] text-muted-foreground">来源</span>
            <Select
              value={codeSource ?? CODE_SOURCE_ALL}
              onValueChange={(v) => onCodeSourceChange(v === CODE_SOURCE_ALL ? null : v)}
            >
              <SelectTrigger className="h-7 w-[160px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CODE_SOURCE_ALL}>全部来源</SelectItem>
                <SelectItem value={CODE_SOURCE_NATIVE}>Git仓库采纳</SelectItem>
                {availableSources.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 子模块一（项目模式总量）：含 VibeCoding 在内的整体口径 */}
        <div>
          <div className="mb-3 flex items-center gap-1.5">
            <h3 className="text-xs font-semibold text-foreground">项目模式总量</h3>
            <InfoHint hint="项目模式下产生的全部代码（含 VibeCoding 等未使用 Skill 的对话）。" />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3">
            <div className="grid grid-cols-2 gap-3 content-start md:grid-cols-5">
              <StatCard
                icon={Code2}
                label="代码生成行数"
                tag="计数"
                value={formatLineCount(codeStats?.generatedLines ?? 0)}
                color="bg-sky-500"
                hint={<GeneratedLinesTooltip />}
              />
              <StatCard
                icon={Gauge}
                label="总量入库采纳率"
                tag="总量口径 · 入库"
                value={formatPercent(codeStats?.inclusivePushedAdoptionRate)}
                sub={
                  codeStats
                    ? `${formatLineCount(codeStats.pushedAdoptedLines)} / ${formatLineCount(codeStats.inclusiveEffectiveGeneratedLines)} 行`
                    : "暂无已 Push 数据"
                }
                color="bg-emerald-500"
                hint={codeStats ? <InclusivePushedAdoptionTooltip data={codeStats} /> : undefined}
              />
              <StatCard
                icon={Gauge}
                label="总量提交采纳率"
                tag="总量口径 · 提交"
                value={formatPercent(codeStats?.inclusiveAdoptionRate)}
                sub={
                  codeStats
                    ? `${formatLineCount(codeStats.adoptedLines)} / ${formatLineCount(codeStats.inclusiveEffectiveGeneratedLines)} 行`
                    : "暂无代码生成数据"
                }
                color="bg-cyan-500"
                hint={codeStats ? <InclusiveAdoptionTooltip data={codeStats} /> : undefined}
              />
              <StatCard
                icon={Gauge}
                label="入库采纳率"
                tag="提交口径 · 已push"
                value={formatPercent(codeStats?.pushedAdoptionRate)}
                sub={
                  codeStats
                    ? `${formatLineCount(codeStats.pushedAdoptedLines)} / ${formatLineCount(codeStats.pushedEffectiveGeneratedLines)} 行`
                    : "暂无已 Push 数据"
                }
                color="bg-teal-500"
                hint={codeStats ? <PushedAdoptionTooltip data={codeStats} /> : undefined}
              />
              <StatCard
                icon={Gauge}
                label="提交采纳率"
                tag="提交口径 · 对标组织级"
                value={formatPercent(codeStats?.measuredAdoptionRate)}
                sub={
                  codeStats
                    ? `${formatLineCount(codeStats.adoptedLines)} / ${formatLineCount(codeStats.effectiveGeneratedLines)} 行`
                    : "暂无代码生成数据"
                }
                color="bg-indigo-500"
                hint={codeStats ? <MeasuredAdoptionTooltip data={codeStats} /> : undefined}
              />
            </div>
            <CodeAdoptionFunnel data={funnelData} onFirstStageClick={onFunnelFirstStageClick} />
          </div>
        </div>

        {/* 子模块二（AutoBizDevOps 插件约束生成）：使用了 Skill 的子集 */}
        <div>
          <div className="mb-3 flex items-center gap-1.5">
            <h3 className="text-xs font-semibold text-foreground">由 AutoBizDevOps 插件约束生成</h3>
            <InfoHint hint="仅统计调用了 AutoBizDevOps 插件 Skill 的对话所生成的代码，是项目模式总量的子集。" />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3">
            <div className="grid grid-cols-2 gap-3 content-start md:grid-cols-5">
              <StatCard
                icon={Code2}
                label="Skill 生成行数"
                tag="计数"
                value={formatLineCount(skillCodeStats?.generatedLines ?? 0)}
                sub="由 Skill 生成的原始行数"
                color="bg-violet-500"
                hint={<GeneratedLinesTooltip />}
              />
              <StatCard
                icon={Gauge}
                label="总量入库采纳率"
                tag="总量口径 · 入库"
                value={formatPercent(skillCodeStats?.inclusivePushedAdoptionRate)}
                sub={
                  skillCodeStats
                    ? `${formatLineCount(skillCodeStats.pushedAdoptedLines)} / ${formatLineCount(skillCodeStats.inclusiveEffectiveGeneratedLines)} 行`
                    : "暂无已 Push 数据"
                }
                color="bg-emerald-500"
                hint={
                  skillCodeStats ? (
                    <InclusivePushedAdoptionTooltip data={skillCodeStats} />
                  ) : undefined
                }
              />
              <StatCard
                icon={Gauge}
                label="总量提交采纳率"
                tag="总量口径 · 提交"
                value={formatPercent(skillCodeStats?.inclusiveAdoptionRate)}
                sub={
                  skillCodeStats
                    ? `${formatLineCount(skillCodeStats.adoptedLines)} / ${formatLineCount(skillCodeStats.inclusiveEffectiveGeneratedLines)} 行`
                    : "暂无代码生成数据"
                }
                color="bg-cyan-500"
                hint={
                  skillCodeStats ? <InclusiveAdoptionTooltip data={skillCodeStats} /> : undefined
                }
              />
              <StatCard
                icon={Gauge}
                label="入库采纳率"
                tag="提交口径 · 已push"
                value={formatPercent(skillCodeStats?.pushedAdoptionRate)}
                sub={
                  skillCodeStats
                    ? `${formatLineCount(skillCodeStats.pushedAdoptedLines)} / ${formatLineCount(skillCodeStats.pushedEffectiveGeneratedLines)} 行`
                    : "暂无已 Push 数据"
                }
                color="bg-teal-500"
                hint={skillCodeStats ? <PushedAdoptionTooltip data={skillCodeStats} /> : undefined}
              />
              <StatCard
                icon={Gauge}
                label="提交采纳率"
                tag="提交口径 · 对标组织级"
                value={formatPercent(skillCodeStats?.measuredAdoptionRate)}
                sub={
                  skillCodeStats
                    ? `${formatLineCount(skillCodeStats.adoptedLines)} / ${formatLineCount(skillCodeStats.effectiveGeneratedLines)} 行`
                    : "暂无代码生成数据"
                }
                color="bg-indigo-500"
                hint={
                  skillCodeStats ? <MeasuredAdoptionTooltip data={skillCodeStats} /> : undefined
                }
              />
            </div>
            <CodeAdoptionFunnel
              data={skillFunnelData}
              onFirstStageClick={onSkillFunnelFirstStageClick}
            />
          </div>
        </div>
      </section>

      {/* Project list */}
      <ProjectListSection
        projectCounts={projectCounts}
        projectPages={projectPages}
        adapterOptions={adapterOptions}
        pageLoading={projectPageLoading}
        pageError={projectPageError}
        loading={loading}
        onPageChange={onProjectPageChange}
        onOpenTraces={onOpenTraces}
        onOpenFeatureCommits={onOpenFeatureCommits}
        onOpenProjectCommits={onOpenProjectCommits}
        loadFeatureNodes={loadFeatureNodes}
      />

      {/* Adapter (plugin) distribution — 紧随项目列表之后 */}
      <AdapterListSection
        adapters={adapters}
        loadPluginAggregate={loadPluginAggregate}
        fetchAdapterProjectPage={fetchAdapterProjectPage}
        onOpenTraces={onOpenTraces}
        onOpenFeatureCommits={onOpenFeatureCommits}
        onOpenProjectCommits={onOpenProjectCommits}
        loadFeatureNodes={loadFeatureNodes}
      />

      <ProjectModeAnalyticsSection analytics={data?.analytics} onUserClick={onUserClick} />

      {/* Skill / Tool 使用排行，与平台运营概览同款 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">技能 / 工具使用</h2>
        <div className="grid grid-cols-2 gap-3">
          <SkillRankingPanel
            bySkill={topSkills}
            bySkillAll={topSkills}
            totalSkills={summary?.distinctSkillCount ?? 0}
            totalSkillCalls={summary?.skillCallCount ?? 0}
            bySkillAdoption={bySkillAdoption}
            onSkillClick={onSkillClick}
            marketSkillKeys={marketSkillKeys}
            pluginSkillKeys={pluginSkillKeys}
          />
          <ToolRankingPanel
            byTool={tools.byTool}
            byToolAll={tools.byToolAll}
            byToolFilteredAll={tools.byToolFilteredAll}
            byToolAllFull={tools.byToolAllFull}
            totalTools={tools.totalTools}
            totalToolCalls={tools.totalToolCalls}
          />
        </div>
      </section>
    </div>
  )
}
