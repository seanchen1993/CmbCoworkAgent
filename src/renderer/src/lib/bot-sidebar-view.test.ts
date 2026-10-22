import { expect, it } from "vitest"
import type {
  BotDefinition,
  BotGroup,
  BotConversationActivity
} from "../../../shared/bots/contracts"
import {
  botSidebarPreview,
  botPinnedConversationIds,
  botSidebarDropPatch,
  botPinDropTarget,
  orderBotConversations
} from "./bot-sidebar-view"
import type { BotViewState } from "../components/bots/view-store"

it("prioritizes pending questions over drafts and drafts over history, with bounded Unicode previews", () => {
  expect(botSidebarPreview("等待你确认", "未发送", true)).toEqual({
    isDraft: false,
    text: "等待你确认"
  })
  expect(botSidebarPreview("旧消息", " 新草稿\n第二行 ", false)).toEqual({
    isDraft: true,
    text: "新草稿 第二行"
  })
  expect(botSidebarPreview("旧消息", " \n ", false)).toEqual({ isDraft: false, text: "旧消息" })
  expect(botSidebarPreview("😀".repeat(141), "", false).text).toBe("😀".repeat(140) + "…")
})

it("mixes groups and Bots by actual activity without moving a chat just because it was renamed or marked unread", () => {
  const bot = { id: "a", createdAt: 10, updatedAt: 900 } as BotDefinition
  const group = { id: "g" } as BotGroup
  const activity = (
    kind: "bot" | "group",
    id: string,
    updatedAt: number
  ): BotConversationActivity => ({ kind, id, updatedAt, version: 1, preview: "", unread: false })
  const activities = new Map([
    ["bot:a", activity("bot", "a", 20)],
    ["group:g", activity("group", "g", 30)]
  ])
  const bots = [bot],
    groups = [group]
  expect(orderBotConversations(bots, groups, activities).map((item) => item.value.id)).toEqual([
    "g",
    "a"
  ])
  activities.set("bot:a", { ...activities.get("bot:a")!, unread: true, version: 100 })
  expect(orderBotConversations(bots, groups, activities).map((item) => item.value.id)).toEqual([
    "g",
    "a"
  ])
  activities.set("bot:a", activity("bot", "a", 40))
  expect(orderBotConversations(bots, groups, activities).map((item) => item.value.id)).toEqual([
    "a",
    "g"
  ])
  expect(bots).toEqual([bot])
  expect(groups).toEqual([group])
})

const sidebarView = (): BotViewState => ({
  selectedId: "current-private-chat",
  groupId: null,
  detailOpen: true,
  detailTab: "files",
  groupDetailTab: "members",
  showArchived: false,
  showExecutionDetails: false,
  accentMode: "bot",
  sidebarWidth: 264,
  detailWidth: 320,
  pinnedBotIds: ["a", "b"],
  pinnedGroupIds: ["g1", "g2"],
  hiddenBotIds: ["hidden"],
  hiddenGroupIds: [],
  sections: [
    { id: "s1", name: "First", botIds: ["a", "other"], groupIds: ["g1"], collapsed: true },
    { id: "s2", name: "Second", botIds: [], collapsed: false }
  ]
})

it("preserves the actual legacy Bot-then-group layout without writing or migrating preferences", () => {
  const view = sidebarView()
  expect(botPinnedConversationIds(view, ["g2", "g1"])).toEqual([
    "bot:a",
    "bot:b",
    "group:g2",
    "group:g1"
  ])
  expect(view).not.toHaveProperty("pinnedConversationIds")
})

it("accepts older persisted hosts that predate group pins and sections without migrating on read", () => {
  const view = { pinnedBotIds: ["a"] } as BotViewState
  expect(botPinnedConversationIds(view)).toEqual(["bot:a"])
  expect(
    botSidebarDropPatch(view, { kind: "group", id: "g", pinned: false }, { kind: "pin-grid" })
  ).toEqual({
    pinnedGroupIds: ["g"],
    hiddenGroupIds: [],
    pinnedConversationIds: ["bot:a", "group:g"]
  })
  expect(view).toEqual({ pinnedBotIds: ["a"] })
})

it("projects a mixed pin order once, ignores stale entries and appends missing membership", () => {
  const view = sidebarView()
  view.pinnedConversationIds = ["group:g2", "bot:a", "bot:a", "bot:removed", "section:s1"]
  expect(botPinnedConversationIds(view)).toEqual(["group:g2", "bot:a", "bot:b", "group:g1"])
  expect(view.pinnedBotIds).toEqual(["a", "b"])
})

it("moves across Bot/group grid slots without dropping unseen pins or changing conversation state", () => {
  const view = sidebarView()
  view.pinnedBotIds.push("unseen")
  view.pinnedConversationIds = ["bot:a", "bot:unseen", "group:g1", "bot:b", "group:g2"]
  const before = structuredClone(view)
  const patch = botSidebarDropPatch(
    view,
    { kind: "bot", id: "b", pinned: true },
    {
      kind: "pin-grid",
      anchor: "bot:a",
      position: "before"
    }
  )!
  expect(patch.pinnedConversationIds).toEqual([
    "bot:b",
    "bot:a",
    "bot:unseen",
    "group:g1",
    "group:g2"
  ])
  expect(Object.keys(patch).sort()).toEqual([
    "hiddenBotIds",
    "pinnedBotIds",
    "pinnedConversationIds"
  ])
  const next = { ...view, ...patch }
  expect(next.sections).toBe(view.sections)
  expect(next.selectedId).toBe("current-private-chat")
  expect(next.groupId).toBeNull()
  expect(next.detailTab).toBe("files")
  expect(view).toEqual(before)
})

it("pins an ordinary row idempotently and clears only that row's hidden preference", () => {
  const view = sidebarView()
  const source = { kind: "bot" as const, id: "hidden", pinned: false }
  const target = { kind: "pin-grid" as const, anchor: "group:g1", position: "before" as const }
  const patch = botSidebarDropPatch(view, source, target)!
  const next = { ...view, ...patch }
  expect(next.pinnedBotIds).toEqual(["a", "b", "hidden"])
  expect(next.hiddenBotIds).toEqual([])
  expect(next.pinnedConversationIds).toEqual([
    "bot:a",
    "bot:b",
    "bot:hidden",
    "group:g1",
    "group:g2"
  ])
  expect(botSidebarDropPatch(next, source, target)).toBeNull()
})

it("unpins a tile into the list without erasing its existing section, collapsed state or other pins", () => {
  const view = sidebarView()
  view.pinnedConversationIds = ["group:g1", "bot:a", "bot:b", "group:g2"]
  const patch = botSidebarDropPatch(
    view,
    { kind: "bot", id: "a", pinned: true },
    { kind: "agent-list" }
  )!
  expect(patch.pinnedBotIds).toEqual(["b"])
  expect(patch.pinnedConversationIds).toEqual(["group:g1", "bot:b", "group:g2"])
  expect(patch).not.toHaveProperty("sections")
  expect(view.sections[0].botIds).toEqual(["a", "other"])
  expect(view.sections[0].collapsed).toBe(true)
  expect(
    botSidebarDropPatch(view, { kind: "bot", id: "other", pinned: false }, { kind: "agent-list" })
  ).toBeNull()
})

it("moves a pinned group into a section with one patch and keeps unrelated Bot membership", () => {
  const view = sidebarView()
  const patch = botSidebarDropPatch(
    view,
    { kind: "group", id: "g1", pinned: true },
    {
      kind: "section-body",
      id: "s2"
    }
  )!
  expect(patch.pinnedGroupIds).toEqual(["g2"])
  expect(patch.sections![0]).toEqual({ ...view.sections[0], groupIds: [] })
  expect(patch.sections![1]).toEqual({ ...view.sections[1], groupIds: ["g1"] })
  expect(patch).not.toHaveProperty("pinnedBotIds")
  expect(patch).not.toHaveProperty("selectedId")
})

it("keeps existing pin membership and mixed order when the original menu moves a conversation", () => {
  const view = sidebarView()
  view.pinnedConversationIds = ["group:g1", "bot:a", "bot:b", "group:g2"]
  const patch = botSidebarDropPatch(
    view,
    { kind: "bot", id: "a", pinned: false },
    {
      kind: "section-body",
      id: "s2"
    }
  )!
  expect(Object.keys(patch)).toEqual(["sections"])
  const next = { ...view, ...patch }
  expect(next.pinnedBotIds).toBe(view.pinnedBotIds)
  expect(next.pinnedConversationIds).toBe(view.pinnedConversationIds)
  expect(next.sections[1].botIds).toEqual(["a"])
})

it("uses the synthetic ungrouped section as a move destination without manually sorting ordinary rows", () => {
  const view = sidebarView()
  const patch = botSidebarDropPatch(
    view,
    { kind: "bot", id: "other", pinned: false },
    {
      kind: "section-body",
      id: null
    }
  )!
  expect(patch.sections![0].botIds).toEqual(["a"])
  expect(patch.sections![0].groupIds).toEqual(["g1"])
  expect(
    botSidebarDropPatch(
      { ...view, ...patch },
      { kind: "bot", id: "other", pinned: false },
      {
        kind: "section-body",
        id: null
      }
    )
  ).toBeNull()
})

it("reorders sections while preserving each section object and handles the reverse direction", () => {
  const view = sidebarView()
  const patch = botSidebarDropPatch(
    view,
    { kind: "section", id: "s1" },
    {
      kind: "section",
      id: "s2",
      position: "after"
    }
  )!
  expect(patch.sections).toEqual([view.sections[1], view.sections[0]])
  expect(patch.sections![1]).toBe(view.sections[0])
  const back = botSidebarDropPatch(
    { ...view, ...patch },
    { kind: "section", id: "s1" },
    {
      kind: "section",
      id: "s2",
      position: "before"
    }
  )!
  expect(back.sections).toEqual(view.sections)
})

it("does not persist cancelled, same-slot, missing-anchor, deleted-section or cross-kind drop routes", () => {
  const view = sidebarView()
  expect(
    botSidebarDropPatch(
      view,
      { kind: "bot", id: "a", pinned: true },
      { kind: "pin-grid", anchor: "bot:a" }
    )
  ).toBeNull()
  expect(
    botSidebarDropPatch(
      view,
      { kind: "bot", id: "a", pinned: true },
      { kind: "pin-grid", anchor: "bot:missing" }
    )
  ).toBeNull()
  expect(
    botSidebarDropPatch(
      view,
      { kind: "bot", id: "a", pinned: true },
      { kind: "section-body", id: "deleted" }
    )
  ).toBeNull()
  expect(botSidebarDropPatch(view, { kind: "section", id: "s1" }, { kind: "pin-grid" })).toBeNull()
  expect(
    botSidebarDropPatch(
      view,
      { kind: "bot", id: "a", pinned: true },
      { kind: "section", id: "s1", position: "before" }
    )
  ).toBeNull()
  expect(
    botSidebarDropPatch(
      view,
      { kind: "section", id: "deleted" },
      { kind: "section", id: "s1", position: "before" }
    )
  ).toBeNull()
})

it("uses the current preference snapshot so a pin added during a drag remains present", () => {
  const view = sidebarView()
  const current = { ...view, pinnedBotIds: [...view.pinnedBotIds, "new-during-drag"] }
  const patch = botSidebarDropPatch(
    current,
    { kind: "bot", id: "b", pinned: true },
    {
      kind: "pin-grid",
      anchor: "bot:a",
      position: "before"
    }
  )!
  expect(patch.pinnedConversationIds).toContain("bot:new-during-drag")
  expect(patch.pinnedBotIds).toEqual(["a", "b", "new-during-drag"])
})

const grid = [
  { key: "bot:a", left: 0, right: 80, top: 0, bottom: 80 },
  { key: "group:g", left: 88, right: 168, top: 0, bottom: 80 },
  { key: "bot:b", left: 0, right: 80, top: 88, bottom: 168 },
  { key: "bot:c", left: 88, right: 168, top: 88, bottom: 168 }
]

it("resolves pin insertion by both row and column, including blank grid and trailing space", () => {
  expect(botPinDropTarget([], { x: 0, y: 0 })).toEqual({ kind: "pin-grid" })
  expect(botPinDropTarget(grid, { x: 10, y: 20 })).toEqual({
    kind: "pin-grid",
    anchor: "bot:a",
    position: "before"
  })
  expect(botPinDropTarget(grid, { x: 100, y: 20 })).toEqual({
    kind: "pin-grid",
    anchor: "group:g",
    position: "before"
  })
  expect(botPinDropTarget(grid, { x: 170, y: 20 })).toEqual({
    kind: "pin-grid",
    anchor: "bot:b",
    position: "before"
  })
  expect(botPinDropTarget(grid, { x: 10, y: 100 })).toEqual({
    kind: "pin-grid",
    anchor: "bot:b",
    position: "before"
  })
  expect(botPinDropTarget(grid, { x: 170, y: 200 })).toEqual({
    kind: "pin-grid",
    anchor: "bot:c",
    position: "after"
  })
})

it("resolves compact single-column and RTL grid insertions without changing stored identity keys", () => {
  expect(botPinDropTarget([grid[0], grid[2]], { x: 50, y: 100 })).toEqual({
    kind: "pin-grid",
    anchor: "bot:b",
    position: "after"
  })
  const rtl = [
    { ...grid[1], key: "bot:a" },
    { ...grid[0], key: "group:g" }
  ]
  expect(botPinDropTarget(rtl, { x: 180, y: 20 }, true)).toEqual({
    kind: "pin-grid",
    anchor: "bot:a",
    position: "before"
  })
  expect(botPinDropTarget(rtl, { x: 90, y: 20 }, true)).toEqual({
    kind: "pin-grid",
    anchor: "group:g",
    position: "before"
  })
})
