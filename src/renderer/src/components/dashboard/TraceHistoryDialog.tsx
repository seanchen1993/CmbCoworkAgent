import { useMemo, useState, type ReactNode } from "react"
import {
  Activity,
  AlertCircle,
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Coins,
  Download,
  Gauge,
  Hash,
  Info,
  Loader2,
  MessageSquare,
  Terminal,
  Timer,
  Wrench
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { TraceConversation, TraceThreadConversation, buildTraceConversation } from "@/components/trace/TraceConversation"
import type { DashboardCodeStats, DashboardTraceDetail, DashboardTraceNode, DashboardTraceViewMode } from "./use-dashboard"

const EMPTY_NODES: DashboardTraceNode[] = []

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return String(tokens)
}

function fmtLines(lines: number): string {
  if (lines >= 1_000_000) return `${(lines / 1_000_000).toFixed(1)}M`
  if (lines >= 1_000) return `${(lines / 1_000).toFixed(1)}K`
  return String(Math.round(lines))
}

function fmtPercent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toFixed(2)}%`
}

function fmtExactLines(lines: number): string {
  return Math.round(lines).toLocaleString("zh-CN")
}

function GeneratedLinesTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">代码生成行数说明</div>
      <div className="text-muted-foreground">当前按 agent 写入或编辑的非空行统计。</div>
      <div className="text-muted-foreground">空行和仅包含空白字符的行不会计入。</div>
      <div className="text-muted-foreground">该指标表示原始生成量，包含后续被 agent 自己改写的中间稿。</div>
    </div>
  )
}

function SkillAttributionTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">Skill 归因说明</div>
      <div className="text-muted-foreground">代码生成优先归因到当前 run 实际命中的 Skill。</div>
      <div className="text-muted-foreground">若当前 run 尚未命中 Skill，会回看最近 2 轮会话中的 Skill 共同归因。</div>
      <div className="text-muted-foreground">若当前 run 已命中 Skill，还会补入上一轮会话中的 Skill 一并归因。</div>
    </div>
  )
}

function InfoHint({ content }: { content: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-label="查看说明"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || "-"
  return date.toLocaleString()
}

function SkillCodeStat({
  icon: Icon,
  label,
  value,
  sub,
  tooltipContent
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  tooltipContent?: React.ReactNode
}): React.JSX.Element {
  const card = (
    <div
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 ${tooltipContent ? "cursor-help" : ""}`}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p className="truncate text-[12px] font-semibold">{value}</p>
        {sub && <p className="truncate text-[10px] text-muted-foreground/70">{sub}</p>}
      </div>
    </div>
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

function InclusiveAdoptionTooltip({ stats }: { stats: DashboardCodeStats }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">含未提交采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.adoptedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.effectiveGeneratedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">未提交生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.unmeasuredGeneratedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">含未提交分母</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.inclusiveEffectiveGeneratedLines)} 行</span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / (已测量有效生成行数 + 未提交生成行数)。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
      </div>
    </div>
  )
}

function MeasuredAdoptionTooltip({ stats }: { stats: DashboardCodeStats }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">已Commit采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.adoptedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.effectiveGeneratedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量原始生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.measuredGeneratedLines)} 行</span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / 已测量有效生成行数。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
      </div>
    </div>
  )
}

function PushedAdoptionTooltip({ stats }: { stats: DashboardCodeStats }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">已 Push 采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 采纳行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.pushedAdoptedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 有效生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.pushedEffectiveGeneratedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 原始生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.pushedMeasuredGeneratedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push Commit 数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.pushedCommitCount)} 次</span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 已 Push 采纳行数 / 已 Push 有效生成行数。</div>
        <div>仅统计通过应用成功 Push 后的 commit。</div>
      </div>
    </div>
  )
}

function SkillCodeStatsBar({ stats }: { stats: DashboardCodeStats | null }): React.JSX.Element {
  if (!stats) {
    return (
      <section className="shrink-0 border-b border-border bg-background px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold text-foreground">代码指标</h3>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>按当前 Skill 归因</span>
              <InfoHint content={<SkillAttributionTooltip />} />
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
          暂无代码采纳数据
        </div>
      </section>
    )
  }
  return (
    <section className="shrink-0 border-b border-border bg-background px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-foreground">代码指标</h3>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>按当前 Skill 归因</span>
            <InfoHint content={<SkillAttributionTooltip />} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-3">
        <SkillCodeStat
          icon={Code2}
          label="生成行数"
          value={fmtLines(stats.generatedLines)}
          tooltipContent={<GeneratedLinesTooltip />}
        />
        <SkillCodeStat
          icon={CheckCircle2}
          label="采纳行数"
          value={fmtLines(stats.adoptedLines)}
        />
        <SkillCodeStat
          icon={Gauge}
          label="含未提交采纳率"
          value={fmtPercent(stats.inclusiveAdoptionRate)}
          sub={
            stats.inclusiveAdoptionRate === null
              ? "暂无代码生成数据"
              : `${fmtLines(stats.adoptedLines)} / ${fmtLines(stats.inclusiveEffectiveGeneratedLines)} 行`
          }
          tooltipContent={<InclusiveAdoptionTooltip stats={stats} />}
        />
        <SkillCodeStat
          icon={Gauge}
          label="已Commit采纳率"
          value={fmtPercent(stats.measuredAdoptionRate)}
          sub={
            stats.measuredAdoptionRate === null
              ? "暂无测量数据"
              : `${fmtLines(stats.adoptedLines)} / ${fmtLines(stats.effectiveGeneratedLines)} 行`
          }
          tooltipContent={<MeasuredAdoptionTooltip stats={stats} />}
        />
        <SkillCodeStat
          icon={Gauge}
          label="已 Push 采纳率"
          value={fmtPercent(stats.pushedAdoptionRate)}
          sub={
            stats.pushedAdoptionRate === null
              ? "暂无已 Push 数据"
              : `${fmtLines(stats.pushedAdoptedLines)} / ${fmtLines(stats.pushedEffectiveGeneratedLines)} 行`
          }
          tooltipContent={<PushedAdoptionTooltip stats={stats} />}
        />
      </div>
    </section>
  )
}

function outcomeLabel(outcome: string): string {
  if (outcome === "success") return "成功"
  if (outcome === "error") return "错误"
  if (outcome === "cancelled") return "取消"
  return outcome || "未知"
}

function outcomeClass(outcome: string): string {
  if (outcome === "success") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
  if (outcome === "error") return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
  return "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/20"
}

function nodeIcon(node: DashboardTraceNode): React.JSX.Element {
  if (node.type === "trace") return <Activity className="size-3.5" />
  if (node.type === "llm") return <Bot className="size-3.5" />
  if (node.type === "tool") return <Wrench className="size-3.5" />
  if (node.type === "tool_result") return <Terminal className="size-3.5" />
  if (node.type === "error") return <AlertCircle className="size-3.5" />
  if (node.type === "cancel") return <Ban className="size-3.5" />
  return <MessageSquare className="size-3.5" />
}

function nodeStatusClass(status?: DashboardTraceNode["status"]): string {
  if (status === "success") return "text-emerald-600"
  if (status === "error") return "text-red-500"
  if (status === "running") return "text-blue-500"
  if (status === "cancelled") return "text-zinc-500"
  return "text-muted-foreground"
}

function JsonBlock({ value }: { value: unknown }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  let text = ""
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }

  if (text.length <= 220) {
    return <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/70">{text}</pre>
  }

  return (
    <div className="space-y-1">
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/70">
        {expanded ? text : `${text.slice(0, 220)}...`}
      </pre>
      <button
        type="button"
        className="text-[10px] text-blue-500 hover:underline"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "收起" : "展开"}
      </button>
    </div>
  )
}

function TraceTreeNode({
  node,
  childrenByParent,
  depth
}: {
  node: DashboardTraceNode
  childrenByParent: Map<string, DashboardTraceNode[]>
  depth: number
}): React.JSX.Element {
  const children = childrenByParent.get(node.id) ?? []
  const hasDetail = node.input !== undefined || node.output !== undefined || node.metadata !== undefined || children.length > 0
  const [open, setOpen] = useState(depth <= 1)

  return (
    <div style={{ marginLeft: `${depth * 14}px` }}>
      <div className="mb-2 overflow-hidden rounded-md border border-border bg-card/70">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30 disabled:hover:bg-transparent"
          disabled={!hasDetail}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={cn("shrink-0", nodeStatusClass(node.status))}>{nodeIcon(node)}</span>
          <span className="truncate text-[12px] font-medium text-foreground/85">
            {node.name || node.type}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">
            {new Date(node.startedAt).toLocaleTimeString()}
          </span>
          {node.status && (
            <Badge variant="outline" className="ml-auto text-[10px]">
              {node.status}
            </Badge>
          )}
          {hasDetail && (open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          ))}
        </button>

        {open && hasDetail && (
          <div className="space-y-2 border-t border-border/60 bg-background/60 px-3 py-2">
            {node.input !== undefined && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Input</p>
                <JsonBlock value={node.input} />
              </div>
            )}
            {node.output !== undefined && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Output</p>
                <JsonBlock value={node.output} />
              </div>
            )}
            {node.metadata && Object.keys(node.metadata).length > 0 && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Metadata</p>
                <JsonBlock value={node.metadata} />
              </div>
            )}
          </div>
        )}
      </div>

      {open && children.map((child) => (
        <TraceTreeNode key={child.id} node={child} childrenByParent={childrenByParent} depth={depth + 1} />
      ))}
    </div>
  )
}

function TraceCard({
  trace,
  selected,
  onClick
}: {
  trace: DashboardTraceDetail
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const conversation = buildTraceConversation(trace)
  return (
    <button
      type="button"
      className={cn(
        "w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/30",
        selected ? "border-primary shadow-sm" : "border-border"
      )}
      onClick={onClick}
    >
      <div className="mb-2 flex items-center gap-2">
        <Badge className={cn("border px-1.5 py-0 text-[10px]", outcomeClass(trace.outcome))}>
          {outcomeLabel(trace.outcome)}
        </Badge>
        <span className="truncate text-[10px] font-mono text-muted-foreground/60">{trace.traceId.slice(0, 10)}</span>
      </div>
      <p className="line-clamp-3 text-xs leading-5 text-foreground/80">{trace.userMessage || "无用户输入记录"}</p>
      {conversation.assistantText && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          答：{conversation.assistantText}
        </p>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
        <span>{formatTime(trace.startedAt)}</span>
        <span className="inline-flex items-center gap-0.5"><Timer className="size-3" />{fmtDuration(trace.durationMs)}</span>
        <span className="inline-flex items-center gap-0.5"><Wrench className="size-3" />{trace.totalToolCalls}</span>
        {trace.totalTokens > 0 && (
          <span className="inline-flex items-center gap-1">
            <Coins className="size-3" />
            <span>↑{fmtTokens(trace.totalInputTokens)}</span>
            <span className="text-muted-foreground/30">/</span>
            <span>↓{fmtTokens(trace.totalOutputTokens)}</span>
          </span>
        )}
      </p>
    </button>
  )
}

interface TraceThreadGroup {
  threadId: string
  traces: DashboardTraceDetail[]
  latestStartedAt: string
  successCount: number
  errorCount: number
  totalToolCalls: number
  totalDurationMs: number
  totalTokens: number
}

function buildTraceThreadGroups(traces: DashboardTraceDetail[]): TraceThreadGroup[] {
  const grouped = new Map<string, DashboardTraceDetail[]>()
  for (const trace of traces) {
    const threadId = trace.threadId || "unknown-thread"
    const list = grouped.get(threadId) ?? []
    list.push(trace)
    grouped.set(threadId, list)
  }

  return Array.from(grouped.entries())
    .map(([threadId, threadTraces]) => {
      const sorted = [...threadTraces].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return {
        threadId,
        traces: sorted,
        latestStartedAt: sorted[0]?.startedAt ?? "",
        successCount: sorted.filter((trace) => trace.outcome === "success").length,
        errorCount: sorted.filter((trace) => trace.outcome === "error").length,
        totalToolCalls: sorted.reduce((sum, trace) => sum + trace.totalToolCalls, 0),
        totalDurationMs: sorted.reduce((sum, trace) => sum + trace.durationMs, 0),
        totalTokens: sorted.reduce((sum, trace) => sum + trace.totalTokens, 0)
      }
    })
    .sort((a, b) => b.latestStartedAt.localeCompare(a.latestStartedAt))
}

function TraceThreadGroupCard({
  group,
  selectedTraceId,
  onSelectTrace
}: {
  group: TraceThreadGroup
  selectedTraceId: string | null
  onSelectTrace: (traceId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const selectedInGroup = group.traces.some((trace) => trace.traceId === selectedTraceId)

  return (
    <div className={cn(
      "overflow-hidden rounded-lg border bg-card",
      selectedInGroup ? "border-primary/50" : "border-border"
    )}>
      <button
        type="button"
        className="flex w-full items-start gap-2 border-b border-border/70 bg-muted/10 px-3 py-2 text-left transition-colors hover:bg-muted/20"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] font-semibold text-foreground">
              Thread {group.threadId.slice(0, 10)}
            </span>
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {group.traces.length} 条
            </Badge>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/60">
            <span>{formatTime(group.latestStartedAt)}</span>
            <span className="inline-flex items-center gap-0.5"><Wrench className="size-3" />{group.totalToolCalls}</span>
            {group.totalTokens > 0 && (
              <span className="inline-flex items-center gap-0.5"><Coins className="size-3" />{fmtTokens(group.totalTokens)}</span>
            )}
            <span className="text-emerald-600">成功 {group.successCount}</span>
            {group.errorCount > 0 && <span className="text-red-500">错误 {group.errorCount}</span>}
          </p>
        </div>
      </button>

      {open && (
        <div className="space-y-2 p-2">
          {group.traces.map((trace) => (
            <TraceCard
              key={trace.traceId}
              trace={trace}
              selected={selectedTraceId === trace.traceId}
              onClick={() => onSelectTrace(trace.traceId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TraceViewModeToggle({
  value,
  onChange
}: {
  value: DashboardTraceViewMode
  onChange: (mode: DashboardTraceViewMode) => void
}): React.JSX.Element {
  return (
    <div className="flex overflow-hidden rounded-md border border-border bg-background">
      {([
        ["thread", "Thread"],
        ["trace", "Trace"]
      ] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          className={cn(
            "h-7 px-2.5 text-[11px] font-medium transition-colors",
            value === mode
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          onClick={() => onChange(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function TraceExplorer({
  traces,
  codeStats = null,
  loading = false,
  error = null,
  title = "最近 10 条 Trace 记录",
  subtitle = "选择记录查看完整执行树",
  headerRight = null,
  emptyText = "当前时间范围内没有会话历史",
  showCodeStats = true,
  viewMode,
  defaultViewMode = "thread",
  onViewModeChange,
  showViewModeToggle = true,
  className
}: {
  traces: DashboardTraceDetail[]
  codeStats?: DashboardCodeStats | null
  loading?: boolean
  error?: string | null
  title?: string
  subtitle?: string
  headerRight?: ReactNode
  emptyText?: string
  showCodeStats?: boolean
  viewMode?: DashboardTraceViewMode
  defaultViewMode?: DashboardTraceViewMode
  onViewModeChange?: (mode: DashboardTraceViewMode) => void
  showViewModeToggle?: boolean
  className?: string
}): React.JSX.Element {
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [localViewMode, setLocalViewMode] = useState<DashboardTraceViewMode>(defaultViewMode)
  const activeViewMode = viewMode ?? localViewMode
  const handleViewModeChange = (mode: DashboardTraceViewMode): void => {
    if (!viewMode) setLocalViewMode(mode)
    onViewModeChange?.(mode)
  }

  const selectedTrace = traces.find((trace) => trace.traceId === selectedTraceId) ?? traces[0] ?? null
  const traceGroups = useMemo(() => buildTraceThreadGroups(traces), [traces])
  const selectedThreadGroup = useMemo(() => {
    if (!selectedTrace) return traceGroups[0] ?? null
    return traceGroups.find((group) =>
      group.traces.some((trace) => trace.traceId === selectedTrace.traceId)
    ) ?? traceGroups[0] ?? null
  }, [selectedTrace, traceGroups])
  const metricMode = activeViewMode === "thread" && selectedThreadGroup ? "thread" : "trace"
  const metricStartedAt =
    metricMode === "thread" ? selectedThreadGroup?.latestStartedAt : selectedTrace?.startedAt
  const metricToolCalls =
    metricMode === "thread" ? selectedThreadGroup?.totalToolCalls ?? 0 : selectedTrace?.totalToolCalls ?? 0
  const metricDurationMs =
    metricMode === "thread" ? selectedThreadGroup?.totalDurationMs ?? 0 : selectedTrace?.durationMs ?? 0
  const metricTokens =
    metricMode === "thread" ? selectedThreadGroup?.totalTokens ?? 0 : selectedTrace?.totalTokens ?? 0
  const nodes = selectedTrace?.nodes ?? EMPTY_NODES
  const root = nodes.find((node) => node.parentId === null) ?? nodes[0]
  const childrenByParent = useMemo(() => {
    const map = new Map<string, DashboardTraceNode[]>()
    for (const node of nodes) {
      if (!node.parentId) continue
      const list = map.get(node.parentId) ?? []
      list.push(node)
      map.set(node.parentId, list)
    }
    return map
  }, [nodes])

  if (loading) {
    return (
      <div className={cn("flex min-h-[360px] flex-1 items-center justify-center", className)}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn("flex min-h-[360px] flex-1 items-center justify-center px-6 text-sm text-destructive", className)}>
        {error}
      </div>
    )
  }

  if (traces.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        {showCodeStats && <SkillCodeStatsBar stats={codeStats} />}
        <section className="flex min-h-0 flex-1 flex-col bg-background">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div>
              <h3 className="text-xs font-semibold text-foreground">{title}</h3>
              <p className="text-[10px] text-muted-foreground">{subtitle}</p>
            </div>
            <div className="flex items-center gap-2">
              {showViewModeToggle && (
                <TraceViewModeToggle value={activeViewMode} onChange={handleViewModeChange} />
              )}
              {headerRight}
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
            {emptyText}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {showCodeStats && <SkillCodeStatsBar stats={codeStats} />}
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div>
            <h3 className="text-xs font-semibold text-foreground">{title}</h3>
            <p className="text-[10px] text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            {showViewModeToggle && (
              <TraceViewModeToggle value={activeViewMode} onChange={handleViewModeChange} />
            )}
            {headerRight}
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border">
            <ScrollArea className="h-full">
              <div className="space-y-2 p-3">
                {activeViewMode === "thread"
                  ? traceGroups.map((group) => (
                    <TraceThreadGroupCard
                      key={group.threadId}
                      group={group}
                      selectedTraceId={selectedTrace?.traceId ?? null}
                      onSelectTrace={setSelectedTraceId}
                    />
                  ))
                  : traces.map((trace) => (
                    <TraceCard
                      key={trace.traceId}
                      trace={trace}
                      selected={selectedTrace?.traceId === trace.traceId}
                      onClick={() => setSelectedTraceId(trace.traceId)}
                    />
                  ))}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col">
            {selectedTrace && (
              <div className="grid shrink-0 grid-cols-4 border-b border-border">
                <div className="flex items-center gap-2 border-r border-border px-4 py-2.5">
                  <Clock className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground">{metricMode === "thread" ? "最近时间" : "时间"}</p>
                    <p className="truncate text-[12px] font-semibold">{formatTime(metricStartedAt ?? "")}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 border-r border-border px-4 py-2.5">
                  <Hash className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground">工具调用</p>
                    <p className="truncate text-[12px] font-semibold">{metricToolCalls}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 border-r border-border px-4 py-2.5">
                  <Timer className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground">{metricMode === "thread" ? "总耗时" : "耗时"}</p>
                    <p className="truncate text-[12px] font-semibold">{fmtDuration(metricDurationMs)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-4 py-2.5">
                  <Coins className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground">Token</p>
                    <p className="truncate text-[12px] font-semibold">{fmtTokens(metricTokens)}</p>
                  </div>
                </div>
              </div>
            )}

            <ScrollArea className="min-h-0 flex-1">
              <div className="p-4">
                {selectedTrace && !selectedTrace.rawAvailable && (
                  <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {selectedTrace.rawError || "该 trace 缺少完整 raw 内容，无法展示完整执行树"}
                  </div>
                )}
                {root ? (
                  <div className="space-y-4">
                    {activeViewMode === "thread" && selectedThreadGroup ? (
                      <TraceThreadConversation traces={selectedThreadGroup.traces} />
                    ) : (
                      <TraceConversation trace={selectedTrace} />
                    )}
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold text-foreground">执行树</p>
                        <p className="text-[10px] text-muted-foreground">
                          当前选中 trace 的工具、模型调用与原始结构
                        </p>
                      </div>
                      <TraceTreeNode node={root} childrenByParent={childrenByParent} depth={0} />
                    </div>
                  </div>
                ) : selectedTrace ? (
                  <div className="space-y-4">
                    {activeViewMode === "thread" && selectedThreadGroup ? (
                      <TraceThreadConversation traces={selectedThreadGroup.traces} />
                    ) : (
                      <TraceConversation trace={selectedTrace} />
                    )}
                    <div className="rounded-md border border-border bg-card p-4">
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">Trace Summary</p>
                      <JsonBlock value={selectedTrace} />
                    </div>
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </div>
      </section>
    </div>
  )
}

export function TraceHistoryDialog({
  open,
  onOpenChange,
  skill,
  traces,
  codeStats,
  tracePage = 1,
  tracePageSize = 10,
  totalTraces = traces.length,
  traceViewMode = "thread",
  onTraceViewModeChange,
  onTracePrevious,
  onTraceNext,
  onExportPage,
  exporting = false,
  loading,
  error
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: string | null
  traces: DashboardTraceDetail[]
  codeStats: DashboardCodeStats | null
  tracePage?: number
  tracePageSize?: number
  totalTraces?: number
  traceViewMode?: DashboardTraceViewMode
  onTraceViewModeChange?: (mode: DashboardTraceViewMode) => void
  onTracePrevious?: () => void
  onTraceNext?: () => void
  onExportPage?: () => void
  exporting?: boolean
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const displayTotalTraces = Math.max(totalTraces, traces.length)
  const canPrevious = tracePage > 1 && !loading
  const canNext = tracePage * tracePageSize < displayTotalTraces && !loading
  const totalLabel = traceViewMode === "thread" ? "个 Thread" : "条 Trace"
  const titleLabel = traceViewMode === "thread" ? "Thread 记录" : "Trace 记录"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base">Skill 会话历史 · {skill ?? "-"}</DialogTitle>
        </DialogHeader>
        <TraceExplorer
          traces={traces}
          codeStats={codeStats}
          loading={loading}
          error={error}
          title={`${titleLabel}（第 ${tracePage} 页）`}
          subtitle={`共 ${displayTotalTraces.toLocaleString("zh-CN")} ${totalLabel}，选择记录查看对话还原与执行树`}
          viewMode={traceViewMode}
          onViewModeChange={onTraceViewModeChange}
          headerRight={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={onExportPage}
                disabled={exporting || loading || traces.length === 0}
              >
                {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                导出本页
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onTracePrevious}
                disabled={!canPrevious}
              >
                上一页
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={onTraceNext}
                disabled={!canNext}
              >
                下一页
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          }
          emptyText="当前时间范围内没有该 Skill 的会话历史"
        />
      </DialogContent>
    </Dialog>
  )
}
