/**
 * Regression coverage for bounded SqlJsSaver reopen/setup work.
 *
 * Run:
 *   npx tsx tests/checkpointer-reopen-performance.spec.ts
 */

import assert from "assert"
import { mkdtemp, rm } from "fs/promises"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata, SerializerProtocol } from
  "@langchain/langgraph-checkpoint"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "os"
import { join } from "path"
import {
  NativeSqliteAdapter,
  type NativeSqliteBindings
} from "../src/main/db/native-sqlite-adapter"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"

const NAMESPACE_COUNT = 2_000
const MAX_REOPEN_STATEMENTS = 8

function config(
  threadId: string,
  checkpointNs: string,
  checkpointId?: string
): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpointId
    }
  }
}

function liveCheckpoint(checkpointId: string, version: number): Checkpoint {
  return {
    ...checkpoint(checkpointId),
    id: checkpointId,
    ts: new Date(Date.UTC(2026, 7, 21, 0, 0, version)).toISOString(),
    channel_values: {
      messages: [{ id: `message-${version}`, role: "assistant", content: `tail-${version}` }],
      runtime: "small"
    },
    channel_versions: { messages: version, runtime: 1 }
  } as Checkpoint
}

function checkpoint(checkpointId: string): Checkpoint {
  return {
    v: 1,
    id: checkpointId,
    ts: "2026-08-21T00:00:00.000Z",
    channel_values: {
      messages: {
        __cmb_sqljs_external_messages_v1: true,
        messageCount: 0
      },
      runtime: "small"
    },
    channel_versions: { messages: 1, runtime: 1 },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

const metadata = {
  source: "loop",
  step: 1,
  writes: {},
  parents: {}
} as CheckpointMetadata

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toUpperCase()
}

function assertBoundedSetupStatement(sql: string): void {
  const normalized = normalizedSql(sql)
  const forbidden = [
    "PRAGMA TABLE_INFO(CHECKPOINTS)",
    "UPDATE CHECKPOINTS SET CHECKPOINT_TS",
    "UPDATE CHECKPOINTS SET FORK_BOUNDARY_MARKER",
    "WHERE FORK_BOUNDARY_MARKER = 0",
    "FROM CHECKPOINT_MESSAGE_SNAPSHOTS GROUP BY THREAD_ID, CHECKPOINT_NS",
    "FROM CHECKPOINTS GROUP BY THREAD_ID, CHECKPOINT_NS",
    "PRAGMA FREELIST_COUNT",
    "VACUUM"
  ]
  const violation = forbidden.find((pattern) => normalized.includes(pattern))
  if (violation) throw new Error(`ordinary reopen executed cold maintenance: ${normalized}`)
}

function rejectAnyDeserialization(delegate: SerializerProtocol, observed: { count: number }) {
  return {
    dumpsTyped: (value: unknown) => delegate.dumpsTyped(value),
    loadsTyped: (type: string, value: string | Uint8Array) => {
      observed.count += 1
      throw new Error(
        `ordinary reopen deserialized persisted data (${type}, ${
          typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength
        } bytes)`
      )
    }
  } satisfies SerializerProtocol
}

async function seedNamespaces(databasePath: string, threadId: string): Promise<void> {
  const bootstrap = new SqlJsSaver(databasePath)
  await bootstrap.initialize()
  const [checkpointType, checkpointPayload] = await bootstrap.serde.dumpsTyped(
    checkpoint("seed")
  )
  const [metadataType, metadataPayload] = await bootstrap.serde.dumpsTyped(metadata)
  const [snapshotType, snapshotPayload] = await bootstrap.serde.dumpsTyped([])
  assert.equal(checkpointType, metadataType)
  await bootstrap.close()

  const database = new DatabaseSync(databasePath)
  const checkpointStatement = database.prepare(
    `INSERT INTO checkpoints
     (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
      metadata, checkpoint_ts, fork_boundary_marker)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0)`
  )
  const snapshotStatement = database.prepare(
    `INSERT INTO checkpoint_message_snapshots
     (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
      message_count, type, suffix)
     VALUES (?, ?, ?, NULL, 0, 0, ?, ?)`
  )
  database.exec("BEGIN")
  try {
    for (let index = 0; index < NAMESPACE_COUNT; index += 1) {
      const checkpointNs = `worker:${String(index).padStart(4, "0")}`
      const checkpointId = "seed"
      checkpointStatement.run(
        threadId,
        checkpointNs,
        checkpointId,
        checkpointType,
        checkpointPayload,
        metadataPayload,
        "2026-08-20T00:00:00.000Z"
      )
      snapshotStatement.run(
        threadId,
        checkpointNs,
        checkpointId,
        snapshotType,
        snapshotPayload
      )
    }
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  } finally {
    database.close()
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "checkpointer-reopen-performance-"))
  const databasePath = join(directory, "namespaces.sqlite")
  const threadId = "many-namespaces"

  try {
    await seedNamespaces(databasePath, threadId)

    const prototype = NativeSqliteAdapter.prototype
    const originalRun = prototype.run
    const originalExec = prototype.exec
    const originalPrepare = prototype.prepare
    let statements: string[] = []

    prototype.run = function (
      this: NativeSqliteAdapter,
      sql: string,
      bindings?: NativeSqliteBindings
    ) {
      assertBoundedSetupStatement(sql)
      statements.push(normalizedSql(sql))
      return originalRun.call(this, sql, bindings)
    }
    prototype.exec = function (
      this: NativeSqliteAdapter,
      sql: string,
      bindings?: NativeSqliteBindings
    ) {
      assertBoundedSetupStatement(sql)
      statements.push(normalizedSql(sql))
      return originalExec.call(this, sql, bindings)
    }
    prototype.prepare = function (
      this: NativeSqliteAdapter,
      sql: string,
      bindings?: NativeSqliteBindings
    ) {
      assertBoundedSetupStatement(sql)
      statements.push(normalizedSql(sql))
      return originalPrepare.call(this, sql, bindings)
    }

    try {
      for (let reopen = 0; reopen < 2; reopen += 1) {
        statements = []
        const observedLoads = { count: 0 }
        const saver = new SqlJsSaver(databasePath, undefined, { maxDatabaseBytes: 1 })
        saver.serde = rejectAnyDeserialization(saver.serde, observedLoads)
        await saver.initialize()
        await saver.close()
        assert.equal(observedLoads.count, 0, "ordinary reopen must not deserialize checkpoint rows")
        assert(
          statements.length <= MAX_REOPEN_STATEMENTS,
          `ordinary reopen executed ${statements.length} statements for ${NAMESPACE_COUNT} namespaces`
        )
      }
    } finally {
      prototype.run = originalRun
      prototype.exec = originalExec
      prototype.prepare = originalPrepare
    }

    const raw = new DatabaseSync(databasePath, { readOnly: true })
    const snapshotCount = raw
      .prepare(`SELECT COUNT(*) AS count FROM checkpoint_message_snapshots`)
      .get() as { count: number }
    const migrationCount = raw
      .prepare(`SELECT COUNT(*) AS count FROM checkpoint_schema_migrations`)
      .get() as { count: number }
    raw.close()
    assert.equal(Number(snapshotCount.count), NAMESPACE_COUNT)
    assert.equal(Number(migrationCount.count), 1)

    let parentCheckpointId = "seed"
    for (let reopen = 1; reopen <= 5; reopen += 1) {
      const saver = new SqlJsSaver(databasePath, undefined, { maxNonRootCheckpoints: 1 })
      const checkpointId = `reopen-${reopen}`
      await saver.put(
        config(threadId, "worker:1999", parentCheckpointId),
        liveCheckpoint(checkpointId, reopen),
        metadata
      )
      await saver.close()
      parentCheckpointId = checkpointId
    }

    const maintained = new DatabaseSync(databasePath, { readOnly: true })
    const maintainedSnapshotCount = maintained
      .prepare(`SELECT COUNT(*) AS count FROM checkpoint_message_snapshots`)
      .get() as { count: number }
    maintained.close()
    assert.equal(
      Number(maintainedSnapshotCount.count),
      NAMESPACE_COUNT,
      "reopen + put must collect superseded snapshots only in the affected namespace"
    )

    const verification = new SqlJsSaver(databasePath)
    try {
      const tuple = await verification.getTuple(config(threadId, "worker:1999"))
      assert.equal(tuple?.checkpoint.id, parentCheckpointId)
      assert.equal(
        ((tuple?.checkpoint.channel_values as { messages?: unknown[] }).messages?.[0] as {
          content?: string
        }).content,
        "tail-5",
        "namespace-local maintenance must preserve the latest snapshot"
      )
    } finally {
      await verification.close()
    }

    console.log("checkpointer reopen performance tests passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
