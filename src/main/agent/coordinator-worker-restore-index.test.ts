import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Worker } from "node:worker_threads"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildLegacyCoordinatorWorkerRestoreIndex,
  COORDINATOR_WORKER_RESTORE_MAX_WAITERS,
  COORDINATOR_WORKER_RESTORE_MAX_WORKERS,
  COORDINATOR_WORKER_RESTORE_WORKER_RESOURCE_LIMITS,
  COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT,
  COORDINATOR_WORKER_RESTORE_INDEX_FILENAME,
  COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES,
  COORDINATOR_WORKER_RESTORE_STATE_MAX_BYTES,
  COORDINATOR_WORKER_RESTORE_STORE_MAX_OPERATIONS_PER_DIRECTORY,
  CoordinatorWorkerRestoreIndexStore
} from "./coordinator-worker-restore-index"
import {
  CoordinatorWorkerManager,
  MAX_COORDINATOR_UNRESOLVED_WORKERS,
  type CoordinatorWorkerSnapshot
} from "./coordinator-worker-manager"

const THREAD_ID = "thread-restore-index-load"
const HISTORY_SIZE = 10_000
let workspacePath = ""
let workersDir = ""

function workerId(index: number): string {
  return `implementer-${1_800_000_000_000 + index}-1`
}

function stateJson(
  id: string,
  status: "running" | "completed" = "completed",
  acknowledged = true
): string {
  return JSON.stringify({
    status,
    ...(status === "running" ? {} : { notification_acknowledged: acknowledged }),
    worker_id: id,
    worker_thread_id: `${THREAD_ID}__worker__${id}`,
    parent_thread_id: THREAD_ID,
    role: "implementer",
    workload: "read_only",
    owned_files: [],
    description: id,
    turns: 1,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    tool_call_count: 0,
    last_event: status === "running" ? "Worker running." : "Worker completed."
  })
}

beforeAll(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), "coordinator-restore-index-"))
  workersDir = path.join(workspacePath, ".cmbdevclaw", "coordinator", THREAD_ID, "workers")
  await mkdir(workersDir, { recursive: true })
  for (let offset = 0; offset < HISTORY_SIZE; offset += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, HISTORY_SIZE - offset) }, (_, batchIndex) => {
        const id = workerId(offset + batchIndex)
        return writeFile(path.join(workersDir, `${id}.json`), stateJson(id), "utf8")
      })
    )
  }
}, 120_000)

afterAll(async () => {
  await rm(workspacePath, { recursive: true, force: true })
}, 120_000)

describe("coordinator worker restore index", () => {
  it("bounds restore worker heaps, concurrent scans, and queued directory inputs", async () => {
    expect(COORDINATOR_WORKER_RESTORE_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(64)
    const workers: FakeRestoreWorker[] = []
    const workerFactory = async (): Promise<Worker> => {
      const worker = new FakeRestoreWorker()
      workers.push(worker)
      return worker as unknown as Worker
    }
    const controllers = Array.from(
      { length: COORDINATOR_WORKER_RESTORE_MAX_WORKERS + COORDINATOR_WORKER_RESTORE_MAX_WAITERS },
      () => new AbortController()
    )
    const retained = controllers.map((controller, index) =>
      buildLegacyCoordinatorWorkerRestoreIndex(
        path.join(workersDir, `queued-${index}`),
        controller.signal,
        workerFactory
      ).catch((error) => error)
    )
    await Promise.resolve()
    expect(workers).toHaveLength(COORDINATOR_WORKER_RESTORE_MAX_WORKERS)
    await expect(
      buildLegacyCoordinatorWorkerRestoreIndex("overflow", undefined, workerFactory)
    ).rejects.toThrow("capacity exceeded")
    for (const controller of controllers) controller.abort()
    await Promise.all(retained)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
  })

  it("hard-bounds queued state writes per directory and oversized retained input", async () => {
    const queueDirectory = path.join(workspacePath, "queue-pressure", "workers")
    await mkdir(queueDirectory, { recursive: true })
    const store = new CoordinatorWorkerRestoreIndexStore()
    const writes = Array.from(
      { length: COORDINATOR_WORKER_RESTORE_STORE_MAX_OPERATIONS_PER_DIRECTORY },
      (_, index) => {
        const id = `implementer-${1_900_000_000_000 + index}-1`
        return store.writeWorkerState(path.join(queueDirectory, `${id}.json`), "{}", {
          worker_id: id,
          status: "completed",
          notification_acknowledged: true,
          updated_at: "2026-08-26T00:00:00.000Z"
        })
      }
    )
    const overflowId = "implementer-1900000009999-1"
    await expect(
      store.writeWorkerState(path.join(queueDirectory, `${overflowId}.json`), "{}", {
        worker_id: overflowId,
        status: "completed",
        notification_acknowledged: true,
        updated_at: "2026-08-26T00:00:00.000Z"
      })
    ).rejects.toThrow(/capacity exceeded/)
    await Promise.all(writes)
    await store.waitForIdle(queueDirectory)
    expect(store.isIdle(queueDirectory)).toBe(true)

    await expect(
      store.writeWorkerState(
        path.join(queueDirectory, "oversized.json"),
        "x".repeat(COORDINATOR_WORKER_RESTORE_STATE_MAX_BYTES + 1),
        {
          worker_id: "implementer-1900000010000-1",
          status: "completed",
          notification_acknowledged: true,
          updated_at: "2026-08-26T00:00:00.000Z"
        }
      )
    ).rejects.toThrow(/hard persistence byte budget/)
    await expect(store.loadCandidates("x".repeat(32_769), "active")).rejects.toThrow(
      /path exceeds its hard limit/
    )
  })

  it("migrates 10k legacy states off-thread with a hard-bounded response", async () => {
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const result = await buildLegacyCoordinatorWorkerRestoreIndex(workersDir)
    clearInterval(ticker)

    expect(ticks).toBeGreaterThan(5)
    expect(result.stats.directory_entries).toBe(HISTORY_SIZE)
    expect(result.stats.candidate_files).toBe(HISTORY_SIZE)
    expect(result.stats.prefix_reads).toBe(HISTORY_SIZE)
    expect(result.index.entries).toHaveLength(COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT)
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result }), "utf8")).toBeLessThanOrEqual(
      COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES
    )
  }, 120_000)

  it("uses the persisted hot index after restart without another directory scan", async () => {
    const firstStore = new CoordinatorWorkerRestoreIndexStore()
    const firstCandidates = await firstStore.loadCandidates(workersDir, "recent")
    expect(firstCandidates.entries).toHaveLength(COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT)

    let workerStarts = 0
    const restartedStore = new CoordinatorWorkerRestoreIndexStore(async () => {
      workerStarts += 1
      throw new Error("The hot index must avoid a legacy directory scan")
    })
    const restartedCandidates = await restartedStore.loadCandidates(workersDir, "recent")
    expect(workerStarts).toBe(0)
    expect(restartedCandidates.entries).toHaveLength(COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT)
    expect(
      await stat(path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME))
    ).toMatchObject({
      size: expect.any(Number)
    })
    expect(
      (await stat(path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME))).size
    ).toBeLessThanOrEqual(COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES)
  }, 120_000)

  it("keeps creation, status updates, acknowledgement, and restart reads consistent", async () => {
    const id = `implementer-${Date.now() + 20_000}-1`
    const statePath = path.join(workersDir, `${id}.json`)
    const store = new CoordinatorWorkerRestoreIndexStore()
    await store.writeWorkerState(statePath, stateJson(id, "running"), {
      worker_id: id,
      status: "running",
      updated_at: new Date(Date.now() + 20_000).toISOString()
    })

    const restartedWhileRunning = new CoordinatorWorkerRestoreIndexStore()
    expect(
      (await restartedWhileRunning.loadCandidates(workersDir, "active")).entries.map(
        (entry) => entry.worker_id
      )
    ).toContain(id)

    await store.writeWorkerState(statePath, stateJson(id, "completed", false), {
      worker_id: id,
      status: "completed",
      notification_acknowledged: false,
      updated_at: new Date(Date.now() + 21_000).toISOString()
    })
    expect(
      (
        await new CoordinatorWorkerRestoreIndexStore().loadCandidates(workersDir, "active")
      ).entries.map((entry) => entry.worker_id)
    ).toContain(id)

    await store.writeWorkerState(statePath, stateJson(id, "completed", true), {
      worker_id: id,
      status: "completed",
      notification_acknowledged: true,
      updated_at: new Date(Date.now() + 22_000).toISOString()
    })
    const acknowledgedRestart = new CoordinatorWorkerRestoreIndexStore()
    expect(
      (await acknowledgedRestart.loadCandidates(workersDir, "active")).entries.map(
        (entry) => entry.worker_id
      )
    ).not.toContain(id)
    expect(
      (await acknowledgedRestart.loadCandidates(workersDir, "recent")).entries.map(
        (entry) => entry.worker_id
      )
    ).toContain(id)

    const persisted = JSON.parse(
      await readFile(path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME), "utf8")
    ) as { entries: unknown[] }
    expect(persisted.entries.length).toBeLessThanOrEqual(COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT)
  }, 120_000)

  it("drains successor index writes queued while the current tail settles", async () => {
    const store = new CoordinatorWorkerRestoreIndexStore()
    const firstId = `implementer-${Date.now() + 30_000}-1`
    const secondId = `implementer-${Date.now() + 30_001}-1`
    const first = store.writeWorkerState(
      path.join(workersDir, `${firstId}.json`),
      stateJson(firstId, "completed", true),
      {
        worker_id: firstId,
        status: "completed",
        notification_acknowledged: true,
        updated_at: new Date(Date.now() + 30_000).toISOString()
      }
    )
    let successorSettled = false
    const successor = first
      .then(() =>
        store.writeWorkerState(
          path.join(workersDir, `${secondId}.json`),
          stateJson(secondId, "completed", true),
          {
            worker_id: secondId,
            status: "completed",
            notification_acknowledged: true,
            updated_at: new Date(Date.now() + 30_001).toISOString()
          }
        )
      )
      .then(() => {
        successorSettled = true
      })

    await store.waitForIdle(workersDir)
    expect(successorSettled).toBe(true)
    await successor
  })

  it("tombstones a hung old directory incarnation before same-thread recreation", async () => {
    const incarnationDirectory = path.join(workspacePath, "incarnation-recreate", "workers")
    let blockedIncarnationId = -1
    let releaseOldWrite = (): void => undefined
    let markOldWriteEntered = (): void => undefined
    const oldWriteEntered = new Promise<void>((resolve) => {
      markOldWriteEntered = resolve
    })
    const oldWriteGate = new Promise<void>((resolve) => {
      releaseOldWrite = resolve
    })
    class PausedRestoreIndexStore extends CoordinatorWorkerRestoreIndexStore {
      protected override async beforeWriteWorkerState(
        _statePath: string,
        incarnation?: { id: number }
      ): Promise<void> {
        if (incarnation?.id !== blockedIncarnationId) return
        markOldWriteEntered()
        await oldWriteGate
      }
    }
    const store = new PausedRestoreIndexStore()
    const oldIncarnation = store.createDirectoryIncarnation(incarnationDirectory)
    blockedIncarnationId = oldIncarnation.id
    const oldId = "implementer-2000000000000-1"
    const oldWrite = store.writeWorkerState(
      path.join(incarnationDirectory, `${oldId}.json`),
      stateJson(oldId),
      {
        worker_id: oldId,
        status: "completed",
        notification_acknowledged: true,
        updated_at: "2026-08-26T00:00:00.000Z"
      },
      oldIncarnation
    )
    await oldWriteEntered

    const deletion = store.deleteDirectoryIncarnation(oldIncarnation, () =>
      rm(incarnationDirectory, { recursive: true, force: true })
    )
    const newIncarnation = store.createDirectoryIncarnation(incarnationDirectory)
    const newId = "implementer-2000000000001-1"
    const newWrite = store.writeWorkerState(
      path.join(incarnationDirectory, `${newId}.json`),
      stateJson(newId),
      {
        worker_id: newId,
        status: "completed",
        notification_acknowledged: true,
        updated_at: "2026-08-26T00:00:01.000Z"
      },
      newIncarnation
    )

    releaseOldWrite()
    await expect(oldWrite).rejects.toMatchObject({ name: "AbortError" })
    await deletion
    await newWrite
    await store.waitForIdle(incarnationDirectory)
    await expect(readFile(path.join(incarnationDirectory, `${oldId}.json`), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" })
    expect(await readFile(path.join(incarnationDirectory, `${newId}.json`), "utf8")).toBe(
      stateJson(newId)
    )
    const persistedIndex = JSON.parse(
      await readFile(
        path.join(incarnationDirectory, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME),
        "utf8"
      )
    ) as { entries: Array<{ worker_id: string }> }
    expect(persistedIndex.entries.map((entry) => entry.worker_id)).toEqual([newId])
  })

  it("does not let late terminal persistence recreate deleted same-thread artifacts", async () => {
    const fixedThreadId = "thread-incarnation-terminal-recreate"
    const coordinatorRoot = path.join(
      workspacePath,
      ".cmbdevclaw",
      "coordinator",
      fixedThreadId
    )
    let oldIncarnationId = -1
    let oldWriteCount = 0
    let releaseOldTerminalState = (): void => undefined
    let markOldTerminalStateEntered = (): void => undefined
    const oldTerminalStateEntered = new Promise<void>((resolve) => {
      markOldTerminalStateEntered = resolve
    })
    const oldTerminalStateGate = new Promise<void>((resolve) => {
      releaseOldTerminalState = resolve
    })
    class PausedTerminalStore extends CoordinatorWorkerRestoreIndexStore {
      override createDirectoryIncarnation(directory: string) {
        const incarnation = super.createDirectoryIncarnation(directory)
        if (oldIncarnationId < 0) oldIncarnationId = incarnation.id
        return incarnation
      }

      protected override async beforeWriteWorkerState(
        _statePath: string,
        incarnation?: { id: number }
      ): Promise<void> {
        if (incarnation?.id !== oldIncarnationId) return
        oldWriteCount += 1
        if (oldWriteCount !== 2) return
        markOldTerminalStateEntered()
        await oldTerminalStateGate
      }
    }
    const store = new PausedTerminalStore()
    const manager = new CoordinatorWorkerManager({ restoreIndexStore: store })
    const oldWorker = manager.startWorker({
      parentThreadId: fixedThreadId,
      workspacePath,
      role: "implementer",
      workload: "read_only",
      description: "old generation",
      prompt: "finish old generation",
      runner: async () => ({ summary: "old terminal result" })
    })
    await oldTerminalStateEntered
    expect(
      await readFile(
        path.join(
          coordinatorRoot,
          "reports",
          "workers",
          oldWorker.worker_id,
          "turn-1.json"
        ),
        "utf8"
      )
    ).toContain("old terminal result")

    const deletion = manager.forgetThreadAndDeleteArtifacts(fixedThreadId, workspacePath)
    let markNewTerminalPersisted: (worker: CoordinatorWorkerSnapshot) => void =
      () => undefined
    const newTerminalPersisted = new Promise<CoordinatorWorkerSnapshot>((resolve) => {
      markNewTerminalPersisted = resolve
    })
    const newWorker = manager.startWorker({
      parentThreadId: fixedThreadId,
      workspacePath,
      role: "implementer",
      workload: "read_only",
      description: "new generation",
      prompt: "finish new generation",
      runner: async () => ({ summary: "new terminal result" }),
      onUpdate: ({ worker }) => {
        if (worker.status === "completed" || worker.status === "failed") {
          markNewTerminalPersisted(worker)
        }
      }
    })
    await expect(readFile(path.join(coordinatorRoot, "workers", `${newWorker.worker_id}.json`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
    releaseOldTerminalState()
    await deletion
    const newStatePath = path.join(
      coordinatorRoot,
      "workers",
      `${newWorker.worker_id}.json`
    )
    const newResultPath = path.join(
      coordinatorRoot,
      "reports",
      "workers",
      newWorker.worker_id,
      "turn-1.json"
    )
    const persistedWorker = await newTerminalPersisted
    expect(persistedWorker.status).toBe("completed")
    const newState = await readFile(newStatePath, "utf8")
    const newResult = await readFile(newResultPath, "utf8")
    expect(newState).toContain('"status": "completed"')
    expect(newResult).toContain("new terminal result")

    await store.waitForIdle(path.join(coordinatorRoot, "workers"))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(
      readFile(path.join(coordinatorRoot, "workers", `${oldWorker.worker_id}.json`), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      readFile(
        path.join(
          coordinatorRoot,
          "reports",
          "workers",
          oldWorker.worker_id,
          "turn-1.json"
        ),
        "utf8"
      )
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      await readFile(newStatePath, "utf8")
    ).toContain("new generation")
    expect(
      await readFile(newResultPath, "utf8")
    ).toContain("new terminal result")
    expect((await stat(path.join(coordinatorRoot, "scratchpad"))).isDirectory()).toBe(true)
    const persistedIndex = JSON.parse(
      await readFile(
        path.join(coordinatorRoot, "workers", COORDINATOR_WORKER_RESTORE_INDEX_FILENAME),
        "utf8"
      )
    ) as { entries: Array<{ worker_id: string }> }
    expect(persistedIndex.entries.map((entry) => entry.worker_id)).toEqual([
      newWorker.worker_id
    ])
    manager.clear()
  })

  it("does not recreate a deleted directory from a late secondary-index rebuild", async () => {
    const rebuildDirectory = path.join(workspacePath, "late-index-rebuild", "workers")
    await mkdir(rebuildDirectory, { recursive: true })
    let markPosted = (): void => undefined
    const posted = new Promise<void>((resolve) => {
      markPosted = resolve
    })
    class DelayedRestoreWorker extends FakeRestoreWorker {
      override postMessage(): void {
        markPosted()
      }
    }
    const delayedWorker = new DelayedRestoreWorker()
    const store = new CoordinatorWorkerRestoreIndexStore(
      async () => delayedWorker as unknown as Worker
    )
    const incarnation = store.createDirectoryIncarnation(rebuildDirectory)
    const restore = store.loadCandidates(
      rebuildDirectory,
      "recent",
      undefined,
      incarnation
    )
    await posted
    store.tombstoneDirectoryIncarnation(incarnation)
    await rm(rebuildDirectory, { recursive: true, force: true })
    delayedWorker.emit("message", {
      ok: true,
      result: {
        index: { version: 1, complete: true, overflow: false, entries: [] },
        stats: {
          directory_entries: 0,
          candidate_files: 0,
          prefix_reads: 0,
          response_bytes: 0
        }
      }
    })
    await expect(restore).rejects.toMatchObject({ name: "AbortError" })
    await expect(stat(rebuildDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps a failed deletion poisoned instead of mixing a revived incarnation", async () => {
    const poisonedDirectory = path.join(workspacePath, "failed-delete-poison", "workers")
    await mkdir(poisonedDirectory, { recursive: true })
    await writeFile(path.join(poisonedDirectory, "old.json"), "old", "utf8")
    const store = new CoordinatorWorkerRestoreIndexStore()
    const oldIncarnation = store.createDirectoryIncarnation(poisonedDirectory)
    const deletionError = new Error("simulated rm failure")
    await expect(
      store.deleteDirectoryIncarnation(oldIncarnation, async () => {
        throw deletionError
      })
    ).rejects.toBe(deletionError)

    const revivedIncarnation = store.createDirectoryIncarnation(poisonedDirectory)
    const revivedId = "implementer-2000000000002-1"
    await expect(
      store.writeWorkerState(
        path.join(poisonedDirectory, `${revivedId}.json`),
        stateJson(revivedId),
        {
          worker_id: revivedId,
          status: "completed",
          notification_acknowledged: true,
          updated_at: "2026-08-26T00:00:02.000Z"
        },
        revivedIncarnation
      )
    ).rejects.toBe(deletionError)
    expect(await readFile(path.join(poisonedDirectory, "old.json"), "utf8")).toBe("old")
    await expect(
      readFile(path.join(poisonedDirectory, `${revivedId}.json`), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })

    await store.deleteDirectoryIncarnation(oldIncarnation, () =>
      rm(poisonedDirectory, { recursive: true, force: true })
    )
    await expect(
      store.writeWorkerState(
        path.join(poisonedDirectory, `${revivedId}.json`),
        stateJson(revivedId),
        {
          worker_id: revivedId,
          status: "completed",
          notification_acknowledged: true,
          updated_at: "2026-08-26T00:00:02.000Z"
        },
        revivedIncarnation
      )
    ).rejects.toBe(deletionError)

    const freshIncarnation = store.createDirectoryIncarnation(poisonedDirectory)
    const freshId = "implementer-2000000000003-1"
    await store.writeWorkerState(
      path.join(poisonedDirectory, `${freshId}.json`),
      stateJson(freshId),
      {
        worker_id: freshId,
        status: "completed",
        notification_acknowledged: true,
        updated_at: "2026-08-26T00:00:03.000Z"
      },
      freshIncarnation
    )
    expect(await readFile(path.join(poisonedDirectory, `${freshId}.json`), "utf8")).toBe(
      stateJson(freshId)
    )
  })

  it("uses the manager's known workspace when deletion input omits the path", async () => {
    const fixedThreadId = "thread-known-workspace-delete"
    const coordinatorRoot = path.join(
      workspacePath,
      ".cmbdevclaw",
      "coordinator",
      fixedThreadId
    )
    const manager = new CoordinatorWorkerManager()
    const worker = manager.startWorker({
      parentThreadId: fixedThreadId,
      workspacePath,
      role: "implementer",
      workload: "read_only",
      description: "known workspace deletion",
      prompt: "finish",
      runner: async () => ({ summary: "done" })
    })
    await manager.waitForTerminalPersistence(fixedThreadId, [worker.worker_id])
    expect((await stat(coordinatorRoot)).isDirectory()).toBe(true)
    await manager.forgetThreadAndDeleteArtifacts(fixedThreadId)
    await expect(stat(coordinatorRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("pages overflowed unresolved history without silently dropping worker notifications", async () => {
    const unresolvedIds = Array.from(
      { length: MAX_COORDINATOR_UNRESOLVED_WORKERS + 5 },
      (_, index) => workerId(HISTORY_SIZE - 1 - index)
    )
    await Promise.all(
      unresolvedIds.map((id) =>
        writeFile(path.join(workersDir, `${id}.json`), stateJson(id, "completed", false), "utf8")
      )
    )
    await rm(path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME), { force: true })

    const manager = new CoordinatorWorkerManager()
    await manager.restoreWorkersForThread({
      parentThreadId: THREAD_ID,
      workspacePath,
      mode: "active"
    })
    const firstPage = manager
      .readWorkers(THREAD_ID)
      .filter((worker) => worker.notification_acknowledged === false)
    expect(firstPage).toHaveLength(MAX_COORDINATOR_UNRESOLVED_WORKERS)
    expect(() =>
      manager.startWorker({
        parentThreadId: THREAD_ID,
        workspacePath,
        role: "implementer",
        workload: "read_only",
        description: "must wait for overflow notifications",
        prompt: "do not start",
        runner: async () => ({ summary: "unexpected" })
      })
    ).toThrow(/awaiting acknowledgement/i)

    await manager.acknowledgeNotifications(
      THREAD_ID,
      firstPage.map((worker) => worker.worker_id)
    )
    const secondPage = manager
      .readWorkers(THREAD_ID)
      .filter((worker) => worker.notification_acknowledged === false)
    expect(secondPage).toHaveLength(5)
    expect(secondPage.every((worker) => unresolvedIds.includes(worker.worker_id))).toBe(true)

    const restarted = new CoordinatorWorkerManager()
    await restarted.restoreWorkersForThread({
      parentThreadId: THREAD_ID,
      workspacePath,
      mode: "active"
    })
    expect(
      restarted
        .readWorkers(THREAD_ID)
        .filter((worker) => worker.notification_acknowledged === false)
    ).toHaveLength(5)
  }, 120_000)

  it("pages unresolved state hydration by a hard aggregate byte budget", async () => {
    const largeIds = Array.from(
      { length: 12 },
      (_, index) => `implementer-${1_900_000_000_000 + index}-1`
    )
    await Promise.all(
      largeIds.map((id) => {
        const state = JSON.parse(stateJson(id, "completed", false)) as Record<string, unknown>
        state.description = `large-${id}-${"x".repeat(400_000)}`
        return writeFile(path.join(workersDir, `${id}.json`), JSON.stringify(state), "utf8")
      })
    )
    await rm(path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME), { force: true })

    const manager = new CoordinatorWorkerManager()
    await manager.restoreWorkersForThread({
      parentThreadId: THREAD_ID,
      workspacePath,
      mode: "active"
    })
    const firstPage = manager
      .readWorkers(THREAD_ID)
      .filter((worker) => worker.notification_acknowledged === false)
    const totalUnresolved = largeIds.length + 5
    expect(firstPage.length).toBeGreaterThan(0)
    expect(firstPage.length).toBeLessThan(totalUnresolved)

    await manager.acknowledgeNotifications(
      THREAD_ID,
      firstPage.map((worker) => worker.worker_id)
    )
    expect(
      manager
        .readWorkers(THREAD_ID)
        .filter((worker) => worker.notification_acknowledged === false)
    ).toHaveLength(totalUnresolved - firstPage.length)
  }, 120_000)

  it("cancels an obsolete migration and lets the queued winner rebuild", async () => {
    await rm(path.join(workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME), { force: true })
    const store = new CoordinatorWorkerRestoreIndexStore()
    const obsoleteController = new AbortController()
    const obsolete = store.loadCandidates(workersDir, "recent", obsoleteController.signal)
    setTimeout(() => {
      obsoleteController.abort(new DOMException("Superseded by thread C", "AbortError"))
    }, 1)

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" })
    const winner = await store.loadCandidates(workersDir, "recent")
    expect(winner.entries).toHaveLength(COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT)
  }, 120_000)
})

class FakeRestoreWorker extends EventEmitter {
  terminated = false

  postMessage(): void {
    return undefined
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}
