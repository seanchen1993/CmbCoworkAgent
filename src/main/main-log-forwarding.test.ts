import { describe, expect, it, vi } from "vitest"
import {
  MAIN_LOG_DROPPED_SUMMARY,
  MAIN_LOG_MESSAGE_MAX_CHARS,
  createMainLogForwarder,
  createMainLogForwardingGate,
  createSafeLogMethod,
  createSafeLogProcessingGuard,
  createSafeProcessErrorHandler,
  isEpipeError,
  isTrustedMainLogToggleRequest,
  isTrustedRendererUrl,
  resolveTrustedRendererUrl,
  type MainLogForwardWindow,
  type MainLogForwardWebContents
} from "./main-log-forwarding"

function createWindow(overrides: Partial<MainLogForwardWebContents> = {}): MainLogForwardWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      mainFrame: { detached: false, isDestroyed: () => false },
      send: vi.fn(),
      ...overrides
    }
  }
}

describe("createMainLogForwarder", () => {
  it("breaks the Electron send -> wrapped console.error -> send recursion chain", () => {
    const rawErrorSink = vi.fn()
    const persist = vi.fn((_level: string, args: unknown[]) => args)
    let wrappedConsoleError: (...args: unknown[]) => void = () => undefined
    const send = vi.fn(() => {
      wrappedConsoleError("WebFrameMain.send failed")
    })
    const forward = createMainLogForwarder({
      channel: "debug:main-console-log",
      isEnabled: () => true,
      getWindows: () => [createWindow({ send })],
      formatValue: String,
      isTrustedWindow: () => true
    })
    wrappedConsoleError = createSafeLogMethod({
      level: "ERROR",
      persist,
      forward,
      sink: rawErrorSink,
      processingGuard: createSafeLogProcessingGuard()
    })

    expect(() => forward("INFO", ["business log"])).not.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(rawErrorSink).toHaveBeenCalledWith("WebFrameMain.send failed")
  })

  it("blocks a synchronous send-to-console reentry and releases the latch afterwards", () => {
    let forward: (level: string, args: unknown[]) => void = () => undefined
    const send = vi.fn(() => {
      forward("ERROR", ["Electron send fallback"])
    })
    const window = createWindow({ send })
    forward = createMainLogForwarder({
      channel: "debug:main-console-log",
      isEnabled: () => true,
      getWindows: () => [window],
      formatValue: String,
      isTrustedWindow: () => true
    })

    expect(() => forward("INFO", ["first"])).not.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith("debug:main-console-log", {
      level: "INFO",
      message: "first"
    })

    forward("INFO", ["second"])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("isolates a throwing window and continues forwarding to the next window", () => {
    const failedSend = vi.fn(() => {
      throw new Error("frame disappeared")
    })
    const healthySend = vi.fn()
    const forward = createMainLogForwarder({
      channel: "debug:main-console-log",
      isEnabled: () => true,
      getWindows: () => [createWindow({ send: failedSend }), createWindow({ send: healthySend })],
      formatValue: String,
      isTrustedWindow: () => true
    })

    expect(() => forward("WARN", ["message"])).not.toThrow()
    expect(failedSend).toHaveBeenCalledTimes(1)
    expect(healthySend).toHaveBeenCalledTimes(1)
  })

  it("skips destroyed, crashed, detached, and concurrently destroyed targets", () => {
    const sends = Array.from({ length: 6 }, () => vi.fn())
    const destroyedWindow = createWindow({ send: sends[0] })
    destroyedWindow.isDestroyed = () => true
    const destroyedContents = createWindow({ isDestroyed: () => true, send: sends[1] })
    const crashedContents = createWindow({ isCrashed: () => true, send: sends[2] })
    const detachedFrame = createWindow({
      mainFrame: { detached: true, isDestroyed: () => false },
      send: sends[3]
    })
    const destroyedFrame = createWindow({
      mainFrame: { detached: false, isDestroyed: () => true },
      send: sends[4]
    })
    const racingWindow = createWindow({ send: sends[5] })
    Object.defineProperty(racingWindow, "webContents", {
      get() {
        throw new Error("destroyed during property read")
      }
    })

    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [
        destroyedWindow,
        destroyedContents,
        crashedContents,
        detachedFrame,
        destroyedFrame,
        racingWindow
      ],
      formatValue: String,
      isTrustedWindow: () => true
    })

    expect(() => forward("ERROR", ["ignored"])).not.toThrow()
    for (const send of sends) expect(send).not.toHaveBeenCalled()
  })

  it("supports Electron versions without crash or main-frame state APIs", () => {
    const send = vi.fn()
    const window = createWindow({ isCrashed: undefined, mainFrame: undefined, send })
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [window],
      formatValue: String,
      isTrustedWindow: () => true
    })

    forward("INFO", ["compatible"])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("releases the latch after window enumeration fails", () => {
    const send = vi.fn()
    let attempt = 0
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => {
        attempt += 1
        if (attempt === 1) throw new Error("Electron is shutting down")
        return [createWindow({ send })]
      },
      formatValue: String,
      isTrustedWindow: () => true
    })

    forward("INFO", ["first"])
    forward("INFO", ["second"])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("forwards only to the trusted local main window", () => {
    const mainSend = vi.fn()
    const loginSend = vi.fn()
    const main = createWindow({
      getURL: () => "file:///app/out/renderer/index.html?route=chat#latest",
      mainFrame: {
        detached: false,
        isDestroyed: () => false,
        url: "file:///app/out/renderer/index.html#latest"
      },
      send: mainSend
    })
    const login = createWindow({
      getURL: () => "file:///app/out/renderer/index.html",
      mainFrame: {
        detached: false,
        isDestroyed: () => false,
        url: "file:///app/out/renderer/index.html"
      },
      send: loginSend
    })
    const expectedUrl = resolveTrustedRendererUrl("file:///app/out/renderer/index.html")
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [main, login],
      formatValue: String,
      isTrustedWindow: (window) =>
        window === main &&
        isTrustedRendererUrl(window.webContents.getURL?.(), expectedUrl) &&
        isTrustedRendererUrl(window.webContents.mainFrame?.url, expectedUrl)
    })

    forward("INFO", ["local only"])
    expect(mainSend).toHaveBeenCalledTimes(1)
    expect(loginSend).not.toHaveBeenCalled()

    main.webContents.getURL = () => "https://oa-auth.example.test/login"
    if (main.webContents.mainFrame) {
      main.webContents.mainFrame.url = "https://oa-auth.example.test/login"
    }
    forward("INFO", ["remote navigation"])
    expect(mainSend).toHaveBeenCalledTimes(1)
  })

  it("caps the final forwarded message at the file-log limit", () => {
    const send = vi.fn()
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [createWindow({ send })],
      formatValue: String,
      isTrustedWindow: () => true
    })

    forward("INFO", ["x".repeat(MAIN_LOG_MESSAGE_MAX_CHARS * 4)])
    const payload = send.mock.calls[0]?.[1] as { message: string }
    expect(payload.message).toHaveLength(MAIN_LOG_MESSAGE_MAX_CHARS)
    expect(payload.message).toMatch(/…\[main-log-truncated\]$/)
  })

  it("bounds a burst and emits at most one budgeted summary in the next window", () => {
    let now = 0
    const send = vi.fn()
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [createWindow({ send })],
      formatValue: String,
      isTrustedWindow: () => true,
      rateWindowMs: 1_000,
      maxMessagesPerWindow: 1,
      maxBytesPerWindow: 4_096,
      now: () => now
    })

    forward("INFO", ["first"])
    forward("INFO", ["dropped-one"])
    forward("INFO", ["dropped-two"])
    expect(send).toHaveBeenCalledTimes(1)

    now = 1_000
    forward("INFO", ["recovered-but-budgeted"])
    forward("INFO", ["still-budgeted"])

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith("channel", {
      level: "WARN",
      message: MAIN_LOG_DROPPED_SUMMARY
    })
  })

  it("applies an independent UTF-8 byte budget", () => {
    const send = vi.fn()
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [createWindow({ send })],
      formatValue: String,
      isTrustedWindow: () => true,
      maxMessagesPerWindow: 10,
      maxBytesPerWindow: 6,
      now: () => 0
    })

    forward("INFO", ["你好"])
    forward("INFO", ["x"])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("channel", { level: "INFO", message: "你好" })
  })

  it("stops an asynchronous send-to-console fallback chain at the burst limit", async () => {
    let wrappedConsoleError: (...args: unknown[]) => void = () => undefined
    const send = vi.fn(() => {
      queueMicrotask(() => wrappedConsoleError("async WebFrameMain.send failed"))
    })
    const forward = createMainLogForwarder({
      channel: "channel",
      isEnabled: () => true,
      getWindows: () => [createWindow({ send })],
      formatValue: String,
      isTrustedWindow: () => true,
      maxMessagesPerWindow: 4,
      maxBytesPerWindow: 4_096,
      now: () => 0
    })
    wrappedConsoleError = createSafeLogMethod({
      level: "ERROR",
      persist: (_level, args) => args,
      forward,
      sink: vi.fn(),
      processingGuard: createSafeLogProcessingGuard()
    })

    forward("INFO", ["start"])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(send).toHaveBeenCalledTimes(4)

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(send).toHaveBeenCalledTimes(4)
  })
})

describe("createSafeLogMethod", () => {
  it("does not throw when persistence, forwarding, or the terminal sink fails", () => {
    const persist = vi.fn(() => {
      throw new Error("disk unavailable")
    })
    const forward = vi.fn(() => {
      throw new Error("renderer unavailable")
    })
    const sink = vi.fn(() => {
      throw new Error("stderr unavailable")
    })
    const log = createSafeLogMethod({
      level: "ERROR",
      persist,
      forward,
      sink,
      processingGuard: createSafeLogProcessingGuard()
    })

    expect(() => log("secret input")).not.toThrow()
    expect(forward).toHaveBeenCalledWith("ERROR", ["[Main] Log processing failed"])
    expect(sink).toHaveBeenCalledWith("[Main] Log processing failed")
  })

  it("uses persisted redacted arguments for forwarding and the raw sink", () => {
    const forward = vi.fn()
    const sink = vi.fn()
    const log = createSafeLogMethod({
      level: "INFO",
      persist: () => ["redacted"],
      forward,
      sink,
      processingGuard: createSafeLogProcessingGuard()
    })

    log("sensitive")
    expect(forward).toHaveBeenCalledWith("INFO", ["redacted"])
    expect(sink).toHaveBeenCalledWith("redacted")
  })

  it("shares a persistence guard and suppresses cross-console reentry", () => {
    const guard = createSafeLogProcessingGuard()
    const infoForward = vi.fn()
    const warnForward = vi.fn()
    const infoSink = vi.fn()
    const warnSink = vi.fn()
    let warn: (...args: unknown[]) => void = () => undefined
    const persist = vi.fn((level: string) => {
      if (level === "INFO") warn("nested secret")
      return [`${level.toLowerCase()}-redacted`]
    })
    const info = createSafeLogMethod({
      level: "INFO",
      persist,
      forward: infoForward,
      sink: infoSink,
      processingGuard: guard
    })
    warn = createSafeLogMethod({
      level: "WARN",
      persist,
      forward: warnForward,
      sink: warnSink,
      processingGuard: guard
    })

    info("outer secret")

    expect(persist).toHaveBeenCalledTimes(1)
    expect(warnForward).not.toHaveBeenCalled()
    expect(warnSink).toHaveBeenCalledWith("[Main] Recursive log processing suppressed")
    expect(infoForward).toHaveBeenCalledWith("INFO", ["info-redacted"])
    expect(infoSink).toHaveBeenCalledWith("info-redacted")

    warn("later")
    expect(persist).toHaveBeenCalledTimes(2)
    expect(warnForward).toHaveBeenCalledWith("WARN", ["warn-redacted"])
  })
})

describe("trusted renderer log IPC", () => {
  const expectedDevUrl = resolveTrustedRendererUrl("http://localhost:5173/app/index.html")
  const expectedPackagedUrl = resolveTrustedRendererUrl(
    "file:///Applications/CMBDevClaw/out/renderer/index.html"
  )

  it("matches the exact local renderer path while ignoring only query and hash", () => {
    expect(
      isTrustedRendererUrl("http://localhost:5173/app/index.html?hmr=1#chat", expectedDevUrl)
    ).toBe(true)
    expect(isTrustedRendererUrl("http://localhost:5173/other/index.html", expectedDevUrl)).toBe(
      false
    )
    expect(
      isTrustedRendererUrl(
        "file:///Applications/CMBDevClaw/out/renderer/index.html?thread=1",
        expectedPackagedUrl
      )
    ).toBe(true)
    expect(
      isTrustedRendererUrl(
        "file:///Applications/CMBDevClaw/out/renderer/login.html",
        expectedPackagedUrl
      )
    ).toBe(false)
    expect(resolveTrustedRendererUrl("https://auth.example.test/app/index.html")).toBeUndefined()
  })

  it("accepts toggles only from the trusted main window main frame with a strict boolean", () => {
    const contents = {}
    const mainFrame = {}
    const baseRequest = {
      enabled: true,
      expectedWebContents: contents,
      sender: contents,
      expectedMainFrame: mainFrame,
      senderFrame: mainFrame,
      expectedRendererUrl: expectedDevUrl,
      senderUrl: "http://localhost:5173/app/index.html?thread=1",
      senderFrameUrl: "http://localhost:5173/app/index.html#chat"
    }

    expect(isTrustedMainLogToggleRequest(baseRequest)).toBe(true)
    expect(isTrustedMainLogToggleRequest({ ...baseRequest, enabled: "true" })).toBe(false)
    expect(isTrustedMainLogToggleRequest({ ...baseRequest, sender: {} })).toBe(false)
    expect(isTrustedMainLogToggleRequest({ ...baseRequest, senderFrame: {} })).toBe(false)
    expect(
      isTrustedMainLogToggleRequest({
        ...baseRequest,
        senderUrl: "https://auth.example.test/login",
        senderFrameUrl: "https://auth.example.test/login"
      })
    ).toBe(false)
    expect(
      isTrustedMainLogToggleRequest({
        ...baseRequest,
        senderUrl: "http://localhost:5173/other/index.html"
      })
    ).toBe(false)
  })

  it("keeps lifecycle revocation closed until the trusted renderer explicitly opts in again", () => {
    const gate = createMainLogForwardingGate(true)
    expect(gate.isEnabled()).toBe(true)

    gate.disableForLifecycle()
    expect(gate.isEnabled()).toBe(false)
    expect(gate.isEnabled()).toBe(false)

    gate.setFromTrustedRenderer(true)
    expect(gate.isEnabled()).toBe(true)
    gate.setFromTrustedRenderer(false)
    expect(gate.isEnabled()).toBe(false)
  })
})

describe("safe process error handling", () => {
  it("recognizes EPIPE without trusting arbitrary error values", () => {
    expect(isEpipeError({ code: "EPIPE" })).toBe(true)
    expect(isEpipeError(null)).toBe(false)
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(() => isEpipeError(revoked.proxy)).not.toThrow()
    expect(isEpipeError(revoked.proxy)).toBe(false)
  })

  it("does not invoke an ordinary getter or Proxy trap while checking EPIPE", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let reads = 0
    const reentrantTrap = (): never => {
      reads += 1
      console.error("reentrant fatal log")
      throw new Error("the EPIPE check must not execute this trap")
    }
    const getterError = Object.defineProperty({}, "code", {
      configurable: true,
      get: reentrantTrap
    })
    const proxyError = new Proxy(
      { code: "EPIPE" },
      {
        get: reentrantTrap,
        getOwnPropertyDescriptor: reentrantTrap,
        getPrototypeOf: reentrantTrap
      }
    )

    try {
      expect(isEpipeError(getterError)).toBe(false)
      expect(isEpipeError(proxyError)).toBe(false)
      expect(reads).toBe(0)
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it("does not throw again for null or revoked fatal exception values", () => {
    const guard = createSafeLogProcessingGuard()
    const rawSink = vi.fn()
    const persist = vi.fn((_level: string, args: unknown[]) => {
      Reflect.get(args[1] as object, "message")
      return args
    })
    const write = createSafeLogMethod({
      level: "ERROR",
      persist,
      sink: rawSink,
      processingGuard: guard
    })
    const handler = createSafeProcessErrorHandler({
      prefix: "[Main] Uncaught exception:",
      write,
      flush: () => {
        throw new Error("flush failed")
      }
    })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()

    expect(() => handler(null)).not.toThrow()
    expect(() => handler(revoked.proxy)).not.toThrow()
    expect(rawSink).toHaveBeenNthCalledWith(1, "[Main] Log processing failed")
    expect(rawSink).toHaveBeenNthCalledWith(2, "[Main] Log processing failed")
  })
})
