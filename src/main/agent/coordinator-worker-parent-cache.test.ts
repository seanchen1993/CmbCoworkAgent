import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CoordinatorWorkerManager,
  MAX_COORDINATOR_ACTIVE_RESTORES,
  MAX_COORDINATOR_IDLE_PARENTS_IN_MEMORY,
  MAX_COORDINATOR_RESTORE_WAITERS,
  type CoordinatorWorkerRunResult
} from "./coordinator-worker-manager"
import { CoordinatorWorkerRestoreIndexStore } from "./coordinator-worker-restore-index"

class ProbeRestoreIndexStore extends CoordinatorWorkerRestoreIndexStore {
  readonly loadCounts = new Map<string, number>()

  override async loadCandidates(workersDir: string): Promise<{ entries: []; overflow: false }> {
    this.loadCounts.set(workersDir, (this.loadCounts.get(workersDir) ?? 0) + 1)
    return { entries: [], overflow: false }
  }

  override async writeWorkerState(): Promise<boolean> {
    return true
  }

  override isIdle(): boolean {
    return true
  }

  override async waitForIdle(): Promise<void> {
    return undefined
  }
}

function workersDirectory(workspacePath: string, threadId: string): string {
  return path.join(workspacePath, ".cmbdevclaw", "coordinator", threadId, "workers")
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class BlockingProbeRestoreIndexStore extends ProbeRestoreIndexStore {
  readonly gate = deferred<void>()
  entered = 0

  override async loadCandidates(workersDir: string): Promise<{ entries: []; overflow: false }> {
    this.entered += 1
    await this.gate.promise
    return super.loadCandidates(workersDir)
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("coordinator worker parent cache", () => {
  it("hard-bounds active restores and retained waiters across many parents", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "coordinator-restore-pressure-"))
    temporaryDirectories.push(workspacePath)
    const store = new BlockingProbeRestoreIndexStore()
    const manager = new CoordinatorWorkerManager({ restoreIndexStore: store })
    const admitted = MAX_COORDINATOR_ACTIVE_RESTORES + MAX_COORDINATOR_RESTORE_WAITERS
    const restores = Array.from({ length: admitted }, (_, index) =>
      manager.restoreWorkersForThread({
        parentThreadId: `restore-pressure-${index}`,
        workspacePath,
        mode: "active"
      })
    )

    await vi.waitFor(() => expect(store.entered).toBe(MAX_COORDINATOR_ACTIVE_RESTORES))
    await expect(
      manager.restoreWorkersForThread({
        parentThreadId: "restore-pressure-overflow",
        workspacePath,
        mode: "active"
      })
    ).rejects.toThrow(/capacity exceeded/)

    store.gate.resolve(undefined)
    await expect(Promise.all(restores)).resolves.toHaveLength(admitted)
  })

  it("evicts the least-recently-used idle parent and rehydrates it on demand", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "coordinator-parent-lru-"))
    temporaryDirectories.push(workspacePath)
    const store = new ProbeRestoreIndexStore()
    const manager = new CoordinatorWorkerManager({ restoreIndexStore: store })
    const parentCount = MAX_COORDINATOR_IDLE_PARENTS_IN_MEMORY + 5

    for (let index = 0; index < parentCount; index += 1) {
      await manager.restoreWorkersForThread({
        parentThreadId: `idle-parent-${index}`,
        workspacePath,
        mode: "active"
      })
    }

    const oldestDir = workersDirectory(workspacePath, "idle-parent-0")
    const newestDir = workersDirectory(workspacePath, `idle-parent-${parentCount - 1}`)
    expect(store.loadCounts.get(oldestDir)).toBe(1)
    expect(store.loadCounts.get(newestDir)).toBe(1)

    await manager.restoreWorkersForThread({
      parentThreadId: "idle-parent-0",
      workspacePath,
      mode: "active"
    })
    expect(store.loadCounts.get(oldestDir)).toBe(2)

    await manager.restoreWorkersForThread({
      parentThreadId: `idle-parent-${parentCount - 1}`,
      workspacePath,
      mode: "active"
    })
    expect(store.loadCounts.get(newestDir)).toBe(1)
  })

  it("never evicts running or unacknowledged parents under idle-parent pressure", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "coordinator-parent-protected-"))
    temporaryDirectories.push(workspacePath)
    const store = new ProbeRestoreIndexStore()
    const manager = new CoordinatorWorkerManager({ restoreIndexStore: store })
    const run = deferred<CoordinatorWorkerRunResult>()
    const runnerStarted = deferred<void>()
    const started = manager.startWorker({
      parentThreadId: "protected-parent",
      workspacePath,
      role: "implementer",
      workload: "read_only",
      description: "protected parent",
      prompt: "wait",
      runner: async () => {
        runnerStarted.resolve(undefined)
        return run.promise
      }
    })
    await runnerStarted.promise

    for (let index = 0; index < MAX_COORDINATOR_IDLE_PARENTS_IN_MEMORY + 5; index += 1) {
      await manager.restoreWorkersForThread({
        parentThreadId: `pressure-running-${index}`,
        workspacePath,
        mode: "active"
      })
    }
    expect(manager.readWorkers("protected-parent")).toEqual([
      expect.objectContaining({ worker_id: started.worker_id, status: "running" })
    ])

    run.resolve({ summary: "done", rawText: "done" })
    await manager.waitForWorkers("protected-parent", {
      workerId: started.worker_id,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      waitForCleanup: true
    })
    await vi.waitFor(() => expect(manager.hasNotifications("protected-parent")).toBe(true))

    for (let index = 0; index < MAX_COORDINATOR_IDLE_PARENTS_IN_MEMORY + 5; index += 1) {
      await manager.restoreWorkersForThread({
        parentThreadId: `pressure-unacknowledged-${index}`,
        workspacePath,
        mode: "active"
      })
    }
    expect(manager.readWorkers("protected-parent")).toEqual([
      expect.objectContaining({
        worker_id: started.worker_id,
        status: "completed",
        notification_acknowledged: false
      })
    ])
    expect(manager.peekNotifications("protected-parent")).not.toHaveLength(0)
    manager.clear()
  })
})
