import { expect, it } from "vitest"
import { parseBotPluginCommand } from "./bot-plugin-command"

it("recognizes only an explicit composer command and preserves argument newlines", () => {
  expect(parseBotPluginCommand("/plugins\n")).toEqual({ kind: "list" })
  expect(parseBotPluginCommand("/plugins 2")).toEqual({ kind: "list", page: 2 })
  expect(parseBotPluginCommand("/plugin notes 中文\n第二行")).toEqual({
    kind: "run",
    name: "notes",
    args: "中文\n第二行"
  })
  expect(parseBotPluginCommand("/plugin owner:run")).toEqual({
    kind: "run",
    name: "owner:run",
    args: ""
  })
  for (const text of [
    "请运行 /plugin notes",
    "> /plugin notes",
    "`/plugin notes`",
    " /plugins",
    "/plugins args",
    "/plugin ../run",
    "/plugin",
    "/plugin <script>"
  ])
    expect(parseBotPluginCommand(text)).toBeUndefined()
})
