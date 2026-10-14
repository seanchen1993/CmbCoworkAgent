import { expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionStreamCursor } from "./stream-cursor"
import { FunctionSessionActivity } from "./session-activity"

it("reuses an actual in-flight first pull when the old frame disappears, then delivers each item once", async () => {
  const arrival = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  let pulls = 0
  const source = (async function* () {
    pulls++
    arrival.resolve()
    await finish.promise
    yield "first"
    pulls++
    yield "second"
    return "done"
  })()
  const cursor = new FunctionStreamCursor(source, new AbortController().signal)
  const old = new AbortController()
  const pending = cursor.read({ signal: old.signal })
  const rejection = expect(pending).rejects.toThrow()
  await arrival.promise
  old.abort()
  const owner = { signal: new AbortController().signal }
  const resumed = cursor.read(owner)
  finish.resolve()
  await rejection
  const first = await resumed
  expect(first.item).toEqual({ done: false, value: "first" })
  expect(pulls).toBe(1)
  cursor.accept(owner, first.receipt)
  cursor.commit(owner)
  const remaining: ModJson[] = []
  for await (const item of cursor.remaining()) remaining.push(item)
  expect(remaining).toEqual(["second"])
  expect(pulls).toBe(2)
  await cursor.close()
})

it("requires exact host owner and receipt, retaining acknowledged but not yet published input after failure", async () => {
  const source = (async function* () {
    yield "unpublished"
    return "done"
  })()
  const cursor = new FunctionStreamCursor(source, new AbortController().signal)
  const old = new AbortController(),
    owner = { signal: old.signal }
  const first = await cursor.read(owner)
  expect(() => cursor.accept({ signal: old.signal }, first.receipt)).toThrow(
    "MODS_STREAM_RECEIPT_INVALID"
  )
  expect(() => cursor.accept(owner, "forged")).toThrow("MODS_STREAM_RECEIPT_INVALID")
  cursor.accept(owner, first.receipt)
  old.abort()
  const recovered = await cursor.remaining().next()
  expect(recovered).toEqual({ done: false, value: "unpublished" })
  await cursor.close()
})

it("retains one native return through yielding and abort-ignoring actual finally cleanup", async () => {
  const activity = new FunctionSessionActivity(),
    cleanup = Promise.withResolvers<void>()
  let returns = 0
  const source = (async function* () {
    try {
      yield "answer"
    } finally {
      returns++
      yield "cleanup"
      await cleanup.promise
    }
    return "done"
  })()
  const cursor = new FunctionStreamCursor(source, new AbortController().signal, {
    run: (run) => activity.run(run),
    cleanup: (run) => activity.cleanup(run)
  })
  const owner = { signal: new AbortController().signal }
  const first = await cursor.read(owner)
  cursor.accept(owner, first.receipt)
  cursor.commit(owner)
  const closing = cursor.close()
  expect(cursor.close()).toBe(closing)
  await Promise.resolve()
  await Promise.resolve()
  expect(activity.size).toBe(1)
  cleanup.resolve()
  await closing
  expect(returns).toBe(1)
  expect(activity.size).toBe(0)
})
