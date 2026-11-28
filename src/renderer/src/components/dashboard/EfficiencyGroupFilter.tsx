import { useEffect, useMemo, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import {
  projectMetricGroupKey,
  type ProjectMetricGroup,
  type ProjectMetricGroupOptions
} from "../../../../shared/project-metrics"
import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { cn } from "@renderer/lib/utils"
import {
  EFFICIENCY_FILTER_MENU,
  EFFICIENCY_FILTER_OPTION,
  EFFICIENCY_FILTER_TRIGGER,
  EFFICIENCY_ORG_FILTER_WIDTH
} from "./efficiency-filter-styles"

interface EfficiencyGroupFilterProps extends ProjectMetricGroupOptions {
  value: ProjectMetricGroup[]
  onChange: (groups: ProjectMetricGroup[]) => void
  refreshKey: number
}

const UNCLASSIFIED_ORG = "__unclassified__"

export function EfficiencyGroupFilter({
  range,
  granularity,
  upperOrgLv1,
  dateBasis,
  value,
  onChange,
  refreshKey
}: EfficiencyGroupFilterProps): React.JSX.Element {
  const realRooms = useMemo(
    () => (upperOrgLv1 ?? []).filter((room) => room !== UNCLASSIFIED_ORG),
    [upperOrgLv1]
  )
  const filters = useMemo(
    () => ({ range, granularity, upperOrgLv1: realRooms, dateBasis }),
    [range, granularity, realRooms, dateBasis]
  )
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{
    filters: ProjectMetricGroupOptions
    refreshKey: number
    retry: number
    options: ProjectMetricGroup[]
    error?: string
  }>()
  useEffect(() => {
    if (!filters.upperOrgLv1?.length) return
    let cancelled = false
    void window.api.dashboard.projectMetricGroupOptions(filters).then(
      (response) => {
        if (cancelled) return
        setResult({
          filters,
          refreshKey,
          retry,
          options: response.data ?? [],
          error: response.success ? undefined : response.error || "获取组失败"
        })
      },
      () => {
        if (!cancelled)
          setResult({ filters, refreshKey, retry, options: [], error: "获取组失败" })
      }
    )
    return () => {
      cancelled = true
    }
  }, [filters, refreshKey, retry])

  const enabled = realRooms.length > 0
  const current =
    result?.filters === filters && result.refreshKey === refreshKey && result.retry === retry
      ? result
      : undefined
  const selected = new Set(value.map(projectMetricGroupKey))
  const options = new Map(value.map((group) => [projectMetricGroupKey(group), group]))
  for (const group of current?.options ?? []) options.set(projectMetricGroupKey(group), group)
  const list = [...options.values()].sort(
    (a, b) =>
      a.roomName.localeCompare(b.roomName, "zh-CN") ||
      a.groupName.trim().localeCompare(b.groupName.trim(), "zh-CN") ||
      a.groupName.localeCompare(b.groupName)
  )
  const label = (group: ProjectMetricGroup): string => {
    const displayGroup = group.groupName.trim()
    return realRooms.length > 1 ? `${group.roomName}／${displayGroup}` : displayGroup
  }
  const title =
    value.length === 1 ? label(value[0]) : value.length ? `已选 ${value.length} 个组` : "全部"
  const toggleGroup = (group: ProjectMetricGroup, key: string): void => {
    onChange(
      selected.has(key)
        ? value.filter((item) => projectMetricGroupKey(item) !== key)
        : [...value, group]
    )
  }
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">组筛选</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label={`组筛选：${title}`}
            variant="outline"
            size="sm"
            className={cn(EFFICIENCY_FILTER_TRIGGER, EFFICIENCY_ORG_FILTER_WIDTH)}
            title={enabled ? title : "请先选择室"}
            disabled={!enabled}
          >
            <span className={cn("truncate", !value.length && "text-muted-foreground")}>{title}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={cn(EFFICIENCY_FILTER_MENU, "w-[var(--radix-popover-trigger-width)] p-1")}
        >
          <button
            type="button"
            aria-pressed={!value.length}
            className={cn(EFFICIENCY_FILTER_OPTION, "flex w-full items-center justify-between")}
            onClick={() => onChange([])}
          >
            全部
            {!value.length && <Check className="size-3.5" />}
          </button>
          <div className="my-1 h-px bg-border" />
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {list.map((group) => {
              const key = projectMetricGroupKey(group)
              const checked = selected.has(key)
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={checked}
                  title={label(group)}
                  className={cn(EFFICIENCY_FILTER_OPTION, "flex w-full items-center justify-between gap-2")}
                  onClick={() => toggleGroup(group, key)}
                >
                  <span className={cn("truncate", checked && "font-medium")}>{label(group)}</span>
                  {checked && <Check className="size-3.5 shrink-0" />}
                </button>
              )
            })}
            {(!current || current.error || !list.length) && (
              <div
                className={cn(
                  "px-2 py-2 text-center text-xs",
                  current?.error ? "text-destructive" : "text-muted-foreground"
                )}
                aria-live="polite"
              >
                <span>{current?.error || (current ? "暂无可选组" : "加载中…")}</span>
                {current?.error ? (
                  <button
                    type="button"
                    className="ml-1.5 text-primary underline-offset-2 hover:underline"
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    重试
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
