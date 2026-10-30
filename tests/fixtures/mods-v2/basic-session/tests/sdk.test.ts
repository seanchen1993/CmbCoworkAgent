import { expect, test, tier } from "claude-code/testing"

tier("user")
test("SDK operations, nested dispatch, registration return and void results", async ($, on) => {
  const commands = new Map()
  let waits = 0
  on("command.register", (_, e) => {
    commands.set(e.name, e)
    return { value: { command: e.name } }
  })
  on("command.list", () => ({ value: [...commands.values()].map((c) => ({ ...c, source: "plugin" })) }))
  on("session.id", () => ({ value: "thread" }))
  on("clock.sleep", (_, e) => {
    expect(e.ms).toBe(0)
    waits++
    return { value: undefined }
  })
  const answer = await $.command.run({ command: "sdk-probe", args: "" })
  expect(JSON.parse(answer.text)).toEqual({
    registered: { command: "sdk-child" },
    description: "Child!",
    id: "nested:other:thread",
    now: 123,
    short: "undefined",
    next: "undefined"
  })
  expect(waits).toBe(1)
})
