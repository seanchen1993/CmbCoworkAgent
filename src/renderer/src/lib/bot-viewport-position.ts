import { botViewAddress } from "./bot-thread-view"

/** Match the existing Cmb chat scroll-session bound; transcript bodies have a separate cache. */
export const BOT_VIEWPORT_POSITION_LIMIT = 48
const MAX_VIEWPORT_POSITION_LIMIT = 128

export interface BotViewportPosition {
  messageId: string | null
  offset: number
  followTail: boolean
}

export interface BotViewportPositionLease {
  viewId: string
  generation: number
}

export interface BotViewportPositionCache {
  open(viewId: string): {
    lease: BotViewportPositionLease
    position: BotViewportPosition | null
  }
  save(lease: BotViewportPositionLease, position: BotViewportPosition): boolean
  isCurrent(lease: BotViewportPositionLease): boolean
  delete(viewId: string): void
  prune(availableConversationIds: ReadonlySet<string>): void
  clear(): void
  size(): number
}

function copyPosition(position: BotViewportPosition): BotViewportPosition {
  // Project the narrow fields explicitly, so callers cannot accidentally retain a row,
  // a DOM node, file content or other live renderer objects in the navigation cache.
  return {
    messageId: position.followTail ? null : position.messageId,
    offset: position.followTail || !position.messageId ? 0 : position.offset,
    followTail: position.followTail
  }
}

/** Adapt the LRU and generation lease used by Chat's chat-scroll-session-store.ts.
 * Reopening a view supersedes previous callbacks; eviction, deletion and workspace
 * restoration invalidate its lease without keeping an unbounded tombstone map.
 */
export function createBotViewportPositionCache(
  maximumPositions = BOT_VIEWPORT_POSITION_LIMIT
): BotViewportPositionCache {
  const limit = Number.isFinite(maximumPositions)
    ? Math.max(1, Math.min(MAX_VIEWPORT_POSITION_LIMIT, Math.floor(maximumPositions)))
    : BOT_VIEWPORT_POSITION_LIMIT
  const entries = new Map<string, { generation: number; position: BotViewportPosition | null }>()
  let generation = 0

  const isCurrent = (lease: BotViewportPositionLease): boolean => {
    const entry = entries.get(lease.viewId)
    return !!entry && entry.generation === lease.generation
  }
  const touch = (
    viewId: string,
    entry: { generation: number; position: BotViewportPosition | null }
  ): void => {
    entries.delete(viewId)
    entries.set(viewId, entry)
    if (entries.size > limit) entries.delete(entries.keys().next().value!)
  }

  return {
    open(viewId) {
      if (!viewId || viewId.length > 512)
        throw new TypeError("A Bot viewport requires a valid view ID")
      const position = entries.get(viewId)?.position ?? null
      const lease = { viewId, generation: ++generation }
      touch(viewId, { generation: lease.generation, position })
      return { lease, position: position ? copyPosition(position) : null }
    },
    save(lease, position) {
      if (
        !isCurrent(lease) ||
        !Number.isFinite(position.offset) ||
        typeof position.followTail !== "boolean" ||
        (position.messageId !== null &&
          (typeof position.messageId !== "string" ||
            !position.messageId ||
            position.messageId.length > 512))
      )
        return false
      touch(lease.viewId, {
        generation: lease.generation,
        position: copyPosition(position)
      })
      return true
    },
    isCurrent,
    delete(viewId) {
      entries.delete(viewId)
    },
    prune(availableConversationIds) {
      for (const viewId of entries.keys())
        if (!availableConversationIds.has(botViewAddress(viewId).conversationId))
          entries.delete(viewId)
    },
    clear() {
      entries.clear()
    },
    size: () => entries.size
  }
}

export const botViewportPositionCache = createBotViewportPositionCache()
