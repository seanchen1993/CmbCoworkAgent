import { expect, it } from "vitest"
import { botPaletteRows, type BotPaletteConversation } from "./bot-command-palette"
import {
  commandPaletteVirtualWindow,
  commandPaletteScrollTopForRow
} from "../components/bots/upstream/grok-palette-primitives"

const conversations: BotPaletteConversation[] = [
  { id: "a", name: "Café 支付研发", detail: "payment development", group: false, hidden: false },
  { id: "hidden", name: "支付研发", detail: "归档", group: false, hidden: true },
  { id: "group", name: "支付团队", detail: "评审", group: true, hidden: false }
]
it("ranks normalized names, requires every token and keeps hidden Bots after visible results", () => {
  expect(botPaletteRows(conversations, [], [], "", "all").map((row) => row.conversationId)).toEqual(
    ["a", "group"]
  )
  expect(
    botPaletteRows(conversations, [], [], "CAFE 研发", "bot").map((row) => row.conversationId)
  ).toEqual(["a"])
  expect(botPaletteRows(conversations, [], [], "支付", "all").at(-1)?.conversationId).toBe("hidden")
  expect(botPaletteRows(conversations, [], [], "支付 不存在", "all")).toEqual([])
  expect(
    botPaletteRows(conversations, [], [], "支付", "group").map((row) => row.conversationId)
  ).toEqual(["group"])
})
it("retains domain content matches even if the truncated preview omits the search term", () => {
  const match = {
    id: "m",
    kind: "message" as const,
    conversationId: "a",
    conversationName: "支付",
    botId: null,
    title: "支付",
    snippet: "截断预览",
    createdAt: 1
  }
  expect(botPaletteRows([], [], [match], "original term", "all")[0].match).toBe(match)
  expect(botPaletteRows([], [], [match], "original term", "action")).toEqual([])
})
it("bounds mounted rows and scrolls keyboard-selected rows fully into view", () => {
  const range = commandPaletteVirtualWindow({
    rowCount: 10000,
    rowPitchPx: 51,
    leadingOffsetPx: 8,
    scrollTopPx: 18000,
    viewportPx: 350,
    overscanRows: 6
  })
  expect(range.end - range.start).toBeLessThanOrEqual(21)
  const top = commandPaletteScrollTopForRow({
    rowIndex: 500,
    rowPitchPx: 51,
    rowGapPx: 2,
    leadingOffsetPx: 8,
    scrollTopPx: 0,
    viewportPx: 350,
    edgeInsetPx: 8
  })!
  expect(top).toBeGreaterThan(0)
  expect(top + 350).toBe(8 + 500 * 51 + 49 + 8)
})

it("retains exact Bot and group roster identities for the existing avatar without altering ordering", () => {
  const roster: BotPaletteConversation[] = [
    {
      id: "private",
      name: "私聊助手",
      detail: "",
      group: false,
      hidden: false,
      memberIds: ["bot-a"]
    },
    {
      id: "group",
      name: "协作群",
      detail: "",
      group: true,
      hidden: false,
      memberIds: ["bot-b", "bot-a"]
    },
    { id: "empty", name: "历史群", detail: "", group: true, hidden: false, memberIds: [] }
  ]
  const rows = botPaletteRows(roster, [], [], "", "all")
  expect(rows.map((row) => row.conversationId)).toEqual(["private", "group", "empty"])
  expect(rows.map((row) => row.memberIds)).toEqual([["bot-a"], ["bot-b", "bot-a"], []])
  expect(roster.map((item) => item.memberIds)).toEqual([["bot-a"], ["bot-b", "bot-a"], []])
})
