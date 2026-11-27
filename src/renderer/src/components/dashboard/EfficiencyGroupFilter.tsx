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

interface EfficiencyGroupFilterProps extends ProjectMetricGroupOptions {
  value: ProjectMetricGroup[]
  onChange: (groups: ProjectMetricGroup[]) => void
  refreshKey: number
}

export function EfficiencyGroupFilter({
  range,
  granularity,
  upperOrgLv1,
  dateBasis,
  value,
  onChange,
  refreshKey
}: EfficiencyGroupFilterProps): React.JSX.Element {
  const filters = useMemo(
    () => ({ range, granularity, upperOrgLv1, dateBasis }),
    [range, granularity, upperOrgLv1, dateBasis]
  )
  const [result, setResult] = useState<{
    filters: ProjectMetricGroupOptions
    refreshKey: number
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
          options: response.data ?? [],
          error: response.success ? undefined : response.error || "获取组失败"
        })
      },
      () => {
        if (!cancelled) setResult({ filters, refreshKey, options: [], error: "获取组失败" })
      }
    )
    return () => {
      cancelled = true
    }
  }, [filters, refreshKey])

  const enabled = Boolean(upperOrgLv1?.length)
  const current = result?.filters === filters && result.refreshKey === refreshKey ? result : undefined
  const selected = new Set(value.map(projectMetricGroupKey))
  const options = new Map(value.map((group) => [projectMetricGroupKey(group), group]))
  for (const group of current?.options ?? []) options.set(projectMetricGroupKey(group), group)
  const list = [...options.values()].sort(
    (a, b) => a.roomName.localeCompare(b.roomName) || a.groupName.localeCompare(b.groupName)
  )
  const label = (group: ProjectMetricGroup): string =>
    (upperOrgLv1?.length ?? 0) > 1 ? `${group.roomName}／${group.groupName}` : group.groupName
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
            className="h-7 w-[190px] justify-between gap-1 text-xs font-normal"
            title={enabled ? title : "请先选择室"}
            disabled={!enabled}
          >
            <span className={cn("truncate", !value.length && "text-muted-foreground")}>{title}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-1">
          <button
            type="button"
            aria-pressed={!value.length}
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60"
            onClick={() => onChange([])}
          >
            全部
            {!value.length && <Check className="size-3.5 text-primary" />}
          </button>
          <div className="my-1 h-px bg-border" />
          <div className="max-h-64 overflow-y-auto">
            {list.map((group) => {
              const key = projectMetricGroupKey(group)
              const checked = selected.has(key)
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={checked}
                  title={label(group)}
                  className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                  onClick={() => toggleGroup(group, key)}
                >
                  <span className={cn("truncate", checked && "font-medium")}>{label(group)}</span>
                  {checked && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              )
            })}
            {(!current || current.error || !list.length) && (
              <div className="px-2 py-2 text-center text-xs text-muted-foreground" aria-live="polite">
                {current?.error || (current ? "暂无可选组" : "加载中…")}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
