/**
 * Regression tests for native SQLite WAL durability, explicit checkpoints,
 * recovery candidates, retention and close/retire race handling.
 *
 * Run:
 *   npx tsx tests/sqljs-saver-async-flush.spec.ts
 */

import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import assert from "assert"
import initSqlJs from "sql.js"
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

function config(threadId: string, checkpointId?: string, checkpointNs = ""): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId }
  }
}

async function putCheckpoint(
  saver: SqlJsSaver,
  threadId: string,
  id: string,
  checkpointNs = "",
  parentCheckpointId?: string
): Promise<void> {
  const metadata = {
    source: "input",
    step: 0,
    writes: {},
    parents: {}
  } as CheckpointMetadata
  await saver.put(config(threadId, parentCheckpointId, checkpointNs), makeCheckpoint(id), metadata)
}

async function putForkBoundaryCheckpoint(
  saver: SqlJsSaver,
  threadId: string,
  id: string,
  parentCheckpointId?: string
): Promise<void> {
  const metadata = {
    source: "loop",
    step: 1,
    writes: {},
    parents: {},
    cmb_fork_boundary: {
      version: 1,
      kind: "turn_complete",
      boundaryId: `turn_complete:${threadId}:${id}`,
      completedAt: new Date().toISOString(),
      source: "agent_run_complete"
    }
  } as CheckpointMetadata
  await saver.put(config(threadId, parentCheckpointId), makeCheckpoint(id), metadata)
}

async function readBackLatestId(
  dbPath: string,
  threadId: string,
  checkpointNs = ""
): Promise<string | undefined> {
  const reopened = new SqlJsSaver(dbPath)
  const tuple = await reopened.getTuple(config(threadId, undefined, checkpointNs))
  await reopened.close()
  return tuple?.checkpoint?.id as string | undefined
}

async function testFlushBeforeDebounce(dir: string): Promise<void> {
  const dbPath = join(dir, "before-debounce.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  // A FULL WAL checkpoint must preserve the already-committed mutation.
  await saver.flush()
  await saver.close()

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-1", `expected cp-1 persisted via sync flush, got ${id}`)
  console.log("PASS explicit WAL checkpoint preserves committed data")
}

async function testCloseWhileSaveInFlight(dir: string): Promise<void> {
  const dbPath = join(dir, "in-flight.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  // Waiting no longer schedules a whole-database export; a later mutation must
  // remain authoritative when close performs its final checkpoint.
  await new Promise((r) => setTimeout(r, 320))
  await putCheckpoint(saver, "t1", "cp-2")
  await saver.close()

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-2", `expected cp-2 (no stale clobber from in-flight save), got ${id}`)
  console.log("PASS close checkpoints the latest committed mutation")
}

async function testAsyncDebouncedPersist(dir: string): Promise<void> {
  const dbPath = join(dir, "async.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  // WAL commits are durable without waiting for the former export debounce.
  await new Promise((r) => setTimeout(r, 450))

  const id = await readBackLatestId(dbPath, "t1")
  assert(id === "cp-1", `expected cp-1 persisted by async debounced save, got ${id}`)
  await saver.close()
  console.log("PASS WAL commit is visible without export or explicit flush")
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

async function testWalWritesAvoidWholeDatabaseSnapshots(dir: string): Promise<void> {
  const dbPath = join(dir, "wal-no-export.sqlite")
  const saver = new SqlJsSaver(dbPath)
  const largeValue = "x".repeat(2 * 1024 * 1024)
  for (let index = 1; index <= 4; index += 1) {
    const checkpoint = makeCheckpoint(`wal-${index}`)
    ;(checkpoint.channel_values as Record<string, unknown>).largeValue = `${index}:${largeValue}`
    await saver.put(
      config("t-wal-no-export", index > 1 ? `wal-${index - 1}` : undefined),
      checkpoint,
      {
        source: "input",
        step: index,
        writes: {},
        parents: {}
      } as CheckpointMetadata
    )
  }
  await saver.flushStrict()

  const openFiles = (await readdir(dir)).filter((file) => file.startsWith("wal-no-export.sqlite"))
  assert(
    !openFiles.some((file) => /\.(?:tmp|bak)(?:\.|$)/.test(file)),
    `WAL writes unexpectedly created a full snapshot candidate: ${openFiles.join(", ")}`
  )
  await saver.close()
  console.log("PASS large checkpoint updates avoid whole-database snapshot files")
}

async function testForkBoundaryByteBudgetIncludesExternalMessages(dir: string): Promise<void> {
  const dbPath = join(dir, "fork-boundary-external-bytes.sqlite")
  const threadId = "t-fork-boundary-external-bytes"
  const saver = new SqlJsSaver(dbPath, undefined, {
    maxRootCheckpoints: 1,
    maxRootForkBoundaryCheckpoints: 10,
    maxRootForkBoundaryBytes: 1_024
  })
  let parentCheckpointId: string | undefined
  for (let index = 1; index <= 3; index += 1) {
    const checkpoint = makeCheckpoint(`boundary-bytes-${index}`)
    ;(checkpoint.channel_values as Record<string, unknown>).messages = [
      { id: `message-${index}`, type: "ai", content: "m".repeat(4_096) }
    ]
    await saver.put(
      config(threadId, parentCheckpointId),
      checkpoint,
      {
        source: "loop",
        step: index,
        writes: {},
        parents: {},
        cmb_fork_boundary: {
          version: 1,
          kind: "turn_complete",
          boundaryId: `turn_complete:${threadId}:${index}`,
          completedAt: new Date().toISOString(),
          source: "agent_run_complete"
        }
      } as CheckpointMetadata
    )
    parentCheckpointId = checkpoint.id
  }

  const retainedIds: string[] = []
  for await (const tuple of saver.list(config(threadId))) retainedIds.push(tuple.checkpoint.id)
  await saver.close()

  assert.deepEqual(
    retainedIds,
    ["boundary-bytes-3"],
    "external transcript bytes must remain part of the fork-boundary retention budget"
  )
  console.log("PASS fork boundary byte budget includes external transcript snapshots")
}

async function testFlushStrictReportsPersistenceFailure(dir: string): Promise<void> {
  const dbPath = join(dir, "strict-checkpoint-failure.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t-strict", "strict-1")

  const target = saver as unknown as {
    db: { flush: (mode?: "FULL" | "TRUNCATE") => void } | null
  }
  const database = target.db
  assert(database, "native database should be initialized")
  const originalFlush = database.flush.bind(database)
  database.flush = () => {
    throw new Error("injected WAL checkpoint failure")
  }

  let failed = false
  const originalWarn = console.warn
  try {
    console.warn = () => undefined
    await saver.flushStrict()
  } catch {
    failed = true
  } finally {
    console.warn = originalWarn
    database.flush = originalFlush
    await saver.close()
  }

  assert(failed, "flushStrict should reject when the checkpoint file cannot be persisted")
  console.log("PASS flushStrict reports checkpoint persistence failures")
}

async function testConcurrentFlushStrictSerializesWithClose(dir: string): Promise<void> {
  const dbPath = join(dir, "strict-concurrent.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t-strict-concurrent", "strict-cp-1")
  await Promise.all([saver.flushStrict(), saver.flushStrict()])

  await putCheckpoint(saver, "t-strict-concurrent", "strict-cp-2")
  await Promise.all([saver.flushStrict(), saver.close()])

  const id = await readBackLatestId(dbPath, "t-strict-concurrent")
  assert(
    id === "strict-cp-2",
    `expected strict-cp-2 after concurrent strict flush/close, got ${id}`
  )
  console.log("PASS concurrent flushStrict calls serialize with close")
}

async function testMutationBurstSurvivesConcurrentFlushStrictStorm(dir: string): Promise<void> {
  const dbPath = join(dir, "strict-flush-storm.sqlite")
  const threadId = "t-strict-flush-storm"
  const saver = new SqlJsSaver(dbPath)
  const pendingFlushes: Promise<void>[] = []

  for (let index = 1; index <= 30; index += 1) {
    const checkpointId = `storm-cp-${index.toString().padStart(2, "0")}`
    const parentCheckpointId =
      index > 1 ? `storm-cp-${(index - 1).toString().padStart(2, "0")}` : undefined
    await putCheckpoint(saver, threadId, checkpointId, "", parentCheckpointId)
    pendingFlushes.push(saver.flush())
    pendingFlushes.push(saver.flushStrict())
    if (index % 5 === 0) {
      pendingFlushes.push(saver.flushStrict())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  await Promise.all(pendingFlushes)
  await Promise.all(Array.from({ length: 8 }, () => saver.flushStrict()))
  await saver.close()

  const latestId = await readBackLatestId(dbPath, threadId)
  assert.equal(latestId, "storm-cp-30", "strict flush storm should persist the last checkpoint")

  const reopened = new SqlJsSaver(dbPath)
  const retainedIds: string[] = []
  for await (const tuple of reopened.list(config(threadId))) {
    retainedIds.push(tuple.checkpoint.id)
  }
  await reopened.close()
  assert(
    retainedIds.includes("storm-cp-30"),
    `flush storm should retain storm-cp-30, got ${retainedIds.join(", ")}`
  )
  console.log("PASS mutation burst survives concurrent flushStrict storm")
}

async function testCloseAndPostCloseFlushStrictRaceIsIdempotent(dir: string): Promise<void> {
  const dbPath = join(dir, "strict-close-race.sqlite")
  const threadId = "t-strict-close-race"
  const saver = new SqlJsSaver(dbPath)

  await putCheckpoint(saver, threadId, "close-race-cp-1")
  await new Promise((resolve) => setTimeout(resolve, 320))
  await putCheckpoint(saver, threadId, "close-race-cp-2", "", "close-race-cp-1")

  const closePromise = saver.close()
  await Promise.all([
    closePromise,
    ...Array.from({ length: 12 }, () => saver.flushStrict()),
    ...Array.from({ length: 12 }, () => saver.flush())
  ])

  const latestId = await readBackLatestId(dbPath, threadId)
  assert.equal(latestId, "close-race-cp-2", "close/flushStrict race should keep latest checkpoint")
  console.log("PASS close and post-close flushStrict race is idempotent")
}

async function testRecoverFromBackupWhenLiveFileIsCorrupt(dir: string): Promise<void> {
  const dbPath = join(dir, "corrupt-live.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  await saver.flush()
  await saver.close()

  // Native SQLite deliberately avoids writing whole-database backups on each
  // checkpoint. Seed a legacy .bak candidate to verify recovery compatibility.
  await copyFile(dbPath, `${dbPath}.bak`)
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

async function testOversizedLiveStillRecoversNewerTempSnapshot(dir: string): Promise<void> {
  const dbPath = join(dir, "oversized-newer-temp.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t-oversized-temp", "cp-old")
  await saver.flush()
  await saver.close()

  await new Promise((r) => setTimeout(r, 20))
  const tempSaver = new SqlJsSaver(`${dbPath}.tmp`)
  await putCheckpoint(tempSaver, "t-oversized-temp", "cp-new")
  await tempSaver.flush()
  await tempSaver.close()

  const recovered = new SqlJsSaver(dbPath, undefined, {
    maxDatabaseBytes: 1,
    maxRootCheckpoints: 1
  })
  const tuple = await recovered.getTuple(config("t-oversized-temp"))
  await recovered.close()

  assert.equal(
    tuple?.checkpoint.id,
    "cp-new",
    "newer temp snapshot must win before oversized live compaction"
  )
  console.log("PASS oversized live database still recovers newer temp snapshot first")
}

async function testOversizedDatabaseCompactsInsteadOfStartingFresh(dir: string): Promise<void> {
  const dbPath = join(dir, "oversized-compact.sqlite")
  const original = new SqlJsSaver(dbPath, undefined, { maxCheckpointsPerNamespace: 3 })
  await putCheckpoint(original, "t-oversized", "root-1")
  await putCheckpoint(original, "t-oversized", "root-2", "", "root-1")
  await putCheckpoint(original, "t-oversized", "root-3", "", "root-2")
  await putCheckpoint(original, "t-oversized", "tool-1", "tools:fanout")
  await putCheckpoint(original, "t-oversized", "tool-2", "tools:fanout", "tool-1")
  await putCheckpoint(original, "t-oversized", "tool-3", "tools:fanout", "tool-2")
  await original.flush()
  await original.close()

  const compacted = new SqlJsSaver(dbPath, undefined, {
    maxRootCheckpoints: 2,
    maxNonRootCheckpoints: 1,
    maxDatabaseBytes: 1
  })
  const rootIds: string[] = []
  for await (const tuple of compacted.list(config("t-oversized"))) {
    rootIds.push(tuple.checkpoint.id)
  }
  const toolIds: string[] = []
  for await (const tuple of compacted.list(config("t-oversized", undefined, "tools:fanout"))) {
    toolIds.push(tuple.checkpoint.id)
  }
  await compacted.close()

  assert.deepEqual(rootIds, ["root-3", "root-2"])
  assert.deepEqual(toolIds, ["tool-3"])
  const files = await readdir(dir)
  assert(
    !files.some((file) => file.startsWith("oversized-compact.sqlite.bak.")),
    "oversized but healthy database should be compacted, not quarantined into a timestamped backup"
  )
  console.log("PASS oversized healthy database compacts instead of starting fresh")
}

async function testListEarlyBreakLeavesSaverReusable(dir: string): Promise<void> {
  const dbPath = join(dir, "list-early-break.sqlite")
  const saver = new SqlJsSaver(dbPath, undefined, { maxRootCheckpoints: 3 })
  await putCheckpoint(saver, "t-list-break", "cp-1")
  await putCheckpoint(saver, "t-list-break", "cp-2", "", "cp-1")
  await saver.flushStrict()

  let firstId: string | undefined
  for await (const tuple of saver.list(config("t-list-break"))) {
    firstId = tuple.checkpoint.id
    break
  }
  assert.equal(firstId, "cp-2", "list should yield the newest checkpoint before early break")

  await putCheckpoint(saver, "t-list-break", "cp-3", "", "cp-2")
  await saver.flushStrict()
  await saver.close()

  const id = await readBackLatestId(dbPath, "t-list-break")
  assert.equal(id, "cp-3", "saver should remain usable after a list() early break")
  console.log("PASS list early break frees statements and keeps saver reusable")
}

async function testForkBoundaryMarkerColumnBackfillsSerializedMetadata(dir: string): Promise<void> {
  const dbPath = join(dir, "fork-marker-backfill.sqlite")
  const original = new SqlJsSaver(dbPath, undefined, {
    maxRootCheckpoints: 2,
    maxRootForkBoundaryCheckpoints: 2
  })
  await putForkBoundaryCheckpoint(original, "t-marker-backfill", "boundary-1")
  await putForkBoundaryCheckpoint(original, "t-marker-backfill", "boundary-2", "boundary-1")
  await putCheckpoint(original, "t-marker-backfill", "temp-3", "", "boundary-2")
  await putCheckpoint(original, "t-marker-backfill", "temp-4", "", "temp-3")
  await original.flushStrict()
  await original.close()

  const SQL = await initSqlJs()
  const raw = new SQL.Database(await readFile(dbPath))
  raw.run(`UPDATE checkpoints SET fork_boundary_marker = 0`)
  raw.run(`DELETE FROM checkpoint_schema_migrations`)
  await writeFile(dbPath, Buffer.from(raw.export()))
  raw.close()

  const reopened = new SqlJsSaver(dbPath, undefined, {
    maxRootCheckpoints: 2,
    maxRootForkBoundaryCheckpoints: 2
  })
  await putCheckpoint(reopened, "t-marker-backfill", "temp-5", "", "temp-4")
  const retainedIds: string[] = []
  for await (const tuple of reopened.list(config("t-marker-backfill"))) {
    retainedIds.push(tuple.checkpoint.id)
  }
  await reopened.close()

  assert.deepEqual(retainedIds, ["temp-5", "temp-4", "boundary-2", "boundary-1"])
  console.log("PASS fork boundary marker column backfills serialized metadata")
}

async function testRetirePoisonsLateWriters(dir: string): Promise<void> {
  const dbPath = join(dir, "retire.sqlite")
  const saver = new SqlJsSaver(dbPath)
  await putCheckpoint(saver, "t1", "cp-1")
  await saver.flush()

  // WAL mutations commit immediately; retire still must not recreate the file
  // after the thread's backing artifacts are swept.
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
  await new Promise((r) => setTimeout(r, 450))
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
    await testWalWritesAvoidWholeDatabaseSnapshots(dir)
    await testForkBoundaryByteBudgetIncludesExternalMessages(dir)
    await testFlushStrictReportsPersistenceFailure(dir)
    await testConcurrentFlushStrictSerializesWithClose(dir)
    await testMutationBurstSurvivesConcurrentFlushStrictStorm(dir)
    await testCloseAndPostCloseFlushStrictRaceIsIdempotent(dir)
    await testRecoverFromBackupWhenLiveFileIsCorrupt(dir)
    await testRecoverFromNewerTempSnapshot(dir)
    await testOversizedLiveStillRecoversNewerTempSnapshot(dir)
    await testOversizedDatabaseCompactsInsteadOfStartingFresh(dir)
    await testListEarlyBreakLeavesSaverReusable(dir)
    await testForkBoundaryMarkerColumnBackfillsSerializedMetadata(dir)
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
