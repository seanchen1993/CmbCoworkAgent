import { AsyncKeyedLock } from "./async-keyed-lock"
import { getThreadCore, type ThreadSummaryRow } from "../db"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnation
} from "../services/thread-incarnation"

export const THREAD_RUN_MUTATION_MAX_WAITERS_PER_THREAD = 128
export const THREAD_RUN_MUTATION_MAX_WAITERS_TOTAL = 1_024

const threadRunMutationLock = new AsyncKeyedLock({
  maxWaitersPerKey: THREAD_RUN_MUTATION_MAX_WAITERS_PER_THREAD,
  maxWaitersTotal: THREAD_RUN_MUTATION_MAX_WAITERS_TOTAL,
  label: "Thread mutation queue"
})

let cancelBackgroundMutation: ((threadId: string) => Promise<void>) | undefined
const foregroundCheckpointOpens = new Map<string, number>()
const publishingThreads = new Set<string>()

export function stageThreadPublication(threadId: string): () => void {
  publishingThreads.add(threadId)
  return () => {
    publishingThreads.delete(threadId)
  }
}

export function isThreadPublicationPending(threadId: string): boolean {
  return publishingThreads.has(threadId)
}

export function registerBackgroundThreadMutationCancellation(
  cancel: (threadId: string) => Promise<void>
) {
  cancelBackgroundMutation = cancel
}

export async function preemptBackgroundThreadMutation(threadId: string): Promise<void> {
  await cancelBackgroundMutation?.(threadId)
}

export function pinForegroundCheckpointOpen(threadId: string): () => void {
  foregroundCheckpointOpens.set(threadId, (foregroundCheckpointOpens.get(threadId) ?? 0) + 1)
  return () => {
    const remaining = (foregroundCheckpointOpens.get(threadId) ?? 1) - 1
    if (remaining) foregroundCheckpointOpens.set(threadId, remaining)
    else foregroundCheckpointOpens.delete(threadId)
  }
}

export function isForegroundCheckpointOpening(threadId: string): boolean {
  return foregroundCheckpointOpens.has(threadId)
}

export function tryBackgroundThreadMutationLock<T>(
  threadId: string,
  operation: () => Promise<T>
): Promise<T> | undefined {
  if (threadRunMutationLock.has(threadId)) return undefined
  return threadRunMutationLock.withKey(threadId, operation)
}

export function withThreadRunMutationLock<T>(
  threadId: string,
  operation: () => Promise<T>
): Promise<T> {
  void cancelBackgroundMutation?.(threadId)
  return threadRunMutationLock.withKey(threadId, operation)
}

export interface ThreadMutationLease {
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
}

export class ThreadMutationLeaseExpiredError extends Error {
  constructor(threadId: string) {
    super(`Thread changed while the request was queued: ${threadId}`)
    this.name = "ThreadMutationLeaseExpiredError"
  }
}

/** Capture before any await so an old queued request cannot target a same-id replacement row. */
export function captureThreadMutationLease(threadId: string): ThreadMutationLease | null {
  const row = getThreadCore(threadId)
  if (!row) return null
  return { threadId, incarnation: captureThreadIncarnation(row) }
}

export function requireThreadMutationLease(
  threadId: string,
  notFoundMessage = "Thread not found"
): ThreadMutationLease {
  const lease = captureThreadMutationLease(threadId)
  if (!lease) throw new Error(notFoundMessage)
  return lease
}

export function isThreadMutationLeaseCurrent(lease: ThreadMutationLease): boolean {
  return matchesThreadIncarnation(getThreadCore(lease.threadId), lease.incarnation)
}

/**
 * Lock ordering contract: callers acquire any workflow transition lease first, then call this.
 * The row is re-read inside the same-thread lock and passed to a continuation with no ABA window.
 */
export function withThreadMutationLeaseLock<T>(
  lease: ThreadMutationLease,
  operation: (row: ThreadSummaryRow) => Promise<T> | T
): Promise<T> {
  return withThreadRunMutationLock(lease.threadId, async () => {
    const row = getThreadCore(lease.threadId)
    if (!row || !matchesThreadIncarnation(row, lease.incarnation)) {
      throw new ThreadMutationLeaseExpiredError(lease.threadId)
    }
    return operation(row)
  })
}
