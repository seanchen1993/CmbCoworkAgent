import { useState } from "react"
import { Activity, Users, Clock, ArrowDownToLine, ArrowUpFromLine } from "lucide-react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts"
import type { OverviewData } from "../use-dashboard"

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold text-foreground leading-tight">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function ToolTopPanel({ data }: { data: OverviewData }) {
  const [showAll, setShowAll] = useState(false)
  const toolList = showAll ? data.byToolAll : data.byTool

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            Tool 使用 Top {showAll ? toolList.length : 10}
          </h3>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span><span className="font-semibold text-foreground">{data.totalTools}</span> 种</span>
            <span className="text-border">|</span>
            <span>共 <span className="font-semibold text-foreground">{formatNumber(data.totalToolCalls)}</span> 次调用</span>
          </div>
        </div>
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          <button
            className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
              !showAll
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => setShowAll(false)}
          >
            已过滤
          </button>
          <button
            className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
              showAll
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => setShowAll(true)}
          >
            全部
          </button>
        </div>
      </div>
      {toolList.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-4">暂无数据</div>
      ) : (
        <div className={`space-y-1.5 ${showAll ? "max-h-[320px] overflow-y-auto pr-1" : ""}`}>
          {toolList.map((item, i) => {
            const max = toolList[0].count
            const pct = max > 0 ? (item.count / max) * 100 : 0
            return (
              <div key={item.tool} className="flex items-center gap-2">
                <span className="w-5 text-[10px] text-muted-foreground text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs truncate text-foreground font-mono">{item.tool}</span>
                    <span className="text-[11px] text-muted-foreground ml-2 shrink-0">{item.count}</span>
                  </div>
                  <div className="h-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function OverviewPanel({
  data,
  loading
}: {
  data: OverviewData | null
  loading: boolean
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  const trendData = data.trend

  return (
    <div className="space-y-4">
      {/* Row 1: Core metrics */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          icon={Activity}
          label="调用总次数"
          value={formatNumber(data.totalCalls)}
          color="bg-blue-500"
        />
        <StatCard
          icon={Users}
          label="活跃用户数"
          value={String(data.activeUsers)}
          color="bg-violet-500"
        />
        <StatCard
          icon={Clock}
          label="平均耗时"
          value={formatDuration(data.avgDurationMs)}
          color="bg-amber-500"
        />
        <StatCard
          icon={ArrowDownToLine}
          label="输入 Token"
          value={formatNumber(data.inputTokens)}
          color="bg-sky-500"
        />
        <StatCard
          icon={ArrowUpFromLine}
          label="输出 Token"
          value={formatNumber(data.outputTokens)}
          color="bg-rose-500"
        />
      </div>

      {/* Skill & Tool Top rankings */}
      <div className="grid grid-cols-2 gap-3">
        {/* Skill Top 10 */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-muted-foreground">Skill 使用 Top 10</h3>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span><span className="font-semibold text-foreground">{data.totalSkills}</span> 种</span>
              <span className="text-border">|</span>
              <span>共 <span className="font-semibold text-foreground">{formatNumber(data.totalSkillCalls)}</span> 次调用</span>
            </div>
          </div>
          {data.bySkill.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">暂无数据</div>
          ) : (
            <div className="space-y-1.5">
              {data.bySkill.map((item, i) => {
                const max = data.bySkill[0].count
                const pct = max > 0 ? (item.count / max) * 100 : 0
                return (
                  <div key={item.skill} className="flex items-center gap-2">
                    <span className="w-4 text-[10px] text-muted-foreground text-right">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs truncate text-foreground">{item.skill}</span>
                        <span className="text-[11px] text-muted-foreground ml-2 shrink-0">{item.count}</span>
                      </div>
                      <div className="h-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Tool Top */}
        <ToolTopPanel data={data} />
      </div>

      {/* Trend chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">调用量趋势</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="count"
              name="调用次数"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="users"
              name="活跃用户"
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
