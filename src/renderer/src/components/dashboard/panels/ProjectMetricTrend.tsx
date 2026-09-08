import { useEffect, useMemo, useState } from "react"
import { ChevronDown, Loader2 } from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type {
  ProjectMetricSummaryGroup,
  ProjectMetricTrendData,
  ProjectMetricTrendDateField,
  ProjectMetricTrendFilters
} from "../../../../../shared/project-metrics"

type MetricKey = Exclude<
  keyof ProjectMetricSummaryGroup,
  "developmentMode" | "projectCount" | "samples"
>

const METRICS: Array<{
  key: MetricKey
  label: string
  unit: string
  sample: keyof ProjectMetricSummaryGroup["samples"]
  color: string
}> = [
  { key: "avgBugCount", label: "平均缺陷数", unit: "个", sample: "bug", color: "#3b82f6" },
  {
    key: "avgFuncPointCount",
    label: "平均功能点",
    unit: "功能点",
    sample: "functionPoint",
    color: "#8b5cf6"
  },
  {
    key: "defectDensityPer100Fp",
    label: "平均缺陷密度",
    unit: "个/百功能点",
    sample: "defectDensity",
    color: "#ef4444"
  },
  {
    key: "avgTestLeadDays",
    label: "平均发起 ST 耗时",
    unit: "天",
    sample: "testLead",
    color: "#10b981"
  },
  {
    key: "avgDeliveryDays",
    label: "平均特性上线耗时",
    unit: "天",
    sample: "delivery",
    color: "#f59e0b"
  },
  {
    key: "avgInputTokens",
    label: "平均输入 Token",
    unit: "Token",
    sample: "token",
    color: "#06b6d4"
  },
  {
    key: "avgOutputTokens",
    label: "平均输出 Token",
    unit: "Token",
    sample: "token",
    color: "#ec4899"
  },
  {
    key: "avgPushedAdoptedLines",
    label: "平均代码行数",
    unit: "行",
    sample: "codeLines",
    color: "#84cc16"
  },
  {
    key: "inputTokensPerAdoptedLine",
    label: "平均单行代码消耗输入 Token",
    unit: "Token/行",
    sample: "tokensPerLine",
    color: "#f97316"
  },
  {
    key: "outputTokensPerAdoptedLine",
    label: "平均单行代码消耗输出 Token",
    unit: "Token/行",
    sample: "tokensPerLine",
    color: "#6366f1"
  }
]

const MODES = [
  { key: "devclaw", label: "CMBDevClaw" },
  { key: "non_devclaw", label: "非 CMBDevClaw" }
] as const

function metricValue(
  group: ProjectMetricSummaryGroup | undefined,
  metric: (typeof METRICS)[number]
): number | null {
  const value = group?.[metric.key]
  return group &&
    group.samples[metric.sample] > 0 &&
    typeof value === "number" &&
    Number.isFinite(value)
    ? value
    : null
}

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (Math.abs(value) >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return Number(value.toFixed(2)).toLocaleString("zh-CN")
}

export function ProjectMetricTrend({
  filters,
  refreshKey
}: {
  filters: ProjectMetricTrendFilters
  refreshKey: number
}): React.JSX.Element {
  const [selected, setSelected] = useState<MetricKey[]>(["avgBugCount"])
  const [scaleMode, setScaleMode] = useState<"raw" | "normalized">("raw")
  const [dateField, setDateField] = useState<ProjectMetricTrendDateField>("createDate")
  const [data, setData] = useState<ProjectMetricTrendData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setData(null)
    async function load(): Promise<void> {
      try {
        const result = await window.api.dashboard.projectMetricTrend({ ...filters, dateField })
        if (!active) return
        if (!result.success || !result.data) throw new Error(result.error || "获取项目指标趋势失败")
        setData(result.data)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [filters, refreshKey, dateField])

  const metrics = METRICS.filter((metric) => selected.includes(metric.key))
  const firstSelectedLabel = METRICS.find((metric) => metric.key === selected[0])?.label
  const changeSelection = (next: MetricKey[]): void => {
    const multiple = next.length > 1
    const wasMultiple = selected.length > 1
    if (multiple !== wasMultiple) {
      setScaleMode(multiple ? "normalized" : "raw")
    }
    if (next.length === 0) setScaleMode("raw")
    setSelected(next)
  }
  const rawChartData = useMemo(
    () =>
      (data?.months ?? []).map(({ month, groups }) => {
        const point: Record<string, string | number | null> = { month }
        for (const metric of METRICS) {
          for (const mode of MODES) {
            point[`${metric.key}_${mode.key}`] = metricValue(
              groups.find((group) => group.developmentMode === mode.key),
              metric
            )
          }
        }
        return point
      }),
    [data]
  )
  const chartData = useMemo(() => {
    if (scaleMode === "raw") return rawChartData
    const normalized = rawChartData.map((point) => ({ ...point }))
    for (const metric of METRICS) {
      // 两组共用同一指标的六个月范围，保留组间相对高低。
      const values = rawChartData.flatMap((point) =>
        MODES.flatMap((mode) => {
          const value = point[`${metric.key}_${mode.key}`]
          return typeof value === "number" ? [value] : []
        })
      )
      if (values.length === 0) continue
      const minimum = Math.min(...values)
      const maximum = Math.max(...values)
      for (const point of normalized) {
        for (const mode of MODES) {
          const key = `${metric.key}_${mode.key}`
          const value = point[key]
          if (typeof value !== "number") continue
          point[key] = maximum === minimum ? 50 : ((value - minimum) / (maximum - minimum)) * 100
        }
      }
    }
    return normalized
  }, [rawChartData, scaleMode])
  const hasValues = chartData.some((point) =>
    metrics.some((metric) => MODES.some((mode) => point[`${metric.key}_${mode.key}`] !== null))
  )
  const asymmetric =
    Boolean(filters.adapterName) ||
    filters.tokenConsumptionMin != null ||
    filters.tokenConsumptionMax != null

  return (
    <div className="mt-5 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xs font-semibold text-foreground">指标月度趋势</h3>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 max-w-80 gap-2 text-xs"
                title={firstSelectedLabel ?? "选择指标"}
                aria-label={`选择指标：${firstSelectedLabel ?? "未选择"}${selected.length > 1 ? `，另选 ${selected.length - 1} 项` : ""}`}
              >
                <span className="truncate">{firstSelectedLabel ?? "选择指标"}</span>
                {selected.length > 1 ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                    +{selected.length - 1}
                  </span>
                ) : null}
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <div className="mb-1 flex items-center justify-between border-b border-border px-2 pb-2">
                <span className="text-xs text-muted-foreground">已选 {selected.length} 项</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={selected.length === 0}
                  onClick={() => changeSelection([])}
                >
                  清空全部
                </Button>
              </div>
              {METRICS.map((metric) => (
                <label
                  key={metric.key}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(metric.key)}
                    onChange={() =>
                      changeSelection(
                        selected.includes(metric.key)
                          ? selected.filter((key) => key !== metric.key)
                          : [...selected, metric.key]
                      )
                    }
                  />
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: metric.color }}
                  />
                  {metric.label}
                </label>
              ))}
            </PopoverContent>
          </Popover>
          <div
            className="flex gap-1 rounded-md border border-border p-0.5"
            role="group"
            aria-label="纵轴显示方式"
          >
            {(
              [
                { value: "raw", label: "原始值" },
                { value: "normalized", label: "趋势对比" }
              ] as const
            ).map((mode) => (
              <Button
                key={mode.value}
                variant={scaleMode === mode.value ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                aria-pressed={scaleMode === mode.value}
                disabled={selected.length === 0}
                onClick={() => setScaleMode(mode.value)}
              >
                {mode.label}
              </Button>
            ))}
          </div>
          <div
            className="flex gap-1 rounded-md border border-border p-0.5"
            role="group"
            aria-label="按项目日期展示"
          >
            {(
              [
                { value: "createDate", label: "立项时间" },
                { value: "endDate", label: "结项时间" }
              ] as const
            ).map((option) => (
              <Button
                key={option.value}
                variant={dateField === option.value ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                aria-pressed={dateField === option.value}
                onClick={() => setDateField(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          {MODES.map((mode) => (
            <span key={mode.key} className="inline-flex items-center gap-1.5">
              <span
                className={`w-6 border-t-2 ${mode.key === "non_devclaw" ? "border-dashed" : "border-solid"}`}
              />
              {mode.label}
            </span>
          ))}
        </div>
      </div>
      {/*<p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">*/}
      {/*  最近 6 个完整自然月，按 GMT+8 立项月份分组，不含当月；不受顶部日期选择影响。*/}
      {/*  数值沿用下方对比指标口径，反映各月立项项目截至当前的指标，并非历史月末快照。*/}
      {/*</p>*/}
      {/*{asymmetric ? (*/}
      {/*  <p className="mt-2 text-xs text-status-warning-foreground">*/}
      {/*    插件、Token 消耗筛选仅作用于 CMBDevClaw 侧，两侧样本范围不对称。*/}
      {/*  </p>*/}
      {/*) : null}*/}
      {data?.truncated ? (
        <p className="mt-2 text-xs text-status-warning-foreground">
          项目关联样本超过 10,000 条，趋势可能存在统计不完整或开发方式误分类。
        </p>
      ) : null}
      {loading ? (
        <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          正在统计月度趋势
        </div>
      ) : error ? (
        <div
          className="flex h-72 items-center justify-center text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : metrics.length === 0 ? (
        <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
          请在左上角选择要展示的指标
        </div>
      ) : (
        <>
          {!hasValues ? (
            <p className="mt-3 text-xs text-muted-foreground">所选指标暂无有效数据</p>
          ) : null}
          <div className="mt-4">
            <div className="mb-2 text-[10px] text-muted-foreground">
              {scaleMode === "normalized" ? "归一化刻度（0–100）" : "原始数值"}
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                  vertical={false}
                />
                <XAxis
                  dataKey="month"
                  interval={0}
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--color-border)" }}
                />
                <YAxis
                  width={64}
                  domain={scaleMode === "normalized" ? [0, 100] : [0, "auto"]}
                  ticks={scaleMode === "normalized" ? [0, 25, 50, 75, 100] : undefined}
                  tickFormatter={formatAxis}
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  filterNull={false}
                  content={({ active, label }) => {
                    const month = data?.months.find((item) => item.month === label)
                    if (!active || !month) return null
                    return (
                      <div className="rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md">
                        <div className="mb-2 font-semibold">
                          {month.month} {dateField === "endDate" ? "结项" : "立项"}项目
                        </div>
                        <table className="text-[11px]">
                          <thead>
                            <tr>
                              <th className="pb-2 text-left font-medium">指标</th>
                              {MODES.map((mode) => (
                                <th key={mode.key} className="pb-2 pl-4 text-right font-medium">
                                  {mode.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {metrics.map((metric) => (
                              <tr key={metric.key}>
                                <td className="py-1" style={{ color: metric.color }}>
                                  {metric.label}
                                </td>
                                {MODES.map((mode) => {
                                  const group = month.groups.find(
                                    (item) => item.developmentMode === mode.key
                                  )
                                  const value = metricValue(group, metric)
                                  return (
                                    <td
                                      key={mode.key}
                                      className="py-1 pl-4 text-right tabular-nums"
                                    >
                                      <div>
                                        {value === null
                                          ? "暂无数据"
                                          : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${metric.unit}`}
                                      </div>
                                      <div className="text-[10px] text-muted-foreground">
                                        有效样本 {group?.samples[metric.sample] ?? 0}
                                      </div>
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  }}
                />
                {metrics.flatMap((metric) =>
                  MODES.map((mode) => (
                    <Line
                      key={`${metric.key}_${mode.key}`}
                      dataKey={`${metric.key}_${mode.key}`}
                      name={`${metric.label} · ${mode.label}`}
                      type="linear"
                      stroke={metric.color}
                      strokeWidth={2}
                      strokeDasharray={mode.key === "non_devclaw" ? "6 4" : undefined}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            {metrics.map((metric) => (
              <span key={metric.key} className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ backgroundColor: metric.color }} />
                {metric.label}（{metric.unit}）
              </span>
            ))}
          </div>
          {/*<p className="mt-3 text-[10px] text-muted-foreground">*/}
          {/*  {scaleMode === "normalized"*/}
          {/*    ? "每个指标按两组项目近 6 个月的共同最小值、最大值映射至 0–100，不代表增长百分比；全部有效值相同时显示在 50。悬浮查看原始数值。"*/}
          {/*    : "纵轴为实际数值，不同量级指标共用刻度；可切换趋势对比查看变化。"}*/}
          {/*  缺失数据留空。非 CMBDevClaw 项目暂无 Token 和代码行数数据。*/}
          {/*</p>*/}
        </>
      )}
    </div>
  )
}
