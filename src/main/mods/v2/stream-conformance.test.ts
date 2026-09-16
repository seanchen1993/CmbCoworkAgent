import { resolve } from "node:path"
import { expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { dispatchFunctionStream } from "./stream-dispatcher"

const cases = [
  ["cmb-transform", ["ONE", "TWO"], "terminal-value", 1],
  ["cmb-delegate", ["one", "two"], "onetwo", 1],
  ["cmb-stream-fail", ["wrapped-one", "two"], "onetwo", 1],
  ["cmb-stream-double", ["one", "two", "one", "two"], "onetwo", 2],
  ["cmb-stream-throw-before", ["one", "two"], "onetwo", 1],
  ["cmb-stream-catch", ["one", "two"], "onetwo", 1]
] as const
it.each(cases)("Claude streaming conformance: %s", async (model, texts, answer, requests) => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/conformance"))
  const guest = await FunctionGuestRuntime.create(compiled.code)
  try {
    let count = 0
    const stream = dispatchFunctionStream(
      [{ name: compiled.name, root: compiled.root, tier: "user", guest, capabilities: [] }],
      { turnId: "probe", index: 0, model, messageCount: 1 },
      {
        async *core(e) {
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
        }
      }
    )
    const chunks: unknown[] = []
    for await (const chunk of stream) chunks.push((chunk as ModObject).text)
    expect(chunks).toEqual(texts)
    expect(((await stream.result) as ModObject).answer).toBe(answer)
    expect(count).toBe(requests)
  } finally {
    guest.dispose()
  }
})
