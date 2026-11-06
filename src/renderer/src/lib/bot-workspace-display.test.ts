import { describe, expect, it } from "vitest"
import { botDefaultWorkspaceOwner, botWorkspaceDisplay } from "./bot-workspace-display"

const bot = { id: "bot-1", name: "小 A", color: "#008888" }
describe("Bot workspace presentation", () => {
  it.each([
    "/Users/demo/.cmbcoworkagent/bots/workspaces/bot-1/",
    "C:\\Users\\demo\\.cmbcoworkagent\\bots\\workspaces\\bot-1",
    "/custom-data-root/bots/workspaces/bot-1"
  ])("labels legacy default directory without exposing its id: %s", (path) => {
    expect(botDefaultWorkspaceOwner(path)).toBe(bot.id)
    expect(botWorkspaceDisplay(path, [bot])).toMatchObject({
      name: "小 A · 默认工作区",
      isDefault: true
    })
    expect(botWorkspaceDisplay(path, [{ ...bot, name: "新名字" }]).name).toBe("新名字 · 默认工作区")
  })
  it.each([
    "/projects/bot-1",
    "C:\\code\\08ee86d6-99d7-40c8",
    "/repo/bots/workspaces/bot-1/output"
  ])("does not classify an ordinary folder as a default directory: %s", (path) => {
    expect(botDefaultWorkspaceOwner(path)).toBeNull()
    expect(botWorkspaceDisplay(path, [bot]).isDefault).toBe(false)
  })
  it("uses the task's authoritative workspace choice, including project labels", () => {
    const path = "/custom-data-root/bots/workspaces/bot-1"
    expect(botWorkspaceDisplay(path, [bot], { kind: "directory", path }).isDefault).toBe(false)
    expect(
      botWorkspaceDisplay(
        "/code/backend",
        [],
        { kind: "project", path: "/code/backend", projectId: "p", projectName: "客户经营平台" },
        bot
      )
    ).toMatchObject({ name: "客户经营平台", kindLabel: "项目工作区", isDefault: false })
  })
  it("keeps a readable fallback while the Bot catalog is unavailable", () => {
    expect(botWorkspaceDisplay("/data/bots/workspaces/deleted").name).toBe("Bot · 默认工作区")
    expect(botWorkspaceDisplay("D:\\业务资料\\需求分析").name).toBe("需求分析")
  })
})
