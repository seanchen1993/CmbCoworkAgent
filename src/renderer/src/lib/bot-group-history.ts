import type { BotGroupMessage } from "../../../shared/bots/contracts"

export const EMPTY_GROUP_HISTORY = {
  messages: [] as BotGroupMessage[],
  firstIndex: 1_000_000,
  loaded: false
}

/** Preserve Virtuoso's absolute item positions when an overlapping older page arrives. */
export function mergeGroupHistory(
  previous: typeof EMPTY_GROUP_HISTORY,
  page: BotGroupMessage[]
): typeof EMPTY_GROUP_HISTORY {
  const byId = new Map(previous.messages.map((item) => [item.id, item]))
  for (const item of page) byId.set(item.id, item)
  const messages = [...byId.values()].sort((a, b) => a.ordinal - b.ordinal)
  const prepended = previous.messages.length
    ? messages.findIndex((item) => item.id === previous.messages[0].id)
    : 0
  return {
    messages,
    firstIndex: previous.firstIndex - Math.max(0, prepended),
    loaded: true
  }
}
