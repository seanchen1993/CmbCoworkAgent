import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { CoordinatorWorkerRestoreIndexStore, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME } from "./coordinator-worker-restore-index"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coordinator-source-index-"))
  const database = new DatabaseSync(join(root, "actual.sqlite"))
  cleanup.push(async () => { database.close(); await rm(root, { recursive: true, force: true }) })
  database.exec("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  const metadata = (token: string) => JSON.stringify({ cmb_thread_incarnation: token })
  database.prepare("INSERT INTO threads VALUES('parent',1,?)").run(metadata("original"))
  const readRow = () => database.prepare("SELECT created_at,metadata FROM threads WHERE thread_id='parent'")
    .get() as { created_at: number; metadata: string }
  const incarnation = captureThreadIncarnation(readRow())
  const assertCurrent = () => {
    if (!matchesThreadIncarnation(readRow(), incarnation))
      throw new DOMException("Original database row replaced", "AbortError")
  }
  const workersDir = join(root, "workers")
  await mkdir(workersDir)
  return { workersDir, assertCurrent,
    replace: () => database.prepare("UPDATE threads SET metadata=? WHERE thread_id='parent'").run(metadata("replacement")) }
}

describe("coordinator restore index original host source", () => {
  it("does not publish a queued old state or remove a new index after actual row replacement", async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    class HeldStore extends CoordinatorWorkerRestoreIndexStore {
      protected override async beforeWriteWorkerState(): Promise<void> { entered(); await held }
    }
    const store = new HeldStore(), directory = store.createDirectoryIncarnation(f.workersDir)
    const statePath = join(f.workersDir, "implementer-10000-1.json")
    const indexPath = join(f.workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME)
    const currentState = '{"owner":"current"}', currentIndex = '{"version":1,"complete":true,"overflow":false,"entries":[]}'
    await writeFile(statePath, currentState)
    await writeFile(indexPath, currentIndex)
    const pending = store.writeWorkerState(statePath, '{"owner":"old"}', {
      worker_id: "implementer-10000-1", status: "completed", notification_acknowledged: false,
      updated_at: "2026-04-29T00:00:00.000Z"
    }, directory, f.assertCurrent)
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    try { await started; f.replace() } finally { release() }
    await rejected
    expect(directory.valid).toBe(true)
    expect(await readFile(statePath, "utf8")).toBe(currentState)
    expect(await readFile(indexPath, "utf8")).toBe(currentIndex)
  })

  it("does not publish a rebuilt index for an original row replaced during the scan", async () => {
    const f = await fixture()
    let posted!: () => void
    const started = new Promise<void>(resolve => { posted = resolve })
    class HeldWorker extends EventEmitter {
      postMessage(): void { posted() }
      unref(): this { return this }
      terminate(): Promise<number> { return Promise.resolve(0) }
    }
    // A controlled scan response positions the race; actual native row reads, store queue,
    // source checks and atomic index publication are production code, not a Worker E2E claim.
    const worker = new HeldWorker()
    const store = new CoordinatorWorkerRestoreIndexStore(async () => worker as unknown as Worker)
    const directory = store.createDirectoryIncarnation(f.workersDir)
    const pending = store.loadCandidates(f.workersDir, "recent", undefined, directory, f.assertCurrent)
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await started
    f.replace()
    worker.emit("message", { ok: true, result: {
      index: { version: 1, complete: true, overflow: false, entries: [] },
      stats: { directory_entries: 0, candidate_files: 0, prefix_reads: 0, response_bytes: 0 }
    } })
    await rejected
    expect(directory.valid).toBe(true)
    await expect(stat(join(f.workersDir, COORDINATOR_WORKER_RESTORE_INDEX_FILENAME)))
      .rejects.toMatchObject({ code: "ENOENT" })
  })
})
