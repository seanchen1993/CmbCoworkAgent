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
 * Only an active request owns a slot. A new sequence is unique even after a slot is released.
 */
export function createThreadMessageWindowIntentCoordinator(): ThreadMessageWindowIntentCoordinator {
  const active = new Map<string, ThreadMessageWindowIntentToken>()
  let sequence = 0
  const isCurrent = (token: ThreadMessageWindowIntentToken): boolean =>
    active.get(token.threadId)?.sequence === token.sequence && active.get(token.threadId)?.kind === token.kind

  return {
    begin(threadId, kind) {
      const token = { threadId, sequence: ++sequence, kind }
      active.set(threadId, token)
      return token
    },
    isCurrent,
    finish(token) {
      if (!isCurrent(token)) return false
      active.delete(token.threadId)
      return true
    },
    cancel(threadId, expectedKind) {
      const activeKind = active.get(threadId)?.kind
      if (!activeKind || (expectedKind && activeKind !== expectedKind)) return false
      active.delete(threadId)
      return true
    },
    activeKind(threadId) {
      return active.get(threadId)?.kind ?? null
    }
  }
}
