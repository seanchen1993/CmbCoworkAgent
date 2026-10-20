import { expect, it, vi } from "vitest"
import { FunctionSessionActivity } from "./session-activity"
import { dispatchFunctionStream } from "./stream-dispatcher"

it("explicit retirement observes a short native read settling without cancelling it", async () => {
  const activity = new FunctionSessionActivity()
  const release = activity.retainFresh()
  const controller = new AbortController()
  const admission = activity.pauseForRetirementWhenIdle(controller.signal)
  expect(activity.foregroundSize).toBe(1)
  release()
  expect(await admission).toBe(true)
  expect(controller.signal.aborted).toBe(false)
  expect(() => activity.retainFresh()).toThrow("MODS_CONFIG_APPLYING")
  activity.resume()
  activity.retainFresh()()
})

it("bounded retirement admission leaves running work untouched on timeout or cancellation", async () => {
  const activity = new FunctionSessionActivity()
  const release = activity.retainFresh()
  const controller = new AbortController()
  expect(await activity.pauseForRetirementWhenIdle(controller.signal, 1)).toBe(false)
  expect(activity.foregroundSize).toBe(1)
  const pending = activity.pauseForRetirementWhenIdle(controller.signal)
  const rejected = expect(pending).rejects.toThrow("caller left")
  controller.abort(Error("caller left"))
  await rejected
  release()
  activity.retainFresh()()
})

it.each([false, true])(
  "native retainFresh does not lend its token to an expired ordinary ALS caller (throws=%s)",
  async (failed) => {
    const activity = new FunctionSessionActivity()
    const wake = Promise.withResolvers<void>()
    const effect = vi.fn(async () => "unrelated SDK")
    let late!: Promise<void>
    await activity.run(async () => {
      late = wake.promise.then(async () => {
        expect(() => activity.retain()).toThrow("MODS_ENTRY_EXPIRED")
        const release = activity.retainFresh()
        try {
          expect(activity.size).toBe(1)
          expect(activity.pauseIfIdle()).toBe(false)
          expect(() => activity.retain()).toThrow("MODS_ENTRY_EXPIRED")
          await expect(activity.run(effect)).rejects.toThrow("MODS_ENTRY_EXPIRED")
          expect(effect).not.toHaveBeenCalled()
          if (failed) throw Error("actual native caller failed")
        } finally {
          release()
        }
        expect(activity.size).toBe(0)
      })
    })
    expect(activity.size).toBe(0)
    wake.resolve()
    if (failed) await expect(late).rejects.toThrow("actual native caller failed")
    else await late
    expect(effect).not.toHaveBeenCalled()
    expect(activity.pauseIfIdle()).toBe(true)
  }
)

it.each(["pause", "close"] as const)(
  "native retainFresh preserves the actual %s admission fence",
  async (action) => {
    const activity = new FunctionSessionActivity()
    const wake = Promise.withResolvers<void>()
    let late!: Promise<void>
    await activity.run(async () => {
      late = wake.promise.then(() => {
        expect(() => activity.retainFresh()).toThrow(
          action === "pause" ? "MODS_CONFIG_APPLYING" : "MODS_SESSION_CLOSED"
        )
        expect(activity.size).toBe(0)
      })
    })
    if (action === "pause") expect(activity.pauseIfIdle()).toBe(true)
    else activity.close()
    wake.resolve()
    await late
  }
)

it("native timer waits remain owned but cannot publish while paused", async () => {
  const activity = new FunctionSessionActivity()
  const wake = Promise.withResolvers<void>()
  const published = vi.fn()
  const pending = activity.fresh(async () => {
    await activity.nativeWait(() => wake.promise)
    expect(activity.foregroundSize).toBe(1)
    published()
  })
  expect(activity.size).toBe(1)
  expect(activity.foregroundSize).toBe(0)
  expect(activity.pauseIfIdle()).toBe(false)
  expect(activity.pauseIfIdle(false)).toBe(true)
  wake.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(published).not.toHaveBeenCalled()
  activity.resume()
  await pending
  expect(published).toHaveBeenCalledOnce()
  expect(activity.size).toBe(0)
})

it("retirement rejects a waking native timer before its callback or publication", async () => {
  const activity = new FunctionSessionActivity()
  const wake = Promise.withResolvers<void>()
  const callback = vi.fn()
  const pending = activity.fresh(async () => {
    await activity.nativeWait(() => wake.promise)
    callback()
  })
  const rejected = expect(pending).rejects.toThrow("MODS_SESSION_CLOSED")
  expect(activity.pauseIfIdle(false)).toBe(true)
  activity.close()
  wake.resolve()
  await rejected
  expect(callback).not.toHaveBeenCalled()
  expect(activity.size).toBe(0)
})

it.each(["pause", "close"] as const)(
  "rechecks %s inserted between native wait admission and foreground promotion",
  async (action) => {
    const activity = new FunctionSessionActivity()
    const wake = Promise.withResolvers<void>()
    const published = vi.fn()
    const pending = activity.fresh(async () => {
      await activity.nativeWait(() => wake.promise)
      published()
    })
    const settled =
      action === "close" ? expect(pending).rejects.toThrow("MODS_SESSION_CLOSED") : pending
    wake.resolve()
    queueMicrotask(() => {
      if (action === "close") activity.close()
      else expect(activity.pauseIfIdle(false)).toBe(true)
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(published).not.toHaveBeenCalled()
    if (action === "pause") activity.resume()
    await settled
    expect(published).toHaveBeenCalledTimes(action === "pause" ? 1 : 0)
  }
)

it("a rejected native wait remains paused until preflight failure resumes the old instance", async () => {
  const activity = new FunctionSessionActivity()
  const wake = Promise.withResolvers<void>()
  const caught = vi.fn()
  const pending = activity.fresh(async () => {
    try {
      await activity.nativeWait(() => wake.promise)
    } catch (error) {
      expect(activity.foregroundSize).toBe(1)
      caught(error)
    }
  })
  expect(activity.pauseIfIdle(false)).toBe(true)
  wake.reject(Error("native timer failed"))
  await Promise.resolve()
  await Promise.resolve()
  expect(caught).not.toHaveBeenCalled()
  activity.resume()
  await pending
  expect(caught.mock.calls[0][0].message).toBe("native timer failed")
  await expect(activity.nativeWait(async () => {})).rejects.toThrow("MODS_NATIVE_WAIT_SCOPE")
})

it("only host-acknowledged resources are excluded from an explicit foreground pause", async () => {
  const activity = new FunctionSessionActivity()
  const resource = activity.retainResource()
  expect(activity.pauseIfIdle(false)).toBe(false)
  resource.ready()
  expect(activity.size).toBe(1)
  expect(activity.foregroundSize).toBe(0)
  expect(activity.pauseIfIdle()).toBe(false)
  expect(activity.pauseIfIdle(false)).toBe(true)
  resource.closing()
  expect(activity.foregroundSize).toBe(1)
  resource.release()
})

it("a paused resource ancestor cannot start a new SDK call or sync entry", async () => {
  const activity = new FunctionSessionActivity()
  const wake = Promise.withResolvers<void>()
  const arrived = Promise.withResolvers<void>()
  const call = vi.fn(async () => "new effect")
  const pending = activity.resource(async () => {
    arrived.resolve()
    await wake.promise
    expect(() => activity.sync(() => {})).toThrow("MODS_CONFIG_APPLYING")
    return activity.run(call)
  })
  await arrived.promise
  expect(activity.pauseIfIdle(false)).toBe(true)
  wake.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(call).not.toHaveBeenCalled()
  const rejected = expect(pending).rejects.toThrow("MODS_SESSION_CLOSED")
  activity.close()
  await rejected
})

it("host cleanup drains a paused resource without admitting unrelated work", async () => {
  const activity = new FunctionSessionActivity()
  const resource = activity.retainResource()
  resource.ready()
  expect(activity.pauseIfIdle(false)).toBe(true)
  activity.close()
  await activity.cleanup(() => activity.run(async () => resource.release()))
  expect(activity.size).toBe(0)
  expect(() => activity.retain()).toThrow("MODS_SESSION_CLOSED")
})

it("retains actual async cleanup after a logical cancellation", async () => {
  const activity = new FunctionSessionActivity()
  const cleanup = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const run = activity.run(async () => {
    try {
      entered.resolve()
      throw Error("cancelled")
    } finally {
      await cleanup.promise
    }
  })
  const rejected = expect(run).rejects.toThrow("cancelled")
  await entered.promise
  expect(activity.size).toBe(1)
  expect(activity.pauseIfIdle()).toBe(false)
  cleanup.resolve()
  await rejected
  expect(activity.pauseIfIdle()).toBe(true)
})

it("a stream result resolving or rejecting early cannot retire an unfinished iterator", async () => {
  for (const failed of [false, true]) {
    const activity = new FunctionSessionActivity()
    const cleanup = Promise.withResolvers<void>()
    const source = (async function* () {
      try {
        yield "answer"
        return "done"
      } finally {
        await cleanup.promise
      }
    })()
    const result = failed ? Promise.reject(Error("early result")) : Promise.resolve("early result")
    void result.catch(() => {})
    const stream = await activity.run(async () => Object.assign(source, { result }))
    await result.catch(() => {})
    expect(activity.pauseIfIdle()).toBe(false)
    expect(await stream.next()).toEqual({ done: false, value: "answer" })
    const closing = stream.return("closed")
    await Promise.resolve()
    expect(activity.size).toBe(1)
    cleanup.resolve()
    expect(await closing).toEqual({ done: true, value: "closed" })
    expect(activity.pauseIfIdle()).toBe(true)
  }
})

it("pause queues fresh background entries and failure resume preserves their work", async () => {
  const activity = new FunctionSessionActivity()
  expect(activity.pauseIfIdle()).toBe(true)
  const callback = vi.fn(async () => "tick")
  const next = activity.fresh(callback)
  await Promise.resolve()
  expect(callback).not.toHaveBeenCalled()
  expect(activity.size).toBe(0)
  activity.resume()
  expect(await next).toBe("tick")
  expect(callback).toHaveBeenCalledOnce()
})

it("an expired inherited token cannot silently become a fresh nested call", async () => {
  const activity = new FunctionSessionActivity()
  let late!: () => Promise<unknown>
  await activity.run(async () => {
    late = await new Promise((resolve) => {
      const handler = () => resolve(() => activity.run(async () => "bad"))
      // A delayed continuation retains the original async context after the entry has ended.
      queueMicrotask(handler)
    })
  })
  // Capture the actual inherited context independently of the caller of the returned function.
  let continuation!: Promise<unknown>
  const start = Promise.withResolvers<void>()
  await activity.run(async () => {
    continuation = start.promise.then(() => late())
  })
  start.resolve()
  await expect(continuation).rejects.toThrow("MODS_ENTRY_EXPIRED")
  expect(activity.size).toBe(0)
})

it("nested work stays live and independently retains an unawaited host Promise", async () => {
  const activity = new FunctionSessionActivity()
  const finish = Promise.withResolvers<void>()
  let child!: Promise<void>
  await activity.run(async () => {
    child = activity.run(() => finish.promise)
  })
  expect(activity.size).toBe(1)
  expect(activity.pauseIfIdle()).toBe(false)
  finish.resolve()
  await child
  expect(activity.pauseIfIdle()).toBe(true)
})

it("explicit scope disposal is idempotent and synchronous methods stay synchronous", () => {
  const activity = new FunctionSessionActivity()
  expect(activity.sync(() => 42)).toBe(42)
  const dispose = activity.retain()
  expect(activity.size).toBe(1)
  dispose()
  dispose()
  expect(activity.size).toBe(0)
})

it("a native resource admits outside an expired drawing without dropping actual occupancy", async () => {
  const activity = new FunctionSessionActivity()
  const enter = Promise.withResolvers<void>()
  let continuation!: Promise<ReturnType<FunctionSessionActivity["retainFreshResource"]>>
  await activity.run(async () => {
    continuation = enter.promise.then(() => activity.retainFreshResource())
  })
  enter.resolve()
  const native = await continuation
  expect(activity.size).toBe(1)
  expect(activity.foregroundSize).toBe(1)
  expect(activity.pauseIfIdle(false)).toBe(false)
  native.ready()
  expect(activity.size).toBe(1)
  expect(activity.foregroundSize).toBe(0)
  expect(activity.pauseIfIdle()).toBe(false)
  expect(activity.pauseIfIdle(false)).toBe(true)
  activity.resume()
  native.closing()
  expect(activity.pauseIfIdle(false)).toBe(false)
  native.release()
  native.release()
  expect(activity.size).toBe(0)
})

it("close rejects queued new work without pretending existing cleanup has finished", async () => {
  const activity = new FunctionSessionActivity()
  activity.pauseIfIdle()
  const queued = activity.fresh(async () => "never")
  const rejected = expect(queued).rejects.toThrow("MODS_SESSION_CLOSED")
  activity.close()
  await rejected
  expect(activity.size).toBe(0)
})

it("async disposal waits for finally even if return yields an additional cleanup item", async () => {
  const activity = new FunctionSessionActivity()
  let cleaned = false
  const source = (async function* () {
    try {
      yield "answer"
    } finally {
      yield "cleanup"
      cleaned = true
    }
  })()
  const stream = await activity.run(async () => source)
  await stream.next()
  await stream[Symbol.asyncDispose]()
  expect(cleaned).toBe(true)
  expect(activity.size).toBe(0)
})

it("wraps actual transport streams with non-writable return methods and preserves result identity", async () => {
  for (const ending of ["return", "throw", "dispose"] as const) {
    const activity = new FunctionSessionActivity()
    let cleaned = false
    const actual = dispatchFunctionStream(
      [],
      {},
      {
        core: async function* () {
          try {
            yield { text: "answer" }
            return {}
          } finally {
            cleaned = true
          }
        }
      }
    )
    const stream = await activity.run(async () => actual)
    expect(stream.result).toBe(actual.result)
    expect(await stream.next()).toEqual({ done: false, value: { text: "answer" } })
    if (ending === "return") await stream.return({})
    else if (ending === "throw") await stream.throw(Error("cancel")).catch(() => {})
    else await stream[Symbol.asyncDispose]()
    expect(cleaned).toBe(true)
    expect(activity.size).toBe(0)
  }
})

it("notifies foreground idle after release and resource demotion without polling", async () => {
  const idle = vi.fn()
  const activity = new FunctionSessionActivity(undefined, undefined, idle)
  const release = activity.retainFresh()
  const resource = activity.retainFreshResource()
  release()
  await Promise.resolve()
  expect(idle).not.toHaveBeenCalled()
  resource.ready()
  await Promise.resolve()
  expect(idle).toHaveBeenCalledOnce()
  expect(activity.size).toBe(1)
  resource.closing()
  resource.release()
  await Promise.resolve()
  expect(idle).toHaveBeenCalledTimes(2)
})

it("contains idle observer errors and detaches pending notifications on close", async () => {
  const idle = vi.fn(() => { throw Error("observer") })
  const activity = new FunctionSessionActivity(undefined, undefined, idle)
  activity.retainFresh()()
  await Promise.resolve()
  expect(activity.size).toBe(0)
  expect(idle).toHaveBeenCalledOnce()
  activity.retainFresh()()
  activity.close()
  await Promise.resolve()
  expect(idle).toHaveBeenCalledOnce()
})

it("only native UI lifetimes can cross development retirement, remaining occupied until drain", async () => {
  const idle = vi.fn()
  const activity = new FunctionSessionActivity(undefined, undefined, idle)
  const ui = activity.retainRetirableUiResource()
  const release = activity.retainFresh()
  expect(activity.pauseForRetirement()).toBe(false)
  release()
  await Promise.resolve()
  expect(idle).toHaveBeenCalledOnce()
  expect(activity.foregroundSize).toBe(1)
  expect(activity.pauseIfIdle(false)).toBe(false)
  expect(activity.pauseForRetirement()).toBe(true)
  expect(() => activity.retainFresh()).toThrow("MODS_CONFIG_APPLYING")
  expect(activity.size).toBe(1)
  activity.close()
  expect(activity.size).toBe(1)
  ui.release()
  expect(activity.size).toBe(0)
})


it("explicit retirement pauses new admission and waits for real foreground release", async () => {
  const activity = new FunctionSessionActivity()
  const held = activity.retainFreshResource()
  let ready = false
  const waiting = activity.pauseAndWaitForRetirement().then(() => { ready = true })
  await Promise.resolve()
  expect(ready).toBe(false)
  expect(() => activity.retainFresh()).toThrow("MODS_CONFIG_APPLYING")
  held.release()
  await waiting
  expect(ready).toBe(true)
  expect(() => activity.retainFresh()).toThrow("MODS_CONFIG_APPLYING")
  activity.close()
})


it("mixed retirement waits for ordinary foreground but lets native UI be cancelled by drain", async () => {
  const activity = new FunctionSessionActivity()
  const ordinary = activity.retainFreshResource()
  const nativeUi = activity.retainRetirableUiResource()
  let ready = false
  const waiting = activity.pauseAndWaitForRetirement().then(() => { ready = true })
  await Promise.resolve()
  expect(ready).toBe(false)
  expect(activity.foregroundSize).toBe(2)
  ordinary.release()
  await waiting
  expect(activity.foregroundSize).toBe(1)
  expect(activity.retirementBlockingSize).toBe(0)
  // The remaining UI is owned by the subsequent host session close, never an admission permit.
  activity.close()
  nativeUi.release()
  expect(activity.size).toBe(0)
})

it("external close wakes a pending explicit retirement as unknown rather than a false drain", async () => {
  const activity = new FunctionSessionActivity()
  const held = activity.retainFreshResource()
  const waiting = activity.pauseAndWaitForRetirement()
  activity.close()
  await expect(waiting).rejects.toThrow("MODS_SESSION_CLOSED")
  held.release()
})

it("closed admission never mistakes its outer caller or native cleanup for settled occupancy", async () => {
  const activity = new FunctionSessionActivity()
  const caller = activity.retainFresh()
  const gate = Promise.withResolvers<void>()
  const cleanup = activity.cleanup(() => gate.promise)
  activity.close()
  let settled = false
  const waiting = activity.whenSettled().then(() => { settled = true })
  caller()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(activity.size).toBe(1)
  gate.resolve()
  await cleanup
  await waiting
  expect(settled).toBe(true)
  expect(activity.size).toBe(0)
})
