import {
  Activity,
  Users,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  Code2,
  Trash2,
  Gauge
} from "lucide-react"
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend
} from "recharts"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { CodeAdoptionFunnel, SkillRankingPanel, ToolRankingPanel } from "./dashboard-shared"
import type { OverviewData } from "../use-dashboard"

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
  tooltipContent,
  onClick
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
  tooltipContent?: React.ReactNode
  onClick?: () => void
}) {
  const className = `flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left ${
    onClick
      ? "cursor-pointer transition-colors hover:bg-muted/30"
      : tooltipContent
        ? "cursor-help"
        : ""
  }`
  const content = (
    <>
      <div className={`flex size-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div className="min-w-0">
        <div className="truncate whitespace-nowrap text-[11px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold text-foreground leading-tight">{value}</div>
        {sub && <div className="whitespace-nowrap text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </>
  )
  const card = onClick ? (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )

  if (!tooltipContent) return card

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent className="max-w-64">{tooltipContent}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
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

function formatPercent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toFixed(2)}%`
}

function formatExactNumber(n: number): string {
  return Math.round(n).toLocaleString("zh-CN")
}

function InclusiveAdoptionTooltip({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">含未提交采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">未提交生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeUnmeasuredGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">含未提交分母</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeInclusiveEffectiveGeneratedLines)} 行
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / (已测量有效生成行数 + 未提交生成行数)。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
      </div>
    </div>
  )
}

function MeasuredAdoptionTooltip({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">已Commit采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量原始生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeMeasuredGeneratedLines)} 行
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / 已测量有效生成行数。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
      </div>
    </div>
  )
}

function PushedAdoptionTooltip({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">已 Push 采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 采纳行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 有效生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 原始生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedMeasuredGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push Commit 数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedCommitCount)} 次
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 已 Push 采纳行数 / 已 Push 有效生成行数。</div>
        <div>仅统计通过应用成功 Push 后的 commit。</div>
      </div>
    </div>
  )
}

function GeneratedLinesTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">代码生成行数说明</div>
      <div className="text-muted-foreground">当前按 agent 写入或编辑的非空行统计。</div>
      <div className="text-muted-foreground">空行和仅包含空白字符的行不会计入。</div>
      <div className="text-muted-foreground">
        该指标表示原始生成量，包含后续被 agent 自己改写的中间稿。
      </div>
      <div className="text-muted-foreground">
        以下文件不纳入统计：非代码文件（如
        Markdown、JSON、图片等）、锁文件（package-lock.json、pnpm-lock.yaml、yarn.lock）、压缩/构建产物（.min.js/.min.css、.map）、依赖与构建目录（node_modules、dist、build
        等）。
      </div>
    </div>
  )
}

export function OverviewPanel({
  data,
  loading,
  onSkillClick,
  onActiveUsersClick,
  marketSkillKeys = new Set(),
  pluginSkillKeys = new Set()
}: {
  data: OverviewData | null
  loading: boolean
  onSkillClick?: (skill: string) => void
  onActiveUsersClick?: () => void
  marketSkillKeys?: Set<string>
  pluginSkillKeys?: Set<string>
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  const trendData = data.trend

  return (
    <div className="space-y-4">
      {/* 概览卡片（左，统一大小）+ 代码采纳漏斗（右，跨整列高度）*/}
      <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3">
        <div className="grid grid-cols-5 gap-3 content-start">
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
            onClick={onActiveUsersClick}
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
          <StatCard
            icon={Code2}
            label="代码生成行数"
            value={formatNumber(data.codeGeneratedLines)}
            color="bg-emerald-500"
            tooltipContent={<GeneratedLinesTooltip />}
          />
          <StatCard
            icon={Trash2}
            label="代码删除行数"
            value={formatNumber(data.codeDeletedLines)}
            color="bg-zinc-500"
            tooltipContent={<GeneratedLinesTooltip />}
          />
          <StatCard
            icon={Gauge}
            label="已 Push 采纳率"
            value={formatPercent(data.codePushedAdoptionRate)}
            sub={
              data.codePushedAdoptionRate === null
                ? "暂无已 Push 数据"
                : `${formatNumber(data.codePushedAdoptedLines)} / ${formatNumber(data.codePushedEffectiveGeneratedLines)} 行`
            }
            color="bg-indigo-500"
            tooltipContent={<PushedAdoptionTooltip data={data} />}
          />
          <StatCard
            icon={Gauge}
            label="已Commit采纳率"
            value={formatPercent(data.codeMeasuredAdoptionRate)}
            sub={
              data.codeMeasuredAdoptionRate === null
                ? "暂无测量数据"
                : `${formatNumber(data.codeAdoptedLines)} / ${formatNumber(data.codeEffectiveGeneratedLines)} 行`
            }
            color="bg-blue-500"
            tooltipContent={<MeasuredAdoptionTooltip data={data} />}
          />
          <StatCard
            icon={Gauge}
            label="含未提交采纳率"
            value={formatPercent(data.codeInclusiveAdoptionRate)}
            sub={
              data.codeInclusiveAdoptionRate === null
                ? "暂无代码生成数据"
                : `${formatNumber(data.codeAdoptedLines)} / ${formatNumber(data.codeInclusiveEffectiveGeneratedLines)} 行`
            }
            color="bg-cyan-500"
            tooltipContent={<InclusiveAdoptionTooltip data={data} />}
          />
        </div>
        <CodeAdoptionFunnel
          data={{
            inclusiveEffectiveGeneratedLines: data.codeInclusiveEffectiveGeneratedLines,
            effectiveGeneratedLines: data.codeEffectiveGeneratedLines,
            pushedEffectiveGeneratedLines: data.codePushedEffectiveGeneratedLines,
            adoptedLines: data.codeAdoptedLines,
            pushedAdoptedLines: data.codePushedAdoptedLines,
            inclusiveAdoptionRate: data.codeInclusiveAdoptionRate,
            measuredAdoptionRate: data.codeMeasuredAdoptionRate,
            pushedAdoptionRate: data.codePushedAdoptionRate
          }}
        />
      </div>

      {/* Skill & Tool Top rankings */}
      <div className="grid grid-cols-2 gap-3">
        <SkillRankingPanel
          bySkill={data.bySkill}
          bySkillAll={data.bySkillAll}
          totalSkills={data.totalSkills}
          totalSkillCalls={data.totalSkillCalls}
          bySkillAdoption={data.bySkillAdoption}
          onSkillClick={onSkillClick}
          marketSkillKeys={marketSkillKeys}
          pluginSkillKeys={pluginSkillKeys}
        />
        <ToolRankingPanel
          byTool={data.byTool}
          byToolAll={data.byToolAll}
          byToolFilteredAll={data.byToolFilteredAll}
          byToolAllFull={data.byToolAllFull}
          totalTools={data.totalTools}
          totalToolCalls={data.totalToolCalls}
        />
      </div>

      {/* Trend chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">调用量趋势</h3>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              yAxisId="calls"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="users"
              orientation="right"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
              allowDecimals={false}
            />
            <RechartsTooltip
              formatter={(value, name) => [
                Number(value ?? 0).toLocaleString("zh-CN"),
                String(name)
              ]}
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              yAxisId="users"
              dataKey="users"
              name="活跃用户"
              fill="#8b5cf6"
              fillOpacity={0.75}
              barSize={18}
              radius={[4, 4, 0, 0]}
            />
            <Line
              yAxisId="calls"
              type="monotone"
              dataKey="count"
              name="调用次数"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
