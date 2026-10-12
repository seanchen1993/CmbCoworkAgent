import { readFileSync } from "fs"
import { resolve } from "path"
import { runInNewContext } from "vm"
import { describe, expect, it, vi } from "vitest"

class ChromeEvent<T extends (...args: never[]) => unknown> {
  readonly listeners: T[] = []

  addListener(listener: T): void {
    this.listeners.push(listener)
  }

  emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) listener(...args)
  }
}

interface ScheduledTimer {
  callback: () => void
  delay: number
  id: number
}

function loadServiceWorker() {
  const testConsole = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
  const timers: ScheduledTimer[] = []
  const ports: Array<{
    disconnect: () => void
    onDisconnect: ChromeEvent<() => void>
    onMessage: ChromeEvent<(message: Record<string, unknown>) => void>
    postMessage: ReturnType<typeof vi.fn>
  }> = []
  const runtimeMessages = new ChromeEvent<
    (
      message: Record<string, unknown>,
      sender: unknown,
      respond: (value: unknown) => void
    ) => boolean
  >()
  const alarms = new ChromeEvent<(alarm: { name: string }) => void>()
  const createdAlarms: Array<{ name: string; options: Record<string, number> }> = []
  let nextTimerId = 1

  const chrome = {
    alarms: {
      clear: vi.fn(),
      create: vi.fn((name: string, options: Record<string, number>) => {
        createdAlarms.push({ name, options })
      }),
      onAlarm: alarms
    },
    cookies: {
      getAll: vi.fn((_query: unknown, callback: (value: unknown[]) => void) => callback([])),
      getAllCookieStores: vi.fn((callback: (value: Array<{ id: string }>) => void) =>
        callback([{ id: "0" }])
      )
    },
    permissions: {
      contains: vi.fn((_permission: { origins: string[] }, callback: (value: boolean) => void) =>
        callback(true)
      )
    },
    runtime: {
      connectNative: vi.fn(() => {
        const onDisconnect = new ChromeEvent<() => void>()
        const port = {
          disconnect: () => onDisconnect.emit(),
          onDisconnect,
          onMessage: new ChromeEvent<(message: Record<string, unknown>) => void>(),
          postMessage: vi.fn()
        }
        ports.push(port)
        return port
      }),
      getManifest: () => ({ version: "test" }),
      lastError: undefined as { message: string } | undefined,
      onInstalled: new ChromeEvent<() => void>(),
      onMessage: runtimeMessages,
      onStartup: new ChromeEvent<() => void>()
    },
    storage: {
      local: {
        get: vi.fn((_keys: string[], callback: (value: Record<string, unknown>) => void) =>
          callback({})
        ),
        set: vi.fn((_items: Record<string, unknown>, callback: () => void) => callback())
      }
    }
  }

  const setTimeout = (callback: () => void, delay = 0): number => {
    const id = nextTimerId
    nextTimerId += 1
    timers.push({ callback, delay, id })
    return id
  }
  const clearTimeout = (id: number): void => {
    const index = timers.findIndex((timer) => timer.id === id)
    if (index >= 0) timers.splice(index, 1)
  }

  const source = readFileSync(resolve(process.cwd(), "chrome-extension/service-worker.js"), "utf8")
  runInNewContext(source, {
    TextEncoder,
    chrome,
    clearTimeout,
    console: testConsole,
    crypto: { randomUUID: () => "profile-test" },
    setTimeout
  })

  const runTimer = (delay: number): void => {
    const index = timers.findIndex((timer) => timer.delay === delay)
    expect(index).toBeGreaterThanOrEqual(0)
    const [timer] = timers.splice(index, 1)
    timer.callback()
  }

  return { alarms, chrome, createdAlarms, ports, runTimer, runtimeMessages, timers }
}

describe("Chrome extension native host lifecycle", () => {
  it("retries an initial connection failure and then falls back to a minute-level alarm", () => {
    const worker = loadServiceWorker()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)

    worker.ports[0].onDisconnect.emit()
    worker.runTimer(1000)
    worker.ports[1].onDisconnect.emit()
    worker.runTimer(3000)
    worker.ports[2].onDisconnect.emit()
    worker.runTimer(10000)
    worker.ports[3].onDisconnect.emit()
    expect(worker.createdAlarms).toEqual([
      {
        name: "cmb-native-host-reconnect",
        options: { delayInMinutes: 1, periodInMinutes: 1 }
      }
    ])

    worker.runtimeMessages.emit({ type: "popup-status" }, undefined, vi.fn())
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(4)
    worker.alarms.emit({ name: "cmb-native-host-reconnect" })
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
  })

  it("limits recovery after a successful connection to three attempts", () => {
    const worker = loadServiceWorker()
    worker.ports[0].onMessage.emit({
      connected: true,
      protocolVersion: 1,
      type: "host-status"
    })

    worker.ports[0].onDisconnect.emit()
    worker.runTimer(1000)
    worker.ports[1].onDisconnect.emit()
    worker.runTimer(3000)
    worker.ports[2].onDisconnect.emit()
    worker.runTimer(10000)
    worker.ports[3].onDisconnect.emit()

    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(4)
    expect(worker.timers).toHaveLength(0)
  })

  it("restores the retry budget after a manual reconnect", () => {
    const worker = loadServiceWorker()
    worker.ports[0].onMessage.emit({
      connected: true,
      protocolVersion: 1,
      type: "host-status"
    })
    worker.ports[0].onDisconnect.emit()
    worker.runTimer(1000)
    worker.ports[1].onDisconnect.emit()
    worker.runTimer(3000)
    worker.ports[2].onDisconnect.emit()
    worker.runTimer(10000)
    worker.ports[3].onDisconnect.emit()

    worker.runtimeMessages.emit({ type: "reconnect-native" }, undefined, vi.fn())
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
    worker.ports[4].onDisconnect.emit()
    expect(worker.timers.map((timer) => timer.delay)).toEqual([1000])
  })
})

const exportId = "a0000000-0000-4000-8000-000000000001"
const secondId = "a0000000-0000-4000-8000-000000000002"
const cookie = { name: "session", value: "fixture", domain: ".example.test", path: "/" }
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function connectForExport(worker: ReturnType<typeof loadServiceWorker>) {
  worker.ports[0].onMessage.emit({ type: "host-status", connected: true, protocolVersion: 1 })
}
function requestExport(worker: ReturnType<typeof loadServiceWorker>, requestId = exportId) {
  worker.ports[0].onMessage.emit({ type: "export-cookies", protocolVersion: 1, requestId })
}
function exportMessages(worker: ReturnType<typeof loadServiceWorker>) {
  return worker.ports[0].postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type.startsWith("cookie-export-"))
}

describe("Chrome extension export boundaries", () => {
  it("requires an established protocol and host permission before reading cookies", async () => {
    const worker = loadServiceWorker()
    requestExport(worker)
    expect(worker.chrome.cookies.getAll).not.toHaveBeenCalled()
    expect(exportMessages(worker)[0].code).toBe("protocol_error")
    connectForExport(worker)
    worker.chrome.permissions.contains.mockImplementation((_permission, callback) =>
      callback(false)
    )
    requestExport(worker)
    await flush()
    expect(exportMessages(worker).at(-1).code).toBe("permission_required")
    expect(worker.chrome.cookies.getAllCookieStores).not.toHaveBeenCalled()
    expect(worker.chrome.cookies.getAll).not.toHaveBeenCalled()
  })

  it("never falls back to an incognito store", async () => {
    const worker = loadServiceWorker()
    connectForExport(worker)
    worker.chrome.cookies.getAllCookieStores.mockImplementation((callback) =>
      callback([{ id: "1" }])
    )
    requestExport(worker)
    await flush()
    expect(exportMessages(worker).at(-1).code).toBe("export_failed")
    expect(worker.chrome.cookies.getAll).not.toHaveBeenCalled()
  })

  it("bounds UTF-8 chunk bytes and reports skipped oversized cookies", async () => {
    const worker = loadServiceWorker()
    connectForExport(worker)
    worker.chrome.cookies.getAll.mockImplementation((_query, callback) =>
      callback([
        cookie,
        { ...cookie, name: "too-big", value: "界".repeat(200000) },
        { ...cookie, name: "bounded", value: "界".repeat(170000) }
      ])
    )
    requestExport(worker)
    await flush()
    while (worker.timers.some((timer) => timer.delay === 0)) {
      worker.runTimer(0)
      await flush()
    }
    const messages = exportMessages(worker)
    expect(worker.chrome.cookies.getAll).toHaveBeenCalledWith(
      { storeId: "0" },
      expect.any(Function)
    )
    expect(messages.at(-1)).toMatchObject({ type: "cookie-export-complete", total: 2, skipped: 1 })
    for (const chunk of messages.filter((message) => message.type === "cookie-export-chunk"))
      expect(Buffer.byteLength(JSON.stringify(chunk.cookies))).toBeLessThanOrEqual(512 * 1024)
    expect(JSON.stringify(messages)).not.toContain("too-big")
  })

  it("bounds the export count and keeps cancellation effective between chunks", async () => {
    const worker = loadServiceWorker()
    connectForExport(worker)
    worker.chrome.cookies.getAll.mockImplementation((_query, callback) =>
      callback(
        Array.from({ length: 10001 }, (_, index) => ({
          ...cookie,
          name: String(index),
          value: "x".repeat(80)
        }))
      )
    )
    requestExport(worker)
    await flush()
    expect(exportMessages(worker)[0]).toMatchObject({
      type: "cookie-export-begin",
      total: 10000,
      skipped: 1
    })
    worker.ports[0].onMessage.emit({ type: "cancel-cookie-export", requestId: exportId })
    worker.runTimer(0)
    await flush()
    expect(
      exportMessages(worker).filter((message) => message.type === "cookie-export-chunk")
    ).toHaveLength(1)
    expect(
      exportMessages(worker).some((message) => message.type === "cookie-export-complete")
    ).toBe(false)
    worker.chrome.cookies.getAll.mockImplementation((_query, callback) => callback([]))
    requestExport(worker, secondId)
    await flush()
    expect(exportMessages(worker).at(-1)).toMatchObject({
      type: "cookie-export-complete",
      requestId: secondId
    })
  })

  it("does not export stale cookies to a replacement native connection", async () => {
    const worker = loadServiceWorker()
    connectForExport(worker)
    let release!: (cookies: unknown[]) => void
    worker.chrome.cookies.getAll.mockImplementation((_query, callback) => {
      release = callback
    })
    requestExport(worker)
    await flush()
    requestExport(worker, secondId)
    await flush()
    expect(worker.chrome.cookies.getAll).toHaveBeenCalledTimes(1)
    expect(exportMessages(worker).at(-1)).toMatchObject({
      code: "export_failed",
      requestId: secondId
    })
    worker.runtimeMessages.emit({ type: "reconnect-native" }, undefined, vi.fn())
    release([cookie])
    await flush()
    expect(
      worker.ports[1].postMessage.mock.calls.every(
        ([message]) => message.type === "extension-ready"
      )
    ).toBe(true)
    expect(exportMessages(worker).some((message) => message.type === "cookie-export-chunk")).toBe(
      false
    )
  })
})
