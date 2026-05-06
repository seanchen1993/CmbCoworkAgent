export interface SubagentInternalLogEntry {
  id: string
  kind: "tool_call" | "tool_result"
  title: string
  content: string
  result?: string
  status?: "waiting" | "completed"
  createdAt: string
  checkpointNs?: string
  toolCallId?: string
  toolName?: string
}

export interface CoordinatorWorkerView {
  worker_id: string
  worker_thread_id: string
  parent_thread_id: string
  role: "implementer" | "verifier"
  workload: "read_only" | "verify" | "write"
  owned_files: string[]
  description: string
  status: "running" | "completed" | "failed" | "cancelled"
  turns: number
  created_at: string
  updated_at: string
  last_started_at?: string
  last_activity_at?: string
  finished_at?: string
  summary?: string
  error?: string
  report_path?: string
  result_path?: string
  transcript_path?: string
  token_usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
  }
  tool_call_count: number
  last_tool_name?: string
  duration_ms?: number
  last_event: string
  notification_acknowledged?: boolean
  suppress_notification_auto_run?: boolean
}

export const MAX_COORDINATOR_WORKERS_IN_THREAD_STATE = 40

export function upsertSubagentLogEntry(
  logs: SubagentInternalLogEntry[],
  entry: SubagentInternalLogEntry
): SubagentInternalLogEntry[] {
  const existingIndex = logs.findIndex((log) => log.id === entry.id)
  if (existingIndex === -1) {
    return [...logs, entry].slice(-20)
  }

  const nextLogs = [...logs]
  const existing = nextLogs[existingIndex]
  nextLogs[existingIndex] = {
    ...existing,
    ...entry,
    content: entry.content || existing.content,
    result: entry.result ?? existing.result,
    status: entry.status ?? existing.status,
    toolName: entry.toolName || existing.toolName,
    title: entry.title || existing.title
  }
  return nextLogs.slice(-20)
}

export function mergeCoordinatorWorkers(
  existing: CoordinatorWorkerView[],
  incoming: CoordinatorWorkerView[],
  options: { authoritative?: boolean } = {}
): CoordinatorWorkerView[] {
  const baseWorkers = options.authoritative ? [] : existing
  const byId = new Map(baseWorkers.map((worker) => [worker.worker_id, worker]))
  for (const worker of incoming) {
    byId.set(worker.worker_id, {
      ...byId.get(worker.worker_id),
      ...worker
    })
  }
  const sorted = Array.from(byId.values()).sort(
    (a, b) => safeTimestamp(b.updated_at) - safeTimestamp(a.updated_at)
  )
  return limitCoordinatorWorkersForThreadState(sorted)
}

function limitCoordinatorWorkersForThreadState(
  workers: CoordinatorWorkerView[]
): CoordinatorWorkerView[] {
  if (workers.length <= MAX_COORDINATOR_WORKERS_IN_THREAD_STATE) return workers

  const running = workers
    .filter((worker) => worker.status === "running")
    .slice(0, MAX_COORDINATOR_WORKERS_IN_THREAD_STATE)
  const terminalLimit = Math.max(0, MAX_COORDINATOR_WORKERS_IN_THREAD_STATE - running.length)
  const pendingTerminal = workers.filter(
    (worker) => worker.status !== "running" && worker.notification_acknowledged === false
  )
  const terminal = workers.filter(
    (worker) => worker.status !== "running" && worker.notification_acknowledged !== false
  )
  const visibleTerminal = [...pendingTerminal, ...terminal].slice(0, terminalLimit)

  return [...running, ...visibleTerminal].sort(
    (a, b) => safeTimestamp(b.updated_at) - safeTimestamp(a.updated_at)
  )
}

function comparableCoordinatorWorker(worker: CoordinatorWorkerView): CoordinatorWorkerView {
  if (worker.status !== "running") return worker
  const stableWorker = { ...worker }
  delete stableWorker.duration_ms
  return stableWorker
}

export function coordinatorWorkersEqual(
  left: CoordinatorWorkerView[],
  right: CoordinatorWorkerView[]
): boolean {
  if (left.length !== right.length) return false
  return (
    JSON.stringify(left.map(comparableCoordinatorWorker)) ===
    JSON.stringify(right.map(comparableCoordinatorWorker))
  )
}

export function safeTimestamp(value: string | undefined): number {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}
