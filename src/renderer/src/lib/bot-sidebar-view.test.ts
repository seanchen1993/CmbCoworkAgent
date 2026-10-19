import { expect, it } from "vitest"
import type {
  BotDefinition,
  BotGroup,
  BotConversationActivity
} from "../../../shared/bots/contracts"
import { botSidebarPreview, orderBotConversations } from "./bot-sidebar-view"

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
