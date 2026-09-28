import { useState } from "react"
import { Check, ChevronDown, Users, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export function ProjectMetricGroupFilter({
  value,
  options,
  loading,
  disabled,
  error,
  onChange
}: {
  value: string[]
  options: string[]
  loading: boolean
  disabled: boolean
  error: string | null
  onChange: (groups: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selected = new Set(value)
  const label = disabled
    ? "请先选择室"
    : value.length === 0
      ? "全部"
      : value.length === 1
        ? value[0]
        : `已选 ${value.length} 个组`

  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <Users className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground" title="仅筛选项目质量与交付指标">
        组筛选
      </span>
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-[240px] justify-between gap-1 text-xs font-normal"
            disabled={disabled || loading}
            title="仅筛选项目质量与交付指标"
          >
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {loading ? "加载中" : label}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-1">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60"
            onClick={() => onChange([])}
          >
            <span className={value.length === 0 ? "font-medium" : "text-muted-foreground"}>
              全部
            </span>
            {value.length === 0 && <Check className="size-3.5 text-primary" />}
          </button>
          <div className="my-1 h-px bg-border" />
          <div className="max-h-64 overflow-y-auto pr-1">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {error || "暂无可选组"}
              </div>
            ) : (
              options.map((group) => (
                <button
                  key={group}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                  onClick={() =>
                    onChange(
                      selected.has(group)
                        ? value.filter((item) => item !== group)
                        : [...value, group]
                    )
                  }
                >
                  <span className={cn("truncate", selected.has(group) && "font-medium")}>
                    {group}
                  </span>
                  {selected.has(group) && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onChange([])}
        >
          <X className="size-3.5" />
          清除
        </Button>
      )}
    </div>
  )
}
