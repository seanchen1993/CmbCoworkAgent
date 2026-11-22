import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WarmDisplayRuntime } from "./warm-display-runtime"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

describe("WarmDisplayRuntime", () => {
  const workspace = "/workspace"
  const epoch = "epoch:1"
  const client = { id: "empty-host" }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("owns one starting host and transfers it once to the matching scope after ready", async () => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const ready = deferred<() => boolean>()
    const proof = vi.fn(() => true)
    const prepare = vi.fn(() => ready.promise)
    const stop = vi.fn(async () => {})
    const duplicate = vi.fn(async () => () => true)

    slot.start(workspace, epoch, client, prepare, stop)
    slot.start("/other", epoch, { id: "unstarted" }, duplicate, stop)
    expect(slot.occupied).toBe(true)
    expect(slot.take(workspace, epoch)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(prepare).toHaveBeenCalledOnce()
    expect(duplicate).not.toHaveBeenCalled()
    expect(slot.take(workspace, epoch)).toBeUndefined()

    ready.resolve(proof)
    await vi.advanceTimersByTimeAsync(0)
    expect(slot.take("/other", epoch)).toBeUndefined()
    expect(slot.take(workspace, "epoch:2")).toBeUndefined()
    expect(proof).not.toHaveBeenCalled()
    expect(slot.take(workspace, epoch)).toBe(client)
    expect(proof).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(false)
    expect(slot.take(workspace, epoch)).toBeUndefined()
    await slot.retire(workspace)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(stop).not.toHaveBeenCalled()
  })

  it("expires the starting host after 15 seconds and holds capacity until physical exit", async () => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const ready = deferred<() => boolean>()
    const proof = vi.fn(() => true)
    const exited = deferred<void>()
    const stop = vi.fn(() => exited.promise)

    slot.start(workspace, epoch, client, () => ready.promise, stop)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stop).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(true)

    ready.resolve(proof)
    await vi.advanceTimersByTimeAsync(0)
    expect(slot.take(workspace, epoch)).toBeUndefined()
    expect(proof).not.toHaveBeenCalled()
    exited.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(slot.occupied).toBe(false)
  })

  it("retains the occupied slot after an unconfirmed exit until an explicit retry succeeds", async () => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const stop = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(Error("exit unconfirmed"))
      .mockResolvedValueOnce(undefined)
    const replacement = vi.fn(async () => () => true)

    slot.start(workspace, epoch, client, async () => () => true, stop)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(stop).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(true)
    expect(slot.take(workspace, epoch)).toBeUndefined()
    slot.start(workspace, epoch, { id: "unstarted" }, replacement, stop)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(replacement).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()

    await slot.retire(workspace)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(slot.occupied).toBe(false)
  })

  it("joins explicit retirement and prevents a synchronous cancellation from starting a host", async () => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const prepare = vi.fn(async () => () => true)
    const exited = deferred<void>()
    const stop = vi.fn(() => exited.promise)

    slot.start(workspace, epoch, client, prepare, stop)
    const unrelated = slot.retire("/other")
    const draining = slot.retire(workspace)
    expect(slot.retire()).toBe(draining)
    await unrelated
    expect(prepare).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(true)

    exited.resolve()
    await draining
    expect(slot.occupied).toBe(false)
  })

  it("bounds admission waits while keeping the slot until a late physical exit", async () => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const exited = deferred<void>()
    const stop = vi.fn(() => exited.promise)
    slot.start(workspace, epoch, client, async () => () => true, stop)
    await vi.advanceTimersByTimeAsync(0)

    const continued = vi.fn()
    const yielded = slot.retireForAdmission().then(continued)
    await vi.advanceTimersByTimeAsync(100)
    expect(continued).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    await yielded
    expect(continued).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(true)
    expect(slot.take(workspace, epoch)).toBeUndefined()

    exited.resolve()
    await slot.retire()
    expect(slot.occupied).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
  })

  it("retires a host if its physical readiness preparation rejects", async () => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const stop = vi.fn(async () => {})
    slot.start(workspace, epoch, client, async () => { throw Error("host exited") }, stop)

    await vi.advanceTimersByTimeAsync(0)
    expect(stop).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(false)
    expect(slot.take(workspace, epoch)).toBeUndefined()
  })

  it.each([
    () => false,
    () => { throw Error("host exited") }
  ])("retires a ready host that fails its current proof", async (proof) => {
    const slot = new WarmDisplayRuntime<typeof client>()
    const stop = vi.fn(async () => {})
    slot.start(workspace, epoch, client, async () => proof, stop)
    await vi.advanceTimersByTimeAsync(0)

    expect(slot.take(workspace, epoch)).toBeUndefined()
    expect(slot.occupied).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(stop).toHaveBeenCalledOnce()
    expect(slot.occupied).toBe(false)
  })
})
