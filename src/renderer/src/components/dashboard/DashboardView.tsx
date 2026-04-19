/**
 * Operations Dashboard
 *
 * 5 panels: Overview · Feedback · Model Analysis · User Analysis · Productivity
 */
import { useState, useCallback } from "react"
import { RefreshCw, Loader2, AlertCircle, ChevronLeft, ChevronRight, Download } from "lucide-react"
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
  onExport,
  loading,
  exporting
}: {
  granularity: Granularity
  range: { from: string; to: string }
  onGranularityChange: (g: Granularity) => void
  onNavigate: (dir: "prev" | "next") => void
  onCustomRange: (from: string, to: string) => void
  onRefresh: () => void
  onExport: () => void
  loading: boolean
  exporting: boolean
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

      {/* Spacer + Export + Refresh */}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs"
        onClick={onExport}
        disabled={exporting || loading}
      >
        {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        导出Excel
      </Button>
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

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

  const [exporting, setExporting] = useState(false)

  const handleExport = useCallback(async () => {
    if (!overview && !modelStats && !userStats && !productivity) return
    setExporting(true)
    try {
      const sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }> = []

      // 1. Overview summary
      if (overview) {
        sheets.push({
          name: "使用概览",
          header: ["指标", "值"],
          rows: [
            ["调用总次数", overview.totalCalls],
            ["活跃用户数", overview.activeUsers],
            ["平均耗时", formatDuration(overview.avgDurationMs)],
            ["输入 Token", overview.inputTokens],
            ["输出 Token", overview.outputTokens],
            ["Skill 种类数", overview.totalSkills],
            ["Skill 调用次数", overview.totalSkillCalls],
            ["Tool 种类数", overview.totalTools],
            ["Tool 调用次数", overview.totalToolCalls]
          ]
        })

        // Trend
        if (overview.trend.length > 0) {
          sheets.push({
            name: "调用量趋势",
            header: ["时间", "调用次数", "活跃用户"],
            rows: overview.trend.map((t) => [t.time, t.count, t.users])
          })
        }

        // Skill Top
        if (overview.bySkill.length > 0) {
          sheets.push({
            name: "Skill使用排行",
            header: ["排名", "Skill", "调用次数"],
            rows: [
              ["Skill 种类数", overview.totalSkills, ""],
              ["Skill 调用次数", overview.totalSkillCalls, ""],
              ["", "", ""],
              ...overview.bySkill.map((s, i) => [i + 1, s.skill, s.count])
            ]
          })
        }

        // Tool Top (filtered)
        if (overview.byTool.length > 0) {
          sheets.push({
            name: "Tool使用排行(已过滤)",
            header: ["排名", "Tool", "调用次数"],
            rows: [
              ["Tool 种类数", overview.totalTools, ""],
              ["Tool 调用次数", overview.totalToolCalls, ""],
              ["", "", ""],
              ...overview.byTool.map((t, i) => [i + 1, t.tool, t.count])
            ]
          })
        }

        // Tool Top (all)
        if (overview.byToolAll.length > 0) {
          sheets.push({
            name: "Tool使用排行(全部)",
            header: ["排名", "Tool", "调用次数"],
            rows: [
              ["Tool 种类数", overview.totalTools, ""],
              ["Tool 调用次数", overview.totalToolCalls, ""],
              ["", "", ""],
              ...overview.byToolAll.map((t, i) => [i + 1, t.tool, t.count])
            ]
          })
        }
      }

      // 2. Model stats
      if (modelStats) {
        if (modelStats.byModel.length > 0) {
          sheets.push({
            name: "模型使用统计",
            header: ["模型", "调用次数", "输入Token", "输出Token", "总Token"],
            rows: modelStats.byModel.map((m) => [
              m.model, m.count, m.inputTokens, m.outputTokens, m.inputTokens + m.outputTokens
            ])
          })
        }
        if (modelStats.byTier.length > 0) {
          sheets.push({
            name: "分流统计",
            header: ["Tier", "调用次数"],
            rows: modelStats.byTier.map((t) => [t.tier, t.count])
          })
        }
        if (modelStats.byLayer.length > 0) {
          sheets.push({
            name: "路由决策层",
            header: ["决策层", "命中次数"],
            rows: modelStats.byLayer.map((l) => [l.layer, l.count])
          })
        }
      }

      // 3. User stats
      if (userStats) {
        if (userStats.topUsers.length > 0) {
          sheets.push({
            name: "用户使用排行",
            header: ["排名", "SAP ID", "用户名", "部门", "调用次数"],
            rows: userStats.topUsers.map((u, i) => [
              i + 1, u.sapId, u.userName, u.orgName || "—", u.count
            ])
          })
        }
        if (userStats.byOrg.length > 0) {
          sheets.push({
            name: "部门分布",
            header: ["部门", "调用次数"],
            rows: userStats.byOrg.map((o) => [o.org, o.count])
          })
        }
        if (userStats.byVersion.length > 0) {
          sheets.push({
            name: "版本分布",
            header: ["版本", "调用次数"],
            rows: userStats.byVersion.map((v) => [v.version, v.count])
          })
        }
      }

      // 4. Productivity
      if (productivity) {
        sheets.push({
          name: "生产力概览",
          header: ["指标", "值"],
          rows: [
            ["Commit 总数", productivity.totalCommits],
            ["新增行数", productivity.totalInsertions],
            ["删除行数", productivity.totalDeletions],
            ["文件变更数", productivity.totalFilesChanged],
            ["活跃用户数", productivity.activeUsers],
            ["人均 Commit", Number(productivity.avgCommitsPerUser.toFixed(1))]
          ]
        })
        if (productivity.commitTrend.length > 0) {
          sheets.push({
            name: "Commit趋势",
            header: ["时间", "Commit数"],
            rows: productivity.commitTrend.map((c) => [c.time, c.count])
          })
        }
      }

      if (sheets.length === 0) return

      const result = await window.api.dashboard.exportExcel(sheets)
      if (result.success) {
        console.log("[Dashboard] Exported to:", result.filePath)
      } else if (!result.canceled && result.error) {
        console.error("[Dashboard] Export failed:", result.error)
      }
    } finally {
      setExporting(false)
    }
  }, [overview, modelStats, userStats, productivity])

  return (
    <div className="flex flex-col h-full">
      <TimeControlBar
        granularity={granularity}
        range={range}
        onGranularityChange={changeGranularity}
        onNavigate={navigate}
        onCustomRange={setCustomRange}
        onRefresh={refresh}
        onExport={handleExport}
        loading={loading}
        exporting={exporting}
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
