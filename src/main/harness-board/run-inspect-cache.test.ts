import { afterEach, describe, expect, it, vi } from "vitest"
import { HarnessRunInspectCache } from "./run-inspect-cache"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

describe("shared readonly run inspections", () => {
  it("shares concurrent consumers and the delayed page refresh for one state change", async () => {
    vi.useFakeTimers()
    const cache = new HarnessRunInspectCache()
    const result = deferred<Buffer>()
    const inspect = vi.fn(() => result.promise)
    const stage = cache.run("p", "f", "command", inspect)
    const otherStage = cache.run("p", "f", "command", inspect)
    await Promise.resolve()
    expect(inspect).toHaveBeenCalledTimes(1)
    result.resolve(Buffer.from("current"))
    expect((await stage).toString()).toBe("current")
    expect((await otherStage).toString()).toBe("current")
    await vi.advanceTimersByTimeAsync(500)
    expect((await cache.run("p", "f", "command", inspect)).toString()).toBe("current")
    expect(inspect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(501)
    await cache.run("p", "f", "command", inspect)
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it("never joins or reuses a snapshot from before a state/artifact notification", async () => {
    const cache = new HarnessRunInspectCache()
    const oldResult = deferred<Buffer>()
    const inspect = vi
      .fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockResolvedValue(Buffer.from("new"))
    const old = cache.run("p", "f", "command", inspect)
    cache.invalidate("p", "f")
    expect((await cache.run("p", "f", "command", inspect)).toString()).toBe("new")
    oldResult.resolve(Buffer.from("old"))
    expect((await old).toString()).toBe("old")
    expect((await cache.run("p", "f", "command", inspect)).toString()).toBe("new")
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it("cancels one reader independently and kills the inspection only after the last leaves", async () => {
    const cache = new HarnessRunInspectCache()
    const first = new AbortController()
    const second = new AbortController()
    let executionSignal!: AbortSignal
    const inspect = vi.fn((signal: AbortSignal) => {
      executionSignal = signal
      return new Promise<Buffer>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
    })
    const page = cache.run("p", "f", "command", inspect, first.signal)
    const stage = cache.run("p", "f", "command", inspect, second.signal)
    await Promise.resolve()
    first.abort(new Error("page left"))
    await expect(page).rejects.toThrow("page left")
    expect(executionSignal.aborted).toBe(false)
    second.abort(new Error("turn ended"))
    await expect(stage).rejects.toThrow("turn ended")
    expect(executionSignal.aborted).toBe(true)
    expect(inspect).toHaveBeenCalledTimes(1)
    const recovered = vi.fn(async () => Buffer.from("retry"))
    expect((await cache.run("p", "f", "command", recovered)).toString()).toBe("retry")
  })

  it("isolates features and changed plugin commands, and never retains failed results", async () => {
    const cache = new HarnessRunInspectCache()
    const inspect = vi.fn(async () => Buffer.from("value"))
    await cache.run("p", "f", "command1", inspect)
    await cache.run("p", "other", "command1", inspect)
    await cache.run("p", "f", "command2", inspect)
    expect(inspect).toHaveBeenCalledTimes(3)
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(Buffer.from("back"))
    await expect(cache.run("p", "failed", "command", failing)).rejects.toThrow("offline")
    expect((await cache.run("p", "failed", "command", failing)).toString()).toBe("back")
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it("bounds retained bytes and avoids retaining oversized output", async () => {
    const cache = new HarnessRunInspectCache(1_000, 4, 2)
    const inspect = vi.fn(async () => Buffer.from("1234"))
    await cache.run("p", "first", "command", inspect)
    await cache.run("p", "second", "command", inspect)
    await cache.run("p", "first", "command", inspect)
    expect(inspect).toHaveBeenCalledTimes(3)
    const oversized = vi.fn(async () => Buffer.from("12345"))
    await cache.run("p", "large", "command", oversized)
    await cache.run("p", "large", "command", oversized)
    expect(oversized).toHaveBeenCalledTimes(2)
  })

  it("bounds completed entries while preserving in-flight sharing under capacity pressure", async () => {
    const cache = new HarnessRunInspectCache(1_000, 100, 2)
    const pending = deferred<Buffer>()
    const slow = vi.fn(() => pending.promise)
    const first = cache.run("p", "slow", "command", slow)
    const quick = vi.fn(async () => Buffer.from("x"))
    for (const feature of ["one", "two", "three"]) {
      await cache.run("p", feature, "command", quick)
    }
    const joined = cache.run("p", "slow", "command", slow)
    pending.resolve(Buffer.from("ready"))
    await expect(first).resolves.toEqual(Buffer.from("ready"))
    await expect(joined).resolves.toEqual(Buffer.from("ready"))
    expect(slow).toHaveBeenCalledTimes(1)
    await cache.run("p", "three", "command", quick)
    expect(quick).toHaveBeenCalledTimes(3)
    await cache.run("p", "one", "command", quick)
    expect(quick).toHaveBeenCalledTimes(4)
  })
})
