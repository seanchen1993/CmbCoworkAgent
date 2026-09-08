import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Worker as WorkerType } from "node:worker_threads"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { MemoryFilesPage } from "../../shared/memory-catalog"
import {
  MEMORY_CATALOG_MAX_ACTIVE_SCOPES,
  MEMORY_CATALOG_WORKER_RESOURCE_LIMITS,
  MemoryCatalogClient,
  MemoryCatalogRequestCancelledError,
  MemoryCatalogWorkerUnavailableError
} from "./client"
import {
  MEMORY_CATALOG_MAX_RESPONSE_BYTES,
  type MemoryCatalogSource
} from "./protocol"

const clients: MemoryCatalogClient[] = []
const temporaryDirectories: string[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "memory-catalog-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "memory-catalog-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./memory-catalog-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
  rmSync(workerBuildDirectory, { recursive: true, force: true })
}, 60_000)

function sourceAt(root: string): MemoryCatalogSource {
  return {
    memoryRootDir: root,
    globalMemoryDir: join(root, "global"),
    projectsMemoryDir: join(root, "projects"),
    memorySettingsPath: join(root, "memory-settings.json")
  }
}

function track(client: MemoryCatalogClient): MemoryCatalogClient {
  clients.push(client)
  return client
}

async function waitForRequests(worker: FakeMemoryWorker, count: number): Promise<void> {
  for (let attempt = 0; attempt < 30 && worker.requests.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(worker.requests).toHaveLength(count)
}

function emptyFilesPage(memoryDir = "C:\\memory"): MemoryFilesPage {
  return {
    items: [],
    hasMore: false,
    totalCount: 0,
    truncated: false,
    truncatedReasons: [],
    scanStats: { scannedEntries: 0, scannedFiles: 0, readBytes: 0 },
    stats: {
      fileCount: 0,
      totalSize: 0,
      indexSize: 0,
      enabled: true,
      dreamEnabled: false,
      dreamState: { lastRunAt: 0, sessionsSinceLastRun: 0 },
      scope: "global",
      memoryDir
    }
  }
}

describe("MemoryCatalogClient", () => {
  it("bounds its heap/scopes and treats a clean early exit as a recoverable failure", async () => {
    expect(MEMORY_CATALOG_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(192)
    const workers = [new FakeMemoryWorker(), new FakeMemoryWorker()]
    let starts = 0
    const source = sourceAt("C:\\memory")
    const client = track(
      new MemoryCatalogClient(
        async () => workers[starts++] as unknown as WorkerType,
        () => source
      )
    )
    const input = {
      kind: "files" as const,
      scope: "global" as const,
      memoryDir: source.globalMemoryDir
    }
    const first = client.read(input, "clean-exit")
    await waitForRequests(workers[0], 1)
    workers[0].emit("exit", 0)
    await expect(first).rejects.toBeInstanceOf(MemoryCatalogWorkerUnavailableError)

    const replacement = client.read(input, "replacement")
    await waitForRequests(workers[1], 1)
    workers[1].emit("message", {
      type: "read-result",
      requestId: workers[1].requests[0].requestId,
      ok: true,
      result: emptyFilesPage()
    })
    await expect(replacement).resolves.toMatchObject({ items: [] })

    const pressure = Array.from({ length: MEMORY_CATALOG_MAX_ACTIVE_SCOPES }, (_, index) =>
      client.read(input, `scope:${index}`).catch((error) => error)
    )
    await expect(client.read(input, "scope:overflow")).rejects.toThrow("capacity exceeded")
    await client.close()
    await Promise.all(pressure)
  })

  it("cleans latest/pending state when postMessage throws synchronously", async () => {
    const worker = new FakeMemoryWorker()
    const source = sourceAt("C:\\memory")
    const client = track(
      new MemoryCatalogClient(async () => worker as unknown as WorkerType, () => source)
    )
    const input = {
      kind: "files" as const,
      scope: "global" as const,
      memoryDir: source.globalMemoryDir
    }
    worker.postError = new Error("dispatch failed")
    await expect(client.read(input, "same-scope")).rejects.toThrow("dispatch failed")
    worker.postError = null
    const retry = client.read(input, "same-scope")
    await waitForRequests(worker, 1)
    worker.emit("message", {
      type: "read-result",
      requestId: worker.requests[0].requestId,
      ok: true,
      result: emptyFilesPage()
    })
    await expect(retry).resolves.toMatchObject({ items: [] })
  })

  it("does not dispatch a Worker that finishes starting after close", async () => {
    let finishStart: ((worker: WorkerType) => void) | undefined
    const starting = new Promise<WorkerType>((resolve) => {
      finishStart = resolve
    })
    const worker = new FakeMemoryWorker()
    const source = sourceAt("C:\\memory")
    const client = track(new MemoryCatalogClient(() => starting, () => source))
    const read = client.read(
      { kind: "files", scope: "global", memoryDir: source.globalMemoryDir },
      "close-during-start"
    )

    await client.close()
    finishStart?.(worker as unknown as WorkerType)

    await expect(read).rejects.toBeInstanceOf(MemoryCatalogWorkerUnavailableError)
    expect(worker.requests).toHaveLength(0)
  })

  it("enforces A to B to C latest-wins and unmount cancellation", async () => {
    const worker = new FakeMemoryWorker()
    const source = sourceAt("C:\\memory")
    const client = track(
      new MemoryCatalogClient(async () => worker as unknown as WorkerType, () => source)
    )
    const input = {
      kind: "files" as const,
      scope: "global" as const,
      memoryDir: source.globalMemoryDir
    }

    const a = client.read(input, "renderer:files").catch((error) => error)
    await waitForRequests(worker, 1)
    const b = client.read(input, "renderer:files").catch((error) => error)
    await waitForRequests(worker, 2)
    const c = client.read(input, "renderer:files")
    await waitForRequests(worker, 3)

    await expect(a).resolves.toBeInstanceOf(MemoryCatalogRequestCancelledError)
    await expect(b).resolves.toBeInstanceOf(MemoryCatalogRequestCancelledError)
    expect(Atomics.load(new Int32Array(worker.requests[0].cancelBuffer), 0)).toBe(1)
    expect(Atomics.load(new Int32Array(worker.requests[1].cancelBuffer), 0)).toBe(1)
    worker.emit("message", {
      type: "read-result",
      requestId: worker.requests[2].requestId,
      ok: true,
      result: emptyFilesPage(source.globalMemoryDir)
    })
    await expect(c).resolves.toMatchObject({ items: [], hasMore: false })

    const unmounted = client.read(input, "renderer:unmount").catch((error) => error)
    await waitForRequests(worker, 4)
    client.cancelScope("renderer:unmount")
    await expect(unmounted).resolves.toBeInstanceOf(MemoryCatalogRequestCancelledError)
    expect(Atomics.load(new Int32Array(worker.requests[3].cancelBuffer), 0)).toBe(1)
  })

  it(
    "scans 20k files off-main while the event-loop ticker advances and pages stay bounded",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "memory-catalog-large-"))
      temporaryDirectories.push(root)
      const source = sourceAt(root)
      mkdirSync(source.globalMemoryDir, { recursive: true })
      mkdirSync(source.projectsMemoryDir, { recursive: true })
      for (let index = 0; index < 20_000; index += 1) {
        writeFileSync(
          join(source.globalMemoryDir, `memory-${index.toString().padStart(5, "0")}.md`),
          ""
        )
      }
      const client = track(
        new MemoryCatalogClient(
          async () => new Worker(workerBundlePath, { name: "memory-catalog-test" }),
          () => source
        )
      )
      let ticks = 0
      const ticker = setInterval(() => {
        ticks += 1
      }, 1)
      const first = await client.read(
        {
          kind: "files",
          scope: "global",
          memoryDir: source.globalMemoryDir,
          limit: 128
        },
        "renderer:large"
      )
      clearInterval(ticker)
      if (!("items" in first) || !("stats" in first)) throw new Error("expected files page")

      expect(ticks).toBeGreaterThan(5)
      expect(first.items).toHaveLength(128)
      expect(first.totalCount).toBe(20_000)
      expect(first.hasMore).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(first), "utf-8")).toBeLessThanOrEqual(
        MEMORY_CATALOG_MAX_RESPONSE_BYTES
      )
    },
    180_000
  )
})

interface FakeRequest {
  requestId: number
  cancelBuffer: SharedArrayBuffer
}

class FakeMemoryWorker extends EventEmitter {
  readonly requests: FakeRequest[] = []
  postError: Error | null = null

  postMessage(message: FakeRequest): void {
    if (this.postError) throw this.postError
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}
