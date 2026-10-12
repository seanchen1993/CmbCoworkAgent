import { expect, it } from "vitest"
import { projectBotSidebar } from "./bot-sidebar-projection"
import type { BotConversation, CoworkBot } from "../../../shared/bot-types"

function bot(id: string, hidden = false): CoworkBot {
  return {
    id,
    name: id,
    hidden,
    pinned: false,
    instructions: "",
    modelRef: null,
    workspacePath: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null
  }
}
function chat(id: string, members: string[], kind: "direct" | "group" = "direct"): BotConversation {
  return { id, kind, name: id, members, revision: 1, createdAt: 1 }
}
const visible = chat("Visible", ["visible"])
const hidden = chat("Hidden", ["hidden"])
const group = chat("Group", ["hidden", "visible"], "group")
const bots = [bot("visible"), bot("hidden", true)]

it("keeps hidden Bot rows out of collapsed navigation while retaining their recovery entry", () => {
  const result = projectBotSidebar([hidden, visible, group], bots, "", false)
  expect(result.entries).toEqual([visible, group, { kind: "hidden-bots", count: 1 }])
  expect(result.conversations).toEqual([visible, group])
  expect(result.byBotId.get("hidden")).toBe(bots[1])
})

it("opens hidden Bots in a separate final section without adding its header to keyboard navigation", () => {
  const result = projectBotSidebar([hidden, group, visible], bots, "", true)
  expect(result.entries).toEqual([group, visible, { kind: "hidden-bots", count: 1 }, hidden])
  expect(result.conversations).toEqual([group, visible, hidden])
  expect(result.entries[3]).toBe(hidden)
})

it("allows recovery when every match is hidden and applies the existing case insensitive filter", () => {
  expect(projectBotSidebar([hidden, visible], bots, "hIDden", false).entries).toEqual([
    { kind: "hidden-bots", count: 1 }
  ])
  expect(projectBotSidebar([hidden, visible], bots, "visible", true).entries).toEqual([visible])
  expect(projectBotSidebar([hidden], bots, "missing", true).entries).toEqual([])
})
