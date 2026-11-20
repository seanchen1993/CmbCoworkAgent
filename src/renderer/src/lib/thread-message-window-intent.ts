export type ThreadMessageWindowIntentKind =
  | "hydrate"
  | "older"
  | "target"
  | "gap"
  | "latest"

export interface ThreadMessageWindowIntentToken {
  threadId: string
  sequence: number
  kind: ThreadMessageWindowIntentKind
}

export interface ThreadMessageWindowIntentCoordinator {
  begin(threadId: string, kind: ThreadMessageWindowIntentKind): ThreadMessageWindowIntentToken
  isCurrent(token: ThreadMessageWindowIntentToken): boolean
  finish(token: ThreadMessageWindowIntentToken): boolean
  cancel(threadId: string, expectedKind?: ThreadMessageWindowIntentKind): boolean
  activeKind(threadId: string): ThreadMessageWindowIntentKind | null
}

/**
 * Hydration is only cancellable after its first transcript mutation has reached the registry.
 * Until then the checkpoint fallback remains the only path that can prevent a permanently blank
 * chat when the latency-critical DB page fails.
 */
export function canCancelThreadMessageWindowIntent(
  activeKind: ThreadMessageWindowIntentKind | null,
  firstTranscriptPublished: boolean
): boolean {
  return activeKind !== "hydrate" || firstTranscriptPublished
}

/**
 * Per-thread latest-wins fence for every async mutation of the resident transcript window.
 * The monotonic sequence is retained after completion so an old promise can never become current
 * again when a later request finishes or is cancelled.
 */
export function createThreadMessageWindowIntentCoordinator(): ThreadMessageWindowIntentCoordinator {
  const sequences = new Map<string, number>()
  const activeKinds = new Map<string, ThreadMessageWindowIntentKind>()

  const advance = (threadId: string): number => {
    const sequence = (sequences.get(threadId) ?? 0) + 1
    sequences.set(threadId, sequence)
    return sequence
  }

  const isCurrent = (token: ThreadMessageWindowIntentToken): boolean =>
    sequences.get(token.threadId) === token.sequence &&
    activeKinds.get(token.threadId) === token.kind

  return {
    begin(threadId, kind) {
      const token = { threadId, sequence: advance(threadId), kind }
      activeKinds.set(threadId, kind)
      return token
    },
    isCurrent,
    finish(token) {
      if (!isCurrent(token)) return false
      activeKinds.delete(token.threadId)
      return true
    },
    cancel(threadId, expectedKind) {
      const activeKind = activeKinds.get(threadId)
      if (!activeKind || (expectedKind && activeKind !== expectedKind)) return false
      advance(threadId)
      activeKinds.delete(threadId)
      return true
    },
    activeKind(threadId) {
      return activeKinds.get(threadId) ?? null
    }
  }
}
