import { mkdtempSync, rmSync } from "node:fs"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  Checkpoint,
  CheckpointMetadata,
  SerializerProtocol
} from "@langchain/langgraph-checkpoint"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  CheckpointRuntimeProjectionClient,
  CheckpointRuntimeProjectionWorkerUnavailableError,
  readLatestCheckpointTupleInWorker
} from "./runtime-projection-client"
import {
  commitPreparedRuntimeProjection,
  prepareLatestRuntimeProjectionMigration
} from "./runtime-projection-store"
import { SqlJsSaver } from "./sqljs-saver"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
} from "./runtime-projection-protocol"
import {
  openThreadMessageHydrationDatabase,
  readThreadMessagesPage
} from "../thread-message-hydration/page-reader"

const temporaryDirectories: string[] = []
const clients: CheckpointRuntimeProjectionClient[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "runtime-projection-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./runtime-projection-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function config(threadId: string, checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      ...(checkpointId ? { checkpoint_id: checkpointId } : {})
    }
  }
}

function checkpoint(
  id: string,
  version: number,
  messages: unknown[],
  todoContent = "legacy todo"
): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date(Date.UTC(2026, 7, 24, 0, 0, version)).toISOString(),
    channel_values: {
      messages,
      unrelated: "keep-small-runtime-channel",
      todos: [{ id: "todo-1", content: todoContent, status: "pending" }],
      __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
    },
    channel_versions: { messages: version, todos: version },
    versions_seen: {}
  } as Checkpoint
}

const metadata = {
  source: "loop",
  step: 1,
  writes: {},
  parents: {}
} as CheckpointMetadata

function createClient(): CheckpointRuntimeProjectionClient {
  const client = new CheckpointRuntimeProjectionClient(
    async () => new Worker(workerBundlePath, { name: "runtime-projection-test" })
  )
  clients.push(client)
  return client
}

async function seedLegacyInlineFixture(input: {
  threadId: string
  messages: unknown[]
}): Promise<{ databasePath: string; legacyCheckpoint: Checkpoint }> {
  const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-"))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, "thread.sqlite")
  const legacyCheckpoint = checkpoint("legacy-inline", 1, input.messages)
  const saver = new SqlJsSaver(databasePath)
  await saver.put(config(input.threadId), legacyCheckpoint, metadata)
  const [type, payload] = await saver.serde.dumpsTyped(legacyCheckpoint)
  await saver.close()

  const database = new DatabaseSync(databasePath)
  database
    .prepare(
      `UPDATE checkpoints SET type = ?, checkpoint = ?
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    .run(type, payload, input.threadId, legacyCheckpoint.id)
  database
    .prepare(
      `DELETE FROM checkpoint_message_snapshots
       WHERE thread_id = ? AND checkpoint_ns = ''`
    )
    .run(input.threadId)
  database
    .prepare(
      `DELETE FROM checkpoint_runtime_projections
       WHERE thread_id = ? AND checkpoint_ns = ''`
    )
    .run(input.threadId)
  database.close()
  return { databasePath, legacyCheckpoint }
}

function createMessageDatabase(checkpointDatabasePath: string, threadId: string): string {
  const databasePath = join(dirname(checkpointDatabasePath), "messages.sqlite")
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_messages (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      provider_source_id TEXT,
      provider_occurrence INTEGER,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      name TEXT,
      status TEXT,
      is_error INTEGER,
      content_priority INTEGER,
      goal_id TEXT,
      active_window_id TEXT,
      created_at INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    );
    CREATE TABLE thread_message_buckets (
      thread_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL,
      next_ordinal INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_message_fragments (
      fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE thread_message_fragment_states (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      total_chars INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    );
  `)
  const now = Date.now()
  database
    .prepare("INSERT INTO threads (thread_id, created_at, updated_at) VALUES (?, ?, ?)")
    .run(threadId, now, now)
  database.close()
  return databasePath
}

function rejectLargeDeserialization(
  delegate: SerializerProtocol,
  maxBytes: number,
  observedBytes: number[]
): SerializerProtocol {
  return {
    dumpsTyped: (value) => delegate.dumpsTyped(value),
    loadsTyped: (type, value) => {
      const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength
      observedBytes.push(bytes)
      if (bytes > maxBytes) throw new Error(`main deserialized ${bytes} checkpoint bytes`)
      return delegate.loadsTyped(type, value)
    }
  }
}

describe("checkpoint runtime projection worker", () => {
  it("returns an authoritative empty result when the checkpoint database is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-absent-"))
    temporaryDirectories.push(directory)

    await expect(
      readLatestCheckpointTupleInWorker(
        join(directory, "not-created.sqlite"),
        "thread-without-a-run"
      )
    ).resolves.toBeNull()
  })

  it("returns null when a fully published checkpoint database has no checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-empty-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "empty.sqlite")
    const saver = new SqlJsSaver(databasePath)
    await saver.initialize()
    await saver.close()

    const client = createClient()
    await expect(client.readLatestTuple(databasePath, "empty-thread")).resolves.toBeNull()
    await expect(client.hasTranscript(databasePath, "empty-thread")).resolves.toBe(false)
    await expect(
      client.bootstrapLegacyTranscript(
        databasePath,
        join(directory, "unused-messages.sqlite"),
        "empty-thread"
      )
    ).resolves.toMatchObject({
      runtimeTuple: null,
      stats: { checkpointId: null, totalMessages: 0, migratedMessages: 0 }
    })
  })

  it("does not require the pending-writes table for an empty bounded read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-partial-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "partial.sqlite")
    const partial = new DatabaseSync(databasePath)
    partial.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint TEXT,
        metadata TEXT,
        fork_boundary_marker INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE checkpoint_message_snapshots (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        prefix_length INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL,
        generation TEXT NOT NULL DEFAULT '',
        type TEXT,
        suffix BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE checkpoint_runtime_projections (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_ts TEXT NOT NULL,
        projection_version INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL,
        runtime_checkpoint BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns)
      )
    `)
    partial.close()

    const client = createClient()
    await expect(
      client.readLatestTuple(databasePath, "partial-thread", "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })
    ).resolves.toBeNull()
    await expect(client.hasTranscript(databasePath, "partial-thread")).resolves.toBe(false)
    await expect(
      client.bootstrapLegacyTranscript(
        databasePath,
        join(directory, "unused-messages.sqlite"),
        "partial-thread"
      )
    ).resolves.toMatchObject({
      runtimeTuple: null,
      stats: { checkpointId: null, totalMessages: 0, migratedMessages: 0 }
    })
    await expect(client.ensureRuntimeProjection(databasePath, "partial-thread")).resolves.toEqual({
      sourceBytes: 0,
      projectionBytes: 0,
      inlineMessageCount: 0,
      migrated: false,
      stale: false
    })
  })

  it("still rejects a checkpoint table missing a required base column", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-invalid-base-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "invalid-base.sqlite")
    const invalid = new DatabaseSync(databasePath)
    invalid.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)
    invalid.close()

    const client = createClient()
    await expect(
      client.readLatestTuple(databasePath, "invalid-base", "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })
    ).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY })
    await expect(client.hasTranscript(databasePath, "invalid-base")).rejects.toMatchObject({
      name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
    })
    await expect(
      client.bootstrapLegacyTranscript(
        databasePath,
        join(directory, "unused-messages.sqlite"),
        "invalid-base"
      )
    ).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY })
  })

  it("bootstraps a checkpoints-and-writes-only legacy database without creating projections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-base-only-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "base-only.sqlite")
    const threadId = "base-only-inline-thread"
    const legacyCheckpoint = checkpoint("base-only-inline", 1, [
      { id: "legacy-visible", type: "human", content: "recover without auxiliary tables" }
    ])
    const legacyCheckpointPayload = JSON.stringify(legacyCheckpoint)
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint TEXT,
        metadata TEXT,
        checkpoint_ts TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `)
    legacy
      .prepare(
        `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata, checkpoint_ts)
         VALUES (?, '', ?, 'json', ?, ?, ?)`
      )
      .run(
        threadId,
        legacyCheckpoint.id,
        legacyCheckpointPayload,
        JSON.stringify(metadata),
        legacyCheckpoint.ts
      )
    legacy.close()

    const client = createClient()
    await expect(
      client.readLatestTuple(databasePath, threadId, "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })
    ).resolves.toMatchObject({
      checkpoint: {
        id: legacyCheckpoint.id,
        channel_values: {
          messages: [{ id: "legacy-visible", type: "human" }]
        }
      }
    })
    await expect(client.hasTranscript(databasePath, threadId)).resolves.toBe(true)
    await expect(client.readLatestRuntimeTuple(databasePath, threadId)).resolves.toMatchObject({
      checkpoint: {
        id: legacyCheckpoint.id,
        channel_values: {
          messages: [],
          todos: [{ id: "todo-1", content: "legacy todo", status: "pending" }],
          __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
        }
      }
    })
    const zeroMessageTuple = (await client.readLatestTuple(databasePath, threadId, "", {
      messageLimit: 0,
      messageByteBudget: 0
    })) as {
      checkpoint?: { channel_values?: Record<string, unknown> }
    }
    expect(zeroMessageTuple.checkpoint?.channel_values).toMatchObject({
      messages: [],
      todos: [{ id: "todo-1", content: "legacy todo", status: "pending" }],
      __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
    })

    await expect(client.readLatestTuple(databasePath, threadId)).resolves.toMatchObject({
      checkpoint: {
        id: legacyCheckpoint.id,
        channel_values: {
          messages: [{ id: "legacy-visible", type: "human" }],
          todos: [{ id: "todo-1", content: "legacy todo", status: "pending" }],
          __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
        }
      },
      pendingWrites: []
    })

    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    await expect(
      client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId)
    ).resolves.toMatchObject({
      runtimeTuple: { checkpoint: { id: legacyCheckpoint.id } },
      stats: { checkpointId: legacyCheckpoint.id, totalMessages: 1, migratedMessages: 1 }
    })
    await expect(client.ensureRuntimeProjection(databasePath, threadId)).resolves.toMatchObject({
      migrated: false,
      stale: false
    })

    const verifier = new DatabaseSync(databasePath, { readOnly: true })
    const source = verifier
      .prepare(
        `SELECT type, checkpoint FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(threadId, legacyCheckpoint.id) as { type?: unknown; checkpoint?: unknown }
    expect(source).toMatchObject({ type: "json", checkpoint: legacyCheckpointPayload })
    const tables = verifier
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'checkpoint_message_snapshots', 'checkpoint_runtime_projections', 'writes'
         ) ORDER BY name`
      )
      .all() as Array<{ name?: unknown }>
    verifier.close()
    expect(tables.map((table) => String(table.name))).toEqual(["writes"])

    const messages = new DatabaseSync(messageDatabasePath, { readOnly: true })
    const durableMessage = messages
      .prepare(
        `SELECT message_id, role, content_json, ordinal FROM thread_messages
         WHERE thread_id = ? ORDER BY ordinal`
      )
      .get(threadId)
    messages.close()
    expect(durableMessage).toMatchObject({
      message_id: "legacy-visible",
      role: "user",
      content_json: '"recover without auxiliary tables"',
      ordinal: 0
    })
  })

  it("restores runtime state from a real long inline history within a small worker heap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-long-state-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "long-state.sqlite")
    const threadId = "long-runtime-state"
    const checkpointId = "long-runtime-checkpoint"
    const saver = new SqlJsSaver(databasePath)
    await saver.initialize()
    await saver.close()

    const messageContent = "history".padEnd(8 * 1024, "x")
    const messages = Array.from({ length: 3_000 }, (_, index) => ({
      id: `history-${index}`,
      type: index % 2 === 0 ? "human" : "ai",
      content: messageContent
    }))
    const longCheckpoint = checkpoint(checkpointId, 1, messages, "keep runtime todo")
    const serializedCheckpoint = JSON.stringify(longCheckpoint)
    expect(Buffer.byteLength(serializedCheckpoint, "utf8")).toBeGreaterThan(20 * 1024 * 1024)

    const database = new DatabaseSync(databasePath)
    database
      .prepare(
        `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata, checkpoint_ts)
         VALUES (?, '', ?, 'json', ?, ?, ?)`
      )
      .run(
        threadId,
        checkpointId,
        serializedCheckpoint,
        JSON.stringify(metadata),
        longCheckpoint.ts
      )
    database.close()

    const limitedClient = new CheckpointRuntimeProjectionClient(
      async () =>
        new Worker(workerBundlePath, {
          name: "runtime-projection-small-heap-test",
          resourceLimits: {
            maxOldGenerationSizeMb: 48,
            maxYoungGenerationSizeMb: 8,
            stackSizeMb: 4
          }
        })
    )
    clients.push(limitedClient)

    let mainTickerCount = 0
    const ticker = setInterval(() => {
      mainTickerCount += 1
    }, 1)
    let runtimeTuple: unknown
    try {
      runtimeTuple = await limitedClient.readLatestRuntimeTuple(
        databasePath,
        threadId,
        "",
        "long-runtime-state"
      )
    } finally {
      clearInterval(ticker)
    }

    const projected = runtimeTuple as {
      checkpoint?: { channel_values?: Record<string, unknown> }
    }
    expect(projected.checkpoint?.channel_values).toMatchObject({
      messages: [],
      todos: [{ id: "todo-1", content: "keep runtime todo", status: "pending" }],
      __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
    })
    expect(projected.checkpoint?.channel_values).not.toHaveProperty("unrelated")
    expect(Buffer.byteLength(JSON.stringify(runtimeTuple), "utf8")).toBeLessThan(128 * 1024)
    expect(mainTickerCount).toBeGreaterThan(5)

    const readBoundedTail = async (): Promise<{
      tuple: unknown
      tickerCount: number
    }> => {
      let tickerCount = 0
      const tailTicker = setInterval(() => {
        tickerCount += 1
      }, 1)
      try {
        return {
          tuple: await limitedClient.readLatestTuple(databasePath, threadId, "", {
            messageLimit: 128,
            messageByteBudget: 1024 * 1024
          }),
          tickerCount
        }
      } finally {
        clearInterval(tailTicker)
      }
    }
    const inlineTail = await readBoundedTail()
    const inlineMessages = (
      inlineTail.tuple as {
        checkpoint?: {
          channel_values?: { messages?: unknown[]; __cmb_original_message_count?: number }
        }
      }
    ).checkpoint?.channel_values
    expect(inlineMessages?.messages?.length).toBeGreaterThan(100)
    expect(inlineMessages?.messages?.length).toBeLessThanOrEqual(128)
    expect(inlineMessages?.messages?.at(0)).toMatchObject({
      id: `history-${messages.length - (inlineMessages?.messages?.length ?? 0)}`
    })
    expect(inlineMessages?.messages?.at(-1)).toMatchObject({ id: "history-2999" })
    expect(inlineMessages?.__cmb_original_message_count).toBe(messages.length)
    expect(Buffer.byteLength(JSON.stringify(inlineTail.tuple), "utf8")).toBeLessThan(
      1024 * 1024
    )
    expect(inlineTail.tickerCount).toBeGreaterThan(5)

    const external = new DatabaseSync(databasePath)
    external
      .prepare(
        `INSERT INTO checkpoint_message_snapshots
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          prefix_length, message_count, type, suffix)
         VALUES (?, '', ?, NULL, 0, ?, 'json', ?)`
      )
      .run(threadId, checkpointId, messages.length, JSON.stringify(messages))
    external
      .prepare(
        `UPDATE checkpoints SET checkpoint = ?
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .run(
        JSON.stringify({
          ...longCheckpoint,
          channel_values: {
            ...longCheckpoint.channel_values,
            messages: {
              __cmb_sqljs_external_messages_v1: true,
              messageCount: messages.length
            }
          }
        }),
        threadId,
        checkpointId
      )
    external.close()

    const externalTail = await readBoundedTail()
    const externalMessages = (
      externalTail.tuple as {
        checkpoint?: {
          channel_values?: { messages?: unknown[]; __cmb_original_message_count?: number }
        }
      }
    ).checkpoint?.channel_values
    expect(externalMessages?.messages?.length).toBeGreaterThan(100)
    expect(externalMessages?.messages?.length).toBeLessThanOrEqual(128)
    expect(externalMessages?.messages?.at(0)).toMatchObject({
      id: `history-${messages.length - (externalMessages?.messages?.length ?? 0)}`
    })
    expect(externalMessages?.messages?.at(-1)).toMatchObject({ id: "history-2999" })
    expect(externalMessages?.__cmb_original_message_count).toBe(messages.length)
    expect(Buffer.byteLength(JSON.stringify(externalTail.tuple), "utf8")).toBeLessThan(
      1024 * 1024
    )
    expect(externalTail.tickerCount).toBeGreaterThan(5)

    const withoutSnapshots = new DatabaseSync(databasePath)
    withoutSnapshots.exec("DROP TABLE checkpoint_message_snapshots")
    withoutSnapshots.close()
    await expect(
      limitedClient.readLatestRuntimeTuple(databasePath, threadId)
    ).resolves.toMatchObject({
      checkpoint: {
        channel_values: {
          messages: [],
          todos: [{ id: "todo-1", content: "keep runtime todo", status: "pending" }]
        }
      }
    })

    const verifier = new DatabaseSync(databasePath, { readOnly: true })
    const persisted = verifier
      .prepare(
        `SELECT json_extract(
                  checkpoint,
                  '$.channel_values.messages.messageCount'
                ) AS message_count,
                length(runtime_checkpoint) AS projection_bytes
         FROM checkpoints
         JOIN checkpoint_runtime_projections USING (thread_id, checkpoint_ns, checkpoint_id)
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(threadId, checkpointId) as {
      message_count?: unknown
      projection_bytes?: unknown
    }
    verifier.close()
    expect(Number(persisted.message_count)).toBe(messages.length)
    expect(Number(persisted.projection_bytes)).toBeLessThan(128 * 1024)
  }, 30_000)

  it("reads the authoritative tail across truncated external snapshot generations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-tail-chain-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "tail-chain.sqlite")
    const threadId = "truncated-tail-chain"
    const saver = new SqlJsSaver(databasePath)
    await saver.initialize()
    await saver.close()

    const message = (id: string): Record<string, unknown> => ({
      id,
      type: "ai",
      content: id
    })
    const latestCheckpoint = checkpoint("snapshot-c", 3, [], "chain todo")
    const database = new DatabaseSync(databasePath)
    database
      .prepare(
        `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          type, checkpoint, metadata, checkpoint_ts)
         VALUES (?, '', ?, 'snapshot-b', 'json', ?, ?, ?)`
      )
      .run(
        threadId,
        latestCheckpoint.id,
        JSON.stringify({
          ...latestCheckpoint,
          channel_values: {
            ...latestCheckpoint.channel_values,
            messages: {
              __cmb_sqljs_external_messages_v1: true,
              messageCount: 5
            }
          }
        }),
        JSON.stringify(metadata),
        latestCheckpoint.ts
      )
    const insertSnapshot = database.prepare(
      `INSERT INTO checkpoint_message_snapshots
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        prefix_length, message_count, type, suffix)
       VALUES (?, '', ?, ?, ?, ?, 'json', ?)`
    )
    insertSnapshot.run(
      threadId,
      "snapshot-a",
      null,
      0,
      4,
      JSON.stringify([message("a"), message("b"), message("c"), message("d")])
    )
    insertSnapshot.run(
      threadId,
      "snapshot-b",
      "snapshot-a",
      2,
      4,
      JSON.stringify([message("e"), message("f")])
    )
    insertSnapshot.run(
      threadId,
      "snapshot-c",
      "snapshot-b",
      3,
      5,
      JSON.stringify([message("g"), message("h")])
    )
    database.close()

    const client = createClient()
    const tuple = (await client.readLatestTuple(databasePath, threadId, "", {
      messageLimit: 4,
      messageByteBudget: 1024 * 1024
    })) as {
      checkpoint?: {
        channel_values?: {
          messages?: Array<{ id?: string }>
          __cmb_original_message_count?: number
          todos?: unknown[]
        }
      }
    }
    expect(tuple.checkpoint?.channel_values?.messages?.map((entry) => entry.id)).toEqual([
      "b",
      "e",
      "g",
      "h"
    ])
    expect(tuple.checkpoint?.channel_values?.__cmb_original_message_count).toBe(5)
    expect(tuple.checkpoint?.channel_values?.todos).toMatchObject([
      { id: "todo-1", content: "chain todo", status: "pending" }
    ])
  })

  it("keeps tool identity when an oversized checkpoint message uses SQL fallback", async () => {
    const threadId = "oversized-bounded-tool-message"
    const { databasePath } = await seedLegacyInlineFixture({
      threadId,
      messages: [
        {
          id: ["langchain_core", "messages", "AIMessage"],
          additional_kwargs: {},
          kwargs: {
            id: "oversized-ai",
            content: "large tool request",
            additional_kwargs: { cmb_internal_coordinator_notification: true },
            tool_calls: [
              {
                id: "call-large-write",
                name: "write_file",
                args: { content: "x".repeat(96 * 1024) }
              }
            ]
          }
        }
      ]
    })
    const client = createClient()
    const tuple = (await client.readLatestTuple(databasePath, threadId, "", {
      messageLimit: 10,
      messageByteBudget: 1024 * 1024
    })) as {
      checkpoint?: {
        channel_values?: {
          messages?: Array<Record<string, unknown>>
        }
      }
    }
    expect(tuple.checkpoint?.channel_values?.messages).toEqual([
      expect.objectContaining({
        id: "oversized-ai",
        type: "ai",
        content: "large tool request",
        tool_calls: [{ id: "call-large-write", name: "write_file", args: {} }]
      })
    ])
    expect(tuple.checkpoint?.channel_values?.messages?.[0]).not.toHaveProperty(
      "additional_kwargs.cmb_internal_coordinator_notification"
    )
  })

  it("rejects an external checkpoint until its snapshot schema is published", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-missing-snapshot-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "missing-snapshot.sqlite")
    const partial = new DatabaseSync(databasePath)
    partial.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint TEXT,
        metadata TEXT,
        fork_boundary_marker INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
      CREATE TABLE checkpoint_runtime_projections (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_ts TEXT NOT NULL,
        projection_version INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL,
        runtime_checkpoint BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns)
      )
    `)
    partial
      .prepare(
        `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
         VALUES (?, '', 'checkpoint-1', 'json', ?, '{}')`
      )
      .run(
        "external-thread",
        JSON.stringify({
          v: 1,
          id: "checkpoint-1",
          ts: "2026-08-31T00:00:00.000Z",
          channel_values: {
            messages: { __cmb_sqljs_external_messages_v1: true, messageCount: 1 }
          },
          channel_versions: {},
          versions_seen: {}
        })
      )
    partial.close()

    const client = createClient()
    await expect(client.hasTranscript(databasePath, "external-thread")).rejects.toMatchObject({
      name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
    })
    await expect(
      client.readLatestTuple(databasePath, "external-thread", "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })
    ).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY })
    await expect(
      client.bootstrapLegacyTranscript(
        databasePath,
        join(directory, "unused-messages.sqlite"),
        "external-thread"
      )
    ).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY })
    await expect(
      client.ensureRuntimeProjection(databasePath, "external-thread")
    ).resolves.toMatchObject({ migrated: true, stale: false })
    await expect(
      client.readLatestRuntimeTuple(databasePath, "external-thread")
    ).resolves.toMatchObject({
      checkpoint: {
        id: "checkpoint-1",
        channel_values: { messages: [] }
      }
    })
    await expect(
      client.ensureRuntimeProjection(databasePath, "external-thread")
    ).resolves.toMatchObject({ migrated: false, stale: false })
  })

  it("reads a pre-timestamp base checkpoint before SqlJsSaver publishes the full schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-runtime-projection-saver-retry-"))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, "legacy-base.sqlite")
    const threadId = "legacy-base-retry"
    const olderCheckpoint = checkpoint("legacy-base-checkpoint-001", 0, [
      { id: "legacy-older-message", type: "human", content: "older checkpoint" }
    ])
    const legacyCheckpoint = checkpoint("legacy-base-checkpoint-002", 1, [
      { id: "legacy-retry-message", type: "human", content: "retry after schema upgrade" }
    ])
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
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
    const insertCheckpoint = legacy.prepare(
      `INSERT INTO checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
       VALUES (?, '', ?, 'json', ?, ?)`
    )
    for (const storedCheckpoint of [olderCheckpoint, legacyCheckpoint]) {
      insertCheckpoint.run(
        threadId,
        storedCheckpoint.id,
        JSON.stringify(storedCheckpoint),
        JSON.stringify(metadata)
      )
    }
    legacy.close()

    const client = createClient()
    await expect(
      client.readLatestTuple(databasePath, threadId, "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })
    ).resolves.toMatchObject({
      checkpoint: {
        id: legacyCheckpoint.id,
        channel_values: { messages: [{ id: "legacy-retry-message", type: "human" }] }
      }
    })
    await expect(client.hasTranscript(databasePath, threadId)).resolves.toBe(true)
    await expect(client.readLatestTuple(databasePath, threadId)).rejects.toMatchObject({
      name: CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
    })

    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    await expect(
      client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId)
    ).resolves.toMatchObject({
      runtimeTuple: { checkpoint: { id: legacyCheckpoint.id } },
      stats: { checkpointId: legacyCheckpoint.id, totalMessages: 1, migratedMessages: 1 }
    })

    const saver = new SqlJsSaver(databasePath)
    await saver.initialize()
    await saver.close()

    await expect(
      client.readLatestTuple(databasePath, threadId, "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })
    ).resolves.toMatchObject({
      checkpoint: {
        id: legacyCheckpoint.id,
        channel_values: { messages: [{ id: "legacy-retry-message", type: "human" }] }
      }
    })
    await expect(client.readLatestTuple(databasePath, threadId)).resolves.toMatchObject({
      checkpoint: { id: legacyCheckpoint.id },
      pendingWrites: []
    })

    const verifier = new DatabaseSync(databasePath, { readOnly: true })
    const checkpointColumns = verifier.prepare("PRAGMA table_info(checkpoints)").all() as Array<{
      name?: unknown
    }>
    const auxiliaryTables = verifier
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'checkpoint_message_snapshots', 'checkpoint_runtime_projections', 'writes'
         )
         ORDER BY name`
      )
      .all() as Array<{ name?: unknown }>
    const checkpointTimestamps = verifier
      .prepare("SELECT checkpoint_id, checkpoint_ts FROM checkpoints ORDER BY checkpoint_id")
      .all() as Array<{ checkpoint_id?: unknown; checkpoint_ts?: unknown }>
    verifier.close()
    expect(checkpointColumns.some((column) => column.name === "checkpoint_ts")).toBe(true)
    expect(checkpointColumns.some((column) => column.name === "fork_boundary_marker")).toBe(true)
    expect(auxiliaryTables.map((table) => table.name)).toEqual([
      "checkpoint_message_snapshots",
      "checkpoint_runtime_projections",
      "writes"
    ])
    expect(checkpointTimestamps).toEqual([
      {
        checkpoint_id: olderCheckpoint.id,
        checkpoint_ts: olderCheckpoint.id
      },
      {
        checkpoint_id: legacyCheckpoint.id,
        checkpoint_ts: legacyCheckpoint.id
      }
    ])
  })

  it("serializes concurrent saver and worker upgrades of a pre-generation snapshot table", async () => {
    const threadId = "legacy-generation-upgrade"
    const { databasePath } = await seedLegacyInlineFixture({
      threadId,
      messages: [{ id: "legacy-message", type: "human", content: "upgrade me" }]
    })
    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec("ALTER TABLE checkpoint_message_snapshots DROP COLUMN generation")
    legacyDatabase.close()

    const client = createClient()
    const saver = new SqlJsSaver(databasePath)
    const [migration] = await Promise.all([
      client.ensureRuntimeProjection(databasePath, threadId),
      saver.initialize()
    ])
    expect(migration.migrated).toBe(true)
    await expect(client.ensureRuntimeProjection(databasePath, threadId)).resolves.toBeDefined()
    await saver.close()

    const verifier = new DatabaseSync(databasePath, { readOnly: true })
    const columns = verifier
      .prepare("PRAGMA table_info(checkpoint_message_snapshots)")
      .all() as Array<{ name?: unknown }>
    const snapshot = verifier
      .prepare(
        `SELECT generation FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ''`
      )
      .get(threadId) as { generation?: unknown } | undefined
    verifier.close()
    expect(columns.some((column) => column.name === "generation")).toBe(true)
    expect(typeof snapshot?.generation).toBe("string")
    expect(String(snapshot?.generation ?? "")).toMatch(/^[0-9a-f-]{32,36}$/)
  })

  it("replaces an untrusted full-checkpoint projection before main deserializes it", async () => {
    const threadId = "legacy-fake-projection"
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId,
      messages: Array.from({ length: 520 }, (_, index) => ({
        id: `legacy-${index}`,
        type: "ai",
        content: "large".repeat(700)
      }))
    })
    const raw = new DatabaseSync(databasePath)
    raw
      .prepare(
        `INSERT INTO checkpoint_runtime_projections (
           thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
           checkpoint_ts, projection_version, type, runtime_checkpoint
         )
         SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                checkpoint_ts, 0, type, checkpoint
         FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .run(threadId, legacyCheckpoint.id)
    raw.close()

    const client = createClient()
    const migration = await client.ensureRuntimeProjection(databasePath, threadId)
    expect(migration.migrated).toBe(true)

    const saver = new SqlJsSaver(databasePath)
    const observedBytes: number[] = []
    saver.serde = rejectLargeDeserialization(saver.serde, 64 * 1024, observedBytes)
    const tuple = await saver.getLatestRuntimeTuple(config(threadId))
    expect(tuple?.checkpoint.id).toBe(legacyCheckpoint.id)
    expect(Math.max(0, ...observedBytes)).toBeLessThan(64 * 1024)
    await saver.close()

    const verifier = new DatabaseSync(databasePath, { readOnly: true })
    const projection = verifier
      .prepare(
        `SELECT projection_version, LENGTH(runtime_checkpoint) AS projection_bytes
         FROM checkpoint_runtime_projections
         WHERE thread_id = ? AND checkpoint_ns = ''`
      )
      .get(threadId) as { projection_version: number; projection_bytes: number }
    verifier.close()
    expect(Number(projection.projection_version)).toBe(1)
    expect(Number(projection.projection_bytes)).toBeLessThan(64 * 1024)
  }, 30_000)

  it("cancels a stale foreground bootstrap before serving the next task", async () => {
    const firstThreadId = "legacy-foreground-a"
    const secondThreadId = "legacy-foreground-b"
    const first = await seedLegacyInlineFixture({
      threadId: firstThreadId,
      messages: Array.from({ length: 563 }, (_, index) => ({
        id: `first-${index}`,
        type: "ai",
        content: `${index}:`.padEnd(3_250, "a")
      }))
    })
    const second = await seedLegacyInlineFixture({
      threadId: secondThreadId,
      messages: [{ id: "second", type: "human", content: "current task" }]
    })
    const firstMessageDatabase = createMessageDatabase(first.databasePath, firstThreadId)
    const secondMessageDatabase = createMessageDatabase(second.databasePath, secondThreadId)
    const client = createClient()

    const stale = client.bootstrapLegacyTranscript(
      first.databasePath,
      firstMessageDatabase,
      firstThreadId,
      "",
      "renderer-1"
    )
    const current = client.bootstrapLegacyTranscript(
      second.databasePath,
      secondMessageDatabase,
      secondThreadId,
      "",
      "renderer-1"
    )

    await expect(stale).rejects.toMatchObject({
      name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
    })
    await expect(current).resolves.toMatchObject({
      stats: { totalMessages: 1, migratedMessages: 1 }
    })
  }, 30_000)

  it("cancels queued transcript checks superseded by a newer workspace intent", async () => {
    const posted: Array<Record<string, unknown>> = []
    const emitter = new EventEmitter()
    const fakeWorker = Object.assign(emitter, {
      postMessage(message: Record<string, unknown>): void {
        if (message.type === "shutdown") {
          queueMicrotask(() => emitter.emit("message", { type: "shutdown-complete" }))
          return
        }
        posted.push(message)
      },
      unref(): Worker {
        return fakeWorker
      },
      terminate: async (): Promise<number> => 0
    }) as unknown as Worker
    const client = new CheckpointRuntimeProjectionClient(async () => fakeWorker)
    clients.push(client)

    const stale = client.hasTranscript("first.sqlite", "thread-1", "", "thread-1")
    const staleResult = expect(stale).rejects.toMatchObject({
      name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
    })
    const current = client.hasTranscript("second.sqlite", "thread-1", "", "thread-1")
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(posted).toHaveLength(2)
    const staleRequest = posted[0] as {
      requestId: number
      cancellationBuffer: SharedArrayBuffer
    }
    const currentRequest = posted[1] as {
      requestId: number
      cancellationBuffer: SharedArrayBuffer
    }
    expect(Atomics.load(new Int32Array(staleRequest.cancellationBuffer), 0)).toBe(1)
    expect(Atomics.load(new Int32Array(currentRequest.cancellationBuffer), 0)).toBe(0)
    expect(
      (client as unknown as { pending: Map<number, unknown> }).pending.size
    ).toBe(1)

    emitter.emit("message", {
      type: "inspect-transcript-presence-result",
      requestId: staleRequest.requestId,
      ok: false,
      error: {
        code: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
        message: "Checkpoint runtime projection request cancelled"
      }
    })
    emitter.emit("message", {
      type: "inspect-transcript-presence-result",
      requestId: currentRequest.requestId,
      ok: true,
      hasTranscript: true
    })

    await staleResult
    await expect(current).resolves.toBe(true)
  })

  it("releases pending and foreground bookkeeping when postMessage throws", async () => {
    const emitter = new EventEmitter()
    let requestAttempts = 0
    const fakeWorker = Object.assign(emitter, {
      postMessage(message: Record<string, unknown>): void {
        if (message.type === "shutdown") {
          queueMicrotask(() => emitter.emit("message", { type: "shutdown-complete" }))
          return
        }
        requestAttempts += 1
        if (requestAttempts === 1) throw new Error("worker port closed")
        queueMicrotask(() =>
          emitter.emit("message", {
            type: "inspect-transcript-presence-result",
            requestId: message.requestId,
            ok: true,
            hasTranscript: true
          })
        )
      },
      unref(): Worker {
        return fakeWorker
      },
      terminate: async (): Promise<number> => 0
    }) as unknown as Worker
    const client = new CheckpointRuntimeProjectionClient(async () => fakeWorker)
    clients.push(client)

    await expect(
      client.hasTranscript("first.sqlite", "thread-1", "", "renderer-1")
    ).rejects.toThrow("Unable to send")
    const state = client as unknown as {
      pending: Map<number, unknown>
      foregroundRequests: Map<string, number>
    }
    expect(state.pending.size).toBe(0)
    expect(state.foregroundRequests.size).toBe(0)

    await expect(
      client.hasTranscript("second.sqlite", "thread-1", "", "renderer-1")
    ).resolves.toBe(true)
  })

  it("rejects a request that resumes after shutdown has drained pending work", async () => {
    const emitter = new EventEmitter()
    const posted: Array<Record<string, unknown>> = []
    const fakeWorker = Object.assign(emitter, {
      postMessage(message: Record<string, unknown>): void {
        if (message.type === "shutdown") {
          queueMicrotask(() => emitter.emit("message", { type: "shutdown-complete" }))
          return
        }
        posted.push(message)
        if (posted.length === 1) {
          queueMicrotask(() =>
            emitter.emit("message", {
              type: "inspect-transcript-presence-result",
              requestId: message.requestId,
              ok: true,
              hasTranscript: true
            })
          )
        }
      },
      unref(): Worker {
        return fakeWorker
      },
      terminate: async (): Promise<number> => 0
    }) as unknown as Worker
    const client = new CheckpointRuntimeProjectionClient(async () => fakeWorker)
    clients.push(client)

    await expect(client.hasTranscript("prime.sqlite", "thread-prime")).resolves.toBe(true)

    // request() now yields through the already-resolved Worker promise. close()
    // drains pending work synchronously before that continuation resumes.
    const racedRequest = client.hasTranscript("closing.sqlite", "thread-closing")
    const closing = client.close()

    await expect(racedRequest).rejects.toBeInstanceOf(
      CheckpointRuntimeProjectionWorkerUnavailableError
    )
    await closing
    expect(posted).toHaveLength(1)
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0)
  })

  it("imports a large empty-transcript fallback without cloning the full tuple", async () => {
    const threadId = "legacy-empty-transcript"
    const messages = Array.from({ length: 563 }, (_, index) => ({
      id: ["langchain_core", "messages", index % 2 === 0 ? "HumanMessage" : "AIMessage"],
      kwargs: {
        id: `legacy-${index}`,
        type: index % 2 === 0 ? "human" : "ai",
        content: `${index}:`.padEnd(3_250, "x")
      }
    }))
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages })
    const messageDatabasePath = createMessageDatabase(databasePath, threadId)

    // Simulate a message committed after the renderer's total=0 observation
    // but before the compatibility worker reserves the legacy prefix.
    const liveDatabase = new DatabaseSync(messageDatabasePath)
    liveDatabase
      .prepare(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES (?, 'live-tail', 'assistant', '"live"', ?, 0)`
      )
      .run(threadId, Date.now())
    liveDatabase
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES (?, 1, 1, ?)`
      )
      .run(threadId, Date.now())
    liveDatabase.close()

    const client = createClient()
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    let result
    try {
      result = await client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId)
    } finally {
      clearInterval(ticker)
    }

    expect(result.stats.payloadBytes).toBeGreaterThan(1.7 * 1024 * 1024)
    expect(result.stats.totalMessages).toBe(563)
    expect(result.stats.migratedMessages).toBe(563)
    expect(result.stats.batches).toBeGreaterThan(1)
    expect(ticks).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(64 * 1024)
    const runtimeValues = (
      result.runtimeTuple as { checkpoint?: { channel_values?: Record<string, unknown> } }
    ).checkpoint?.channel_values
    expect(runtimeValues).toMatchObject({
      todos: [{ id: "todo-1", content: "legacy todo", status: "pending" }]
    })
    expect(runtimeValues && "messages" in runtimeValues).toBe(false)

    const durableDatabase = new DatabaseSync(messageDatabasePath, { readOnly: true })
    const durableSummary = durableDatabase
      .prepare(
        `SELECT COUNT(*) AS total, MAX(ordinal) AS max_ordinal,
                (SELECT ordinal FROM thread_messages
                 WHERE thread_id = ? AND message_id = 'live-tail') AS live_ordinal,
                (SELECT status FROM legacy_checkpoint_transcript_migrations
                 WHERE thread_id = ?) AS migration_status
         FROM thread_messages WHERE thread_id = ?`
      )
      .get(threadId, threadId, threadId) as {
      total: number
      max_ordinal: number
      live_ordinal: number
      migration_status: string
    }
    durableDatabase.close()
    expect(Number(durableSummary.total)).toBe(564)
    expect(Number(durableSummary.max_ordinal)).toBe(563)
    expect(Number(durableSummary.live_ordinal)).toBe(563)
    expect(durableSummary.migration_status).toBe("complete")

    const hydrationDatabase = openThreadMessageHydrationDatabase(messageDatabasePath)
    const page = readThreadMessagesPage(hydrationDatabase, {
      type: "read-page",
      requestId: 1,
      databasePath: messageDatabasePath,
      threadId,
      options: { limit: 128, byteBudget: 1024 * 1024 },
      cancellationBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    }).page
    hydrationDatabase.close()
    expect(page.messages).toHaveLength(128)
    expect(page.total).toBe(564)
    expect(page.hasMore).toBe(true)
    expect(page.messages.at(-1)).toMatchObject({ id: "live-tail", content: "live" })
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(1024 * 1024)

    const repeated = await client.bootstrapLegacyTranscript(
      databasePath,
      messageDatabasePath,
      threadId
    )
    expect(repeated.stats.migratedMessages).toBe(0)
    const repeatedDatabase = new DatabaseSync(messageDatabasePath, { readOnly: true })
    const repeatedCount = repeatedDatabase
      .prepare("SELECT COUNT(*) AS total FROM thread_messages WHERE thread_id = ?")
      .get(threadId) as { total: number }
    repeatedDatabase.close()
    expect(Number(repeatedCount.total)).toBe(564)
  }, 30_000)

  it("imports one oversized legacy text message through resumable fragment transactions", async () => {
    const threadId = "legacy-oversized-message"
    const content = `${"x".repeat(5 * 1024 * 1024)}😀tail`
    const { databasePath } = await seedLegacyInlineFixture({
      threadId,
      messages: [{ id: "oversized", role: "assistant", content }]
    })
    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    const client = createClient()

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const result = await client.bootstrapLegacyTranscript(
      databasePath,
      messageDatabasePath,
      threadId
    )
    clearInterval(ticker)

    expect(ticks).toBeGreaterThan(0)
    expect(result.stats.totalMessages).toBe(1)
    expect(result.stats.migratedMessages).toBe(1)
    expect(result.stats.batches).toBeGreaterThan(5)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024)

    const database = new DatabaseSync(messageDatabasePath, { readOnly: true })
    const summary = database
      .prepare(
        `SELECT COUNT(*) AS fragment_count,
                SUM(length(content_text)) AS total_chars,
                MAX(length(CAST(content_text AS BLOB))) AS max_fragment_bytes,
                (SELECT content_json FROM thread_messages
                 WHERE thread_id = ? AND message_id = 'oversized') AS base_content,
                (SELECT current_fragment_index FROM legacy_checkpoint_transcript_migrations
                 WHERE thread_id = ?) AS fragment_cursor,
                (SELECT total_chars FROM thread_message_fragment_states
                 WHERE thread_id = ? AND message_id = 'oversized') AS state_total_chars
         FROM thread_message_fragments
         WHERE thread_id = ? AND message_id = 'oversized'`
      )
      .get(threadId, threadId, threadId, threadId) as Record<string, unknown>
    const tail = database
      .prepare(
        `SELECT content_text FROM thread_message_fragments
         WHERE thread_id = ? AND message_id = 'oversized'
         ORDER BY fragment_id DESC LIMIT 1`
      )
      .get(threadId) as { content_text?: unknown }
    database.close()

    expect(Number(summary.fragment_count)).toBeGreaterThan(5)
    expect(Number(summary.total_chars)).toBe(Array.from(content).length)
    expect(Number(summary.state_total_chars)).toBe(content.length)
    expect(Number(summary.max_fragment_bytes)).toBeLessThanOrEqual(64 * 1024)
    expect(summary.base_content).toBe('""')
    expect(Number(summary.fragment_cursor)).toBe(0)
    expect(String(tail.content_text)).toContain("😀tail")
  }, 30_000)

  it("migrates a real multi-megabyte legacy transcript without stopping the main ticker", async () => {
    const threadId = "legacy-large-runtime"
    const messages = Array.from({ length: 563 }, (_, index) => ({
      id: `legacy-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}:`.padEnd(3_250, "x")
    }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId,
      messages
    })
    const client = createClient()

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    let stats
    try {
      stats = await client.ensureRuntimeProjection(databasePath, threadId)
    } finally {
      clearInterval(ticker)
    }

    expect(stats.sourceBytes).toBeGreaterThan(1.7 * 1024 * 1024)
    expect(stats.projectionBytes).toBeLessThan(64 * 1024)
    expect(stats.inlineMessageCount).toBe(563)
    expect(stats.migrated).toBe(true)
    expect(ticks).toBeGreaterThan(0)

    const raw = new DatabaseSync(databasePath, { readOnly: true })
    const sizes = raw
      .prepare(
        `SELECT LENGTH(checkpoint) AS checkpoint_bytes,
                (SELECT LENGTH(runtime_checkpoint)
                 FROM checkpoint_runtime_projections
                 WHERE thread_id = ? AND checkpoint_ns = '') AS projection_bytes,
                (SELECT message_count
                 FROM checkpoint_message_snapshots
                 WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?) AS message_count
         FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(
        threadId,
        threadId,
        legacyCheckpoint.id,
        threadId,
        legacyCheckpoint.id
      ) as { checkpoint_bytes: number; projection_bytes: number; message_count: number }
    raw.close()
    expect(Number(sizes.checkpoint_bytes)).toBeLessThan(64 * 1024)
    expect(Number(sizes.projection_bytes)).toBeLessThan(64 * 1024)
    expect(Number(sizes.message_count)).toBe(563)

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const saver = new SqlJsSaver(databasePath)
      const observedBytes: number[] = []
      saver.serde = rejectLargeDeserialization(saver.serde, 64 * 1024, observedBytes)
      const tuple = await saver.getLatestRuntimeTuple(config(threadId))
      expect(tuple?.checkpoint.id).toBe(legacyCheckpoint.id)
      expect(tuple?.checkpoint.channel_values).toMatchObject({
        todos: [{ id: "todo-1", content: "legacy todo", status: "pending" }]
      })
      expect("unrelated" in tuple!.checkpoint.channel_values).toBe(false)
      expect("messages" in tuple!.checkpoint.channel_values).toBe(false)
      expect(Math.max(0, ...observedBytes)).toBeLessThan(64 * 1024)
      await saver.close()
    }

    let largeMainJsonParses = 0
    const originalJsonParse = JSON.parse
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (text.length >= 64 * 1024) largeMainJsonParses += 1
      return originalJsonParse(text, reviver)
    }) as JSON["parse"]
    let fullTuple: unknown
    try {
      fullTuple = await client.readLatestTuple(databasePath, threadId)
    } finally {
      JSON.parse = originalJsonParse
    }
    const restoredMessages = (
      fullTuple as { checkpoint?: { channel_values?: { messages?: unknown[] } } }
    ).checkpoint?.channel_values?.messages
    expect(restoredMessages).toHaveLength(563)
    expect(restoredMessages?.at(-1)).toMatchObject({ id: "legacy-562" })
    expect(largeMainJsonParses).toBe(0)

    const boundedTuple = await client.readLatestTuple(databasePath, threadId, "", {
      messageLimit: 128,
      messageByteBudget: 1024 * 1024
    })
    const boundedCheckpoint = boundedTuple as {
      checkpoint?: {
        channel_values?: {
          messages?: unknown[]
          __cmb_original_message_count?: number
        }
      }
      metadata?: unknown
      pendingWrites?: unknown
    }
    expect(boundedCheckpoint.checkpoint?.channel_values?.messages).toHaveLength(128)
    expect(
      boundedCheckpoint.checkpoint?.channel_values?.__cmb_original_message_count
    ).toBe(563)
    expect("metadata" in boundedCheckpoint).toBe(false)
    expect("pendingWrites" in boundedCheckpoint).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(boundedCheckpoint), "utf8")).toBeLessThan(
      1024 * 1024
    )
  }, 30_000)

  it("does not let a prepared legacy migration overwrite a concurrent newer put", async () => {
    const threadId = "legacy-cas"
    const messages = Array.from({ length: 520 }, (_, index) => ({
      id: `old-${index}`,
      role: "assistant",
      content: "old".repeat(1_000)
    }))
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages })
    const migrationDatabase = new DatabaseSync(databasePath, { timeout: 5_000 })
    const prepared = prepareLatestRuntimeProjectionMigration(migrationDatabase, threadId)
    expect(prepared).not.toBeNull()

    const writer = new SqlJsSaver(databasePath)
    await writer.put(
      config(threadId, "legacy-inline"),
      checkpoint(
        "newer-checkpoint",
        2,
        [{ id: "new", role: "assistant", content: "authoritative" }],
        "new todo"
      ),
      metadata
    )
    await writer.close()

    expect(commitPreparedRuntimeProjection(migrationDatabase, prepared!)).toBe(false)
    migrationDatabase.close()

    const verifier = new SqlJsSaver(databasePath)
    const tuple = await verifier.getLatestRuntimeTuple(config(threadId))
    expect(tuple?.checkpoint.id).toBe("newer-checkpoint")
    expect(tuple?.checkpoint.channel_values).toMatchObject({
      todos: [{ id: "todo-1", content: "new todo", status: "pending" }]
    })
    await verifier.close()
  }, 30_000)
})
