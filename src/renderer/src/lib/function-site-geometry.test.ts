import { afterEach, expect, it, vi } from "vitest"
import { observeFunctionSiteGeometry } from "./function-site-geometry"
import { observeFunctionSiteLayoutWidth } from "./function-site-width"

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
    ({ ownerDocument: document, isConnected: true, parentElement: {}, closest: vi.fn(() => null) }) as unknown as HTMLElement
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
  expect(saved).toHaveBeenLastCalledWith({ height: 360, width: 720, layoutWidth: 720 })
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

it("keys geometry to the allocated message row rather than a shrink-to-fit bubble", () => {
  const f = fixture()
  const node = f.node()
  Object.defineProperty(node, "clientWidth", { value: 160 })
  vi.mocked(node.closest).mockReturnValue({ clientWidth: 720 } as HTMLElement)
  const saved = vi.fn()
  const dispose = observeFunctionSiteGeometry(node, saved)
  f.paint()
  expect(saved).toHaveBeenCalledWith({ height: 360, width: 720, layoutWidth: 720 })
  dispose()
})

it("finishes all same-frame reads before callbacks can write layout or cancel a subscriber", () => {
  const f = fixture()
  const order: string[] = []
  f.measured.mockImplementation(() => {
    order.push("read")
    return { width: 720, height: 360 }
  })
  let stopSecond = () => {}
  const first = observeFunctionSiteGeometry(f.node(), () => {
    order.push("write")
    stopSecond()
  })
  const second = vi.fn(() => order.push("unexpected stale publish"))
  stopSecond = observeFunctionSiteGeometry(f.node(), second)
  f.paint()
  expect(order).toEqual(["read", "read", "write"])
  expect(second).not.toHaveBeenCalled()
  first()
})

it("batches pending row width reads before reservation writes and cancels cold deletion", () => {
  const f = fixture()
  const order: string[] = []
  const observers = Array.from({ length: 40 }, () => {
    const node = f.node()
    Object.defineProperty(node, "clientWidth", { get: () => {
      order.push("read")
      return 720
    } })
    return observeFunctionSiteLayoutWidth(node, width => {
      expect(width).toBe(720)
      order.push("write")
    })
  })
  expect(order).toEqual([])
  observers[0].dispose()
  f.notify()
  f.notify()
  expect(f.request).toHaveBeenCalledOnce()
  f.paint()
  expect(order).toEqual([...Array(39).fill("read"), ...Array(39).fill("write")])
  observers.forEach(observer => observer.refresh())
  observers.forEach(observer => observer.dispose())
  const count = order.length
  f.paint()
  expect(order).toHaveLength(count)
})

it("does not publish pending widths after a sibling write disposes or detaches the row", () => {
  const f = fixture()
  const node = f.node()
  Object.defineProperty(node, "clientWidth", { value: 720 })
  const stale = vi.fn()
  const first = observeFunctionSiteLayoutWidth(node, () => second.dispose())
  const second = observeFunctionSiteLayoutWidth(node, stale)
  f.paint()
  expect(stale).not.toHaveBeenCalled()
  Object.defineProperty(node, "isConnected", { value: false })
  first.refresh()
  f.paint()
  first.dispose()
})
