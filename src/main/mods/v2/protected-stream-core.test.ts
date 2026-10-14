import { expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { protectFunctionStreamCore } from "./protected-stream-core"

it("preserves a real null chunk and terminal result without substituting an object", async () => {
  const publish = vi.fn(async (value: ModJson) => value)
  const assertLive = vi.fn()
  const core = protectFunctionStreamCore(
    async function* () {
      yield null
      return null
    },
    publish,
    assertLive
  )
  const output = core({}, { callId: "native", signal: new AbortController().signal })
  expect(await output.next()).toEqual({ done: false, value: null })
  expect(await output.next()).toEqual({ done: true, value: null })
  expect(publish.mock.calls.map((call) => call[0])).toEqual([null, null])
  expect(assertLive).toHaveBeenCalled()
})

it("keeps cleanup pending until the original yielding finally is actually done", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let cleaned = false
  const core = protectFunctionStreamCore(
    async function* () {
      try {
        yield { text: "first" }
        return null
      } finally {
        entered.resolve()
        yield { text: "cleanup" }
        await finish.promise
        cleaned = true
      }
    },
    async (value) => value,
    () => {}
  )
  const output = core({}, { callId: "native", signal: new AbortController().signal })
  await output.next()
  let returned = false
  const closing = output.return(null).then((item) => {
    returned = true
    return item
  })
  await entered.promise
  await Promise.resolve()
  expect(returned).toBe(false)
  expect(cleaned).toBe(false)
  finish.resolve()
  expect(await closing).toEqual({ done: true, value: null })
  expect(cleaned).toBe(true)
})
