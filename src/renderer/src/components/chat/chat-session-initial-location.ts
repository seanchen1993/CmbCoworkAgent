import type { ChatScrollState } from "../../../../shared/chat-scroll-controller"
import type { ChatScrollSessionAnchor } from "./chat-scroll-session-store"

export interface ChatSessionRestoreSeed extends ChatScrollSessionAnchor {
  threadId: string
}

/** Seed only an active restore. The original DOM correction still owns exact row offsets. */
export function resolveChatSessionInitialLocation(
  threadId: string,
  mode: ChatScrollState["mode"],
  seed: ChatSessionRestoreSeed | null,
  visibleIndexes: ReadonlyMap<string, number>
): { index: number; align: "start"; behavior: "auto"; offset: number } | undefined {
  if (mode !== "detached" || !seed || seed.threadId !== threadId ||
    !Number.isFinite(seed.offsetFromViewportTop)) return undefined
  const index = visibleIndexes.get(seed.messageId)
  if (index === undefined) return undefined
  // Virtuoso's public index is relative to data, regardless of firstItemIndex.
  // A positive saved row offset needs a smaller scrollTop, hence the negative delta.
  return { index, align: "start", behavior: "auto", offset: -seed.offsetFromViewportTop }
}
