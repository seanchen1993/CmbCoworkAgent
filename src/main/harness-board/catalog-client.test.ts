import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({ root: "" }))
vi.mock("../storage", () => ({ getOpenworkDir: () => storage.root }))
beforeEach(async () => {
  storage.root = await mkdtemp(join(tmpdir(), "harness-catalog-client-"))
})
afterEach(async () => {
  try {
    // Read-only client tests must not initialize or migrate any stores.
    expect(await readdir(storage.root)).toEqual([])
  } finally {
    await rm(storage.root, { recursive: true, force: true })
  }
})
import { HarnessCatalogCancelledError, HarnessCatalogClient } from "./catalog-client"

class FakeCatalogWorker extends EventEmitter {
  readonly requests: Array<Record<string, unknown>> = []
  terminateCalls = 0

  postMessage(message: Record<string, unknown>): void {
    this.requests.push(message)
  }

  async waitForRequests(count: number): Promise<void> {
    await vi.waitFor(() => expect(this.requests).toHaveLength(count))
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

    await worker.waitForRequests(2)
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
    await worker.waitForRequests(1)
    const second = client.readProjectContexts(["new"], "renderer:detail")
    await expect(first).rejects.toBeInstanceOf(HarnessCatalogCancelledError)

    await worker.waitForRequests(2)
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
    await worker.waitForRequests(1)
    const firstRequest = worker.requests[0]!
    const second = client.readDialogTips("project-b", "feature-b", scope)

    await expect(first).rejects.toBeInstanceOf(HarnessCatalogCancelledError)
    expect(Atomics.load(new Int32Array(firstRequest.cancelBuffer as SharedArrayBuffer), 0)).toBe(1)

    await worker.waitForRequests(2)
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
    await worker.waitForRequests(1)
    resolveProjectContexts(worker, 0, "batch-1")
    await expect(firstBatch).resolves.toMatchObject({ projects: { "batch-1": null } })

    const single = client.readProjectContexts(["single"], singleScope)
    const nextBatch = client.readProjectContexts(["batch-2"], batchScope)
    await worker.waitForRequests(3)
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
    await firstWorker.waitForRequests(1)
    firstWorker.emit("error", new Error("intentional catalog crash"))
    await expect(crashed).rejects.toThrow("intentional catalog crash")

    const retried = client.readProjectContexts(["second"], "renderer:detail")
    await replacement.waitForRequests(1)
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

  it("preserves structured context-integrity error codes across the worker boundary", async () => {
    const worker = new FakeCatalogWorker()
    const client = new HarnessCatalogClient(async () => worker as unknown as Worker)
    const pending = client.readProjectContexts(["project"], "renderer:integrity")
    await worker.waitForRequests(1)
    const request = worker.requests.at(-1)!

    worker.emit("message", {
      type: "read-project-contexts-result",
      requestId: request.requestId,
      ok: false,
      error: {
        code: "HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED",
        message: "Harness context is incomplete",
        stack: "worker stack"
      }
    })

    await expect(pending).rejects.toMatchObject({
      code: "HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED",
      message: "Harness context is incomplete",
      stack: "worker stack"
    })
    await client.close()
  })

  it("rejects pending work on a clean unexpected exit and restarts", async () => {
    const firstWorker = new FakeCatalogWorker()
    const replacement = new FakeCatalogWorker()
    let starts = 0
    const client = new HarnessCatalogClient(async () => {
      starts += 1
      return (starts === 1 ? firstWorker : replacement) as unknown as Worker
    })

    const exited = client.readProjectContexts(["first"], "renderer:clean-exit")
    await firstWorker.waitForRequests(1)
    firstWorker.emit("exit", 0)
    await expect(exited).rejects.toThrow("exited: 0")

    const retried = client.readProjectContexts(["second"], "renderer:clean-exit")
    await replacement.waitForRequests(1)
    resolveProjectContexts(replacement, 0, "second")
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
    const startWorker = vi.fn(() => workerStarting)
    const client = new HarnessCatalogClient(startWorker)
    const pending = client.readProjectContexts(["project"], "renderer:detail")
    await vi.waitFor(() => expect(startWorker).toHaveBeenCalledOnce())

    const closing = client.close()
    resolveWorker(worker as unknown as Worker)

    await closing
    await expect(pending).rejects.toThrow("closing")
    expect(worker.terminateCalls).toBe(1)
  })
})
