import { describe, expect, it, vi } from "vitest"
import { observeChatViewportResize } from "./chat-viewport-resize"

function fixture() {
  let notify = (): void => undefined
  const disconnect = vi.fn()
  const viewport = {
    clientWidth: 600,
    clientHeight: 609,
    isConnected: true,
    ownerDocument: {
      defaultView: {
        ResizeObserver: class {
          constructor(callback: () => void) { notify = callback }
          observe = vi.fn()
          disconnect = disconnect
        }
      }
    }
  }
  const changed = vi.fn()
  const dispose = observeChatViewportResize(viewport as unknown as HTMLElement, changed)
  return { viewport, changed, dispose, disconnect, notify: () => notify() }
}

describe("chat viewport resize notifications", () => {
  it("ignores the initial sample and duplicate sizes, including width-only changes", () => {
    const f = fixture()
    f.notify()
    expect(f.changed).not.toHaveBeenCalled()
    f.viewport.clientHeight = 337
    f.notify()
    f.notify()
    expect(f.changed).toHaveBeenCalledTimes(1)
    f.viewport.clientWidth = 450
    f.notify()
    expect(f.changed).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it("waits for a hidden viewport to become measurable again", () => {
    const f = fixture()
    f.viewport.clientHeight = 0
    f.notify()
    expect(f.changed).not.toHaveBeenCalled()
    f.viewport.clientHeight = 609
    f.notify()
    expect(f.changed).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it("rejects queued deliveries after cleanup or DOM removal", () => {
    const f = fixture()
    f.viewport.clientHeight = 337
    f.viewport.isConnected = false
    f.notify()
    expect(f.changed).not.toHaveBeenCalled()
    f.viewport.isConnected = true
    f.dispose()
    f.notify()
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.disconnect).toHaveBeenCalledOnce()
  })
})
