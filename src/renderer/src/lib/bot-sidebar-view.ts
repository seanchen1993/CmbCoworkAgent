import type {
  BotDefinition,
  BotGroup,
  BotConversationActivity
} from "../../../shared/bots/contracts"
import type { BotViewState } from "../components/bots/view-store"
import type { BotImConversation } from "../../../shared/bots/im-channel"

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
  activities: ReadonlyMap<string, BotConversationActivity>,
  heldUnreadKey?: string | null
): Conversation[] {
  const conversations: Conversation[] = [
    ...bots.map((value) => ({ kind: "bot" as const, value })),
    ...groups.map((value) => ({ kind: "group" as const, value }))
  ]
  const key = (item: Conversation) => `${item.kind}:${item.value.id}`
  const unread = (item: Conversation) =>
    Number(Boolean(activities.get(key(item))?.unread || heldUnreadKey === key(item)))
  const time = (item: Conversation) =>
    activities.get(key(item))?.updatedAt ?? (item.kind === "bot" ? item.value.createdAt : 0)
  return conversations.sort(
    (a, b) => unread(b) - unread(a) || time(b) - time(a) || key(a).localeCompare(key(b))
  )
}

/** Binding identity, never the title, owns pins, read state and retained history. */
export function orderImConversations(
  conversations: readonly BotImConversation[],
  pinnedIds: readonly string[] = [],
  heldUnreadKey?: string | null
) {
  const pins = new Map(pinnedIds.map((id, index) => [id, index]))
  const active = conversations.filter((item) => item.state === "active")
  const history = conversations.filter((item) => item.state === "revoked")
  const recent = (a: BotImConversation, b: BotImConversation) =>
    b.activity.updatedAt - a.activity.updatedAt || a.id.localeCompare(b.id)
  active.sort((a, b) => {
    const pa = pins.get(a.id),
      pb = pins.get(b.id)
    if (pa !== undefined || pb !== undefined)
      return (pa ?? Number.MAX_SAFE_INTEGER) - (pb ?? Number.MAX_SAFE_INTEGER)
    return (
      Number(b.activity.unread || heldUnreadKey === `im:${b.id}`) -
        Number(a.activity.unread || heldUnreadKey === `im:${a.id}`) || recent(a, b)
    )
  })
  history.sort(recent)
  return { active, history }
}

/** List metadata is already bounded; no transcript fetches for sorting or search. */
export function filterImConversations(
  conversations: readonly BotImConversation[],
  bots: ReadonlyMap<string, BotDefinition>,
  query: string,
  hiddenIds: readonly string[] = [],
  showHidden = false,
  deletedIds: readonly string[] = []
) {
  const search = query.trim().toLocaleLowerCase(),
    hidden = new Set(hiddenIds),
    deleted = new Set(deletedIds)
  return conversations.filter(
    (item) =>
      !(item.state === "revoked" && deleted.has(item.id)) &&
      (search || hidden.has(item.id) === showHidden) &&
      `${item.title} ${bots.get(item.botId)?.name ?? ""}`.toLocaleLowerCase().includes(search)
  )
}

export function botSidebarTime(value: number | undefined, now = Date.now()): string {
  if (!value || !Number.isFinite(value)) return ""
  const date = new Date(value),
    today = new Date(now),
    yesterday = new Date(now)
  if (!Number.isFinite(date.getTime())) return ""
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  if (date.toDateString() === yesterday.toDateString()) return "昨天"
  return `${date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}/`}${date.getMonth() + 1}/${date.getDate()}`
}

/** Local list deletion never changes the channel binding, transcripts or task ownership. */
export function removeImConversationFromView(
  view: BotViewState,
  group: BotImConversation
): Partial<BotViewState> | null {
  if (group.state !== "revoked") return null
  const activeWorks = { ...view.activeImWorkIdByConversation }
  delete activeWorks[group.id]
  return {
    deletedImConversationIds: [...new Set([...(view.deletedImConversationIds ?? []), group.id])],
    pinnedImConversationIds: (view.pinnedImConversationIds ?? []).filter((id) => id !== group.id),
    hiddenImConversationIds: (view.hiddenImConversationIds ?? []).filter((id) => id !== group.id),
    activeImWorkIdByConversation: activeWorks,
    ...(view.imConversationId === group.id
      ? {
          selectedId: group.botId,
          groupId: null,
          imConversationId: null,
          activeWorkIdByBot: { ...view.activeWorkIdByBot, [group.botId]: null },
          detailTab: "details" as const
        }
      : {})
  }
}

/** Keep existing rows under the pointer while a list interaction is in progress. */
export function retainSidebarOrder<T>(
  items: readonly T[],
  previous: readonly string[],
  key: (item: T) => string
): T[] {
  const rank = new Map(previous.map((id, index) => [id, index]))
  return [...items].sort(
    (a, b) =>
      (rank.get(key(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(key(b)) ?? Number.MAX_SAFE_INTEGER)
  )
}

type SidebarPreferences = Pick<
  BotViewState,
  | "pinnedBotIds"
  | "pinnedGroupIds"
  | "pinnedConversationIds"
  | "hiddenBotIds"
  | "hiddenGroupIds"
  | "sections"
>
export type BotSidebarDrag =
  | { kind: "bot" | "group"; id: string; pinned: boolean }
  | { kind: "section"; id: string }
export type BotSidebarDrop =
  | { kind: "pin-grid"; anchor?: string; position?: "before" | "after" }
  | { kind: "agent-list" }
  | { kind: "section-body"; id: string | null }
  | { kind: "section"; id: string; position: "before" | "after" }

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index])

/** Read old preferences without migrating or dropping pins hidden by a current filter. */
export function botPinnedConversationIds(
  view: SidebarPreferences,
  groupOrder: readonly string[] = []
): string[] {
  const pinnedGroups = view.pinnedGroupIds ?? []
  const groups = [...new Set([...groupOrder, ...pinnedGroups])].filter((id) =>
    pinnedGroups.includes(id)
  )
  const members = [
    ...(view.pinnedBotIds ?? []).map((id) => `bot:${id}`),
    ...groups.map((id) => `group:${id}`)
  ]
  const membership = new Set(members)
  return [
    ...new Set([
      ...(view.pinnedConversationIds ?? []).filter((id) => membership.has(id)),
      ...members
    ])
  ]
}

function moveId(
  ids: readonly string[],
  moved: string,
  anchor?: string,
  position: "before" | "after" = "after"
): string[] | null {
  if (anchor === moved) return [...ids]
  if (anchor && !ids.includes(anchor)) return null
  const next = ids.filter((id) => id !== moved)
  const index = anchor ? next.indexOf(anchor) + Number(position === "after") : next.length
  next.splice(index, 0, moved)
  return next
}

/** Only existing view preferences change on drop; conversation and Runtime state stay untouched. */
export function botSidebarDropPatch(
  view: SidebarPreferences,
  source: BotSidebarDrag,
  target: BotSidebarDrop,
  groupOrder: readonly string[] = []
): Partial<SidebarPreferences> | null {
  const sections = view.sections ?? []
  if (source.kind === "section") {
    if (target.kind !== "section") return null
    const ids = sections.map((section) => section.id)
    if (!ids.includes(source.id)) return null
    const next = moveId(ids, source.id, target.id, target.position)
    if (!next || sameIds(ids, next)) return null
    return { sections: next.map((id) => sections.find((section) => section.id === id)!) }
  }
  const pinField = source.kind === "bot" ? "pinnedBotIds" : "pinnedGroupIds"
  const hiddenField = source.kind === "bot" ? "hiddenBotIds" : "hiddenGroupIds"
  const memberField = source.kind === "bot" ? "botIds" : "groupIds"
  const key = `${source.kind}:${source.id}`
  const pins = view[pinField] ?? []
  const hiddenIds = view[hiddenField] ?? []
  const pinned = pins.includes(source.id)
  const order = botPinnedConversationIds(view, groupOrder)
  if (target.kind === "pin-grid") {
    const next = moveId(pinned ? order : [...order, key], key, target.anchor, target.position)
    if (!next) return null
    const hidden = hiddenIds.includes(source.id)
    if (pinned && !hidden && sameIds(order, next)) return null
    return {
      [pinField]: pinned ? pins : [...pins, source.id],
      [hiddenField]: hiddenIds.filter((id) => id !== source.id),
      pinnedConversationIds: next
    }
  }
  if (target.kind !== "agent-list" && target.kind !== "section-body") return null
  if (target.kind === "agent-list" && (!source.pinned || !pinned)) return null
  if (
    target.kind === "section-body" &&
    target.id !== null &&
    !sections.some((section) => section.id === target.id)
  )
    return null
  const patch: Partial<SidebarPreferences> =
    pinned && source.pinned
      ? {
          [pinField]: pins.filter((id) => id !== source.id),
          ...(view.pinnedConversationIds
            ? { pinnedConversationIds: order.filter((id) => id !== key) }
            : {})
        }
      : {}
  if (target.kind === "section-body") {
    const movedSections = sections.map((section) => {
      const ids = section[memberField] ?? []
      const next =
        section.id === target.id
          ? ids.includes(source.id)
            ? ids
            : [...ids, source.id]
          : ids.filter((id) => id !== source.id)
      return sameIds(ids, next) ? section : { ...section, [memberField]: next }
    })
    if (movedSections.some((section, index) => section !== sections[index]))
      patch.sections = movedSections
  }
  return Object.keys(patch).length ? patch : null
}

/** The pin grid can have multiple columns; a vertical midpoint alone gives the wrong slot. */
export function botPinDropTarget(
  tiles: readonly { key: string; left: number; right: number; top: number; bottom: number }[],
  point: { x: number; y: number },
  rtl = false
): Extract<BotSidebarDrop, { kind: "pin-grid" }> {
  if (!tiles.length) return { kind: "pin-grid" }
  let start = 0
  while (start < tiles.length) {
    let end = start + 1
    while (end < tiles.length && Math.abs(tiles[end].top - tiles[start].top) < 1) end++
    const row = tiles.slice(start, end)
    const bottom = Math.max(...row.map((tile) => tile.bottom))
    const nextTop = tiles[end]?.top ?? bottom
    if (point.y <= (bottom + nextTop) / 2) {
      const offset = row.filter(
        (tile) => (point.x - (tile.left + tile.right) / 2) * (rtl ? -1 : 1) > 0
      ).length
      const tile = tiles[start + offset]
      if (tile) return { kind: "pin-grid", anchor: tile.key, position: "before" }
      break
    }
    start = end
  }
  return { kind: "pin-grid", anchor: tiles.at(-1)!.key, position: "after" }
}
