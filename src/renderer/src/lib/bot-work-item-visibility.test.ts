import { afterEach, expect, it, vi } from "vitest"
import { observeBotWorkItem } from "./use-bot-work-item-visibility"
afterEach(() => vi.unstubAllGlobals())
it("shares one passive observer for many offscreen rows, routes visibility exactly and releases every retained element", () => {
  const elements = Array.from({ length: 100 }, () => ({}) as Element)
  let callback!: IntersectionObserverCallback
  const observe = vi.fn(),
    unobserve = vi.fn(),
    disconnect = vi.fn()
  const construct = vi.fn(function (this: unknown, cb: IntersectionObserverCallback) {
    callback = cb
    return { observe, unobserve, disconnect }
  })
  vi.stubGlobal("IntersectionObserver", construct)
  const listeners = elements.map(() => vi.fn())
  const releases = elements.map((element, index) => observeBotWorkItem(element, listeners[index]))
  expect(construct).toHaveBeenCalledOnce()
  expect(observe).toHaveBeenCalledTimes(100)
  expect(listeners.every((listener) => listener.mock.calls[0][0] === false)).toBe(true)
  callback(
    [{ target: elements[90], isIntersecting: true }] as IntersectionObserverEntry[],
    {} as IntersectionObserver
  )
  expect(listeners[90]).toHaveBeenLastCalledWith(true)
  expect(listeners[89]).toHaveBeenCalledOnce()
  releases[90]()
  releases[90]()
  callback(
    [{ target: elements[90], isIntersecting: true }] as IntersectionObserverEntry[],
    {} as IntersectionObserver
  )
  expect(listeners[90]).toHaveBeenCalledTimes(2)
  releases.forEach((release) => release())
  expect(unobserve).toHaveBeenCalledTimes(100)
  expect(disconnect).toHaveBeenCalledOnce()
  const last = observeBotWorkItem(elements[0], vi.fn())
  expect(construct).toHaveBeenCalledTimes(2)
  last()
})
it("does not publish after a fallback subscription unmounts before its initial microtask", async () => {
  vi.stubGlobal("IntersectionObserver", undefined)
  const publish = vi.fn(),
    release = observeBotWorkItem({} as Element, publish)
  release()
  await Promise.resolve()
  expect(publish).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledWith(false)
})
