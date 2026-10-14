import { afterEach, describe, expect, it, vi } from "vitest"
import { createWindowPresentationStore } from "./window-presentation"
import type { WindowPresentationSnapshot } from "../../../shared/window-presentation"

function fixture() {
  let accept!: (value: WindowPresentationSnapshot) => void
  let resolve!: (value: WindowPresentationSnapshot) => void
  const stop = vi.fn()
  const bridge = {
    onChanged: vi.fn((callback: typeof accept) => {
      accept = callback
      return stop
    }),
    read: vi.fn(
      () =>
        new Promise<WindowPresentationSnapshot>((done) => {
          resolve = done
        })
    )
  }
  const store = createWindowPresentationStore(() => bridge)
  return {
    store,
    bridge,
    stop,
    event: (version: number, presentable: boolean) => accept({ version, presentable }),
    resolve: (version: number, presentable: boolean) => resolve({ version, presentable })
  }
}

afterEach(() => vi.useRealTimers())
describe("shared renderer native presentation subscription", () => {
  it("waits for initial state, listens first, and rejects stale initial responses", async () => {
    const f = fixture()
    const dispose = f.store.subscribe(vi.fn())
    expect(f.store.isPresentable(true)).toBe(false)
    expect(f.bridge.onChanged.mock.invocationCallOrder[0]).toBeLessThan(
      f.bridge.read.mock.invocationCallOrder[0]
    )
    f.event(2, false)
    f.resolve(1, true)
    await Promise.resolve()
    expect(f.store.isPresentable(true)).toBe(false)
    f.event(3, true)
    expect(f.store.isPresentable(true)).toBe(true)
    expect(f.store.isPresentable(false)).toBe(false)
    dispose()
  })
  it("shares a single subscription and rejects responses from a retired lifecycle", async () => {
    const f = fixture()
    const one = f.store.subscribe(vi.fn()),
      two = f.store.subscribe(vi.fn())
    expect(f.bridge.read).toHaveBeenCalledOnce()
    one()
    expect(f.stop).not.toHaveBeenCalled()
    two()
    expect(f.stop).toHaveBeenCalledOnce()
    f.resolve(9, false)
    await Promise.resolve()
    expect(f.store.isPresentable(true)).toBe(true)
  })
  it("permits visible unfocused windows and falls back for old preload", () => {
    const store = createWindowPresentationStore(() => undefined)
    const dispose = store.subscribe(vi.fn())
    expect(store.isPresentable(true)).toBe(true)
    expect(store.isPresentable(false)).toBe(false)
    dispose()
  })
  it("bounds initial unknown state and cleans up its timer", () => {
    vi.useFakeTimers()
    const f = fixture()
    const dispose = f.store.subscribe(vi.fn())
    vi.advanceTimersByTime(1499)
    expect(f.store.isPresentable(true)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(f.store.isPresentable(true)).toBe(true)
    f.event(1, false)
    expect(f.store.isPresentable(true)).toBe(false)
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("falls back after a rejected read and disposes during HMR", async () => {
    const stop = vi.fn()
    const store = createWindowPresentationStore(() => ({
      onChanged: () => stop,
      read: () => Promise.reject(Error("unavailable"))
    }))
    store.subscribe(vi.fn())
    await Promise.resolve()
    expect(store.isPresentable(true)).toBe(true)
    store.dispose()
    expect(stop).toHaveBeenCalledOnce()
  })
})
