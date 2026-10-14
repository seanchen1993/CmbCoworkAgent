import { afterEach, expect, it, vi } from "vitest"
import { PluginCatalogGate } from "./catalog-gate"
afterEach(() => vi.useRealTimers())
const options = (signal = new AbortController().signal) => ({ signal, assertCurrent: () => {} })

it("commits synchronously on the final release before the next admission", async () => {
  const gate = new PluginCatalogGate(), release = gate.retain()
  const write = vi.fn(() => "applied")
  const pending = gate.commitWhenIdle(() => {}, write, options())
  expect(write).not.toHaveBeenCalled()
  release()
  expect(write).toHaveBeenCalledTimes(1)
  const nextRelease = gate.retain()
  await expect(pending).resolves.toBe("applied")
  nextRelease()
})

it("times out persistent activity at 2s with no write or retained listener", async () => {
  vi.useFakeTimers()
  const gate = new PluginCatalogGate(), release = gate.retain(), write = vi.fn()
  const pending = gate.commitWhenIdle(() => {}, write, options())
  const rejection = expect(pending).rejects.toThrow("PLUGIN_CATALOG_BUSY")
  await vi.advanceTimersByTimeAsync(2000)
  await rejection
  release()
  expect(write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps one ticket when external bookkeeping clears after the zero edge", async () => {
  vi.useFakeTimers()
  const gate = new PluginCatalogGate(), release = gate.retain(), write = vi.fn(() => 7)
  let busy = true
  const pending = gate.commitWhenIdle(() => { if (busy) throw Error("PLUGIN_CATALOG_BUSY") }, write, options())
  release()
  expect(write).not.toHaveBeenCalled()
  busy = false
  await vi.advanceTimersByTimeAsync(25)
  await expect(pending).resolves.toBe(7)
  expect(write).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it("cancels pending admission without invoking the operation", async () => {
  vi.useFakeTimers()
  const gate = new PluginCatalogGate(), release = gate.retain(), controller = new AbortController()
  const write = vi.fn(), pending = gate.commitWhenIdle(() => {}, write, options(controller.signal))
  const rejection = expect(pending).rejects.toThrow("cancelled")
  controller.abort(Error("cancelled"))
  await rejection
  release()
  expect(write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("revalidates scope at release and never writes a stale candidate", async () => {
  const gate = new PluginCatalogGate(), release = gate.retain(), write = vi.fn()
  let current = true
  const pending = gate.commitWhenIdle(() => {}, write, {
    ...options(), assertCurrent: () => { if (!current) throw Error("AUTHORING_INSTALL_STALE") }
  })
  const rejection = expect(pending).rejects.toThrow("AUTHORING_INSTALL_STALE")
  current = false
  release()
  await rejection
  expect(write).not.toHaveBeenCalled()
})

it("never replays an operation that itself throws BUSY", async () => {
  vi.useFakeTimers()
  const gate = new PluginCatalogGate(), write = vi.fn(() => { throw Error("PLUGIN_CATALOG_BUSY") })
  await expect(gate.commitWhenIdle(() => {}, write, options())).rejects.toThrow("PLUGIN_CATALOG_BUSY")
  await vi.advanceTimersByTimeAsync(2100)
  expect(write).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it("admits nested operations while an apply waits, and commits only after both drain", async () => {
  const gate = new PluginCatalogGate(), outer = gate.retain(), write = vi.fn(() => true)
  const pending = gate.commitWhenIdle(() => {}, write, options())
  const inner = gate.retain()
  outer()
  expect(write).not.toHaveBeenCalled()
  inner()
  await expect(pending).resolves.toBe(true)
  expect(write).toHaveBeenCalledTimes(1)
})

it("does not reenter a queued operation when commit retires a resource", async () => {
  const gate = new PluginCatalogGate(), release = gate.retain()
  const write = vi.fn(() => { const cleanup = gate.retainRetirement(); cleanup(); return true })
  const pending = gate.commitWhenIdle(() => {}, write, options())
  release()
  await expect(pending).resolves.toBe(true)
  expect(write).toHaveBeenCalledTimes(1)
})

it("does not let an abort inside an entered operation hide its successful result", async () => {
  const gate = new PluginCatalogGate(), controller = new AbortController()
  const write = vi.fn(() => { controller.abort(Error("late cancellation")); return "settled" })
  await expect(gate.commitWhenIdle(() => {}, write, options(controller.signal))).resolves.toBe("settled")
  expect(write).toHaveBeenCalledTimes(1)
})

it("preserves an entered operation failure when it also aborts the admission signal", async () => {
  const gate = new PluginCatalogGate(), controller = new AbortController()
  const failure = Error("write failed")
  const write = vi.fn(() => { controller.abort(Error("late cancellation")); throw failure })
  await expect(gate.commitWhenIdle(() => {}, write, options(controller.signal))).rejects.toBe(failure)
  expect(write).toHaveBeenCalledTimes(1)
})

it("rejects an already-aborted signal without writing or retaining timers", async () => {
  vi.useFakeTimers()
  const gate = new PluginCatalogGate(), controller = new AbortController(), write = vi.fn()
  controller.abort(Error("already cancelled"))
  await expect(gate.commitWhenIdle(() => {}, write, options(controller.signal))).rejects.toThrow("already cancelled")
  expect(write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("checks monotonic expiry on release even before the timeout callback runs", async () => {
  const gate = new PluginCatalogGate(), release = gate.retain(), write = vi.fn()
  const now = vi.spyOn(performance, "now").mockReturnValue(0)
  try {
    const pending = gate.commitWhenIdle(() => {}, write, options())
    const rejection = expect(pending).rejects.toThrow("PLUGIN_CATALOG_BUSY")
    now.mockReturnValue(2001)
    release()
    await rejection
    expect(write).not.toHaveBeenCalled()
  } finally { now.mockRestore() }
})

it("rejects non-BUSY idle-check errors immediately without invoking the operation", async () => {
  vi.useFakeTimers()
  const gate = new PluginCatalogGate(), write = vi.fn(), failure = Error("idle check broken")
  await expect(gate.commitWhenIdle(() => { throw failure }, write, options())).rejects.toBe(failure)
  expect(write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["idle", "final-scope"])("refuses admission if the %s check exhausts the deadline", async stage => {
  vi.useFakeTimers()
  let time = 0
  let scopeChecks = 0
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time)
  const gate = new PluginCatalogGate()
  const write = vi.fn()
  try {
    const pending = gate.commitWhenIdle(
      () => { if (stage === "idle") time = 2001 },
      write,
      {
        ...options(),
        assertCurrent: () => {
          scopeChecks++
          if (stage === "final-scope" && scopeChecks === 2) time = 2001
        }
      }
    )
    await expect(pending).rejects.toThrow("PLUGIN_CATALOG_BUSY")
    expect(write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { clock.mockRestore() }
})

it("does not write when the final scope check aborts its signal synchronously", async () => {
  const controller = new AbortController()
  const gate = new PluginCatalogGate()
  const write = vi.fn()
  let scopeChecks = 0
  await expect(gate.commitWhenIdle(() => {}, write, {
    signal: controller.signal,
    assertCurrent: () => {
      if (++scopeChecks === 2) controller.abort(Error("scope closed"))
    }
  })).rejects.toThrow("scope closed")
  expect(write).not.toHaveBeenCalled()
})
