import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { WINDOW_VISIBILITY_CHANGED } from "../shared/window-visibility"
import { NativeWindowVisibility } from "./native-window-visibility"

const windows: EventEmitter[] = []
afterEach(() => {
  for (const window of windows.splice(0)) window.emit("closed")
  vi.useRealTimers()
})

function fixture() {
  const state = { visible: true, minimized: false, destroyed: false, contentsDestroyed: false }
  const send = vi.fn()
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isDestroyed: () => state.destroyed,
    webContents: { id: 7, isDestroyed: () => state.contentsDestroyed, mainFrame: { send } }
  })
  const owner = new NativeWindowVisibility(window as unknown as BrowserWindow)
  windows.push(window)
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame
  } as unknown as IpcMainInvokeEvent
  return { state, window, send, owner, event }
}

it("publishes native hide/minimize changes once and restores with increasing revisions", () => {
  const f = fixture()
  expect(f.owner.read(f.event)).toEqual({ visible: true, revision: 0 })
  f.state.visible = false
  f.window.emit("hide")
  f.window.emit("hide")
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.send).toHaveBeenLastCalledWith(WINDOW_VISIBILITY_CHANGED, {
    visible: false,
    revision: 1
  })
  f.state.visible = true
  f.state.minimized = true
  f.window.emit("show")
  f.window.emit("minimize")
  expect(f.send).toHaveBeenCalledTimes(1)
  f.state.minimized = false
  f.window.emit("restore")
  expect(f.owner.read(f.event)).toEqual({ visible: true, revision: 2 })
  expect(f.send).toHaveBeenCalledTimes(2)
})

it("rejects other windows, child frames and destroyed owners", () => {
  const f = fixture()
  expect(() => f.owner.read({ ...f.event, sender: { id: 8 } } as IpcMainInvokeEvent)).toThrow(
    /main window/
  )
  expect(() => f.owner.read({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow(
    /main window/
  )
  f.state.contentsDestroyed = true
  expect(() => f.owner.read(f.event)).toThrow(/main window/)
  f.state.contentsDestroyed = false
  f.state.destroyed = true
  expect(() => f.owner.read(f.event)).toThrow(/main window/)
  expect(f.send).not.toHaveBeenCalled()
})

it("preserves current visibility through frame replacement and removes native listeners on close", () => {
  const f = fixture()
  f.send.mockImplementationOnce(() => {
    throw new Error("Frame was replaced")
  })
  f.state.visible = false
  // A read also resamples if a lifecycle event has not yet arrived.
  expect(f.owner.read(f.event)).toEqual({ visible: false, revision: 1 })
  const replacement = { send: vi.fn() }
  f.window.webContents.mainFrame = replacement
  expect(() => f.owner.read(f.event)).toThrow(/main window/)
  expect(
    f.owner.read({ ...f.event, senderFrame: replacement } as unknown as IpcMainInvokeEvent)
  ).toEqual({ visible: false, revision: 1 })
  f.window.emit("closed")
  expect(f.window.eventNames()).toEqual([])
  expect(() => f.owner.read(f.event)).toThrow(/main window/)
  f.state.visible = true
  f.window.emit("show")
  expect(replacement.send).not.toHaveBeenCalled()
})

it("recovers missing native notifications with one bounded sampler and clears it on close", async () => {
  vi.useFakeTimers()
  const f = fixture()
  expect(vi.getTimerCount()).toBe(0)
  f.owner.read(f.event)
  f.owner.read(f.event)
  expect(vi.getTimerCount()).toBe(1)
  f.state.visible = false
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.send).toHaveBeenLastCalledWith(WINDOW_VISIBILITY_CHANGED, {
    visible: false,
    revision: 1
  })
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.send).toHaveBeenCalledTimes(1)
  f.state.visible = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.send).toHaveBeenLastCalledWith(WINDOW_VISIBILITY_CHANGED, { visible: true, revision: 2 })
  f.window.emit("closed")
  expect(vi.getTimerCount()).toBe(0)
  f.state.visible = false
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.send).toHaveBeenCalledTimes(2)
})
