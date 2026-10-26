import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createTrustedFunctionWaitScope,
  FunctionTrustedWaitClock,
  FUNCTION_TRUSTED_WAIT_LIMIT_MS,
  withoutTrustedFunctionWaitScope,
  withTrustedFunctionWait,
  withTrustedFunctionWaitScope
} from "./trusted-function-wait"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { boundFunctionStream } from "./bounded-stream"
import type { ModJson } from "../../../shared/mods/types"

afterEach(() => vi.useRealTimers())
const deferred = <T = void>() => Promise.withResolvers<T>()
const clockParticipant = (ms = 120000) => ({
  clock: new FunctionTrustedWaitClock(ms),
  assertCurrent: vi.fn(),
  abort: vi.fn()
})

describe("private trusted Function waits", () => {
  it("retains exact active remainder instead of restarting the invocation", () => {
    let now = 0
    const clock = new FunctionTrustedWaitClock(120000, () => now)
    now = 110000
    clock.begin("approval", 900000)
    now += 125000
    expect(clock.expiresAt - now).toBe(10000)
    clock.end("approval")
    expect(clock.creditMs).toBe(125000)
    now += 9999
    clock.assertLive()
    now++
    expect(() => clock.assertLive()).toThrow("MODS_BUDGET_EXCEEDED")
    expect(() => clock.begin("late", 1)).toThrow()
  })

  it("counts overlaps as a union and rejects duplicate/replayed ticket operations", () => {
    let now = 0
    const clock = new FunctionTrustedWaitClock(10, () => now)
    clock.begin("a", 900000)
    now = 20
    clock.begin("b", 900000)
    expect(() => clock.begin("a", 1)).toThrow("MODS_TRUSTED_WAIT_INVALID")
    now = 30
    clock.end("a")
    expect(clock.creditMs).toBe(30)
    now = 40
    clock.end("b")
    expect(clock.creditMs).toBe(40)
    expect(clock.expiresAt).toBe(50)
    expect(() => clock.end("a")).toThrow("MODS_TRUSTED_WAIT_STALE")
    expect(() => clock.begin("a", 900000)).toThrow("MODS_TRUSTED_WAIT_INVALID")
  })

  it("denies new SDK admission while its native wait ticket is active", () => {
    const clock = new FunctionTrustedWaitClock(120000)
    clock.begin("approval", 900000)
    expect(() => clock.assertDispatchAllowed()).toThrow("MODS_TRUSTED_WAIT_DISPATCH_BLOCKED")
    clock.end("approval")
    clock.assertDispatchAllowed()
    clock.close()
    expect(() => clock.begin("old-frame", 900000)).toThrow()
  })

  it("shares the finite allowance across sequential children of the same original owner", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] })
    const root = createTrustedFunctionWaitScope()
    const first = clockParticipant()
    let second: ReturnType<typeof clockParticipant> | undefined
    try {
      await root.run(async () => {
        await withTrustedFunctionWaitScope(first, async () => {
          const release = deferred()
          const pending = withTrustedFunctionWait("user-approval", undefined, () => release.promise)
          await Promise.resolve()
          await vi.advanceTimersByTimeAsync(FUNCTION_TRUSTED_WAIT_LIMIT_MS - 10000)
          release.resolve()
          await pending
        })
        // This child invocation starts after the first one settled. Its active
        // clock is fresh; only the original owner's trusted-wait allowance is shared.
        second = clockParticipant()
        await withTrustedFunctionWaitScope(second, async () => {
          const release = deferred()
          const pending = withTrustedFunctionWait("user-approval", undefined, () => release.promise)
          const observed = pending.then(
            () => ({ rejected: false, error: undefined }),
            (error) => ({ rejected: true, error })
          )
          await vi.advanceTimersByTimeAsync(10000)
          const outcome = await observed
          expect(outcome.rejected).toBe(true)
          expect(outcome.error).toMatchObject({ message: "MODS_TRUSTED_WAIT_EXPIRED" })
          release.resolve()
        })
      })
      expect(first.abort).not.toHaveBeenCalled()
      expect(second?.abort).toHaveBeenCalledOnce()
    } finally {
      root.close()
    }
  })

  it("keeps sibling root sessions isolated and propagates ordinary rejection without aborting", async () => {
    const a = clockParticipant(),
      b = clockParticipant()
    const expected = Error("ordinary dialog failure")
    await Promise.all([
      withTrustedFunctionWaitScope(a, async () => {
        await expect(
          withTrustedFunctionWait("user-approval", undefined, async () => {
            throw expected
          })
        ).rejects.toBe(expected)
        a.clock.assertDispatchAllowed()
      }),
      withTrustedFunctionWaitScope(b, async () => {
        b.clock.assertDispatchAllowed()
        expect(b.clock.creditMs).toBe(0)
      })
    ])
    expect(a.abort).not.toHaveBeenCalled()
    expect(b.abort).not.toHaveBeenCalled()
  })

  it("does not lend a closed parent's wait owner to a deliberately fresh child execution", async () => {
    const parent = clockParticipant(),
      child = clockParticipant()
    const resumeChild = deferred()
    let childRun!: Promise<void>
    await withTrustedFunctionWaitScope(parent, async () => {
      childRun = withoutTrustedFunctionWaitScope(async () => {
        await resumeChild.promise
        await withTrustedFunctionWaitScope(child, async () => {
          await expect(
            withTrustedFunctionWait("user-approval", undefined, async () => "allowed")
          ).resolves.toBe("allowed")
        })
      })
    })
    resumeChild.resolve()
    await childRun
    expect(child.abort).not.toHaveBeenCalled()
    expect(parent.clock.creditMs).toBe(0)
  })

  it.each([true, false])(
    "retains the explicit fresh boundary after a synchronous child re-enables ALS (fresh=%s)",
    async (fresh) => {
      const parent = createTrustedFunctionWaitScope()
      const release = deferred()
      const callback = vi.fn()
      const periods = async () => {
        // This synchronous first child is essential: AsyncLocalStorage.exit() alone
        // can restore the old parent store when the nested run() re-enables ALS.
        const first = createTrustedFunctionWaitScope()
        try {
          first.run(() => undefined)
        } finally {
          first.close()
        }
        await release.promise
        const second = createTrustedFunctionWaitScope()
        try {
          second.run(callback)
        } finally {
          second.close()
        }
      }
      const pending = parent.run(() =>
        fresh ? withoutTrustedFunctionWaitScope(periods) : periods()
      )
      parent.close()
      release.resolve()
      if (fresh) {
        await pending
        expect(callback).toHaveBeenCalledOnce()
      } else {
        await expect(pending).rejects.toThrow("MODS_TRUSTED_WAIT_STALE")
        expect(callback).not.toHaveBeenCalled()
      }
    }
  )

  it("counts concurrent waits once for the same logical owner", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] })
    const participant = clockParticipant()
    await withTrustedFunctionWaitScope(participant, async () => {
      const a = deferred(),
        b = deferred()
      const first = withTrustedFunctionWait("user-approval", undefined, () => a.promise)
      await vi.advanceTimersByTimeAsync(20)
      const second = withTrustedFunctionWait("policy-queue", undefined, () => b.promise)
      await vi.advanceTimersByTimeAsync(10)
      a.resolve()
      await first
      await vi.advanceTimersByTimeAsync(10)
      b.resolve()
      await second
      expect(participant.clock.creditMs).toBe(40)
      expect(participant.clock.expiresAt).toBe(120040)
    })
    expect(participant.abort).not.toHaveBeenCalled()
  })

  it("never opens a dialog after late ACK and does not refund an expired main caller", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] })
    const ack = deferred()
    const participant = { ...clockParticipant(20), prepare: vi.fn(() => ack.promise) }
    const dialog = vi.fn(async () => "allowed")
    const pending = withTrustedFunctionWaitScope(participant, () =>
      withTrustedFunctionWait("user-approval", undefined, dialog)
    )
    const rejected = expect(pending).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    await vi.advanceTimersByTimeAsync(21)
    ack.resolve()
    await rejected
    expect(dialog).not.toHaveBeenCalled()
    expect(participant.clock.creditMs).toBe(0)
    expect(participant.abort).toHaveBeenCalledOnce()
  })

  it("aborts all ancestors on partial ACK failure without starting the protected work", async () => {
    const a = { ...clockParticipant(), prepare: vi.fn(async () => {}) }
    const b = {
      ...clockParticipant(),
      prepare: vi.fn(async () => {
        throw Error("wrong call owner")
      })
    }
    const work = vi.fn(async () => "allowed")
    await expect(
      withTrustedFunctionWaitScope(a, () =>
        withTrustedFunctionWaitScope(b, () =>
          withTrustedFunctionWait("user-approval", undefined, work)
        )
      )
    ).rejects.toThrow("wrong call owner")
    expect(work).not.toHaveBeenCalled()
    expect(a.abort).toHaveBeenCalledOnce()
    expect(b.abort).toHaveBeenCalledOnce()
    expect(a.clock.creditMs).toBe(0)
  })

  it("cancels without waiting for approval and ignores a late allow", async () => {
    const participant = clockParticipant()
    const controller = new AbortController()
    const shown = deferred(),
      reply = deferred<string>()
    const spawn = vi.fn()
    const pending = withTrustedFunctionWaitScope(participant, async () => {
      await withTrustedFunctionWait("user-approval", controller.signal, () => {
        shown.resolve()
        return reply.promise
      })
      spawn()
    })
    await shown.promise
    const rejected = expect(pending).rejects.toThrow("revoked")
    controller.abort(Error("revoked"))
    await rejected
    reply.resolve("allowed")
    await Promise.resolve()
    expect(spawn).not.toHaveBeenCalled()
    expect(participant.abort).toHaveBeenCalledOnce()
  })

  it("pauses an opted-in ordinary dispatch but never its inherited hard cut", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "hrtime"] })
    const soft = new FunctionDispatchDeadline(100, undefined, undefined, true)
    const hard = new FunctionDispatchDeadline(50)
    const gate = deferred()
    try {
      const pending = soft.run(() =>
        soft.wait(withTrustedFunctionWait("user-approval", hard.signal, () => gate.promise))
      )
      const rejected = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(50)
      await rejected
      expect(hard.signal.aborted).toBe(true)
      expect(soft.signal.aborted).toBe(true)
      gate.resolve()
    } finally {
      soft.close()
      hard.close()
    }
  })

  it("retains the same cumulative allowance across actual bounded stream pulls", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "hrtime"] })
    const first = deferred(),
      second = deferred()
    async function* values(): AsyncGenerator<ModJson, ModJson> {
      await withTrustedFunctionWait("user-approval", undefined, () => first.promise)
      yield "first"
      await withTrustedFunctionWait("user-approval", undefined, () => second.promise)
      return "second"
    }
    const cancel = vi.fn()
    const stream = boundFunctionStream(values(), {
      deadline: () => ({
        value: new FunctionDispatchDeadline(120000, undefined, undefined, true),
        shared: false
      }),
      cancel
    })
    const one = stream.next()
    await vi.advanceTimersByTimeAsync(FUNCTION_TRUSTED_WAIT_LIMIT_MS - 10000)
    first.resolve()
    expect(await one).toEqual({ done: false, value: "first" })
    const two = stream.next()
    const rejected = expect(two).rejects.toThrow("MODS_TRUSTED_WAIT_EXPIRED")
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
    second.resolve()
    expect(cancel).toHaveBeenCalled()
  })
})
