import assert from "node:assert/strict"
import type { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { dispatchFunctionPullStream } from "../../src/main/mods/v2/pull-stream-dispatcher"

export async function checkPullStream(client: FunctionRuntimeClient): Promise<string[]> {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    on("process.spawn",async function*($,e,next){const signal=next.signal;
      yield {data:await $.session.id()};yield {fresh:signal!==next.signal};return yield* next(e)})
  }}`)
  try {
    const stream = dispatchFunctionPullStream(
      [{ name: "pull", root: "/pull", tier: "prepend", guest, capabilities: [] }],
      { argv: ["fixture"] },
      {
        timeoutMs: 100,
        capabilities: () => ["session.id"],
        sdk: async () => ({ value: "current" }),
        core: async function* () {
          yield { data: "core" }
          return { code: 0 }
        }
      }
    )
    assert.deepEqual(await stream.next(), { done: false, value: { data: "current" } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(await stream.next(), { done: false, value: { fresh: true } })
    assert.deepEqual(await stream.next(), { done: false, value: { data: "core" } })
    assert.deepEqual(await stream.next(), { done: true, value: { code: 0 } })
    assert.deepEqual(await stream.result, { code: 0 })
    return [
      "real utility persistent process middleware resumes with fresh per-pull authority after idle beyond a pull budget"
    ]
  } finally {
    await guest.dispose()
  }
}
