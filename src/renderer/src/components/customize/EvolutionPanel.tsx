import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued"
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  Cpu,
  Hash,
  Info,
  Loader2,
  MessageSquare,
  Settings2,
  Sparkles,
  Terminal,
  Timer,
  Trash2,
  Wrench,
  XCircle,
  Ban,
  RotateCcw
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"

interface SkillCandidate {
  candidateId: string
  action: "create" | "patch"
  skillId: string
  name: string
  description: string
  proposedContent: string
  rationale: string
  sourceTraceIds: string[]
  generatedAt: string
  status: "pending" | "approved" | "rejected"
}

interface TraceEntry {
  traceId: string
  threadId: string
  startedAt: string
  durationMs: number
  userMessage: string
  totalToolCalls: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  outcome: string
  usedSkills: string[]
}

interface TraceThreadGroup {
  threadId: string
  threadTitle: string
  traces: TraceEntry[]
  latestStartedAt: string
  totalToolCalls: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  successCount: number
  errorCount: number
}

interface TraceToolCall {
  name: string
  args: Record<string, unknown>
  result?: string
  durationMs?: number
}

interface TraceStep {
  index: number
  startedAt: string
  assistantText: string
  toolCalls: TraceToolCall[]
}

interface TraceNode {
  id: string
  type: "trace" | "llm" | "tool" | "tool_result" | "message" | "error" | "cancel"
  parentId: string | null
  name?: string
  status?: "running" | "success" | "error" | "cancelled" | "unknown"
  startedAt: string
  endedAt?: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

interface TraceDetail extends TraceEntry {
  endedAt: string
  modelId: string
  errorMessage?: string
  steps: TraceStep[]
  nodes?: TraceNode[]
}

type Tab = "candidates" | "traces"

function buildFallbackNodes(detail: TraceDetail): TraceNode[] {
  const rootId = `trace:${detail.traceId}`
  const nodes: TraceNode[] = [
    {
      id: rootId,
      type: "trace",
      parentId: null,
      name: "Agent Trace",
      status: detail.outcome === "error" ? "error" : detail.outcome === "cancelled" ? "cancelled" : "success",
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
      input: { userMessage: detail.userMessage },
      output: {
        outcome: detail.outcome,
        totalToolCalls: detail.totalToolCalls
      }
    },
    {
      id: `user:${detail.traceId}`,
      type: "message",
      parentId: rootId,
      name: "User Message",
      status: "success",
      startedAt: detail.startedAt,
      endedAt: detail.startedAt,
      output: detail.userMessage
    }
  ]

  for (let i = 0; i < detail.steps.length; i++) {
    const step = detail.steps[i]
    const llmId = `llm:${detail.traceId}:${i}`
    nodes.push({
      id: llmId,
      type: "llm",
      parentId: rootId,
      name: `LLM Call #${i + 1}`,
      status: "success",
      startedAt: step.startedAt,
      endedAt: step.startedAt,
      output: step.assistantText
    })

    for (let j = 0; j < step.toolCalls.length; j++) {
      const tool = step.toolCalls[j]
      const toolId = `tool:${detail.traceId}:${i}:${j}`
      nodes.push({
        id: toolId,
        type: "tool",
        parentId: llmId,
        name: tool.name,
        status: "success",
        startedAt: step.startedAt,
        endedAt: step.startedAt,
        input: tool.args
      })
      if (tool.result !== undefined) {
        nodes.push({
          id: `tool_result:${detail.traceId}:${i}:${j}`,
          type: "tool_result",
          parentId: toolId,
          name: `${tool.name} result`,
          status: "success",
          startedAt: step.startedAt,
          endedAt: step.startedAt,
          output: tool.result
        })
      }
    }
  }

  nodes.push({
    id: `terminal:${detail.traceId}`,
    type: detail.outcome === "error" ? "error" : detail.outcome === "cancelled" ? "cancel" : "message",
    parentId: rootId,
    name: detail.outcome === "error" ? "Run Error" : detail.outcome === "cancelled" ? "Run Cancelled" : "Run Completed",
    status: detail.outcome === "error" ? "error" : detail.outcome === "cancelled" ? "cancelled" : "success",
    startedAt: detail.endedAt,
    endedAt: detail.endedAt,
    output: detail.errorMessage ?? (detail.outcome === "success" ? "Completed" : detail.outcome)
  })

  return nodes
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Format a token count: ≥1000 → "1.2k", otherwise plain number. */
function fmtTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return String(tokens)
}

/** Format a cumulative duration for thread-level summary: e.g. "2m30s", "1h5m" */
function fmtDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}m`
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`
}

function isSameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

function outcomeColor(outcome: string): string {
  return {
    success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    error: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    cancelled: "bg-zinc-500/15 text-zinc-500 border-zinc-500/20"
  }[outcome] ?? "bg-zinc-500/15 text-zinc-500 border-zinc-500/20"
}

function nodeIcon(node: TraceNode): React.JSX.Element {
  if (node.type === "trace") return <Activity className="size-3.5" />
  if (node.type === "llm") return <Bot className="size-3.5" />
  if (node.type === "tool") return <Wrench className="size-3.5" />
  if (node.type === "tool_result") return <Terminal className="size-3.5" />
  if (node.type === "error") return <AlertCircle className="size-3.5" />
  if (node.type === "cancel") return <Ban className="size-3.5" />
  return <MessageSquare className="size-3.5" />
}

function nodeStatusClass(status?: TraceNode["status"]): string {
  if (status === "success") return "text-emerald-600"
  if (status === "error") return "text-red-500"
  if (status === "running") return "text-blue-500"
  if (status === "cancelled") return "text-zinc-500"
  return "text-muted-foreground"
}

function JsonBlock({ value }: { value: unknown }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const text = JSON.stringify(value, null, 2)
  if (text.length <= 180) {
    return <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/70">{text}</pre>
  }
  return (
    <div className="space-y-1">
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/70">
        {expanded ? text : `${text.slice(0, 180)}...`}
      </pre>
      <button className="text-[10px] text-blue-500 hover:underline" onClick={() => setExpanded((v) => !v)}>
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
  node: TraceNode
  childrenByParent: Map<string, TraceNode[]>
  depth: number
}): React.JSX.Element {
  const children = childrenByParent.get(node.id) ?? []
  const hasDetail = node.input !== undefined || node.output !== undefined || children.length > 0
  const [open, setOpen] = useState(depth <= 1)

  return (
    <div style={{ marginLeft: `${depth * 14}px` }} className="relative">
      <div className="rounded-md border border-border bg-card/70 mb-2 overflow-hidden">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
          onClick={() => hasDetail && setOpen((v) => !v)}
          disabled={!hasDetail}
        >
          <span className={cn("shrink-0", nodeStatusClass(node.status))}>{nodeIcon(node)}</span>
          <span className="text-[12px] font-medium text-foreground/85">
            {node.name || node.type}
          </span>
          <span className="text-[10px] text-muted-foreground/60">{new Date(node.startedAt).toLocaleTimeString()}</span>
          {node.status && (
            <Badge variant="outline" className="text-[10px] ml-auto">
              {node.status}
            </Badge>
          )}
          {hasDetail && (open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />)}
        </button>

        {open && hasDetail && (
          <div className="border-t border-border/60 px-3 py-2 space-y-2 bg-background/60">
            {node.input !== undefined && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Input</p>
                <JsonBlock value={node.input} />
              </div>
            )}
            {node.output !== undefined && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Output</p>
                <JsonBlock value={node.output} />
              </div>
            )}
            {node.metadata && Object.keys(node.metadata).length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Metadata</p>
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

function TraceDetailView({ detail, onClose }: { detail: TraceDetail; onClose: () => void }): React.JSX.Element {
  const nodes = (detail.nodes && detail.nodes.length > 0) ? detail.nodes : buildFallbackNodes(detail)
  const root = nodes.find((n) => n.parentId === null) ?? nodes[0]
  const childrenByParent = useMemo(() => {
    const map = new Map<string, TraceNode[]>()
    for (const node of nodes) {
      if (!node.parentId) continue
      const list = map.get(node.parentId) ?? []
      list.push(node)
      map.set(node.parentId, list)
    }
    return map
  }, [nodes])

  return (
    <div className="flex flex-1 min-w-0 flex-col h-full overflow-hidden bg-background">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>
          <ArrowLeft className="size-3.5" />
          Traces
        </button>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-xs font-mono text-muted-foreground">{detail.traceId.slice(0, 16)}</span>
        <Badge className={cn("ml-auto border text-[10px]", outcomeColor(detail.outcome))}>{detail.outcome}</Badge>
      </div>

      <div className="shrink-0 border-b border-border grid grid-cols-4">
        <Stat icon={<Timer className="size-3.5" />} label="耗时" value={fmt(detail.durationMs)} />
        <Stat icon={<Hash className="size-3.5" />} label="工具调用" value={String(detail.totalToolCalls)} />
        <Stat icon={<Cpu className="size-3.5" />} label="模型" value={detail.modelId.split("/").pop() ?? detail.modelId} />
        <Stat
          icon={<Sparkles className="size-3.5" />}
          label="使用技能"
          value={detail.usedSkills.length > 0 ? detail.usedSkills.join(", ") : "未使用"}
        />
      </div>

      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full px-4 py-3">
          {root ? (
            <TraceTreeNode node={root} childrenByParent={childrenByParent} depth={0} />
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">该 trace 暂无树结构数据</div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}

function Stat({ icon, label, value }: { icon: React.JSX.Element; label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-r border-border last:border-r-0">
      <span className="text-muted-foreground/60 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">{label}</p>
        <p className="text-[12px] font-semibold truncate" title={value}>{value}</p>
      </div>
    </div>
  )
}

function TraceCard({
  trace,
  checked,
  onToggle,
  onOpen,
  onDelete
}: {
  trace: TraceEntry
  checked: boolean
  onToggle: (traceId: string, checked: boolean) => void
  onOpen: (traceId: string) => void
  onDelete: (traceId: string) => void
}): React.JSX.Element {
  return (
    <div
      className="w-full text-left rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors group overflow-hidden"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(trace.traceId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen(trace.traceId)
        }
      }}
    >
      <div className={cn("h-0.5 w-full",
        trace.outcome === "success" ? "bg-emerald-500/60" :
          trace.outcome === "error" ? "bg-red-500/60" : "bg-zinc-500/30"
      )} />
      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(trace.traceId, e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            className="size-3.5"
          />
          <Badge className={cn("border text-[10px] px-1.5 py-0 shrink-0", outcomeColor(trace.outcome))}>
            {trace.outcome === "success" ? "成功" : trace.outcome === "error" ? "错误" : "取消"}
          </Badge>
          <span className="text-[10px] font-mono text-muted-foreground/60">{trace.traceId.slice(0, 8)}</span>
          <button
            className="ml-auto text-muted-foreground/50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(trace.traceId)
            }}
            title="删除 trace"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
        <p className="text-[12px] text-foreground/80 line-clamp-2 leading-snug">{trace.userMessage}</p>
        <p className="text-[10px] text-muted-foreground/50 flex items-center gap-2">
          <span>{new Date(trace.startedAt).toLocaleString()}</span>
          <span className="inline-flex items-center gap-0.5"><Timer className="size-3" />{fmt(trace.durationMs)}</span>
          <span className="inline-flex items-center gap-0.5"><Wrench className="size-3" />{trace.totalToolCalls}</span>
          {(trace.totalTokens ?? 0) > 0 ? (
            <span className="inline-flex items-center gap-1" title="输入 token / 输出 token">
              <Coins className="size-3" />
              <span>↑{fmtTokens(trace.totalInputTokens ?? 0)}</span>
              <span className="text-muted-foreground/30">/</span>
              <span>↓{fmtTokens(trace.totalOutputTokens ?? 0)}</span>
            </span>
          ) : null}
        </p>
      </div>
    </div>
  )
}

function TraceThreadGroupCard({
  group,
  selectedTraceIds,
  onToggleTrace,
  onOpenTrace,
  onDeleteTrace,
  onToggleThread,
  onDeleteThread
}: {
  group: TraceThreadGroup
  selectedTraceIds: Set<string>
  onToggleTrace: (traceId: string, checked: boolean) => void
  onOpenTrace: (traceId: string) => void
  onDeleteTrace: (traceId: string) => void
  onToggleThread: (threadId: string, checked: boolean) => void
  onDeleteThread: (threadId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const traceIds = group.traces.map((trace) => trace.traceId)
  const selectedCount = traceIds.filter((traceId) => selectedTraceIds.has(traceId)).length
  const allChecked = traceIds.length > 0 && selectedCount === traceIds.length

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3 border-b border-border/70 bg-muted/10">
        <button
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{group.threadTitle}</span>
            <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">
              {group.threadId.slice(0, 8)}
            </Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {group.traces.length} 条 traces
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>最近运行：{new Date(group.latestStartedAt).toLocaleString()}</span>
            <span className="inline-flex items-center gap-1"><Wrench className="size-3" />{group.totalToolCalls}</span>
            <span className="inline-flex items-center gap-1"><Clock className="size-3" />总耗时 {fmtDuration(group.totalDurationMs)}</span>
            {group.totalTokens > 0 ? (
              <span className="inline-flex items-center gap-1" title="输入 token / 输出 token">
                <Coins className="size-3" />
                <span>↑{fmtTokens(group.totalInputTokens)}</span>
                <span className="text-muted-foreground/30">/</span>
                <span>↓{fmtTokens(group.totalOutputTokens)}</span>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="size-3" />{group.successCount}</span>
            {group.errorCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-red-500"><AlertCircle className="size-3" />{group.errorCount}</span>
            ) : null}
            <span>已选 {selectedCount}</span>
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onToggleThread(group.threadId, !allChecked)}
          >
            {allChecked ? "取消选中" : "选中本会话"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onDeleteThread(group.threadId)}
          >
            <Trash2 className="size-3 mr-1" />删本会话
          </Button>
        </div>
      </div>

      {open ? (
        <div className="p-3 space-y-2">
          {group.traces.map((trace) => (
            <TraceCard
              key={trace.traceId}
              trace={trace}
              checked={selectedTraceIds.has(trace.traceId)}
              onToggle={onToggleTrace}
              onOpen={onOpenTrace}
              onDelete={onDeleteTrace}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function OptimizeStreamCard({
  running,
  runningSummary,
  streamedText,
  streamError,
  onRetry
}: {
  running: boolean
  runningSummary: string | null
  streamedText: string
  streamError: string | null
  onRetry: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasContent = streamedText.length > 0

  // Status label: prefer runningSummary when running, otherwise fallback
  const statusLabel = streamError
    ? "生成失败"
    : running
      ? (runningSummary ?? "正在生成优化候选...")
      : "生成完成"

  return (
    <div className={cn(
      "shrink-0 border-b border-violet-500/20 bg-violet-500/10 px-4 py-2"
    )}>
      <div className="flex items-center gap-2">
        {running && !streamError ? (
          <Loader2 className="size-3.5 text-violet-600 animate-spin shrink-0" />
        ) : streamError ? (
          <XCircle className="size-3.5 text-destructive shrink-0" />
        ) : (
          <Sparkles className="size-3.5 text-violet-600 shrink-0" />
        )}
        <span className={cn(
          "text-xs flex-1",
          streamError ? "text-destructive" : "text-violet-700 dark:text-violet-300"
        )}>
          {statusLabel}
        </span>
        <div className="flex items-center gap-2">
          {(running || streamError) && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-violet-400/40 text-violet-700 dark:text-violet-300 hover:bg-violet-500/10 transition-colors"
            >
              <RotateCcw className="size-2.5" />
              重试
            </button>
          )}
          {hasContent && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {expanded ? "收起" : "查看内容"}
            </button>
          )}
        </div>
      </div>
      {streamError && (
        <p className="text-[11px] text-destructive mt-1 pl-5">{streamError}</p>
      )}
      {expanded && hasContent && (
        <div className="mt-2 border border-violet-500/20 rounded px-2 py-1.5 max-h-48 overflow-y-auto bg-background/60">
          <pre className="text-[10px] text-foreground/80 whitespace-pre-wrap break-all font-mono">{streamedText}</pre>
        </div>
      )}
    </div>
  )
}

function CandidateCard({
  candidate,
  onApprove,
  onReject
}: {
  candidate: SkillCandidate
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [oldContent, setOldContent] = useState<string | null>(null)
  const [oldContentStatus, setOldContentStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle")
  // Use a ref to track load state inside the effect without adding it to the dependency array,
  // preventing the infinite loop caused by cleanup resetting state that re-triggers the effect.
  const loadInitiatedRef = useRef(false)

  // Load the existing SKILL.md content when a patch candidate is first expanded.
  // candidate.skillId equals skill.name (from SkillUsageDetector), so match by name.
  useEffect(() => {
    if (!expanded || candidate.action !== "patch" || loadInitiatedRef.current) return

    loadInitiatedRef.current = true
    setOldContentStatus("loading")

    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const skills = await window.api.skills.list()
        const matched = skills.find((s) => s.name === candidate.skillId)
        if (!matched) throw new Error(`Skill not found: ${candidate.skillId}`)

        const result = await window.api.skills.read(matched.path)
        if (!result.success || typeof result.content !== "string") {
          throw new Error(result.error ?? "Failed to read skill content")
        }

        if (!cancelled) {
          setOldContent(result.content)
          setOldContentStatus("ready")
        }
      } catch {
        if (!cancelled) setOldContentStatus("failed")
      }
    }

    void load()
    return () => { cancelled = true }
  }, [expanded, candidate.action, candidate.skillId])

  // Reset all load state when the candidate changes
  useEffect(() => {
    loadInitiatedRef.current = false
    setOldContent(null)
    setOldContentStatus("idle")
  }, [candidate.candidateId])

  const approve = async (): Promise<void> => {
    setLoading(true)
    await onApprove(candidate.candidateId)
    setLoading(false)
  }

  const reject = async (): Promise<void> => {
    setLoading(true)
    await onReject(candidate.candidateId)
    setLoading(false)
  }

  const statusEl = candidate.status === "approved"
    ? <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 gap-1 text-xs"><CheckCircle2 className="size-3" />已采纳</Badge>
    : candidate.status === "rejected"
      ? <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20 gap-1 text-xs"><XCircle className="size-3" />已拒绝</Badge>
      : <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 gap-1 text-xs"><Clock className="size-3" />待审批</Badge>

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <button className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{candidate.name}</span>
            <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">{candidate.skillId}</Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{candidate.action === "create" ? "新建" : "更新"}</Badge>
            {statusEl}
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{candidate.description}</p>
          {candidate.action === "patch" && (
            <p className="text-[11px] text-muted-foreground mt-1">
              优化目标 skill：
              <span className="ml-1 font-mono text-foreground/80">{candidate.skillId}</span>
            </p>
          )}
          <p className="text-[10px] text-muted-foreground/50 mt-1">基于 {candidate.sourceTraceIds.length} 条 trace · {new Date(candidate.generatedAt).toLocaleString()}</p>
        </div>
        {candidate.status === "pending" && (
          <div className="flex gap-1.5 shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              className="h-7 px-2.5 text-xs border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600"
              onClick={approve}
            >
              {loading ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3 mr-1" />}
              采纳
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
              onClick={reject}
            >
              <XCircle className="size-3 mr-1" />拒绝
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/30 px-4 pb-4 pt-3 space-y-3">
          {candidate.rationale && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">优化理由</p>
              <p className="text-xs text-foreground/80">{candidate.rationale}</p>
            </div>
          )}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              SKILL.md {candidate.action === "patch" ? "变更" : "预览"}
            </p>
            <div className="rounded border border-border bg-background max-h-80 overflow-y-auto">
              {candidate.action === "patch" && (oldContentStatus === "idle" || oldContentStatus === "loading") && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  正在加载旧版内容…
                </div>
              )}
              {candidate.action === "patch" && oldContentStatus === "ready" && oldContent !== null && (
                <ReactDiffViewer
                  oldValue={oldContent}
                  newValue={candidate.proposedContent}
                  splitView={false}
                  compareMethod={DiffMethod.LINES}
                  useDarkTheme={false}
                  styles={{
                    contentText: { fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", wordBreak: "break-all" }
                  }}
                />
              )}
              {candidate.action === "patch" && oldContentStatus === "failed" && (
                <div className="px-3 pt-2 pb-1">
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1">
                    <AlertCircle className="size-3 shrink-0" />
                    未找到原始技能文件（{candidate.skillId}），无法显示 diff，仅展示新内容
                  </p>
                  <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {candidate.proposedContent}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
              {candidate.action === "create" && (
                <div className="p-3">
                  <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {candidate.proposedContent}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon}
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">{desc}</p>
    </div>
  )
}

export function EvolutionPanel(): React.JSX.Element {
  const [candidates, setCandidates] = useState<SkillCandidate[]>([])
  const [traces, setTraces] = useState<TraceEntry[]>([])
  const [tracesLoading, setTracesLoading] = useState(false)
  const [selectedTrace, setSelectedTrace] = useState<TraceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [onlineSkillEvolutionEnabled, setOnlineSkillEvolutionEnabled] = useState(false)
  const [autoPropose, setAutoPropose] = useState(false)
  const [threshold, setThreshold] = useState(10)
  const [thresholdInput, setThresholdInput] = useState("10")
  const [thresholdSaved, setThresholdSaved] = useState(false)
  const {
    threads,
    loadThreads,
    evolutionTab: tab,
    setEvolutionTab: setTab,
    evolutionRunning: running,
    setEvolutionRunning: setRunning,
    evolutionRunningSummary: runningSummary,
    setEvolutionRunningSummary: setRunningSummary,
    evolutionSummary: summary,
    setEvolutionSummary: setSummary,
    evolutionSelectedTraceIds: selectedTraceIds,
    setEvolutionSelectedTraceIds,
    evolutionRunProgress: runProgress,
    setEvolutionRunProgress,
    mergeEvolutionRunProgress,
    evolutionStreamedText: streamedText,
    setEvolutionStreamedText,
    appendEvolutionStreamedText,
    evolutionStreamError: streamError,
    setEvolutionStreamError,
    evolutionLastRunOpts: lastRunOpts,
    setEvolutionLastRunOpts
  } = useAppStore()

  const pendingCount = candidates.filter((c) => c.status === "pending").length

  const loadTraces = useCallback(async () => {
    setTracesLoading(true)
    try {
      const list = await window.api.optimizer.getTraces({ limit: 80 })
      setTraces(list)
      const keep = new Set<string>()
      const valid = new Set(list.map((t) => t.traceId))
      for (const id of selectedTraceIds) {
        if (valid.has(id)) keep.add(id)
      }
      if (!isSameIdSet(keep, selectedTraceIds)) {
        setEvolutionSelectedTraceIds(keep)
      }
    } finally {
      setTracesLoading(false)
    }
  }, [selectedTraceIds, setEvolutionSelectedTraceIds])

  const runOptimizer = useCallback(async (
    opts?: {
      threadId?: string
      mode?: "auto" | "selected"
      traceIds?: string[]
    },
    pendingMessage = "正在分析选中内容，请稍候..."
  ) => {
    setEvolutionLastRunOpts(opts ?? null)
    setEvolutionStreamedText("")
    setEvolutionStreamError(null)
    setRunning(true)
    setRunningSummary(pendingMessage)
    setSummary(null)
    setEvolutionRunProgress({})
    try {
      const result = await window.api.optimizer.run(opts)
      setSummary(result.summary)
      setCandidates(await window.api.optimizer.getCandidates())
    } catch (e) {
      setSummary(`运行失败: ${e}`)
    } finally {
      setRunning(false)
      setRunningSummary(null)
    }
  }, [setEvolutionLastRunOpts, setEvolutionRunProgress, setEvolutionStreamedText, setEvolutionStreamError, setRunning, setRunningSummary, setSummary])

  useEffect(() => {
    if (threads.length === 0) {
      loadThreads().catch(console.warn)
    }
  }, [threads.length, loadThreads])

  useEffect(() => {
    window.api.optimizer.getOnlineSkillEvolutionEnabled().then(setOnlineSkillEvolutionEnabled).catch(console.warn)
    window.api.optimizer.getAutoPropose().then(setAutoPropose).catch(console.warn)
    window.api.optimizer.getCandidates().then(setCandidates).catch(console.warn)
    window.api.optimizer.getThreshold().then((v) => {
      setThreshold(v)
      setThresholdInput(String(v))
    }).catch(console.warn)
  }, [])

  useEffect(() => {
    if (tab === "traces" && !selectedTrace) {
      loadTraces().catch(console.warn)
    }
  }, [tab, selectedTrace, loadTraces])

  useEffect(() => {
    const onRunProgress = window.api.optimizer.onRunProgress
    if (typeof onRunProgress !== "function") return

    return onRunProgress((payload) => {
      mergeEvolutionRunProgress(payload)
    })
  }, [mergeEvolutionRunProgress])

  useEffect(() => {
    const offStart = window.api.optimizer.onStreamStart(() => {
      setEvolutionStreamedText("")
      setEvolutionStreamError(null)
    })
    const offChunk = window.api.optimizer.onStreamChunk(({ chunk }) => {
      appendEvolutionStreamedText(chunk)
    })
    const offEnd = window.api.optimizer.onStreamEnd(({ success, error }) => {
      if (!success && error) setEvolutionStreamError(error)
    })
    return () => {
      offStart()
      offChunk()
      offEnd()
    }
  }, [appendEvolutionStreamedText, setEvolutionStreamedText, setEvolutionStreamError])

  const toggleOnlineSkillEvolution = useCallback(async () => {
    const next = !onlineSkillEvolutionEnabled
    setOnlineSkillEvolutionEnabled(next)
    await window.api.optimizer.setOnlineSkillEvolutionEnabled(next).catch(console.warn)
  }, [onlineSkillEvolutionEnabled])

  const toggleAutoPropose = useCallback(async () => {
    const next = !autoPropose
    setAutoPropose(next)
    await window.api.optimizer.setAutoPropose(next).catch(console.warn)
  }, [autoPropose])

  const commitThreshold = useCallback(async () => {
    const parsed = parseInt(thresholdInput, 10)
    const clamped = Number.isNaN(parsed) ? 10 : Math.max(1, Math.min(99, parsed))
    setThreshold(clamped)
    setThresholdInput(String(clamped))
    await window.api.optimizer.setThreshold(clamped).catch(console.warn)
    setThresholdSaved(true)
    setTimeout(() => setThresholdSaved(false), 1500)
  }, [thresholdInput])

  const handleExpandTrace = useCallback(async (traceId: string) => {
    setDetailLoading(true)
    try {
      const detail = await window.api.optimizer.getTraceDetail(traceId)
      if (detail) {
        setSelectedTrace(detail as TraceDetail)
      }
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const handleApprove = useCallback(async (candidateId: string) => {
    const result = await window.api.optimizer.approve(candidateId)
    if (result.success) {
      setCandidates((prev) => prev.map((candidate) => (
        candidate.candidateId === candidateId ? { ...candidate, status: "approved" } : candidate
      )))
    }
  }, [])

  const handleReject = useCallback(async (candidateId: string) => {
    await window.api.optimizer.reject(candidateId)
    setCandidates((prev) => prev.map((candidate) => (
      candidate.candidateId === candidateId ? { ...candidate, status: "rejected" } : candidate
    )))
  }, [])

  const handleClear = useCallback(async () => {
    await window.api.optimizer.clear()
    setCandidates([])
    setSummary(null)
  }, [])

  const toggleTraceChecked = useCallback((traceId: string, checked: boolean) => {
    const next = new Set(selectedTraceIds)
    if (checked) next.add(traceId)
    else next.delete(traceId)
    setEvolutionSelectedTraceIds(next)
  }, [selectedTraceIds, setEvolutionSelectedTraceIds])

  const handleDeleteTraces = useCallback(async (traceIds: string[]) => {
    if (traceIds.length === 0) return
    if (typeof window.api.optimizer.deleteTraces !== "function") {
      console.error("[Evolution] deleteTraces API not available in preload")
      setSummary("当前应用版本不支持 trace 删除，请重启应用后再试。")
      window.alert("当前应用版本不支持 trace 删除，请重启应用后再试。")
      return
    }

    const confirmed = window.confirm(
      traceIds.length === 1
        ? "确认删除这条 trace 吗？该操作不可恢复。"
        : `确认删除选中的 ${traceIds.length} 条 trace 吗？该操作不可恢复。`
    )
    if (!confirmed) return

    const result = await window.api.optimizer.deleteTraces(traceIds)
      if (result.deletedIds.length > 0) {
        const deleted = new Set(result.deletedIds)
        setTraces((prev) => prev.filter((trace) => !deleted.has(trace.traceId)))
        const nextSelected = new Set(selectedTraceIds)
        for (const id of deleted) nextSelected.delete(id)
        setEvolutionSelectedTraceIds(nextSelected)
        if (selectedTrace && deleted.has(selectedTrace.traceId)) {
          setSelectedTrace(null)
          setSummary("当前打开的 trace 已删除")
        }
      }

    await loadTraces()

    if (result.failed.length > 0) {
      setSummary(`已删除 ${result.deletedIds.length} 条，失败 ${result.failed.length} 条`)
    } else {
      setSummary(`已删除 ${result.deletedIds.length} 条 trace`)
    }
  }, [loadTraces, selectedTrace, selectedTraceIds, setEvolutionSelectedTraceIds, setSummary])

  const progressItems = Object.values(runProgress).sort((a, b) => a.index - b.index)
  const allTraceIds = useMemo(() => traces.map((trace) => trace.traceId), [traces])
  const threadTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const thread of threads) {
      map.set(thread.thread_id, thread.title?.trim() || `会话 ${thread.thread_id.slice(0, 8)}`)
    }
    return map
  }, [threads])
  const traceGroups = useMemo<TraceThreadGroup[]>(() => {
    const grouped = new Map<string, TraceEntry[]>()
    for (const trace of traces) {
      const list = grouped.get(trace.threadId) ?? []
      list.push(trace)
      grouped.set(trace.threadId, list)
    }

    return Array.from(grouped.entries())
      .map(([threadId, threadTraces]) => {
        const sortedTraces = [...threadTraces].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        const totals = threadTraces.reduce(
          (acc, t) => {
            acc.totalToolCalls += t.totalToolCalls
            acc.totalDurationMs += t.durationMs
            acc.totalInputTokens += t.totalInputTokens ?? 0
            acc.totalOutputTokens += t.totalOutputTokens ?? 0
            acc.totalTokens += t.totalTokens ?? 0
            return acc
          },
          { totalToolCalls: 0, totalDurationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 }
        )
        return {
          threadId,
          threadTitle: threadTitleById.get(threadId) ?? `会话 ${threadId.slice(0, 8)}`,
          traces: sortedTraces,
          latestStartedAt: sortedTraces[0]?.startedAt ?? "",
          totalToolCalls: totals.totalToolCalls,
          totalDurationMs: totals.totalDurationMs,
          totalInputTokens: totals.totalInputTokens,
          totalOutputTokens: totals.totalOutputTokens,
          totalTokens: totals.totalTokens,
          successCount: sortedTraces.filter((t) => t.outcome === "success").length,
          errorCount: sortedTraces.filter((t) => t.outcome === "error").length
        }
      })
      .sort((a, b) => b.latestStartedAt.localeCompare(a.latestStartedAt))
  }, [traces, threadTitleById])
  const selectedThreadCount = useMemo(
    () => traceGroups.filter((group) => group.traces.some((trace) => selectedTraceIds.has(trace.traceId))).length,
    [traceGroups, selectedTraceIds]
  )
  const allSelected = allTraceIds.length > 0 && allTraceIds.every((id) => selectedTraceIds.has(id))

  const handleRunSelected = useCallback(async () => {
    const traceIds = [...selectedTraceIds]
    if (traceIds.length === 0) {
      setSummary("请先选择会话或 trace")
      return
    }
    const pendingMessage = selectedThreadCount > 0
      ? `正在分析已选内容（${traceIds.length} 条 trace / ${selectedThreadCount} 个会话），请稍候...`
      : `正在分析已选内容（${traceIds.length} 条 trace），请稍候...`
    await runOptimizer({ mode: "selected", traceIds }, pendingMessage)
    setTab("candidates")
  }, [runOptimizer, selectedTraceIds, selectedThreadCount])

  const handleRetryOptimizer = useCallback(() => {
    const pendingMessage = lastRunOpts?.traceIds
      ? `正在重试分析（${lastRunOpts.traceIds.length} 条 trace），请稍候...`
      : "正在重试分析，请稍候..."
    runOptimizer(lastRunOpts ?? undefined, pendingMessage).catch(console.warn)
  }, [lastRunOpts, runOptimizer])

  const toggleSelectAll = useCallback(() => {
    if (allTraceIds.length === 0) return
    if (allTraceIds.every((id) => selectedTraceIds.has(id))) {
      setEvolutionSelectedTraceIds(new Set<string>())
      return
    }
    setEvolutionSelectedTraceIds(new Set(allTraceIds))
  }, [allTraceIds, selectedTraceIds, setEvolutionSelectedTraceIds])

  const toggleThreadChecked = useCallback((threadId: string, checked: boolean) => {
    const next = new Set(selectedTraceIds)
    const traceIds = traces.filter((trace) => trace.threadId === threadId).map((trace) => trace.traceId)
    for (const traceId of traceIds) {
      if (checked) next.add(traceId)
      else next.delete(traceId)
    }
    setEvolutionSelectedTraceIds(next)
  }, [selectedTraceIds, setEvolutionSelectedTraceIds, traces])

  const handleDeleteThread = useCallback(async (threadId: string) => {
    const traceIds = traces.filter((trace) => trace.threadId === threadId).map((trace) => trace.traceId)
    if (traceIds.length === 0) return
    await handleDeleteTraces(traceIds)
  }, [handleDeleteTraces, traces])

  if (detailLoading) {
    return (
      <div className="flex flex-1 min-w-0 items-center justify-center h-full">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (selectedTrace) {
    return <TraceDetailView detail={selectedTrace} onClose={() => setSelectedTrace(null)} />
  }

  return (
    <div className="flex flex-1 min-w-0 flex-col h-full overflow-hidden">
      <div className="shrink-0 border-b border-border px-4 py-3 flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold flex-1">自优化</span>
      </div>

      {/* 配置区：在线自动沉淀总开关 + 模式/阈值 */}
      <div className="shrink-0 border-b border-border px-4 py-2 bg-muted/20 flex items-start gap-3">
        <Settings2 className="size-3.5 text-muted-foreground/60 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-muted-foreground">开启在线自动沉淀 Skill</span>
            <div className="group relative shrink-0">
              <Info className="size-3.5 text-muted-foreground/40 hover:text-muted-foreground/70 cursor-default transition-colors" />
              <div className="pointer-events-none absolute top-full left-0 mt-2 w-80 rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-5 text-muted-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-50">
                <p><span className="font-medium text-foreground">开启：</span> 会在当前对话过程中自动触发技能沉淀流程。</p>
                <p className="mt-1"><span className="font-medium text-foreground">关闭：</span> 不会自动沉淀技能，你仍可在下方基于 traces 手动做离线优化。</p>
              </div>
            </div>
            <button
              onClick={toggleOnlineSkillEvolution}
              className={cn(
                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none shrink-0",
                onlineSkillEvolutionEnabled ? "bg-violet-500" : "bg-muted-foreground/30"
              )}
            >
              <span className={cn(
                "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
                onlineSkillEvolutionEnabled ? "translate-x-4" : "translate-x-0.5"
              )} />
            </button>
          </div>

          <div
            className={cn(
              "flex flex-wrap items-center gap-2 transition-opacity",
              onlineSkillEvolutionEnabled ? "opacity-100" : "opacity-45"
            )}
          >
            <span className="text-xs text-muted-foreground">触发模式</span>
            <div className="inline-flex rounded-md border border-border bg-background p-0.5">
              <button
                disabled={!onlineSkillEvolutionEnabled}
                onClick={() => {
                  if (!autoPropose) void toggleAutoPropose()
                }}
                className={cn(
                  "h-6 rounded px-2.5 text-[11px] transition-colors",
                  autoPropose
                    ? "bg-violet-500 text-white"
                    : "text-muted-foreground hover:text-foreground",
                  !onlineSkillEvolutionEnabled && "cursor-not-allowed hover:text-muted-foreground"
                )}
              >
                直接触发
              </button>
              <button
                disabled={!onlineSkillEvolutionEnabled}
                onClick={() => {
                  if (autoPropose) void toggleAutoPropose()
                }}
                className={cn(
                  "h-6 rounded px-2.5 text-[11px] transition-colors",
                  !autoPropose
                    ? "bg-violet-500 text-white"
                    : "text-muted-foreground hover:text-foreground",
                  !onlineSkillEvolutionEnabled && "cursor-not-allowed hover:text-muted-foreground"
                )}
              >
                模型判断
              </button>
            </div>
            <div className="group relative shrink-0">
              <Info className="size-3.5 text-muted-foreground/40 hover:text-muted-foreground/70 cursor-default transition-colors" />
              <div className="pointer-events-none absolute top-full left-0 mt-2 w-80 rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-5 text-muted-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-50">
                <p><span className="font-medium text-foreground">直接触发：</span> 达到工具调用阈值后，直接进入技能沉淀流程。</p>
                <p className="mt-1"><span className="font-medium text-foreground">模型判断：</span> 达到工具调用阈值后，先由大模型判断是否值得沉淀，再决定是否进入技能沉淀流程。</p>
              </div>
            </div>

            <span className="ml-2 text-xs text-muted-foreground">工具调用阈值</span>
            <input
              type="number"
              min={1}
              max={99}
              disabled={!onlineSkillEvolutionEnabled}
              value={thresholdInput}
              onChange={(e) => {
                setThresholdInput(e.target.value)
                setThresholdSaved(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitThreshold()
              }}
              className={cn(
                "w-12 h-6 rounded border bg-background text-center text-xs transition-colors",
                "focus:outline-none focus:ring-1 focus:ring-violet-500/50",
                "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                thresholdInput !== String(threshold)
                  ? "border-violet-400 text-foreground"
                  : "border-border text-muted-foreground",
                !onlineSkillEvolutionEnabled && "cursor-not-allowed bg-muted/30"
              )}
            />
            {thresholdSaved ? (
              <span className="text-[11px] text-emerald-500 flex items-center gap-0.5">
                <CheckCircle2 className="size-3" />已保存
              </span>
            ) : thresholdInput !== String(threshold) ? (
              <button
                disabled={!onlineSkillEvolutionEnabled}
                onClick={commitThreshold}
                className={cn(
                  "h-6 px-2 rounded text-[11px] transition-colors",
                  onlineSkillEvolutionEnabled
                    ? "bg-violet-500 text-white hover:bg-violet-600"
                    : "bg-muted text-muted-foreground cursor-not-allowed"
                )}
              >
                保存
              </button>
            ) : (
              <span className="w-10" />
            )}
          </div>
        </div>
      </div>

      {summary && (
        <div className="shrink-0 px-4 py-2 bg-muted/50 border-b border-border">
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
      )}

      {progressItems.length > 0 && (
        <div className="shrink-0 border-b border-border px-4 py-2 bg-background/80">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">优化进度（串行子任务）</p>
          <div className="flex flex-wrap gap-1.5">
            {progressItems.map((item) => (
              <Badge key={item.traceId} variant="outline" className="text-[10px] gap-1">
                <span className={cn(
                  "size-1.5 rounded-full",
                  item.status === "completed" ? "bg-emerald-500" :
                    item.status === "failed" ? "bg-red-500" :
                      item.status === "running" ? "bg-blue-500" : "bg-zinc-400"
                )} />
                {item.index}/{item.total} · {item.traceId.slice(0, 6)} · {item.status}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {(running || streamError || streamedText.length > 0) && (
        <OptimizeStreamCard
          running={running}
          runningSummary={runningSummary}
          streamedText={streamedText}
          streamError={streamError}
          onRetry={handleRetryOptimizer}
        />
      )}

      <div className="shrink-0 flex border-b border-border px-4">
        {(["candidates", "traces"] as Tab[]).map((item) => (
          <button
            key={item}
            className={cn(
              "flex items-center gap-1.5 text-xs py-2 px-1 border-b-2 mr-4 transition-colors",
              tab === item ? "border-foreground text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setTab(item)}
          >
            {item === "candidates" ? (
              <>
                <Sparkles className="size-3.5" />
                优化候选
                {pendingCount > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center size-4 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-bold">
                    {pendingCount}
                  </span>
                )}
              </>
            ) : (
              <>
                <Activity className="size-3.5" />
                执行 Traces
                {traces.length > 0 && (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    ({traceGroups.length} 个会话 / {traces.length} 条)
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>

      {tab === "candidates" && (
        <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 bg-muted/10">
          <span className="text-xs text-muted-foreground flex-1">候选 {candidates.length} 条</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={handleClear}
            disabled={running || candidates.length === 0}
          >
            <Trash2 className="size-3" />清除候选
          </Button>
        </div>
      )}

      {tab === "traces" && (
        <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 bg-muted/10">
          <span className="text-xs text-muted-foreground flex-1">
            已选 {selectedTraceIds.size} 条 trace · {selectedThreadCount} 个会话
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={traces.length === 0}
            onClick={toggleSelectAll}
          >
            {allSelected ? "取消全选" : "全选"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={running || selectedTraceIds.size === 0}
            onClick={handleRunSelected}
          >
            {running ? (
              <>
                <Loader2 className="size-3 mr-1 animate-spin" />
                分析中...
              </>
            ) : (
              "分析选中内容"
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={selectedTraceIds.size === 0}
            onClick={() => handleDeleteTraces([...selectedTraceIds])}
          >
            <Trash2 className="size-3 mr-1" />删除
          </Button>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {tab === "candidates" ? (
            candidates.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="size-8 text-muted-foreground/40 mb-3" />}
                title="暂无优化候选"
                desc="请先切换到「执行 Traces」，分析会话或选中的 trace"
              />
            ) : (
              [...candidates]
                .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
                .map((candidate) => (
                  <CandidateCard key={candidate.candidateId} candidate={candidate} onApprove={handleApprove} onReject={handleReject} />
                ))
            )
          ) : tracesLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
          ) : traces.length === 0 ? (
            <EmptyState
              icon={<Activity className="size-8 text-muted-foreground/40 mb-3" />}
              title="暂无执行记录"
              desc="Traces 会按会话分组展示，每次 Agent 调用结束后自动记录到本地"
            />
          ) : (
            traceGroups.map((group) => (
              <TraceThreadGroupCard
                key={group.threadId}
                group={group}
                selectedTraceIds={selectedTraceIds}
                onToggleTrace={toggleTraceChecked}
                onOpenTrace={handleExpandTrace}
                onDeleteTrace={(traceId) => handleDeleteTraces([traceId]).catch(console.warn)}
                onToggleThread={toggleThreadChecked}
                onDeleteThread={(threadId) => handleDeleteThread(threadId).catch(console.warn)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
