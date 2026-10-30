import { test, expect, tier } from "claude-code/testing"

tier("user")
test("model completion operation unwraps text and explicit next calls independently", async ($, on) => {
  let calls = 0
  on("model.complete", (_, e) => {
    calls++
    expect(e.model).toBe("fixture")
    expect(e.maxTokens).toBe(32)
    return { value: e.prompt }
  })
  expect((await $.command.run({ command: "model-probe", args: "input" })).text)
    .toBe("model-sdk:first:second")
  expect((await $.command.run({ command: "model-probe", args: "short" })).text)
    .toBe("local answer")
  expect(calls).toBe(2)
})
