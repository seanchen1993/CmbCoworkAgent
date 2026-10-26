import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BotBrowserEngine } from "./browser-engine"
import { startElectronBotBrowser } from "./electron-browser-engine"

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }))
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}) }))
vi.mock("electron", () => ({ app: { isPackaged: true } }))
vi.mock("playwright", () => ({ chromium: { connectOverCDP: fixture.connect } }))

type Request = { id: number; action: string; targetId?: string }
let engine: BotBrowserEngine | undefined
let child: EventEmitter & { connected: boolean; send: ReturnType<typeof vi.fn> }
let pages: Array<EventEmitter & { targetId: string; isClosed(): boolean }>
let captureValue: unknown
let holdCapture: boolean

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  engine = undefined
  captureValue = Buffer.from("native-jpeg").toString("base64")
  holdCapture = false
  pages = [1, 2].map((id) =>
    Object.assign(new EventEmitter(), {
      targetId: `owned-${id}`,
      isClosed: () => false
    })
  )
  let created = 0
  child = Object.assign(new EventEmitter(), {
    connected: true,
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    send: vi.fn((request: Request, callback?: (error: Error | null) => void) => {
      callback?.(null)
      if (request.action === "quit") {
        child.emit("close")
        return
      }
      if (request.action === "capture" && holdCapture) return
      const value =
        request.action === "create"
          ? { targetId: pages[created++].targetId }
          : request.action === "capture"
            ? captureValue
            : "Native title"
      queueMicrotask(() => child.emit("message", { id: request.id, value }))
    }),
    kill: vi.fn()
  })
  fixture.spawn.mockImplementation(() => {
    queueMicrotask(() => {
      child.emit("message", { ready: true })
      ;(child as typeof child & { stderr: EventEmitter }).stderr.emit(
        "data",
        Buffer.from("DevTools listening on ws://127.0.0.1:9000/devtools/browser/fixture-browser")
      )
    })
    return child
  })
  fixture.connect.mockResolvedValue({
    contexts: () => [
      {
        pages: () => pages,
        newCDPSession: async (page: (typeof pages)[number]) => ({
          send: async () => ({ targetInfo: { targetId: page.targetId } }),
          detach: vi.fn(async () => {})
        })
      }
    ],
    close: vi.fn(async () => {})
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await engine?.close()
  vi.restoreAllMocks()
})

describe("Electron Bot browser native capture RPC", () => {
  it("uses the Page's exact native target without showing or changing the page", async () => {
    engine = await startElectronBotBrowser("/synthetic-profile")
    const first = await engine.createPage()
    const second = await engine.createPage()
    child.send.mockClear()
    expect(await engine.capturePage(second)).toEqual(Buffer.from("native-jpeg"))
    expect(child.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "capture", targetId: "owned-2" }),
      expect.any(Function)
    )
    child.send.mockClear()
    await engine.capturePage(first)
    expect(child.send.mock.calls[0][0]).toMatchObject({ action: "capture", targetId: "owned-1" })
  })

  it("dispatches toolbar commands for the exact Page and reports unknown targets or rejected leases", async () => {
    engine = await startElectronBotBrowser("/synthetic-profile")
    const first = await engine.createPage()
    const second = await engine.createPage()
    const listener = vi.fn(async () => {})
    const stop = engine.onToolbarAction!(listener)
    child.emit("message", {
      event: "toolbar-action",
      requestId: 11,
      targetId: "owned-2",
      generation: 8,
      action: "reload"
    })
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(second, 8, { action: "reload", url: undefined })
    )
    expect(listener).not.toHaveBeenCalledWith(first, expect.anything(), expect.anything())
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith(
        { action: "toolbar-result", requestId: 11 },
        expect.any(Function)
      )
    )
    listener.mockRejectedValueOnce(new Error("控制权已改变"))
    child.emit("message", {
      event: "toolbar-action",
      requestId: 12,
      targetId: "owned-1",
      generation: 7,
      action: "return"
    })
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith(
        { action: "toolbar-result", requestId: 12, error: "控制权已改变" },
        expect.any(Function)
      )
    )
    stop()
    child.emit("message", {
      event: "toolbar-action",
      requestId: 13,
      targetId: "unknown",
      generation: 8,
      action: "new"
    })
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "toolbar-result",
          requestId: 13,
          error: expect.any(String)
        }),
        expect.any(Function)
      )
    )
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent capture readers without mixing different targets", async () => {
    engine = await startElectronBotBrowser("/synthetic-profile")
    const first = await engine.createPage()
    const second = await engine.createPage()
    holdCapture = true
    child.send.mockClear()
    const captures = [
      engine.capturePage(first),
      engine.capturePage(first),
      engine.capturePage(second)
    ]
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    for (const [request] of child.send.mock.calls) {
      child.emit("message", {
        id: request.id,
        value: Buffer.from(request.targetId).toString("base64")
      })
    }
    expect((await Promise.all(captures)).map((image) => image.toString())).toEqual([
      "owned-1",
      "owned-1",
      "owned-2"
    ])
  })

  it("rejects invalid or empty capture replies and logs only a fixed failure classification", async () => {
    engine = await startElectronBotBrowser("/synthetic-profile")
    const page = await engine.createPage()
    for (const invalid of [null, "", "not base64!", "a", "A".repeat(24 * 1024 * 1024 + 1)]) {
      captureValue = invalid
      await expect(engine.capturePage(page)).rejects.toThrow("截图数据无效")
    }
    expect(console.warn).toHaveBeenCalledWith(
      "[BotBrowser] Native preview capture failed:",
      "unavailable"
    )
    captureValue = Buffer.from("recovered").toString("base64")
    expect(await engine.capturePage(page)).toEqual(Buffer.from("recovered"))
  })

  it("times capture out at five seconds, ignores late replies and frees pending RPC capacity", async () => {
    engine = await startElectronBotBrowser("/synthetic-profile")
    const page = await engine.createPage()
    vi.useFakeTimers()
    holdCapture = true
    let settled = false
    const pending = engine.capturePage(page).catch((error: Error) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBe(false)
    const request = child.send.mock.calls.at(-1)![0] as Request
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ message: "Bot 浏览器响应超时" })
    expect(vi.getTimerCount()).toBe(0)
    child.emit("message", { id: request.id, value: Buffer.from("late").toString("base64") })
    // Repeated readers share one new RPC after the timed-out capture releases its slot.
    const before = child.send.mock.calls.length
    const next = Array.from({ length: 16 }, () =>
      engine!.capturePage(page).catch((error: Error) => error)
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(child.send.mock.calls.length - before).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(
      (await Promise.all(next)).every(
        (error) => error instanceof Error && error.message === "Bot 浏览器响应超时"
      )
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    holdCapture = false
    expect(await engine.capturePage(page)).toEqual(Buffer.from("native-jpeg"))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cleans a capture timer when the child exits", async () => {
    engine = await startElectronBotBrowser("/synthetic-profile")
    const page = await engine.createPage()
    vi.useFakeTimers()
    holdCapture = true
    const pending = engine.capturePage(page).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(0)
    child.emit("exit")
    expect(await pending).toMatchObject({ message: expect.stringContaining("已退出") })
    expect(vi.getTimerCount()).toBe(0)
  })
})
