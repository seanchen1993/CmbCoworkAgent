import type { ReactNode } from "react"
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer
} from "recharts"
import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { UserStatsData } from "../use-dashboard"

const COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981",
  "#06b6d4", "#f97316", "#6366f1", "#14b8a6", "#e11d48"
]


function PiePanel({
  title,
  data,
  dataKey,
  nameKey,
  onSliceClick,
  action,
  helperText
}: {
  title: string
  data: Record<string, unknown>[]
  dataKey: string
  nameKey: string
  onSliceClick?: (entry: Record<string, unknown>) => void
  action?: ReactNode
  helperText?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
          {helperText ? <p className="mt-1 text-[11px] text-muted-foreground/80">{helperText}</p> : null}
        </div>
        {action}
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={data}
              dataKey={dataKey}
              nameKey={nameKey}
              cx="50%"
              cy="50%"
              outerRadius={75}
              label={({ name, percent }) =>
                `${String(name).length > 6 ? String(name).slice(0, 6) + "…" : name} ${((percent ?? 0) * 100).toFixed(0)}%`
              }
              labelLine={false}
              fontSize={9}
              onClick={onSliceClick ? (entry) => onSliceClick(entry as Record<string, unknown>) : undefined}
              style={onSliceClick ? { cursor: "pointer" } : undefined}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center h-[240px] text-xs text-muted-foreground">
          暂无数据
        </div>
      )}
    </div>
  )
}

export function UserPanel({
  data,
  loading,
  onDrillDownOrg,
  onResetOrgDrilldown
}: {
  data: UserStatsData | null
  loading: boolean
  onDrillDownOrg: (orgLv1: string) => void
  onResetOrgDrilldown: () => void
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  const isDrilledDown = data.selectedUpperOrgLv1 !== null

  return (
    <div className="grid grid-cols-3 gap-4">
      {/* User ranking table */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">用户使用排行</h3>
        <div className="max-h-[260px] overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left py-2 px-2 font-medium">#</th>
                <th className="text-left py-2 px-2 font-medium">用户</th>
                <th className="text-left py-2 px-2 font-medium">部门</th>
                <th className="text-right py-2 px-2 font-medium">调用次数</th>
              </tr>
            </thead>
            <tbody>
              {data.topUsers.map((u, i) => (
                <tr key={u.sapId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="py-1.5 px-2 text-muted-foreground">{i + 1}</td>
                  <td className="py-1.5 px-2 text-foreground">
                    {u.userName}
                    <span className="text-muted-foreground ml-1">({u.sapId})</span>
                  </td>
                  <td className="py-1.5 px-2 text-muted-foreground">{u.orgName || "—"}</td>
                  <td className="py-1.5 px-2 text-right font-medium text-foreground">{u.count}</td>
                </tr>
              ))}
              {data.topUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-muted-foreground">
                    暂无数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Org distribution */}
      <PiePanel
        title="部门分布"
        data={data.byOrg as Record<string, unknown>[]}
        dataKey="count"
        nameKey="org"
        helperText="点击可查看下级组织使用情况"
        action={isDrilledDown ? (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onResetOrgDrilldown}>
            <ChevronLeft className="size-3.5" />
            返回上级
          </Button>
        ) : undefined}
        onSliceClick={!isDrilledDown ? (entry) => {
          const key = typeof entry.key === "string" ? entry.key : ""
          onDrillDownOrg(key)
        } : undefined}
      />

      {/* Version distribution */}
      <PiePanel
        title="版本占比"
        data={data.byVersion as Record<string, unknown>[]}
        dataKey="count"
        nameKey="version"
      />
    </div>
  )
}
