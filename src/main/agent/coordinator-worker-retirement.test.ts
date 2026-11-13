import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CoordinatorWorkerManager } from "./coordinator-worker-manager"
import { CoordinatorWorkerRestoreIndexStore,
  COORDINATOR_WORKER_RESTORE_MAX_DIRECTORY_DELETIONS } from "./coordinator-worker-restore-index"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coordinator-captured-retirement-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new CoordinatorWorkerRestoreIndexStore()
  const directory = join(root, "workers")
  return { root, store, directory, incarnation: store.createDirectoryIncarnation(directory) }
}

describe("captured coordinator directory retirement", () => {
  it("reserves capacity before commit without invalidating or touching the old source", async () => {
    const f = await fixture(), remove = vi.fn(async () => {})
    const prepared = f.store.prepareDirectoryRetirement(f.incarnation, remove)
    expect(f.incarnation.valid).toBe(true)
    await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" })
    prepared.abort()
    expect(f.incarnation.valid).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    expect(() => prepared.activate()).toThrow("expired")
    const retry = f.store.prepareDirectoryRetirement(f.incarnation, remove)
    await retry.activate().finalize()
    expect(remove).toHaveBeenCalledOnce()
  })

  it("rejects a full reservation set before commit and returns aborted capacity", async () => {
    const f = await fixture()
    const prepared = Array.from({ length: COORDINATOR_WORKER_RESTORE_MAX_DIRECTORY_DELETIONS },
      (_, index) => f.store.prepareDirectoryRetirement(
        f.store.createDirectoryIncarnation(join(f.root, `slot-${index}`)), async () => {}))
    try {
      expect(() => f.store.prepareDirectoryRetirement(f.incarnation, async () => {}))
        .toThrow("capacity exceeded")
      expect(f.incarnation.valid).toBe(true)
      prepared.pop()!.abort()
      const admitted = f.store.prepareDirectoryRetirement(f.incarnation, async () => {})
      admitted.abort()
    } finally { for (const item of prepared) item.abort() }
  })

  it("does not let the old deletion API bypass a prepared or failed captured retirement", async () => {
    const f = await fixture(), remove = vi.fn(async () => {})
    const prepared = f.store.prepareDirectoryRetirement(f.incarnation, remove)
    expect(() => f.store.deleteDirectoryIncarnation(f.incarnation, remove)).toThrow("busy")
    expect(f.incarnation.valid).toBe(true)
    prepared.abort()
    const failing = f.store.prepareDirectoryRetirement(f.incarnation, async () => {
      throw Error("Captured cleanup remains unavailable")
    }).activate()
    await expect(failing.finalize()).rejects.toThrow("unavailable")
    const replacement = f.store.createDirectoryIncarnation(f.directory)
    expect(() => f.store.deleteDirectoryIncarnation(replacement, remove)).toThrow("busy")
    expect(f.store.deleteDirectoryIncarnation(f.incarnation, remove)).toBe(failing.completion)
    expect(remove).not.toHaveBeenCalled()
  })

  it("holds a new incarnation behind both old physical operations and captured cleanup", async () => {
    const f = await fixture(), entered = deferred(), oldWrite = deferred(), permit = deferred()
    const physical = f.store.runDirectoryArtifactOperation(f.incarnation, async () => {
      entered.resolve(); await oldWrite.promise
    })
    await entered.promise
    const remove = vi.fn(async () => { await permit.promise })
    const active = f.store.prepareDirectoryRetirement(f.incarnation, remove).activate()
    const shared = f.store.prepareDirectoryRetirement(f.incarnation, async () => {
      throw Error("A duplicate handle must not replace captured cleanup")
    }).activate()
    expect(shared).toBe(active)
    const replacement = f.store.createDirectoryIncarnation(f.directory)
    let started = false
    const next = f.store.runDirectoryArtifactOperation(replacement, async () => { started = true })
    const finalized = active.finalize()
    expect(active.finalize()).toBe(finalized)
    expect(() => f.store.prepareDirectoryRetirement(replacement, async () => {})).toThrow("busy")
    try {
      await Promise.resolve()
      expect(started).toBe(false)
      expect(remove).not.toHaveBeenCalled()
      oldWrite.resolve()
      await physical
      await active.oldPhysicalDrained
      await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
      expect(started).toBe(false)
    } finally { oldWrite.resolve(); permit.resolve() }
    await finalized
    await next
    expect(started).toBe(true)
    expect(replacement.valid).toBe(true)
  })

  it("does not release a failed cleanup barrier and retries only its original closure", async () => {
    const f = await fixture(), failure = Error("old path temporarily unavailable")
    const remove = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const active = f.store.prepareDirectoryRetirement(f.incarnation, remove).activate()
    await expect(active.finalize()).rejects.toBe(failure)
    const replacement = f.store.createDirectoryIncarnation(f.directory)
    let released = false
    void replacement.ready.then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    await active.finalize()
    await replacement.ready
    expect(remove).toHaveBeenCalledTimes(2)
    expect(released).toBe(true)
  })

  it("does not clear replacement records or files after a synchronous prepare/activate ABA", async () => {
    const f = await fixture(), manager = new CoordinatorWorkerManager({ restoreIndexStore: f.store })
    const workersDir = join(f.root, ".cmbdevclaw/coordinator/parent/workers")
    await mkdir(workersDir, { recursive: true })
    const snapshot = (id: string) => JSON.stringify({ worker_id: id,
      worker_thread_id: `parent__worker__${id}`, parent_thread_id: "parent", role: "implementer",
      description: id, status: "completed", turns: 1, created_at: "2026-04-29T00:00:00.000Z",
      updated_at: "2026-04-29T00:00:00.000Z", last_event: "Worker completed.",
      notification_acknowledged: true })
    const oldPath = join(workersDir, "implementer-10000-1.json")
    await writeFile(oldPath, snapshot("implementer-10000-1"))
    await manager.restoreWorkersForThread({ parentThreadId: "parent", workspacePath: f.root, mode: "full" })
    const prepared = manager.prepareThreadRetirement("parent", f.root)
    manager.forgetThread("parent")
    await rm(oldPath)
    const newPath = join(workersDir, "implementer-20000-1.json")
    const newBytes = snapshot("implementer-20000-1")
    await writeFile(newPath, newBytes)
    await manager.restoreWorkersForThread({ parentThreadId: "parent", workspacePath: f.root, mode: "full" })
    const active = prepared.activate()
    await expect(active.finalize()).rejects.toThrow("source changed")
    expect(manager.readWorkers("parent").map(row => row.worker_id)).toEqual(["implementer-20000-1"])
    expect(await readFile(newPath, "utf8")).toBe(newBytes)
    manager.clear()
  })

  it("cancels a full restore waiting on cleanup without reading old files or releasing its barrier", async () => {
    const f = await fixture(), manager = new CoordinatorWorkerManager({ restoreIndexStore: f.store })
    await manager.restoreWorkersForThread({ parentThreadId: "parent", workspacePath: f.root, mode: "full" })
    const active = manager.prepareThreadRetirement("parent", f.root).activate()
    const controller = new AbortController()
    const pending = manager.restoreWorkersForThread({ parentThreadId: "parent", workspacePath: f.root,
      mode: "full", signal: controller.signal })
    const outcome = pending.then(() => undefined, error => error as unknown)
    await Promise.resolve()
    controller.abort(new DOMException("Obsolete restore", "AbortError"))
    expect(await outcome).toMatchObject({ name: "AbortError" })
    let barrierReleased = false
    void active.completion.then(() => { barrierReleased = true })
    await Promise.resolve()
    expect(barrierReleased).toBe(false)
    await active.finalize()
    expect(await manager.restoreWorkersForThread({ parentThreadId: "parent", workspacePath: f.root,
      mode: "full" })).toEqual([])
    manager.clear()
  })
})
