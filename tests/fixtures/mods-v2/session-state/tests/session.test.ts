import { expect, test, tier } from "claude-code/testing"
tier("user")

test("session state operations have empty inputs and plugin origin", async ($, on) => {
  for (const [method, value] of [
    ["session.model", "actual"],
    ["session.turns", 2],
    ["session.messages", [{ role: "user", text: "prompt", toolUses: [] }]]
  ]) {
    on(method, (_, e, next) => {
      expect(e).toEqual({})
      expect(next.origin.plugin).toBe("session-state")
      return { value }
    })
  }
  expect(JSON.parse((await $.command.run({ command: "session-state" })).text)).toEqual({
    model: "view:actual",
    turns: 2,
    messages: [{ role: "user", text: "prompt", toolUses: [] }]
  })
})

test("an empty transcript and zero turns retain their values", async ($, on) => {
  on("session.model", () => ({ value: "actual" }))
  on("session.turns", () => ({ value: 0 }))
  on("session.messages", () => ({ value: [] }))
  expect(JSON.parse((await $.command.run({ command: "session-state" })).text)).toEqual({
    model: "view:actual",
    turns: 0,
    messages: []
  })
})

test("denied state reads reject the SDK operation", async ($, on) => {
  on("session.model", () => ({ deny: "state denied" }))
  expect((await $.command.run({ command: "session-state" })).text).toContain("caught:")
})
