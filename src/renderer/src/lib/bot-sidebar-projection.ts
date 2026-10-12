import type { BotConversation, CoworkBot } from "../../../shared/bot-types"

export type BotSidebarEntry = BotConversation | { kind: "hidden-bots"; count: number }

/** Keep hidden Bots discoverable without mixing them into the ordinary list or
 * keyboard order. This is only a projection of the existing workspace state. */
export function projectBotSidebar(
  conversations: readonly BotConversation[],
  bots: readonly CoworkBot[],
  query: string,
  showHidden: boolean
) {
  const byBotId = new Map(bots.map((bot) => [bot.id, bot]))
  const visible: BotConversation[] = []
  const hidden: BotConversation[] = []
  const filter = query.toLowerCase()
  for (const conversation of conversations) {
    if (!conversation.name.toLowerCase().includes(filter)) continue
    const bot = conversation.kind === "direct" ? byBotId.get(conversation.members[0]) : undefined
    if (bot?.hidden) hidden.push(conversation)
    else visible.push(conversation)
  }
  const entries: BotSidebarEntry[] = [...visible]
  if (hidden.length) entries.push({ kind: "hidden-bots", count: hidden.length })
  if (showHidden) entries.push(...hidden)
  return {
    byBotId,
    entries,
    conversations: showHidden ? [...visible, ...hidden] : visible
  }
}
