import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { HarnessStageAttributionCache } from "./harness-stage-attribution-cache"
import { HarnessStageWatchRegistry } from "./harness-stage-watch"

let workerCode: string
const registries: HarnessStageWatchRegistry[] = []
const roots: string[] = []
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../harness-board/watch-ref-worker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false
  })
  workerCode = result.outputFiles[0].text
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(registries.splice(0).map((registry) => registry.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function root() {
  const path = await mkdtemp(join(tmpdir(), "harness-stage-watch-"))
  roots.push(path)
  return path
}
function registry(changed: (project: string, feature: string) => void) {
  const result = new HarnessStageWatchRegistry(
    changed,
    async () => new Worker(workerCode, { eval: true })
  )
  registries.push(result)
  return result
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeStageWorker extends EventEmitter {
  readonly requests: Array<Record<string, unknown>> = []
  watcherCount = 1
  terminations = 0

  unref(): this {
    return this
  }

  async terminate(): Promise<number> {
    this.terminations += 1
    return 0
  }

  postMessage(message: Record<string, unknown>): void {
    this.requests.push(message)
    if (message.type === "start") {
      Promise.resolve().then(() =>
        this.emit("message", {
          type: "installed",
          scopeKey: message.scopeKey,
          generation: message.generation,
          watcherCount: this.watcherCount,
          cancelled: false
        })
      )
    }
  }
}

describe("project conversation stage notifications", () => {
  it("refreshes node/status changes and atomic replacements while ignoring ordinary file writes", async () => {
    const workspace = await root()
    const stateFile = join(workspace, "state.json")
    await writeFile(stateFile, JSON.stringify({ name: "plan", status: "进行中" }))
    const resolver = vi.fn(async () => JSON.parse(await readFile(stateFile, "utf8")))
    const cache = new HarnessStageAttributionCache({ resolver, now: () => 0 })
    const changed = vi.fn((p: string, f: string) => cache.markDirty(p, f))
    await registry(changed).configure("p", "f", workspace, [
      { path: "state.json", purpose: "run-state" },
      { path: ".", purpose: "artifacts" },
      { path: "hooks.log", purpose: "hook-log" }
    ])
    expect((await cache.getForExecution("p", "f")).nodeName).toBe("plan")
    await writeFile(join(workspace, "code.ts"), "edited")
    await writeFile(join(workspace, "hooks.log"), "hook finished")
    await pause(150)
    expect(changed).not.toHaveBeenCalled()
    await cache.getForExecution("p", "f")
    expect(resolver).toHaveBeenCalledTimes(1)

    for (const [index, stage] of [
      { name: "dev", status: "进行中" },
      { name: "dev", status: "已完成" },
      { name: "test", status: "进行中" }
    ].entries()) {
      changed.mockClear()
      if (index === 1) {
        await writeFile(join(workspace, "replacement.json"), JSON.stringify(stage))
        await rename(join(workspace, "replacement.json"), stateFile)
      } else await writeFile(stateFile, JSON.stringify(stage))
      await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("p", "f"))
      // Let a multi-event filesystem write finish its trailing notification.
      await pause(120)
      await expect(cache.getForExecution("p", "f")).resolves.toEqual({
        nodeName: stage.name,
        nodeStatus: stage.status
      })
      expect(resolver).toHaveBeenCalledTimes(index + 2)
    }
  })

  it("keeps more than four project conversations subscribed and isolates features", async () => {
    const workspace = await root()
    const changed = vi.fn()
    const watches = registry(changed)
    for (let i = 0; i < 6; i++) {
      await writeFile(join(workspace, `${i}.json`), "before")
      await watches.configure("p", `f${i}`, workspace, [
        { path: `${i}.json`, purpose: "run-state" }
      ])
    }
    await pause(150)
    changed.mockClear()
    await writeFile(join(workspace, "0.json"), "after")
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("p", "f0"))
    await pause(150)
    expect(changed.mock.calls.every(([p, f]) => p === "p" && f === "f0")).toBe(true)
  })

  it("does not start a worker for unbound calls or artifact/log-only refs", async () => {
    const factory = vi.fn(async () => new Worker(workerCode, { eval: true }))
    const watches = new HarnessStageWatchRegistry(vi.fn(), factory)
    registries.push(watches)
    await watches.configure("", "f", "/workspace", [{ path: "state", purpose: "run-state" }])
    await watches.configure("p", "", "/workspace", [{ path: "state", purpose: "run-state" }])
    await watches.configure("p", "f", "/workspace", [{ path: ".", purpose: "artifacts" }])
    expect(factory).not.toHaveBeenCalled()
  })

  it("remembers page paths without watching until a project conversation activates them", async () => {
    const workspace = await root()
    await writeFile(join(workspace, "state.json"), "before")
    const changed = vi.fn()
    const factory = vi.fn(async () => new Worker(workerCode, { eval: true }))
    const watches = new HarnessStageWatchRegistry(changed, factory)
    registries.push(watches)
    watches.remember("p", "f", workspace, [{ path: "state.json", purpose: "run-state" }])
    expect(factory).not.toHaveBeenCalled()
    await Promise.all([watches.activate("p", "f"), watches.activate("p", "f")])
    expect(factory).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledExactlyOnceWith("p", "f")
    changed.mockClear()
    await writeFile(join(workspace, "state.json"), "after")
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("p", "f"))
  })

  it("reuses watchers, renews their lease and releases idle scopes", async () => {
    vi.useFakeTimers()
    const worker = new FakeStageWorker()
    const watches = new HarnessStageWatchRegistry(
      vi.fn(),
      async () => worker as unknown as Worker,
      100
    )
    registries.push(watches)
    const configure = () =>
      watches.configure("p", "f", "/workspace", [{ path: "state", purpose: "run-state" }])
    await configure()
    await vi.advanceTimersByTimeAsync(50)
    await configure()
    expect(worker.requests.filter((r) => r.type === "start")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(51)
    expect(worker.requests.filter((r) => r.type === "stop")).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(worker.requests.filter((r) => r.type === "stop")).toHaveLength(1)
    await configure()
    expect(worker.requests.filter((r) => r.type === "start")).toHaveLength(2)
  })

  it("keeps 1,000 hot activations synchronous without repeated starts or timers", async () => {
    vi.useFakeTimers()
    const worker = new FakeStageWorker()
    const factory = vi.fn(async () => worker as unknown as Worker)
    const changed = vi.fn()
    const watches = new HarnessStageWatchRegistry(changed, factory)
    registries.push(watches)
    await watches.configure("p", "f", "/workspace", [{ path: "state", purpose: "run-state" }])
    const timerCount = vi.getTimerCount()

    for (let index = 0; index < 1_000; index += 1) {
      expect(watches.activate("p", "f")).toBeUndefined()
    }

    expect(worker.requests.filter((request) => request.type === "start")).toHaveLength(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(timerCount)
  })

  it("reconfigures active page paths immediately and releases subscriptions when state refs disappear", async () => {
    vi.useFakeTimers()
    const worker = new FakeStageWorker()
    const changed = vi.fn()
    const watches = new HarnessStageWatchRegistry(changed, async () => worker as unknown as Worker)
    registries.push(watches)
    await watches.configure("p", "f", "/workspace", [{ path: "old-state", purpose: "run-state" }])
    const firstStart = worker.requests[0]

    watches.remember("p", "f", "/workspace", [{ path: "new-state", purpose: "run-state" }])
    await vi.advanceTimersByTimeAsync(0)
    const starts = worker.requests.filter((request) => request.type === "start")
    expect(starts).toHaveLength(2)
    expect(starts[1].refs).toEqual([{ path: "new-state", purpose: "run-state" }])
    expect(new Int32Array(firstStart.cancelBuffer as SharedArrayBuffer)[0]).toBe(1)
    expect(changed).toHaveBeenCalledExactlyOnceWith("p", "f")
    expect(watches.activate("p", "f")).toBeUndefined()

    watches.remember("p", "f", "/workspace", [{ path: ".", purpose: "artifacts" }])
    expect(new Int32Array(starts[1].cancelBuffer as SharedArrayBuffer)[0]).toBe(1)
    expect(worker.requests.filter((request) => request.type === "stop")).toHaveLength(2)
    expect(watches.activate("p", "f")).toBeUndefined()
    watches.remember("p", "f", "/workspace", [{ path: "later-state", purpose: "run-state" }])
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.requests.filter((request) => request.type === "start")).toHaveLength(2)
  })

  it("retries failed installations on demand after 30 seconds without a hot-path retry storm", async () => {
    vi.useFakeTimers()
    const worker = new FakeStageWorker()
    worker.watcherCount = 0
    const changed = vi.fn()
    const watches = new HarnessStageWatchRegistry(changed, async () => worker as unknown as Worker)
    registries.push(watches)
    const configure = () =>
      watches.configure("p", "f", "/workspace", [{ path: "state", purpose: "run-state" }])
    await configure()
    for (let index = 0; index < 1_000; index += 1) {
      expect(watches.activate("p", "f")).toBeUndefined()
    }
    await vi.advanceTimersByTimeAsync(29_999)
    expect(watches.activate("p", "f")).toBeUndefined()
    await configure()
    expect(worker.requests.filter((request) => request.type === "start")).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()

    worker.watcherCount = 1
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.requests.filter((request) => request.type === "start")).toHaveLength(1)
    const retry = watches.activate("p", "f")
    expect(retry).toBeInstanceOf(Promise)
    await retry

    expect(worker.requests.filter((request) => request.type === "start")).toHaveLength(2)
    expect(changed).toHaveBeenCalledExactlyOnceWith("p", "f")
    expect(watches.activate("p", "f")).toBeUndefined()
  })

  it("cannot recreate subscriptions after close", async () => {
    vi.useFakeTimers()
    const worker = new FakeStageWorker()
    const factory = vi.fn(async () => worker as unknown as Worker)
    const watches = new HarnessStageWatchRegistry(vi.fn(), factory)
    registries.push(watches)
    await watches.configure("p", "f", "/workspace", [{ path: "state", purpose: "run-state" }])
    await watches.close()

    watches.remember("p", "f", "/workspace", [{ path: "new-state", purpose: "run-state" }])
    expect(watches.activate("p", "f")).toBeUndefined()
    await watches.configure("p", "f", "/workspace", [{ path: "new-state", purpose: "run-state" }])
    await vi.advanceTimersByTimeAsync(20 * 60_000)

    expect(worker.requests.filter((request) => request.type === "start")).toHaveLength(1)
    expect(worker.terminations).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
