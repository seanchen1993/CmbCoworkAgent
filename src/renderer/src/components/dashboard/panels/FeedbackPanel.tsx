import { ThumbsUp, ThumbsDown, Percent, MessageSquareText, Users } from "lucide-react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts"
import type { FeedbackData } from "../use-dashboard"

function StatCard({
  icon: Icon,
  label,
  value,
  color
}: {
  icon: React.ElementType
  label: string
  value: string
  color: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-8 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-3.5 text-white" />
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-base font-bold text-foreground leading-tight">{value}</div>
      </div>
    </div>
  )
}

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

export function FeedbackPanel({
  data,
  loading
}: {
  data: FeedbackData | null
  loading: boolean
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard
          icon={ThumbsUp}
          label="点赞次数"
          value={String(data.totalLikes)}
          color="bg-emerald-500"
        />
        <StatCard
          icon={ThumbsDown}
          label="点踩次数"
          value={String(data.totalDislikes)}
          color="bg-rose-500"
        />
        <StatCard
          icon={Users}
          label="点赞用户数"
          value={String(data.totalLikeUsers)}
          color="bg-teal-500"
        />
        <StatCard
          icon={Users}
          label="点踩用户数"
          value={String(data.totalDislikeUsers)}
          color="bg-orange-500"
        />
        <StatCard
          icon={Percent}
          label="点赞率"
          value={formatPercent(data.likeRate)}
          color="bg-blue-500"
        />
        <StatCard
          icon={MessageSquareText}
          label="文本反馈"
          value={String(data.recentComments.length)}
          color="bg-violet-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-3">点踩类型分布</h3>
          {data.byDislikeType.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">暂无点踩数据</div>
          ) : (
            <div className="space-y-2">
              {data.byDislikeType.map((item) => {
                const max = data.byDislikeType[0]?.count ?? 0
                const pct = max > 0 ? (item.count / max) * 100 : 0
                return (
                  <div key={item.type} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-foreground">{item.label}</span>
                      <span className="text-[11px] text-muted-foreground">{item.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-rose-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-3">最近文本反馈</h3>
          {data.recentComments.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">暂无文本反馈</div>
          ) : (
            <div className="space-y-2 max-h-[200px] overflow-auto">
              {data.recentComments.map((item, idx) => (
                <div key={`${item.time}-${idx}`} className="rounded-lg border border-border/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-foreground">
                      {item.typeLabel}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{item.time}</span>
                  </div>
                  <div className="mt-1.5 text-xs text-foreground/90 leading-relaxed break-all">
                    {item.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">点赞/点踩趋势</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.trend}>
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
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="likes"
              name="点赞"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ r: 2.5 }}
            />
            <Line
              type="monotone"
              dataKey="dislikes"
              name="点踩"
              stroke="#f43f5e"
              strokeWidth={2}
              dot={{ r: 2.5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
