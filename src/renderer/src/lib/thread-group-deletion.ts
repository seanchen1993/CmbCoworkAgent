export interface ThreadDeletionState {
  hasRunningCoordinatorWorker?: boolean
  workflowRunning?: boolean
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
      threadState?.hasRunningCoordinatorWorker ||
      threadState?.coordinatorWorkers?.some((worker) => worker.status === "running") ||
      threadState?.scheduledTaskLoading ||
      threadState?.workflowRunning ||
      threadState?.workflowRun?.status === "running"
    ) {
      return true
    }
  }

  return false
}

export interface ThreadGroupDeletionResult {
  deletedIds: string[]
  remainingIds: string[]
  failedId?: string
  error?: unknown
}

export function runBestEffortCommittedDeletionCleanups(
  cleanups: ReadonlyArray<{ label: string; run: () => void }>,
  onError: (label: string, error: unknown) => void = (label, error) =>
    console.warn(`[ThreadDeletion] ${label}:`, error)
): void {
  for (const cleanup of cleanups) {
    try {
      cleanup.run()
    } catch (error) {
      onError(cleanup.label, error)
    }
  }
}

export function cleanupDeletedThreadIfResident(
  threadId: string,
  threadStates: Record<string, ThreadDeletionState | undefined>,
  cleanupThread: (threadId: string) => void
): void {
  // The authoritative selector can return thousands of rows that were never
  // hydrated in this renderer. Running the full ThreadProvider cleanup for
  // those ids creates one generation entry and one unbind IPC per id despite
  // there being no local runtime to release.
  if (threadStates[threadId] === undefined) return
  cleanupThread(threadId)
}

export async function deleteThreadGroupSequentially(
  threadIds: Iterable<string>,
  handlers: {
    deleteThread: (threadId: string) => Promise<void>
    cleanupThread: (threadId: string) => void
    markRead: (threadId: string) => void
  }
): Promise<ThreadGroupDeletionResult> {
  const ids = Array.from(new Set(threadIds))
  const deletedIds: string[] = []
  for (let index = 0; index < ids.length; index += 1) {
    const threadId = ids[index]
    try {
      await handlers.deleteThread(threadId)
    } catch (error) {
      return {
        deletedIds,
        remainingIds: ids.slice(index),
        failedId: threadId,
        error
      }
    }

    // The backend deletion is the commit boundary. Record it before local
    // bookkeeping so a renderer-only cleanup failure can never make this ID
    // look retryable after its database row is already gone.
    deletedIds.push(threadId)
    try {
      handlers.cleanupThread(threadId)
    } catch (error) {
      console.warn("[ThreadGroupDeletion] Failed to clean up deleted thread state:", {
        threadId,
        error
      })
    }
    try {
      handlers.markRead(threadId)
    } catch (error) {
      console.warn("[ThreadGroupDeletion] Failed to clear deleted thread unread state:", {
        threadId,
        error
      })
    }
    // Keep a large group delete from becoming one uninterrupted IPC burst.
    // Each thread still uses the mature single-delete transaction, while the
    // macrotask boundary lets renderer frames and main-process events run.
    if (index < ids.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return { deletedIds, remainingIds: [] }
}
