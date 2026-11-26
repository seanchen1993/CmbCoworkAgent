import { afterEach, describe, expect, it, vi } from "vitest"
import { loadVisibleMessageImages } from "./load-visible-message-images"

const element = {} as Element
const images = [{ filename: "figure.png", url: "data:image/webp;base64,cGl4ZWxz" }]

function stubVisibility() {
  let notify: (visible: boolean) => void = () => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        notify = (visible) => callback([{ isIntersecting: visible }])
      }
      observe = observe
      disconnect = disconnect
    }
  )
  return { setVisible: (visible: boolean) => notify(visible), observe, disconnect }
}

afterEach(() => vi.unstubAllGlobals())

describe("loadVisibleMessageImages", () => {
  it("reads a virtualized message once when it approaches the viewport", async () => {
    const observer = stubVisibility()
    const read = vi.fn().mockResolvedValue(images)
    const complete = vi.fn()
    const dispose = loadVisibleMessageImages(element, read, complete)
    expect(observer.observe).toHaveBeenCalledWith(element)
    observer.setVisible(false)
    expect(read).not.toHaveBeenCalled()
    observer.setVisible(true)
    observer.setVisible(true)
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledExactlyOnceWith(images)
    expect(observer.disconnect).toHaveBeenCalled()
    dispose()
  })

  it("drops a late result when a row is recycled into another message", async () => {
    const observer = stubVisibility()
    let finish!: (result: typeof images) => void
    const read = () =>
      new Promise<typeof images>((resolve) => {
        finish = resolve
      })
    const complete = vi.fn()
    const dispose = loadVisibleMessageImages(element, read, complete)
    observer.setVisible(true)
    dispose()
    finish(images)
    await Promise.resolve()
    expect(complete).not.toHaveBeenCalled()
  })

  it("keeps an empty receipt distinct from a failed read", async () => {
    vi.stubGlobal("IntersectionObserver", undefined)
    const complete = vi.fn()
    loadVisibleMessageImages(element, async () => [], complete)
    loadVisibleMessageImages(
      element,
      async () => {
        throw Error("unavailable")
      },
      complete
    )
    await Promise.resolve()
    expect(complete.mock.calls).toEqual([[[]], [null]])
  })
})
