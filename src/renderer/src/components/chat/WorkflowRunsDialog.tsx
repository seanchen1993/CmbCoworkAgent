import { useCallback, useEffect, useState, type JSX } from "react"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  History,
  Loader2,
  RefreshCw,
  Square
} from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { PersistedWorkflowRunDTO, WorkflowRunSummaryDTO } from "@/lib/workflow-run-view"

/**
 * Runs-history management dialog — the desktop counterpart of Claude Code's
 * `/workflows` manager. Lists this thread's persisted runs; drill into one to
 * see phases → agents (full prompt/result previews, errors, tokens, duration),
 * narrator logs, the final result JSON, the exact script that ran, and the
 * resume command for failed runs. The active run can be cancelled from here.
 */

interface WorkflowRunsDialogProps {
  threadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function statusChip(status: string): { label: string; className: string } {
  switch (status) {
    case "running":
      return {
        label: "运行中",
        className: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
      }
    case "completed":
      return {
        label: "已完成",
        className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
      }
    case "aborted":
      return {
        label: "已中止",
        className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
      }
    default:
      return {
        label: "失败",
        className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
      }
  }
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return new Date(ms).toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          toast.success(`已复制${label}`)
        } catch {
          toast.error("复制失败")
        }
      }}
      className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
      title={`复制${label}`}
    >
      <Copy className="size-2.5" />
      {label}
    </button>
  )
}

function Section({
  title,
  defaultOpen = false,
  children
}: {
  title: string
  defaultOpen?: boolean
  children: JSX.Element | null
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
        {title}
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  )
}

function AgentDetail({ agent }: { agent: PersistedWorkflowRunDTO["agents"][number] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const durationMs =
    agent.endedAt && agent.startedAt
      ? Math.max(0, Date.parse(agent.endedAt) - Date.parse(agent.startedAt))
      : 0
  return (
    <div className="rounded-md border border-border/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[11px]"
      >
        {agent.status === "running" ? (
          <Loader2 className="size-3 animate-spin text-violet-500" />
        ) : agent.status === "completed" ? (
          <Check className="size-3 text-emerald-500" />
        ) : agent.status === "cached" ? (
          <History className="size-3 text-sky-500" />
        ) : (
          <CircleSlash className="size-3 text-red-500" />
        )}
        <span className="min-w-0 flex-1 truncate text-foreground/80">{agent.label}</span>
        {durationMs > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatDuration(durationMs)}
          </span>
        )}
        {agent.outputTokens > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {agent.outputTokens}tk
          </span>
        )}
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-1.5">
          {agent.promptPreview && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">指令</div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 text-[10px] leading-4">
                {agent.promptPreview}
              </pre>
            </div>
          )}
          {agent.resultPreview && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">结果</div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 text-[10px] leading-4">
                {agent.resultPreview}
              </pre>
            </div>
          )}
          {agent.error && (
            <div>
              <div className="text-[10px] font-medium text-red-500">错误</div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-red-50 p-1.5 text-[10px] leading-4 text-red-700 dark:bg-red-500/10 dark:text-red-300">
                {agent.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RunDetail({
  threadId,
  runId,
  onBack
}: {
  threadId: string
  runId: string
  onBack: () => void
}): JSX.Element {
  const [run, setRun] = useState<PersistedWorkflowRunDTO | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const raw = await window.api.workflows.getRun(threadId, runId)
      setRun(raw as PersistedWorkflowRunDTO | null)
    } catch (error) {
      console.warn("[WorkflowRunsDialog] Failed to load run:", error)
      toast.error("加载运行详情失败")
    } finally {
      setLoading(false)
    }
  }, [threadId, runId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }
  if (!run) {
    return <div className="p-4 text-sm text-muted-foreground">未找到该运行记录。</div>
  }

  const chip = statusChip(run.status)
  const agentsByPhase = new Map<string | null, PersistedWorkflowRunDTO["agents"]>()
  for (const agent of run.agents) {
    const list = agentsByPhase.get(agent.phase) ?? []
    list.push(agent)
    agentsByPhase.set(agent.phase, list)
  }
  const phaseOrder: Array<string | null> = [...run.phases]
  for (const key of agentsByPhase.keys()) {
    if (!phaseOrder.includes(key)) phaseOrder.push(key)
  }
  // Self-contained resume: just the runId — the script is loaded from the saved
  // run. (Passing scriptPath would fail if the .workflow.js was pruned while the
  // run JSON survived.)
  const resumeCommand = `workflow 工具入参: {"resumeFromRunId": "${run.runId}"}`

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          返回列表
        </button>
        <span className="truncate text-sm font-semibold">{run.workflowName}</span>
        <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", chip.className)}>
          {chip.label}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="刷新"
        >
          <RefreshCw className="size-3" />
        </button>
        {run.status === "running" && (
          <button
            type="button"
            onClick={async () => {
              const cancelled = await window.api.workflows
                .cancelRun(threadId, run.runId)
                .catch(() => false)
              if (cancelled) {
                toast.success("已请求中止")
                void load()
              } else {
                toast.info("该工作流已不在运行中")
              }
            }}
            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            <Square className="size-3" />
            取消
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {run.runId}
          <CopyButton text={run.runId} label="runId" />
        </span>
        <span>开始 {formatTime(run.startedAt)}</span>
        {run.completedAt && <span>结束 {formatTime(run.completedAt)}</span>}
        <span>
          子代理 {run.agents.length} · 缓存 {run.stats.agentsCached} · 失败 {run.stats.agentsFailed}{" "}
          · 输出 {run.stats.outputTokens.toLocaleString()} tokens
        </span>
      </div>

      {run.error && (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-red-50 p-2 text-[11px] leading-4 text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {run.error}
        </pre>
      )}

      {run.warning && (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-amber-50 p-2 text-[11px] leading-4 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          {run.warning}
        </pre>
      )}

      {run.status !== "completed" && run.status !== "running" && (
        <div className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-[11px] text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
          <span className="min-w-0 flex-1">
            已完成的子代理结果保留在 journal,可让模型续跑该任务。
          </span>
          <CopyButton text={resumeCommand} label="续跑指引" />
        </div>
      )}

      <div className="space-y-1.5">
        {phaseOrder.map((phase) => {
          const agents = agentsByPhase.get(phase) ?? []
          if (agents.length === 0 && phase === null) return null
          return (
            <Section
              key={phase ?? "__none__"}
              title={`${phase ?? "未分组"}(${agents.length})`}
              defaultOpen={agents.length > 0 && agents.length <= 12}
            >
              <div className="space-y-1">
                {agents.map((agent) => (
                  <AgentDetail key={agent.index} agent={agent} />
                ))}
              </div>
            </Section>
          )
        })}
      </div>

      {run.logs.length > 0 && (
        <Section title={`日志(${run.logs.length})`}>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[10px] leading-4">
            {run.logs.join("\n")}
          </pre>
        </Section>
      )}

      {run.result !== undefined && run.result !== null && (
        <Section title="最终结果" defaultOpen>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[10px] leading-4">
            {typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2)}
          </pre>
        </Section>
      )}

      {run.script && (
        <Section title="编排脚本">
          <pre className="max-h-64 overflow-y-auto whitespace-pre break-words rounded bg-muted/60 p-2 text-[10px] leading-4">
            {run.script}
          </pre>
        </Section>
      )}
    </div>
  )
}

export function WorkflowRunsDialog({
  threadId,
  open,
  onOpenChange
}: WorkflowRunsDialogProps): JSX.Element {
  const [runs, setRuns] = useState<WorkflowRunSummaryDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const raw = await window.api.workflows.listRuns(threadId)
      setRuns(raw as WorkflowRunSummaryDTO[])
    } catch (error) {
      console.warn("[WorkflowRunsDialog] Failed to list runs:", error)
      toast.error("加载工作流历史失败")
    } finally {
      setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    if (open) {
      setSelectedRunId(null)
      void loadRuns()
    }
  }, [open, loadRuns])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <History className="size-4 text-violet-500" />
            工作流运行历史
          </DialogTitle>
        </DialogHeader>
        {selectedRunId ? (
          <RunDetail
            threadId={threadId}
            runId={selectedRunId}
            onBack={() => setSelectedRunId(null)}
          />
        ) : loading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : runs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">本线程还没有工作流运行记录。</div>
        ) : (
          <div className="space-y-1.5">
            {runs.map((run) => {
              const chip = statusChip(run.status)
              return (
                <button
                  key={run.runId}
                  type="button"
                  onClick={() => setSelectedRunId(run.runId)}
                  className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">
                        {run.workflowName}
                      </span>
                      <span
                        className={cn("rounded-full px-1.5 py-0.5 text-[10px]", chip.className)}
                      >
                        {chip.label}
                      </span>
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {run.runId} · {formatTime(run.startedAt)} · {run.agentCount} 个子代理 · 输出{" "}
                      {run.stats.outputTokens.toLocaleString()} tokens
                    </div>
                  </div>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
