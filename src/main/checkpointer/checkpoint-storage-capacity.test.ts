import { setupRealCheckpointStorageWorkerFixture } from "../../../tests/support/checkpoint-storage-real-worker"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it, vi } from "vitest"
import { SqlJsSaver } from "./sqljs-saver"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"

const actual = setupRealCheckpointStorageWorkerFixture()
const tick = () => new Promise<void>(done => setImmediate(done))

it("bounds actual live maintenance Workers at 2 plus 16 waiters, and drains close/retire physically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-storage-capacity-"))
  const savers: SqlJsSaver[] = [], pending: Array<Promise<unknown>> = []
  const acquire = vi.spyOn(BoundedWorkerAdmission.prototype, "acquire")
  const start = () => {
    const path = join(directory, `original-${savers.length}.sqlite`), database = new DatabaseSync(path)
    database.exec(`CREATE TABLE checkpoints(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,type TEXT,checkpoint TEXT,metadata TEXT,
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
      INSERT INTO checkpoints VALUES('original','','old',NULL,'json','{}','{}')`)
    database.close()
    const saver = new SqlJsSaver(path)
    savers.push(saver)
    const outcome = saver.initialize().then(() => "initialized", error => error)
    pending.push(outcome)
    return { saver, outcome }
  }
  actual.holdAfterAck = true
  try {
    const first = start(), second = start()
    await vi.waitFor(() => expect(actual.controls.filter(control => control.acknowledged)).toHaveLength(2),
      { timeout: 2000, interval: 10 })
    expect(actual.entered).toHaveLength(2)
    expect(actual.exited).toBe(0)
    const queued = Array.from({ length: 16 }, start)
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(18))
    const overflow = start()
    expect(await overflow.outcome).toMatchObject({ name: "CHECKPOINT_STORAGE_BUSY" })
    expect(actual.entered).toHaveLength(2)

    await queued[0].saver.close()
    expect(await queued[0].outcome).toMatchObject({ message: "SQLJS_SAVER_CLOSING" })
    expect(actual.entered).toHaveLength(2)
    const replacementWaiter = start()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(20))
    expect(actual.entered).toHaveLength(2)

    let closed = false, retired = false
    const closing = first.saver.close().then(() => { closed = true })
    const retiring = second.saver.retire().then(() => { retired = true })
    await tick()
    expect(closed).toBe(false)
    expect(retired).toBe(false)
    const queuedClosings = [...queued.slice(1), replacementWaiter].map(item => item.saver.close())
    await Promise.all(queuedClosings)
    expect(actual.entered).toHaveLength(2)
    expect(actual.exited).toBe(0)
    // The extra interval is test-only. Both real schema ACKs have already closed SQLite;
    // physical thread credit must still wait for the actual native exit events.
    await Promise.all(actual.controls.map(control => control.worker.terminate()))
    await Promise.all([closing, retiring])
    expect(await first.outcome).toMatchObject({ name: "CHECKPOINT_STORAGE_MAINTENANCE_FAILED" })
    expect(await second.outcome).toMatchObject({ name: "CHECKPOINT_STORAGE_MAINTENANCE_FAILED" })
    await Promise.all(pending)
    expect(actual.exited).toBe(2)
    expect(closed).toBe(true)
    expect(retired).toBe(true)
    await expect(second.saver.initialize()).rejects.toThrow("retired")
  } finally {
    actual.holdAfterAck = false
    const closing = savers.map(saver => saver.close())
    await Promise.all(actual.controls.map(control => control.worker.terminate()))
    await Promise.allSettled([...pending, ...closing])
    acquire.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
