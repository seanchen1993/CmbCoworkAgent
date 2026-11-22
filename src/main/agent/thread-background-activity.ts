import { coordinatorWorkerManager } from "./coordinator-worker-manager"
import { workflowRunManager } from "./workflow/run-manager"

export interface ThreadBackgroundActivity {
  phase: "running" | "pending_results" | "idle"
  label: string
}

export interface ThreadBackgroundReaders {
  coordinator: Pick<
    typeof coordinatorWorkerManager,
    | "hasRunningWorkersForThread"
    | "hasTerminalWorkerAwaitingNotificationForThread"
    | "hasAutoRunnableNotifications"
  >
  workflow: Pick<typeof workflowRunManager, "isActive" | "isBusyForThreadAsync">
}

const readers: ThreadBackgroundReaders = {
  coordinator: coordinatorWorkerManager,
  workflow: workflowRunManager
}

/** Shared by Feature and IM status reads. A finished parent can still own live children/results. */
export async function readThreadBackgroundActivity(
  threadId: string,
  workspacePath: string | undefined,
  dependencies: ThreadBackgroundReaders = readers,
  discoverWorkflowResults = true
): Promise<ThreadBackgroundActivity> {
  const live = (): ThreadBackgroundActivity | undefined => {
    if (dependencies.coordinator.hasRunningWorkersForThread(threadId))
      return { phase: "running", label: "Team 子代理执行中" }
    if (dependencies.workflow.isActive(threadId))
      return { phase: "running", label: "Workflow 子任务执行中" }
    if (
      dependencies.coordinator.hasTerminalWorkerAwaitingNotificationForThread(threadId) ||
      dependencies.coordinator.hasAutoRunnableNotifications(threadId)
    )
      return { phase: "pending_results", label: "Team 子任务结果待汇总" }
    return undefined
  }
  const current = live()
  if (current) return current
  // Uses the manager's compact result index, not transcripts or retained historical runs.
  const pending =
    discoverWorkflowResults &&
    !!workspacePath &&
    (await dependencies.workflow.isBusyForThreadAsync(threadId, workspacePath))
  // A new child may have started while the index was being read.
  return (
    live() ??
    (pending
      ? { phase: "pending_results", label: "Workflow 结果待汇总" }
      : { phase: "idle", label: "空闲" })
  )
}
