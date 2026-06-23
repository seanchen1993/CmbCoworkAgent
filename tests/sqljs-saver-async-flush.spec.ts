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

import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"

type AnyConfig = { configurable: { thread_id: string; checkpoint_ns: string; checkpoint_id?: string } }

let counter = 0
function makeCheckpoint(id: string): any {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_values: { value: id },
    channel_versions: { value: ++counter },
    versions_seen: {},
    pending_sends: []
  }
}

function config(threadId: string, checkpointId?: string): AnyConfig {
  return { configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId } }
}

async function putCheckpoint(saver: SqlJsSaver, threadId: string, id: string): Promise<void> {
  await saver.put(config(threadId) as any, makeCheckpoint(id), { source: "input", step: 0, writes: {}, parents: {} } as any)
}

async function readBackLatestId(dbPath: string, threadId: string): Promise<string | undefined> {
  const reopened = new SqlJsSaver(dbPath)
  const tuple = await reopened.getTuple(config(threadId) as any)
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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sqljs-saver-flush-"))
  try {
    await testFlushBeforeDebounce(dir)
    await testCloseWhileSaveInFlight(dir)
    await testAsyncDebouncedPersist(dir)
    console.log("sqljs-saver async/flush tests passed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
