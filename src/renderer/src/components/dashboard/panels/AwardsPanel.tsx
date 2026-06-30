import React, { useMemo, useState } from "react"
import {
  Award,
  Trophy,
  Users,
  Loader2,
  AlertCircle,
  Info,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Download
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatTopUserOrgName } from "../use-dashboard"
import type {
  DashboardAwardSkillContribution,
  DashboardAwardUserApplication,
  DashboardAwardTeamBenchmarkRow,
  DashboardCodeStats
} from "../use-dashboard"

/** 团队标杆奖一行：后端室/组指标 + 前端按市场作者归属补的贡献技能数 / 覆盖室数。 */
export interface TeamBenchmarkRow extends DashboardAwardTeamBenchmarkRow {
  /** 贡献技能数（室级有值；组级为 null，该指标按室口径）。 */
  contributedSkillCount: number | null
  /** 技能试用覆盖室数（室级有值；组级为 null）。 */
  skillCoverageShiCount: number | null
  children?: TeamBenchmarkRow[]
}

/** 室/组展示，沿用运营面板规则：upperOrgLv1/upperOrgLv0。 */
function orgLabelOf(row: { shi: string; group?: string }): string {
  return formatTopUserOrgName("", row.shi, row.group ?? "")
}

/** 技能贡献奖一行：聚合数据 + 已 join 的应用市场构建者展示字段。 */
export interface AwardSkillRow extends DashboardAwardSkillContribution {
  /** 应用市场技能展示名（中文名优先），无则回退 skillKey。 */
  displayName: string
  builderName: string
  builderOrg: string
  builderSapId: string
  featured?: string
}

interface AwardsPanelProps {
  skillRows: AwardSkillRow[]
  skillsLoading: boolean
  skillsError: string | null
  userApps: DashboardAwardUserApplication[]
  usersLoading: boolean
  usersError: string | null
  teamRows: TeamBenchmarkRow[]
  teamLoading: boolean
  teamError: string | null
  /** 导出当前奖项数据为 Excel；不传则不显示导出按钮。 */
  onExport?: () => void
  exporting?: boolean
}

/** 技能贡献奖每页展示条数（分页）。 */
const CONTRIBUTION_PAGE_SIZE = 50
/** 技能应用奖展示上限。 */
const APPLICATION_TOP_N = 20

/** 四个 AI 代码入库率口径（与项目运营概览同口径），统一在两张表展示。 */
const ADOPTION_FIELDS: Array<{
  key: string
  group: string
  metric: string
  field: keyof DashboardCodeStats
}> = [
  { key: "measured", group: "提交口径", metric: "提交", field: "measuredAdoptionRate" },
  { key: "pushed", group: "提交口径", metric: "入库", field: "pushedAdoptionRate" },
  { key: "inclusive", group: "总量口径", metric: "提交", field: "inclusiveAdoptionRate" },
  {
    key: "inclusivePushed",
    group: "总量口径",
    metric: "入库",
    field: "inclusivePushedAdoptionRate"
  }
]

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0"
  return new Intl.NumberFormat("zh-CN").format(Math.round(value))
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function rateOf(codeStats: DashboardCodeStats | null, field: keyof DashboardCodeStats): number {
  const value = codeStats?.[field]
  return typeof value === "number" && Number.isFinite(value) ? value : -1
}

function InfoHint({ hint }: { hint: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center">
            <Info className="size-3 text-muted-foreground/70" aria-label="查看说明" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** 可排序列头：点击切换该列升/降序，当前列显示方向箭头。 */
function SortHeader({
  active,
  desc,
  onClick,
  children,
  className
}: {
  active: boolean
  desc: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <th className={cn("px-3 py-2 text-right font-medium", className)}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {children}
        {active ? (
          desc ? (
            <ArrowDown className="size-3" />
          ) : (
            <ArrowUp className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  )
}

type AwardSubTab = "contribution" | "application" | "team"

const SUB_TABS: Array<{ id: AwardSubTab; label: string; icon: typeof Award }> = [
  { id: "contribution", label: "研发智能化技能贡献奖", icon: Award },
  { id: "application", label: "研发智能化技能应用奖", icon: Trophy },
  { id: "team", label: "研发智能化团队标杆奖", icon: Users }
]

export function AwardsPanel({
  skillRows,
  skillsLoading,
  skillsError,
  userApps,
  usersLoading,
  usersError,
  teamRows,
  teamLoading,
  teamError,
  onExport,
  exporting
}: AwardsPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<AwardSubTab>("contribution")

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1 rounded-md bg-muted/50 p-1 text-sm">
          {SUB_TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium transition-colors",
                  tab === t.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-4" />
                {t.label}
              </button>
            )
          })}
        </div>
        {onExport ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={onExport}
            disabled={exporting || skillsLoading || usersLoading || teamLoading}
          >
            {exporting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            导出Excel
          </Button>
        ) : null}
      </div>

      {tab === "contribution" ? (
        <ContributionTable rows={skillRows} loading={skillsLoading} error={skillsError} />
      ) : tab === "application" ? (
        <ApplicationTable rows={userApps} loading={usersLoading} error={usersError} />
      ) : (
        <TeamBenchmarkTable rows={teamRows} loading={teamLoading} error={teamError} />
      )}
    </div>
  )
}

/** 入库率口径说明：四个口径并列展示，本期未按治理/新系统/存量分档。 */
const ADOPTION_HINT =
  "AI 代码入库率四个口径：提交口径=已提交(Push)代码内的采纳/入库；总量口径=对全部有效生成行(含未提交)。其中「总量口径·入库」为领导主看的端到端真实入库率。本期未按治理任务/新系统开发/存量系统迭代分档（系统暂无任务性质分类维度），评分时请对照各档阈值（治理≥90% / 新系统>85% / 存量>80%）人工判断。"

const CROSS_ORG_HINT = "使用过该技能的去重室（upperOrgLv1）数。评分标准①要求跨 ≥2 室使用。"

type ContribSortKey = "crossOrgCount" | "userCount" | "callCount" | string

function ContributionTable({
  rows,
  loading,
  error
}: {
  rows: AwardSkillRow[]
  loading: boolean
  error: string | null
}): React.JSX.Element {
  // 默认按「提交口径·入库率」(pushedAdoptionRate) 从高到低。
  const [sortKey, setSortKey] = useState<ContribSortKey>("pushed")
  const [sortDesc, setSortDesc] = useState(true)
  const [page, setPage] = useState(1)

  const sortValue = (row: AwardSkillRow, key: ContribSortKey): number => {
    if (key === "crossOrgCount") return row.crossOrgCount
    if (key === "userCount") return row.userCount
    if (key === "callCount") return row.callCount
    const adoption = ADOPTION_FIELDS.find((a) => a.key === key)
    if (adoption) return rateOf(row.codeStats, adoption.field)
    return 0
  }

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      if (av !== bv) return sortDesc ? bv - av : av - bv
      // 平手时稳定回退：跨室数 → 调用数。
      if (a.crossOrgCount !== b.crossOrgCount) return b.crossOrgCount - a.crossOrgCount
      return b.callCount - a.callCount
    })
  }, [rows, sortKey, sortDesc])

  const totalPages = Math.max(1, Math.ceil(sorted.length / CONTRIBUTION_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * CONTRIBUTION_PAGE_SIZE
  const paged = sorted.slice(pageStart, pageStart + CONTRIBUTION_PAGE_SIZE)

  // 排序变化后回到第 1 页，避免停留在越界页码。
  const toggleSort = (key: ContribSortKey): void => {
    setPage(1)
    if (key === sortKey) setSortDesc((v) => !v)
    else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载技能贡献数据…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-destructive">
        <AlertCircle className="size-4" />
        {error}
      </div>
    )
  }
  if (rows.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">暂无个人构建技能的使用数据。</div>
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        候选范围：应用市场中个人构建并发布的技能（默认按提交口径·入库率排序）。 跨 ≥2
        室使用且各档入库率达标者为评分标准命中。
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">技能</th>
              <th className="px-3 py-2 font-medium">构建者</th>
              <SortHeader
                active={sortKey === "crossOrgCount"}
                desc={sortDesc}
                onClick={() => toggleSort("crossOrgCount")}
              >
                <span className="inline-flex items-center gap-1">
                  跨室数 <InfoHint hint={CROSS_ORG_HINT} />
                </span>
              </SortHeader>
              <SortHeader
                active={sortKey === "userCount"}
                desc={sortDesc}
                onClick={() => toggleSort("userCount")}
              >
                使用人数
              </SortHeader>
              <SortHeader
                active={sortKey === "callCount"}
                desc={sortDesc}
                onClick={() => toggleSort("callCount")}
              >
                调用数
              </SortHeader>
              {ADOPTION_FIELDS.map((a, i) => (
                <SortHeader
                  key={a.key}
                  active={sortKey === a.key}
                  desc={sortDesc}
                  onClick={() => toggleSort(a.key)}
                  className={i === 0 ? "border-l border-border/60" : undefined}
                >
                  <span className="flex flex-col items-end leading-tight">
                    <span className="text-[10px] text-muted-foreground/70">{a.group}</span>
                    <span className="inline-flex items-center gap-1">
                      {a.metric}
                      {a.key === "inclusivePushed" ? <InfoHint hint={ADOPTION_HINT} /> : null}
                    </span>
                  </span>
                </SortHeader>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((row) => {
              const crossOk = row.crossOrgCount >= 2
              return (
                <tr key={row.skillKey} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{row.displayName}</div>
                    {row.featured ? (
                      <span className="text-[11px] text-muted-foreground">{row.featured}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-foreground">{row.builderName || "—"}</div>
                    {row.builderOrg ? (
                      <span className="text-[11px] text-muted-foreground">{row.builderOrg}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      {crossOk ? (
                        <CheckCircle2 className="size-3.5 text-emerald-600" />
                      ) : (
                        <XCircle className="size-3.5 text-muted-foreground/50" />
                      )}
                      <span className={crossOk ? "font-semibold text-foreground" : ""}>
                        {formatNumber(row.crossOrgCount)}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(row.userCount)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(row.callCount)}
                  </td>
                  {ADOPTION_FIELDS.map((a, i) => (
                    <td
                      key={a.key}
                      className={cn(
                        "px-3 py-2 text-right tabular-nums",
                        i === 0 ? "border-l border-border/60" : undefined,
                        a.key === "inclusivePushed" ? "font-medium text-foreground" : undefined
                      )}
                    >
                      {formatPercent(row.codeStats?.[a.field] as number | null | undefined)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          共 {formatNumber(sorted.length)} 个 · 第 {safePage} / {totalPages} 页（每页{" "}
          {CONTRIBUTION_PAGE_SIZE} 个）
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded border border-border px-2 py-1 hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-3.5" />
            上一页
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded border border-border px-2 py-1 hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

type AppSortKey =
  | "callCount"
  | "skillCount"
  | "skillUsageCount"
  | "toolCallCount"
  | "threadCount"
  | "featureCount"
  | string

const APPLICATION_HINT =
  "榜单按深度使用 + 个人 AI 代码入库率综合评估，展示前 20 名。本期实质性成效仅纳入「调用数 / 技能种类数 / 用技能总次数 / 工具调用 / 会话数 / 特性数 + AI 代码入库率(四口径)」；云治理/安全治理/项目开发任务数与 ST 缺陷率本期暂不纳入（数据源在系统外，待对接）。"

function ApplicationTable({
  rows,
  loading,
  error
}: {
  rows: DashboardAwardUserApplication[]
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const [sortKey, setSortKey] = useState<AppSortKey>("callCount")
  const [sortDesc, setSortDesc] = useState(true)

  const sortValue = (row: DashboardAwardUserApplication, key: AppSortKey): number => {
    switch (key) {
      case "callCount":
        return row.callCount
      case "skillCount":
        return row.skillCount
      case "skillUsageCount":
        return row.skillUsageCount
      case "toolCallCount":
        return row.toolCallCount
      case "threadCount":
        return row.threadCount
      case "featureCount":
        return row.featureCount
      default: {
        const adoption = ADOPTION_FIELDS.find((a) => a.key === key)
        return adoption ? rateOf(row.codeStats, adoption.field) : 0
      }
    }
  }

  const sorted = useMemo(() => {
    return [...rows]
      .sort((a, b) => {
        const av = sortValue(a, sortKey)
        const bv = sortValue(b, sortKey)
        if (av !== bv) return sortDesc ? bv - av : av - bv
        return b.callCount - a.callCount
      })
      .slice(0, APPLICATION_TOP_N)
  }, [rows, sortKey, sortDesc])

  const toggleSort = (key: AppSortKey): void => {
    if (key === sortKey) setSortDesc((v) => !v)
    else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载技能应用榜数据…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-destructive">
        <AlertCircle className="size-4" />
        {error}
      </div>
    )
  }
  if (rows.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">暂无个人应用数据。</div>
  }

  const depthColumns: Array<{ key: AppSortKey; label: string }> = [
    { key: "callCount", label: "调用数" },
    { key: "skillCount", label: "技能种类数" },
    { key: "skillUsageCount", label: "用技能总次数" },
    { key: "toolCallCount", label: "工具调用" },
    { key: "threadCount", label: "会话数" },
    { key: "featureCount", label: "特性数" }
  ]

  return (
    <div className="space-y-3">
      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        展示前 {APPLICATION_TOP_N} 名（按当前排序列取，默认按调用数）。点击列头切换排序。{" "}
        <InfoHint hint={APPLICATION_HINT} />
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">室/组</th>
              {depthColumns.map((col) => (
                <SortHeader
                  key={col.key}
                  active={sortKey === col.key}
                  desc={sortDesc}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                </SortHeader>
              ))}
              {ADOPTION_FIELDS.map((a, i) => (
                <SortHeader
                  key={a.key}
                  active={sortKey === a.key}
                  desc={sortDesc}
                  onClick={() => toggleSort(a.key)}
                  className={i === 0 ? "border-l border-border/60" : undefined}
                >
                  <span className="flex flex-col items-end leading-tight">
                    <span className="text-[10px] text-muted-foreground/70">{a.group}</span>
                    <span className="inline-flex items-center gap-1">
                      {a.metric}
                      {a.key === "inclusivePushed" ? <InfoHint hint={ADOPTION_HINT} /> : null}
                    </span>
                  </span>
                </SortHeader>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, index) => (
              <tr
                key={row.sapId || row.ystId || index}
                className="border-b border-border/60 last:border-0"
              >
                <td className="px-3 py-2">
                  {index < 3 ? (
                    <Badge variant="secondary" className="font-semibold">
                      {index + 1}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">{index + 1}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{row.userName || "—"}</div>
                  {row.sapId ? (
                    <span className="text-[11px] text-muted-foreground">{row.sapId}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatTopUserOrgName(
                    row.orgName ?? "",
                    row.upperOrgLv1 ?? "",
                    row.upperOrgLv0 ?? ""
                  ) || "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.callCount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(row.skillCount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(row.skillUsageCount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(row.toolCallCount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(row.threadCount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(row.featureCount)}
                </td>
                {ADOPTION_FIELDS.map((a, i) => (
                  <td
                    key={a.key}
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      i === 0 ? "border-l border-border/60" : undefined,
                      a.key === "inclusivePushed" ? "font-medium text-foreground" : undefined
                    )}
                  >
                    {formatPercent(row.codeStats?.[a.field] as number | null | undefined)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const TEAM_HINT =
  "按 室(upperOrgLv1) → 组(upperOrgLv0) 两级统计。人均使用次数=本行使用次数/本行去重用户；总量人均使用次数=全员总使用次数/全员去重用户（基线，每行相同）；超过人均人数=该室/组内使用次数高于「总量人均」的用户数。代码提交行数取已采纳行数；AI 代码入库率四口径同其它榜单。贡献技能数 / 技能覆盖室数按应用市场作者归属（发布者所属室）统计，仅在室级展示。"

type TeamSortKey =
  | "usageCount"
  | "perCapitaUsage"
  | "totalPerCapitaUsage"
  | "aboveAvgUserCount"
  | "contributedSkillCount"
  | "skillCoverageShiCount"
  | "skillUsageCount"
  | "committedLines"
  | string

function teamSortValue(row: TeamBenchmarkRow, key: TeamSortKey): number {
  switch (key) {
    case "usageCount":
      return row.usageCount
    case "perCapitaUsage":
      return row.perCapitaUsage
    case "totalPerCapitaUsage":
      return row.totalPerCapitaUsage
    case "aboveAvgUserCount":
      return row.aboveAvgUserCount
    case "contributedSkillCount":
      return row.contributedSkillCount ?? -1
    case "skillCoverageShiCount":
      return row.skillCoverageShiCount ?? -1
    case "skillUsageCount":
      return row.skillUsageCount
    case "committedLines":
      return row.codeStats?.adoptedLines ?? -1
    default: {
      const adoption = ADOPTION_FIELDS.find((a) => a.key === key)
      return adoption ? rateOf(row.codeStats, adoption.field) : 0
    }
  }
}

function TeamBenchmarkTable({
  rows,
  loading,
  error
}: {
  rows: TeamBenchmarkRow[]
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const [sortKey, setSortKey] = useState<TeamSortKey>("usageCount")
  const [sortDesc, setSortDesc] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const sortedShi = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = teamSortValue(a, sortKey)
      const bv = teamSortValue(b, sortKey)
      if (av !== bv) return sortDesc ? bv - av : av - bv
      return b.usageCount - a.usageCount
    })
  }, [rows, sortKey, sortDesc])

  const toggleSort = (key: TeamSortKey): void => {
    if (key === sortKey) setSortDesc((v) => !v)
    else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  const toggleExpand = (shi: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(shi)) next.delete(shi)
      else next.add(shi)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载团队标杆数据…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-destructive">
        <AlertCircle className="size-4" />
        {error}
      </div>
    )
  }
  if (rows.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">暂无团队数据。</div>
  }

  const columns: Array<{ key: TeamSortKey; label: string }> = [
    { key: "usageCount", label: "使用次数" },
    { key: "perCapitaUsage", label: "室/组人均使用次数" },
    { key: "totalPerCapitaUsage", label: "总量人均使用次数" },
    { key: "aboveAvgUserCount", label: "超过人均人数" },
    { key: "contributedSkillCount", label: "贡献技能数" },
    { key: "skillCoverageShiCount", label: "技能覆盖室数" },
    { key: "skillUsageCount", label: "技能使用次数" },
    { key: "committedLines", label: "代码提交行数" }
  ]

  const renderCells = (row: TeamBenchmarkRow): React.JSX.Element => (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.usageCount)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.perCapitaUsage.toFixed(1)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.totalPerCapitaUsage.toFixed(1)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.aboveAvgUserCount)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.contributedSkillCount === null ? "—" : formatNumber(row.contributedSkillCount)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.skillCoverageShiCount === null ? "—" : formatNumber(row.skillCoverageShiCount)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.skillUsageCount)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatNumber(row.codeStats?.adoptedLines ?? 0)}
      </td>
      {ADOPTION_FIELDS.map((a, i) => (
        <td
          key={a.key}
          className={cn(
            "px-3 py-2 text-right tabular-nums",
            i === 0 ? "border-l border-border/60" : undefined,
            a.key === "inclusivePushed" ? "font-medium text-foreground" : undefined
          )}
        >
          {formatPercent(row.codeStats?.[a.field] as number | null | undefined)}
        </td>
      ))}
    </>
  )

  return (
    <div className="space-y-3">
      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        按室汇总，点击室名展开下属组。点击列头切换排序。 <InfoHint hint={TEAM_HINT} />
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">室 / 组</th>
              {columns.map((col) => (
                <SortHeader
                  key={col.key}
                  active={sortKey === col.key}
                  desc={sortDesc}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                </SortHeader>
              ))}
              {ADOPTION_FIELDS.map((a, i) => (
                <SortHeader
                  key={a.key}
                  active={sortKey === a.key}
                  desc={sortDesc}
                  onClick={() => toggleSort(a.key)}
                  className={i === 0 ? "border-l border-border/60" : undefined}
                >
                  <span className="flex flex-col items-end leading-tight">
                    <span className="text-[10px] text-muted-foreground/70">{a.group}</span>
                    <span className="inline-flex items-center gap-1">
                      {a.metric}
                      {a.key === "inclusivePushed" ? <InfoHint hint={ADOPTION_HINT} /> : null}
                    </span>
                  </span>
                </SortHeader>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedShi.map((shiRow) => {
              const isOpen = expanded.has(shiRow.shi)
              const children = shiRow.children ?? []
              return (
                <React.Fragment key={shiRow.shi}>
                  <tr className="border-b border-border/60">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary disabled:cursor-default disabled:hover:text-foreground"
                        disabled={children.length === 0}
                        onClick={() => toggleExpand(shiRow.shi)}
                      >
                        {children.length > 0 ? (
                          isOpen ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )
                        ) : (
                          <span className="inline-block size-3.5" />
                        )}
                        {orgLabelOf(shiRow)}
                      </button>
                    </td>
                    {renderCells(shiRow)}
                  </tr>
                  {isOpen &&
                    children.map((groupRow) => (
                      <tr
                        key={`${shiRow.shi}/${groupRow.group}`}
                        className="border-b border-border/40 bg-muted/20"
                      >
                        <td className="px-3 py-2 pl-9 text-muted-foreground">
                          {orgLabelOf(groupRow)}
                        </td>
                        {renderCells(groupRow)}
                      </tr>
                    ))}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
