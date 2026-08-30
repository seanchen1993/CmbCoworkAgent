/**
 * Renderer view model for a dynamic workflow run, built incrementally from
 * `workflow_progress` custom stream events emitted by the main process.
 */

export interface WorkflowAgentView {
  agentIndex: number
  label: string
  phase: string | null
  status: "running" | "completed" | "error" | "cached"
  outputTokens: number
  durationMs: number
  error?: string
  /** Truncated prompt — drill-down: what this agent was asked. */
  promptPreview?: string
  /** Truncated final text — drill-down: what it returned. */
  resultPreview?: string
}

export interface WorkflowRunStatsView {
  agentsTotal: number
  agentsCached: number
  agentsFailed: number
  outputTokens: number
  durationMs: number
}

export type WorkflowWorktreeStatusView =
  | "provisioning"
  | "running"
  | "ready"
  | "recoverable"
  | "integrating"
  | "merged"
  | "discarded"

export interface WorkflowWorktreeView {
  id: string
  branch: string
  /** Actual linked-worktree root; may differ from the agent's scoped workspace. */
  directory: string
  workspaceDirectory: string
  dirty: boolean
  status: WorkflowWorktreeStatusView
  cleanupPending?: boolean
  error?: string
  updatedAt: string
}

export function newerWorkflowWorktree(
  current: WorkflowWorktreeView,
  incoming: WorkflowWorktreeView
): WorkflowWorktreeView {
  const currentTerminal = current.status === "merged" || current.status === "discarded"
  const incomingTerminal = incoming.status === "merged" || incoming.status === "discarded"
  if (currentTerminal) {
    if (incoming.status !== current.status) return current
    return incoming.updatedAt >= current.updatedAt ? incoming : current
  }
  if (incomingTerminal) return incoming
  return incoming.updatedAt >= current.updatedAt ? incoming : current
}

export interface WorkflowRunView {
  runId: string
  name: string
  description: string
  status: "running" | "completed" | "error" | "aborted"
  resumed: boolean
  /** Declared phases first, then phases discovered at runtime, in order. */
  phases: string[]
  currentPhase: string | null
  agents: WorkflowAgentView[]
  worktrees: WorkflowWorktreeView[]
  logs: string[]
  error?: string
  /** Non-fatal advisory (e.g. completed but ran 0 agents). */
  warning?: string
  stats: WorkflowRunStatsView | null
  startedAtMs: number
}

const MAX_VIEW_LOGS = 200
const MAX_VIEW_AGENTS = 1200

export interface WorkflowProgressEventView {
  kind: string
  runId?: string
  [key: string]: unknown
}

export function applyWorkflowProgressEvent(
  previous: WorkflowRunView | null,
  event: WorkflowProgressEventView
): WorkflowRunView | null {
  if (!event || typeof event !== "object" || typeof event.kind !== "string") return previous
  const runId = typeof event.runId === "string" ? event.runId : null
  if (!runId) return previous

  if (event.kind === "started") {
    return {
      runId,
      name: typeof event.name === "string" ? event.name : "workflow",
      description: typeof event.description === "string" ? event.description : "",
      status: "running",
      resumed: event.resumed === true,
      phases: Array.isArray(event.phases)
        ? event.phases.filter((phase): phase is string => typeof phase === "string")
        : [],
      currentPhase: null,
      agents: [],
      worktrees: Array.isArray(event.worktrees)
        ? event.worktrees
            .map((worktree) => toWorktreeView(worktree))
            .filter((worktree): worktree is WorkflowWorktreeView => worktree !== null)
        : [],
      logs: [],
      stats: null,
      startedAtMs: Date.now()
    }
  }

  // All other events require a matching live run.
  if (!previous || previous.runId !== runId) return previous

  switch (event.kind) {
    case "phase": {
      const title = typeof event.title === "string" ? event.title : null
      if (!title) return previous
      return {
        ...previous,
        currentPhase: title,
        phases: previous.phases.includes(title) ? previous.phases : [...previous.phases, title]
      }
    }
    case "log": {
      const message = typeof event.message === "string" ? event.message : null
      if (message === null) return previous
      const logs = [...previous.logs, message]
      if (logs.length > MAX_VIEW_LOGS) logs.splice(0, logs.length - MAX_VIEW_LOGS)
      return { ...previous, logs }
    }
    case "agent_start": {
      const agent = toAgentView(event, "running")
      if (!agent) return previous
      return { ...previous, agents: upsertAgent(previous.agents, agent) }
    }
    case "agent_end": {
      const status = event.status
      if (status !== "completed" && status !== "error" && status !== "cached") return previous
      const agent = toAgentView(event, status)
      if (!agent) return previous
      return { ...previous, agents: upsertAgent(previous.agents, agent) }
    }
    case "worktree_update": {
      const worktree = toWorktreeView(event.worktree)
      if (!worktree) return previous
      const index = previous.worktrees.findIndex((candidate) => candidate.id === worktree.id)
      if (index < 0) return { ...previous, worktrees: [...previous.worktrees, worktree] }
      const worktrees = [...previous.worktrees]
      worktrees[index] = newerWorkflowWorktree(worktrees[index], worktree)
      return { ...previous, worktrees }
    }
    case "worktree_remove": {
      if (typeof event.worktreeId !== "string") return previous
      return {
        ...previous,
        worktrees: previous.worktrees.filter((candidate) => candidate.id !== event.worktreeId)
      }
    }
    case "finished": {
      const status =
        event.status === "completed" || event.status === "error" || event.status === "aborted"
          ? event.status
          : "error"
      const stats = toStatsView(event.stats)
      return {
        ...previous,
        status,
        error: typeof event.error === "string" ? event.error : undefined,
        warning: typeof event.warning === "string" ? event.warning : undefined,
        stats,
        // A finished run has no in-flight agents; normalize stragglers.
        agents: previous.agents.map((agent) =>
          agent.status === "running"
            ? { ...agent, status: status === "completed" ? "completed" : "error" }
            : agent
        )
      }
    }
    default:
      return previous
  }
}

const WORKTREE_STATUSES = new Set<WorkflowWorktreeStatusView>([
  "provisioning",
  "running",
  "ready",
  "recoverable",
  "integrating",
  "merged",
  "discarded"
])

export function toWorktreeView(value: unknown): WorkflowWorktreeView | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== "string" ||
    typeof record.branch !== "string" ||
    typeof record.directory !== "string" ||
    typeof record.workspaceDirectory !== "string" ||
    typeof record.dirty !== "boolean" ||
    typeof record.status !== "string" ||
    !WORKTREE_STATUSES.has(record.status as WorkflowWorktreeStatusView) ||
    typeof record.updatedAt !== "string"
  ) {
    return null
  }
  return {
    id: record.id,
    branch: record.branch,
    directory: record.directory,
    workspaceDirectory: record.workspaceDirectory,
    dirty: record.dirty,
    status: record.status as WorkflowWorktreeStatusView,
    cleanupPending: record.cleanupPending === true,
    error: typeof record.error === "string" ? record.error : undefined,
    updatedAt: record.updatedAt
  }
}

function toAgentView(
  event: WorkflowProgressEventView,
  status: WorkflowAgentView["status"]
): WorkflowAgentView | null {
  const agentIndex = typeof event.agentIndex === "number" ? event.agentIndex : null
  if (agentIndex === null) return null
  return {
    agentIndex,
    label: typeof event.label === "string" ? event.label : `agent ${agentIndex}`,
    phase: typeof event.phase === "string" ? event.phase : null,
    status,
    outputTokens: typeof event.outputTokens === "number" ? event.outputTokens : 0,
    durationMs: typeof event.durationMs === "number" ? event.durationMs : 0,
    error: typeof event.error === "string" ? event.error : undefined,
    promptPreview: typeof event.promptPreview === "string" ? event.promptPreview : undefined,
    resultPreview: typeof event.resultPreview === "string" ? event.resultPreview : undefined
  }
}

function upsertAgent(agents: WorkflowAgentView[], next: WorkflowAgentView): WorkflowAgentView[] {
  const index = agents.findIndex((agent) => agent.agentIndex === next.agentIndex)
  if (index >= 0) {
    const merged = [...agents]
    merged[index] = {
      ...merged[index],
      ...next,
      promptPreview: next.promptPreview ?? merged[index].promptPreview,
      resultPreview: next.resultPreview ?? merged[index].resultPreview
    }
    return merged
  }
  const appended = [...agents, next]
  if (appended.length > MAX_VIEW_AGENTS) appended.splice(0, appended.length - MAX_VIEW_AGENTS)
  return appended
}

function toStatsView(stats: unknown): WorkflowRunStatsView | null {
  if (!stats || typeof stats !== "object") return null
  const record = stats as Record<string, unknown>
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0
  return {
    agentsTotal: num(record.agentsTotal),
    agentsCached: num(record.agentsCached),
    agentsFailed: num(record.agentsFailed),
    outputTokens: num(record.outputTokens),
    durationMs: num(record.durationMs)
  }
}

/** Groups agents under their phase for display; phaseless agents go last. */
export function groupWorkflowAgentsByPhase(
  view: WorkflowRunView
): Array<{ phase: string | null; agents: WorkflowAgentView[] }> {
  const order: Array<string | null> = [...view.phases]
  const groups = new Map<string | null, WorkflowAgentView[]>()
  for (const phase of order) groups.set(phase, [])
  for (const agent of view.agents) {
    const key = agent.phase
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(agent)
  }
  return order
    .map((phase) => ({ phase, agents: groups.get(phase) ?? [] }))
    .filter((group) => group.agents.length > 0 || group.phase !== null)
}

/** Renderer-side mirror of the persisted run file (main process schema). */
export interface PersistedWorkflowRunDTO {
  runId: string
  workflowName: string
  description?: string
  status: "running" | "completed" | "error" | "aborted"
  phases: string[]
  currentPhase: string | null
  agents: Array<{
    index: number
    label: string
    phase: string | null
    status: "running" | "completed" | "error" | "cached"
    error?: string
    outputTokens: number
    startedAt: string
    endedAt?: string
    promptPreview?: string
    resultPreview?: string
  }>
  worktrees?: WorkflowWorktreeView[]
  logs: string[]
  result?: unknown
  error?: string
  warning?: string
  stats: WorkflowRunStatsView
  startedAt: string
  completedAt?: string
  script?: string
  resumed?: boolean
}

export interface WorkflowRunSummaryDTO {
  runId: string
  workflowName: string
  description?: string
  status: "running" | "completed" | "error" | "aborted"
  stats: WorkflowRunStatsView
  startedAt: string
  completedAt?: string
  agentCount: number
  notificationDelivered?: boolean
}

/** Rebuilds the live panel view from a persisted run (renderer reload / app restart). */
/**
 * Merge a hydrated (persisted) run into the live panel state on reload/reconnect.
 * Keep the fresher LIVE state only when BOTH sides are still running; if hydrate
 * brings back a TERMINAL status (completed/error/aborted), adopt it even over a
 * local "running" — otherwise a dropped terminal event strands the panel on a
 * running spinner with a dead cancel button. (Caller guarantees same runId.)
 */
export function reconcileHydratedWorkflowRun(
  prev: WorkflowRunView | null | undefined,
  restored: WorkflowRunView
): WorkflowRunView {
  if (prev?.status === "running" && restored.status === "running") return prev
  return restored
}

export function workflowRunViewFromPersisted(run: PersistedWorkflowRunDTO): WorkflowRunView {
  const startedAtMs = Date.parse(run.startedAt)
  return {
    runId: run.runId,
    name: run.workflowName,
    description: run.description ?? "",
    status: run.status,
    // Persisted on the run since launch (see PersistedWorkflowRun.resumed); a fresh
    // run's grown journal must NOT be mistaken for a resume after reload.
    resumed: run.resumed === true,
    phases: [...run.phases],
    currentPhase: run.currentPhase,
    agents: run.agents.map((agent) => ({
      agentIndex: agent.index,
      label: agent.label,
      phase: agent.phase,
      status: agent.status,
      outputTokens: agent.outputTokens,
      durationMs:
        agent.endedAt && agent.startedAt
          ? Math.max(0, Date.parse(agent.endedAt) - Date.parse(agent.startedAt))
          : 0,
      error: agent.error,
      promptPreview: agent.promptPreview,
      resultPreview: agent.resultPreview
    })),
    worktrees: (run.worktrees ?? [])
      .map((worktree) => toWorktreeView(worktree))
      .filter((worktree): worktree is WorkflowWorktreeView => worktree !== null),
    logs: [...run.logs],
    error: run.error,
    warning: run.warning,
    stats: run.status === "running" ? null : run.stats,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now()
  }
}
