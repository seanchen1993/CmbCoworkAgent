import { useMemo, useState } from "react"
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
  Gauge,
  Hash,
  Loader2,
  MessageSquare,
  Terminal,
  Timer,
  Wrench
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { DashboardCodeStats, DashboardTraceDetail, DashboardTraceNode } from "./use-dashboard"

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

function AdoptionDetailTooltip({ stats }: { stats: DashboardCodeStats }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">代码行数明细</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.adoptedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">生成行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.generatedLines)} 行</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">删除行数</span>
          <span className="font-medium text-foreground">{fmtExactLines(stats.deletedLines)} 行</span>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground">采纳率按 采纳行数 / 生成行数 计算</div>
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
            <p className="text-[10px] text-muted-foreground">按当前 Skill 归因</p>
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
          <p className="text-[10px] text-muted-foreground">按当前 Skill 归因</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <SkillCodeStat
          icon={Code2}
          label="生成行数"
          value={fmtLines(stats.generatedLines)}
        />
        <SkillCodeStat
          icon={CheckCircle2}
          label="采纳行数"
          value={fmtLines(stats.adoptedLines)}
        />
        <SkillCodeStat
          icon={Gauge}
          label="采纳率"
          value={fmtPercent(stats.adoptionRate)}
          sub={
            stats.adoptionRate === null
              ? "暂无代码生成数据"
              : `${fmtLines(stats.adoptedLines)} / ${fmtLines(stats.generatedLines)} 行`
          }
          tooltipContent={<AdoptionDetailTooltip stats={stats} />}
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

export function TraceHistoryDialog({
  open,
  onOpenChange,
  skill,
  traces,
  codeStats,
  loading,
  error
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: string | null
  traces: DashboardTraceDetail[]
  codeStats: DashboardCodeStats | null
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  const selectedTrace = traces.find((trace) => trace.traceId === selectedTraceId) ?? traces[0] ?? null
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base">Skill 会话历史 · {skill ?? "-"}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        ) : traces.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <SkillCodeStatsBar stats={codeStats} />
            <section className="flex min-h-0 flex-1 flex-col bg-background">
              <div className="shrink-0 border-b border-border px-5 py-3">
                <h3 className="text-xs font-semibold text-foreground">最近 3 次 Trace 记录</h3>
                <p className="text-[10px] text-muted-foreground">选择记录查看完整执行树</p>
              </div>
              <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                当前时间范围内没有该 Skill 的会话历史
              </div>
            </section>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <SkillCodeStatsBar stats={codeStats} />
            <section className="flex min-h-0 flex-1 flex-col bg-background">
              <div className="shrink-0 border-b border-border px-5 py-3">
                <h3 className="text-xs font-semibold text-foreground">最近 3 次 Trace 记录</h3>
                <p className="text-[10px] text-muted-foreground">选择记录查看完整执行树</p>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
                <div className="min-h-0 border-r border-border">
                  <ScrollArea className="h-full">
                    <div className="space-y-2 p-3">
                      {traces.map((trace) => (
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
                          <p className="text-[10px] text-muted-foreground">时间</p>
                          <p className="truncate text-[12px] font-semibold">{formatTime(selectedTrace.startedAt)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 border-r border-border px-4 py-2.5">
                        <Hash className="size-3.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-[10px] text-muted-foreground">工具调用</p>
                          <p className="truncate text-[12px] font-semibold">{selectedTrace.totalToolCalls}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 border-r border-border px-4 py-2.5">
                        <Timer className="size-3.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-[10px] text-muted-foreground">耗时</p>
                          <p className="truncate text-[12px] font-semibold">{fmtDuration(selectedTrace.durationMs)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 px-4 py-2.5">
                        <Coins className="size-3.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-[10px] text-muted-foreground">Token</p>
                          <p className="truncate text-[12px] font-semibold">{fmtTokens(selectedTrace.totalTokens)}</p>
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
                        <TraceTreeNode node={root} childrenByParent={childrenByParent} depth={0} />
                      ) : selectedTrace ? (
                        <div className="rounded-md border border-border bg-card p-4">
                          <p className="mb-2 text-xs font-semibold text-muted-foreground">Trace Summary</p>
                          <JsonBlock value={selectedTrace} />
                        </div>
                      ) : null}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
