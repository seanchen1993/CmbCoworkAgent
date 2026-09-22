import { expect, test, tier } from "claude-code/testing"
tier("user")

test("usage options and plugin origin reach the lower operation", async ($, on) => {
  on("session.usage", (_, e, next) => {
    expect(e).toEqual({ columns: 60 })
    expect(next.origin.plugin).toBe("session-usage")
    return { value: { context: { window: 1000, tokens: 120, percent: 12 }, rateLimits: [] } }
  })
  expect(JSON.parse((await $.command.run({ command: "usage-probe" })).text)).toEqual({
    context: { window: 1000, tokens: 120, percent: 12 },
    rateLimits: []
  })
})

test("a fresh window preserves absent readings", async ($, on) => {
  on("session.usage", () => ({ value: { context: { window: 1000 }, rateLimits: [] } }))
  expect(JSON.parse((await $.command.run({ command: "usage-probe" })).text)).toEqual({
    context: { window: 1000 },
    rateLimits: []
  })
})

test("denied usage rejects the SDK operation", async ($, on) => {
  on("session.usage", () => ({ deny: "usage denied" }))
  expect((await $.command.run({ command: "usage-probe" })).text).toContain("caught:")
})
