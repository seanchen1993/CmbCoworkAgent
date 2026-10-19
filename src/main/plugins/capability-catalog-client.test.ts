import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { afterEach, expect, it, vi } from "vitest"
import { CapabilityCatalogWorkers } from "./capability-catalog-client"

class FakeWorker extends EventEmitter {
  unref = vi.fn()
  terminate = vi.fn(async () => {
    this.emit("exit", 0)
    return 0
  })
  postMessage = vi.fn((request: { id: number }) => {
    queueMicrotask(() =>
      this.emit("message", {
        id: request.id,
        result: {
          pluginId: "plugin",
          status: "invalid",
          capabilities: [],
          packageDigest: null,
          reasons: ["CAPABILITY_PACKAGE_LIMIT"]
        }
      })
    )
  })
}
const plugin = { id: "plugin", name: "plugin", version: "1", path: "host-path", enabled: true }
afterEach(() => vi.useRealTimers())

it("reuses one worker serially, returns hard limits unchanged, and always terminates", async () => {
  const worker = new FakeWorker()
  const factory = vi.fn(async () => worker as unknown as Worker)
  const pool = new CapabilityCatalogWorkers(factory)
  await pool.read(async (read) => {
    for (let n = 0; n < 2; n++)
      expect((await read(plugin, "project")).reasons).toEqual(["CAPABILITY_PACKAGE_LIMIT"])
  })
  expect(factory).toHaveBeenCalledOnce()
  expect(worker.postMessage).toHaveBeenCalledTimes(2)
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(worker.listenerCount("message")).toBe(0)
})

it("bounds simultaneous transactions and releases permits after errors", async () => {
  const factory = vi.fn(async () => new FakeWorker() as unknown as Worker)
  const pool = new CapabilityCatalogWorkers(factory)
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const a = pool.read(async () => wait)
  const b = pool.read(async () => wait)
  await expect(pool.read(async () => {})).rejects.toThrow("COMPOSITION_CATALOG_BUSY")
  expect(factory).toHaveBeenCalledTimes(2)
  release()
  await Promise.all([a, b])
  await expect(
    pool.read(async () => {
      throw Error("COMPOSITION_SOURCE_CHANGED")
    })
  ).rejects.toThrow("COMPOSITION_SOURCE_CHANGED")
  await expect(pool.read(async () => "available")).resolves.toBe("available")
})

it.each(["error", "exit", "abort", "watchdog"] as const)(
  "rejects %s without a partial result, terminates and allows the next request",
  async (mode) => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    worker.postMessage.mockImplementation(() => {})
    const pool = new CapabilityCatalogWorkers(async () => worker as unknown as Worker)
    const abort = new AbortController()
    const pending = pool.read((read) => read(plugin, "project"), abort.signal)
    const rejection = expect(pending).rejects.toThrow("COMPOSITION_CATALOG_BUSY")
    await Promise.resolve()
    await Promise.resolve()
    if (mode === "abort") abort.abort()
    else if (mode === "watchdog") await vi.advanceTimersByTimeAsync(10000)
    else worker.emit(mode, mode === "error" ? Error("worker crashed") : 1)
    await rejection
    expect(worker.terminate).toHaveBeenCalled()
    expect(worker.listenerCount("message")).toBe(0)
    await expect(pool.read(async () => "new request")).resolves.toBe("new request")
  }
)

it("releases its permit when worker startup fails", async () => {
  const factory = vi.fn(async (): Promise<Worker> => {
    throw Error("startup")
  })
  const pool = new CapabilityCatalogWorkers(factory)
  for (let n = 0; n < 3; n++)
    await expect(pool.read(async () => {})).rejects.toThrow("COMPOSITION_CATALOG_BUSY")
  expect(factory).toHaveBeenCalledTimes(3)
})

it("keeps transaction cancellation active between sequential reads with the same signal", async () => {
  const worker = new FakeWorker()
  const pool = new CapabilityCatalogWorkers(async () => worker as unknown as Worker)
  const abort = new AbortController()
  await expect(
    pool.read(async (read) => {
      await read(plugin, "project", abort.signal)
      abort.abort()
      expect(worker.terminate).toHaveBeenCalledOnce()
      return "must not publish a result after cancellation"
    }, abort.signal)
  ).rejects.toThrow("COMPOSITION_CATALOG_BUSY")
})
