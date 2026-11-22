import type { Message } from "@/types"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"

export interface BotMessageEntranceState {
  scope: string | null
  ids: readonly string[]
  live: boolean
  entering: ReadonlySet<string>
}

/** Grok's append/retire distinction, bounded to the current CMB history window. */
export function projectBotMessageEntrance(
  previous: BotMessageEntranceState | null,
  scope: string | null,
  ids: readonly string[],
  live: boolean
): BotMessageEntranceState {
  const sameIds =
    previous?.ids.length === ids.length && ids.every((id, i) => previous.ids[i] === id)
  if (previous?.scope === scope && previous.live === live && sameIds) return previous
  if (!previous || previous.scope !== scope || !live || !previous.live)
    return { scope, ids, live, entering: new Set() }
  const prior = new Set(previous.ids)
  const lastShared = ids.findLastIndex((id) => prior.has(id))
  // Disjoint pages are history replacement, not a new turn. An already loaded empty chat may grow.
  const appended = lastShared >= 0 ? ids.slice(lastShared + 1) : previous.ids.length ? [] : ids
  const current = new Set(ids)
  return {
    scope,
    ids,
    live,
    entering: new Set([
      ...[...previous.entering].filter((id) => current.has(id)),
      ...appended.filter((id) => !prior.has(id))
    ])
  }
}

export function retireBotMessageEntrance(
  state: BotMessageEntranceState,
  id: string
): BotMessageEntranceState {
  if (!state.entering.has(id)) return state
  const entering = new Set(state.entering)
  entering.delete(id)
  return { ...state, entering }
}

/** Empty tool/reasoning shells must not consume the later visible reply's entrance. */
export function botMessageHasEntranceBody(message: Message): boolean {
  if (message.role === "user") return true
  if (message.role !== "assistant") return false
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content
  return Boolean(
    blocks?.some(
      (block) =>
        block.type === "image" ||
        (block.type === "text" && splitBotInlineReasoning(block.text ?? "").body.trim())
    )
  )
}
