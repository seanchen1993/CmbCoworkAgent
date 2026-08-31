import type { ThreadConversationPresence } from "./agent-mode-switch-availability"
import type { ThreadMessageWindowIntentKind } from "./thread-message-window-intent"

export interface ForegroundHydrationToken {
  threadId: string
  generation: number
}

export interface ThreadHistoryHydrationAttempt {
  loadGeneration: number
  foregroundToken: ForegroundHydrationToken | null
}

/**
 * Invalidates latency-sensitive renderer hydration as soon as the foreground
 * task changes. Per-thread generations still fence cleanup/reopen; this token
 * additionally prevents A -> B -> C navigation from spending renderer CPU on
 * parsing and applying the now-hidden A/B payloads.
 */
export class ForegroundHydrationGeneration {
  private threadId: string | null
  private generation = 0

  constructor(threadId: string | null) {
    this.threadId = threadId
  }

  transition(threadId: string | null): void {
    if (threadId === this.threadId) return
    this.threadId = threadId
    this.generation += 1
  }

  capture(threadId: string): ForegroundHydrationToken | null {
    if (threadId !== this.threadId) return null
    return { threadId, generation: this.generation }
  }

  isCurrent(token: ForegroundHydrationToken): boolean {
    return token.threadId === this.threadId && token.generation === this.generation
  }
}

export function isThreadHistoryHydrationAttemptActive(
  attempt: ThreadHistoryHydrationAttempt | undefined,
  loadGeneration: number | undefined,
  foreground: ForegroundHydrationGeneration
): boolean {
  return Boolean(
    attempt &&
    attempt.loadGeneration === loadGeneration &&
    (attempt.foregroundToken === null || foreground.isCurrent(attempt.foregroundToken))
  )
}

interface ConversationPresencePageSummary {
  total: number
  hasVisibleMessages?: boolean
  legacyCheckpointMigrationStatus?: "migrating" | "complete" | null
}

export const THREAD_HISTORY_HYDRATION_MAX_AUTO_RETRIES = 6
export const SUBAGENT_TRANSCRIPT_HYDRATION_MAX_AUTO_RETRIES = 6
export const SUBAGENT_TRANSCRIPT_PERSIST_MAX_AUTO_RETRIES = 6

export function getThreadHistoryHydrationRetryDelay(retryCount: number): number {
  const normalizedCount = Number.isFinite(retryCount)
    ? Math.max(0, Math.floor(retryCount))
    : 0
  return Math.min(30_000, 500 * 2 ** Math.min(normalizedCount, 6))
}

export interface ThreadHistoryHydrationRetrySchedule {
  exhausted: boolean
  delayMs: number | null
  nextRetryCount: number
}

/**
 * Keep persistent corruption or an unavailable worker from turning one task
 * into a process-lifetime polling loop. The initial request is not counted;
 * callers may make this many bounded automatic recovery attempts afterwards.
 */
export function getThreadHistoryHydrationRetrySchedule(
  retryCount: number
): ThreadHistoryHydrationRetrySchedule {
  return getBoundedHydrationRetrySchedule(
    retryCount,
    THREAD_HISTORY_HYDRATION_MAX_AUTO_RETRIES
  )
}

function getBoundedHydrationRetrySchedule(
  retryCount: number,
  maxAutoRetries: number
): ThreadHistoryHydrationRetrySchedule {
  const normalizedCount = Number.isFinite(retryCount)
    ? Math.max(0, Math.floor(retryCount))
    : 0
  if (normalizedCount >= maxAutoRetries) {
    return {
      exhausted: true,
      delayMs: null,
      nextRetryCount: maxAutoRetries
    }
  }
  return {
    exhausted: false,
    delayMs: getThreadHistoryHydrationRetryDelay(normalizedCount),
    nextRetryCount: normalizedCount + 1
  }
}

/**
 * Subagent transcript restoration has its own budget. It must not inherit or
 * reset the main transcript's count: either worker can fail independently.
 */
export function getSubagentTranscriptHydrationRetrySchedule(
  retryCount: number
): ThreadHistoryHydrationRetrySchedule {
  return getBoundedHydrationRetrySchedule(
    retryCount,
    SUBAGENT_TRANSCRIPT_HYDRATION_MAX_AUTO_RETRIES
  )
}

export function isSubagentTranscriptHydrationRetryExhausted(retryCount: number): boolean {
  return getSubagentTranscriptHydrationRetrySchedule(retryCount).exhausted
}

/**
 * Persist recovery is independent from both hydration budgets. A broken DB/IPC
 * path must stop polling, while a later foreground change may grant this write
 * path a fresh bounded attempt budget without affecting transcript reads.
 */
export function getSubagentTranscriptPersistRetrySchedule(
  retryCount: number
): ThreadHistoryHydrationRetrySchedule {
  return getBoundedHydrationRetrySchedule(
    retryCount,
    SUBAGENT_TRANSCRIPT_PERSIST_MAX_AUTO_RETRIES
  )
}

export function isSubagentTranscriptPersistRetryExhausted(retryCount: number): boolean {
  return getSubagentTranscriptPersistRetrySchedule(retryCount).exhausted
}

export type ThreadHistoryHydrationRetryDisposition = "run" | "wait" | "cancel"

/**
 * A background recovery must never supersede a window explicitly selected by
 * the user. The current hydrate may still be finishing ancillary restoration,
 * so wait for that one; any historical/user intent cancels this retry until the
 * task is reopened or another foreground recovery is requested.
 */
export function getThreadHistoryHydrationRetryDisposition(
  activeIntent: ThreadMessageWindowIntentKind | null,
  hasHistoricalWindow: boolean
): ThreadHistoryHydrationRetryDisposition {
  if (activeIntent === "hydrate") return "wait"
  if (activeIntent !== null || hasHistoricalWindow) return "cancel"
  return "run"
}

export function shouldBootstrapLegacyCheckpointTranscript(
  page: ConversationPresencePageSummary | null | undefined
): boolean {
  if (!page) return false
  // A visible durable row or goal sidecar proves only that the conversation is
  // non-empty; it does not prove that an older checkpoint prefix was copied.
  // The durable table becomes the full transcript authority only after the
  // one-time migration marker is complete.
  return page.legacyCheckpointMigrationStatus !== "complete"
}

export function shouldAwaitCheckpointConversationPresence(
  page: ConversationPresencePageSummary | null | undefined
): boolean {
  return Boolean(page && page.legacyCheckpointMigrationStatus !== "complete")
}

export function shouldKeepMainTranscriptLoadingAfterPage(
  result: { succeeded: true; page: ConversationPresencePageSummary } | { succeeded: false }
): boolean {
  return result.succeeded && shouldBootstrapLegacyCheckpointTranscript(result.page)
}

export function resolveConversationPresenceFromPage(
  page: ConversationPresencePageSummary | null | undefined,
  options: { legacyFallbackPending: boolean }
): ThreadConversationPresence {
  if (!page || typeof page.hasVisibleMessages !== "boolean") return "unknown"
  if (page.hasVisibleMessages) return "nonempty"
  if (options.legacyFallbackPending) return "unknown"
  return "empty"
}

interface CoordinatorWorkerRequest<T> {
  subscribeUpdates: boolean
  promise: Promise<T>
}

/**
 * Shares coordinator restoration between foreground binding and history
 * hydration. A subscription-capable request satisfies a snapshot caller; a
 * snapshot already in flight is allowed to finish before one upgrade request.
 */
export class CoordinatorWorkerRequestCache<T> {
  private readonly requests = new Map<string, CoordinatorWorkerRequest<T>>()

  request(
    threadId: string,
    subscribeUpdates: boolean,
    load: (subscribeUpdates: boolean) => Promise<T>
  ): Promise<T> {
    const existing = this.requests.get(threadId)
    if (existing && (existing.subscribeUpdates || !subscribeUpdates)) {
      return existing.promise
    }

    const promise = existing
      ? existing.promise.then(
          () => load(true),
          () => load(true)
        )
      : load(subscribeUpdates)
    const entry = { subscribeUpdates, promise }
    this.requests.set(threadId, entry)
    void promise.then(
      () => this.deleteIfCurrent(threadId, entry),
      () => this.deleteIfCurrent(threadId, entry)
    )
    return promise
  }

  invalidate(threadId: string): void {
    this.requests.delete(threadId)
  }

  clear(): void {
    this.requests.clear()
  }

  private deleteIfCurrent(threadId: string, entry: CoordinatorWorkerRequest<T>): void {
    if (this.requests.get(threadId) === entry) this.requests.delete(threadId)
  }
}
