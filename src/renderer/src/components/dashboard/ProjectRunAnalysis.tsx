import { Fragment, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react"
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Info,
  Loader2,
  RefreshCw
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type {
  RunAnalysisData,
  RunAnalysisFeature,
  RunAnalysisMembership,
  RunAnalysisOptions,
  RunAnalysisRange,
  RunAnalysisSession,
  RunAnalysisSessionRequest,
  RunAnalysisSessions,
  RunAnalysisStages
} from "../../../../shared/project-run-analysis"
import { RUN_ANALYSIS_NOTES } from "../../../../shared/project-run-analysis"
import {
  DEFAULT_RUN_ANALYSIS_FILTERS,
  RUN_ANALYSIS_PRESETS,
  filterRunAnalysis,
  groupRunAnalysis,
  idleDays,
  runAnalysisExportRows,
  runAnalysisPreset,
  runAnalysisPresetCounts,
  runAnalysisFilterChips,
  clearRunAnalysisFilter,
  runAnalysisSummary,
  type RunAnalysisFilters,
  type RunAnalysisMatch,
  type RunAnalysisProjectMatch,
  type RunAnalysisSort
} from "./project-run-analysis-view"
import { TraceExplorer } from "./TraceHistoryDialog"
import type { DashboardTraceDetail } from "./use-dashboard"

const selectClass = "h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs"
const linkClass =
  "text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
const count = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("zh-CN"))
const percent = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`)
const duration = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n < 3600000
      ? `${(n / 60000).toFixed(1)}分钟`
      : `${(n / 3600000).toFixed(1)}小时`
const date = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN") : "—")
const days = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}天`)
const noSkillLabel = (row: { conversationCount: number; noSkillConversationCount: number }) =>
  row.conversationCount
    ? `${row.noSkillConversationCount}/${row.conversationCount}轮 (${percent(row.noSkillConversationCount / row.conversationCount)})`
    : "—"
function AnalysisLink({ children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      aria-label={props["aria-label"] ?? (typeof children === "string" ? children : undefined)}
      className={`${className ?? linkClass} inline-flex items-center gap-0.5`}
    >
      {children}
      <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
    </button>
  )
}
function Hint({ note }: { note: string }) {
  return (
    <span
      title={note}
      aria-label={note}
      tabIndex={0}
      className="ml-1 inline-flex cursor-help align-middle text-muted-foreground"
    >
      <Info className="size-3" />
    </span>
  )
}

export interface ProjectRunAnalysisProps {
  range: RunAnalysisRange
  options: RunAnalysisOptions
  active?: boolean
  refreshKey?: number
  loadData?: (range: RunAnalysisRange, opts: RunAnalysisOptions) => Promise<RunAnalysisData>
  onOpenFeatureCommits?: (row: RunAnalysisFeature, pushedOnly?: boolean) => void
  onOpenCodeTrace?: (row: RunAnalysisFeature) => void
}
export function ProjectRunAnalysis({
  range,
  options,
  active = true,
  refreshKey = 0,
  loadData,
  onOpenFeatureCommits,
  onOpenCodeTrace
}: ProjectRunAnalysisProps): React.JSX.Element {
  const [membership, setMembership] = useState<RunAnalysisMembership>("active")
  const [filters, setFilters] = useState<RunAnalysisFilters>({ ...DEFAULT_RUN_ANALYSIS_FILTERS })
  const [preset, setPreset] = useState("")
  const [sort, setSort] = useState<RunAnalysisSort>("idle")
  const [desc, setDesc] = useState(true)
  const [mode, setMode] = useState<"feature" | "project">("feature")
  const [advanced, setAdvanced] = useState(false)
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [result, setResult] = useState<{ key: string; data: RunAnalysisData } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState("")
  const [diagnose, setDiagnose] = useState<RunAnalysisFeature | null>(null)
  const [sessions, setSessions] = useState<RunAnalysisSessionRequest | null>(null)
  const completed = useRef<{
    key: string
    at: number
    loader: ProjectRunAnalysisProps["loadData"]
  } | null>(null)
  const handledRefresh = useRef({ refresh, refreshKey })
  const key = JSON.stringify([range, options, membership, refresh, refreshKey])
  const data = result?.key === key ? result.data : null
  useEffect(() => {
    if (!active) return
    if (
      completed.current?.key === key &&
      completed.current.loader === loadData &&
      Date.now() - completed.current.at < 30000
    )
      return
    let cancelled = false
    let settled = false
    const forceRefresh =
      refresh !== handledRefresh.current.refresh || refreshKey !== handledRefresh.current.refreshKey
    setLoading(true)
    setError(null)
    setPage(1)
    setDiagnose(null)
    setSessions(null)
    const [r, o, m] = JSON.parse(key) as [
      RunAnalysisRange,
      RunAnalysisOptions,
      RunAnalysisMembership
    ]
    const requestOptions = { ...o, membership: m, refresh: forceRefresh }
    const promise = loadData
      ? loadData(r, requestOptions)
      : window.api.dashboard.projectModeRunAnalysis(r, requestOptions).then((res) => {
          if (!res.success || !res.data) throw new Error(res.error ?? "获取运行分析失败")
          return res.data
        })
    void promise
      .then((value) => {
        if (!cancelled) {
          completed.current = { key, at: Date.now(), loader: loadData }
          handledRefresh.current = { refresh, refreshKey }
          setResult({ key, data: value })
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        settled = true
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (!settled && !loadData)
        void window.api.dashboard
          .cancelRequests?.(["dashboard:projectModeRunAnalysis"])
          .catch(() => undefined)
    }
  }, [key, active, loadData, refresh, refreshKey])
  const matches = useMemo(
    () => (data ? filterRunAnalysis(data, filters, sort, desc) : []),
    [data, filters, sort, desc]
  )
  const groups = useMemo(
    () => (data ? groupRunAnalysis(data, matches, sort, desc) : []),
    [data, matches, sort, desc]
  )
  const presetCounts = useMemo(
    () => (data ? runAnalysisPresetCounts(data, filters) : null),
    [data, filters]
  )
  const filterChips = runAnalysisFilterChips(filters)
  const all = mode === "feature" ? matches : groups
  const maxPage = Math.max(1, Math.ceil(all.length / 20)),
    currentPage = Math.min(page, maxPage)
  const visible = all.slice((currentPage - 1) * 20, currentPage * 20)
  const stages = [...new Set(data?.rows.map((r) => r.currentStage ?? "__missing__") ?? [])].sort()
  const plugins = [
    ...new Map(
      data?.rows.map((r) => [
        JSON.stringify([r.adapterName, r.adapterVersion]),
        `${r.adapterName ?? "未知插件"}${r.adapterVersion ? ` @${r.adapterVersion}` : ""}`
      ]) ?? []
    ).entries()
  ]
  const statuses = [
    ...new Set(data?.rows.map((r) => r.currentStatus ?? "__missing__") ?? [])
  ].sort()
  const update = <K extends keyof RunAnalysisFilters>(name: K, value: RunAnalysisFilters[K]) => {
    if (!["keyword", "plugin", "stage", "status"].includes(name)) setPreset("")
    setFilters((f) => ({ ...f, [name]: value }))
    setPage(1)
  }
  const request = (
    row: RunAnalysisFeature,
    metric: RunAnalysisSessionRequest["metric"],
    nodeName?: string | null
  ) =>
    setSessions({
      ...options,
      projectId: row.projectId,
      featureSlug: row.featureSlug,
      metric,
      ...(nodeName !== undefined ? { nodeName } : {})
    })
  const copy = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(runAnalysisSummary(data, matches))
      setNotice("已复制当前筛选汇总")
    } catch {
      setNotice("复制失败，请检查剪贴板权限")
    }
  }
  const exportExcel = async () => {
    if (!data) return
    try {
      const XLSX = await import("xlsx")
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.json_to_sheet(runAnalysisExportRows(data, matches)),
        "匹配特性"
      )
      if (mode === "project")
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.json_to_sheet(
            groups.map((g) => ({
              ...runAnalysisExportRows(data, [g])[0],
              名单内特性数: g.totalFeatures,
              匹配特性数: g.features.filter((f) => f.row.featureSlug !== null).length,
              匹配特性: g.features.map((f) => f.row.featureTitle).join("；")
            }))
          ),
          "项目汇总"
        )
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.json_to_sheet([
          {
            筛选: JSON.stringify(filters),
            排序: sort,
            方向: desc ? "降序" : "升序",
            名单范围: membership,
            说明: Object.values(RUN_ANALYSIS_NOTES).join(" "),
            查询开始: data.queryStartedAt,
            数据截至: data.dataAsOf
          }
        ]),
        "统计口径"
      )
      XLSX.writeFile(book, `运行分析-${new Date(data.dataAsOf).toISOString().slice(0, 10)}.xlsx`)
      setNotice(`已导出全部${matches.length}条匹配记录`)
    } catch (e) {
      setNotice(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const numberFilter = (name: keyof RunAnalysisFilters, label: string, factor = 1) => {
    const value = filters[name] as number | null
    return (
      <label className="flex min-w-0 items-center gap-2 text-xs" key={name}>
        <span className="flex-1">{label}</span>
        <Input
          aria-label={label}
          type="number"
          min="0"
          max={factor === 100 ? 100 : undefined}
          className="h-8 w-24 shrink-0 text-xs"
          value={value === null ? "" : value * factor}
          placeholder="不限"
          onChange={(e) =>
            update(
              name,
              e.target.value === ""
                ? null
                : Math.min(factor === 100 ? 100 : Infinity, Math.max(0, Number(e.target.value))) /
                    factor
            )
          }
        />
      </label>
    )
  }
  const renderRow = (match: RunAnalysisMatch | RunAnalysisProjectMatch, group = false) => {
    const r = match.row,
      g = group ? (match as RunAnalysisProjectMatch) : null
    return (
      <tr key={JSON.stringify([r.projectId, r.featureSlug])} className="border-t align-top">
        <td className="max-w-64 px-3 py-3">
          <div className="font-medium">{r.projectName}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {r.adapterName ?? "未知插件"} · {r.creator ?? "未知创建人"}
          </div>
          {g ? (
            <button
              aria-label={`展开${r.projectName}的匹配特性`}
              aria-expanded={expanded === r.projectId}
              className={`${linkClass} mt-2 flex items-center gap-1`}
              onClick={() => setExpanded(expanded === r.projectId ? null : r.projectId)}
            >
              {expanded === r.projectId ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}{" "}
              {g.features.filter((f) => f.row.featureSlug !== null).length}个匹配特性
            </button>
          ) : (
            <button
              aria-label={`查看${r.featureTitle}详情`}
              title={`${r.featureSlug ?? "未关联特性"}${!r.inSnapshot && r.featureSlug ? " · 历史观测" : ""}`}
              className={`${linkClass} mt-2 text-left`}
              onClick={() => setDiagnose(r)}
            >
              {r.featureTitle}
            </button>
          )}
        </td>
        <td className="px-3 py-3">
          {group ? (
            "见匹配特性"
          ) : (
            <>
              {r.currentStage ?? "—"}
              <div className="mt-1 text-muted-foreground">{r.currentStatus ?? "—"}</div>
            </>
          )}
        </td>
        <td className="px-3 py-3 whitespace-nowrap">
          {days(r.executionSpanMs === null ? null : r.executionSpanMs / 86400000)}
          <div className="mt-1 text-[11px] text-muted-foreground">
            累计 {duration(r.totalDurationMs)}
          </div>
        </td>
        <td className="px-3 py-3 whitespace-nowrap" title={date(r.lastExecutedAt)}>
          {data && r.lastExecutedAt ? `${days(idleDays(r, data.dataAsOf))}前` : "—"}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {r.lastExecutedAt
              ? new Date(r.lastExecutedAt).toLocaleDateString("zh-CN")
              : "暂无执行记录"}
          </div>
        </td>
        <td className="px-3 py-3 whitespace-nowrap">
          <AnalysisLink
            disabled={group || !r.featureSlug || !r.codeStats || !onOpenFeatureCommits}
            onClick={() => onOpenFeatureCommits?.(r)}
          >
            {percent(r.codeStats?.inclusiveAdoptionRate)}
          </AnalysisLink>
          <div
            className="mt-1 text-[11px] text-muted-foreground"
            title="采纳行数 / 全量有效生成行数"
          >
            {count(r.codeStats?.adoptedLines)} /{" "}
            {count(r.codeStats?.inclusiveEffectiveGeneratedLines)}行
          </div>
        </td>
        <td className="px-3 py-3 whitespace-nowrap">
          <span title="Harness 采纳行数 / VibeCoding 采纳行数">
            {count(r.harnessAdoptedLines)} / {count(r.vibeAdoptedLines)}行
          </span>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Vibe占比 {percent(r.vibeAdoptedShare)}
          </div>
        </td>
        <td className="px-3 py-3">
          <AnalysisLink
            disabled={group || !r.conversationCount}
            onClick={() => request(r, "noSkill")}
          >
            {count(r.noSkillConversationCount)}轮
          </AnalysisLink>
          <div className="mt-1 text-[11px] text-muted-foreground">
            共 {count(r.conversationCount)} 轮主对话
          </div>
        </td>
        <td
          className="px-3 py-3 whitespace-nowrap"
          title={`已上报工具调用的记录 ${r.toolReportedTraceCount}/${r.traceCount}；模型调用 ${r.modelReportedTraceCount}/${r.traceCount}`}
        >
          {count(r.toolCalls)} / {count(r.modelCalls)}
        </td>
        <td
          className="px-3 py-3 whitespace-nowrap"
          title={`分类覆盖 ${r.subagentClassifiedTraceCount}/${r.traceCount}；可去重记录 ${r.subagentIdentifiedTraceCount}/${r.subagentTurns}`}
        >
          {r.traceCount ? `${r.subagentCount}个` : "—"}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {r.traceCount ? `执行 ${r.subagentTurns} 轮` : ""}
          </div>
        </td>
        <td className="sticky right-0 bg-card px-3 py-3 whitespace-nowrap">
          {group ? (
            <AnalysisLink
              aria-label={`查看${r.projectName}的匹配特性`}
              onClick={() => setExpanded(expanded === r.projectId ? null : r.projectId)}
            >
              查看匹配特性
            </AnalysisLink>
          ) : (
            <AnalysisLink aria-label={`查看${r.featureTitle}详情`} onClick={() => setDiagnose(r)}>
              查看详情
            </AnalysisLink>
          )}
        </td>
      </tr>
    )
  }
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4"
      aria-label="运行分析"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-sm font-semibold">
          运行分析
          <Hint note={Object.values(RUN_ANALYSIS_NOTES).join("\n")} />
          {import.meta.env.DEV && (
            <span className="ml-2 text-[10px] font-normal text-amber-600">开发示例数据</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw className="mr-1 size-3" />
            刷新
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data || !matches.length}
            onClick={() => void copy()}
          >
            <Copy className="mr-1 size-3" />
            复制汇总
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data || !matches.length}
            onClick={() => void exportExcel()}
          >
            <Download className="mr-1 size-3" />
            导出Excel
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          查看范围
          <select
            aria-label="查看范围"
            className={selectClass}
            value={membership}
            onChange={(e) => setMembership(e.target.value as RunAnalysisMembership)}
          >
            <option value="active">进行中的全部项目</option>
            <option value="executed">所选日期内有执行（含归档）</option>
            <option value="created">所选日期内新建项目（含归档）</option>
          </select>
        </label>
        {membership !== "active" && (
          <span className="text-muted-foreground">
            {date(range.from)} 至 {date(range.to)}
          </span>
        )}
        <span className="text-muted-foreground">
          指标为累计数据；
          {membership === "active" ? "当前范围不受顶部日期限制" : "顶部日期仅用于筛选项目范围"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Input
          aria-label="项目或特性关键词"
          placeholder="搜索项目或特性"
          className="h-8 min-w-32 flex-1 text-xs sm:max-w-72"
          value={filters.keyword}
          onChange={(e) => update("keyword", e.target.value)}
        />
        <select
          aria-label="当前阶段"
          className={selectClass}
          value={filters.stage}
          onChange={(e) => update("stage", e.target.value)}
        >
          <option value="">全部阶段</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {s === "__missing__" ? "阶段未记录" : s}
            </option>
          ))}
        </select>
        <select
          aria-label="当前状态"
          className={selectClass}
          value={filters.status}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">全部状态</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s === "__missing__" ? "状态未记录" : s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs">
          快速筛选
          <select
            aria-label="快速筛选"
            className={selectClass}
            disabled={!data}
            value={
              preset ||
              (filterChips.some((c) => !["keyword", "plugin", "stage", "status"].includes(c.key))
                ? "custom"
                : "")
            }
            onChange={(e) => {
              const id = e.target.value
              setPreset(id)
              setFilters(runAnalysisPreset(id, filters))
              const selected = RUN_ANALYSIS_PRESETS.find((p) => p.key === id)
              if (selected) {
                setSort(selected.sort)
                setDesc(selected.desc)
              }
              setPage(1)
            }}
          >
            <option value="">全部</option>
            <option value="custom" disabled hidden>
              自定义条件
            </option>
            {RUN_ANALYSIS_PRESETS.map(({ key: id, label }) => (
              <option value={id} key={id}>
                {label}
                {presetCounts ? `（${presetCounts[id]}个特性）` : ""}
              </option>
            ))}
          </select>
        </label>
        <Button
          aria-label="更多筛选"
          aria-expanded={advanced}
          size="sm"
          variant={advanced ? "secondary" : "outline"}
          onClick={() => setAdvanced((v) => !v)}
        >
          更多筛选 <ChevronDown className="ml-1 size-3" />
        </Button>
      </div>
      {advanced && (
        <div className="space-y-3 rounded-md bg-muted/30 p-3">
          <label className="flex items-center gap-2 text-xs">
            插件 / 版本
            <select
              aria-label="分析插件"
              className={selectClass}
              value={filters.plugin}
              onChange={(e) => update("plugin", e.target.value)}
            >
              <option value="">全部插件 / 版本</option>
              {plugins.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-muted-foreground">
            结果需同时满足以下条件，留空表示不限。快捷筛选的默认条件也可以在这里调整。
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {numberFilter("idleDays", "距最近执行至少（天）")}
            {numberFilter("spanDays", "执行跨度至少（天）")}
            {numberFilter("adoptionMax", "采纳率不高于（%）", 100)}
            {numberFilter("minCodeLines", "有效生成行数至少（行）")}
            {numberFilter("vibeMin", "Vibe采纳占比至少（%）", 100)}
            {numberFilter("noSkillMin", "未使用 Skill 主对话不少于（轮）")}
            {numberFilter("toolMin", "工具调用不少于（次）")}
            {numberFilter("modelMin", "模型调用不少于（次）")}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {filterChips.map((chip) => (
          <button
            key={chip.key}
            aria-label={`移除筛选：${chip.label}`}
            className="rounded-full border bg-muted/40 px-2 py-1"
            onClick={() => {
              setFilters(clearRunAnalysisFilter(filters, chip.key))
              if (!["keyword", "plugin", "stage", "status"].includes(chip.key)) setPreset("")
              setPage(1)
            }}
          >
            {chip.label} ×
          </button>
        ))}
        {filterChips.length > 0 && (
          <button
            aria-label="清除全部筛选"
            className={linkClass}
            onClick={() => {
              setFilters({ ...DEFAULT_RUN_ANALYSIS_FILTERS })
              setPreset("")
              setPage(1)
            }}
          >
            清除筛选
          </button>
        )}
      </div>
      {loading && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在完整聚合分析范围，大范围可能需要较长时间…
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded border border-destructive/30 p-3 text-sm text-destructive"
        >
          <AlertCircle className="size-4" />
          {error}
          <Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs">
            <div className="flex items-center gap-3">
              <div className="inline-flex rounded-md border p-0.5">
                {(
                  [
                    ["feature", "按特性"],
                    ["project", "按项目"]
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    aria-label={label}
                    aria-pressed={mode === id}
                    className={`rounded px-3 py-1.5 ${mode === id ? "bg-muted font-medium" : "text-muted-foreground"}`}
                    onClick={() => {
                      setMode(id)
                      setPage(1)
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span>
                {groups.length}个项目 · {matches.filter((m) => m.row.featureSlug !== null).length}
                个特性
              </span>
              {matches.some((m) => m.row.featureSlug === null) && (
                <Hint note="结果另含未关联特性的执行记录，不计入特性数量。" />
              )}
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">排序</span>
              <select
                aria-label="分析排序"
                className={selectClass}
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as RunAnalysisSort)
                  setPage(1)
                }}
              >
                {[
                  ["idle", "距最近执行"],
                  ["span", "执行跨度"],
                  ["duration", "累计耗时"],
                  ["adoption", "采纳率"],
                  ["vibe", "Vibe占比"],
                  ["noSkill", "未用Skill主对话"],
                  ["tools", "工具调用"],
                  ["models", "模型调用"]
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <Button
                aria-label="切换排序方向"
                size="sm"
                variant="ghost"
                onClick={() => setDesc((v) => !v)}
              >
                {sort === "idle"
                  ? desc
                    ? "久未执行优先"
                    : "最近执行优先"
                  : desc
                    ? "从高到低"
                    : "从低到高"}
              </Button>
            </div>
          </div>
          {mode === "project" && (
            <p className="text-[11px] text-muted-foreground">
              包含符合条件特性；指标为项目累计。展开项目查看匹配特性。
            </p>
          )}
          <div className="max-w-full overflow-x-auto rounded-md border">
            <table className="w-full min-w-[1180px] text-left text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  {[
                    ["项目 / 特性", ""],
                    ["当前阶段 / 状态", "当前阶段与状态来自最近上报快照，不代表实时运行状态。"],
                    ["执行跨度", RUN_ANALYSIS_NOTES.span],
                    [
                      "最近执行",
                      "从最近一次执行开始时间到数据截至时间的间隔，鼠标悬停可查看完整时间。"
                    ],
                    ["采纳率", RUN_ANALYSIS_NOTES.adoption],
                    ["Harness / Vibe采纳", RUN_ANALYSIS_NOTES.adoption],
                    ["未使用Skill主对话", RUN_ANALYSIS_NOTES.skill],
                    ["工具 / 模型调用", RUN_ANALYSIS_NOTES.cost],
                    ["子代理", RUN_ANALYSIS_NOTES.cost]
                  ].map(([label, note]) => (
                    <th key={label} className="px-3 py-2 font-medium">
                      {label}
                      {note && <Hint note={note} />}
                    </th>
                  ))}
                  <th className="sticky right-0 bg-muted px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((match) => (
                  <Fragment key={JSON.stringify([match.row.projectId, match.row.featureSlug])}>
                    {renderRow(match, mode === "project")}
                    {mode === "project" && expanded === match.row.projectId && (
                      <tr>
                        <td colSpan={10} className="border-t bg-muted/20 p-3">
                          <div className="mb-2 font-medium">匹配特性</div>
                          <div className="flex flex-wrap gap-2">
                            {(match as RunAnalysisProjectMatch).features.map((f) => (
                              <button
                                aria-label={`查看${f.row.featureTitle}详情`}
                                key={JSON.stringify([f.row.projectId, f.row.featureSlug])}
                                className="rounded border bg-background px-3 py-2 text-left hover:border-primary"
                                onClick={() => setDiagnose(f.row)}
                              >
                                <div className="text-primary">
                                  {f.row.featureTitle} · {f.row.currentStage ?? "阶段未记录"}
                                </div>
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                  {f.reasons.join("；") || "符合当前筛选"}
                                </div>
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!all.length && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {filterChips.length
                  ? "没有符合条件的结果，试试移除部分筛选条件。"
                  : "当前范围暂无数据，可切换查看范围。"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <div>
              数据截至 {date(data.dataAsOf)} · 缺失数据显示 —
              <Hint
                note={`查询开始于 ${date(data.queryStartedAt)}。当前阶段以最近上报为准。筛选、排序及导出覆盖全部结果，展示每页20条。`}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </Button>
              {currentPage} / {maxPage} 页 · {all.length}条
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage >= maxPage}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {data && diagnose && (
        <RunAnalysisDiagnosis
          key={JSON.stringify([key, diagnose.projectId, diagnose.featureSlug])}
          row={diagnose}
          options={options}
          onClose={() => setDiagnose(null)}
          onSessions={request}
          onCommits={onOpenFeatureCommits}
          onCodeTrace={onOpenCodeTrace}
        />
      )}
      {data && sessions && (
        <RunAnalysisSessionDialog
          key={JSON.stringify(sessions)}
          request={sessions}
          onClose={() => setSessions(null)}
        />
      )}
    </section>
  )
}

function RunAnalysisDiagnosis({
  row,
  options,
  onClose,
  onSessions,
  onCommits,
  onCodeTrace
}: {
  row: RunAnalysisFeature
  options: RunAnalysisOptions
  onClose: () => void
  onSessions: (
    row: RunAnalysisFeature,
    metric: RunAnalysisSessionRequest["metric"],
    node?: string | null
  ) => void
  onCommits?: ProjectRunAnalysisProps["onOpenFeatureCommits"]
  onCodeTrace?: ProjectRunAnalysisProps["onOpenCodeTrace"]
}) {
  const [data, setData] = useState<RunAnalysisStages | null>(null),
    [error, setError] = useState<string | null>(null)
  const requestKey = JSON.stringify({
    ...options,
    projectId: row.projectId,
    featureSlug: row.featureSlug
  })
  useEffect(() => {
    let cancelled = false
    void window.api.dashboard
      .projectModeRunAnalysisStages(JSON.parse(requestKey))
      .then((res) => {
        if (cancelled) return
        if (!res.success || !res.data) throw new Error(res.error ?? "阶段分析失败")
        setData(res.data)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [requestKey])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-[1300px] min-w-0 flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>特性诊断 · {row.featureTitle}</DialogTitle>
          <DialogDescription>
            {row.projectName} · 当前阶段 {row.currentStage ?? "未记录"} /{" "}
            {row.currentStatus ?? "未记录"} · 快照 {date(row.snapshotAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 rounded-md bg-muted/30 p-3 text-xs sm:grid-cols-3">
          <div className="space-y-1">
            <div className="font-medium">执行时间</div>
            <div>首次 {date(row.firstExecutedAt)}</div>
            <div>最近 {date(row.lastExecutedAt)}</div>
            <div>结束 {date(row.lastEndedAt)}</div>
            <div>累计耗时 {duration(row.totalDurationMs)}</div>
          </div>
          <div className="space-y-1">
            <div className="font-medium">
              代码采纳 <Hint note={RUN_ANALYSIS_NOTES.adoption} />
            </div>
            <div>已测量有效生成 {count(row.codeStats?.effectiveGeneratedLines)}行</div>
            <div>未测量 {count(row.codeStats?.unmeasuredGeneratedLines)}行</div>
            <div>
              Harness / Vibe采纳 {count(row.harnessAdoptedLines)} / {count(row.vibeAdoptedLines)}行
            </div>
            <AnalysisLink
              disabled={!row.featureSlug || !onCommits}
              onClick={() => onCommits?.(row, true)}
            >
              入库采纳 {count(row.codeStats?.pushedAdoptedLines)}行
            </AnalysisLink>
          </div>
          <div className="space-y-1">
            <div className="font-medium">
              调用与代理 <Hint note={RUN_ANALYSIS_NOTES.cost} />
            </div>
            <div>
              工具 / 模型字段覆盖 {row.toolReportedTraceCount}/{row.traceCount} ·{" "}
              {row.modelReportedTraceCount}/{row.traceCount}
            </div>
            <div>
              子代理 {count(row.subagentCount)}个 / {count(row.subagentTurns)}轮
            </div>
            <div>
              分类覆盖 {row.subagentClassifiedTraceCount}/{row.traceCount} · 可去重记录{" "}
              {row.subagentIdentifiedTraceCount}/{row.subagentTurns}
            </div>
            <div>
              {Object.entries(row.subagentKinds)
                .map(([k, n]) => `${k}: ${n}轮`)
                .join("；") || "类型未记录"}
            </div>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{RUN_ANALYSIS_NOTES.stages}</p>
        <div className="flex flex-wrap gap-3 text-xs">
          {onCodeTrace && (
            <AnalysisLink onClick={() => onCodeTrace(row)}>项目代码溯源</AnalysisLink>
          )}
          <AnalysisLink className={linkClass} onClick={() => onSessions(row, "main")}>
            主Agent对话 {count(row.conversationCount)}
          </AnalysisLink>
          <AnalysisLink className={linkClass} onClick={() => onSessions(row, "noSkill")}>
            未用Skill {noSkillLabel(row)}
          </AnalysisLink>
          <AnalysisLink
            className={linkClass}
            disabled={!row.featureSlug || !onCommits}
            onClick={() => onCommits?.(row)}
          >
            采纳率 / 特性代码溯源 {percent(row.codeStats?.inclusiveAdoptionRate)}
          </AnalysisLink>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : !data ? (
          <div className="flex gap-2 py-8 text-sm">
            <Loader2 className="size-4 animate-spin" />
            正在读取所选特性的阶段聚合…
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[950px] text-left text-xs">
              <thead className="bg-muted/40">
                <tr>
                  {[
                    "阶段",
                    "累计执行耗时",
                    "执行跨度（近似）",
                    "开始于该阶段的主对话",
                    "未用Skill主对话",
                    "已上报工具 / 模型调用",
                    "会话入口"
                  ].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((s) => (
                  <tr key={s.nodeName ?? "__missing__"} className="border-t">
                    <td className="px-3 py-3">{s.nodeName ?? "未归因阶段"}</td>
                    <td className="px-3 py-3">
                      {duration(s.attributedDurationMs ?? s.totalDurationMs)}
                    </td>
                    <td className="px-3 py-3">
                      {days(s.executionSpanMs === null ? null : s.executionSpanMs / 86400000)}
                    </td>
                    <td className="px-3 py-3">
                      <AnalysisLink
                        className={linkClass}
                        disabled={!s.conversationCount}
                        onClick={() => onSessions(row, "main", s.nodeName)}
                      >
                        {count(s.conversationCount)}
                      </AnalysisLink>
                    </td>
                    <td className="px-3 py-3">
                      <AnalysisLink
                        className={linkClass}
                        disabled={!s.conversationCount}
                        onClick={() => onSessions(row, "noSkill", s.nodeName)}
                      >
                        {noSkillLabel(s)}
                      </AnalysisLink>
                    </td>
                    <td className="px-3 py-3">
                      {count(s.attributedToolCalls ?? s.toolCalls)} /{" "}
                      {count(s.attributedModelCalls ?? s.modelCalls)}
                    </td>
                    <td className="px-3 py-3">
                      <AnalysisLink
                        className={linkClass}
                        onClick={() => onSessions(row, "all", s.nodeName)}
                      >
                        查看阶段记录
                      </AnalysisLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.rows.length && (
              <p className="p-6 text-muted-foreground">没有已上报的阶段执行记录</p>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">
              阶段数据截至 {date(data.dataAsOf)}
              。真实阶段停留时长、历史阶段变化及实时运行状态无法从现有快照可靠还原。
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
function RunAnalysisSessionDialog({
  request,
  onClose
}: {
  request: RunAnalysisSessionRequest
  onClose: () => void
}) {
  const [data, setData] = useState<RunAnalysisSessions | null>(null),
    [after, setAfter] = useState<unknown[] | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState<RunAnalysisSession | null>(null)
  const [history, setHistory] = useState<(unknown[] | null)[]>([])
  useEffect(() => {
    let cancelled = false
    void window.api.dashboard
      .projectModeRunAnalysisSessions({ ...request, after })
      .then((res) => {
        if (cancelled) return
        if (!res.success || !res.data) throw new Error(res.error ?? "会话加载失败")
        setData(res.data)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [request, after])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-[1100px] min-w-0 flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {request.metric === "noSkill"
              ? "未使用Skill的主Agent对话"
              : request.metric === "main"
                ? "主Agent对话"
                : "阶段执行记录"}
          </DialogTitle>
          <DialogDescription>
            {request.projectId} / {request.featureSlug ?? "未归因特性"}
            {request.nodeName !== undefined ? ` · ${request.nodeName ?? "未归因阶段"}` : ""} ·
            累计口径，点击进入完整会话
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{RUN_ANALYSIS_NOTES.skill}</p>
        {loading ? (
          <Loader2 className="size-5 animate-spin" />
        ) : error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          <>
            <div className="overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    {["开始时间", "阶段", "执行耗时", "记录", "操作"].map((h) => (
                      <th key={h} className="p-2">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((r) => (
                    <tr className="border-t" key={r.traceId}>
                      <td className="p-2">{date(r.startedAt)}</td>
                      <td className="p-2">{r.nodeName ?? "未归因"}</td>
                      <td className="p-2">{duration(r.durationMs)}</td>
                      <td className="max-w-64 break-all p-2">{r.traceId}</td>
                      <td className="p-2">
                        <AnalysisLink
                          className={linkClass}
                          disabled={!r.threadId}
                          onClick={() => setSelected(r)}
                        >
                          查看完整会话
                        </AnalysisLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data?.rows.length && (
                <p className="p-6 text-center text-muted-foreground">没有符合相同口径的记录</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 text-xs">
              共{count(data?.total)}轮
              <Button
                size="sm"
                variant="outline"
                disabled={!history.length}
                onClick={() => {
                  setLoading(true)
                  setError(null)
                  setAfter(history.at(-1) ?? null)
                  setHistory((h) => h.slice(0, -1))
                }}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!data?.after}
                onClick={() => {
                  setLoading(true)
                  setError(null)
                  setHistory((h) => [...h, after])
                  setAfter(data?.after ?? null)
                }}
              >
                下一页
              </Button>
            </div>
          </>
        )}
        {selected && (
          <RunAnalysisConversation
            request={request}
            session={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
function RunAnalysisConversation({
  request,
  session,
  onClose
}: {
  request: RunAnalysisSessionRequest
  session: RunAnalysisSession
  onClose: () => void
}) {
  const [traces, setTraces] = useState<DashboardTraceDetail[]>([]),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    void window.api.dashboard
      .projectModeRunAnalysisTrace({ ...request, traceId: session.traceId })
      .then((res) => {
        if (cancelled) return
        if (!res.success || !res.data) throw new Error(res.error ?? "完整会话加载失败")
        setTraces([res.data])
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [request, session])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex h-[82vh] w-[95vw] max-w-[1100px] min-w-0 flex-col gap-0 p-0">
        <DialogHeader className="border-b p-4">
          <DialogTitle>运行分析 · 完整会话</DialogTitle>
          <DialogDescription className="break-all">{session.traceId}</DialogDescription>
        </DialogHeader>
        <TraceExplorer
          traces={traces}
          loading={loading}
          error={error}
          viewMode="trace"
          showViewModeToggle={false}
          showCodeStats={false}
          title="执行步骤详情"
        />
      </DialogContent>
    </Dialog>
  )
}
