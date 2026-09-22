import type { FunctionTurnNotice } from "./turn"

interface NoticeMessage {
  id: string
  role: string
  provider_source_id?: string
}

/** Place host notices within resident history; never carry them across a released history gap. */
export function placeFunctionTurnNotices(
  messages: readonly NoticeMessage[],
  visibleIndexes: readonly number[],
  notices: readonly FunctionTurnNotice[],
  gapBeforeMessageId?: string | null
): Map<string, FunctionTurnNotice[]> {
  const placements = new Map<string, FunctionTurnNotice[]>()
  if (!notices.length) return placements
  const visible = new Set(visibleIndexes)
  const indexes = new Map(messages.map((message, index) => [message.id, index]))
  const providerIndexes = new Map<string, number[]>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== "assistant" || !message.provider_source_id) continue
    const candidates = providerIndexes.get(message.provider_source_id) ?? []
    candidates.push(index)
    providerIndexes.set(message.provider_source_id, candidates)
  }
  const gap = gapBeforeMessageId ? indexes.get(gapBeforeMessageId) : undefined
  for (const notice of notices) {
    const turn = indexes.get(notice.turnId)
    let index = notice.anchorMessageId ? indexes.get(notice.anchorMessageId) : turn
    if (notice.anchorMessageId && index !== undefined && turn !== undefined && index <= turn)
      index = undefined
    if (index === undefined && notice.anchorMessageId && turn !== undefined) {
      // Renderer normalization may change a provider id. Require a unique match in this turn.
      let end = turn + 1
      while (end < messages.length && messages[end].role !== "user" && end !== gap) end++
      const candidates = (providerIndexes.get(notice.anchorMessageId) ?? []).filter(
        (candidate) => candidate > turn && candidate < end
      )
      if (candidates.length === 1) index = candidates[0]
    }
    if (index === undefined) continue
    if (notice.anchorMessageId && messages[index].role !== "assistant") continue
    if (!notice.anchorMessageId && messages[index].role !== "user") continue
    // Empty terminal assistant rows can be filtered. Use the preceding visible row in that
    // resident segment, stopping at the user boundary. A missing anchor is never guessed.
    while (!visible.has(index) && index > 0 && index !== gap && messages[index].role !== "user")
      index--
    if (!visible.has(index)) continue
    const id = messages[index].id
    const entries = placements.get(id) ?? []
    entries.push(notice)
    placements.set(id, entries)
  }
  return placements
}
