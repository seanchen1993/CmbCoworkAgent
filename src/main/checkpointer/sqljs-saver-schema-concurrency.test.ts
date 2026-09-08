import type { SerializerProtocol } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { performance } from "node:perf_hooks"
import { SqlJsSaver } from "./sqljs-saver"

const temporaryDirectories: string[] = []

function temporaryDatabase(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `cmb-checkpoint-schema-${name}-`))
  temporaryDirectories.push(directory)
  return join(directory, "checkpoint.sqlite")
}

function seedLegacyCheckpointDatabase(
  databasePath: string,
  options: { malformedMigrationTable?: boolean } = {}
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
       VALUES ('thread', '', 'checkpoint-1', 'json', '{}', ?)`
    )
    .run(JSON.stringify({ cmb_fork_boundary: { stable: true } }))
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
  it("initializes two cold saver instances for one legacy database without lock timeout", async () => {
    const databasePath = temporaryDatabase("same-file")
    seedLegacyCheckpointDatabase(databasePath)
    const first = new SqlJsSaver(databasePath)
    const second = new SqlJsSaver(relative(process.cwd(), databasePath))

    const started = performance.now()
    try {
      await Promise.all([first.initialize(), second.initialize()])
      expect(performance.now() - started).toBeLessThan(3_000)

      const verifier = new DatabaseSync(databasePath, { readOnly: true })
      const checkpoint = verifier
        .prepare("SELECT checkpoint_ts, fork_boundary_marker FROM checkpoints")
        .get() as { checkpoint_ts?: unknown; fork_boundary_marker?: unknown }
      const migration = verifier
        .prepare("SELECT COUNT(*) AS count FROM checkpoint_schema_migrations")
        .get() as { count?: unknown }
      verifier.close()
      expect(checkpoint).toMatchObject({
        checkpoint_ts: "checkpoint-1",
        fork_boundary_marker: 1
      })
      expect(Number(migration.count)).toBe(1)
    } finally {
      await Promise.allSettled([first.close(), second.close()])
    }
  }, 10_000)

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
