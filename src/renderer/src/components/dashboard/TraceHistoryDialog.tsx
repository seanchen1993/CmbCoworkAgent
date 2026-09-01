import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  Coins,
  Cpu,
  Download,
  Gauge,
  Hash,
  Info,
  Loader2,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  Tag,
  Timer,
  Wrench
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  TraceConversation,
  TraceThreadConversation,
  buildTraceConversation
} from "@/components/trace/TraceConversation"
import type {
  DashboardCodeStats,
  DashboardTraceDetail,
  DashboardTraceTriggerScope,
  DashboardTraceViewMode
} from "./use-dashboard"

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
      <div className="text-muted-foreground">
        标准 test 路径或 test 命名文件会单独上报，不计入采纳率。
      </div>
      <div className="text-muted-foreground">
        该指标表示原始生成量，包含后续被 agent 自己改写的中间稿。
      </div>
    </div>
  )
}

function SkillAttributionTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">Skill 归因说明</div>
      <div className="text-muted-foreground">代码生成优先归因到当前 run 实际命中的 Skill。</div>
      <div className="text-muted-foreground">
        若当前 run 尚未命中 Skill，会回看最近 2 轮会话中的 Skill 共同归因。
      </div>
      <div className="text-muted-foreground">
        若当前 run 已命中 Skill，还会补入上一轮会话中的 Skill 一并归因。
      </div>
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
      <div className="text-[11px] font-medium text-foreground">
        总量提交采纳率（相对全部有效生成）
      </div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.adoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.effectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">未提交生成行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.unmeasuredGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">含未提交分母</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.inclusiveEffectiveGeneratedLines)} 行
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

function MeasuredAdoptionTooltip({ stats }: { stats: DashboardCodeStats }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">提交采纳率（已 Commit 采纳率）</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.adoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.effectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量原始生成行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.measuredGeneratedLines)} 行
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

function PushedAdoptionTooltip({ stats }: { stats: DashboardCodeStats }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">入库采纳率（已 Push 采纳率）</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 采纳行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.pushedAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 有效生成行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.pushedEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 原始生成行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.pushedMeasuredGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push Commit 数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.pushedCommitCount)} 次
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

function InclusivePushedAdoptionTooltip({
  stats
}: {
  stats: DashboardCodeStats
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">
        总量入库采纳率（已 Push 真实入库率）
      </div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 采纳行数</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.pushedAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">含未提交分母</span>
          <span className="font-medium text-foreground">
            {fmtExactLines(stats.inclusiveEffectiveGeneratedLines)} 行
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 已 Push 采纳行数 / (已测量有效生成行数 + 未提交生成行数)。</div>
        <div>Agent 有效产出中最终真实推送入库的比例，分母含未提交，口径最严。</div>
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
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        <SkillCodeStat
          icon={Code2}
          label="生成行数"
          value={fmtLines(stats.generatedLines)}
          tooltipContent={<GeneratedLinesTooltip />}
        />
        <SkillCodeStat icon={CheckCircle2} label="采纳行数" value={fmtLines(stats.adoptedLines)} />
        <SkillCodeStat
          icon={Gauge}
          label="总量入库采纳率"
          value={fmtPercent(stats.inclusivePushedAdoptionRate)}
          sub={
            stats.inclusivePushedAdoptionRate === null
              ? "暂无已 Push 数据"
              : `${fmtLines(stats.pushedAdoptedLines)} / ${fmtLines(stats.inclusiveEffectiveGeneratedLines)} 行`
          }
          tooltipContent={<InclusivePushedAdoptionTooltip stats={stats} />}
        />
        <SkillCodeStat
          icon={Gauge}
          label="总量提交采纳率"
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
          label="入库采纳率"
          value={fmtPercent(stats.pushedAdoptionRate)}
          sub={
            stats.pushedAdoptionRate === null
              ? "暂无已 Push 数据"
              : `${fmtLines(stats.pushedAdoptedLines)} / ${fmtLines(stats.pushedEffectiveGeneratedLines)} 行`
          }
          tooltipContent={<PushedAdoptionTooltip stats={stats} />}
        />
        <SkillCodeStat
          icon={Gauge}
          label="提交采纳率"
          value={fmtPercent(stats.measuredAdoptionRate)}
          sub={
            stats.measuredAdoptionRate === null
              ? "暂无测量数据"
              : `${fmtLines(stats.adoptedLines)} / ${fmtLines(stats.effectiveGeneratedLines)} 行`
          }
          tooltipContent={<MeasuredAdoptionTooltip stats={stats} />}
        />
      </div>
    </section>
  )
}

function outcomeLabel(outcome: string): string {
  if (outcome === "success") return "成功"
  if (outcome === "error") return "错误"
  if (outcome === "cancelled") return "取消"
  if (outcome === "unknown") return "未定"
  return outcome || "未知"
}

function outcomeClass(outcome: string): string {
  if (outcome === "success")
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
  if (outcome === "error") return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
  if (outcome === "unknown")
    return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
  return "border-border bg-muted text-muted-foreground"
}

function shortTraceId(value?: string): string {
  return value ? value.slice(0, 10) : ""
}

function isSubagentTrace(trace: DashboardTraceDetail): boolean {
  return trace.traceKind === "subagent" || Boolean(trace.parentTraceId || trace.subagentKind)
}

function traceThreadGroupKey(trace: DashboardTraceDetail): string {
  return trace.rootThreadId || trace.threadId || "unknown-thread"
}

function traceDisplayLabel(trace: DashboardTraceDetail): string {
  if (trace.subagentKind === "coordinator_worker") {
    const role = trace.coordinatorWorkerRole === "verifier" ? "Verifier" : "Worker"
    return trace.coordinatorWorkerId ? `${role} ${trace.coordinatorWorkerId}` : role
  }
  if (trace.subagentKind === "workflow_agent") {
    return trace.workflowAgentLabel || `Workflow Agent ${trace.workflowAgentIndex ?? ""}`.trim()
  }
  if (trace.subagentKind === "task") return "Task Agent"
  if (trace.traceKind === "subagent") return "子 Agent"
  if (trace.executionMode === "coordinator") return "Agent Team"
  if (trace.executionMode === "workflow") return "Ultra Workflow"
  return "主 Agent"
}

function traceDisplayClass(trace: DashboardTraceDetail): string {
  if (isSubagentTrace(trace)) {
    if (trace.subagentKind === "workflow_agent") {
      return "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300"
    }
    return "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300"
  }
  if (trace.executionMode === "workflow") {
    return "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300"
  }
  if (trace.executionMode === "coordinator") {
    return "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
  }
  return "border-border bg-background text-muted-foreground"
}

function inferredToolCount(trace: DashboardTraceDetail): number {
  if (trace.totalToolCalls > 0) return trace.totalToolCalls
  const metadataToolCount = (trace.nodes ?? []).reduce((count, node) => {
    const names = node.metadata?.toolNames
    return count + (Array.isArray(names) ? names.filter((name) => typeof name === "string").length : 0)
  }, 0)
  return metadataToolCount || trace.totalToolCalls
}

function internalNotificationPreview(kind: "coordinator" | "workflow" | "internal"): string {
  if (kind === "coordinator") return "Agent Team 内部通知触发"
  if (kind === "workflow") return "Ultra Workflow 内部通知触发"
  return "内部通知触发"
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
  const isChild = isSubagentTrace(trace)
  return (
    <button
      type="button"
      className={cn(
        "w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/30",
        selected ? "border-primary shadow-sm" : "border-border",
        isChild && "ml-3 w-[calc(100%-0.75rem)] border-l-4 border-l-blue-400/50"
      )}
      onClick={onClick}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge className={cn("border px-1.5 py-0 text-[10px]", outcomeClass(trace.outcome))}>
          {outcomeLabel(trace.outcome)}
        </Badge>
        <Badge className={cn("border px-1.5 py-0 text-[10px]", traceDisplayClass(trace))}>
          {traceDisplayLabel(trace)}
        </Badge>
        <span className="truncate text-[10px] font-mono text-muted-foreground/60">
          {shortTraceId(trace.traceId)}
        </span>
        {isChild && trace.parentTraceId && (
          <span className="text-[10px] font-mono text-muted-foreground/50">
            parent {shortTraceId(trace.parentTraceId)}
          </span>
        )}
      </div>
      <p className="line-clamp-3 text-xs leading-5 text-foreground/80">
        {conversation.userText ||
          (conversation.internalNotificationKind
            ? internalNotificationPreview(conversation.internalNotificationKind)
            : "无用户输入记录")}
      </p>
      {conversation.assistantText && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          答：{conversation.assistantText}
        </p>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
        <span>{formatTime(trace.startedAt)}</span>
        <span className="inline-flex items-center gap-0.5">
          <Timer className="size-3" />
          {fmtDuration(trace.durationMs)}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <Wrench className="size-3" />
          {inferredToolCount(trace)}
        </span>
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
  rootTraceId?: string
  traces: DashboardTraceDetail[]
  latestStartedAt: string
  subagentCount: number
  successCount: number
  errorCount: number
  totalToolCalls: number
  totalModelCalls: number
  totalUserInputRequests: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  /** thread 内出现过的 APP 版本（聚合去重，按出现顺序）。 */
  appVersions: string[]
}

function summarizeThreadGroup(
  threadId: string,
  threadTraces: DashboardTraceDetail[]
): TraceThreadGroup {
  // thread 内部按时间升序：第一条卡片即该 thread 的首轮对话，符合自然阅读顺序。
  const sorted = [...threadTraces].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const latestStartedAt = sorted.reduce(
    (latest, trace) => (trace.startedAt > latest ? trace.startedAt : latest),
    sorted[0]?.startedAt ?? ""
  )
  const rootTrace = sorted.find((trace) => !isSubagentTrace(trace)) ?? sorted[0]
  return {
    threadId,
    rootTraceId: rootTrace?.rootTraceId || rootTrace?.traceId,
    traces: sorted,
    latestStartedAt,
    subagentCount: sorted.filter(isSubagentTrace).length,
    successCount: sorted.filter((trace) => trace.outcome === "success").length,
    errorCount: sorted.filter((trace) => trace.outcome === "error").length,
    totalToolCalls: sorted.reduce((sum, trace) => sum + inferredToolCount(trace), 0),
    totalModelCalls: sorted.reduce((sum, trace) => sum + (trace.modelCallCount ?? 0), 0),
    totalUserInputRequests: sorted.reduce(
      (sum, trace) => sum + (trace.userInputRequestCount ?? 0),
      0
    ),
    totalDurationMs: sorted.reduce((sum, trace) => sum + trace.durationMs, 0),
    totalInputTokens: sorted.reduce((sum, trace) => sum + (trace.totalInputTokens ?? 0), 0),
    totalOutputTokens: sorted.reduce((sum, trace) => sum + (trace.totalOutputTokens ?? 0), 0),
    totalTokens: sorted.reduce((sum, trace) => sum + (trace.totalTokens ?? 0), 0),
    appVersions: [
      ...new Set(
        sorted
          .map((trace) => trace.appVersion?.trim())
          .filter((version): version is string => Boolean(version))
      )
    ]
  }
}

function buildTraceThreadGroups(traces: DashboardTraceDetail[]): TraceThreadGroup[] {
  const grouped = new Map<string, DashboardTraceDetail[]>()
  for (const trace of traces) {
    const threadId = traceThreadGroupKey(trace)
    const list = grouped.get(threadId) ?? []
    list.push(trace)
    grouped.set(threadId, list)
  }

  // thread 列表本身按最近活跃时间降序：最新的会话排在最前。
  return Array.from(grouped.entries())
    .map(([threadId, threadTraces]) => summarizeThreadGroup(threadId, threadTraces))
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

  function handleSelectGroup(): void {
    if (group.traces.length > 0) {
      onSelectTrace(group.traces[0].traceId)
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card",
        selectedInGroup ? "border-primary/50" : "border-border"
      )}
    >
      <div
        role="button"
        tabIndex={0}
        className="flex w-full items-start gap-2 border-b border-border/70 bg-muted/10 px-3 py-2 text-left transition-colors hover:bg-muted/20 cursor-pointer"
        onClick={handleSelectGroup}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleSelectGroup()
        }}
      >
        <button
          type="button"
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          aria-label={open ? "折叠" : "展开"}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[11px] font-semibold text-foreground">
              Root Thread {group.threadId.slice(0, 10)}
            </span>
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {group.traces.length} 条
            </Badge>
            {group.subagentCount > 0 && (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                子 {group.subagentCount}
              </Badge>
            )}
            {group.rootTraceId && (
              <span className="truncate text-[10px] font-mono text-muted-foreground/50">
                root {shortTraceId(group.rootTraceId)}
              </span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/60">
            <span>{formatTime(group.latestStartedAt)}</span>
            <span className="inline-flex items-center gap-0.5">
              <Wrench className="size-3" />
              {group.totalToolCalls}
            </span>
            {group.totalTokens > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Coins className="size-3" />
                {fmtTokens(group.totalTokens)}
              </span>
            )}
            <span className="text-emerald-600">成功 {group.successCount}</span>
            {group.errorCount > 0 && <span className="text-red-500">错误 {group.errorCount}</span>}
          </p>
        </div>
      </div>

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
      {(
        [
          ["thread", "Thread"],
          ["trace", "Trace"]
        ] as const
      ).map(([mode, label]) => (
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

export function TraceTriggerScopeToggle({
  value,
  onChange
}: {
  value: DashboardTraceTriggerScope
  onChange: (scope: DashboardTraceTriggerScope) => void
}): React.JSX.Element {
  return (
    <div className="flex overflow-hidden rounded-md border border-border bg-background">
      {(
        [
          ["active", "主动触发"],
          ["all", "全部"]
        ] as const
      ).map(([scope, label]) => (
        <button
          key={scope}
          type="button"
          className={cn(
            "h-7 px-2.5 text-[11px] font-medium transition-colors",
            value === scope
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          onClick={() => onChange(scope)}
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
  subtitle = "选择记录查看对话还原",
  headerRight = null,
  emptyText = "当前时间范围内没有会话历史",
  showCodeStats = true,
  viewMode,
  defaultViewMode = "thread",
  onViewModeChange,
  showViewModeToggle = true,
  allowFullscreen = true,
  loadThreadTraces,
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
  allowFullscreen?: boolean
  loadThreadTraces?: (threadId: string) => Promise<DashboardTraceDetail[]>
  className?: string
}): React.JSX.Element {
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [localViewMode, setLocalViewMode] = useState<DashboardTraceViewMode>(defaultViewMode)
  const [fullscreen, setFullscreen] = useState(false)
  // 按 threadId 缓存「完整 thread」拉取结果，避免重复请求。
  const [threadTraceCache, setThreadTraceCache] = useState<Record<string, DashboardTraceDetail[]>>(
    {}
  )
  const [threadLoadingId, setThreadLoadingId] = useState<string | null>(null)
  const activeViewMode = viewMode ?? localViewMode
  const handleViewModeChange = (mode: DashboardTraceViewMode): void => {
    if (!viewMode) setLocalViewMode(mode)
    onViewModeChange?.(mode)
  }

  // 默认通过 IPC 拉取单个 thread 的完整 trace（不受时间窗 / skill / 触发方式裁剪）。
  const defaultLoadThreadTraces = useCallback(
    async (threadId: string): Promise<DashboardTraceDetail[]> => {
      const api = window.api?.dashboard
      if (!api || typeof api.threadTraces !== "function") return []
      try {
        const res = await api.threadTraces(threadId)
        return res?.success && Array.isArray(res.data) ? (res.data as DashboardTraceDetail[]) : []
      } catch {
        return []
      }
    },
    []
  )
  const effectiveLoadThreadTraces = loadThreadTraces ?? defaultLoadThreadTraces

  // 概览分组（来自分页接口，每个 thread 仅含预览的若干条 trace）。
  const baseGroups = useMemo(() => buildTraceThreadGroups(traces), [traces])
  // 若某 thread 已拉到完整 trace，则用完整数据重建该分组。
  const traceGroups = useMemo(
    () =>
      baseGroups.map((group) => {
        const full = threadTraceCache[group.threadId]
        return full && full.length > 0 ? summarizeThreadGroup(group.threadId, full) : group
      }),
    [baseGroups, threadTraceCache]
  )

  // 选中 trace 的查找范围同时覆盖概览列表与已加载的完整 thread，
  // 这样点击「完整会话」里新出现的 trace 也能在对话还原中正确定位。
  const tracesById = useMemo(() => {
    const map = new Map<string, DashboardTraceDetail>()
    for (const trace of traces) map.set(trace.traceId, trace)
    for (const list of Object.values(threadTraceCache)) {
      for (const trace of list) map.set(trace.traceId, trace)
    }
    return map
  }, [traces, threadTraceCache])

  const selectedTrace =
    (selectedTraceId ? (tracesById.get(selectedTraceId) ?? null) : null) ?? traces[0] ?? null
  const selectedThreadGroup = useMemo(() => {
    if (!selectedTrace) return traceGroups[0] ?? null
    return (
      traceGroups.find((group) =>
        group.traces.some((trace) => trace.traceId === selectedTrace.traceId)
      ) ??
      traceGroups[0] ??
      null
    )
  }, [selectedTrace, traceGroups])

  // thread 模式下选中某个 thread 时，懒加载其完整 trace 列表。
  const selectedThreadId = selectedThreadGroup?.threadId ?? null
  useEffect(() => {
    if (activeViewMode !== "thread") return
    if (!selectedThreadId || selectedThreadId === "unknown-thread") return
    if (threadTraceCache[selectedThreadId]) return
    let cancelled = false
    setThreadLoadingId(selectedThreadId)
    void effectiveLoadThreadTraces(selectedThreadId)
      .then((full) => {
        if (cancelled) return
        setThreadTraceCache((prev) =>
          prev[selectedThreadId]
            ? prev
            : { ...prev, [selectedThreadId]: Array.isArray(full) ? full : [] }
        )
      })
      .finally(() => {
        if (!cancelled)
          setThreadLoadingId((current) => (current === selectedThreadId ? null : current))
      })
    return () => {
      cancelled = true
    }
  }, [activeViewMode, selectedThreadId, threadTraceCache, effectiveLoadThreadTraces])

  const threadLoading = threadLoadingId !== null && threadLoadingId === selectedThreadId
  const metricMode = activeViewMode === "thread" && selectedThreadGroup ? "thread" : "trace"
  const metricStartedAt =
    metricMode === "thread" ? selectedThreadGroup?.latestStartedAt : selectedTrace?.startedAt
  const metricToolCalls =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalToolCalls ?? 0)
      : (selectedTrace?.totalToolCalls ?? 0)
  const metricModelCalls =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalModelCalls ?? 0)
      : (selectedTrace?.modelCallCount ?? 0)
  const metricUserInputRequests =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalUserInputRequests ?? 0)
      : (selectedTrace?.userInputRequestCount ?? 0)
  const metricDurationMs =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalDurationMs ?? 0)
      : (selectedTrace?.durationMs ?? 0)
  const metricTokens =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalTokens ?? 0)
      : (selectedTrace?.totalTokens ?? 0)
  const metricInputTokens =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalInputTokens ?? 0)
      : (selectedTrace?.totalInputTokens ?? 0)
  const metricOutputTokens =
    metricMode === "thread"
      ? (selectedThreadGroup?.totalOutputTokens ?? 0)
      : (selectedTrace?.totalOutputTokens ?? 0)
  const metricAppVersions =
    metricMode === "thread"
      ? (selectedThreadGroup?.appVersions ?? [])
      : selectedTrace?.appVersion
        ? [selectedTrace.appVersion]
        : []
  const metricAppVersionLabel = metricAppVersions.length > 0 ? metricAppVersions.join("、") : "—"

  const fullscreenToggle = allowFullscreen && !fullscreen && (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => setFullscreen(true)}
      title="全屏查看会话记录"
    >
      <Maximize2 className="size-3.5" />
      全屏
    </Button>
  )

  const wrapFullscreen = (content: React.JSX.Element): React.JSX.Element => {
    if (!fullscreen) return content
    return (
      <Dialog open onOpenChange={(open) => !open && setFullscreen(false)}>
        <DialogContent className="left-0 top-0 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 shadow-none sm:rounded-none [&>button]:hidden">
          <DialogTitle className="sr-only">{title} · 全屏查看</DialogTitle>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="absolute right-4 top-3 z-20 size-8 bg-background shadow-sm"
              onClick={() => setFullscreen(false)}
              title="退出全屏"
              aria-label="退出全屏"
            >
              <Minimize2 className="size-4" />
            </Button>
            {content}
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  if (loading) {
    return wrapFullscreen(
      <div className={cn("flex min-h-[360px] flex-1 items-center justify-center", className)}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return wrapFullscreen(
      <div
        className={cn(
          "flex min-h-[360px] flex-1 items-center justify-center px-6 text-sm text-destructive",
          className
        )}
      >
        {error}
      </div>
    )
  }

  if (traces.length === 0) {
    return wrapFullscreen(
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        {showCodeStats && <SkillCodeStatsBar stats={codeStats} />}
        <section className="flex min-h-0 flex-1 flex-col bg-background">
          <div
            className={cn(
              "flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3",
              fullscreen && "pr-14"
            )}
          >
            <div>
              <h3 className="text-xs font-semibold text-foreground">{title}</h3>
              <p className="text-[10px] text-muted-foreground">{subtitle}</p>
            </div>
            <div className="flex items-center gap-2">
              {showViewModeToggle && (
                <TraceViewModeToggle value={activeViewMode} onChange={handleViewModeChange} />
              )}
              {headerRight}
              {fullscreenToggle}
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center px-6 py-12 text-sm text-muted-foreground">
            {emptyText}
          </div>
        </section>
      </div>
    )
  }

  const conversationContent = (
    <>
      {selectedTrace && !selectedTrace.rawAvailable && (
        <div className="mb-3 shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {selectedTrace.rawError || "该 trace 缺少完整 raw 内容，无法还原完整对话"}
        </div>
      )}
      {selectedTrace ? (
        activeViewMode === "thread" && selectedThreadGroup ? (
          <TraceThreadConversation
            traces={selectedThreadGroup.traces}
            className={fullscreen ? "min-h-0 flex-1" : undefined}
            loading={threadLoading}
            fillAvailableHeight={fullscreen}
            selectedTraceId={selectedTrace.traceId}
          />
        ) : (
          <TraceConversation trace={selectedTrace} />
        )
      ) : null}
    </>
  )

  return wrapFullscreen(
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {showCodeStats && <SkillCodeStatsBar stats={codeStats} />}
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        <div
          className={cn(
            "flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3",
            fullscreen && "pr-14"
          )}
        >
          <div>
            <h3 className="text-xs font-semibold text-foreground">{title}</h3>
            <p className="text-[10px] text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            {showViewModeToggle && (
              <TraceViewModeToggle value={activeViewMode} onChange={handleViewModeChange} />
            )}
            {headerRight}
            {fullscreenToggle}
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
              <div className="flex shrink-0 overflow-x-auto border-b border-border">
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">
                      {metricMode === "thread" ? "最近时间" : "时间"}
                    </p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {formatTime(metricStartedAt ?? "")}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">工具调用</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">{metricToolCalls}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">模型调用</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {metricModelCalls}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <MessageCircleQuestion className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">请求用户输入</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {metricUserInputRequests}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <Timer className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">
                      {metricMode === "thread" ? "总耗时" : "耗时"}
                    </p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {fmtDuration(metricDurationMs)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <Coins className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">Token</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {fmtTokens(metricTokens)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <ArrowUpFromLine className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">输入 Token</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {fmtTokens(metricInputTokens)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
                  <ArrowDownToLine className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">输出 Token</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {fmtTokens(metricOutputTokens)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
                  <Tag className="size-3.5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">APP 版本</p>
                    <p className="whitespace-nowrap text-[12px] font-semibold">
                      {metricAppVersionLabel}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {fullscreen && activeViewMode === "thread" && selectedThreadGroup ? (
              <div className="flex min-h-0 flex-1 flex-col p-4">{conversationContent}</div>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-4">{conversationContent}</div>
              </ScrollArea>
            )}
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
  traceTriggerScope = "active",
  onTraceViewModeChange,
  onTraceTriggerScopeChange,
  onTracePrevious,
  onTraceNext,
  onExportPage,
  exporting = false,
  loading,
  error,
  onPageChange
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
  traceTriggerScope?: DashboardTraceTriggerScope
  onTraceViewModeChange?: (mode: DashboardTraceViewMode) => void
  onTraceTriggerScopeChange?: (scope: DashboardTraceTriggerScope) => void
  onTracePrevious?: () => void
  onTraceNext?: () => void
  onExportPage?: () => void
  exporting?: boolean
  loading: boolean
  error: string | null
  onPageChange?: (page: number) => void
}): React.JSX.Element {
  const displayTotalTraces = Math.max(totalTraces, traces.length)
  const totalPages = Math.max(1, Math.ceil(displayTotalTraces / Math.max(1, tracePageSize)))
  const canPrevious = tracePage > 1 && !loading
  const canNext = tracePage < totalPages && !loading
  const handlePrevious = onTracePrevious ?? (() => onPageChange?.(tracePage - 1))
  const handleNext = onTraceNext ?? (() => onPageChange?.(tracePage + 1))
  const totalLabel = traceViewMode === "thread" ? "个 Thread" : "条 Trace"
  const titleLabel = traceViewMode === "thread" ? "Thread 记录" : "Trace 记录"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">
                Skill 会话历史 · {skill ?? "-"}
              </DialogTitle>
              <p className="mt-1 text-[11px] text-muted-foreground">
                共 {displayTotalTraces.toLocaleString("zh-CN")} 条 · 第 {tracePage} / {totalPages}{" "}
                页
              </p>
            </div>
          </div>
        </DialogHeader>
        <TraceExplorer
          traces={traces}
          codeStats={codeStats}
          loading={loading}
          error={error}
          title={`${titleLabel}（第 ${tracePage} 页）`}
          subtitle={`共 ${displayTotalTraces.toLocaleString("zh-CN")} ${totalLabel}，选择记录定位到对话`}
          viewMode={traceViewMode}
          onViewModeChange={onTraceViewModeChange}
          headerRight={
            <div className="flex items-center gap-2">
              {onTraceTriggerScopeChange && (
                <TraceTriggerScopeToggle
                  value={traceTriggerScope}
                  onChange={onTraceTriggerScopeChange}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={onExportPage}
                disabled={exporting || loading || traces.length === 0}
              >
                {exporting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                导出本页
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePrevious}
                disabled={!canPrevious}
              >
                <ChevronLeft className="size-3.5" />
                上一页
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={handleNext}
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
