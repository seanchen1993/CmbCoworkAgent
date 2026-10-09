import type { EfficiencyPluginFilter } from "../../../../../shared/dashboard-efficiency-compute"
/**
 * 研发效能面板
 *
 * 展示 AI 编码有效性与算力产出效能。
 * 范围固定为「项目模式 + 已绑定精益项目」。算力指标默认 Dev，
 * 可切换原有全流程口径，并单独筛选项目绑定的插件及其版本。
 */
import React, { useMemo, useState } from "react"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  DashboardEfficiencyChangeKind,
  DashboardEfficiencyChangeKindStats,
  DashboardEfficiencyData
} from "../use-dashboard"
import { ProjectMetricsSection } from "./ProjectMetricsSection"

// ─────────────────────────────────────────────────────────
// 目标线
// ─────────────────────────────────────────────────────────

/** 新增（绿地）代码入库采纳率目标。 */
const NEW_ADOPTION_TARGET = 0.9
/** 存量（棕地）迭代代码入库采纳率目标。 */
const LEGACY_ADOPTION_TARGET = 0.85

const CHANGE_KIND_LABELS: Record<DashboardEfficiencyChangeKind, string> = {
  new: "新增功能代码",
  legacy: "存量迭代代码",
  unclassified: "未分类（历史数据）"
}

const CHANGE_KIND_TARGETS: Partial<Record<DashboardEfficiencyChangeKind, number>> = {
  new: NEW_ADOPTION_TARGET,
  legacy: LEGACY_ADOPTION_TARGET
}

// ─────────────────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────────────────

function formatPercent(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(digits)}%`
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatCount(value)
}

function formatTokensPerLine(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return value >= 100 ? formatCount(value) : value.toFixed(1)
}

// ─────────────────────────────────────────────────────────
// 基础件
// ─────────────────────────────────────────────────────────

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="text-muted-foreground hover:text-foreground">
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-[100] max-h-[calc(100vh-24px)] w-80 max-w-[calc(100vw-24px)] overflow-y-auto whitespace-normal text-xs leading-relaxed"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function MetricCard({
  title,
  hint,
  children
}: {
  title: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint ? <Hint>{hint}</Hint> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────
// 指标 2：AI 编码有效性
// ─────────────────────────────────────────────────────────

function AdoptionBucket({
  stats
}: {
  stats: DashboardEfficiencyChangeKindStats
}): React.JSX.Element {
  const target = CHANGE_KIND_TARGETS[stats.changeKind]
  const rate = stats.inclusivePushedAdoptionRate
  const hasData = stats.inclusiveEffectiveGeneratedLines > 0
  const met = target !== undefined && rate !== null ? rate >= target : null

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{CHANGE_KIND_LABELS[stats.changeKind]}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          met === null
            ? "text-foreground"
            : met
              ? "text-status-nominal-foreground"
              : "text-status-warning-foreground"
        )}
      >
        {hasData ? formatPercent(rate) : "—"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {target !== undefined ? `目标 > ${formatPercent(target, 0)}` : "无目标线"}
      </div>
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <div>入库采纳 {formatCount(stats.pushedAdoptedLines)} 行</div>
        <div>有效生成 {formatCount(stats.inclusiveEffectiveGeneratedLines)} 行</div>
      </div>
    </div>
  )
}

/**
 * 新增行占比分布。用来看 0.7 这条阈值是切在分布的稀疏处还是密集处——
 * 切在密集处意味着两桶的划分对阈值极其敏感，微调就会大幅搬运数据。
 */
function NewRatioHistogram({
  bins
}: {
  bins: DashboardEfficiencyData["adoption"]["newRatioHistogram"]
}): React.JSX.Element | null {
  const max = useMemo(() => bins.reduce((acc, bin) => Math.max(acc, bin.docCount), 0), [bins])
  if (bins.length === 0 || max === 0) return null

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <span>新增行占比分布</span>
        <Hint>
          <div className="space-y-1">
            <div>
              计算公式：新增行占比 = max（生成行数 − 删除或被替换的旧行数，0）÷ 生成行数。
              等量改写为 0，纯新增为 1。
            </div>
            <div>
              0.7 是当前的分桶阈值。如果阈值正好落在分布密集处，说明两桶划分对阈值很敏感，
              微调阈值会大幅改变结果——此时应该按分布的稀疏处重新定阈值。
            </div>
          </div>
        </Hint>
      </div>
      <div className="mt-2 flex h-16 items-end gap-px">
        {bins.map((bin) => (
          <div
            key={bin.from}
            className="group relative flex h-full flex-1 items-end"
            title={`[${bin.from.toFixed(2)}, ${(bin.from + 0.05).toFixed(2)}) · ${formatCount(bin.docCount)} 次`}
          >
            <div
              className={cn(
                "w-full rounded-sm",
                bin.from >= 0.7 ? "bg-emerald-500/60" : "bg-amber-500/60"
              )}
              style={{
                height: `${bin.docCount === 0 ? 0 : Math.max(3, (bin.docCount / max) * 64)}px`
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>0（全是改写）</span>
        <span>0.7 阈值</span>
        <span>1（纯新增）</span>
      </div>
    </div>
  )
}

function AdoptionCard({
  adoption
}: {
  adoption: DashboardEfficiencyData["adoption"]
}): React.JSX.Element {
  return (
    <MetricCard
      title="AI 编码有效性"
      hint={
        <div className="space-y-1.5">
          <div>入库采纳率 = 已 Push 采纳行 ÷ 全部有效生成行（含未提交）。</div>
          <div>
            新增 / 存量根据每次生成中的新旧代码行差异划分，阈值为 0.7：删除或替换的旧代码越多，
            越偏向存量迭代。分类结果在代码生成时确定，后续不再重新计算。
          </div>
          <div>
            统计中包含超过 14 天归因窗口、尚未获得采纳结果的生成代码；这部分只计入有效生成行，
            因此采纳率是偏保守的参考值。
          </div>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {adoption.byChangeKind.map((stats) => (
          <AdoptionBucket key={stats.changeKind} stats={stats} />
        ))}
      </div>

      <NewRatioHistogram bins={adoption.newRatioHistogram} />
    </MetricCard>
  )
}

// ─────────────────────────────────────────────────────────
// 指标 3：算力产出效能
// ─────────────────────────────────────────────────────────

/**
 * 单行成本里输入 / 输出各占多少。用的是同一个分母（入库采纳行），
 * 所以两条的每行数相加恰好等于卡片主数值。
 */
function PerLineSplit({
  label,
  perLine,
  share,
  barClassName
}: {
  label: string
  perLine: number | null
  share: number | null
  barClassName: string
}): React.JSX.Element {
  return (
    <div className="min-w-[104px]">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
        {formatTokensPerLine(perLine)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">/行</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", barClassName)}
          style={{ width: `${Math.min(100, Math.max(0, (share ?? 0) * 100))}%` }}
        />
      </div>
      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
        {formatPercent(share, 1)}
      </div>
    </div>
  )
}

function ComputeCard({
  compute,
  scope = "dev"
}: {
  compute: DashboardEfficiencyData["compute"]
  scope?: "dev" | "all"
}): React.JSX.Element {
  const { totalTokens, totalInputTokens, totalOutputTokens, pushedAdoptedLines } = compute
  const partialTokens =
    scope === "dev" &&
    (compute.tokenUsageIncomplete ?? compute.tokenUsageReportedCalls < compute.modelCalls)
  const cacheAvailable = scope === "all" || compute.cacheUsageReportedCalls > 0
  const cachePartial = scope === "dev" && compute.cacheUsageReportedCalls < compute.modelCalls
  const ratio = (value: number | null): string =>
    compute.tokenTotalsConsistent ? `${partialTokens ? "≥" : ""}${formatTokensPerLine(value)}` : "—"
  return (
    <MetricCard
      title={`算力产出效能 · ${scope === "all" ? "全流程" : "Dev 研发阶段"}`}
      hint={
        <div className="space-y-1.5">
          <div>
            {scope === "all"
              ? "汇总全部阶段的调用与代码，包含主、子 Agent。"
              : "仅汇总研发阶段的调用与代码，包含主、子 Agent。"}
          </div>
          <div>单行入库代码Token数 = Token 总量 ÷ 已 Push 采纳行数，后续入库会更新结果。</div>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-x-10 gap-y-4 rounded-md border border-border bg-background p-3">
        <div>
          <div className="text-xs text-muted-foreground">单行入库代码Token数</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
            {ratio(compute.tokensPerAdoptedLine)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {formatCompact(totalTokens)} tokens ÷ {formatCount(pushedAdoptedLines)} 行
          </div>
        </div>
        <div className="flex gap-8">
          <PerLineSplit
            label="其中输入"
            perLine={
              compute.tokenTotalsConsistent && pushedAdoptedLines > 0
                ? totalInputTokens / pushedAdoptedLines
                : null
            }
            share={totalTokens > 0 ? totalInputTokens / totalTokens : null}
            barClassName="bg-sky-500"
          />
          <PerLineSplit
            label="其中输出"
            perLine={
              compute.tokenTotalsConsistent && pushedAdoptedLines > 0
                ? totalOutputTokens / pushedAdoptedLines
                : null
            }
            share={totalTokens > 0 ? totalOutputTokens / totalTokens : null}
            barClassName="bg-violet-500"
          />
        </div>
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="text-xs text-muted-foreground">输入 Token</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {partialTokens ? "≥" : ""}
            {formatCompact(totalInputTokens)}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="text-xs text-muted-foreground">输出 Token</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {partialTokens ? "≥" : ""}
            {formatCompact(totalOutputTokens)}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            其中缓存读取
            <Hint>
              {scope === "all"
                ? "汇总执行记录上报的缓存读取用量。"
                : "只统计已上报的研发阶段缓存；“≥”表示部分调用缺少缓存用量。"}
            </Hint>
          </dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {cacheAvailable ? (
              <>
                {cachePartial ? "≥" : ""}
                {formatCompact(compute.cacheReadTokens)}
                {!cachePartial && totalInputTokens > 0 ? (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {formatPercent(compute.cacheReadTokens / totalInputTokens, 1)}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-base font-normal text-muted-foreground">未采集</span>
            )}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            产码记录占比
            <Hint>
              {scope === "all"
                ? "产生过代码的执行记录数 ÷ 全部执行记录数。"
                : "研发阶段产生过代码的执行记录 ÷ 有研发阶段活动的全部执行记录。"}
              子 Agent 独立计数；产生代码不代表已经入库。
            </Hint>
          </dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {formatPercent(compute.codeProducingTraceRatio, 1)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {formatCount(compute.codeProducingTraceCount)}/{formatCount(compute.traceCount)}
            </span>
          </dd>
        </div>
      </dl>
      {partialTokens ? (
        <p className="mt-3 text-xs text-muted-foreground">
          部分模型调用未返回完整用量，“≥”表示已采集的下限。
        </p>
      ) : null}
      {!compute.tokenTotalsConsistent ? (
        <div className="mt-3 flex items-start gap-2 text-xs text-status-warning-foreground">
          <AlertCircle className="size-3.5 shrink-0" />
          Token 总量与输入、输出或缓存用量不一致，暂不展示每行消耗。
        </div>
      ) : null}
    </MetricCard>
  )
}

const PLUGIN_PAGE_SIZE = 10
const PLUGIN_COLUMNS = [
  { key: "adapterName", label: "插件" },
  { key: "versions", label: "版本" },
  { key: "totalTokens", label: "Token" },
  { key: "generatedLines", label: "生成行" },
  { key: "pushedAdoptedLines", label: "入库行" },
  { key: "tokensPerAdoptedLine", label: "单行入库代码Token数" }
] as const

type PluginSortKey = (typeof PLUGIN_COLUMNS)[number]["key"]

function pluginSortValue(
  row: DashboardEfficiencyData["computeByPlugin"][number],
  key: PluginSortKey
): string | number | null {
  if (key === "adapterName") return row.adapterName ?? "未归因插件"
  if (key === "versions") return row.versions.join("、") || null
  if (
    key === "tokensPerAdoptedLine" &&
    (!row.compute.tokenTotalsConsistent || row.compute.traceCount === 0)
  )
    return null
  return row.compute[key]
}

function PluginComputeTable({
  rows,
  scope = "dev"
}: {
  rows: DashboardEfficiencyData["computeByPlugin"]
  scope?: "dev" | "all"
}): React.JSX.Element {
  const [sort, setSort] = useState<{ key: PluginSortKey; direction: "asc" | "desc" }>({
    key: "totalTokens",
    direction: "desc"
  })
  const [page, setPage] = useState(1)
  // Sort the complete list before taking a page, so ranking is global.
  const visible = useMemo(
    () =>
      rows
        .filter(
          ({ compute }) =>
            compute.traceCount > 0 || compute.generatedLines > 0 || compute.pushedAdoptedLines > 0
        )
        .sort((a, b) => {
          const left = pluginSortValue(a, sort.key)
          const right = pluginSortValue(b, sort.key)
          // Values displayed as unavailable stay at the end in either direction.
          if (left === null && right !== null) return 1
          if (right === null && left !== null) return -1
          const comparison =
            typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left ?? "").localeCompare(String(right ?? ""), "zh-CN", { numeric: true })
          return (
            (sort.direction === "desc" ? -1 : 1) * comparison ||
            (a.adapterName ?? "").localeCompare(b.adapterName ?? "")
          )
        }),
    [rows, sort]
  )
  const totalPages = Math.max(1, Math.ceil(visible.length / PLUGIN_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageRows = visible.slice(
    (currentPage - 1) * PLUGIN_PAGE_SIZE,
    currentPage * PLUGIN_PAGE_SIZE
  )
  const perLine = (metrics: DashboardEfficiencyData["compute"]): string => {
    if (
      !metrics.tokenTotalsConsistent ||
      metrics.tokensPerAdoptedLine === null ||
      metrics.traceCount === 0
    )
      return "—"
    const partial =
      scope === "dev" &&
      (metrics.tokenUsageIncomplete ?? metrics.tokenUsageReportedCalls < metrics.modelCalls)
    return `${partial ? "≥" : ""}${formatTokensPerLine(metrics.tokensPerAdoptedLine)}`
  }
  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              {PLUGIN_COLUMNS.map((column) => {
                const active = sort.key === column.key
                return (
                  <th
                    key={column.key}
                    className="whitespace-nowrap px-3 py-2 text-left font-medium"
                    aria-sort={
                      active ? (sort.direction === "desc" ? "descending" : "ascending") : "none"
                    }
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      aria-label={`按${column.label}排序${active ? `，当前${sort.direction === "desc" ? "降序" : "升序"}` : ""}`}
                      onClick={() => {
                        setSort((current) => ({
                          key: column.key,
                          direction:
                            current.key === column.key
                              ? current.direction === "desc"
                                ? "asc"
                                : "desc"
                              : column.key === "adapterName" || column.key === "versions"
                                ? "asc"
                                : "desc"
                        }))
                        setPage(1)
                      }}
                    >
                      {column.label}
                      {!active ? (
                        <ArrowUpDown className="size-3 opacity-50" />
                      ) : sort.direction === "desc" ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ArrowUp className="size-3" />
                      )}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const metrics = row.compute
              return (
                <tr key={row.adapterName ?? ""} className="border-t border-border tabular-nums">
                  <td className="px-3 py-2">{row.adapterName ?? "未归因插件"}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.versions.join("、") || "未记录"}
                  </td>
                  <td className="px-3 py-2">
                    {scope === "dev" &&
                    (metrics.tokenUsageIncomplete ??
                      metrics.tokenUsageReportedCalls < metrics.modelCalls)
                      ? "≥"
                      : ""}
                    {formatCompact(metrics.totalTokens)}
                  </td>
                  <td className="px-3 py-2">{formatCount(metrics.generatedLines)}</td>
                  <td className="px-3 py-2">{formatCount(metrics.pushedAdoptedLines)}</td>
                  <td className="px-3 py-2">{perLine(metrics)}</td>
                </tr>
              )
            })}
            {!visible.length ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  本期暂无对应{scope === "dev" ? "研发阶段" : "全流程"}记录
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {visible.length > PLUGIN_PAGE_SIZE ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            共 {formatCount(visible.length)} 个插件 · 每页 {PLUGIN_PAGE_SIZE} 个 · 第 {currentPage}/
            {totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft className="mr-1 size-3.5" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={currentPage >= totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
              <ChevronRight className="ml-1 size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ComputeSection({
  data,
  loading,
  pluginFilter,
  onPluginFilterChange
}: {
  data: DashboardEfficiencyData
  loading: boolean
  pluginFilter: EfficiencyPluginFilter
  onPluginFilterChange: (filter: EfficiencyPluginFilter) => void
}): React.JSX.Element {
  const name = pluginFilter.adapterName ?? ""
  const scope = pluginFilter.scope ?? "dev"
  const version = pluginFilter.adapterVersion ?? ""
  const options = data.pluginOptions
  const versions = options.find((option) => option.adapterName === name)?.versions ?? []
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label htmlFor="efficiency-scope">统计口径</label>
        <select
          id="efficiency-scope"
          value={scope}
          disabled={loading}
          onChange={(event) =>
            onPluginFilterChange({
              ...pluginFilter,
              scope: event.target.value === "all" ? "all" : "dev"
            })
          }
          className="h-8 rounded-md border border-border bg-background px-2"
        >
          <option value="dev">Dev 研发阶段</option>
          <option value="all">全流程</option>
        </select>
        <label htmlFor="efficiency-plugin">算力统计插件</label>
        <select
          id="efficiency-plugin"
          value={name}
          disabled={loading}
          onChange={(event) =>
            onPluginFilterChange({
              ...pluginFilter,
              adapterName: event.target.value || null,
              adapterVersion: null
            })
          }
          className="h-8 max-w-64 rounded-md border border-border bg-background px-2"
        >
          <option value="">全部插件</option>
          {name && !options.some((option) => option.adapterName === name) ? (
            <option value={name}>{name}（本期无记录）</option>
          ) : null}
          {options.map((option) => (
            <option key={option.adapterName} value={option.adapterName}>
              {option.adapterName}
            </option>
          ))}
        </select>
        {name ? (
          <>
            <label htmlFor="efficiency-version">版本</label>
            <select
              id="efficiency-version"
              value={version}
              disabled={loading}
              onChange={(event) =>
                onPluginFilterChange({
                  ...pluginFilter,
                  adapterName: name,
                  adapterVersion: event.target.value || null
                })
              }
              className="h-8 max-w-48 rounded-md border border-border bg-background px-2"
            >
              <option value="">全部版本</option>
              {version && !versions.includes(version) ? (
                <option value={version}>{version}（本期无记录）</option>
              ) : null}
              {versions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在加载数据
        </div>
      ) : (
        <>
          <ComputeCard compute={data.compute} scope={data.computeScope} />
          <div className="text-sm font-medium">插件对比</div>
          <PluginComputeTable rows={data.computeByPlugin} scope={data.computeScope} />
        </>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────
// 面板
// ─────────────────────────────────────────────────────────

export function EfficiencyPanel({
  data,
  loading,
  error,
  pluginFilter,
  onPluginFilterChange,
  range,
  upperOrgLv1,
  groupNames,
  projectMetricRefreshKey
}: {
  data: DashboardEfficiencyData | null
  loading: boolean
  error: string | null
  pluginFilter: EfficiencyPluginFilter
  onPluginFilterChange: (filter: EfficiencyPluginFilter) => void
  range: { from: string; to: string }
  upperOrgLv1: string[]
  groupNames: string[]
  projectMetricRefreshKey: number
}): React.JSX.Element {
  return (
    <div className="space-y-4 px-6 py-4">
      <ProjectMetricsSection
        range={range}
        upperOrgLv1={upperOrgLv1}
        groupNames={groupNames}
        refreshKey={projectMetricRefreshKey}
      />

      {loading && !data ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载现有研发效能指标
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : !data ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
          暂无现有研发效能数据
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>统计范围：项目模式 · 已绑定精益项目</span>
            <span>·</span>
            <span>{formatCount(data.meta.projectCount)} 个项目</span>
            {data.meta.truncated ? (
              <>
                <span>·</span>
                <span className="text-status-warning-foreground">
                  项目数超过上限，以下为截断后的子集
                </span>
              </>
            ) : null}
          </div>

          <AdoptionCard adoption={data.adoption} />
          <ComputeSection
            data={data}
            loading={loading}
            pluginFilter={pluginFilter}
            onPluginFilterChange={onPluginFilterChange}
          />
        </>
      )}
    </div>
  )
}
