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
  let nextTimerId = 1

  const chrome = {
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

  return { chrome, ports, runTimer, runtimeMessages, timers }
}

describe("Chrome extension native host lifecycle", () => {
  it("does not retry an initial connection failure or connect during status polling", () => {
    const worker = loadServiceWorker()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)

    worker.ports[0].onDisconnect.emit()
    expect(worker.timers).toHaveLength(0)

    worker.runtimeMessages.emit({ type: "popup-status" }, undefined, vi.fn())
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
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
