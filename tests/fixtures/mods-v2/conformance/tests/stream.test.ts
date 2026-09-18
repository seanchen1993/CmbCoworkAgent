import { test, expect, tier } from "claude-code/testing"
tier("user")
const cases = [
  ["cmb-transform", ["ONE", "TWO"], "terminal-value", 1],
  ["cmb-delegate", ["one", "two"], "onetwo", 1],
  ["cmb-stream-fail", ["wrapped-one", "two"], "onetwo", 1],
  ["cmb-stream-double", ["one", "two", "one", "two"], "onetwo", 2],
  ["cmb-stream-throw-before", ["one", "two"], "onetwo", 1],
  ["cmb-stream-catch", ["one", "two"], "onetwo", 1]
]
for (const [model, texts, answer, requests] of cases) {
  test(`stream semantics: ${model}`, async ($, on) => {
    let count = 0
    on("turn.step", { model }, async function* ($, e) {
      count++
      yield { kind: "text", index: 0, text: "one" }
      yield { kind: "text", index: 0, text: "two" }
      return {
        turnId: e.turnId,
        index: e.index,
        answer: "onetwo",
        toolUses: [],
        stopReason: "end_turn",
        usage: null
      }
    })
    const stream = $.turn.step({ turnId: "probe", index: 0, model, messageCount: 1 })
    const chunks = []
    let terminal
    while (true) {
      const item = await stream.next()
      if (item.done) {
        terminal = item.value
        break
      }
      chunks.push(item.value.text)
    }
    expect(chunks).toEqual(texts)
    expect(terminal.answer).toBe(answer)
    expect(count).toBe(requests)
  })
}
