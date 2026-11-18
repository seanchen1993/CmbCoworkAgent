import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Download, Info, Loader2, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  projectCompleteMonths,
  projectMonthlyPeriodLabel
} from "../../../../../shared/project-metric-calendar"
import { PersonalEfficiencyWeightsDialog } from "./PersonalEfficiencyWeightsDialog"
import {
  PERSONAL_EFFICIENCY_METRICS,
  defaultPersonalEfficiencyWeights,
  type PersonalEfficiencyData,
  type PersonalEfficiencyFilters,
  type PersonalEfficiencyMetric,
  type PersonalEfficiencyPerson
} from "../../../../../shared/personal-efficiency"
import { rankPersonalEfficiency } from "../../../../../shared/personal-efficiency-ranking"
import { PersonalEfficiencyDetail } from "./PersonalEfficiencyDetail"
import { formatPersonalMetric } from "./personal-efficiency-format"

export function PersonalEfficiencySection({
  range,
  upperOrgLv1,
  dateBasis,
  refreshKey
}: PersonalEfficiencyFilters & { refreshKey: number }): React.JSX.Element {
  const filters = useMemo(
    () => ({ range, upperOrgLv1, dateBasis }),
    [range, upperOrgLv1, dateBasis]
  )
  const months = projectCompleteMonths(range)
  const monthLabel = months.length ? projectMonthlyPeriodLabel(months) : null
  const [result, setResult] = useState<{
    filters: PersonalEfficiencyFilters
    refreshKey: number
    retry: number
    data: PersonalEfficiencyData | null
    error: string | null
  } | null>(null)
  const [retry, setRetry] = useState(0)
  const [weights, setWeights] = useState(defaultPersonalEfficiencyWeights)
  const [weightOpen, setWeightOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState("")
  const [sort, setSort] = useState<PersonalEfficiencyMetric | "score">("score")
  const [ascending, setAscending] = useState(false)
  const [page, setPage] = useState(1)
  const [selection, setSelection] = useState<{
    filters: PersonalEfficiencyFilters
    refreshKey: number
    person: PersonalEfficiencyPerson
  } | null>(null)
  const current =
    result?.filters === filters && result?.refreshKey === refreshKey && result?.retry === retry
      ? result
      : null
  const data = current?.data ?? null
  const error = current?.error
  const loading = !current
  const selected =
    selection?.filters === filters && selection?.refreshKey === refreshKey ? selection.person : null
  function setSelected(person: PersonalEfficiencyPerson | null): void {
    setSelection(person ? { filters, refreshKey, person } : null)
  }
  useEffect(() => {
    let active = true
    void window.api.dashboard
      .personalEfficiency(filters)
      .then((response) => {
        if (!active) return
        if (!response.success || !response.data)
          throw new Error(response.error || "获取个人使用情况失败")
        setResult({ filters, refreshKey, retry, data: response.data, error: null })
      })
      .catch((cause: unknown) => {
        if (active)
          setResult({
            filters,
            refreshKey,
            retry,
            data: null,
            error: cause instanceof Error ? cause.message : String(cause)
          })
      })
    return () => {
      active = false
    }
  }, [filters, refreshKey, retry])

  const effectiveSort =
    !monthLabel &&
    PERSONAL_EFFICIENCY_METRICS.some((metric) => metric.key === sort && metric.monthly)
      ? "score"
      : sort
  const rows = useMemo(
    () =>
      rankPersonalEfficiency(
        data?.people ?? [],
        weights,
        effectiveSort,
        ascending ? "asc" : "desc",
        Boolean(monthLabel)
      ).filter(({ person }) =>
        `${person.userName} ${person.sapId}`.toLowerCase().includes(keyword.trim().toLowerCase())
      ),
    [data, weights, effectiveSort, ascending, keyword, monthLabel]
  )
  const pages = Math.max(1, Math.ceil(rows.length / 20))
  const currentPage = Math.min(page, pages)
  const metrics = PERSONAL_EFFICIENCY_METRICS.filter((metric) => !metric.monthly || monthLabel)
  const hasWeights = metrics.some(({ key }) => weights[key] !== 0)
  function changeSort(key: PersonalEfficiencyMetric | "score"): void {
    setAscending(effectiveSort === key ? !ascending : false)
    setSort(key)
    setPage(1)
  }
  async function exportPersonal(): Promise<void> {
    setExporting(true)
    setExportError(null)
    try {
      const result = await window.api.dashboard.personalEfficiencyExport(filters, {
        keyword,
        weights,
        sortBy: effectiveSort,
        sortOrder: ascending ? "asc" : "desc"
      })
      if (!result.success && !result.canceled)
        throw new Error(result.error || "导出个人效能明细失败")
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }
  const header = (key: PersonalEfficiencyMetric | "score", label: string): React.JSX.Element => (
    <th
      key={key}
      scope="col"
      aria-sort={effectiveSort === key ? (ascending ? "ascending" : "descending") : "none"}
      className="px-3 py-2 text-right font-medium"
    >
      <button
        type="button"
        onClick={() => changeSort(key)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {effectiveSort === key ? (
          ascending ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
      </button>
    </th>
  )
  return (
    <section aria-busy={loading}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">个人使用情况</h2>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="查看个人使用统计口径"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs leading-relaxed">
                <p>
                  项目指标按照项目经理的维度统计到人
                  统计，受项目所属室和项目日期筛选控制；代码生成指标按项目模式关联的精益项目统计。
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value)
              setPage(1)
            }}
            placeholder="搜索姓名或员工号"
            aria-label="搜索个人使用情况"
            className="h-8 w-44 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={loading || exporting || !rows.length}
            onClick={() => void exportPersonal()}
          >
            {exporting ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 size-3.5" />
            )}
            导出个人效能明细
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setWeightOpen(true)}
          >
            <Settings2 className="mr-1 size-3.5" />
            排名权重
          </Button>
        </div>
      </div>
      {!hasWeights ? (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          权重全部为 0，未计算综合排名。
        </p>
      ) : null}
      {data?.warnings.map((warning) => (
        <p key={warning} role="status" className="mb-2 text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      {exportError ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {exportError}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mb-3 text-xs text-destructive">
          {error}
          <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
            重试
          </Button>
        </div>
      ) : null}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载个人使用情况
        </div>
      ) : null}
      {data ? (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    排名
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    人员
                  </th>
                  {header("score", "综合得分")}
                  {metrics.map(({ key, label }) => header(key, label))}
                  <th scope="col" className="px-3 py-2 font-medium">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice((currentPage - 1) * 20, currentPage * 20)
                  .map(({ person, score, rank }) => (
                    <tr key={person.sapId} className="border-t border-border/60 hover:bg-muted/20">
                      <td className="px-3 py-2 text-left tabular-nums">{rank ?? "—"}</td>
                      <td className="px-3 py-2 text-left">
                        <button
                          type="button"
                          onClick={() => setSelected(person)}
                          className="text-primary hover:underline"
                        >
                          {person.userName}
                        </button>
                        <div
                          className="mt-0.5 text-muted-foreground"
                          title={person.rooms.join("、")}
                        >
                          {person.sapId}
                        </div>
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        title={
                          score === null
                            ? hasWeights
                              ? "参与评分的指标数据不完整"
                              : "权重全部为零"
                            : "各项原值乘权重后求和"
                        }
                      >
                        {formatPersonalMetric(score)}
                      </td>
                      {metrics.map(({ key, unit }) => (
                        <td key={key} className="px-3 py-2 text-right tabular-nums">
                          {formatPersonalMetric(person.values[key], unit)}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setSelected(person)}
                        >
                          详情
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!rows.length ? (
              <div className="p-8 text-center text-xs text-muted-foreground">
                当前范围内无符合条件的人员
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              共 {rows.length} 人 · 第 {currentPage} / {pages} 页
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      ) : null}
      {weightOpen ? (
        <PersonalEfficiencyWeightsDialog
          weights={weights}
          includeMonthly={Boolean(monthLabel)}
          onClose={() => setWeightOpen(false)}
          onApply={(next) => {
            setWeights(next)
            setSort("score")
            setAscending(false)
            setPage(1)
            setWeightOpen(false)
          }}
        />
      ) : null}
      <PersonalEfficiencyDetail
        key={selected?.sapId ?? "closed"}
        person={selected}
        filters={filters}
        onClose={() => setSelected(null)}
      />
    </section>
  )
}
