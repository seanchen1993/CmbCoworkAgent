import { useEffect, useState } from "react"
import { Code2, Info, Layers, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type {
  ProjectMetricFilters,
  ProjectMetricOverviewData
} from "../../../../../shared/project-metrics"
import {
  PROJECT_AI_RATE_TIP,
  PROJECT_FEATURE_COVERAGE_TIP
} from "../../../../../shared/project-metric-indicators"

const count = (value: number | null | undefined): string =>
  value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
const percent = (value: number | null | undefined): string =>
  value == null ? "—" : `${(value * 100).toFixed(2)}%`
function Tip({ text }: { text: string }): React.JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="查看指标口径">
            <Info className="size-3.5 text-muted-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-xs leading-relaxed">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
function Card({
  title,
  tip,
  icon,
  value,
  detail,
  error
}: {
  title: string
  tip: string
  icon: React.ReactNode
  value: string
  detail: string
  error: string | null | undefined
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {icon}
        <span>{title}</span>
        <Tip text={tip} />
      </div>
      <div className="mt-3 text-3xl font-semibold tabular-nums">{error ? "—" : value}</div>
      <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
      {error ? (
        <div role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  )
}
export function ProjectMetricOverview({
  filters,
  refreshKey
}: {
  filters: ProjectMetricFilters
  refreshKey: number
}): React.JSX.Element {
  const [data, setData] = useState<ProjectMetricOverviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const range = filters.range
  const rooms = filters.upperOrgLv1
  const dateBasis = filters.dateBasis
  useEffect(() => {
    let active = true
    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      setData(null)
      try {
        const result = await window.api.dashboard.projectMetricOverview({
          range,
          upperOrgLv1: rooms,
          dateBasis
        })
        if (!active) return
        if (!result.success || !result.data) throw new Error(result.error || "获取概览指标失败")
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
  }, [range, rooms, dateBasis, refreshKey, retry])
  const failed = error || data?.featureError || data?.codeError || data?.monthlyError
  return (
    <div className="mt-4 space-y-3" aria-busy={loading}>
      {loading || failed ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {failed ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setRetry((v) => v + 1)}
            >
              <RefreshCw className="mr-1 size-3" />
              重试概览
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <Card
          title="应用研发智能化特性占比"
          tip={PROJECT_FEATURE_COVERAGE_TIP}
          icon={<Layers className="size-4 text-sky-500" />}
          value={percent(data?.features?.rate)}
          detail={`智能化特性 ${count(data?.features?.intelligent)} / 特性总数 ${count(data?.features?.total)}`}
          error={error || data?.featureError}
        />
        <Card
          title="AI代码入库率"
          tip={PROJECT_AI_RATE_TIP}
          icon={<Code2 className="size-4 text-emerald-500" />}
          value={percent(data?.code?.pushedAdoptionRate)}
          detail={`已 Push 采纳 ${count(data?.code?.pushedAdoptedLines)} 行 / 对应有效生成 ${count(data?.code?.pushedEffectiveGeneratedLines)} 行`}
          error={error || data?.codeError}
        />
      </div>
      {data?.monthlyError ? (
        <div className="text-xs text-destructive" role="alert">
          月度代码数据：{data.monthlyError}
        </div>
      ) : null}
      {data?.monthly ? (
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="flex items-center gap-2 text-xs font-medium">
            代码入库情况
            <span className="font-normal text-muted-foreground">
              组织累计入库：{count(data.monthly.totalPushedLines)} 行
            </span>
          </div>
          <div className="mt-3 space-y-3">
            {[
              { source: "cumulative" as const, ...data.monthly.cumulative },
              ...data.monthly.sources
            ].map((source) => (
              <div
                key={source.source}
                className={`grid grid-cols-[110px_1fr_150px] items-center gap-3 text-xs ${source.source === "cumulative" ? "font-semibold" : ""}`}
              >
                <span>
                  {source.source === "cumulative"
                    ? "累计 AI 入库代码占比（硅碳比）"
                    : source.source === "devagent-ide"
                      ? "devagent-ide"
                      : source.source === "devclaw"
                        ? "CMBDevClaw"
                        : source.source}
                </span>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${source.source === "cumulative" ? "bg-emerald-500" : "bg-sky-500"}`}
                    style={{ width: `${Math.min(100, Math.max(0, (source.rate ?? 0) * 100))}%` }}
                  />
                </div>
                <span
                  className="text-right tabular-nums"
                  title={
                    source.missing
                      ? "数据未完整填报或代码查询不可用"
                      : data.monthly?.totalPushedLines === 0
                        ? "累计入库代码为零，比例不可用"
                        : undefined
                  }
                >
                  {percent(source.rate)} · {count(source.pushedLines)} 行
                  {source.missing ? "（缺数据）" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
