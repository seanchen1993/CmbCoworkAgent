export interface DehydrationCoordinatorWorker {
  status: "running" | "completed" | "failed" | "cancelled"
  notification_acknowledged?: boolean
  suppress_notification_auto_run?: boolean
}

export interface SpecialThreadActivity {
  scheduledTaskLoading: boolean
  goalStatus?: "active" | "paused" | "complete"
  workflowStatus?: "running" | "completed" | "error" | "aborted"
  coordinatorWorkers: readonly DehydrationCoordinatorWorker[]
}

/** Terminal task metadata is cheap and recoverable; only unfinished work or an
 * unacknowledged coordinator result must keep the hydrated task resident. */
export function hasBlockingSpecialThreadActivity(activity: SpecialThreadActivity): boolean {
  if (activity.scheduledTaskLoading) return true
  if (activity.goalStatus === "active") return true
  if (activity.workflowStatus === "running") return true
  return activity.coordinatorWorkers.some(
    (worker) =>
      worker.status === "running" ||
      (worker.notification_acknowledged !== true &&
        worker.suppress_notification_auto_run !== true)
  )
}

/** Heavy, durable-or-reconstructable state released by the idle holder LRU. */
export function createDehydratedThreadStatePatch() {
  return {
    messages: [] as never[],
    messagesContentVersion: 0,
    goalUi: { goal: null, events: [] as never[], lastUpdated: null },
    todos: [] as never[],
    workspaceFiles: [] as never[],
    subagents: [] as never[],
    subagentTranscripts: {} as Record<string, never>,
    subagentTranscriptContentVersions: {} as Record<string, number>,
    subagentTranscriptsRevision: 0,
    subagentTranscriptBaselineReady: false,
    coordinatorWorkers: [] as never[],
    subagentToolCallCount: 0,
    subagentInternalLogs: [] as never[],
    toolCallStates: {} as Record<string, never>,
    approvalQueue: [] as never[],
    openFiles: [] as never[],
    activeTab: "agent" as const,
    fileContents: {} as Record<string, string>,
    tokenUsage: null,
    harnessAgentmdLoadStatus: null,
    contextCompaction: null,
    workflowRun: null,
    historyLoading: false,
    historyPageLoading: false,
    historyHasMore: false,
    historyPageCursor: null,
    historyMessageTotal: 0,
    historyLoadedMessageCount: 0
  }
}
