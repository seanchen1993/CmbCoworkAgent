import { useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Granularity, TimeRange } from "./use-dashboard"
import {
  formatRangeLabel,
  formatDateInputValue,
  addDaysToDateInput,
  MS_PER_DAY
} from "./dashboard-time-range"

export interface DashboardTimeControl {
  granularity: Granularity
  range: TimeRange
  onGranularityChange: (g: Granularity) => void
  onNavigate: (dir: "prev" | "next") => void
  onCustomRange: (from: string, to: string) => void
  customRangeMaxDays: number
}
const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "custom", label: "自定义" }
]

export function TimeControlBar({
  granularity,
  range,
  onGranularityChange,
  onNavigate,
  onCustomRange,
  onRefresh,
  loading = false,
  disabled = false,
  className,
  customRangeMaxDays,
  orgFilter
}: DashboardTimeControl & {
  onRefresh?: () => void
  loading?: boolean
  disabled?: boolean
  className?: string
  orgFilter?: ReactNode
}) {
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [customRangeError, setCustomRangeError] = useState("")
  const normalizedCustomRangeMaxDays = Math.max(1, Math.floor(customRangeMaxDays))
  const customToMax = customFrom
    ? addDaysToDateInput(customFrom, normalizedCustomRangeMaxDays - 1)
    : ""

  const openDatePicker = () => {
    setCustomFrom(formatDateInputValue(new Date(range.from)))
    setCustomTo(formatDateInputValue(new Date(range.to)))
    setCustomRangeError("")
    setShowDatePicker(true)
  }

  const handleCustomConfirm = (): void => {
    if (!customFrom || !customTo) return

    const fromDate = new Date(customFrom + "T00:00:00")
    const toDate = new Date(customTo + "T00:00:00")
    if (toDate < fromDate) {
      setCustomRangeError("结束日期不能早于开始日期")
      return
    }

    const selectedDays = Math.floor((toDate.getTime() - fromDate.getTime()) / MS_PER_DAY) + 1
    if (selectedDays > normalizedCustomRangeMaxDays) {
      setCustomRangeError(`自定义范围最多选择 ${normalizedCustomRangeMaxDays} 天`)
      return
    }

    setCustomRangeError("")
    onCustomRange(
      new Date(customFrom + "T00:00:00").toISOString(),
      new Date(customTo + "T23:59:59.999").toISOString()
    )
    setShowDatePicker(false)
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-3 px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm",
        className
      )}
    >
      {/* Granularity tabs */}
      <div
        className="flex shrink-0 items-center rounded-lg border border-border overflow-hidden"
        role="group"
        aria-label="时间粒度"
      >
        {GRANULARITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={granularity === opt.value}
            disabled={disabled}
            className={`whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors ${
              granularity === opt.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => {
              if (opt.value === "custom") {
                openDatePicker()
                onGranularityChange("custom")
              } else {
                setShowDatePicker(false)
                onGranularityChange(opt.value)
              }
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Navigation arrows (not for custom) */}
      {granularity !== "custom" && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上一周期"
            disabled={disabled}
            onClick={() => onNavigate("prev")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs text-foreground font-medium min-w-[140px] text-center">
            {formatRangeLabel(range.from, range.to, granularity)}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下一周期"
            disabled={disabled}
            onClick={() => onNavigate("next")}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Custom date picker */}
      {granularity === "custom" && showDatePicker && (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="开始日期"
              disabled={disabled}
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => {
                setCustomFrom(e.target.value)
                setCustomRangeError("")
              }}
              className="h-7 min-w-0 w-32 px-2 text-xs border border-border rounded bg-background text-foreground"
            />
            <span className="text-xs text-muted-foreground">~</span>
            <input
              type="date"
              aria-label="结束日期"
              disabled={disabled}
              value={customTo}
              min={customFrom || undefined}
              max={customToMax || undefined}
              onChange={(e) => {
                setCustomTo(e.target.value)
                setCustomRangeError("")
              }}
              className="h-7 min-w-0 w-32 px-2 text-xs border border-border rounded bg-background text-foreground"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={disabled || !customFrom || !customTo}
              onClick={handleCustomConfirm}
            >
              确认
            </Button>
          </div>
          {customRangeError ? (
            <span className="text-[11px] leading-none text-destructive">{customRangeError}</span>
          ) : null}
        </div>
      )}

      {granularity === "custom" && !showDatePicker && (
        <span className="min-w-0 text-xs text-foreground font-medium">
          {formatRangeLabel(range.from, range.to, granularity)}
          <button
            className="ml-2 text-primary underline"
            disabled={disabled}
            onClick={openDatePicker}
          >
            修改
          </button>
        </span>
      )}

      {/* 室筛选：紧跟日期控件之后 */}
      {orgFilter}

      {/* Spacer + Refresh */}
      {onRefresh && (
        <>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 text-xs"
            onClick={onRefresh}
            disabled={loading || disabled}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            刷新
          </Button>
        </>
      )}
    </div>
  )
}
