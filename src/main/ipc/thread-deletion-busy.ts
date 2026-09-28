interface ThreadDeletionRuntime {
  hasActiveRun: (threadId: string) => boolean
  isAborting: (threadId: string) => boolean
  waitForSettlement: (threadId: string) => Promise<string>
  hasExternalRun: (threadId: string) => boolean
  hasWorkflowRun: (threadId: string) => boolean
  hasWorkerRun: (threadId: string) => boolean
}

/** A missing workspace is not a running task, but prevents verification of retained worktrees. */
export function assertThreadDeletionWorkspace(
  agentMode: "normal" | "coordinator" | "workflow",
  workspacePath: unknown
): void {
  if (agentMode !== "normal" && (typeof workspacePath !== "string" || !workspacePath.trim())) {
    throw new Error("会话缺少工作区路径，无法确认是否仍有未处理的工作树；请恢复工作区关联后重试。")
  }
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
