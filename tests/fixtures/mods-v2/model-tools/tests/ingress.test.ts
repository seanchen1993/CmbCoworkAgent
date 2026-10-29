import { test, expect, tier } from "claude-code/testing"
tier("user")
test("engine tool ingress has engine origin, independent next refs, context and recovery", async ($, on) => {
  let count = 0
  on("tool.call", (_, e) => ({ result: e.file_path, text: e.file_path, ref: ++count }))
  expect(await $.tool.call({ tool: "read_file", file_path: "input" })).toEqual({
    result: "second",
    text: "second",
    ref: 2,
    context: ["engine", "first"]
  })
  expect(await $.tool.call({ tool: "read_file", file_path: "deny" })).toEqual({ deny: "No read" })
  expect(await $.tool.call({ tool: "read_file", file_path: "throw-after" })).toEqual({
    result: "once",
    text: "once",
    ref: 3
  })
  expect(count).toBe(3)
})
