import type { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface TestWindow extends EventEmitter {
  visible: boolean
  destroyed: boolean
  canGoBack: boolean
  canGoForward: boolean
  captureEmpty: boolean
  captureWidth: number
  throttled: boolean
  resize: ReturnType<typeof vi.fn>
  jpeg: Buffer
  toJPEG: ReturnType<typeof vi.fn>
  toolbar: { webContents: { mainFrame: object } }
  close(): void
  loadURL: ReturnType<typeof vi.fn>
  webContents: EventEmitter & { capturePage: ReturnType<typeof vi.fn> }
}

const fixture = vi.hoisted(() => ({
  windows: [] as unknown[],
  listeners: new Map<string, (message?: unknown) => void>(),
  send: vi.fn(),
  ipc: new Map<string, (event: unknown, input: unknown) => Promise<void>>(),
  app: {
    exit: vi.fn(),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve())
  }
}))

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  class BrowserWindow extends EventEmitter {
    visible = false
    destroyed = false
    canGoBack = false
    canGoForward = false
    targetId = `owned-target-${fixture.windows.length + 1}`
    captureEmpty = false
    captureWidth = 1280
    throttled = true
    resize = vi.fn(() => ({ toJPEG: this.toJPEG }))
    jpeg = Buffer.from(`native-${this.targetId}`)
    toJPEG = vi.fn(() => this.jpeg)
    webContents = Object.assign(new EventEmitter(), {
      getTitle: () => "Synthetic browser page",
      isDestroyed: () => this.destroyed,
      getBackgroundThrottling: () => this.throttled,
      setBackgroundThrottling: (value: boolean) => {
        this.throttled = value
      },
      setWindowOpenHandler: vi.fn(),
      capturePage: vi.fn(async () => ({
        isEmpty: () => this.captureEmpty,
        getSize: () => ({ width: this.captureWidth, height: 860 }),
        resize: this.resize,
        toJPEG: this.toJPEG
      })),
      navigationHistory: {
        canGoBack: () => this.canGoBack,
        canGoForward: () => this.canGoForward
      },
      debugger: {
        attach: vi.fn(),
        sendCommand: vi.fn(async () => ({ targetInfo: { targetId: this.targetId } })),
        isAttached: () => true,
        detach: vi.fn()
      }
    })
    constructor() {
      super()
      fixture.windows.push(this)
    }
    toolbar = { webContents: { mainFrame: {} } }
    setControl = vi.fn()
    setMenuBarVisibility = vi.fn()
    loadURL = vi.fn(async () => {})
    isDestroyed = () => this.destroyed
    isVisible = () => this.visible
    isMinimized = () => false
    restore = vi.fn()
    focus = vi.fn()
    show = () => {
      this.visible = true
    }
    hide = () => {
      this.visible = false
    }
    close() {
      const event = { preventDefault: vi.fn() }
      this.emit("close", event)
      if (!event.preventDefault.mock.calls.length) this.destroy()
    }
    destroy() {
      this.destroyed = true
      this.emit("closed")
    }
  }
  return {
    app: fixture.app,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<void>) =>
        fixture.ipc.set(channel, handler)
    },
    BrowserWindow,
    session: {
      defaultSession: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() }
      }
    }
  }
})

vi.mock("./browser-host-window", async () => ({
  BotBrowserWindow: (await import("electron")).BrowserWindow
}))

let sendDescriptor: PropertyDescriptor | undefined
let connectedDescriptor: PropertyDescriptor | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.windows.length = 0
  fixture.listeners.clear()
  fixture.ipc.clear()
  vi.stubEnv("CMB_BOT_BROWSER_PROFILE", "/synthetic-bot-browser-profile")
  sendDescriptor = Object.getOwnPropertyDescriptor(process, "send")
  connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected")
  Object.defineProperty(process, "send", { configurable: true, value: fixture.send })
  Object.defineProperty(process, "connected", { configurable: true, value: true })
  const originalOn = process.on.bind(process)
  vi.spyOn(process, "on").mockImplementation(((event, listener) => {
    if (event === "message" || event === "disconnect") {
      fixture.listeners.set(event, listener)
      return process
    }
    return originalOn(event, listener)
  }) as typeof process.on)
  await import("./browser-host-entry")
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledWith({ ready: true }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor)
  else Reflect.deleteProperty(process, "send")
  if (connectedDescriptor) Object.defineProperty(process, "connected", connectedDescriptor)
  else Reflect.deleteProperty(process, "connected")
})

async function command(id: number, action: string, targetId?: string, generation?: number) {
  fixture.listeners.get("message")!({ id, action, targetId, generation })
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ id })))
  return fixture.send.mock.calls.find(([message]) => message.id === id)![0] as {
    value?: unknown
    error?: string
  }
}

describe("Bot browser native window lifecycle", () => {
  it("hides native close while preserving the exact target for reopening without navigation", async () => {
    expect((await command(1, "create")).value).toEqual({ targetId: "owned-target-1" })
    const window = fixture.windows[0] as TestWindow
    const closed = vi.fn()
    window.on("closed", closed)
    await command(2, "show", "owned-target-1", 9)
    expect(window.visible).toBe(true)

    window.close()

    expect(window.visible).toBe(false)
    expect(window.destroyed).toBe(false)
    expect(closed).not.toHaveBeenCalled()
    expect(fixture.send).toHaveBeenCalledWith(
      { event: "window-hidden", targetId: "owned-target-1", generation: 9 },
      expect.any(Function)
    )
    expect((await command(3, "get-title", "owned-target-1")).value).toBe("Synthetic browser page")
    expect((await command(4, "show", "owned-target-1", 9)).error).toBeUndefined()
    expect(window.visible).toBe(true)
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank")
  })

  it("reports only the native-hidden target and never reports the parent's hide RPC", async () => {
    await command(1, "create")
    await command(2, "create")
    const first = fixture.windows[0] as TestWindow
    const second = fixture.windows[1] as TestWindow
    await command(3, "show", "owned-target-1", 5)
    await command(4, "show", "owned-target-2", 6)

    second.close()

    const events = () =>
      fixture.send.mock.calls.filter(([message]) => message.event === "window-hidden")
    expect(events().map(([message]) => message.targetId)).toEqual(["owned-target-2"])
    expect(events()[0][0].generation).toBe(6)
    expect(first.visible).toBe(true)
    expect(second.visible).toBe(false)
    await command(5, "hide")
    expect(first.visible).toBe(false)
    expect(events()).toHaveLength(1)
  })

  it("reports only the latest existing claim token and rejects invalid show tokens", async () => {
    await command(1, "create")
    const window = fixture.windows[0] as TestWindow
    await command(2, "show", "owned-target-1")
    window.close()
    const events = () =>
      fixture.send.mock.calls
        .filter(([message]) => message.event === "window-hidden")
        .map(([message]) => message)
    expect(events()).toEqual([])
    await command(3, "show", "owned-target-1", 30)
    window.close()
    await command(4, "show", "owned-target-1", 31)
    window.close()
    expect(events()).toEqual([
      { event: "window-hidden", targetId: "owned-target-1", generation: 30 },
      { event: "window-hidden", targetId: "owned-target-1", generation: 31 }
    ])
    expect((await command(5, "show", "owned-target-1", -1)).error).toBe("浏览器控制版本无效")
    await command(6, "show", "owned-target-1")
    window.close()
    expect(events()).toHaveLength(2)
  })

  it("accepts toolbar commands only from trusted chrome with a live lease and relays the exact target", async () => {
    await command(1, "create")
    await command(2, "show", "owned-target-1", 42)
    const window = fixture.windows[0] as TestWindow
    const action = fixture.ipc.get("bot-browser-toolbar-action")!
    const sender = window.toolbar.webContents
    await expect(
      action({ sender: window.webContents }, { action: "reload", generation: 42 })
    ).rejects.toThrow("来源")
    await expect(
      action({ sender, senderFrame: {} }, { action: "reload", generation: 42 })
    ).rejects.toThrow("来源")
    const event = { sender, senderFrame: sender.mainFrame }
    await expect(action(event, { action: "reload", generation: 41 })).rejects.toThrow("控制权")
    await expect(action(event, { action: "execute", generation: 42 })).rejects.toThrow("无效")
    const pending = action(event, { action: "reload", generation: 42 })
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "toolbar-action",
        requestId: 1,
        targetId: "owned-target-1",
        generation: 42,
        action: "reload"
      }),
      expect.any(Function)
    )
    fixture.listeners.get("message")!({ action: "toolbar-result", requestId: 1 })
    await pending
    await command(3, "hide")
    await expect(action(event, { action: "reload", generation: 42 })).rejects.toThrow("控制权")
    expect((await command(4, "is-content", "owned-target-1")).value).toBe(true)
    expect((await command(5, "is-content", "toolbar-target")).value).toBe(false)
  })

  it("reads navigation state from the exact native target without navigating", async () => {
    await command(1, "create")
    await command(2, "create")
    const first = fixture.windows[0] as TestWindow
    const second = fixture.windows[1] as TestWindow
    first.canGoBack = true
    second.canGoForward = true

    expect((await command(3, "get-state", "owned-target-1")).value).toEqual({
      title: "Synthetic browser page",
      canGoBack: true,
      canGoForward: false
    })
    expect((await command(4, "get-state", "owned-target-2")).value).toEqual({
      title: "Synthetic browser page",
      canGoBack: false,
      canGoForward: true
    })
    expect((await command(5, "get-state", "unknown-target")).error).toBe("浏览器页面已关闭")
    expect(first.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank")
    expect(second.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank")
  })

  it("captures only the exact native target while preserving hidden windows and claim tokens", async () => {
    await command(1, "create")
    await command(2, "create")
    const first = fixture.windows[0] as TestWindow
    const second = fixture.windows[1] as TestWindow
    await command(3, "show", "owned-target-2", 17)
    second.close()
    fixture.send.mockClear()

    expect((await command(4, "capture", "owned-target-2")).value).toBe(
      second.jpeg.toString("base64")
    )
    expect(first.webContents.capturePage).not.toHaveBeenCalled()
    expect(second.webContents.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, {
      stayHidden: true
    })
    expect(second.toJPEG).toHaveBeenCalledExactlyOnceWith(60)
    expect(second.visible).toBe(false)
    expect(second.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank")
    second.close()
    expect(fixture.send).toHaveBeenCalledWith(
      { event: "window-hidden", targetId: "owned-target-2", generation: 17 },
      expect.any(Function)
    )
    expect((await command(5, "capture", "unknown-target")).error).toBe("浏览器页面已关闭")
    second.webContents.emit("render-process-gone")
    expect((await command(6, "capture", "owned-target-2")).error).toBe("浏览器页面已关闭")
  })

  it("rejects empty native images and empty or oversized JPEG data", async () => {
    await command(1, "create")
    const window = fixture.windows[0] as TestWindow
    window.captureEmpty = true
    expect((await command(2, "capture", "owned-target-1")).error).toBe("Bot 浏览器截图为空")
    expect(window.toJPEG).not.toHaveBeenCalled()
    window.captureEmpty = false
    window.jpeg = Buffer.alloc(0)
    expect((await command(3, "capture", "owned-target-1")).error).toBe("Bot 浏览器截图为空")
    window.jpeg = Buffer.alloc(18 * 1024 * 1024 + 1)
    expect((await command(4, "capture", "owned-target-1")).error).toBe("Bot 浏览器截图过大")
  })

  it("allows one unfinished native capture per target and releases it when settled", async () => {
    await command(1, "create")
    await command(2, "create")
    const first = fixture.windows[0] as TestWindow
    let finish!: (image: unknown) => void
    first.webContents.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fixture.listeners.get("message")!({ id: 3, action: "capture", targetId: "owned-target-1" })
    await vi.waitFor(() => expect(first.webContents.capturePage).toHaveBeenCalledTimes(1))
    expect((await command(4, "capture", "owned-target-1")).error).toBe("Bot 浏览器正在截图，请稍候")
    expect((await command(5, "capture", "owned-target-2")).error).toBeUndefined()
    finish({ isEmpty: () => false, getSize: () => ({ width: 1280 }), toJPEG: () => first.jpeg })
    await vi.waitFor(() =>
      expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }))
    )
    expect((await command(6, "capture", "owned-target-1")).error).toBeUndefined()
    first.webContents.capturePage.mockRejectedValueOnce(new Error("Synthetic native failure"))
    expect((await command(7, "capture", "owned-target-1")).error).toBe("Synthetic native failure")
    expect((await command(8, "capture", "owned-target-1")).error).toBeUndefined()
  })

  it("restores background throttling on timeout while retaining the unfinished native capture guard", async () => {
    await command(1, "create")
    const window = fixture.windows[0] as TestWindow
    let finish!: (image: unknown) => void
    window.webContents.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    vi.useFakeTimers()
    fixture.listeners.get("message")!({ id: 2, action: "capture", targetId: "owned-target-1" })
    await vi.advanceTimersByTimeAsync(0)
    expect(window.throttled).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(fixture.send).toHaveBeenCalledWith({ id: 2, error: "Bot 浏览器截图超时" })
    expect(window.throttled).toBe(true)
    expect((await command(3, "capture", "owned-target-1")).error).toBe("Bot 浏览器正在截图，请稍候")
    expect(window.webContents.capturePage).toHaveBeenCalledTimes(1)
    // A stuck preview must not prevent native window control.
    expect((await command(4, "show", "owned-target-1", 7)).error).toBeUndefined()
    finish({ isEmpty: () => false, getSize: () => ({ width: 1280 }), toJPEG: () => window.jpeg })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.send.mock.calls.filter(([message]) => message.id === 2)).toHaveLength(1)
    expect((await command(5, "capture", "owned-target-1")).error).toBeUndefined()
    expect(window.throttled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds wide native previews and preserves an already unthrottled window", async () => {
    await command(1, "create")
    const window = fixture.windows[0] as TestWindow
    window.captureWidth = 2560
    window.throttled = false
    expect((await command(2, "capture", "owned-target-1")).error).toBeUndefined()
    expect(window.resize).toHaveBeenCalledExactlyOnceWith({ width: 1280 })
    expect(window.throttled).toBe(false)
    window.webContents.capturePage.mockRejectedValueOnce(new Error("Synthetic failure"))
    expect((await command(3, "capture", "owned-target-1")).error).toBe("Synthetic failure")
    expect(window.throttled).toBe(false)
  })

  it("preserves crash destruction and parent-owned shutdown", async () => {
    await command(1, "create")
    const window = fixture.windows[0] as TestWindow

    window.webContents.emit("render-process-gone")

    expect(window.destroyed).toBe(true)
    expect((await command(2, "show", "owned-target-1")).error).toBe("浏览器页面已关闭")
    await command(3, "quit")
    expect(fixture.app.exit).toHaveBeenCalledWith(0)
    fixture.listeners.get("disconnect")!()
    expect(fixture.app.exit).toHaveBeenCalledTimes(2)
  })
})
