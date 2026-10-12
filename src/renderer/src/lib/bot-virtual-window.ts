import type { BotMessage } from "../../../shared/bot-types"

const INDEX_ORIGIN = 1_000_000_000

export interface BotVirtualWindow {
  viewId: string
  firstItemIndex: number
  generation: number
  messages: readonly Pick<BotMessage, "id">[]
}

/** Keep the virtualizer's measured identities when pages are prepended or
 * released. A non-overlapping jump starts a new measurement window.
 */
export function reconcileBotVirtualWindow(
  previous: BotVirtualWindow | null,
  viewId: string,
  messages: BotVirtualWindow["messages"]
): BotVirtualWindow {
  if (!previous || previous.viewId !== viewId)
    return { viewId, firstItemIndex: INDEX_ORIGIN, generation: 0, messages }
  let firstItemIndex = previous.firstItemIndex
  let generation = previous.generation
  const oldFirst = previous.messages[0]?.id
  const newFirst = messages[0]?.id
  if (oldFirst !== newFirst) {
    const prepended = oldFirst ? messages.findIndex((message) => message.id === oldFirst) : -1
    const released = newFirst
      ? previous.messages.findIndex((message) => message.id === newFirst)
      : -1
    if (prepended >= 0) firstItemIndex -= prepended
    else if (released >= 0) firstItemIndex += released
    else {
      firstItemIndex = INDEX_ORIGIN
      generation++
    }
  }
  if (firstItemIndex <= 0 || !Number.isSafeInteger(firstItemIndex)) {
    firstItemIndex = INDEX_ORIGIN
    generation++
  }
  return { viewId, firstItemIndex, generation, messages }
}
