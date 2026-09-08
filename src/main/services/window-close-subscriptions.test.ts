import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
  subscribeWindowClosed,
  type WindowCloseTarget
} from "./window-close-subscriptions"

class TestWindow extends EventEmitter implements WindowCloseTarget {
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
    this.emit("closed")
  }
}

describe("window close subscriptions", () => {
  it("uses one emitter listener for many concurrent task streams", () => {
    const window = new TestWindow()
    const callbacks = Array.from({ length: 32 }, () => vi.fn())
    callbacks.forEach((callback) => subscribeWindowClosed(window, callback))

    expect(window.listenerCount("closed")).toBe(1)
    window.close()
    expect(callbacks.every((callback) => callback.mock.calls.length === 1)).toBe(true)
    expect(window.listenerCount("closed")).toBe(0)
  })

  it("removes the shared listener after the final subscription is disposed", () => {
    const window = new TestWindow()
    const first = subscribeWindowClosed(window, vi.fn())
    const second = subscribeWindowClosed(window, vi.fn())

    first()
    expect(window.listenerCount("closed")).toBe(1)
    second()
    expect(window.listenerCount("closed")).toBe(0)
  })

  it("runs immediately when the window is already destroyed", () => {
    const window = new TestWindow()
    window.destroyed = true
    const callback = vi.fn()

    subscribeWindowClosed(window, callback)
    expect(callback).toHaveBeenCalledOnce()
    expect(window.listenerCount("closed")).toBe(0)
  })

  it("isolates close callback failures", () => {
    const window = new TestWindow()
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const survivingCallback = vi.fn()
    subscribeWindowClosed(window, () => {
      throw new Error("broken cleanup")
    })
    subscribeWindowClosed(window, survivingCallback)

    expect(() => window.close()).not.toThrow()
    expect(survivingCallback).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })
})
