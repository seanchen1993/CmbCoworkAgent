import { describe, expect, it, vi } from "vitest"
import {
  startInitialChatPresentation,
  sampleInitialChatPresentation,
  isFirstLiveChatUserRow
} from "./chat-initial-presentation"

function fixture(initiallyVisible = true) {
  let visible = initiallyVisible
  let now = 0
  let budget = 0
  let next = 0
  const frames = new Map<number, () => void>()
  let timeout: (() => void) | undefined
  let sample = { ready: false, geometry: "pending" }
  const reveal = vi.fn()
  const gate = startInitialChatPresentation({
    sample: () => sample,
    now: () => now,
    isVisible: () => visible,
    reveal,
    requestFrame: (callback) => {
      frames.set(++next, callback)
      return next
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
    setDeadline: (callback, milliseconds) => {
      budget = milliseconds
      timeout = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearDeadline: () => {
      timeout = undefined
    }
  })
  return {
    gate,
    budget: () => budget,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    visibility: (value: boolean) => {
      visible = value
      gate.visibilityChanged()
    },
    reveal,
    frames,
    set: (ready: boolean, geometry: string) => {
      sample = { ready, geometry }
    },
    frame() {
      const current = [...frames.values()]
      frames.clear()
      current.forEach((callback) => callback())
    },
    deadline() {
      timeout?.()
    },
    hasDeadline: () => !!timeout
  }
}

describe("initial chat presentation barrier", () => {
  it("does not publish from a background timer before a restored paint opportunity", () => {
    const f = fixture()
    f.set(true, "before minimize")
    f.frame()
    f.deadline()
    expect(f.reveal).not.toHaveBeenCalled()
    // Electron may still report document.visibilityState=visible while minimized.
    // The caller's native minimized signal pauses independently of visibilitychange.
    f.visibility(false)
    f.advance(1800)
    f.visibility(true)
    f.set(true, "restored scroll379")
    f.frame()
    f.set(true, "restored scroll391")
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.frame()
    // The already-expired foreground escape is still bounded after two full intervals.
    expect(f.reveal).toHaveBeenCalledOnce()
  })
  it("pauses the foreground deadline and resamples after a long minimize", () => {
    const f = fixture()
    f.set(true, "before minimize")
    f.frame()
    f.frame()
    f.advance(1000)
    f.visibility(false)
    f.advance(1800)
    f.deadline()
    expect(f.reveal).not.toHaveBeenCalled()
    expect(f.frames.size).toBe(0)
    f.visibility(true)
    expect(f.budget()).toBe(500)
    f.set(true, "restored geometry")
    f.frame()
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
    f.visibility(false)
    f.visibility(true)
    expect(f.frames.size).toBe(0)
  })
  it("does not reveal an initially background conversation or spend its escape budget", () => {
    const f = fixture(false)
    f.advance(10000)
    f.deadline()
    expect(f.hasDeadline()).toBe(false)
    expect(f.frames.size).toBe(0)
    f.visibility(true)
    expect(f.budget()).toBe(1500)
    f.deadline()
    f.frame()
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
  })
  it("keeps a spent foreground escape bounded after restore but permits fresh frames first", () => {
    const f = fixture()
    f.advance(1500)
    f.visibility(false)
    f.visibility(true)
    expect(f.budget()).toBe(0)
    f.deadline()
    f.frame()
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
  })
  it("disposes paused work and preserves explicit user intent while pending", () => {
    const f = fixture()
    f.visibility(false)
    f.gate.dispose()
    f.visibility(true)
    expect(f.hasDeadline()).toBe(false)
    expect(f.frames.size).toBe(0)
    const user = fixture(false)
    user.gate.reveal()
    expect(user.reveal).toHaveBeenCalledOnce()
  })
  it("bypasses only a first live user row, not a loading running history", () => {
    expect(isFirstLiveChatUserRow(true, false, 1, "user")).toBe(true)
    expect(isFirstLiveChatUserRow(true, false, 20, "user")).toBe(false)
    expect(isFirstLiveChatUserRow(true, true, 1, "user")).toBe(false)
    expect(isFirstLiveChatUserRow(true, false, 1, "assistant")).toBe(false)
    expect(isFirstLiveChatUserRow(false, false, 1, "user")).toBe(false)
    expect(isFirstLiveChatUserRow(true, false, 0, undefined)).toBe(false)
  })
  it("waits for authorized content and two stable measured frame intervals", () => {
    const f = fixture()
    f.frame()
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.set(true, "content height 80 scroll 300")
    f.frame()
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.set(true, "content height 96 scroll 316")
    f.frame()
    f.frame()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
    expect(f.frames.size).toBe(0)
    expect(f.hasDeadline()).toBe(false)
  })
  it("never certifies an empty or not-yet-mounted initial cohort", () => {
    const f = fixture()
    f.set(false, "no mounted rows")
    for (let index = 0; index < 10; index++) f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.gate.dispose()
  })
  it("resets stability when parent scroll height changes even if text stays the same", () => {
    const f = fixture()
    f.set(true, "text stable scrollHeight800")
    f.frame()
    f.frame()
    f.set(true, "text stable scrollHeight816")
    f.frame()
    f.frame()
    expect(f.reveal).not.toHaveBeenCalled()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
  })
  it("does not rehide a revealed conversation for later streaming or layout changes", () => {
    const f = fixture()
    f.set(true, "native")
    f.frame()
    f.frame()
    f.frame()
    f.set(false, "later partial")
    f.frame()
    f.deadline()
    f.gate.reveal()
    expect(f.reveal).toHaveBeenCalledOnce()
    expect(f.frames.size).toBe(0)
  })
  it("reveals a stalled pending site at the bounded deadline", () => {
    const f = fixture()
    f.frame()
    f.deadline()
    expect(f.reveal).not.toHaveBeenCalled()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
    expect(f.frames.size).toBe(0)
  })
  it("lets user intent immediately expose existing content and retry controls", () => {
    const f = fixture()
    f.gate.reveal()
    f.deadline()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
  })
  it("cancels all work on unmount without publishing a late reveal", () => {
    const f = fixture()
    f.gate.dispose()
    f.deadline()
    f.frame()
    f.gate.reveal()
    expect(f.reveal).not.toHaveBeenCalled()
    expect(f.frames.size).toBe(0)
    expect(f.hasDeadline()).toBe(false)
  })
  it("releases normal native content after measured frames without waiting for deadline", () => {
    const f = fixture()
    f.set(true, "native ready")
    f.frame()
    f.frame()
    f.frame()
    expect(f.reveal).toHaveBeenCalledOnce()
  })
  it("ignores offscreen pending sites but waits for visible pending geometry", () => {
    const viewport = {
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0, bottom: 400 })
    }
    const site = (top: number, pending: boolean) => ({
      getBoundingClientRect: () => ({
        x: 0,
        y: top,
        top,
        bottom: top + 40,
        width: 400,
        height: 40
      }),
      querySelector: () => (pending ? {} : null),
      dataset: { functionSite: "AssistantMessage" },
      parentElement: viewport
    })
    let sites = [site(30, false), site(600, true)]
    const root = {
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ visibility: "visible", display: "block" }) }
      },
      querySelectorAll: (selector: string) => (selector === "[data-item-index]" ? [] : sites)
    }
    const sample = () =>
      sampleInitialChatPresentation(
        root as unknown as HTMLElement,
        viewport as unknown as HTMLElement
      )
    expect(sample().ready).toBe(true)
    sites = [site(30, true), site(600, true)]
    expect(sample().ready).toBe(false)
  })
  it("accepts visible native system rows without sites but not an unmounted empty list", () => {
    const viewport = {
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0, bottom: 400 })
    }
    const row = {
      textContent: "System notice",
      querySelector: () => null,
      parentElement: viewport,
      getBoundingClientRect: () => ({ x: 0, y: 10, top: 10, bottom: 50, width: 400, height: 40 })
    }
    let rows = [row]
    const root = {
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ visibility: "visible", display: "block" }) }
      },
      querySelectorAll: (selector: string) => (selector === "[data-item-index]" ? rows : [])
    }
    const sample = () =>
      sampleInitialChatPresentation(
        root as unknown as HTMLElement,
        viewport as unknown as HTMLElement
      )
    expect(sample().ready).toBe(true)
    rows = []
    expect(sample().ready).toBe(false)
  })
})
