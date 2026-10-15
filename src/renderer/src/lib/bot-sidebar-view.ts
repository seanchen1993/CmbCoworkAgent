import type {
  BotDefinition,
  BotGroup,
  BotConversationActivity
} from "../../../shared/bots/contracts"

type Conversation = { kind: "bot"; value: BotDefinition } | { kind: "group"; value: BotGroup }

/** Grok's hover card prioritizes a pending question, then unsent work, then history. */
export function botSidebarPreview(preview: string, draft: string, waiting: boolean) {
  const isDraft = !waiting && Boolean(draft.trim())
  const text = (isDraft ? draft : preview).replace(/\s+/g, " ").trim()
  const points = Array.from(text)
  return { isDraft, text: points.length > 140 ? points.slice(0, 140).join("") + "…" : text }
}

/** A group is a conversation too; keep one activity order instead of separate Bot/group lists. */
export function orderBotConversations(
  bots: readonly BotDefinition[],
  groups: readonly BotGroup[],
  activities: ReadonlyMap<string, BotConversationActivity>
): Conversation[] {
  const conversations: Conversation[] = [
    ...bots.map((value) => ({ kind: "bot" as const, value })),
    ...groups.map((value) => ({ kind: "group" as const, value }))
  ]
  const time = (item: Conversation) =>
    activities.get(`${item.kind}:${item.value.id}`)?.updatedAt ??
    (item.kind === "bot" ? item.value.createdAt : 0)
  return conversations.sort(
    (a, b) =>
      time(b) - time(a) || `${a.kind}:${a.value.id}`.localeCompare(`${b.kind}:${b.value.id}`)
  )
}
