export interface ThreadDeletionState {
  coordinatorWorkers?: Array<{ status?: string }>
  scheduledTaskLoading?: boolean
  workflowRun?: { status?: string } | null
}

export function hasRunningThreadForDeletion(
  threadIds: Iterable<string>,
  threadStates: Record<string, ThreadDeletionState | undefined>,
  streamLoadingStates: Record<string, boolean>
): boolean {
  for (const threadId of threadIds) {
    const threadState = threadStates[threadId]
    if (
      (streamLoadingStates[threadId] ?? false) ||
      threadState?.coordinatorWorkers?.some((worker) => worker.status === "running") ||
      threadState?.scheduledTaskLoading ||
      threadState?.workflowRun?.status === "running"
    ) {
      return true
    }
  }

  return false
}

export async function deleteThreadGroupSequentially(
  threadIds: Iterable<string>,
  handlers: {
    deleteThread: (threadId: string) => Promise<void>
    cleanupThread: (threadId: string) => void
    markRead: (threadId: string) => void
  }
): Promise<void> {
  for (const threadId of threadIds) {
    await handlers.deleteThread(threadId)
    handlers.cleanupThread(threadId)
    handlers.markRead(threadId)
  }
}
