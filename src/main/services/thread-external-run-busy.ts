import { LocalSandbox } from "../agent/local-sandbox"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import { isHeartbeatRunning } from "./heartbeat"
import { HEARTBEAT_THREAD_ID } from "./heartbeat-session"
import { isTaskRunning } from "./scheduler"

function hasActiveThreadServiceRun(threadId: string, metadata: Record<string, unknown>): boolean {
  if (threadId === HEARTBEAT_THREAD_ID && isHeartbeatRunning()) return true
  const scheduledTaskId =
    typeof metadata.scheduledTaskId === "string" ? metadata.scheduledTaskId.trim() : ""
  return Boolean(scheduledTaskId && isTaskRunning(scheduledTaskId))
}

/** Owners whose runs must keep executing when a desktop deletion is refused. */
export function hasExternalThreadRunOwner(
  threadId: string,
  metadata: Record<string, unknown>
): boolean {
  const lease = getLocalThreadRunLease(threadId)
  if (lease && lease.owner !== "desktop") return true
  return hasActiveThreadServiceRun(threadId, metadata)
}

/**
 * Owner-managed runtimes do not participate in agent.ts's foreground activeRuns
 * registry. Destructive operations must consult every owner before treating an
 * unloaded thread as idle; renderer stream state is only a best-effort hint.
 */
export function isExternallyManagedThreadRunBusy(
  threadId: string,
  metadata: Record<string, unknown>
): boolean {
  return (
    Boolean(getLocalThreadRunLease(threadId)) ||
    hasActiveThreadServiceRun(threadId, metadata) ||
    LocalSandbox.hasActiveBackgroundTasks(threadId)
  )
}
