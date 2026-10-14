import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { registerWindowPresentation } from "./window-presentation"
import { WINDOW_PRESENTATION_READ } from "../shared/window-presentation"

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  const ipc = { handle: vi.fn((key, handler) => handlers.set(key, handler)) } as unknown as IpcMain
  const window = new EventEmitter() as EventEmitter & {
    webContents: EventEmitter & {
      mainFrame: object
      isDestroyed(): boolean
      send: ReturnType<typeof vi.fn>
    }
    isDestroyed(): boolean
    isVisible(): boolean
    isMinimized(): boolean
  }
  let visible = true,
    minimized = false
  window.webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn()
  })
  window.isDestroyed = () => false
  window.isVisible = () => visible
  window.isMinimized = () => minimized
  registerWindowPresentation(ipc, window as unknown as BrowserWindow)
  const read = (sender = window.webContents, senderFrame = sender.mainFrame) =>
    handlers.get(WINDOW_PRESENTATION_READ)!({
      sender,
      senderFrame
    } as unknown as IpcMainInvokeEvent)
  return {
    window,
    ipc,
    read,
    set: (v: boolean, m: boolean) => {
      visible = v
      minimized = m
    }
  }
}

describe("own-window native presentation", () => {
  it("reports minimized and hidden independently of renderer visibility or focus", () => {
    const f = fixture()
    expect(f.read()).toEqual({ version: 0, presentable: true })
    f.window.emit("blur")
    expect(f.read()).toEqual({ version: 0, presentable: true })
    f.set(true, true)
    f.window.emit("minimize")
    expect(f.read()).toEqual({ version: 1, presentable: false })
    f.set(true, false)
    f.window.emit("restore")
    expect(f.read()).toEqual({ version: 2, presentable: true })
    f.set(false, false)
    f.window.emit("hide")
    expect(f.read()).toEqual({ version: 3, presentable: false })
    f.set(true, false)
    f.window.emit("show")
    expect(f.window.webContents.send).toHaveBeenLastCalledWith("window-presentation:changed", {
      version: 4,
      presentable: true
    })
  })
  it("rejects other webContents and child frames and registers only once", () => {
    const f = fixture()
    registerWindowPresentation(f.ipc, f.window as unknown as BrowserWindow)
    expect(f.ipc.handle).toHaveBeenCalledOnce()
    expect(() => f.read({ ...f.window.webContents } as typeof f.window.webContents)).toThrow(
      "SENDER_INVALID"
    )
    expect(() => f.read(f.window.webContents, {})).toThrow("SENDER_INVALID")
  })
  it.each(["closed", "destroyed"])("removes subscriptions and ownership on %s", (event) => {
    const f = fixture()
    if (event === "closed") f.window.emit(event)
    else f.window.webContents.emit(event)
    expect(() => f.read()).toThrow("SENDER_INVALID")
    f.window.emit("restore")
    expect(f.window.webContents.send).not.toHaveBeenCalled()
    expect(f.window.listenerCount("minimize")).toBe(0)
    expect(f.window.webContents.listenerCount("destroyed")).toBe(0)
  })
})
