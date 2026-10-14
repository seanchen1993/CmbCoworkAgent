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

interface StoredAlarm {
  name: string
  periodInMinutes?: number
}

interface WorkerOptions {
  deferClear?: boolean
  deferCreate?: boolean
  deferGet?: boolean
  existingAlarm?: StoredAlarm
}

const reconnectAlarm = { name: "cmb-native-host-reconnect", periodInMinutes: 1 }

function loadServiceWorker(options: WorkerOptions = {}) {
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
  const pendingGets: Array<(value: StoredAlarm | undefined) => void> = []
  const pendingClears: Array<() => void> = []
  const pendingCreates: Array<{ finish: () => void; reject: (error: Error) => void }> = []
  let currentAlarm = options.existingAlarm
  let runtimeLastError: { message: string } | undefined
  let nextTimerId = 1
  const deferCreate = options.deferCreate

  const chrome = {
    alarms: {
      clear: vi.fn((_name: string, callback: (value: boolean) => void) => {
        const clear = () => {
          if (!runtimeLastError) currentAlarm = undefined
          callback(!runtimeLastError)
        }
        if (options.deferClear) pendingClears.push(clear)
        else clear()
      }),
      create: vi.fn((name: string, options: Record<string, number>) => {
        createdAlarms.push({ name, options })
        const created = { name, periodInMinutes: options.periodInMinutes }
        if (deferCreate) {
          return new Promise<void>((resolve, reject) => {
            pendingCreates.push({
              finish: () => {
                currentAlarm = created
                resolve()
              },
              reject
            })
          })
        }
        currentAlarm = created
      }),
      get: vi.fn((_name: string, callback: (value: StoredAlarm | undefined) => void) => {
        if (options.deferGet) pendingGets.push(callback)
        else callback(currentAlarm)
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
      get lastError(): { message: string } | undefined {
        return runtimeLastError
      },
      set lastError(value: { message: string } | undefined) {
        runtimeLastError = value
      },
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
  const bootstrap = runInNewContext(source, {
    TextEncoder,
    chrome,
    clearTimeout,
    console: testConsole,
    crypto: { randomUUID: () => "profile-test" },
    setTimeout
  }) as Promise<void>

  const runTimer = (delay: number): void => {
    const index = timers.findIndex((timer) => timer.delay === delay)
    expect(index).toBeGreaterThanOrEqual(0)
    const [timer] = timers.splice(index, 1)
    timer.callback()
  }

  const flush = async (): Promise<void> => {
    // Drain only finite Promise continuations; fake timers are always driven explicitly.
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }
  const completeGet = (alarm = options.existingAlarm): void => {
    const callback = pendingGets.shift()
    if (!callback) throw new Error("No pending alarm lookup")
    callback(alarm)
  }
  const completeCreate = (): void => {
    const pending = pendingCreates.shift()
    if (!pending) throw new Error("No pending alarm create")
    pending.finish()
  }
  const completeClear = (): void => {
    const pending = pendingClears.shift()
    if (!pending) throw new Error("No pending alarm clear")
    pending()
  }

  return {
    alarms,
    bootstrap,
    chrome,
    completeClear,
    completeCreate,
    completeGet,
    createdAlarms,
    currentAlarm: () => currentAlarm,
    flush,
    pendingCreates,
    ports,
    runTimer,
    runtimeMessages,
    testConsole,
    timers
  }
}

type Worker = ReturnType<typeof loadServiceWorker>

function exhaustBurst(worker: Worker): void {
  for (const delay of [1000, 3000, 10000]) {
    worker.ports[worker.ports.length - 1].onDisconnect.emit()
    worker.runTimer(delay)
  }
  worker.ports[worker.ports.length - 1].onDisconnect.emit()
}

function markConnected(worker: Worker, index = worker.ports.length - 1): void {
  worker.ports[index].onMessage.emit({
    connected: true,
    protocolVersion: 1,
    type: "host-status"
  })
}

function manualReconnect(worker: Worker): void {
  worker.runtimeMessages.emit({ type: "reconnect-native" }, undefined, vi.fn())
}

describe("Chrome extension native host lifecycle", () => {
  it("retries an initial connection failure and then falls back to a minute-level alarm", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
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

  it("limits recovery after a successful connection to three attempts", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
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
    expect(worker.createdAlarms).toEqual([])
  })

  it("restores the retry budget after a manual reconnect", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
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

  it("registers listeners synchronously and restores one alarm after worker reload", async () => {
    const worker = loadServiceWorker({ deferGet: true, existingAlarm: reconnectAlarm })
    expect(worker.alarms.listeners).toHaveLength(1)
    expect(worker.runtimeMessages.listeners).toHaveLength(1)
    expect(worker.chrome.runtime.onStartup.listeners).toHaveLength(1)
    expect(worker.chrome.runtime.onInstalled.listeners).toHaveLength(1)
    expect(worker.chrome.runtime.connectNative).not.toHaveBeenCalled()

    worker.chrome.runtime.onStartup.emit()
    worker.chrome.runtime.onInstalled.emit()
    worker.completeGet()
    await worker.bootstrap
    worker.chrome.runtime.onStartup.emit()
    expect(worker.chrome.alarms.get).toHaveBeenCalledTimes(1)
    expect(worker.chrome.runtime.connectNative).not.toHaveBeenCalled()
    expect(worker.chrome.alarms.create).not.toHaveBeenCalled()

    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    worker.ports[0].onDisconnect.emit()
    expect(worker.timers).toHaveLength(0)
    expect(worker.chrome.alarms.create).not.toHaveBeenCalled()
  })

  it("merges startup and alarm wakeups while bootstrap lookup is pending", async () => {
    const worker = loadServiceWorker({ deferGet: true, existingAlarm: reconnectAlarm })
    worker.chrome.runtime.onStartup.emit()
    worker.alarms.emit(reconnectAlarm)
    worker.alarms.emit(reconnectAlarm)
    worker.completeGet()
    await worker.bootstrap
    await worker.flush()
    expect(worker.chrome.alarms.get).toHaveBeenCalledTimes(1)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
  })

  it("does not add a second connection for a stale alarm during a new initial burst", async () => {
    const worker = loadServiceWorker({ deferGet: true })
    worker.alarms.emit(reconnectAlarm)
    worker.chrome.runtime.onStartup.emit()
    worker.completeGet()
    await worker.bootstrap
    await worker.flush()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    expect(worker.timers).toHaveLength(0)
  })

  it("ignores deferred bootstrap state after a manual reconnect", async () => {
    const worker = loadServiceWorker({ deferGet: true, existingAlarm: reconnectAlarm })
    worker.alarms.emit(reconnectAlarm)
    manualReconnect(worker)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    worker.completeGet()
    await worker.bootstrap
    await worker.flush()
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    worker.ports[0].onDisconnect.emit()
    expect(worker.timers.map((timer) => timer.delay)).toEqual([1000])
  })

  it("does not replay an old bootstrap wakeup after the manual burst is exhausted", async () => {
    const worker = loadServiceWorker({ deferGet: true, existingAlarm: reconnectAlarm })
    worker.alarms.emit(reconnectAlarm)
    manualReconnect(worker)
    exhaustBurst(worker)
    worker.completeGet()
    await worker.bootstrap
    await worker.flush()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(4)
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
  })

  it("handles minute failure without another burst or alarm create", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    exhaustBurst(worker)
    for (let index = 0; index < 2; index += 1) {
      worker.alarms.emit(reconnectAlarm)
      worker.alarms.emit(reconnectAlarm)
      expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5 + index)
      worker.ports[worker.ports.length - 1].onDisconnect.emit()
      expect(worker.timers).toHaveLength(0)
    }
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    expect(worker.currentAlarm()).toEqual(reconnectAlarm)
    worker.alarms.emit({ name: "other-alarm" })
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(6)
  })

  it("clears pending Promise create after a manual reconnect", async () => {
    const worker = loadServiceWorker({ deferCreate: true })
    await worker.bootstrap
    exhaustBurst(worker)
    expect(worker.pendingCreates).toHaveLength(1)
    manualReconnect(worker)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
    expect(worker.chrome.alarms.clear).not.toHaveBeenCalled()
    worker.completeCreate()
    await worker.flush()
    expect(worker.chrome.alarms.clear).toHaveBeenCalledTimes(1)
    expect(worker.currentAlarm()).toBeUndefined()
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
    worker.ports[4].onDisconnect.emit()
    expect(worker.timers.map((timer) => timer.delay)).toEqual([1000])
  })

  it("disables minute events on success before clearing pending Promise create", async () => {
    const worker = loadServiceWorker({ deferCreate: true })
    await worker.bootstrap
    exhaustBurst(worker)
    worker.alarms.emit(reconnectAlarm)
    markConnected(worker)
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
    expect(worker.chrome.alarms.clear).not.toHaveBeenCalled()
    worker.completeCreate()
    await worker.flush()
    expect(worker.currentAlarm()).toBeUndefined()
    expect(worker.chrome.alarms.clear).toHaveBeenCalledTimes(1)
    expect(worker.timers.map((timer) => timer.delay)).toEqual([30000])
  })

  it("serializes a new alarm create behind a deferred manual clear", async () => {
    const worker = loadServiceWorker({ deferClear: true, existingAlarm: reconnectAlarm })
    await worker.bootstrap
    manualReconnect(worker)
    exhaustBurst(worker)
    expect(worker.chrome.alarms.clear).toHaveBeenCalledTimes(1)
    expect(worker.chrome.alarms.create).not.toHaveBeenCalled()
    worker.completeClear()
    await worker.flush()
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    expect(worker.currentAlarm()).toEqual(reconnectAlarm)
  })

  it("ignores alarm events while successful connection clear is deferred", async () => {
    const worker = loadServiceWorker({ deferClear: true, existingAlarm: reconnectAlarm })
    await worker.bootstrap
    worker.alarms.emit(reconnectAlarm)
    markConnected(worker)
    worker.alarms.emit(reconnectAlarm)
    worker.chrome.runtime.onStartup.emit()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    worker.completeClear()
    await worker.flush()
    expect(worker.currentAlarm()).toBeUndefined()
  })

  it("stops after a short successful connection with an exhausted budget", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    exhaustBurst(worker)
    worker.alarms.emit(reconnectAlarm)
    markConnected(worker)
    await worker.flush()
    worker.ports[4].onDisconnect.emit()
    expect(worker.timers).toHaveLength(0)
    expect(worker.currentAlarm()).toBeUndefined()
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
  })

  it("retains success history through stable and manual budget resets", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    worker.ports[0].onDisconnect.emit()
    worker.runTimer(1000)
    markConnected(worker)
    worker.runTimer(30000)
    exhaustBurst(worker)
    await worker.flush()
    expect(worker.createdAlarms).toEqual([])
    expect(worker.timers).toHaveLength(0)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)

    manualReconnect(worker)
    exhaustBurst(worker)
    await worker.flush()
    expect(worker.createdAlarms).toEqual([])
    expect(worker.timers).toHaveLength(0)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(9)
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(9)
  })

  it("does not record success from an obsolete port after manual replacement", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    const previousPort = worker.ports[0]
    manualReconnect(worker)
    previousPort.onMessage.emit({ connected: true, protocolVersion: 1, type: "host-status" })
    exhaustBurst(worker)
    await worker.flush()
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    expect(worker.currentAlarm()).toEqual(reconnectAlarm)
  })

  it("does not postpone the stable timer for repeated connected status messages", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    worker.ports[0].onDisconnect.emit()
    worker.runTimer(1000)
    markConnected(worker)
    const stableTimer = worker.timers.find((timer) => timer.delay === 30000)
    markConnected(worker)
    expect(worker.timers.find((timer) => timer.delay === 30000)).toBe(stableTimer)
    worker.runTimer(30000)
    worker.ports[1].onDisconnect.emit()
    expect(worker.timers.map((timer) => timer.delay)).toEqual([1000])
  })

  it("ignores old port and stable callbacks after manual replacement", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    worker.ports[0].onDisconnect.emit()
    worker.runTimer(1000)
    markConnected(worker)
    const staleStableCallback = worker.timers.find((timer) => timer.delay === 30000)!.callback
    const previousPort = worker.ports[1]
    manualReconnect(worker)
    previousPort.onMessage.emit({ type: "export-cookies", requestId: "obsolete-export" })
    previousPort.onMessage.emit({ connected: true, protocolVersion: 1, type: "host-status" })
    previousPort.onDisconnect.emit()
    expect(worker.chrome.cookies.getAll).not.toHaveBeenCalled()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(3)
    expect(worker.timers).toHaveLength(0)

    worker.ports[2].onDisconnect.emit()
    worker.runTimer(1000)
    markConnected(worker)
    staleStableCallback()
    worker.ports[3].onDisconnect.emit()
    expect(worker.timers.map((timer) => timer.delay)).toEqual([3000])
  })

  it("ignores a cancelled retry callback after manual replacement", async () => {
    const worker = loadServiceWorker()
    await worker.bootstrap
    worker.ports[0].onDisconnect.emit()
    const staleRetry = worker.timers[0].callback
    manualReconnect(worker)
    staleRetry()
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(2)
    expect(worker.timers).toHaveLength(0)
  })

  it("does not treat a mismatched protocol as a successful host connection", async () => {
    const worker = loadServiceWorker({ existingAlarm: reconnectAlarm })
    await worker.bootstrap
    worker.alarms.emit(reconnectAlarm)
    worker.ports[0].onMessage.emit({ connected: true, protocolVersion: 2, type: "host-status" })
    expect(worker.chrome.alarms.clear).not.toHaveBeenCalled()
    expect(worker.timers).toHaveLength(0)
    worker.ports[0].onDisconnect.emit()
    expect(worker.timers).toHaveLength(0)
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(2)
  })

  it("logs a failed bootstrap lookup and enters a bounded initial burst", async () => {
    const worker = loadServiceWorker({ deferGet: true })
    worker.chrome.runtime.lastError = { message: "alarm lookup unavailable" }
    worker.completeGet()
    worker.chrome.runtime.lastError = undefined
    await worker.bootstrap
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    exhaustBurst(worker)
    expect(worker.chrome.alarms.get).toHaveBeenCalledTimes(1)
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    expect(worker.testConsole.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not restore reconnect alarm state"),
      { error: "alarm lookup unavailable" }
    )
  })

  it("logs Promise create failure without scheduling an unbounded retry", async () => {
    const worker = loadServiceWorker({ deferCreate: true })
    await worker.bootstrap
    exhaustBurst(worker)
    worker.pendingCreates.shift()!.reject(new Error("alarm quota exceeded"))
    await worker.flush()
    expect(worker.timers).toHaveLength(0)
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    expect(worker.testConsole.warn).toHaveBeenCalledWith(
      expect.stringContaining("chrome.alarms.create failed"),
      { error: "alarm quota exceeded" }
    )
    manualReconnect(worker)
    worker.ports[4].onDisconnect.emit()
    expect(worker.timers.map((timer) => timer.delay)).toEqual([1000])
  })

  it("logs callback clear failure while keeping successful alarm intent disabled", async () => {
    const worker = loadServiceWorker({ deferClear: true, existingAlarm: reconnectAlarm })
    await worker.bootstrap
    worker.alarms.emit(reconnectAlarm)
    markConnected(worker)
    worker.chrome.runtime.lastError = { message: "clear unavailable" }
    worker.completeClear()
    worker.chrome.runtime.lastError = undefined
    await worker.flush()
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    expect(worker.testConsole.warn).toHaveBeenCalledWith(
      expect.stringContaining("chrome.alarms.clear failed"),
      { error: "clear unavailable" }
    )
    expect(worker.chrome.alarms.clear).toHaveBeenCalledTimes(1)
    expect(worker.currentAlarm()).toEqual(reconnectAlarm)
  })

  it("keeps synchronous native connection failures within the same bounded budget", async () => {
    const worker = loadServiceWorker({ deferGet: true })
    worker.chrome.runtime.connectNative.mockImplementation(() => {
      throw new Error("host unavailable")
    })
    worker.completeGet()
    await worker.bootstrap
    for (const delay of [1000, 3000, 10000]) worker.runTimer(delay)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(4)
    expect(worker.timers).toHaveLength(0)
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
    worker.alarms.emit(reconnectAlarm)
    expect(worker.chrome.runtime.connectNative).toHaveBeenCalledTimes(5)
    expect(worker.timers).toHaveLength(0)
    expect(worker.chrome.alarms.create).toHaveBeenCalledTimes(1)
  })
})
