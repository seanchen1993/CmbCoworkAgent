import { expect, test, tier } from "claude-code/testing"
tier("user")

test("tool.check is an engine event with a bare result and the caller origin", async ($, on) => {
  let called = 0
  on("tool.check", (_, e, next) => {
    called++
    expect(e).toEqual({ tool: "Read", input: { file_path: "fixture.txt" } })
    expect(next.origin).toEqual({ plugin: "tool-check", tier: "user" })
    return { decision: "ask", reason: "fixture permission", rule: "Read" }
  })
  const answer = await $.command.run({ command: "permission-probe" })
  expect(JSON.parse(answer.text)).toEqual({
    decision: "ask",
    reason: "fixture permission",
    rule: "Read"
  })
  expect(called).toBe(1)
})

test("tool.check supports explicit deny without invoking a tool", async ($, on) => {
  let tools = 0
  on("tool.call", () => {
    tools++
    return { text: "unexpected" }
  })
  on("tool.check", () => ({ decision: "deny", reason: "fixture denied" }))
  const answer = await $.command.run({ command: "permission-probe" })
  expect(JSON.parse(answer.text)).toEqual({ decision: "deny", reason: "fixture denied" })
  expect(tools).toBe(0)
})

test("rewriting pinned input skips the optional hook and preserves the original query", async ($, on) => {
  on("tool.check", (_, e) => ({ decision: "allow", reason: e.input.file_path }))
  const answer = await $.command.run({ command: "permission-probe", args: "rewrite" })
  expect(JSON.parse(answer.text)).toEqual({ decision: "allow", reason: "original.txt" })
})
