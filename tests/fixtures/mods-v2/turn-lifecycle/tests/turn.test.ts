import { expect, test, tier } from "claude-code/testing"

tier("user")

test("turn start forwards identity and engine origin to the lower handler", async ($, on) => {
  on("turn.start", (_, e, next) => {
    expect(e).toEqual({ turnId: "turn-1", text: "prompt" })
    expect(next.origin.plugin).toBe("engine")
    return { turnId: e.turnId }
  })
  expect(await $.turn.start({ turnId: "turn-1", text: "prompt" })).toEqual({ turnId: "turn-1" })
  expect((await $.command.run({ command: "turn-probe" })).text).toBe("turn-1")
})

test("completion transforms presentation and preserves supplied usage", async ($, on) => {
  on("turn.complete", (_, e) => ({ text: e.answer, usage: e.usage }))
  const usage = {
    model: "api-model",
    input_tokens: 3,
    output_tokens: 2,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 0
  }
  expect(
    await $.turn.complete({
      turnId: "turn-1",
      answer: "answer",
      reason: "answer",
      isAborted: false,
      durationMs: 20,
      usage
    })
  ).toEqual({ text: "done:turn-1:answer:answer", usage })
})

test("abort operation carries plugin origin and void result", async ($, on) => {
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.abort", (_, e, next) => {
    expect(e).toEqual({ turnId: "turn-1" })
    expect(next.origin.plugin).toBe("turn-lifecycle")
    return { value: undefined }
  })
  await $.turn.start({ turnId: "turn-1", text: "prompt" })
  expect((await $.command.run({ command: "turn-probe", args: "abort" })).text).toBe(
    "aborted:undefined"
  )
})

test("an abort denial remains a catchable SDK rejection", async ($, on) => {
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.abort", () => ({ deny: "not allowed" }))
  await $.turn.start({ turnId: "turn-1", text: "prompt" })
  expect((await $.command.run({ command: "turn-probe", args: "abort" })).text).toContain("caught:")
})
