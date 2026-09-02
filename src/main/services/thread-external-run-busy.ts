import { LocalSandbox } from "../agent/local-sandbox"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import { isHeartbeatRunning } from "./heartbeat"
import { HEARTBEAT_THREAD_ID } from "./heartbeat-session"
import { isTaskRunning } from "./scheduler"

/**
 * Owner-managed runtimes do not participate in agent.ts's foreground activeRuns
 * registry. Destructive operations must consult every owner before treating an
 * unloaded thread as idle; renderer stream state is only a best-effort hint.
 */
export function isExternallyManagedThreadRunBusy(
  threadId: string,
  metadata: Record<string, unknown>
): boolean {
  if (getLocalThreadRunLease(threadId)) return true
  if (threadId === HEARTBEAT_THREAD_ID && isHeartbeatRunning()) return true

  const scheduledTaskId =
    typeof metadata.scheduledTaskId === "string" ? metadata.scheduledTaskId.trim() : ""
  if (scheduledTaskId && isTaskRunning(scheduledTaskId)) return true

  return LocalSandbox.hasActiveBackgroundTasks(threadId)
}
