interface ThreadDeletionRuntime {
  hasActiveRun: (threadId: string) => boolean
  isAborting: (threadId: string) => boolean
  waitForSettlement: (threadId: string) => Promise<string>
  hasExternalRun: (threadId: string) => boolean
  hasWorkflowRun: (threadId: string) => boolean
  hasWorkerRun: (threadId: string) => boolean
}

/** Deletion discards terminal results; unlike fork it needs no transcript or notification hydration.
 * Unresolved worktrees remain protected by performThreadDeletion's durable guard.
 */
export async function isThreadDeletionBusy(
  threadId: string,
  runtime: ThreadDeletionRuntime
): Promise<boolean> {
  if (runtime.hasActiveRun(threadId) && runtime.isAborting(threadId)) {
    if ((await runtime.waitForSettlement(threadId)) !== "settled") return true
  }
  return (
    runtime.hasActiveRun(threadId) ||
    runtime.hasExternalRun(threadId) ||
    runtime.hasWorkflowRun(threadId) ||
    runtime.hasWorkerRun(threadId)
  )
}
