import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildLegacyCoordinatorWorkerRestoreIndex,
  COORDINATOR_WORKER_RESTORE_ENTRY_LIMIT,
  COORDINATOR_WORKER_RESTORE_INDEX_FILENAME,
  COORDINATOR_WORKER_RESTORE_INDEX_MAX_BYTES,
  CoordinatorWorkerRestoreIndexStore
} from "./coordinator-worker-restore-index"
import {
  CoordinatorWorkerManager,
  MAX_COORDINATOR_UNRESOLVED_WORKERS
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
