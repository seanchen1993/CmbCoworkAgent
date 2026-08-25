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

export function shouldKeepMainTranscriptLoadingAfterPage(
  result: { succeeded: true; total: number } | { succeeded: false }
): boolean {
  return result.succeeded && result.total === 0
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
