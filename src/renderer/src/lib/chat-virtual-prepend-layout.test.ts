import { afterEach, expect, it, vi } from "vitest"
import type { ComponentProps } from "react"
import { ChatVirtualPrependLayout } from "../components/chat/chat-virtual-prepend-layout"

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0,
    margin = 0,
    padding = 0,
    connected = true
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id)
  })
  const parent = new EventTarget()
  const viewport = Object.assign(new EventTarget(), {
    scrollTop: 0,
    isConnected: true,
    parentElement: parent,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 })
  }) as unknown as HTMLElement
  const style = { translate: "" }
  const translated = () => Number.parseFloat(style.translate.split(" ")[1] ?? "0") || 0
  const measure = vi.fn(() => {
    const top = -50 + margin + padding - viewport.scrollTop + translated()
    return { top, bottom: top + 950, height: 950 }
  })
  const anchor = { getBoundingClientRect: measure } as unknown as HTMLElement
  const root = {
    style,
    contains: (element: HTMLElement) => connected && element === anchor,
    querySelectorAll: () => [anchor]
  } as unknown as HTMLDivElement
  const ref = { current: null as HTMLDivElement | null }
  let props: ComponentProps<typeof ChatVirtualPrependLayout> = {
    context: { windowKey: "same-window", firstItemIndex: 10000, scrollParent: viewport },
    forwardedRef: ref,
    style: { marginTop: "auto" }
  }
  const layout = new ChatVirtualPrependLayout(props)
  const element = layout.render()
  ;(element.props as { ref(element: HTMLDivElement): void }).ref(root)
  const commit = (next: typeof props) => {
    const previous = props
    props = next
    Object.assign(layout, { props })
    const snapshot = layout.getSnapshotBeforeUpdate(previous)
    margin = typeof props.style?.marginTop === "number" ? props.style.marginTop : 0
    layout.componentDidUpdate(previous, undefined, snapshot)
  }
  const prepend = () => {
    commit({ ...props, context: { ...props.context!, firstItemIndex: 9975 } })
    commit({ ...props, style: { marginTop: 2650 } })
  }
  const frame = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  }
  return {
    layout,
    viewport,
    root,
    ref,
    style,
    measure,
    frames,
    frame,
    prepend,
    commit: () => commit({ ...props }),
    nativeScroll: () => {
      viewport.scrollTop += 2650
    },
    nativeFinish: () => {
      padding += 2650
      commit({ ...props, style: { marginTop: "auto" } })
    },
    switchWindow: () =>
      commit({ ...props, context: { ...props.context!, windowKey: "new-window" } }),
    detach: () => {
      connected = false
    }
  }
}

it("paints the same current row through native deviation without changing native scroll or size", () => {
  const f = fixture()
  f.prepend()
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.style.translate).toBe("0 -2650px")
  expect(f.measure().top).toBe(-50)
  expect(f.ref.current).toBe(f.root)
  f.nativeScroll()
  f.frame()
  expect(f.style.translate).toBe("")
  expect(f.measure().top).toBe(-50)
  f.nativeFinish()
  expect(f.measure().top).toBe(-50)
  expect(f.frames.size).toBe(0)
})

it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
  "releases a prepend correction immediately on real %s intent",
  (event) => {
    const f = fixture()
    f.prepend()
    f.viewport.dispatchEvent(new Event(event))
    expect(f.style.translate).toBe("")
    expect(f.frames.size).toBe(0)
    expect(f.viewport.scrollTop).toBe(0)
  }
)

it("does not preserve an old window or detached message, and cancels work on unmount", () => {
  const f = fixture()
  f.prepend()
  f.switchWindow()
  expect(f.style.translate).toBe("")
  expect(f.frames.size).toBe(0)
  const second = fixture()
  second.prepend()
  second.detach()
  second.frame()
  expect(second.style.translate).toBe("")
  expect(second.frames.size).toBe(0)
  second.layout.componentWillUnmount()
})

it("never polls ordinary updates and expires a broken native transaction within three frames", () => {
  const f = fixture()
  f.commit()
  expect(f.measure).not.toHaveBeenCalled()
  expect(f.frames.size).toBe(0)
  f.prepend()
  f.frame()
  f.frame()
  f.frame()
  expect(f.frames.size).toBe(0)
  expect(f.style.translate).toBe("")
  expect(f.viewport.scrollTop).toBe(0)
})
