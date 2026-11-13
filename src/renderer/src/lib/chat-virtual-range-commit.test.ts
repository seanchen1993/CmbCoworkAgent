import React, { type ComponentProps } from "react"
import type { VirtuosoHandle } from "react-virtuoso"
import { afterEach, expect, it, vi } from "vitest"
import { ChatVirtualPrependLayout } from "../components/chat/chat-virtual-prepend-layout"
import { claimChatViewportScrollOwner } from "../components/chat/chat-viewport-scroll-owner"

afterEach(() => vi.unstubAllGlobals())

function fixture(readable = true, horizontallyVisible = true, texts = ["Protected body"]) {
  const tasks: VoidFunction[] = [], frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal("queueMicrotask", (task: VoidFunction) => tasks.push(task))
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id) })
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 })
  const measure = vi.fn(() => ({ top: readable ? 0 : -100, bottom: readable ? 20 : -80, height: 20, width: 100,
    left: horizontallyVisible ? 0 : -200, right: horizontallyVisible ? 100 : -100 }))
  const viewport = Object.assign(new EventTarget(), { isConnected: true,
    getBoundingClientRect: () => ({ top: 0, bottom: 420, left: 0, right: 500 }) }) as unknown as HTMLElement
  const fullRects = vi.fn(() => [measure()]), pointRects = vi.fn(() => measure())
  const endpoints: { start: number; end: number }[] = []
  const body = { closest: () => null, checkVisibility: () => true,
    ownerDocument: { createTreeWalker: vi.fn(() => {
      let index = 0
      return { nextNode: () => index >= texts.length ? null : { nodeValue: texts[index++] } }
    }), createRange: () => {
      let start = 0
      return { selectNodeContents: vi.fn(), getClientRects: fullRects,
        setStart: (_node: Node, offset: number) => { start = offset },
        setEnd: (_node: Node, end: number) => { endpoints.push({ start, end }) },
        getBoundingClientRect: pointRects }
    } } }
  const element = { isConnected: true, dataset: { chatMessageId: "same-row" },
    closest: () => null, checkVisibility: () => true, getBoundingClientRect: measure,
    querySelectorAll: () => [body] } as unknown as HTMLElement
  const root = { isConnected: true, contains: (candidate: HTMLElement) => candidate === element,
    querySelectorAll: vi.fn(() => [element]), style: { translate: "" } } as unknown as HTMLDivElement
  let itemIndex = 3
  const item = { parentElement: root,
    getAttribute: (name: string) => name === "data-index" ? String(itemIndex) : null,
    contains: (candidate: HTMLElement) => candidate === element,
    querySelectorAll: () => [element] } as unknown as Element
  const directItems: Element[] = [item], readItems = vi.fn(() => directItems)
  Object.defineProperty(root, "children", { get: readItems })
  const refresh = vi.fn(), handle = { refreshItemSizes: refresh } as unknown as VirtuosoHandle
  const handleRef = { current: handle as VirtuosoHandle | null }
  const child = (index: number) => React.createElement("div", { key: "row-" + index, "data-index": index })
  let props: ComponentProps<typeof ChatVirtualPrependLayout> = { forwardedRef: { current: null },
    context: { windowKey: "same-window", firstItemIndex: 0, scrollParent: viewport,
      virtuosoRef: handleRef }, children: [child(2), child(3)], style: { marginTop: 0 } }
  const layout = new ChatVirtualPrependLayout(props)
  const rendered = layout.render()
  ;(rendered.props as { ref(element: HTMLDivElement): void }).ref(root)
  const commit = (patch: Partial<typeof props> = {}, index = 1) => {
    const previous = props
    props = { ...props, children: [child(index), child(3)], ...patch }
    Object.assign(layout, { props })
    const snapshot = layout.getSnapshotBeforeUpdate(previous)
    layout.componentDidUpdate(previous, undefined, snapshot)
    return snapshot
  }
  const microtask = () => { const next = tasks.shift(); expect(next).toBeDefined(); next!() }
  const frame = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  }
  return { layout, root, element, viewport, handleRef, refresh, measure, frames, tasks,
    commit, microtask, frame, context: () => props.context!,
    fullRects, pointRects, endpoints, body, item, directItems, readItems,
    setItemIndex: (value: number) => { itemIndex = value },
    members: (...indexes: number[]) => indexes.map(child),
    sameRange: () => commit({ children: props.children }) }
}

it("waits for the parent layout subscription and refreshes once across nested commits", () => {
  const f = fixture()
  f.commit()
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.tasks).toHaveLength(1)
  f.refresh.mockImplementation(() => f.commit({}, 0))
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.tasks).toHaveLength(0)
  f.commit({}, 4)
  expect(f.tasks).toHaveLength(0)
  f.frame()
  f.refresh.mockReset()
  f.commit({}, 5)
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

it("does zero geometry work for same membership streaming and queues nothing without a visible snapshot", () => {
  const f = fixture()
  for (let i = 0; i < 100; i++) f.sameRange()
  expect(f.measure).not.toHaveBeenCalled()
  expect(f.tasks).toHaveLength(0)
  const cold = fixture(false)
  for (let i = 0; i < 10000; i++) cold.commit({}, i + 10)
  expect(cold.tasks).toHaveLength(0)
  expect(cold.refresh).not.toHaveBeenCalled()
  expect(cold.frames.size).toBe(0)
})


it("does not qualify text entirely outside the horizontal viewport", () => {
  const f = fixture(true, false)
  f.commit()
  expect(f.tasks).toHaveLength(0)
  expect(f.refresh).not.toHaveBeenCalled()
})

it.each(["search", "session-restore", "history-restore", "detached"] as const)(
  "yields to an existing or newly claimed %s owner", kind => {
    const initial = fixture(), release = claimChatViewportScrollOwner(initial.viewport, kind)
    initial.commit()
    expect(initial.tasks).toHaveLength(0)
    release.release()
    const queued = fixture()
    queued.commit()
    const owner = claimChatViewportScrollOwner(queued.viewport, kind)
    queued.microtask()
    expect(queued.refresh).not.toHaveBeenCalled()
    expect(queued.frames.size).toBe(0)
    owner.release()
  }
)

it.each(["window", "viewport", "index", "handle", "ref", "id", "membership", "unmount"])(
  "discards a queued task after its %s changes", change => {
    const f = fixture()
    f.commit()
    if (change === "window") f.commit({ context: { ...f.context(), windowKey: "new" } })
    if (change === "viewport") f.commit({ context: { ...f.context(), scrollParent: null } })
    if (change === "index") f.commit({ context: { ...f.context(), firstItemIndex: 1 } })
    if (change === "handle") f.handleRef.current = null
    if (change === "ref") f.commit({ context: { ...f.context(),
      virtuosoRef: { current: f.handleRef.current } } })
    if (change === "id") f.element.dataset.chatMessageId = "replaced-row"
    if (change === "membership") f.commit({}, 0)
    if (change === "unmount") f.layout.componentWillUnmount()
    f.microtask()
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.frames.size).toBe(0)
  }
)

it("does not require the original anchor to remain visible after the new range displaces it", () => {
  const f = fixture()
  f.commit()
  f.measure.mockReturnValue({ top: -23000, bottom: -22980, height: 20, width: 100, left: 0, right: 100 })
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

it("an old checkpoint cannot retire a new window task", () => {
  const f = fixture()
  f.commit()
  f.microtask()
  const oldCheckpoint = [...f.frames.values()][0]
  f.commit({ context: { ...f.context(), windowKey: "new-window" } })
  f.commit({}, 0)
  expect(f.tasks).toHaveLength(1)
  oldCheckpoint(0)
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.frames.size).toBe(1)
})

it("a thrown native refresh remains observable and its checkpoint still releases the exact task", () => {
  const f = fixture()
  f.refresh.mockImplementationOnce(() => { throw new Error("native refresh failed") })
  f.commit()
  expect(() => f.microtask()).toThrow("native refresh failed")
  expect(f.frames.size).toBe(1)
  f.commit({}, 0)
  expect(f.tasks).toHaveLength(0)
  f.frame()
  f.commit({}, 4)
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(2)
  f.layout.componentWillUnmount()
  expect(f.frames.size).toBe(0)
})

it("never takes over a prepend or an existing paint translation", () => {
  const prepend = fixture()
  prepend.commit({ context: { ...prepend.context(), firstItemIndex: -2 } })
  expect(prepend.tasks).toHaveLength(0)
  prepend.layout.componentWillUnmount()
  const translated = fixture()
  translated.commit({ style: { translate: "0 20px" } })
  expect(translated.tasks).toHaveLength(0)
})


it("measures a leading retained pair without a visible body, using the same transaction budget", () => {
  const f = fixture(false)
  f.commit()
  expect(f.tasks).toHaveLength(1)
  f.refresh.mockImplementation(() => {
    f.measure.mockReturnValue({ top: 0, bottom: 20, height: 20, width: 100, left: 0, right: 100 })
    f.commit({}, 0)
  })
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.tasks).toHaveLength(0)
  expect(f.fullRects).not.toHaveBeenCalled()
})

it.each(["backward", "no-overlap", "key-replaced", "index-replaced"])(
  "does not infer an offscreen measurement for %s members", mode => {
    const f = fixture(false)
    const children = mode === "backward" ? f.members(4, 3) :
      mode === "no-overlap" ? f.members(0, 1) : mode === "key-replaced" ? [
        React.createElement("div", { key: "different-key", "data-index": 3 })
      ] : [React.createElement("div", { key: "row-3", "data-index": 1 })]
    f.commit({ children })
    expect(f.tasks).toHaveLength(0)
    expect(f.refresh).not.toHaveBeenCalled()
    if (mode !== "backward") {
      expect(f.measure).not.toHaveBeenCalled()
      expect(f.readItems).not.toHaveBeenCalled()
    }
  }
)

it.each(["direct-index", "reparented", "key"])("rechecks the queued exact pair after %s replacement", mode => {
  const f = fixture(false)
  f.commit()
  if (mode === "direct-index") f.setItemIndex(33)
  if (mode === "reparented") Object.assign(f.item, { parentElement: null })
  if (mode === "key") f.commit({ children: [
    React.createElement("div", { key: "new-key", "data-index": 3 })
  ] })
  f.microtask()
  expect(f.refresh).not.toHaveBeenCalled()
})

it.each([["\u{1f600}", 2], ["\ud800", 1], ["\udc00", 1]] as const)(
  "uses the complete first nonempty code point for %j", (text, end) => {
    const f = fixture(false, true, [text])
    f.commit()
    expect(f.endpoints).toEqual([{ start: 0, end }])
    expect(f.pointRects).toHaveBeenCalledTimes(1)
    expect(f.fullRects).not.toHaveBeenCalled()
    f.microtask()
    expect(f.refresh).toHaveBeenCalledTimes(1)
  }
)

it("skips a zero-width first code point to the next text node without scanning characters", () => {
  const f = fixture(false, true, ["\u200bignored remainder", "Readable next node"])
  f.pointRects.mockReturnValueOnce({ top: -100, bottom: -80, height: 20, width: 0, left: 0, right: 0 })
  f.commit()
  expect(f.endpoints).toEqual([{ start: 0, end: 1 }, { start: 0, end: 1 }])
  expect(f.pointRects).toHaveBeenCalledTimes(2)
  expect(f.fullRects).not.toHaveBeenCalled()
  f.microtask()
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

it("does not materialize all line rects or scan later offscreen bodies after finding a weak candidate", () => {
  const f = fixture(false, true, ["G".repeat(200000)])
  const laterRow = { ...f.element, getBoundingClientRect: () => ({ top: -80, bottom: -60, height: 20 }),
    querySelectorAll: () => { throw new Error("later offscreen text must not be scanned") } }
  const laterItem = { getAttribute: () => "4", querySelectorAll: () => [laterRow] } as unknown as Element
  f.directItems.push(laterItem)
  f.commit({ children: f.members(2, 3, 4) })
  f.commit({ children: f.members(1, 3, 4) })
  expect(f.tasks).toHaveLength(1)
  expect(f.endpoints).toEqual([{ start: 0, end: 1 }])
  expect(f.pointRects).toHaveBeenCalledTimes(1)
  expect(f.fullRects).not.toHaveBeenCalled()
})


it("prefers a real visible retained body over an earlier offscreen candidate", () => {
  const f = fixture(false)
  const visibleRects = vi.fn(() => [{ top: 0, bottom: 20, height: 20, width: 100, left: 0, right: 100 }])
  const visibleBody = { closest: () => null, checkVisibility: () => true,
    ownerDocument: { createTreeWalker: () => {
      let used = false
      return { nextNode: () => used ? null : (used = true, { nodeValue: "Visible body" }) }
    }, createRange: () => ({ selectNodeContents: vi.fn(), getClientRects: visibleRects }) } }
  const visibleRow = { ...f.element,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, height: 20 }),
    querySelectorAll: () => [visibleBody] } as unknown as HTMLElement
  f.directItems.push({ getAttribute: () => "4", querySelectorAll: () => [visibleRow] } as unknown as Element)
  f.commit({ children: f.members(2, 3, 4) })
  const snapshot = f.commit({ children: f.members(1, 3, 4) })
  expect(snapshot?.element).toBe(visibleRow)
  expect(visibleRects).toHaveBeenCalledTimes(1)
  expect(f.pointRects).toHaveBeenCalledTimes(1)
})

it("does not accept a matching data-index nested inside an unrelated direct child", () => {
  const f = fixture(false)
  f.directItems.splice(0, 1, { getAttribute: () => null,
    querySelectorAll: () => [f.element] } as unknown as Element)
  f.commit()
  expect(f.measure).not.toHaveBeenCalled()
  expect(f.tasks).toHaveLength(0)
})
