import { IterableReadableStream } from "@langchain/core/utils/stream"
import { describe, expect, it, vi } from "vitest"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"
import { createNativeEventStream } from "./native-event-stream"

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture<T>(prepared: Promise<unknown>, open: (input: unknown) => AsyncIterable<T>) {
  const cut = new AbortController(), caller = new AbortController(), parent = new AbortController()
  const signal = AbortSignal.any([cut.signal, caller.signal, parent.signal])
  const stream = createNativeEventStream({ prepared, open, cut, signal,
    assertCurrent: () => signal.throwIfAborted() })
  return { stream, cut, caller, parent }
}

describe("native event stream cancellation and actual cleanup", () => {
  it("keeps a native ReadableStream and ordered events, preserving the actual source error", async () => {
    const failure = new Error("actual event source failure")
    const f = fixture(Promise.resolve("actual input"), async function* (input) {
      yield input
      yield "second"
      throw failure
    })
    expect(f.stream).toBeInstanceOf(IterableReadableStream)
    const reader = f.stream.getReader()
    expect(await reader.read()).toEqual({ done: false, value: "actual input" })
    expect(await reader.read()).toEqual({ done: false, value: "second" })
    await expect(reader.read()).rejects.toBe(failure)
    await f.stream[FUNCTION_STREAM_TERMINAL]
    expect(f.cut.signal.aborted).toBe(false)
  })

  it("cuts before preparation returns without opening a provider or claiming actual completion", async () => {
    const held = deferred(), open = vi.fn(async function* () { yield "forbidden" })
    const f = fixture(held.promise, open)
    let closed = false
    void f.stream[FUNCTION_STREAM_TERMINAL].then(() => { closed = true })
    const cancelled = f.stream.cancel("own cancel")
    expect(f.stream.signal.aborted).toBe(true)
    expect(f.cut.signal.reason).toBe("own cancel")
    expect(f.caller.signal.aborted).toBe(false)
    expect(f.parent.signal.aborted).toBe(false)
    expect(open).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(closed).toBe(false)
    held.resolve()
    await cancelled
    await f.stream[FUNCTION_STREAM_TERMINAL]
    expect(closed).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })

  it("reader cancellation aborts immediately but waits for ignored reads and yielding finally", async () => {
    const entered = deferred(), held = deferred(), cleanupEntered = deferred(), cleanup = deferred()
    let finished = 0
    const inner = (async function* () {
      try { entered.resolve(); await held.promise; yield "late native event" }
      finally { cleanupEntered.resolve(); yield "cleanup event"; await cleanup.promise; finished++ }
    })()
    const returned = vi.spyOn(inner, "return")
    const f = fixture(Promise.resolve(null), () => inner)
    const reader = f.stream.getReader(), read = reader.read()
    await entered.promise
    const cancelled = reader.cancel("reader cancel")
    expect(f.cut.signal.aborted).toBe(true)
    expect(f.parent.signal.aborted).toBe(false)
    expect(await read).toEqual({ done: true, value: undefined })
    let terminal = false
    void f.stream[FUNCTION_STREAM_TERMINAL].then(() => { terminal = true })
    held.resolve()
    await cleanupEntered.promise
    expect(finished).toBe(0)
    expect(terminal).toBe(false)
    expect(returned).toHaveBeenCalledTimes(1)
    cleanup.resolve()
    await cancelled
    await f.stream[FUNCTION_STREAM_TERMINAL]
    expect(finished).toBe(1)
    expect(terminal).toBe(true)
    expect(returned).toHaveBeenCalledTimes(1)
  })

  it.each(["return", "throw"] as const)(
    "iterator %s closes its own cut and preserves the original throw value", async method => {
      const held = deferred(), entered = deferred()
      const f = fixture(Promise.resolve(null), async function* () {
        entered.resolve()
        await held.promise
        yield "late"
      })
      const next = f.stream.next()
      await entered.promise
      const error = new Error("actual consumer throw")
      const closed = method === "return" ? f.stream.return() : f.stream.throw(error)
      const observed = method === "return" ?
        expect(closed).resolves.toEqual({ done: true, value: undefined }) :
        expect(closed).rejects.toBe(error)
      expect(f.stream.signal.aborted).toBe(true)
      expect(f.caller.signal.aborted).toBe(false)
      held.resolve()
      expect(await next).toEqual({ done: true, value: undefined })
      await observed
      await f.stream[FUNCTION_STREAM_TERMINAL]
    }
  )

  it("forwards a parent abort without aborting the caller or disguising a held native read as done", async () => {
    const held = deferred(), entered = deferred()
    const f = fixture(Promise.resolve(null), async function* () {
      entered.resolve()
      await held.promise
      yield "late"
    })
    const reader = f.stream.getReader(), next = reader.read()
    await entered.promise
    const reason = new Error("actual parent cancellation")
    const rejected = expect(next).rejects.toBe(reason)
    f.parent.abort(reason)
    await rejected
    expect(f.cut.signal.aborted).toBe(false)
    expect(f.caller.signal.aborted).toBe(false)
    let terminal = false
    void f.stream[FUNCTION_STREAM_TERMINAL].then(() => { terminal = true })
    await Promise.resolve()
    expect(terminal).toBe(false)
    held.resolve()
    await f.stream[FUNCTION_STREAM_TERMINAL]
    expect(terminal).toBe(true)
  })
})
