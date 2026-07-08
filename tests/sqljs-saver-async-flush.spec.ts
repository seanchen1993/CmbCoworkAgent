/**
 * Regression tests for the async/atomic save + flush race handling in
 * SqlJsSaver (perf/p0-batch2). Verifies that a checkpoint persists across a
 * reopen for each ordering of save vs. flush:
 *   1. flush() before the debounce timer fires (synchronous write path)
 *   2. flush()/close() while an async save is in flight (drain, no clobber)
 *   3. data written, left for the debounce to flush asynchronously
 *
 * Run:
 *   npx tsx tests/sqljs-saver-async-flush.spec.ts
 */

import { mkdtemp, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"

let counter = 0
function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_values: { value: id },
    channel_versions: { value: ++counter },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

function config(threadId: string, checkpointId?: string): RunnableConfig {
  return { configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId } }
}

async function putCheckpoint(saver: SqlJsSaver, threadId: string, id: string): Promise<void> {
  const metadata = {
    source: "input",
    step: 0,
    writes: {},
    parents: {}
  } as CheckpointMetadata
  await saver.put(config(threadId), makeCheckpoint(id), metadata)
}

async function readBackLatestId(dbPath: string, threadId: string): Promise<string | undefined> {
  const reopened = new SqlJsSaver(dbPath)
  const tuple = await reopened.getTuple(config(threadId))
  await reopened.close()
  return tuple?.checkpoint?.id as string | undefined
}

async function testFlushBeforeDebounce(dir: string): Promise<void> {
  const dbPath = join(dir, "before-debounce.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  // No wait: debounce (300ms) has NOT fired, so flush takes the synchronous path.
  await saver.flush()
  await saver.close()

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-1", `expected cp-1 persisted via sync flush, got ${id}`)
  console.log("PASS flush before debounce persists synchronously")
}

async function testCloseWhileSaveInFlight(dir: string): Promise<void> {
  const dbPath = join(dir, "in-flight.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  // Let the debounce timer fire so an async save loop starts and is mid-write.
  await new Promise((r) => setTimeout(r, 320))
  // Now write a NEWER checkpoint and immediately close (flush drains the
  // in-flight save, then writes the authoritative latest snapshot).
  await putCheckpoint(saver, "t1", "cp-2")
  await saver.close()

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-2", `expected cp-2 (no stale clobber from in-flight save), got ${id}`)
  console.log("PASS close while save in flight keeps the latest snapshot")
}

async function testAsyncDebouncedPersist(dir: string): Promise<void> {
  const dbPath = join(dir, "async.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  // Wait past the debounce so the async atomic write completes on its own,
  // WITHOUT calling flush/close.
  await new Promise((r) => setTimeout(r, 450))

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-1", `expected cp-1 persisted by async debounced save, got ${id}`)
  await saver.close()
  console.log("PASS async debounced save persists without flush")
}

async function testFlushRemainsReusable(dir: string): Promise<void> {
  const dbPath = join(dir, "flush-reuse.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  await saver.flush()
  await putCheckpoint(saver, "t1", "cp-2")
  await Promise.all([saver.flush(), saver.flush()])
  await saver.close()

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-2", `expected cp-2 after a second flush, got ${id}`)
  console.log("PASS flush remains reusable and coalesces concurrent callers")
}

async function testRecoverFromBackupWhenLiveFileIsCorrupt(dir: string): Promise<void> {
  const dbPath = join(dir, "corrupt-live.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  await saver.flush()
  await saver.close()

  await writeFile(dbPath, Buffer.from("not a sqlite database"))

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-1", `expected cp-1 recovered from backup after live corruption, got ${id}`)

  const files = await readdir(dir)
  assert(
    files.some((file) => file.startsWith("corrupt-live.sqlite.corrupt.")),
    "corrupt live database should be archived for diagnosis"
  )
  console.log("PASS corrupt live database recovers from .bak")
}

async function testRecoverFromNewerTempSnapshot(dir: string): Promise<void> {
  const dbPath = join(dir, "newer-temp.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  await saver.flush()
  await saver.close()

  // Simulate a power loss after a newer snapshot reached the temp file but
  // before it was renamed over the live DB.
  await new Promise((r) => setTimeout(r, 20))
  const tempSaver = new SqlJsSaver(`${dbPath}.tmp`)
  await putCheckpoint(tempSaver, "t1", "cp-2")
  await tempSaver.flush()
  await tempSaver.close()

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-2", `expected cp-2 recovered from newer temp snapshot, got ${id}`)
  console.log("PASS newer temp snapshot wins over older live database")
}

async function testRetirePoisonsLateWriters(dir: string): Promise<void> {
  const dbPath = join(dir, "retire.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  await saver.flush()

  // A newer mutation is still pending (debounce not fired) when the thread is
  // deleted: retire must not flush it — the file is about to be swept.
  await putCheckpoint(saver, "t1", "cp-2")
  await saver.retire()
  for (const suffix of ["", ".bak", ".tmp"]) {
    await rm(`${dbPath}${suffix}`, { force: true })
  }

  // A writer that outlived deletion holds this reference: unlike close(), a
  // retired saver must refuse to re-initialize instead of resurrecting the file.
  let lateWriteRefused = false
  try {
    await putCheckpoint(saver, "t1", "cp-3")
  } catch {
    lateWriteRefused = true
  }
  assert(lateWriteRefused, "late put on a retired saver must be refused")

  await saver.flush() // must be a silent no-op, not a write
  await new Promise((r) => setTimeout(r, 450)) // past any debounced save
  const resurrected = (await readdir(dir)).filter((file) => file.startsWith("retire.sqlite"))
  assert(
    resurrected.length === 0,
    `retired saver resurrected its file(s): ${resurrected.join(", ")}`
  )
  console.log("PASS retire poisons late writers; nothing resurrects the deleted file")
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sqljs-saver-flush-"))
  try {
    await testFlushBeforeDebounce(dir)
    await testCloseWhileSaveInFlight(dir)
    await testAsyncDebouncedPersist(dir)
    await testFlushRemainsReusable(dir)
    await testRecoverFromBackupWhenLiveFileIsCorrupt(dir)
    await testRecoverFromNewerTempSnapshot(dir)
    await testRetirePoisonsLateWriters(dir)
    console.log("sqljs-saver async/flush tests passed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
