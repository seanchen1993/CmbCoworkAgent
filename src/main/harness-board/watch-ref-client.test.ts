import { EventEmitter } from "node:events"
import { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import { HarnessWatchRefWorkerClient } from "./watch-ref-client"
import {
  HARNESS_WATCH_REF_MAX_REFS,
  type HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"

class FakeWatchRefWorker extends EventEmitter {
  readonly requests: Array<Record<string, unknown>> = []
  terminations = 0

  postMessage(message: Record<string, unknown>): void {
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminations += 1
    this.emit("exit", 0)
    return Promise.resolve(0)
  }
}

const clients: HarnessWatchRefWorkerClient[] = []

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map((client) => client.close()))
  } finally {
    vi.useRealTimers()
  }
})

function refs(count: number): HarnessWatchRef[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `path-${index}`,
    purpose: "artifacts"
  }))
}

describe("Harness watch-ref worker client", () => {
  it("keeps the main ticker moving while a worker performs a slow install", async () => {
    const worker = new Worker(
      `
        const { parentPort } = require("node:worker_threads")
        parentPort.on("message", (message) => {
          if (message.type === "start") {
            const until = Date.now() + 150
            while (Date.now() < until) {}
            parentPort.postMessage({
              type: "installed",
              scopeKey: message.scopeKey,
              generation: message.generation,
              watcherCount: message.refs.length,
              cancelled: false
            })
          }
        })
      `,
      { eval: true }
    )
    let installedResolve!: (
      event: Extract<HarnessWatchRefWorkerResponse, { type: "installed" }>
    ) => void
    const installed = new Promise<Extract<HarnessWatchRefWorkerResponse, { type: "installed" }>>(
      (resolve) => {
        installedResolve = resolve
      }
    )
    const client = new HarnessWatchRefWorkerClient(
      {
        onChanged: () => undefined,
        onDirty: () => undefined,
        onInstalled: installedResolve
      },
      async () => worker
    )
    clients.push(client)

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      client.start("project:a", "C:\\workspace", refs(1_000))
      const result = await installed
      expect(result.watcherCount).toBe(HARNESS_WATCH_REF_MAX_REFS)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(10)
  })

  it("cancels A when the same scope installs B and ignores stale worker events", async () => {
    const worker = new FakeWatchRefWorker()
    const changed: string[] = []
    const client = new HarnessWatchRefWorkerClient(
      {
        onChanged: (event) => changed.push(event.workspacePath),
        onDirty: () => undefined
      },
      async () => worker as unknown as Worker
    )
    clients.push(client)

    client.start("run:a", "C:\\workspace-a", refs(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const firstStart = worker.requests.find((request) => request.type === "start")!

    client.start("run:a", "C:\\workspace-b", refs(100))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const starts = worker.requests.filter((request) => request.type === "start")
    const secondStart = starts[1]
    expect(new Int32Array(firstStart.cancelBuffer as SharedArrayBuffer)[0]).toBe(1)
    expect(secondStart.refs).toHaveLength(HARNESS_WATCH_REF_MAX_REFS)
    expect(secondStart.notifyChanges).toBe(true)

    worker.emit("message", {
      type: "changed",
      scopeKey: "run:a",
      generation: firstStart.generation as number,
      workspacePath: "C:\\workspace-a",
      ref: refs(1)[0],
      at: "2026-08-24T00:00:00.000Z"
    } satisfies HarnessWatchRefWorkerResponse)
    worker.emit("message", {
      type: "changed",
      scopeKey: "run:a",
      generation: secondStart.generation as number,
      workspacePath: "C:\\workspace-b",
      ref: refs(1)[0],
      at: "2026-08-24T00:00:01.000Z"
    } satisfies HarnessWatchRefWorkerResponse)

    expect(changed).toEqual(["C:\\workspace-b"])
    client.stopAll()
    expect(new Int32Array(secondStart.cancelBuffer as SharedArrayBuffer)[0]).toBe(1)
    expect(worker.requests.at(-1)).toMatchObject({ type: "stop-all" })
  })

  it("reinstalls desired scopes after a clean unexpected worker exit", async () => {
    const firstWorker = new FakeWatchRefWorker()
    const replacement = new FakeWatchRefWorker()
    let starts = 0
    const client = new HarnessWatchRefWorkerClient(
      { onChanged: () => undefined, onDirty: () => undefined },
      async () => {
        starts += 1
        return (starts === 1 ? firstWorker : replacement) as unknown as Worker
      }
    )
    clients.push(client)

    client.start("project:recover", "C:\\workspace", refs(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(firstWorker.requests).toHaveLength(1)
    firstWorker.emit("exit", 0)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(starts).toBe(2)
    expect(replacement.requests).toHaveLength(1)
    expect(replacement.requests[0]).toMatchObject({
      type: "start",
      scopeKey: "project:recover",
      workspacePath: "C:\\workspace"
    })
  })

  it("keeps identical pending and installed watches without extra IPC", async () => {
    vi.useFakeTimers()
    const worker = new FakeWatchRefWorker()
    const client = new HarnessWatchRefWorkerClient(
      { onDirty: () => undefined },
      async () => worker as unknown as Worker
    )
    clients.push(client)

    client.start("run:a", "C:\\workspace", refs(2))
    client.start("run:a", "C:\\workspace", refs(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.requests).toHaveLength(1)
    const request = worker.requests[0]
    expect(request.notifyChanges).toBe(false)
    worker.emit("message", {
      type: "installed",
      scopeKey: "run:a",
      generation: request.generation,
      watcherCount: 2,
      cancelled: false
    })

    for (let index = 0; index < 100; index += 1) {
      client.start(
        "run:a",
        "C:\\workspace",
        refs(2).map((ref) => ({ purpose: ref.purpose, path: ref.path }))
      )
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.requests).toHaveLength(1)
    expect(Atomics.load(new Int32Array(request.cancelBuffer as SharedArrayBuffer), 0)).toBe(0)
  })

  it.each(["empty installation", "cancelled installation"])(
    "retries an identical configuration after an %s",
    async (failure) => {
      vi.useFakeTimers()
      const worker = new FakeWatchRefWorker()
      const client = new HarnessWatchRefWorkerClient(
        { onDirty: () => undefined },
        async () => worker as unknown as Worker
      )
      clients.push(client)

      client.start("run:a", "C:\\workspace", refs(1))
      await vi.advanceTimersByTimeAsync(0)
      const firstStart = worker.requests[0]
      if (failure === "cancelled installation") {
        Atomics.store(new Int32Array(firstStart.cancelBuffer as SharedArrayBuffer), 0, 1)
      }
      worker.emit("message", {
        type: "installed",
        scopeKey: "run:a",
        generation: firstStart.generation,
        watcherCount: failure === "empty installation" ? 0 : 1,
        cancelled: false
      })
      client.start("run:a", "C:\\workspace", refs(1))
      await vi.advanceTimersByTimeAsync(0)

      const starts = worker.requests.filter((request) => request.type === "start")
      expect(starts).toHaveLength(2)
      expect(starts[1].generation).not.toBe(firstStart.generation)
      expect(Atomics.load(new Int32Array(starts[1].cancelBuffer as SharedArrayBuffer), 0)).toBe(0)
    }
  )

  it("installs each generation once when a new scope arrives during worker recovery", async () => {
    vi.useFakeTimers()
    const firstWorker = new FakeWatchRefWorker()
    const replacement = new FakeWatchRefWorker()
    let resolveReplacement!: (worker: Worker) => void
    const pendingReplacement = new Promise<Worker>((resolve) => {
      resolveReplacement = resolve
    })
    const factory = vi
      .fn<() => Promise<Worker>>()
      .mockResolvedValueOnce(firstWorker as unknown as Worker)
      .mockReturnValue(pendingReplacement)
    const client = new HarnessWatchRefWorkerClient({ onDirty: () => undefined }, factory)
    clients.push(client)

    client.start("run:a", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(0)
    firstWorker.emit("exit", 0)
    client.start("run:b", "C:\\workspace", refs(2))
    await vi.advanceTimersByTimeAsync(99)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(2)
    client.start("run:c", "C:\\workspace", refs(1))
    resolveReplacement(replacement as unknown as Worker)
    await vi.advanceTimersByTimeAsync(0)

    expect(replacement.requests.map((request) => request.scopeKey)).toEqual([
      "run:a",
      "run:b",
      "run:c"
    ])
    for (const request of replacement.requests) {
      expect(Atomics.load(new Int32Array(request.cancelBuffer as SharedArrayBuffer), 0)).toBe(0)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(replacement.requests).toHaveLength(3)
  })

  it("keeps active workers, reuses them during short idle gaps, and releases them after the last scope", async () => {
    vi.useFakeTimers()
    const firstWorker = new FakeWatchRefWorker()
    const replacement = new FakeWatchRefWorker()
    const factory = vi
      .fn<() => Promise<Worker>>()
      .mockResolvedValueOnce(firstWorker as unknown as Worker)
      .mockResolvedValue(replacement as unknown as Worker)
    const client = new HarnessWatchRefWorkerClient({ onDirty: () => undefined }, factory)
    clients.push(client)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory).not.toHaveBeenCalled()
    client.start("run:a", "C:\\workspace", refs(1))
    client.start("run:b", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(0)
    client.stop("run:a")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(firstWorker.terminations).toBe(0)

    client.stop("run:b")
    await vi.advanceTimersByTimeAsync(29_999)
    expect(firstWorker.terminations).toBe(0)
    client.start("run:c", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(firstWorker.terminations).toBe(0)
    expect(factory).toHaveBeenCalledTimes(1)

    client.stop("run:c")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(firstWorker.terminations).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory).toHaveBeenCalledTimes(1)
    client.start("run:d", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(replacement.requests[0]).toMatchObject({ type: "start", scopeKey: "run:d" })
  })

  it("disposes a worker that finishes starting after its last scope was stopped", async () => {
    vi.useFakeTimers()
    const worker = new FakeWatchRefWorker()
    let resolveWorker!: (worker: Worker) => void
    const pendingWorker = new Promise<Worker>((resolve) => {
      resolveWorker = resolve
    })
    const factory = vi.fn(() => pendingWorker)
    const client = new HarnessWatchRefWorkerClient({ onDirty: () => undefined }, factory)
    clients.push(client)

    client.start("run:a", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(0)
    client.stop("run:a")
    resolveWorker(worker as unknown as Worker)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(worker.terminations).toBe(1)
    expect(worker.requests).toEqual([])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("retains a starting worker when a replacement scope arrives before startup finishes", async () => {
    vi.useFakeTimers()
    const worker = new FakeWatchRefWorker()
    let resolveWorker!: (worker: Worker) => void
    const pendingWorker = new Promise<Worker>((resolve) => {
      resolveWorker = resolve
    })
    const factory = vi.fn(() => pendingWorker)
    const client = new HarnessWatchRefWorkerClient({ onDirty: () => undefined }, factory)
    clients.push(client)

    client.start("run:a", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(0)
    client.stop("run:a")
    client.start("run:b", "C:\\workspace", refs(1))
    resolveWorker(worker as unknown as Worker)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(worker.terminations).toBe(0)
    expect(worker.requests).toHaveLength(1)
    expect(worker.requests[0]).toMatchObject({ type: "start", scopeKey: "run:b" })
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("backs off repeated startup failures and cancels recovery when all scopes stop", async () => {
    vi.useFakeTimers()
    const factory = vi
      .fn<() => Promise<Worker>>()
      .mockRejectedValue(new Error("worker unavailable"))
    const client = new HarnessWatchRefWorkerClient({ onDirty: () => undefined }, factory)
    clients.push(client)

    client.start("run:a", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(3)
    client.start("run:b", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(399)
    expect(factory).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.mock.calls.length).toBeLessThan(12)

    const callsBeforeStop = factory.mock.calls.length
    client.stopAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory).toHaveBeenCalledTimes(callsBeforeStop)
  })

  it("restores prompt recovery after a successful install", async () => {
    vi.useFakeTimers()
    const firstWorker = new FakeWatchRefWorker()
    const replacement = new FakeWatchRefWorker()
    const factory = vi
      .fn<() => Promise<Worker>>()
      .mockRejectedValueOnce(new Error("worker unavailable"))
      .mockResolvedValueOnce(firstWorker as unknown as Worker)
      .mockResolvedValue(replacement as unknown as Worker)
    const client = new HarnessWatchRefWorkerClient({ onDirty: () => undefined }, factory)
    clients.push(client)

    client.start("run:a", "C:\\workspace", refs(1))
    await vi.advanceTimersByTimeAsync(100)
    const start = firstWorker.requests[0]
    firstWorker.emit("message", {
      type: "installed",
      scopeKey: "run:a",
      generation: start.generation,
      watcherCount: 1,
      cancelled: false
    })
    firstWorker.emit("exit", 0)
    await vi.advanceTimersByTimeAsync(100)

    expect(factory).toHaveBeenCalledTimes(3)
    expect(replacement.requests[0]).toMatchObject({ type: "start", scopeKey: "run:a" })
  })
})
