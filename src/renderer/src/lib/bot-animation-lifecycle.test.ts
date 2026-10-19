import { afterEach, expect, it, vi } from "vitest"
import { createBudgetedLoop } from "../components/bots/animation/budgeted-loop"

afterEach(() => vi.unstubAllGlobals())

it("parks without frames while idle/hidden and cancels frames and listeners when disposed", () => {
  const frames = new Map<number, FrameRequestCallback>()
  let serial = 0
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => true
  })
  const remove = vi.spyOn(document, "removeEventListener")
  const window = Object.assign(new EventTarget(), {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++serial, callback)
      return serial
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id)
    }
  })
  vi.stubGlobal("document", document)
  vi.stubGlobal("window", window)
  const draw = vi.fn()
  let idle = false
  const loop = createBudgetedLoop(draw, { fps: 30, idleWhen: () => idle })
  const frame = (time: number) => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(time))
  }
  frame(0)
  frame(10)
  expect(draw).toHaveBeenCalledTimes(1)
  idle = true
  frame(40)
  expect(loop.isDormant()).toBe(true)
  expect(frames.size).toBe(0)
  idle = false
  loop.wake()
  expect(frames.size).toBe(1)
  document.visibilityState = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
  expect(frames.size).toBe(0)
  loop.wake()
  expect(frames.size).toBe(0)
  document.visibilityState = "visible"
  document.dispatchEvent(new Event("visibilitychange"))
  expect(frames.size).toBe(1)
  loop.dispose()
  expect(frames.size).toBe(0)
  expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
  loop.wake()
  document.dispatchEvent(new Event("visibilitychange"))
  expect(frames.size).toBe(0)
})

it("keeps a 60 Hz cadence with fractional display timestamps", () => {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true })
  )
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++id, callback)
        return id
      },
      cancelAnimationFrame: (frameId: number) => frames.delete(frameId)
    })
  )
  const draw = vi.fn()
  const loop = createBudgetedLoop(draw, { fps: 60 })
  for (let frame = 0; frame < 60; frame++) {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(frame * 16.666))
  }
  expect(draw).toHaveBeenCalledTimes(60)
  loop.dispose()
  expect(frames.size).toBe(0)
})
