import { GitCommit, FilePlus, FileMinus, FileText, Users, UserCheck } from "lucide-react"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from "recharts"
import type { ProductivityData } from "../use-dashboard"

function StatCard({
  icon: Icon,
  label,
  value,
  color,
  onClick
}: {
  icon: React.ElementType
  label: string
  value: string
  color: string
  onClick?: () => void
}) {
  const content = (
    <>
      <div className={`flex size-8 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-3.5 text-white" />
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-base font-bold text-foreground leading-tight">{value}</div>
      </div>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-ring"
        onClick={onClick}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      {content}
    </div>
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export function ProductivityPanel({
  data,
  loading,
  onCommitTotalClick,
  onCommitBucketClick
}: {
  data: ProductivityData | null
  loading: boolean
  onCommitTotalClick?: () => void
  onCommitBucketClick?: (bucket: { from: string; to: string; label: string }) => void
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  const trendData = data.commitTrend
  const getCommitBucketPayload = (value: unknown): ProductivityData["commitTrend"][number] | null => {
    if (!value || typeof value !== "object") return null
    const payload = (value as { payload?: unknown }).payload
    if (!payload || typeof payload !== "object") return null
    const candidate = payload as Partial<ProductivityData["commitTrend"][number]>
    if (typeof candidate.from !== "string" || typeof candidate.to !== "string" || typeof candidate.time !== "string") {
      return null
    }
    return candidate as ProductivityData["commitTrend"][number]
  }

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-6 gap-3">
        <StatCard
          icon={GitCommit}
          label="Commit 总数"
          value={formatNumber(data.totalCommits)}
          color="bg-blue-500"
          onClick={onCommitTotalClick}
        />
        <StatCard
          icon={FilePlus}
          label="新增行数"
          value={formatNumber(data.totalInsertions)}
          color="bg-emerald-500"
        />
        <StatCard
          icon={FileMinus}
          label="删除行数"
          value={formatNumber(data.totalDeletions)}
          color="bg-red-500"
        />
        <StatCard
          icon={FileText}
          label="文件变更数"
          value={formatNumber(data.totalFilesChanged)}
          color="bg-amber-500"
        />
        <StatCard
          icon={Users}
          label="GitPanel 用户数"
          value={formatNumber(data.activeUsers)}
          color="bg-teal-500"
        />
        <StatCard
          icon={UserCheck}
          label="人均 Commit"
          value={data.avgCommitsPerUser.toFixed(1)}
          color="bg-violet-500"
        />
      </div>

      {/* Commit trend */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">Commit 趋势</h3>
        {trendData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                axisLine={{ stroke: "var(--color-border)" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                axisLine={{ stroke: "var(--color-border)" }}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12
                }}
              />
              <Bar
                dataKey="count"
                name="Commits"
                fill="#3b82f6"
                radius={[4, 4, 0, 0]}
                cursor={onCommitBucketClick ? "pointer" : undefined}
                activeBar={onCommitBucketClick ? { fill: "#2563eb", radius: [4, 4, 0, 0] } : false}
                onClick={(entry: unknown) => {
                  const bucket = getCommitBucketPayload(entry)
                  if (!bucket) return
                  onCommitBucketClick?.({ from: bucket.from, to: bucket.to, label: bucket.time })
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">
            暂无 Commit 数据
          </div>
        )}
      </div>
    </div>
  )
}
