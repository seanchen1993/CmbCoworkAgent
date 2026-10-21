import { afterEach, expect, it, vi } from "vitest"
import { observeFunctionSiteGeometry } from "./function-site-geometry"

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++next, callback)
    return next
  })
  const cancel = vi.fn((id: number) => {
    frames.delete(id)
  })
  const measured = vi.fn(() => ({ width: 720, height: 360 }))
  const document = {
    defaultView: { requestAnimationFrame: request, cancelAnimationFrame: cancel },
    createRange: vi.fn(() => ({
      selectNodeContents: vi.fn(),
      getBoundingClientRect: measured,
      detach: vi.fn()
    }))
  }
  const notifications: Array<() => void> = []
  class Observer {
    constructor(callback: () => void) {
      notifications.push(callback)
    }
    observe = vi.fn()
    disconnect = vi.fn()
  }
  vi.stubGlobal("ResizeObserver", Observer)
  vi.stubGlobal("MutationObserver", Observer)
  const node = () =>
    ({ ownerDocument: document, isConnected: true, parentElement: {} }) as unknown as HTMLElement
  return {
    node,
    request,
    cancel,
    measured,
    document,
    notify: () => notifications.forEach((callback) => callback()),
    paint: () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(0))
    }
  }
}

it("does no synchronous layout work while mounting or deleting a cold drawing", () => {
  const f = fixture()
  const saved = vi.fn()
  const dispose = observeFunctionSiteGeometry(f.node(), saved)
  expect(f.measured).not.toHaveBeenCalled()
  dispose()
  f.paint()
  f.notify()
  f.paint()
  expect(f.document.createRange).not.toHaveBeenCalled()
  expect(saved).not.toHaveBeenCalled()
  expect(f.cancel).toHaveBeenCalledOnce()
})

it("coalesces all mounted drawing geometry into one frame and reads each at most once", () => {
  const f = fixture()
  const saved = vi.fn()
  const stops = Array.from({ length: 40 }, () => observeFunctionSiteGeometry(f.node(), saved))
  f.notify()
  f.notify()
  expect(f.request).toHaveBeenCalledOnce()
  stops[0]()
  f.paint()
  expect(f.measured).toHaveBeenCalledTimes(39)
  expect(saved).toHaveBeenCalledTimes(39)
  expect(saved).toHaveBeenLastCalledWith({ height: 360, width: 720 })
  f.notify()
  f.notify()
  expect(f.request).toHaveBeenCalledTimes(2)
  f.paint()
  expect(f.measured).toHaveBeenCalledTimes(78)
  const reads = f.measured.mock.calls.length
  stops.forEach((stop) => stop())
  expect(f.measured).toHaveBeenCalledTimes(reads)
})

it("ignores detached drawings and invalid geometry without publishing measurements", () => {
  const f = fixture()
  const saved = vi.fn()
  const node = f.node()
  const dispose = observeFunctionSiteGeometry(node, saved)
  Object.defineProperty(node, "isConnected", { value: false, configurable: true })
  f.paint()
  expect(f.measured).not.toHaveBeenCalled()
  Object.defineProperty(node, "isConnected", { value: true })
  f.measured.mockReturnValue({ height: Number.NaN, width: 20 })
  f.notify()
  f.paint()
  expect(saved).not.toHaveBeenCalled()
  dispose()
})
