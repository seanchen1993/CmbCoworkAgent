import { useEffect, useMemo, useState, type ReactNode } from "react"
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts"
import {
  Boxes,
  Layers,
  Activity,
  MessagesSquare,
  ArrowDownToLine,
  ArrowUpFromLine,
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
import { cn } from "@/lib/utils"
import { marketApi } from "@/api/market"
import {
  CodeAdoptionFunnel,
  SkillRankingPanel,
  ToolRankingPanel,
  type CodeAdoptionFunnelData
} from "./dashboard-shared"
import type {
  DashboardProjectModeData,
  DashboardProjectModeAdapter,
  DashboardProjectModeAnalytics,
  DashboardProjectModeFeature,
  DashboardProjectModeOrgDistributionItem,
  DashboardProjectModeProject,
  DashboardProjectModeProjectCounts,
  DashboardProjectModeProjectPageData,
  DashboardProjectModeProjectStatus,
  DashboardProjectModeSkillCount,
  DashboardProjectModeToolUsage,
  DashboardCodeStats
} from "../use-dashboard"

const EMPTY_FUNNEL_DATA: CodeAdoptionFunnelData = {
  inclusiveEffectiveGeneratedLines: 0,
  effectiveGeneratedLines: 0,
  pushedEffectiveGeneratedLines: 0,
  adoptedLines: 0,
  pushedAdoptedLines: 0,
  inclusiveAdoptionRate: null,
  measuredAdoptionRate: null,
  pushedAdoptionRate: null
}

const EMPTY_TOOL_USAGE: DashboardProjectModeToolUsage = {
  byTool: [],
  byToolAll: [],
  byToolFilteredAll: [],
  byToolAllFull: [],
  totalTools: 0,
  totalToolCalls: 0
}

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
  color
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
}): React.JSX.Element {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div className="min-w-0">
        <div className="truncate whitespace-nowrap text-[11px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold leading-tight text-foreground">{value}</div>
        {sub && <div className="whitespace-nowrap text-[10px] text-muted-foreground">{sub}</div>}
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
function InfoHint({ hint }: { hint: string }): React.JSX.Element {
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

/** Per-feature code-adoption line: Agent生成行数 / 有效生成行数 / 已Commit·已Push 采纳率（含行数明细）。 */
function FeatureCodeStatsLine({
  codeStats
}: {
  codeStats?: DashboardCodeStats | null
}): React.JSX.Element {
  if (!codeStats) {
    return <div className="text-[11px] text-muted-foreground/80">暂无代码生成数据</div>
  }
  const adoptedLabel = `${formatLineCount(codeStats.adoptedLines)} / ${formatLineCount(codeStats.effectiveGeneratedLines)} 行`
  const pushedLabel = `${formatLineCount(codeStats.pushedAdoptedLines)} / ${formatLineCount(codeStats.pushedEffectiveGeneratedLines)} 行`
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span>
        Agent生成行数{" "}
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
      <span>
        已Commit采纳率{" "}
        <span className="font-medium text-foreground">
          {formatPercent(codeStats.measuredAdoptionRate)}
        </span>
        <span className="ml-1 text-muted-foreground/80">({adoptedLabel})</span>
      </span>
      <span>
        已Push采纳率{" "}
        <span className="font-medium text-foreground">
          {formatPercent(codeStats.pushedAdoptionRate)}
        </span>
        <span className="ml-1 text-muted-foreground/80">({pushedLabel})</span>
      </span>
    </div>
  )
}

function ProjectRow({
  project,
  expanded,
  onToggle,
  onOpenTraces,
  onOpenFeatureCommits
}: {
  project: DashboardProjectModeProject
  expanded: boolean
  onToggle: () => void
  onOpenTraces: (feature?: DashboardProjectModeFeature) => void
  onOpenFeatureCommits: (feature: DashboardProjectModeFeature) => void
}): React.JSX.Element {
  const codeStats = project.codeStats
  const adoptionLineLabel = codeStats
    ? `${formatLineCount(codeStats.adoptedLines)} / ${formatLineCount(codeStats.effectiveGeneratedLines)} 行`
    : "—"
  const pushedAdoptionLineLabel = codeStats
    ? `${formatLineCount(codeStats.pushedAdoptedLines)} / ${formatLineCount(codeStats.pushedEffectiveGeneratedLines)} 行`
    : "—"
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
          <div className="font-medium">{formatPercent(codeStats?.measuredAdoptionRate)}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{adoptionLineLabel}</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <div className="font-medium">{formatPercent(codeStats?.pushedAdoptionRate)}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{pushedAdoptionLineLabel}</div>
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
  onOpenFeatureCommits
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
    creatorOrgKeyword: string
  ) => void
  onOpenTraces: (
    project: DashboardProjectModeProject,
    feature?: DashboardProjectModeFeature
  ) => void
  onOpenFeatureCommits: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<ProjectListTab>("active")
  const [query, setQuery] = useState("")
  const [creatorQuery, setCreatorQuery] = useState("")
  const [departmentQuery, setDepartmentQuery] = useState("")
  const [adapterName, setAdapterName] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const trimmed = query.trim()
  const creatorKeyword = creatorQuery.trim()
  const creatorOrgKeyword = departmentQuery.trim()
  const rawSelectedAdapter = adapterName.trim()
  const selectedAdapter = adapterOptions.includes(rawSelectedAdapter) ? rawSelectedAdapter : ""
  const pageData = projectPages[tab]
  const currentError = pageError[tab]
  const tabCount =
    tab === "archived" ? (projectCounts?.archived ?? 0) : (projectCounts?.active ?? 0)
  const pageMatchesQuery = pageData?.keyword === trimmed
  const pageMatchesAdapter = (pageData?.adapterName ?? "") === selectedAdapter
  const pageMatchesCreator = (pageData?.creatorKeyword ?? "") === creatorKeyword
  const pageMatchesCreatorOrg = (pageData?.creatorOrgKeyword ?? "") === creatorOrgKeyword
  const pageMatchesFilter =
    pageMatchesQuery && pageMatchesAdapter && pageMatchesCreator && pageMatchesCreatorOrg
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
      pageData.pageSize === PROJECT_PAGE_SIZE
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
        creatorOrgKeyword
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [
    creatorKeyword,
    creatorOrgKeyword,
    onPageChange,
    pageData,
    pageLoading,
    selectedAdapter,
    tab,
    trimmed
  ])

  const switchTab = (next: ProjectListTab): void => {
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
      creatorOrgKeyword
    )
  }

  const tabs: Array<{ id: ProjectListTab; label: string; count: number }> = [
    { id: "active", label: "进行中", count: projectCounts?.active ?? 0 },
    { id: "archived", label: "已归档", count: projectCounts?.archived ?? 0 }
  ]

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-foreground">项目列表</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        项目、插件、项目状态、特性数为当前状态；对话数、Agent生成行数（原始生成行数）、已Commit/已Push采纳率，以及展开行的技能、各特性采纳明细与关联 Commit 按所选时间范围统计。
      </p>

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
              <th className="px-3 py-2 text-right font-medium">特性数</th>
              <th className="px-3 py-2 text-right font-medium">对话数</th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Agent 原始生成行数（未经去重/抵消的原始产出）"
              >
                Agent生成行数
              </th>
              <th className="px-3 py-2 text-right font-medium">已Commit采纳率</th>
              <th className="px-3 py-2 text-right font-medium">已Push采纳率</th>
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
                onOpenTraces={(feature) => onOpenTraces(project, feature)}
                onOpenFeatureCommits={(feature) => onOpenFeatureCommits(project, feature)}
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
    adoptionRate: measuredAdoptionRate
  }
}

/** 按插件名聚合：累加项目/特性/对话数，合并代码采纳明细。 */
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
      codeStats: mergeCodeStats(group.map((a) => a.codeStats))
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
    void marketApi
      .getPlugins({ allowMockOnError: false, silent: true })
      .then((res) => {
        if (cancelled || !res.success || !res.data) return
        const next = new Map<string, PluginMarketInfo>()
        for (const item of res.data) {
          const name = item.name?.trim()
          if (!name) continue
          next.set(name, {
            useScenario: item.category?.trim() || OTHER_ADAPTER_SCENARIO,
            managerName: item.managerName?.trim() || "",
            managerDepartment: item.managerDepartment?.trim() || ""
          })
        }
        setInfoMap(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return infoMap
}

function AdapterListSection({
  adapters
}: {
  adapters: DashboardProjectModeAdapter[]
}): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [mode, setMode] = useState<AdapterListMode>("byName")
  const marketInfo = usePluginMarketInfo()
  const versionCount = adapters.length
  const aggregatedByName = aggregateAdaptersByName(adapters)
  const baseList = mode === "byName" ? aggregatedByName : adapters
  const sortedAdapters = [...baseList].sort(
    (a, b) =>
      b.projectCount - a.projectCount ||
      b.conversationCount - a.conversationCount ||
      a.name.localeCompare(b.name) ||
      (a.version ?? "").localeCompare(b.version ?? "")
  )
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
          ? "按插件名聚合同名插件的多个版本；按项目数降序排列，项目数为当前状态，对话数、已Commit/已Push采纳率按所选时间范围统计。"
          : "按插件版本展开；按项目数降序排列，项目数为当前状态，对话数、已Commit/已Push采纳率按所选时间范围统计。"}
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
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium text-foreground">{adapter.name}</span>
                      {adapter.version && (
                        <Badge variant="outline" className="normal-case tracking-normal">
                          {adapter.version}
                        </Badge>
                      )}
                      {info?.useScenario && (
                        <Badge variant="secondary" className="shrink-0 normal-case tracking-normal">
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
                    <span>
                      项目{" "}
                      <span className="font-medium text-foreground">
                        {formatNumber(adapter.projectCount)}
                      </span>
                    </span>
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
                      已Commit采纳率{" "}
                      <span className="font-medium text-foreground">
                        {formatPercent(adapter.codeStats?.measuredAdoptionRate)}
                      </span>
                    </span>
                    <span>
                      已Push采纳率{" "}
                      <span className="font-medium text-foreground">
                        {formatPercent(adapter.codeStats?.pushedAdoptionRate)}
                      </span>
                    </span>
                  </div>
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
    </section>
  )
}

export function ProjectModePanel({
  data,
  loading,
  error,
  headerAction,
  projectPages,
  projectPageLoading,
  projectPageError,
  onProjectPageChange,
  onOpenTraces,
  onOpenFeatureCommits,
  onSkillClick,
  onUserClick,
  marketSkillKeys = new Set(),
  pluginSkillKeys = new Set()
}: {
  data: DashboardProjectModeData | null
  loading: boolean
  error: string | null
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
    creatorOrgKeyword: string
  ) => void
  onOpenTraces: (
    project: DashboardProjectModeProject,
    feature?: DashboardProjectModeFeature
  ) => void
  onOpenFeatureCommits: (
    project: DashboardProjectModeProject,
    feature: DashboardProjectModeFeature
  ) => void
  onSkillClick?: (skill: string) => void
  onUserClick?: (sapId: string) => void
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
  const funnelData: CodeAdoptionFunnelData = summary?.codeStats ?? EMPTY_FUNNEL_DATA
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
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">项目总数 / 特性总数</span>{" "}
          为当前状态（项目快照实时统计，不随时间范围变化）；其余指标按
          <span className="font-medium text-foreground">所选时间范围</span>统计。
        </p>
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3">
          <div className="grid grid-cols-2 gap-3 content-start md:grid-cols-3 xl:grid-cols-5">
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
                archivedFeatureCount > 0
                  ? `当前状态 · 含 ${archivedFeatureCount} 已归档`
                  : "当前状态"
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
            <StatCard
              icon={Code2}
              label="代码生成行数"
              value={formatLineCount(summary?.codeStats?.generatedLines ?? 0)}
              color="bg-sky-500"
            />
            <StatCard
              icon={Gauge}
              label="已 Push 采纳率"
              value={formatPercent(summary?.codeStats?.pushedAdoptionRate)}
              sub={
                summary?.codeStats
                  ? `${formatLineCount(summary.codeStats.pushedAdoptedLines)} / ${formatLineCount(summary.codeStats.pushedEffectiveGeneratedLines)} 行`
                  : "暂无已 Push 数据"
              }
              color="bg-teal-500"
            />
            <StatCard
              icon={Gauge}
              label="已Commit采纳率"
              value={formatPercent(summary?.codeStats?.measuredAdoptionRate)}
              sub={
                summary?.codeStats
                  ? `${formatLineCount(summary.codeStats.adoptedLines)} / ${formatLineCount(summary.codeStats.effectiveGeneratedLines)} 行`
                  : "暂无代码生成数据"
              }
              color="bg-indigo-500"
            />
            <StatCard
              icon={Gauge}
              label="含未提交采纳率"
              value={formatPercent(summary?.codeStats?.inclusiveAdoptionRate)}
              sub={
                summary?.codeStats
                  ? `${formatLineCount(summary.codeStats.adoptedLines)} / ${formatLineCount(summary.codeStats.inclusiveEffectiveGeneratedLines)} 行`
                  : "暂无代码生成数据"
              }
              color="bg-cyan-500"
            />
          </div>
          <CodeAdoptionFunnel data={funnelData} />
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

      {/* Adapter distribution */}
      <AdapterListSection adapters={adapters} />
    </div>
  )
}
