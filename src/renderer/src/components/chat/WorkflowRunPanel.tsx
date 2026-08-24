import { memo, useEffect, useMemo, useState, type JSX } from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Code2,
  Copy,
  History,
  Loader2,
  Sparkles,
  Square
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import {
  groupWorkflowAgentsByPhase,
  type WorkflowAgentView,
  type WorkflowRunView
} from "@/lib/workflow-run-view"
import { WorkflowRunsDialog } from "./WorkflowRunsDialog"
import { WorkflowWorktreeList } from "./WorkflowWorktreeList"

/**
 * Live observability panel for a dynamic workflow run — the desktop
 * counterpart of Claude Code's `/workflows` live view. Phase groups with
 * per-agent drill-down (prompt / result / error / tokens / duration), a
 * narrator log tail, cancel for running runs, elapsed time, and an entry
 * point into the runs-history dialog. Survives renderer reloads (state is
 * hydrated from disk) because background runs outlive the launching turn.
 */

const MAX_VISIBLE_AGENTS_PER_PHASE = 30
const MAX_VISIBLE_LOGS = 6

interface WorkflowRunPanelProps {
  threadId: string
  run: WorkflowRunView
}

function statusBadge(run: WorkflowRunView): { label: string; className: string } {
  switch (run.status) {
    case "running":
      return {
        label: "运行中",
        className:
          "border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300"
      }
    case "completed":
      return {
        label: "已完成",
        className:
          "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300"
      }
    case "aborted":
      return {
        label: "已中止",
        className:
          "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200"
      }
    default:
      return {
        label: "失败",
        className:
          "border-red-200 bg-red-100 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300"
      }
  }
}

function AgentStatusIcon({ agent }: { agent: WorkflowAgentView }): JSX.Element {
  switch (agent.status) {
    case "running":
      return <Loader2 className="size-3 animate-spin text-violet-500" />
    case "completed":
      return <Check className="size-3 text-emerald-500" />
    case "cached":
      return <History className="size-3 text-sky-500" />
    default:
      return <CircleSlash className="size-3 text-red-500" />
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function AgentRow({
  agent,
  threadId,
  runId
}: {
  agent: WorkflowAgentView
  threadId: string
  runId: string
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const openWorkflowAgentFocusView = useAppStore((state) => state.openWorkflowAgentFocusView)
  const hasDetail = Boolean(agent.promptPreview || agent.resultPreview || agent.error)
  const openToolStream = (): void =>
    openWorkflowAgentFocusView({
      threadId,
      runId,
      agentIndex: agent.agentIndex,
      label: agent.label,
      status: agent.status
    })
  return (
    <div className="rounded-md transition-colors hover:bg-violet-50/60 dark:hover:bg-violet-500/10">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((value) => !value)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-left text-[11px] leading-5",
            hasDetail ? "cursor-pointer" : "cursor-default"
          )}
          title={hasDetail ? "点击查看该子代理的指令与结果" : undefined}
        >
          <AgentStatusIcon agent={agent} />
          <span className="min-w-0 flex-1 truncate text-foreground/80">{agent.label}</span>
          {agent.status === "cached" && (
            <span className="shrink-0 text-[10px] text-sky-500">缓存</span>
          )}
          {agent.durationMs > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatDuration(agent.durationMs)}
            </span>
          )}
          {agent.outputTokens > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {agent.outputTokens}tk
            </span>
          )}
          {hasDetail && (
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90"
              )}
            />
          )}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            openToolStream()
          }}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-violet-100/70 hover:text-violet-600 dark:hover:bg-violet-500/20 dark:hover:text-violet-300"
          title="查看该子代理的实时工具流"
          aria-label="查看该子代理的实时工具流"
        >
          <Code2 className="size-3" />
        </button>
      </div>
      {expanded && (
        <div className="space-y-1 px-2 pb-1.5 pt-0.5">
          {agent.promptPreview && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">指令</div>
              <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 text-[10px] leading-4 text-foreground/80">
                {agent.promptPreview}
              </pre>
            </div>
          )}
          {agent.resultPreview && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">结果</div>
              <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 text-[10px] leading-4 text-foreground/80">
                {agent.resultPreview}
              </pre>
            </div>
          )}
          {agent.error && (
            <div>
              <div className="text-[10px] font-medium text-red-500">错误</div>
              <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-red-50 p-1.5 text-[10px] leading-4 text-red-700 dark:bg-red-500/10 dark:text-red-300">
                {agent.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PhaseGroup({
  phase,
  agents,
  isCurrent,
  threadId,
  runId
}: {
  phase: string | null
  agents: WorkflowAgentView[]
  isCurrent: boolean
  threadId: string
  runId: string
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const done = agents.filter((agent) => agent.status !== "running").length
  const visibleAgents = collapsed ? [] : agents.slice(-MAX_VISIBLE_AGENTS_PER_PHASE)
  const hiddenCount = collapsed ? 0 : Math.max(0, agents.length - visibleAgents.length)

  return (
    <div className="rounded-lg border border-border/60 bg-background/60">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {collapsed ? (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "truncate text-xs font-medium",
            isCurrent ? "text-violet-600 dark:text-violet-300" : "text-foreground"
          )}
        >
          {phase ?? "未分组"}
        </span>
        {agents.length > 0 && (
          <span className="ml-1 h-1 max-w-16 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-violet-400 transition-all dark:bg-violet-500"
              style={{ width: `${Math.round((done / agents.length) * 100)}%` }}
            />
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {done}/{agents.length}
        </span>
      </button>
      {!collapsed && agents.length > 0 && (
        <div className="space-y-0.5 px-1.5 pb-1.5">
          {hiddenCount > 0 && (
            <div className="px-1 text-[10px] text-muted-foreground">
              … {hiddenCount} 个较早的子代理已折叠(可在运行历史中查看全部)
            </div>
          )}
          {visibleAgents.map((agent) => (
            <AgentRow key={agent.agentIndex} agent={agent} threadId={threadId} runId={runId} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Isolated elapsed clock — owns its own per-second state so only this tiny node
 * re-renders each tick, not the whole panel (which holds the phase/agent tree).
 */
function ElapsedClock({ startedAtMs }: { startedAtMs: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <>{` · 已运行 ${formatDuration(Math.max(0, now - startedAtMs))}`}</>
}

export const WorkflowRunPanel = memo(WorkflowRunPanelImpl)

function WorkflowRunPanelImpl({ threadId, run }: WorkflowRunPanelProps): JSX.Element {
  const badge = statusBadge(run)
  // Recompute the phase grouping only when the run object changes (a new
  // progress event), not on unrelated re-renders. `run` is replaced wholesale by
  // the reducer on each update, so depending on it is correct and exhaustive.
  const groups = useMemo(() => groupWorkflowAgentsByPhase(run), [run])
  const runningCount = run.agents.filter((agent) => agent.status === "running").length
  const doneCount = run.agents.length - runningCount
  const visibleLogs = run.logs.slice(-MAX_VISIBLE_LOGS)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // Tool-stream capture is no longer run-level: the focus panel loads ONE agent on
  // demand (live frames if running, the persisted sidecar if finished) and releases it
  // on switch/close, so nothing is buffered here. The "</>" button just opens the focus.

  const handleCancel = async (): Promise<void> => {
    setCancelling(true)
    try {
      const cancelled = await window.api.workflows.cancelRun(threadId, run.runId)
      if (!cancelled) toast.info("该工作流已不在运行中")
    } catch (error) {
      console.warn("[WorkflowRunPanel] Cancel failed:", error)
      toast.error("取消工作流失败,请重试")
    } finally {
      setCancelling(false)
    }
  }

  const handleCopyRunId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(run.runId)
      toast.success("已复制 runId")
    } catch {
      toast.error("复制失败")
    }
  }

  return (
    <div className="mx-1 my-2 overflow-hidden rounded-xl border border-violet-200/70 bg-violet-50/40 shadow-sm dark:border-violet-500/20 dark:bg-violet-500/5">
      <div className="flex items-center gap-2 border-b border-violet-200/60 px-3 py-2 dark:border-violet-500/20">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-violet-500 text-white">
          {run.status === "running" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-foreground">{run.name}</span>
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
                badge.className
              )}
            >
              {badge.label}
            </span>
            {run.resumed && (
              <span className="shrink-0 rounded-full border border-sky-200 bg-sky-100 px-1.5 py-0.5 text-[10px] leading-none text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300">
                续跑
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
            <button
              type="button"
              onClick={handleCopyRunId}
              className="inline-flex items-center gap-0.5 hover:text-foreground"
              title="复制 runId"
            >
              {run.runId}
              <Copy className="size-2.5" />
            </button>
            <span>
              · 子代理 {doneCount}/{run.agents.length}
              {runningCount > 0 ? ` · ${runningCount} 个运行中` : ""}
              {run.status === "running" && <ElapsedClock startedAtMs={run.startedAtMs} />}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="查看本线程的工作流运行历史与完整明细"
        >
          <History className="size-3" />
          运行历史
        </button>
        {run.status === "running" && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-1.5 py-1 text-[10px] text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
            title="中止后台工作流（普通子代理可从 journal 回放；worktree 子代理续跑时会新建 worktree）"
          >
            <Square className="size-3" />
            {cancelling ? "取消中…" : "取消"}
          </button>
        )}
      </div>

      {run.status === "error" && run.error && (
        <div className="flex items-start gap-1.5 border-b border-red-200/60 bg-red-50/60 px-3 py-1.5 text-[11px] leading-5 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{run.error}</span>
        </div>
      )}

      {run.status !== "error" && run.warning && (
        <div className="flex items-start gap-1.5 border-b border-amber-200/60 bg-amber-50/60 px-3 py-1.5 text-[11px] leading-5 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{run.warning}</span>
        </div>
      )}

      {run.worktrees.length > 0 && (
        <div className="space-y-1 border-b border-violet-200/60 p-2 dark:border-violet-500/20">
          <div className="px-0.5 text-[10px] font-medium text-muted-foreground">
            Worktree 交付物 ({run.worktrees.length})
          </div>
          <WorkflowWorktreeList
            threadId={threadId}
            runId={run.runId}
            worktrees={run.worktrees}
            manageAllowed={run.status !== "running"}
          />
        </div>
      )}

      {groups.length > 0 && (
        <div className="max-h-72 space-y-1.5 overflow-y-auto p-2">
          {groups.map((group) => (
            <PhaseGroup
              key={group.phase ?? "__none__"}
              phase={group.phase}
              agents={group.agents}
              isCurrent={run.status === "running" && group.phase === run.currentPhase}
              threadId={threadId}
              runId={run.runId}
            />
          ))}
        </div>
      )}

      {visibleLogs.length > 0 && (
        <div className="space-y-0.5 border-t border-violet-200/60 px-3 py-1.5 dark:border-violet-500/20">
          {visibleLogs.map((message, index) => (
            <div
              key={`${run.logs.length - visibleLogs.length + index}`}
              className="truncate text-[10px] leading-4 text-muted-foreground"
              title={message}
            >
              {message}
            </div>
          ))}
        </div>
      )}

      {run.stats && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-violet-200/60 px-3 py-1.5 text-[10px] tabular-nums text-muted-foreground dark:border-violet-500/20">
          <span>共 {run.stats.agentsTotal} 个子代理</span>
          {run.stats.agentsCached > 0 && <span>缓存复用 {run.stats.agentsCached}</span>}
          {run.stats.agentsFailed > 0 && (
            <span className="text-red-500">失败 {run.stats.agentsFailed}</span>
          )}
          <span>输出 {run.stats.outputTokens.toLocaleString()} tokens</span>
          <span>{formatDuration(run.stats.durationMs)}</span>
        </div>
      )}

      <WorkflowRunsDialog threadId={threadId} open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  )
}

/**
 * Standalone "run history" entry for workflow-mode threads that have NO live run
 * panel (the finished panel is cleared on the next message). Without this, the only
 * WorkflowRunsDialog entry lives inside WorkflowRunPanel, so once the finished panel
 * is gone the user can't reach past runs even though they're still on disk. (#4)
 */
export const WorkflowHistoryButton = memo(WorkflowHistoryButtonImpl)

function WorkflowHistoryButtonImpl({ threadId }: { threadId: string }): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false)
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => setHistoryOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="查看本线程的工作流运行历史与完整明细"
      >
        <History className="size-3" />
        运行历史
      </button>
      <WorkflowRunsDialog threadId={threadId} open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  )
}
