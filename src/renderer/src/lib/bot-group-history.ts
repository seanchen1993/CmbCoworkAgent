import type { BotGroupMessage } from "../../../shared/bots/contracts"

export const EMPTY_GROUP_HISTORY = {
  messages: [] as BotGroupMessage[],
  firstIndex: 1_000_000,
  loaded: false
}

/** Refresh mutable questions already on screen without loading the intervening chat. */
export async function readGroupHistoryRefresh(
  read: (cursor?: { targetMessageId: string }) => Promise<BotGroupMessage[]>,
  loaded: BotGroupMessage[],
  anchored: boolean,
  isCurrent: () => boolean
): Promise<{ page: BotGroupMessage[]; questions: BotGroupMessage[] } | null> {
  const page = anchored ? [] : await read()
  if (!isCurrent()) return null
  const covered = new Set(page.map((item) => item.id))
  const pending = new Set(
    loaded
      .filter((item) => {
        const question = item.question
        return (
          question &&
          !question.result &&
          !covered.has(item.id) &&
          (question.resultId || !["cancelled", "interrupted"].includes(question.state ?? ""))
        )
      })
      .map((item) => item.id)
  )
  const questions: BotGroupMessage[] = []
  for (const id of pending) {
    const rows = await read({ targetMessageId: id })
    if (!isCurrent()) return null
    // One existing page may cover several questions. Never insert unloaded neighbours.
    for (const row of rows) {
      if (pending.delete(row.id)) questions.push(row)
    }
    pending.delete(id)
  }
  return { page, questions }
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
