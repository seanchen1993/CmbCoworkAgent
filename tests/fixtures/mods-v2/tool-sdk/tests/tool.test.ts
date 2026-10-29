import { test, expect, tier } from "claude-code/testing"
tier("user")
test("tool SDK preserves the result envelope, plugin origin and denial", async ($, on) => {
  let count = 0
  on("tool.call", (_, e) => {
    count++
    return { result: e.file_path, text: e.file_path }
  })
  expect(JSON.parse((await $.command.run({ command: "tool-probe", args: "input" })).text))
    .toEqual({ result: "rewritten", text: "rewritten", context: ["tool-sdk"] })
  expect(JSON.parse((await $.command.run({ command: "tool-probe", args: "deny" })).text))
    .toEqual({ deny: "No read" })
  expect(count).toBe(1)
})
