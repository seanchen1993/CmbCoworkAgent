import type { SerializerProtocol } from "@langchain/langgraph-checkpoint"
import { setupRealCheckpointStorageWorkerFixture } from "../../../tests/support/checkpoint-storage-real-worker"
import { afterEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { performance } from "node:perf_hooks"
import { SqlJsSaver } from "./sqljs-saver"
import { CHECKPOINT_TIMESTAMP_MIGRATION } from "./checkpoint-timestamp-schema"
import { MESSAGE_SNAPSHOT_GENERATION_MIGRATION } from "./message-snapshot-schema"

const temporaryDirectories: string[] = []
const realWorkers = setupRealCheckpointStorageWorkerFixture()

function temporaryDatabase(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `cmb-checkpoint-schema-${name}-`))
  temporaryDirectories.push(directory)
  return join(directory, "checkpoint.sqlite")
}

function seedLegacyCheckpointDatabase(
  databasePath: string,
  options: { malformedMigrationTable?: boolean; checkpointPayload?: string } = {}
): void {
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      type TEXT,
      checkpoint TEXT,
      metadata TEXT,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    )
  `)
  database
    .prepare(
      `INSERT INTO checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
       VALUES ('thread', '', 'checkpoint-1', 'json', ?, ?)`
    )
    .run(options.checkpointPayload ?? "{}", JSON.stringify({ cmb_fork_boundary: { stable: true } }))
  if (options.malformedMigrationTable) {
    database.exec("CREATE TABLE checkpoint_schema_migrations (unexpected_column TEXT)")
  }
  database.close()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function blockMetadataLoads(
  delegate: SerializerProtocol,
  entered: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>
): SerializerProtocol {
  let blocked = false
  return {
    dumpsTyped: (value) => delegate.dumpsTyped(value),
    loadsTyped: async (type, value) => {
      if (!blocked) {
        blocked = true
        entered.resolve()
        await release.promise
      }
      return delegate.loadsTyped(type, value)
    }
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("SqlJsSaver schema setup concurrency", () => {
  it("keeps Main responsive while a real default-codec Worker migrates 80 MiB of old checkpoints", async () => {
    const databasePath = temporaryDatabase("large-real-worker")
    const seed = new DatabaseSync(databasePath)
    seed.exec(`CREATE TABLE checkpoints(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,type TEXT,checkpoint TEXT,metadata TEXT,
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id))`)
    const insert = seed.prepare("INSERT INTO checkpoints VALUES('large','',?,NULL,'json',?,?)")
    const checkpoint = JSON.stringify({ ts: "2026-08-01T08:00:00+08:00", padding: "x".repeat(256 * 1024) })
    const metadata = JSON.stringify({ source: "loop", padding: "y".repeat(32 * 1024) })
    seed.exec("BEGIN")
    for (let index = 0; index < 320; index++) insert.run("legacy-" + index, checkpoint, metadata)
    seed.exec("COMMIT")
    seed.close()
    const saver = new SqlJsSaver(databasePath), entered = realWorkers.entered.length,
      exited = realWorkers.exited
    let ticks = 0, maxGapMs = 0, previous = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      maxGapMs = Math.max(maxGapMs, now - previous)
      previous = now
      ticks++
    }, 5)
    const started = performance.now()
    try {
      await saver.initialize()
      const coldMs = performance.now() - started
      clearInterval(timer)
      expect(realWorkers.entered.length).toBe(entered + 1)
      expect(realWorkers.exited).toBe(exited + 1)
      expect(ticks).toBeGreaterThan(10)
      expect(maxGapMs).toBeLessThan(250)
      const verify = new DatabaseSync(databasePath, { readOnly: true })
      try {
        expect(verify.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE checkpoint_ts=?")
          .get("2026-08-01T00:00:00.000Z")?.count).toBe(320)
        expect(verify.prepare("SELECT checkpoint,metadata FROM checkpoints LIMIT 1").get())
          .toEqual({ checkpoint, metadata })
      } finally { verify.close() }
      await saver.close()
      const beforeReopen = realWorkers.entered.length, warmStarted = performance.now()
      await saver.initialize()
      console.info("[CheckpointWorkerFixture] 80 MiB migration", {
        coldMs, mainMaxGapMs: maxGapMs, mainTicks: ticks,
        warmReopenMs: performance.now() - warmStarted, workers: realWorkers.entered.slice(entered)
      })
      expect(realWorkers.entered.length).toBe(beforeReopen)
    } finally { clearInterval(timer); await saver.close() }
  })

  it.each([
    { description: "unknown legacy time", payload: "{}", timestamp: "" },
    {
      description: "native timezone timestamp",
      payload: '{"ts":"2026-08-01T08:00:00+08:00"}',
      timestamp: "2026-08-01T00:00:00.000Z"
    }
  ])(
    "initializes two cold saver instances without lock timeout ($description)",
    async (example) => {
      const databasePath = temporaryDatabase("same-file")
      seedLegacyCheckpointDatabase(databasePath, { checkpointPayload: example.payload })
      const first = new SqlJsSaver(databasePath)
      const second = new SqlJsSaver(relative(process.cwd(), databasePath))

      const started = performance.now()
      try {
        await Promise.all([first.initialize(), second.initialize()])
        expect(performance.now() - started).toBeLessThan(3_000)
        expect(realWorkers.entered.some(worker => worker.threadId > 0 && worker.defaultCodec &&
          worker.heapMiB === 256)).toBe(true)

        const verifier = new DatabaseSync(databasePath, { readOnly: true })
        const checkpoint = verifier
          .prepare(
            "SELECT checkpoint_ts, fork_boundary_marker, checkpoint, metadata FROM checkpoints"
          )
          .get() as {
          checkpoint_ts?: unknown
          fork_boundary_marker?: unknown
          checkpoint?: unknown
          metadata?: unknown
        }
        const migration = verifier
          .prepare("SELECT migration_id FROM checkpoint_schema_migrations ORDER BY migration_id")
          .all() as Array<{ migration_id: string }>
        verifier.close()
        expect(checkpoint).toMatchObject({
          // Missing native time stays unknown; the ID is never guessed to be a timestamp.
          checkpoint_ts: example.timestamp,
          fork_boundary_marker: 1,
          checkpoint: example.payload,
          metadata: JSON.stringify({ cmb_fork_boundary: { stable: true } })
        })
        expect(migration.map((row) => row.migration_id)).toEqual(
          [
            "checkpoint-columns-and-fork-boundary-v1",
            CHECKPOINT_TIMESTAMP_MIGRATION,
            MESSAGE_SNAPSHOT_GENERATION_MIGRATION
          ].sort()
        )
      } finally {
        await Promise.allSettled([first.close(), second.close()])
      }
    },
    10_000
  )

  it("releases the per-database setup queue after a failed initialization", async () => {
    const databasePath = temporaryDatabase("failure-release")
    seedLegacyCheckpointDatabase(databasePath, { malformedMigrationTable: true })
    const failed = new SqlJsSaver(databasePath)

    await expect(failed.initialize()).rejects.toThrow()
    await failed.close()

    const repair = new DatabaseSync(databasePath)
    repair.exec("DROP TABLE checkpoint_schema_migrations")
    repair.close()

    const retry = new SqlJsSaver(databasePath)
    try {
      await expect(retry.initialize()).resolves.toBeUndefined()
    } finally {
      await retry.close()
    }
  })

  it("does not hold the SQLite writer lock while legacy metadata decoding yields", async () => {
    const databasePath = temporaryDatabase("decode-before-transaction")
    seedLegacyCheckpointDatabase(databasePath)
    const saver = new SqlJsSaver(databasePath)
    const entered = deferred()
    const release = deferred()
    saver.serde = blockMetadataLoads(saver.serde, entered, release)

    const initialization = saver.initialize()
    await entered.promise
    try {
      const independentWriter = new DatabaseSync(databasePath, { timeout: 100 })
      let transactionStarted = false
      try {
        expect(() => {
          independentWriter.exec("BEGIN IMMEDIATE")
          transactionStarted = true
        }).not.toThrow()
      } finally {
        if (transactionStarted) independentWriter.exec("ROLLBACK")
        independentWriter.close()
      }
    } finally {
      release.resolve()
      await Promise.allSettled([initialization])
      await saver.close()
    }
  })

  it("does not serialize schema setup for different database paths", async () => {
    const blockedPath = temporaryDatabase("blocked-file")
    const independentPath = temporaryDatabase("independent-file")
    seedLegacyCheckpointDatabase(blockedPath)
    seedLegacyCheckpointDatabase(independentPath)

    const blocked = new SqlJsSaver(blockedPath)
    const independent = new SqlJsSaver(independentPath)
    const entered = deferred()
    const release = deferred()
    blocked.serde = blockMetadataLoads(blocked.serde, entered, release)

    const blockedInitialization = blocked.initialize()
    await entered.promise
    let independentCompleted = false
    const independentInitialization = independent.initialize().then(() => {
      independentCompleted = true
    })

    try {
      await Promise.race([
        independentInitialization,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      ])
      expect(independentCompleted).toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled([blockedInitialization, independentInitialization])
      await Promise.allSettled([blocked.close(), independent.close()])
    }
  })
})
