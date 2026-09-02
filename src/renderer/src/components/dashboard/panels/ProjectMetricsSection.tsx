import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Search
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  ProjectMetricFilters,
  ProjectMetricListOptions,
  ProjectMetricProjectsData,
  ProjectMetricProjectItem,
  ProjectMetricSummaryData,
  ProjectMetricSummaryGroup
} from "../../../../../shared/project-metrics"

const PHASE_OPTIONS = [
  "ST中",
  "ST完成",
  "UAT业务审核",
  "UAT完成",
  "上线中",
  "上线完成",
  "开发中",
  "结项中",
  "结项完成",
  "计划中"
]

const ALL_VALUE = "__all__"
const FILTER_CONTROL_CLASS =
  "h-8 rounded-md border-input bg-background text-xs font-normal shadow-sm"

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatMetric(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits)
}

function formatCount(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString("zh-CN")
}

function formatCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatDays(value: number | null): string {
  const metric = formatMetric(value)
  return metric === "—" ? metric : `${metric} 天`
}

function formatSourceDateTime(value: string | null): string {
  return value ? value.replace("T", " ").replace(/\.\d+$/, "") : "—"
}

function TimeScopeTip(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            aria-label="查看项目指标时间口径"
          >
            <Info className="size-3.5" />
            口径说明
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[420px] text-xs leading-relaxed">
          日期、室组仅用于筛选项目；缺陷数、功能点均为 T-1 数据；代码行数取所选 CMBDevClaw
          项目截至查询时的累计已 Push 采纳行数；输入/输出 Token 取所选 CMBDevClaw
          项目截至查询时的累计 trace Token。日期不用于截断代码行数或 Token。
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function MetricHint({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`查看${label}口径`}
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[360px] text-xs leading-relaxed">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function summaryGroup(
  data: ProjectMetricSummaryData | null,
  mode: "devclaw" | "non_devclaw"
): ProjectMetricSummaryGroup | null {
  return data?.groups.find((group) => group.developmentMode === mode) ?? null
}

function SummaryValue({
  value,
  sample,
  formatter = formatMetric,
  tone
}: {
  value: number | null
  sample?: number
  formatter?: (value: number | null) => string
  tone: "devclaw" | "non_devclaw"
}): React.JSX.Element {
  return (
    <div>
      <div
        className={cn(
          "text-base font-semibold tabular-nums",
          tone === "devclaw"
            ? "text-sky-700 dark:text-sky-300"
            : "text-amber-800 dark:text-amber-300"
        )}
      >
        {formatter(value)}
      </div>
      {sample === undefined ? null : (
        <div className="text-[10px] text-muted-foreground">有效样本 {sample}</div>
      )}
    </div>
  )
}

function SummaryTokenPerLineValue({
  input,
  output,
  sample,
  tone
}: {
  input: number | null
  output: number | null
  sample?: number
  tone: "devclaw" | "non_devclaw"
}): React.JSX.Element {
  if (input === null && output === null) {
    return <SummaryValue value={null} sample={sample} tone={tone} />
  }
  return (
    <div>
      <div
        className={cn(
          "space-y-0.5 text-sm font-semibold tabular-nums",
          tone === "devclaw"
            ? "text-sky-700 dark:text-sky-300"
            : "text-amber-800 dark:text-amber-300"
        )}
      >
        <div>输入 Token/行 {formatCompact(input)}</div>
        <div>输出 Token/行 {formatCompact(output)}</div>
      </div>
      {sample === undefined ? null : (
        <div className="text-[10px] text-muted-foreground">有效样本 {sample}</div>
      )}
    </div>
  )
}

interface SummaryMetricRow {
  label: string
  hint: React.ReactNode
  read?: (group: ProjectMetricSummaryGroup) => number | null
  readPair?: (group: ProjectMetricSummaryGroup) => { input: number | null; output: number | null }
  sample?: keyof ProjectMetricSummaryGroup["samples"]
  formatter?: (value: number | null) => string
}

function SummaryMetricValue({
  row,
  group,
  tone
}: {
  row: SummaryMetricRow
  group: ProjectMetricSummaryGroup | null
  tone: "devclaw" | "non_devclaw"
}): React.JSX.Element {
  const sample = row.sample && group ? group.samples[row.sample] : undefined
  if (row.readPair) {
    const pair = group ? row.readPair(group) : { input: null, output: null }
    return (
      <SummaryTokenPerLineValue
        input={pair.input}
        output={pair.output}
        sample={sample}
        tone={tone}
      />
    )
  }
  return (
    <SummaryValue
      value={group && row.read ? row.read(group) : null}
      sample={sample}
      formatter={row.formatter}
      tone={tone}
    />
  )
}

function SummaryComparison({
  data,
  loading,
  error,
  adapterName,
  tokenConsumptionFiltered
}: {
  data: ProjectMetricSummaryData | null
  loading: boolean
  error: string | null
  adapterName: string
  tokenConsumptionFiltered: boolean
}): React.JSX.Element {
  const devclaw = summaryGroup(data, "devclaw")
  const nonDevclaw = summaryGroup(data, "non_devclaw")
  const rows: SummaryMetricRow[] = [
    {
      label: "平均缺陷数",
      hint: "无缺陷的项目按 0 计算",
      read: (group) => group.avgBugCount,
      sample: "bug"
    },
    {
      label: "平均功能点",
      hint: "仅统计已有功能点结算的项目",
      read: (group) => group.avgFuncPointCount,
      sample: "functionPoint"
    },
    {
      label: "平均缺陷密度",
      hint: "缺陷密度 = 有效项目的缺陷数之和 × 100 ÷ 功能点之和，不计算未结算功能点的项目",
      read: (group) => group.defectDensityPer100Fp,
      sample: "defectDensity"
    },
    {
      label: "平均千行代码缺陷率",
      hint: "千行代码缺陷率 = CMBDevClaw 开发项目的缺陷数之和 × 1000 ÷ 累计已 Push 采纳行数之和。",
      read: (group) => group.defectRatePerKloc,
      sample: "defectRate"
    },
    {
      label: "平均发起 ST 耗时",
      hint: "ST 发起时间 - 立项时间",
      read: (group) => group.avgTestLeadDays,
      sample: "testLead",
      formatter: formatDays
    },
    {
      label: "平均特性上线耗时",
      hint: "首次实施日期 - 特性审批通过时间",
      read: (group) => group.avgDeliveryDays,
      sample: "delivery",
      formatter: formatDays
    },
    {
      label: "平均输入 Token",
      hint: "CMBDevClaw 项目的累计输入 Token 之和 ÷ CMBDevClaw 项目数",
      read: (group) => group.avgInputTokens,
      sample: "token",
      formatter: formatCompact
    },
    {
      label: "平均输出 Token",
      hint: "CMBDevClaw 项目的累计输出 Token 之和 ÷ CMBDevClaw 项目数",
      read: (group) => group.avgOutputTokens,
      sample: "token",
      formatter: formatCompact
    },
    {
      label: "平均代码行数",
      hint: "CMBDevClaw 项目的累计已 Push 采纳行数之和 ÷ CMBDevClaw 项目数。没有采纳行的项目按 0 计入。",
      read: (group) => group.avgPushedAdoptedLines,
      sample: "codeLines",
      formatter: formatCompact
    },
    {
      label: "平均单行代码消耗 Token",
      hint: "CMBDevClaw 项目的累计输入 Token、累计输出 Token ÷ 同一批项目的累计已 Push 采纳行数。只统计代码行数大于 0 的项目。",
      readPair: (group) => ({
        input: group.inputTokensPerAdoptedLine,
        output: group.outputTokensPerAdoptedLine
      }),
      sample: "tokensPerLine"
    }
  ]

  if (loading && !data) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在统计项目指标
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        {error}
      </div>
    )
  }

  return (
    <div>
      {adapterName || tokenConsumptionFiltered ? (
        <div className="mb-3 rounded-md bg-status-warning/10 px-3 py-2 text-xs leading-relaxed text-status-warning-foreground">
          CMBDevClaw 侧已按
          {[adapterName ? "插件" : "", tokenConsumptionFiltered ? "Token 消耗" : ""]
            .filter(Boolean)
            .join("和")}
          收窄；非 CMBDevClaw 侧不受筛选影响，两侧样本范围不对称。
        </div>
      ) : null}
      {error ? (
        <div className="mb-3 text-xs text-destructive">刷新失败，当前展示上一次结果：{error}</div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="text-left text-xs">
            <tr>
              <th className="w-[38%] bg-muted/40 px-4 py-3 font-medium text-muted-foreground">
                对比指标
              </th>
              <th className="border-l border-sky-500/15 bg-sky-500/10 px-4 py-3">
                <div className="flex items-center gap-2 font-semibold text-sky-800 dark:text-sky-200">
                  <span className="size-2 rounded-full bg-sky-500" />
                  CMBDevClaw
                  <span className="ml-auto font-normal tabular-nums text-sky-700/70 dark:text-sky-300/70">
                    {formatCount(devclaw?.projectCount ?? null)} 项目
                  </span>
                </div>
              </th>
              <th className="border-l border-amber-500/15 bg-amber-500/10 px-4 py-3">
                <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
                  <span className="size-2 rounded-full bg-amber-500" />非 CMBDevClaw 项目
                  <span className="ml-auto font-normal tabular-nums text-amber-800/70 dark:text-amber-300/70">
                    {formatCount(nonDevclaw?.projectCount ?? null)} 项目
                  </span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((row) => (
              <tr key={row.label} className="transition-colors hover:bg-muted/20">
                <td className="bg-muted/[0.16] px-4 py-2.5 font-medium text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <span>{row.label}</span>
                    <MetricHint label={row.label}>{row.hint}</MetricHint>
                  </div>
                </td>
                <td className="border-l border-sky-500/10 bg-sky-500/[0.025] px-4 py-2.5">
                  <SummaryMetricValue row={row} group={devclaw} tone="devclaw" />
                </td>
                <td className="border-l border-amber-500/10 bg-amber-500/[0.025] px-4 py-2.5">
                  <SummaryMetricValue row={row} group={nonDevclaw} tone="non_devclaw" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PhaseFilter({
  value,
  onChange
}: {
  value: string[]
  onChange: (value: string[]) => void
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(FILTER_CONTROL_CLASS, "w-40 justify-between px-3")}
        >
          <span className="truncate">
            {value.length === 0 ? "全部阶段" : `已选 ${value.length} 个阶段`}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            全部阶段
          </label>
          {PHASE_OPTIONS.map((phase) => {
            const checked = value.includes(phase)
            return (
              <label
                key={phase}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(checked ? value.filter((item) => item !== phase) : [...value, phase])
                  }
                />
                {phase}
              </label>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

type ProjectMetricSortKey = NonNullable<ProjectMetricListOptions["sortBy"]>

function SortableProjectMetricTh({
  label,
  sortKey,
  activeKey,
  order,
  onSort,
  title
}: {
  label: string
  sortKey: ProjectMetricSortKey
  activeKey: ProjectMetricSortKey
  order: "asc" | "desc"
  onSort: (key: ProjectMetricSortKey) => void
  title?: string
}): React.JSX.Element {
  const active = activeKey === sortKey
  const Icon = active ? (order === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title ?? `按${label}排序`}
        className={cn(
          "ml-auto inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span>{label}</span>
        <Icon className={cn("size-3 shrink-0", active ? "opacity-100" : "opacity-40")} />
      </button>
    </th>
  )
}

function ProjectDateMetric({
  value,
  label,
  dates
}: {
  value: number | null
  label: string
  dates: Array<{ label: string; value: string | null }>
}): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`查看${label}时间明细`}
            className="cursor-help border-b border-dashed border-muted-foreground/40 tabular-nums hover:border-foreground/60 hover:text-foreground"
          >
            {formatDays(value)}
          </button>
        </TooltipTrigger>
        <TooltipContent className="min-w-64 text-xs">
          <div className="mb-1.5 font-medium text-foreground">{label}</div>
          <dl className="space-y-1">
            {dates.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-5">
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd className="font-mono tabular-nums">{formatSourceDateTime(item.value)}</dd>
              </div>
            ))}
          </dl>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ProjectRow({ item }: { item: ProjectMetricProjectItem }): React.JSX.Element {
  const projectName = item.prjName || "—"
  const projectCode = item.prjCode || "—"
  const pluginNames = item.developmentMode === "devclaw" ? item.plugins.join("、") || "--" : "--"
  return (
    <tr className="border-t border-border align-top">
      <td className="min-w-0 overflow-hidden px-3 py-2">
        <div className="truncate whitespace-nowrap font-medium text-foreground" title={projectName}>
          {projectName}
        </div>
        <div
          className="mt-0.5 truncate whitespace-nowrap font-mono text-[10px] text-muted-foreground"
          title={projectCode}
        >
          {projectCode}
        </div>
      </td>
      <td className="min-w-0 overflow-hidden px-3 py-2 text-muted-foreground">
        <div className="truncate whitespace-nowrap" title={pluginNames}>
          {pluginNames}
        </div>
      </td>
      <td className="px-3 py-2">
        <div>{item.roomName || "—"}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">{item.groupName || "—"}</div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatCount(item.bugNum)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatMetric(item.notAdjustFuns)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatMetric(item.defectDensityPer100Fp)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatMetric(item.defectRatePerKloc)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        <ProjectDateMetric
          value={item.testLeadDays}
          label="发起 ST 耗时"
          dates={[
            { label: "ST 发起时间", value: item.firstStStartDate },
            { label: "立项时间", value: item.createDate }
          ]}
        />
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        <ProjectDateMetric
          value={item.deliveryDays}
          label="特性上线耗时"
          dates={[
            { label: "特性审批通过时间", value: item.approvedDate },
            { label: "首次实施日期", value: item.firstOnlineDate }
          ]}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
        <div>输入 Token {formatCompact(item.totalInputTokens)}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          输出 Token {formatCompact(item.totalOutputTokens)}
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatCompact(item.pushedAdoptedLines)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
        <div>输入 Token/行 {formatCompact(item.inputTokensPerAdoptedLine)}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          输出 Token/行 {formatCompact(item.outputTokensPerAdoptedLine)}
        </div>
      </td>
    </tr>
  )
}

export function ProjectMetricsSection({
  range,
  upperOrgLv1,
  refreshKey
}: {
  range: { from: string; to: string }
  upperOrgLv1: string[]
  refreshKey: number
}): React.JSX.Element {
  const [phaseStatuses, setPhaseStatuses] = useState<string[]>([])
  const [functionPointMin, setFunctionPointMin] = useState("")
  const [functionPointMax, setFunctionPointMax] = useState("")
  const [debouncedFunctionPointMin, setDebouncedFunctionPointMin] = useState("")
  const [debouncedFunctionPointMax, setDebouncedFunctionPointMax] = useState("")
  const [tokenConsumptionMin, setTokenConsumptionMin] = useState("")
  const [tokenConsumptionMax, setTokenConsumptionMax] = useState("")
  const [debouncedTokenConsumptionMin, setDebouncedTokenConsumptionMin] = useState("")
  const [debouncedTokenConsumptionMax, setDebouncedTokenConsumptionMax] = useState("")
  const [adapterName, setAdapterName] = useState("")
  const [developmentMode, setDevelopmentMode] = useState<"all" | "devclaw" | "non_devclaw">("all")
  const [keyword, setKeyword] = useState("")
  const [debouncedKeyword, setDebouncedKeyword] = useState("")
  const [departmentKeyword, setDepartmentKeyword] = useState("")
  const [debouncedDepartmentKeyword, setDebouncedDepartmentKeyword] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(20)
  const [sortBy, setSortBy] = useState<ProjectMetricSortKey>("deliveryDays")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")
  const [summary, setSummary] = useState<ProjectMetricSummaryData | null>(null)
  const [projects, setProjects] = useState<ProjectMetricProjectsData | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const summaryRequestId = useRef(0)
  const projectsRequestId = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword.trim())
      setDebouncedDepartmentKeyword(departmentKeyword.trim())
    }, 300)
    return () => clearTimeout(timer)
  }, [departmentKeyword, keyword])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFunctionPointMin(functionPointMin)
      setDebouncedFunctionPointMax(functionPointMax)
      setDebouncedTokenConsumptionMin(tokenConsumptionMin)
      setDebouncedTokenConsumptionMax(tokenConsumptionMax)
    }, 300)
    return () => clearTimeout(timer)
  }, [functionPointMax, functionPointMin, tokenConsumptionMax, tokenConsumptionMin])

  const filters = useMemo<ProjectMetricFilters>(
    () => ({
      range,
      upperOrgLv1,
      phaseStatuses,
      functionPointMin: nullableNumber(debouncedFunctionPointMin),
      functionPointMax: nullableNumber(debouncedFunctionPointMax),
      tokenConsumptionMin: nullableNumber(debouncedTokenConsumptionMin),
      tokenConsumptionMax: nullableNumber(debouncedTokenConsumptionMax),
      adapterName: adapterName || null
    }),
    [
      adapterName,
      debouncedFunctionPointMax,
      debouncedFunctionPointMin,
      debouncedTokenConsumptionMax,
      debouncedTokenConsumptionMin,
      phaseStatuses,
      range,
      upperOrgLv1
    ]
  )
  const listOptions = useMemo<ProjectMetricListOptions>(
    () => ({
      developmentMode,
      keyword: debouncedKeyword,
      departmentKeyword: debouncedDepartmentKeyword,
      page,
      pageSize,
      sortBy,
      sortOrder
    }),
    [
      debouncedDepartmentKeyword,
      debouncedKeyword,
      developmentMode,
      page,
      pageSize,
      sortBy,
      sortOrder
    ]
  )

  useEffect(() => {
    const requestId = ++summaryRequestId.current
    async function loadSummary(): Promise<void> {
      setSummaryLoading(true)
      setSummaryError(null)
      try {
        const result = await window.api.dashboard.projectMetricSummary(filters)
        if (requestId !== summaryRequestId.current) return
        if (!result.success) throw new Error(result.error || "获取项目总体指标失败")
        setSummary(result.data ?? null)
      } catch (error) {
        if (requestId !== summaryRequestId.current) return
        setSummaryError(error instanceof Error ? error.message : String(error))
      } finally {
        if (requestId === summaryRequestId.current) setSummaryLoading(false)
      }
    }
    void loadSummary()
  }, [filters, refreshKey])

  useEffect(() => {
    const requestId = ++projectsRequestId.current
    async function loadProjects(): Promise<void> {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const result = await window.api.dashboard.projectMetricProjects(filters, listOptions)
        if (requestId !== projectsRequestId.current) return
        if (!result.success) throw new Error(result.error || "获取项目明细失败")
        const next = result.data ?? null
        setProjects(next)
        if (next) {
          const maxPage = Math.max(1, Math.ceil(next.total / next.pageSize))
          setPage((current) => (current > maxPage ? maxPage : current))
        }
      } catch (error) {
        if (requestId !== projectsRequestId.current) return
        setProjectsError(error instanceof Error ? error.message : String(error))
      } finally {
        if (requestId === projectsRequestId.current) setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [filters, listOptions, refreshKey])

  const totalPages = Math.max(1, Math.ceil((projects?.total ?? 0) / pageSize))
  const truncated = summary?.truncated || projects?.truncated
  const cycleSort = (key: ProjectMetricSortKey): void => {
    setPage(1)
    if (sortBy !== key) {
      setSortBy(key)
      setSortOrder("desc")
      return
    }
    if (sortOrder === "desc") {
      setSortOrder("asc")
      return
    }
    setSortBy("deliveryDays")
    setSortOrder("desc")
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">项目质量与交付</h2>
        </div>
        <div className="flex items-center gap-3">
          <TimeScopeTip />
          {summaryLoading || projectsLoading ? (
            <div className="flex items-center text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              更新中
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PhaseFilter
          value={phaseStatuses}
          onChange={(value) => {
            setPhaseStatuses(value)
            setPage(1)
          }}
        />
        <Input
          type="number"
          min="0"
          value={functionPointMin}
          onChange={(event) => {
            setFunctionPointMin(event.target.value)
            setPage(1)
          }}
          placeholder="功能点下限"
          className={cn(FILTER_CONTROL_CLASS, "w-28")}
        />
        <span className="text-xs text-muted-foreground">至</span>
        <Input
          type="number"
          min="0"
          value={functionPointMax}
          onChange={(event) => {
            setFunctionPointMax(event.target.value)
            setPage(1)
          }}
          placeholder="功能点上限"
          className={cn(FILTER_CONTROL_CLASS, "w-28")}
        />
        <Input
          type="number"
          min="0"
          value={tokenConsumptionMin}
          disabled={developmentMode === "non_devclaw"}
          onChange={(event) => {
            setTokenConsumptionMin(event.target.value)
            setPage(1)
          }}
          placeholder="Token 消耗下限"
          className={cn(FILTER_CONTROL_CLASS, "w-32")}
        />
        <span className="text-xs text-muted-foreground">至</span>
        <Input
          type="number"
          min="0"
          value={tokenConsumptionMax}
          disabled={developmentMode === "non_devclaw"}
          onChange={(event) => {
            setTokenConsumptionMax(event.target.value)
            setPage(1)
          }}
          placeholder="Token 消耗上限"
          className={cn(FILTER_CONTROL_CLASS, "w-32")}
        />
        <Select
          value={adapterName || ALL_VALUE}
          disabled={developmentMode === "non_devclaw"}
          onValueChange={(value) => {
            setAdapterName(value === ALL_VALUE ? "" : value)
            setPage(1)
          }}
        >
          <SelectTrigger className={cn(FILTER_CONTROL_CLASS, "w-48")}>
            <SelectValue placeholder="全部插件" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>全部插件</SelectItem>
            {(summary?.pluginOptions ?? []).map((plugin) => (
              <SelectItem key={plugin} value={plugin}>
                {plugin}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {truncated ? (
        <div className="mt-3 rounded-md bg-status-warning/10 px-3 py-2 text-xs leading-relaxed text-status-warning-foreground">
          项目关联或派生指标排序样本超过 10,000
          条，当前结果基于截断数据，可能存在统计不完整或开发方式误分类。
        </div>
      ) : null}

      <div className="mt-5">
        <SummaryComparison
          data={summary}
          loading={summaryLoading}
          error={summaryError}
          adapterName={adapterName}
          tokenConsumptionFiltered={
            nullableNumber(debouncedTokenConsumptionMin) !== null ||
            nullableNumber(debouncedTokenConsumptionMax) !== null
          }
        />
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-foreground">项目明细</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={developmentMode}
              onValueChange={(value: "all" | "devclaw" | "non_devclaw") => {
                setDevelopmentMode(value)
                if (value === "non_devclaw") {
                  setAdapterName("")
                  setTokenConsumptionMin("")
                  setTokenConsumptionMax("")
                  setDebouncedTokenConsumptionMin("")
                  setDebouncedTokenConsumptionMax("")
                }
                setPage(1)
              }}
            >
              <SelectTrigger className={cn(FILTER_CONTROL_CLASS, "w-40")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部开发方式</SelectItem>
                <SelectItem value="devclaw">CMBDevClaw</SelectItem>
                <SelectItem value="non_devclaw">非 CMBDevClaw 项目</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value)
                  setPage(1)
                }}
                placeholder="搜索项目编号 / 名称"
                className={cn(FILTER_CONTROL_CLASS, "w-52 pl-8")}
              />
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={departmentKeyword}
                onChange={(event) => {
                  setDepartmentKeyword(event.target.value)
                  setPage(1)
                }}
                placeholder="搜索室 / 组"
                className={cn(FILTER_CONTROL_CLASS, "w-52 pl-8")}
              />
            </div>
          </div>
        </div>

        {projectsError ? (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            {projectsError}
          </div>
        ) : null}

        <div className="mt-3 overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[1580px] table-fixed text-xs">
            <colgroup>
              <col className="w-[250px]" />
              <col className="w-[190px]" />
              <col className="w-[190px]" />
              <col className="w-[90px]" />
              <col className="w-[90px]" />
              <col className="w-[105px]" />
              <col className="w-[125px]" />
              <col className="w-[120px]" />
              <col className="w-[125px]" />
              <col className="w-[155px]" />
              <col className="w-[105px]" />
              <col className="w-[205px]" />
            </colgroup>
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">项目编号 / 名称</th>
                <th className="px-3 py-2 font-medium">CMBDevClaw 插件</th>
                <th className="px-3 py-2 font-medium">部门</th>
                <SortableProjectMetricTh
                  label="缺陷数"
                  sortKey="bugNum"
                  activeKey={sortBy}
                  order={sortOrder}
                  onSort={cycleSort}
                />
                <SortableProjectMetricTh
                  label="功能点"
                  sortKey="notAdjustFuns"
                  activeKey={sortBy}
                  order={sortOrder}
                  onSort={cycleSort}
                />
                <th className="px-3 py-2 text-right font-medium">缺陷密度</th>
                <th className="px-3 py-2 text-right font-medium">千行代码缺陷率</th>
                <th className="px-3 py-2 text-right font-medium">发起 ST 耗时</th>
                <SortableProjectMetricTh
                  label="特性上线耗时"
                  sortKey="deliveryDays"
                  activeKey={sortBy}
                  order={sortOrder}
                  onSort={cycleSort}
                  title="按特性上线耗时排序"
                />
                <th className="px-3 py-2 text-right font-medium">Token</th>
                <SortableProjectMetricTh
                  label="代码行数"
                  sortKey="pushedAdoptedLines"
                  activeKey={sortBy}
                  order={sortOrder}
                  onSort={cycleSort}
                  title="按已 Push 采纳行数排序"
                />
                <SortableProjectMetricTh
                  label="单行代码消耗 Token 数"
                  sortKey="tokensPerAdoptedLine"
                  activeKey={sortBy}
                  order={sortOrder}
                  onSort={cycleSort}
                  title="按输入与输出总 Token/行排序"
                />
              </tr>
            </thead>
            <tbody>
              {projectsLoading && !projects ? (
                <tr>
                  <td colSpan={12} className="h-28 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline size-4 animate-spin" />
                    正在加载项目明细
                  </td>
                </tr>
              ) : (projects?.items.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={12} className="h-28 text-center text-muted-foreground">
                    暂无符合条件的项目
                  </td>
                </tr>
              ) : (
                projects?.items.map((item) => <ProjectRow key={item.prjCode} item={item} />)
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <div>
            共 {formatCount(projects?.total ?? 0)} 个项目 · 第 {page}/{totalPages} 页
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value) as 20 | 50 | 100)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20 条/页</SelectItem>
                <SelectItem value="50">50 条/页</SelectItem>
                <SelectItem value="100">100 条/页</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={page <= 1 || projectsLoading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft className="mr-1 size-3.5" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={page >= totalPages || projectsLoading}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              下一页
              <ChevronRight className="ml-1 size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
