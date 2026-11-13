import type { Thread } from "../types"

interface ThreadDirectoryIncarnation {
  readonly threadId: string
  readonly createdAt: number
  readonly token: string | null
}

/** Small copied display identity. It never grants Main execution or read access. */
export function captureThreadDirectoryIncarnation(
  thread: Thread | undefined
): ThreadDirectoryIncarnation | undefined {
  if (!thread) return undefined
  const createdAt = thread.created_at instanceof Date
    ? thread.created_at.getTime() : new Date(thread.created_at).getTime()
  const value = thread.metadata?.cmb_thread_incarnation
  if (!Number.isFinite(createdAt) || createdAt < 0 ||
    (typeof value === "string" && value.length > 512)) return undefined
  return { threadId: thread.thread_id, createdAt,
    token: typeof value === "string" && value ? value : null }
}

export function sameThreadDirectoryIncarnation(
  first: ThreadDirectoryIncarnation | undefined,
  second: ThreadDirectoryIncarnation | undefined
): boolean {
  return !!first && !!second && first.threadId === second.threadId &&
    first.createdAt === second.createdAt && first.token === second.token
}

/** Compare inside the actual store commit. A fresh host reply matching the
 * current row is still useful after a legacy token promotion or directory read.
 * Workspace/title/revision/object changes in the same incarnation do not veto it.
 */
export function canPublishThreadDirectoryReply(
  original: ThreadDirectoryIncarnation | undefined,
  current: Thread,
  returned: Thread
): boolean {
  const currentScope = captureThreadDirectoryIncarnation(current)
  const returnedScope = captureThreadDirectoryIncarnation(returned)
  return !!original && current.thread_id === returned.thread_id && !!returnedScope &&
    (sameThreadDirectoryIncarnation(original, currentScope) ||
      sameThreadDirectoryIncarnation(returnedScope, currentScope))
}
