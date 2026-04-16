/**
 * Operations Dashboard
 *
 * 5 panels: Overview · Feedback · Model Analysis · User Analysis · Productivity
 */
import { useState } from "react"
import { RefreshCw, Loader2, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useDashboard, type Granularity } from "./use-dashboard"
import { OverviewPanel } from "./panels/OverviewPanel"
import { ModelPanel } from "./panels/ModelPanel"
import { UserPanel } from "./panels/UserPanel"
import { ProductivityPanel } from "./panels/ProductivityPanel"
import { FeedbackPanel } from "./panels/FeedbackPanel"

// ─────────────────────────────────────────────────────────
// Time control bar
// ─────────────────────────────────────────────────────────

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "custom", label: "自定义" }
]

function formatRangeLabel(from: string, to: string, granularity: Granularity): string {
  const f = new Date(from)
  const pad = (n: number): string => String(n).padStart(2, "0")
  const fmtDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  if (granularity === "day") return fmtDate(f)
  if (granularity === "custom") return `${fmtDate(f)} ~ ${fmtDate(new Date(to))}`
  if (granularity === "week") {
    const t = new Date(to)
    return `${fmtDate(f)} ~ ${fmtDate(t)}`
  }
  // month
  return `${f.getFullYear()}-${pad(f.getMonth() + 1)}`
}

function TimeControlBar({
  granularity,
  range,
  onGranularityChange,
  onNavigate,
  onCustomRange,
  onRefresh,
  loading
}: {
  granularity: Granularity
  range: { from: string; to: string }
  onGranularityChange: (g: Granularity) => void
  onNavigate: (dir: "prev" | "next") => void
  onCustomRange: (from: string, to: string) => void
  onRefresh: () => void
  loading: boolean
}) {
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")

  const handleCustomConfirm = (): void => {
    if (customFrom && customTo) {
      onCustomRange(
        new Date(customFrom + "T00:00:00").toISOString(),
        new Date(customTo + "T23:59:59.999").toISOString()
      )
      setShowDatePicker(false)
    }
  }

  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm">
      {/* Granularity tabs */}
      <div className="flex items-center rounded-lg border border-border overflow-hidden">
        {GRANULARITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              granularity === opt.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => {
              if (opt.value === "custom") {
                setShowDatePicker(true)
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
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => onNavigate("prev")}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs text-foreground font-medium min-w-[140px] text-center">
            {formatRangeLabel(range.from, range.to, granularity)}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={() => onNavigate("next")}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Custom date picker */}
      {granularity === "custom" && showDatePicker && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
          />
          <span className="text-xs text-muted-foreground">~</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
          />
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleCustomConfirm}>
            确认
          </Button>
        </div>
      )}

      {granularity === "custom" && !showDatePicker && (
        <span className="text-xs text-foreground font-medium">
          {formatRangeLabel(range.from, range.to, granularity)}
          <button
            className="ml-2 text-primary underline"
            onClick={() => setShowDatePicker(true)}
          >
            修改
          </button>
        </span>
      )}

      {/* Spacer + Refresh */}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        刷新
      </Button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Main Dashboard View
// ─────────────────────────────────────────────────────────

export function DashboardView(): React.JSX.Element {
  const {
    granularity,
    range,
    loading,
    error,
    overview,
    modelStats,
    userStats,
    productivity,
    feedback,
    changeGranularity,
    navigate,
    setCustomRange,
    refresh
  } = useDashboard()

  return (
    <div className="flex flex-col h-full">
      <TimeControlBar
        granularity={granularity}
        range={range}
        onGranularityChange={changeGranularity}
        onNavigate={navigate}
        onCustomRange={setCustomRange}
        onRefresh={refresh}
        loading={loading}
      />

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {/* Overview */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">使用概览</h2>
            <OverviewPanel data={overview} loading={loading} />
          </section>

          {/* Productivity */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">生产力指标</h2>
            <ProductivityPanel data={productivity} loading={loading} />
          </section>

          {/* User Analysis */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">用户分析</h2>
            <UserPanel data={userStats} loading={loading} />
          </section>

          {/* Model Analysis */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">模型分析</h2>
            <ModelPanel data={modelStats} loading={loading} />
          </section>

          {/* Feedback */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">点赞 / 点踩反馈</h2>
            <FeedbackPanel data={feedback} loading={loading} />
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}
