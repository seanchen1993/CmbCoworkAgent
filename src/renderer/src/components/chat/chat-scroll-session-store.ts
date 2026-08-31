import type { ChatScrollState } from "../../../../shared/chat-scroll-controller"
import type { ChatScrollTailSnapshot } from "@/lib/chat-scroll-tail-change"

export interface ChatScrollSessionAnchor {
  messageId: string
  offsetFromViewportTop: number
}

export interface ChatScrollSession {
  state: ChatScrollState
  anchor: ChatScrollSessionAnchor | null
  contentSnapshot: (ChatScrollTailSnapshot & {
    threadId: string
    contentVersion: number
    structureVersion: number
  }) | null
}

export interface ChatScrollSessionLease {
  threadId: string
  generation: number
}

export interface OpenedChatScrollSession {
  lease: ChatScrollSessionLease
  session: ChatScrollSession | null
  pendingRevealMessageId: string | null
}

export interface ChatScrollSessionStore {
  open(threadId: string): OpenedChatScrollSession
  save(lease: ChatScrollSessionLease, session: ChatScrollSession): void
  setPendingRevealMessageId(lease: ChatScrollSessionLease, messageId: string | null): void
  getPendingRevealMessageId(lease: ChatScrollSessionLease): string | null
  delete(threadId: string): void
  size(): number
}

const DEFAULT_CHAT_SCROLL_SESSION_LIMIT = 48

function cloneSession(session: ChatScrollSession): ChatScrollSession {
  return {
    state: { ...session.state },
    anchor: session.anchor ? { ...session.anchor } : null,
    contentSnapshot: session.contentSnapshot ? { ...session.contentSnapshot } : null
  }
}

/**
 * Resume a remounted view without carrying transient animation/restoration locks into it.
 * Advancing the generation also makes callbacks queued by the old component instance stale.
 */
export function restoreChatScrollSessionState(
  session: ChatScrollSession,
  threadId: string
): ChatScrollSession {
  const saved = session.state
  const restoredMode =
    saved.mode === "restoring" ? (saved.restoreMode ?? "detached") : saved.mode
  return {
    state: {
      ...saved,
      threadId,
      generation: saved.generation + 1,
      mode: restoredMode,
      programmaticScrollGuard: false,
      restoreDepth: 0,
      restoreMode: null,
      pendingFollowAfterRestore: false
    },
    anchor: session.anchor ? { ...session.anchor } : null,
    contentSnapshot: session.contentSnapshot ? { ...session.contentSnapshot } : null
  }
}

export function createChatScrollSessionStore(
  maximumSessions = DEFAULT_CHAT_SCROLL_SESSION_LIMIT
): ChatScrollSessionStore {
  const limit = Math.max(1, Math.floor(maximumSessions))
  const sessions = new Map<string, ChatScrollSession>()
  const pendingRevealMessageIds = new Map<string, string>()
  const currentLeaseGenerationByThreadId = new Map<string, number>()
  let nextLeaseGeneration = 0

  const advanceLease = (threadId: string): ChatScrollSessionLease => {
    nextLeaseGeneration += 1
    currentLeaseGenerationByThreadId.delete(threadId)
    currentLeaseGenerationByThreadId.set(threadId, nextLeaseGeneration)
    while (currentLeaseGenerationByThreadId.size > limit) {
      const oldestThreadId = currentLeaseGenerationByThreadId.keys().next().value as
        | string
        | undefined
      if (!oldestThreadId) break
      currentLeaseGenerationByThreadId.delete(oldestThreadId)
    }
    return { threadId, generation: nextLeaseGeneration }
  }

  const isCurrentLease = (lease: ChatScrollSessionLease): boolean =>
    Boolean(
      lease.threadId &&
        currentLeaseGenerationByThreadId.get(lease.threadId) === lease.generation
    )

  const trimPendingReveals = (): void => {
    while (pendingRevealMessageIds.size > limit) {
      const oldestThreadId = pendingRevealMessageIds.keys().next().value as string | undefined
      if (!oldestThreadId) break
      pendingRevealMessageIds.delete(oldestThreadId)
    }
  }

  const touch = (threadId: string, session: ChatScrollSession): void => {
    sessions.delete(threadId)
    sessions.set(threadId, cloneSession(session))
    while (sessions.size > limit) {
      const oldestThreadId = sessions.keys().next().value as string | undefined
      if (!oldestThreadId) break
      sessions.delete(oldestThreadId)
    }
  }

  return {
    open(threadId): OpenedChatScrollSession {
      const lease = advanceLease(threadId)
      const saved = sessions.get(threadId)
      const session = saved ? restoreChatScrollSessionState(saved, threadId) : null
      if (session) touch(threadId, session)
      const pendingRevealMessageId = pendingRevealMessageIds.get(threadId) ?? null
      if (pendingRevealMessageId) {
        pendingRevealMessageIds.delete(threadId)
        pendingRevealMessageIds.set(threadId, pendingRevealMessageId)
      }
      return {
        lease,
        session: session ? cloneSession(session) : null,
        pendingRevealMessageId
      }
    },
    save(lease, session): void {
      if (!isCurrentLease(lease) || session.state.threadId !== lease.threadId) return
      touch(lease.threadId, session)
    },
    setPendingRevealMessageId(lease, messageId): void {
      if (!isCurrentLease(lease)) return
      pendingRevealMessageIds.delete(lease.threadId)
      if (messageId) pendingRevealMessageIds.set(lease.threadId, messageId)
      trimPendingReveals()
    },
    getPendingRevealMessageId(lease): string | null {
      if (!isCurrentLease(lease)) return null
      const messageId = pendingRevealMessageIds.get(lease.threadId)
      if (!messageId) return null
      pendingRevealMessageIds.delete(lease.threadId)
      pendingRevealMessageIds.set(lease.threadId, messageId)
      return messageId
    },
    delete(threadId): void {
      sessions.delete(threadId)
      pendingRevealMessageIds.delete(threadId)
      // Advance even when no view is mounted. Every continuation from the deleted
      // row now has a permanently stale lease; a same-id replacement opens a fresh one.
      advanceLease(threadId)
    },
    size(): number {
      return sessions.size
    }
  }
}

export const chatScrollSessionStore = createChatScrollSessionStore()
