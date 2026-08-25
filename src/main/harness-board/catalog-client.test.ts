import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { HarnessCatalogCancelledError, HarnessCatalogClient } from "./catalog-client"

class FakeCatalogWorker extends EventEmitter {
  readonly requests: Array<Record<string, unknown>> = []
  terminateCalls = 0

  postMessage(message: Record<string, unknown>): void {
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1
    return Promise.resolve(0)
  }
}

function resolveProjectContexts(
  worker: FakeCatalogWorker,
  requestIndex: number,
  projectId: string
): void {
  const request = worker.requests[requestIndex]
  worker.emit("message", {
    type: "read-project-contexts-result",
    requestId: request.requestId,
    ok: true,
    result: {
      projects: { [projectId]: null },
      stats: { durationMs: 1, responseBytes: 64, projectRows: 0, cancelled: false }
    }
  })
}

describe("Harness catalog worker client", () => {
  it("keeps a renderer ticker responsive and makes rapid reloads latest-wins", async () => {
    const worker = new FakeCatalogWorker()
    const client = new HarnessCatalogClient(async () => worker as unknown as Worker)
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const first = client.readPage({ query: "old" }, "renderer:board")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = client.readPage({ query: "new" }, "renderer:board")
    await expect(first).rejects.toBeInstanceOf(HarnessCatalogCancelledError)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(ticks).toBeGreaterThan(0)

    const request = worker.requests.at(-1)!
    worker.emit("message", {
      type: "read-page-result",
      requestId: request.requestId,
      ok: true,
      result: {
        projects: [],
        registry: [],
        projectNextCursor: null,
        registryNextCursor: null,
        summary: {
          totalProjects: 10_000,
          matchedProjects: 0,
          activeProjects: 8_000,
          archivedProjects: 2_000,
          totalRegistry: 10_000
        },
        stats: {
          durationMs: 1,
          responseBytes: 256,
          projectRows: 0,
          registryRows: 0,
          cancelled: false
        }
      }
    })
    await expect(second).resolves.toMatchObject({ summary: { totalProjects: 10_000 } })
    clearInterval(ticker)
    await client.close()
  })

  it("makes project-context lookups latest-wins in the same renderer scope", async () => {
    const worker = new FakeCatalogWorker()
    const client = new HarnessCatalogClient(async () => worker as unknown as Worker)
    const first = client.readProjectContexts(["old"], "renderer:detail")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = client.readProjectContexts(["new"], "renderer:detail")
    await expect(first).rejects.toBeInstanceOf(HarnessCatalogCancelledError)

    const request = worker.requests.at(-1)!
    worker.emit("message", {
      type: "read-project-contexts-result",
      requestId: request.requestId,
      ok: true,
      result: {
        projects: { new: null },
        stats: { durationMs: 1, responseBytes: 64, projectRows: 0, cancelled: false }
      }
    })
    await expect(second).resolves.toMatchObject({ projects: { new: null } })
    await client.close()
  })

  it("cancels dialog tips A when the same renderer lane switches to B", async () => {
    const worker = new FakeCatalogWorker()
    const client = new HarnessCatalogClient(async () => worker as unknown as Worker)
    const scope = "harness-dialog-tips:7"
    const first = client.readDialogTips("project-a", "feature-a", scope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const firstRequest = worker.requests[0]!
    const second = client.readDialogTips("project-b", "feature-b", scope)

    await expect(first).rejects.toBeInstanceOf(HarnessCatalogCancelledError)
    expect(Atomics.load(new Int32Array(firstRequest.cancelBuffer as SharedArrayBuffer), 0)).toBe(1)

    const secondRequest = worker.requests[1]!
    worker.emit("message", {
      type: "read-dialog-tips-result",
      requestId: secondRequest.requestId,
      ok: true,
      result: {
        tips: "feature-b tips",
        stats: { durationMs: 1, responseBytes: 64, cancelled: false }
      }
    })
    await expect(second).resolves.toMatchObject({ tips: "feature-b tips" })
    await client.close()
  })

  it("keeps interleaved batch and single detail lanes independent", async () => {
    const worker = new FakeCatalogWorker()
    const client = new HarnessCatalogClient(async () => worker as unknown as Worker)
    const batchScope = "harness-project-detail:7:batch:context"
    const singleScope = "harness-project-detail:7:single:context"

    const firstBatch = client.readProjectContexts(["batch-1"], batchScope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveProjectContexts(worker, 0, "batch-1")
    await expect(firstBatch).resolves.toMatchObject({ projects: { "batch-1": null } })

    const single = client.readProjectContexts(["single"], singleScope)
    const nextBatch = client.readProjectContexts(["batch-2"], batchScope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveProjectContexts(worker, 1, "single")
    resolveProjectContexts(worker, 2, "batch-2")

    await expect(single).resolves.toMatchObject({ projects: { single: null } })
    await expect(nextBatch).resolves.toMatchObject({ projects: { "batch-2": null } })
    await client.close()
  })

  it("restarts project-context reads after a worker crash", async () => {
    const firstWorker = new FakeCatalogWorker()
    const replacement = new FakeCatalogWorker()
    let starts = 0
    const client = new HarnessCatalogClient(async () => {
      starts += 1
      return (starts === 1 ? firstWorker : replacement) as unknown as Worker
    })

    const crashed = client.readProjectContexts(["first"], "renderer:detail")
    await new Promise((resolve) => setTimeout(resolve, 0))
    firstWorker.emit("error", new Error("intentional catalog crash"))
    await expect(crashed).rejects.toThrow("intentional catalog crash")

    const retried = client.readProjectContexts(["second"], "renderer:detail")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const request = replacement.requests.at(-1)!
    replacement.emit("message", {
      type: "read-project-contexts-result",
      requestId: request.requestId,
      ok: true,
      result: {
        projects: { second: null },
        stats: { durationMs: 1, responseBytes: 64, projectRows: 0, cancelled: false }
      }
    })
    await expect(retried).resolves.toMatchObject({ projects: { second: null } })
    expect(starts).toBe(2)
    await client.close()
  })

  it("terminates a worker that finishes starting during shutdown", async () => {
    const worker = new FakeCatalogWorker()
    let resolveWorker!: (worker: Worker) => void
    const workerStarting = new Promise<Worker>((resolve) => {
      resolveWorker = resolve
    })
    const client = new HarnessCatalogClient(() => workerStarting)
    const pending = client.readProjectContexts(["project"], "renderer:detail")
    await new Promise((resolve) => setTimeout(resolve, 0))

    const closing = client.close()
    resolveWorker(worker as unknown as Worker)

    await closing
    await expect(pending).rejects.toThrow("closing")
    expect(worker.terminateCalls).toBe(1)
  })
})
