import { expect, it, vi } from "vitest"
import { observeBotTranscriptScroll } from "./use-bot-transcript-scroll"

class ElementFixture extends EventTarget {
  scrollTop = 600
  scrollHeight = 1000
  clientHeight = 400
  offsetWidth = 500
  clientWidth = 485
  isContentEditable = false
  ownerDocument!: Document
  content?: ElementFixture
  contains(target: unknown): boolean {
    return target === this || target === this.content
  }
  hasAttribute(): boolean {
    return false
  }
  querySelector(): ElementFixture | null {
    return this.content ?? null
  }
  getBoundingClientRect(): DOMRect {
    return { top: 0, left: 0, right: 500, bottom: 400, width: 500, height: 400 } as DOMRect
  }
}
class InputFixture extends ElementFixture {}
class TextareaFixture extends ElementFixture {}

function fixture() {
  let now = 100
  let notifyResize!: () => void
  const observe = vi.fn(),
    disconnect = vi.fn()
  const viewport = new ElementFixture(),
    content = new ElementFixture(),
    body = new ElementFixture()
  viewport.content = content
  const window = Object.assign(new EventTarget(), {
    performance: { now: () => now },
    HTMLElement: ElementFixture,
    HTMLInputElement: InputFixture,
    HTMLTextAreaElement: TextareaFixture,
    ResizeObserver: class {
      constructor(callback: () => void) {
        notifyResize = callback
      }
      observe = observe
      disconnect = disconnect
    }
  })
  const document = { defaultView: window, activeElement: body, body }
  viewport.ownerDocument = document as unknown as Document
  const following = { current: true }
  const onReadPosition = vi.fn(),
    onUserDetach = vi.fn(),
    onContentHeightChanged = vi.fn()
  const cleanup = observeBotTranscriptScroll({
    scrollParent: viewport as unknown as HTMLElement,
    following,
    onReadPosition,
    onUserDetach,
    onContentHeightChanged
  })
  const event = (target: EventTarget, type: string, fields: object = {}) => {
    const event = new Event(type)
    for (const [key, value] of Object.entries(fields))
      Object.defineProperty(event, key, { value, configurable: true })
    return target.dispatchEvent(event)
  }
  const scroll = (top: number) => {
    viewport.scrollTop = top
    event(viewport, "scroll")
  }
  return {
    viewport,
    content,
    window,
    document,
    following,
    onReadPosition,
    onUserDetach,
    onContentHeightChanged,
    cleanup,
    event,
    scroll,
    resize: () => notifyResize(),
    observe,
    disconnect,
    advance: () => (now += 1000)
  }
}

it("keeps follow intent through measured growth and programmatic viewport adjustments", () => {
  const f = fixture()
  try {
    expect(f.observe.mock.calls.map(([element]) => element)).toEqual([f.content, f.viewport])
    f.viewport.scrollHeight = 1400
    f.resize()
    f.scroll(400)
    expect(f.following.current).toBe(true)
    expect(f.onUserDetach).not.toHaveBeenCalled()
    expect(f.onContentHeightChanged).toHaveBeenCalledTimes(1)
    expect(f.onReadPosition).toHaveBeenCalledTimes(2)
  } finally {
    f.cleanup()
  }
})

it("yields a pending follow frame to an upward wheel and resumes only from a downward gesture at bottom", () => {
  const f = fixture()
  try {
    f.event(f.viewport, "wheel", { deltaY: -120 })
    expect(f.following.current).toBe(false)
    expect(f.onUserDetach).toHaveBeenCalledTimes(1)
    f.scroll(480)
    expect(f.following.current).toBe(false)
    expect(f.onUserDetach).toHaveBeenCalledTimes(1)
    // Browser anchoring or another scroll writer reaching the bottom does not change intent.
    f.scroll(600)
    expect(f.following.current).toBe(false)
    f.event(f.viewport, "wheel", { deltaY: 120 })
    f.scroll(590)
    expect(f.following.current).toBe(false)
    f.scroll(600)
    expect(f.following.current).toBe(true)
    expect(f.onContentHeightChanged).toHaveBeenCalledTimes(1)
  } finally {
    f.cleanup()
  }
})

it("does not resume from an expired downward gesture or layout shrinking a detached viewport", () => {
  const f = fixture()
  try {
    f.following.current = false
    f.scroll(480)
    f.event(f.viewport, "wheel", { deltaY: 120 })
    f.advance()
    f.scroll(600)
    expect(f.following.current).toBe(false)
    f.scroll(480)
    f.viewport.scrollHeight = 880
    f.resize()
    f.event(f.viewport, "scroll")
    expect(f.following.current).toBe(false)
  } finally {
    f.cleanup()
  }
})

it("cancels pending restoration before a detached reader moves in either direction", () => {
  const f = fixture()
  try {
    f.following.current = false
    f.viewport.scrollTop = 0
    f.event(f.viewport, "wheel", { deltaY: 120 })
    expect(f.onUserDetach).toHaveBeenCalledTimes(1)
    expect(f.onReadPosition).toHaveBeenCalledTimes(1)
    expect(f.following.current).toBe(false)
    f.event(f.viewport, "wheel", { deltaY: -120 })
    expect(f.onUserDetach).toHaveBeenCalledTimes(2)
    expect(f.following.current).toBe(false)
  } finally {
    f.cleanup()
  }
})

it("keeps a scrollbar drag detached until pointer release and cleans cancelled pointer intent", () => {
  const f = fixture()
  try {
    f.event(f.viewport, "pointerdown", { clientX: 496, clientY: 150 })
    expect(f.following.current).toBe(false)
    f.scroll(580)
    f.scroll(600)
    expect(f.following.current).toBe(false)
    f.event(f.window, "pointerup")
    expect(f.following.current).toBe(true)
    f.event(f.viewport, "pointerdown", { clientX: 496, clientY: 150 })
    f.event(f.window, "pointercancel")
    f.scroll(550)
    f.scroll(600)
    expect(f.following.current).toBe(false)
  } finally {
    f.cleanup()
  }
})

it("does not treat composer keystrokes as transcript scroll gestures", () => {
  const f = fixture()
  try {
    const input = new TextareaFixture()
    f.document.activeElement = input
    f.event(f.window, "keydown", { key: "PageUp", target: input })
    f.scroll(480)
    expect(f.following.current).toBe(true)
    f.document.activeElement = f.viewport
    f.event(f.window, "keydown", { key: "PageUp", target: f.viewport })
    f.scroll(400)
    expect(f.following.current).toBe(false)
    f.event(f.window, "keydown", { key: "End", target: f.viewport })
    f.scroll(600)
    expect(f.following.current).toBe(true)
  } finally {
    f.cleanup()
  }
})

it("uses touch direction and drops all gestures and queued resize callbacks after teardown", () => {
  const f = fixture()
  f.event(f.viewport, "touchstart", { touches: [{ clientY: 100 }] })
  f.event(f.viewport, "touchmove", { touches: [{ clientY: 130 }] })
  f.scroll(480)
  expect(f.following.current).toBe(false)
  f.event(f.viewport, "touchmove", { touches: [{ clientY: 90 }] })
  f.scroll(600)
  expect(f.following.current).toBe(true)
  f.cleanup()
  const reads = f.onReadPosition.mock.calls.length,
    changes = f.onContentHeightChanged.mock.calls.length
  f.event(f.viewport, "wheel", { deltaY: -120 })
  f.scroll(400)
  f.resize()
  expect(f.following.current).toBe(true)
  expect(f.onReadPosition).toHaveBeenCalledTimes(reads)
  expect(f.onContentHeightChanged).toHaveBeenCalledTimes(changes)
  expect(f.disconnect).toHaveBeenCalledTimes(1)
})
