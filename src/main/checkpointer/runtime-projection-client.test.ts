import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  Checkpoint,
  CheckpointMetadata,
  SerializerProtocol
} from "@langchain/langgraph-checkpoint"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
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
import { sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { installThreadSearchSchema } from "../thread-search/schema"
import { coversLegacyOverlap, createLegacyOverlapProof } from "./legacy-checkpoint-source"
import { persistedMessageToRuntimeMessage } from "../ipc/persisted-runtime-message"
import { persistedMessageFromStreamPayload } from "../ipc/stream-transcript-payload"
import type { Message } from "../types"
import { selectStreamTranscriptValueSnapshots } from "../ipc/stream-transcript-values"
import { projectChatSearchPlan } from "../../shared/chat-search-index"
import { createThreadSearchMessagePlan } from "../../shared/thread-search-projection"
import { normalizeMessageContent } from "../../shared/thread-message-content"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED,
  CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
} from "./runtime-projection-protocol"
import {
  openThreadMessageHydrationDatabase,
  readThreadMessagesPage
} from "../thread-message-hydration/page-reader"
import { buildWorkerCheckpointHistory } from "../../renderer/src/lib/worker-checkpoint-history"
import { buildToolResultAssociations } from "../../renderer/src/lib/worker-tool-result-key"
import { GOAL_CONTINUATION_BOUNDARY_METADATA_KEY } from "../agent/goals/internal-prompt"
import {
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"
import {
  createStreamDataSerializer,
  sanitizeCoordinatorWorkerStreamDataForRenderer
} from "../ipc/stream-data-serialization"

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
      reasoning TEXT,
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

function installVersionedLegacyFixtureSchema(database: DatabaseSync): void {
  database.exec(`PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle';
    ALTER TABLE threads ADD COLUMN metadata TEXT;
    ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE thread_goal_events (thread_id TEXT NOT NULL);
    CREATE INDEX idx_thread_messages_thread_order ON thread_messages(thread_id, ordinal, created_at);
    CREATE INDEX idx_thread_message_fragments_message ON thread_message_fragments(thread_id, message_id, fragment_id);`)
  installThreadSearchSchema({ run: (sql) => database.exec(sql) }, (table, column) =>
    database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column))
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
    const messageDatabase = new DatabaseSync(messageDatabasePath)
    messageDatabase.exec(`ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'busy';
      ALTER TABLE threads ADD COLUMN metadata TEXT DEFAULT '{}';`)
    const thread = messageDatabase.prepare("SELECT created_at FROM threads WHERE thread_id = ?").get(threadId)
    const incarnation = { token: null, legacyCreatedAt: Number(thread?.created_at) }
    const sourceDb = new DatabaseSync(databasePath)
    const checkpointRowId = () => Number(sourceDb.prepare("SELECT rowid FROM checkpoints").get()?.rowid)
    const guard = { incarnation, checkpointId: legacyCheckpoint.id, checkpointRowId: checkpointRowId(), recoverySuffix: "" }
    await expect(client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId, "", undefined, { guard }))
      .rejects.toMatchObject({ name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED" })
    expect(messageDatabase.prepare("SELECT count(*) AS count FROM thread_messages").get()?.count).toBe(0)
    messageDatabase.exec("UPDATE threads SET status = 'idle'")
    messageDatabase.close()
    await expect(client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId, "", undefined,
      { guard: { ...guard, checkpointId: "obsolete" } })).rejects.toMatchObject({ name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED" })
    sourceDb.exec("INSERT OR REPLACE INTO checkpoints SELECT * FROM checkpoints")
    const replacement = { ...guard, checkpointRowId: checkpointRowId() }
    sourceDb.close()
    expect(replacement.checkpointRowId).not.toBe(guard.checkpointRowId)
    await expect(client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId, "", undefined, { guard }))
      .rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
    await expect(
      client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId, "", undefined, { guard: replacement })
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

  it("cancels a scheduled search backfill before its worker starts", async () => {
    const { promise, resolve } = Promise.withResolvers<Worker>()
    const client = new CheckpointRuntimeProjectionClient(() => promise)
    const emitter = new EventEmitter()
    const send = vi.fn(() => emitter.emit("exit", 0))
    const worker = Object.assign(emitter, {
      postMessage: send,
      unref: () => {},
      terminate: async () => 0
    }) as unknown as Worker
    const controller = new AbortController()
    const request = client.bootstrapLegacyTranscript("checkpoint.sqlite", "messages.sqlite", "thread", "", undefined, {
      guard: {
        incarnation: { token: null, legacyCreatedAt: 1 },
        checkpointId: "checkpoint",
        checkpointRowId: 1,
        recoverySuffix: ""
      },
      signal: controller.signal
    })
    try {
      controller.abort()
      await expect(request).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
      resolve(worker)
      await new Promise<void>((done) => setImmediate(done))
      expect(send).not.toHaveBeenCalled()
    } finally {
      resolve(worker)
      await client.close()
    }
  })

  it("rolls back every published batch when a guarded migration fails late", async () => {
    const threadId = "thread-atomic-search-backfill"
    const messages = Array.from({ length: 66 }, (_, index) => ({
      id: `legacy-${index}`,
      type: "human",
      content: `saved ${index}`
    }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const source = new DatabaseSync(databasePath, { readOnly: true })
    const checkpointRowId = Number(source.prepare("SELECT rowid FROM checkpoints").get()?.rowid)
    source.close()
    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    const durable = new DatabaseSync(messageDatabasePath)
    try {
      durable.exec(`
        ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle';
        ALTER TABLE threads ADD COLUMN metadata TEXT DEFAULT '{}';
        CREATE TRIGGER reject_late_legacy_import BEFORE INSERT ON thread_messages
        WHEN NEW.message_id = 'legacy-65'
        BEGIN SELECT RAISE(ABORT, 'rejected late fixture row'); END;
      `)
      const legacyCreatedAt = Number(durable.prepare("SELECT created_at FROM threads").get()?.created_at)
      const call = () => createClient().bootstrapLegacyTranscript(
        databasePath, messageDatabasePath, threadId, "", undefined,
        { guard: { incarnation: { token: null, legacyCreatedAt }, checkpointId: legacyCheckpoint.id,
          checkpointRowId, recoverySuffix: "" } }
      )
      await expect(call()).rejects.toThrow("rejected late fixture row")
      expect(durable.prepare("SELECT COUNT(*) AS n FROM thread_messages").get()?.n).toBe(0)
      expect(durable.prepare("SELECT COUNT(*) AS n FROM legacy_checkpoint_transcript_migrations").get()?.n).toBe(0)

      // A previously interrupted foreground import already published its first batch.
      await expect(createClient().bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId))
        .rejects.toThrow("rejected late fixture row")
      expect(durable.prepare("SELECT next_index, status FROM legacy_checkpoint_transcript_migrations").get())
        .toMatchObject({ next_index: 64, status: "migrating" })
      durable.exec("DROP TRIGGER reject_late_legacy_import")
      await expect(call()).resolves.toMatchObject({ stats: { migratedMessages: 2 } })
      expect(durable.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all())
        .toEqual(messages.map((message) => ({ message_id: message.id })))
      expect(durable.prepare("SELECT status FROM legacy_checkpoint_transcript_migrations").get())
        .toMatchObject({ status: "complete" })
    } finally {
      durable.close()
    }
  })

  it("opens a valid backup-only thread above the background recovery budget", async () => {
    const threadId = "large-backup-only"
    const { databasePath } = await seedLegacyInlineFixture({
      threadId, messages: [{ id: "visible", type: "human", content: "old saved question" }]
    })
    const source = new DatabaseSync(databasePath)
    source.exec("CREATE TABLE padding (content BLOB); INSERT INTO padding VALUES (zeroblob(9437184))")
    source.close()
    renameSync(databasePath, databasePath + ".bak")
    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    const client = createClient()
    await expect(client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId, "", undefined, {
      guard: { incarnation: { token: null, legacyCreatedAt: 1 } }
    })).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
    expect(existsSync(databasePath)).toBe(false)
    await expect(client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId))
      .resolves.toMatchObject({ stats: { totalMessages: 1, migratedMessages: 1 } })
    expect(existsSync(databasePath)).toBe(false)
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

  it.each([false, true])(
    "reconciles lossless and projected worker checkpoint identities (SQL fallback: %s)",
    async (oversized) => {
      const threadId = "worker-identity-transfer"
      const ascii = "p".repeat(256)
      const supplementary = "😀".repeat(128)
      const longSource =
        "x".repeat(4095) + '😀"\\\u0000\ud840' + (oversized ? "x".repeat(65_536) : "")
      const blankSource = " \n\u3000".repeat(800)
      const longToolId = "x".repeat(12_000) + '😀\u0000"\\\ud840'
      const toolIds = [supplementary, longToolId + "1", longToolId + "2"]
      const messages = [
        { id: "user", type: "human", content: "request" },
        ...[
          ["exact-ascii", ascii],
          ["ascii-alias", ascii],
          ["long-source-draft", longSource],
          ["long-source-corrected", longSource],
          ["distinct-a", longSource + "a"],
          ["distinct-b", longSource + "b"],
          ["exact-supplementary", supplementary],
          ["too-many-code-units", supplementary + "!"],
          ["encoded-nul", "before\u0000after"],
          ["encoded-surrogate", "\ud840"],
          ["blank-source", blankSource]
        ].map(([id, source]) => ({
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id,
            content: id,
            ...(oversized && { response_metadata: { ignored: "x".repeat(65_536) } }),
            additional_kwargs: {
              cmb_internal_provider_source_id: source,
              cmb_internal_provider_occurrence: 1
            }
          }
        })),
        {
          id: "requests",
          type: "ai",
          content: "requests",
          tool_calls: toolIds.map((id) => ({ id, name: "read_file", args: {} })),
          ...(oversized && { response_metadata: { ignored: "x".repeat(65_536) } })
        },
        ...["exact-call", "long-call-a", "long-call-b"].map((id, index) => ({
          id,
          type: "tool",
          content: id,
          tool_call_id: toolIds[index],
          ...(oversized && { response_metadata: { ignored: "x".repeat(65_536) } }),
          additional_kwargs: {
            cmb_internal_provider_source_id: "tool-source",
            cmb_internal_provider_occurrence: 1
          }
        }))
      ]
      const { databasePath } = await seedLegacyInlineFixture({ threadId, messages })
      const tuple = (await createClient().readLatestTuple(databasePath, threadId, "", {
        messageLimit: 500,
        messageByteBudget: 1024 * 1024
      })) as {
        checkpoint: { channel_values: { messages: unknown[] } }
      }
      const projected = buildWorkerCheckpointHistory(
        tuple.checkpoint.channel_values.messages,
        threadId
      ).messages
      expect(projected.map((row) => row.content)).toEqual([
        "request",
        "ascii-alias",
        "long-source-corrected",
        "distinct-a",
        "distinct-b",
        "exact-supplementary",
        "too-many-code-units",
        "encoded-nul",
        "encoded-surrogate",
        "blank-source",
        "requests",
        "exact-call",
        "long-call-a",
        "long-call-b"
      ])
      const byContent = new Map(projected.map((row) => [row.content, row]))
      const scope = `worker-turn-${threadId}-1::`
      const hashedProvider = (source: string): string =>
        "cmb-checkpoint-provider-id:sha256:" +
        createHash("sha256").update(JSON.stringify(source)).digest("hex")
      for (const [content, source] of [
        ["ascii-alias", ascii],
        ["long-source-corrected", hashedProvider(longSource)],
        ["distinct-a", hashedProvider(longSource + "a")],
        ["distinct-b", hashedProvider(longSource + "b")],
        ["exact-supplementary", supplementary],
        ["too-many-code-units", hashedProvider(supplementary + "!")],
        ["encoded-nul", "before\u0000after"],
        ["encoded-surrogate", "\ud840"],
        ["exact-call", "tool-source"]
      ]) {
        expect(byContent.get(content)).toMatchObject({
          provider_source_id: scope + source,
          provider_occurrence: 1,
          worker_provider_identity: true
        })
      }
      expect(byContent.get("exact-call")?.tool_call_id).toBe(supplementary)
      expect(byContent.get("blank-source")?.worker_provider_identity).toBeUndefined()
      const expectedIds = toolIds.map((id, index) =>
        index === 0
          ? id
          : "cmb-checkpoint-tool-id:sha256:" +
            createHash("sha256").update(JSON.stringify(id)).digest("hex")
      )
      expect(byContent.get("requests")?.tool_calls?.map(({ id }) => id)).toEqual(expectedIds)
      expect(byContent.get("long-call-a")?.tool_call_id).toBe(expectedIds[1])
      expect(byContent.get("long-call-b")?.tool_call_id).toBe(expectedIds[2])
      expect(
        [...buildToolResultAssociations(projected).values()].map(({ content }) => content)
      ).toEqual(["exact-call", "long-call-a", "long-call-b"])

      const live = createStreamDataSerializer()("values", {
        messages: [
          new AIMessage({
            content: "long-source-corrected",
            additional_kwargs: {
              cmb_internal_provider_source_id: longSource,
              cmb_internal_provider_occurrence: 1
            }
          }),
          new AIMessage({
            content: "requests",
            tool_calls: toolIds.map((id) => ({ id, name: "read_file", args: {} }))
          }),
          ...toolIds.map((id) => new ToolMessage({ content: "result", tool_call_id: id }))
        ]
      })
      expect(
        sanitizeCoordinatorWorkerStreamDataForRenderer(
          "values",
          live.data,
          live.valuesMessageIndexOffset
        )
      ).toMatchObject({
        messages: [
          {
            kwargs: {
              additional_kwargs: {
                cmb_internal_provider_source_id: hashedProvider(longSource),
                cmb_internal_provider_occurrence: 1
              }
            }
          },
          { kwargs: { tool_calls: expectedIds.map((id) => ({ id })) } },
          ...expectedIds.map((id) => ({ kwargs: { tool_call_id: id } }))
        ]
      })
    }
  )

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
    legacyDatabase.exec(
      "DELETE FROM checkpoint_schema_migrations WHERE migration_id = 'checkpoint-message-generation-v1'"
    )
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

  it.each(["contained", "append", "interior", "interior-with-ordinal-gap", "sparse-prefix"])(
    "preserves durable order and exact checkpoint membership (%s)", async (mode) => {
    const threadId = "existing-durable-prefix"
    const missing = mode !== "contained"
    const sparsePrefix = mode === "sparse-prefix"
    const interior = mode.startsWith("interior") || sparsePrefix
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId,
      messages: [
        ...(sparsePrefix ? [{ id: "prefix", type: "ai", content: "Old checkpoint prefix" }] : []),
        { id: "tail", type: "ai", content: "Current checkpoint tail" },
        ...(missing ? [{ id: "answer", type: "ai", content: "New checkpoint answer" }] : []),
        ...(interior ? [{ id: "next", type: "ai", content: "Known later row" }] : [])
      ]
    })
    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(messageDatabasePath)
    try {
      db.exec("ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle'; ALTER TABLE threads ADD COLUMN metadata TEXT")
      const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
        .get(threadId)?.created_at)
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id,message_id,role,content_json,created_at,ordinal)
        VALUES (?, ?, 'assistant', ?, ?, ?)`)
      if (!sparsePrefix) insert.run(threadId, "older", JSON.stringify("Durable history"), 1, 0)
      insert.run(threadId, "tail", JSON.stringify("Current checkpoint tail"), 2, sparsePrefix ? 0 : 1)
      if (interior) {
        insert.run(threadId, "next", JSON.stringify("Known later row"), 3,
          mode === "interior-with-ordinal-gap" || sparsePrefix ? 4 : 2)
      }
      if (sparsePrefix) insert.run(threadId, "after", JSON.stringify("Durable remainder"), 4, 5)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(
        databasePath, messageDatabasePath, threadId, "", undefined,
        { guard: { incarnation: { token: null, legacyCreatedAt } } }
      )).resolves.toMatchObject({ stats: { migratedMessages: Number(missing) + Number(sparsePrefix) } })
      expect(db.prepare("SELECT message_id FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
        .all(threadId).map((row) => row.message_id)).toEqual([
        sparsePrefix ? "prefix" : "older", "tail", ...(missing ? ["answer"] : []),
        ...(interior ? ["next"] : []), ...(sparsePrefix ? ["after"] : [])
      ])
      expect(db.prepare("SELECT status FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)).toMatchObject({ status: "complete" })
      // Recovery membership keeps source order even if the durable window
      // later assigns another ordinal to an existing message.
      if (interior) db.prepare(`UPDATE thread_messages SET ordinal = 99
        WHERE thread_id = ? AND message_id = 'tail'`).run(threadId)
      const recovered = readThreadMessagesPage(db, {
        type: "read-page", requestId: 1, databasePath: messageDatabasePath, threadId,
        options: {
          recoveryCheckpointId: legacyCheckpoint.id,
          notAfterCreatedAt: Date.parse(legacyCheckpoint.ts),
          includeVisibleMessagePresence: true
        },
        cancellationBuffer: new SharedArrayBuffer(4)
      }).page
      expect(recovered.messages.map((message) => message.id)).toEqual([
        ...(sparsePrefix ? ["prefix"] : []), "tail", ...(missing ? ["answer"] : []),
        ...(interior ? ["next"] : [])
      ])
      expect(recovered.hasMore).toBe(false)
    } finally {
      db.close()
    }
  })

  it.each(["new checkpoint", "same checkpoint replaced"])(
    "revalidates a completed legacy transcript after %s", async (mode) => {
      const threadId = "advanced-legacy-source"
      const first = { id: "first", type: "human", content: "original conversation" }
      const second = { id: "second", type: "ai", content: "new checkpoint-only answer" }
      const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [first] })
      const durablePath = createMessageDatabase(databasePath, threadId)
      const db = new DatabaseSync(durablePath)
      try {
        db.exec(`ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle';
          ALTER TABLE threads ADD COLUMN metadata TEXT;`)
        const client = createClient()
        const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        await expect(bootstrap()).resolves.toMatchObject({ stats: { migratedMessages: 1 } })
        const marker = db.prepare(`SELECT checkpoint_id, source_key FROM legacy_checkpoint_transcript_migrations
          WHERE thread_id = ?`)
        const before = marker.get(threadId)?.source_key
        expect(before).toBe(sqliteRecoveryFamilyKey(databasePath))
        const changed = mode === "new checkpoint"
          ? checkpoint("new-legacy", 2, [first, second])
          : checkpoint(legacyCheckpoint.id, 1, [first, second])
        if (mode === "new checkpoint") {
          const saver = new SqlJsSaver(databasePath)
          await saver.put(config(threadId, legacyCheckpoint.id), changed, metadata)
          await saver.close()
        } else {
          const original = new DatabaseSync(databasePath)
          try {
            original.prepare(`UPDATE checkpoints SET type = 'json', checkpoint = ?
              WHERE thread_id = ? AND checkpoint_id = ?`).run(JSON.stringify(changed), threadId, changed.id)
          } finally { original.close() }
        }
        const current = sqliteRecoveryFamilyKey(databasePath)
        expect(current).not.toBe(before)
        const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
          .get(threadId)?.created_at)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined,
          { guard: { sourceKey: current, incarnation: { token: null, legacyCreatedAt } } }
        )).resolves.toMatchObject({ stats: { migratedMessages: 1 } })
        expect(marker.get(threadId)).toEqual({ checkpoint_id: changed.id, source_key: current })
        expect(db.prepare("SELECT message_id FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
          .all(threadId).map((row) => row.message_id)).toEqual(["first", "second"])
        if (mode === "new checkpoint") {
          const recovered = readThreadMessagesPage(db, {
            type: "read-page", requestId: 1, databasePath: durablePath, threadId,
            checkpointDirectory: dirname(databasePath),
            options: { includeVisibleMessagePresence: true, recoveryCheckpointId: legacyCheckpoint.id,
              notAfterCreatedAt: Date.parse(legacyCheckpoint.ts) },
            cancellationBuffer: new SharedArrayBuffer(4)
          }).page
          expect(recovered.messages.map((message) => message.id)).toEqual(["first"])
          expect(recovered.legacyCheckpointMigrationStatus).toBe("complete")
        }
      } finally {
        db.close()
      }
    }, 30_000
  )

  it.each(["foreground directly", "background before foreground", "durable rows without a marker"])(
    "preserves the original positional time archive when revalidating a legacy marker (%s)", async (mode) => {
      const threadId = "original-positional-times"
      const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
        threadId,
        messages: ["first", "second"].map((id) => ({ id, type: "human", content: id }))
      })
      const durablePath = createMessageDatabase(databasePath, threadId)
      const client = createClient()
      const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await bootstrap()
      const db = new DatabaseSync(durablePath)
      try {
        db.exec(`ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle';
          ALTER TABLE threads ADD COLUMN metadata TEXT;
          ALTER TABLE threads ADD COLUMN thread_values TEXT;
          CREATE TABLE thread_legacy_message_times (thread_id TEXT PRIMARY KEY,
            values_json TEXT NOT NULL, applied_checkpoint_id TEXT);
          UPDATE legacy_checkpoint_transcript_migrations SET source_key = NULL, timing_checkpoint_id = NULL;
          DELETE FROM legacy_checkpoint_transcript_source_ids;`)
        if (mode === "durable rows without a marker") {
          db.exec(`DELETE FROM legacy_checkpoint_transcript_migrations;
            DELETE FROM legacy_checkpoint_transcript_sources;
            DELETE FROM legacy_checkpoint_transcript_imports;`)
        }
        db.prepare("UPDATE threads SET thread_values = ? WHERE thread_id = ?").run(JSON.stringify({
          messageTimeOrder: [{ start_at: 100, end_at: 200 }, { start_at: 300, end_at: 400 }]
        }), threadId)
        if (mode === "background before foreground") {
          const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
            .get(threadId)?.created_at)
          await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined, {
            guard: {
              sourceKey: sqliteRecoveryFamilyKey(databasePath),
              incarnation: { token: null, legacyCreatedAt }
            }
          })
        }
        await bootstrap()
        expect(db.prepare("SELECT start_at, end_at FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
          .all(threadId)).toEqual([{ start_at: 100, end_at: 200 }, { start_at: 300, end_at: 400 }])
        expect(db.prepare("SELECT applied_checkpoint_id FROM thread_legacy_message_times WHERE thread_id = ?")
          .get(threadId)?.applied_checkpoint_id).toBe(legacyCheckpoint.id)
      } finally {
        db.close()
      }
    }, 30_000
  )

  it.each(["replaced source row", "changed anchored source body"])(
    "keeps an interrupted copy partial for a same-ID %s", async (mode) => {
    const threadId = "changed-interrupted-source"
    const messages = Array.from({ length: 70 }, (_, index) => ({
      id: `m${index}`, type: "ai", content: `checkpoint message ${index}`
    }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      db.exec(`CREATE TRIGGER break_copy BEFORE INSERT ON thread_messages
        WHEN NEW.message_id = 'm65' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;`)
      if (mode === "changed anchored source body") {
        db.prepare(`INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
          VALUES (?, 'm0', 'assistant', ?, 1, 0)`).run(threadId, JSON.stringify(messages[0].content))
      }
      const client = createClient()
      const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await expect(bootstrap()).rejects.toThrow("fixture interruption")
      db.exec("DROP TRIGGER break_copy")
      messages[14] = { id: mode === "replaced source row" ? "replaced" : "m14", type: "ai",
        content: "different committed prefix" }
      const saver = new SqlJsSaver(databasePath)
      await saver.put(config(threadId), checkpoint(legacyCheckpoint.id, 1, messages), metadata)
      await saver.close()
      await expect(bootstrap()).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
      expect(db.prepare("SELECT status, next_index, source_key FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)).toEqual({ status: "migrating", next_index: 64, source_key: null })
    } finally {
      db.close()
    }
  }, 30_000)

  it("does not verify a changed body from a completed copy as an existing durable match", async () => {
    const threadId = "replaced-imported-body"
    const original = { id: "answer", type: "ai", content: "original body" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [original] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const client = createClient()
    const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
    await bootstrap()
    const saver = new SqlJsSaver(databasePath)
    await saver.put(config(threadId), checkpoint(legacyCheckpoint.id, 1, [
      { ...original, content: "replacement body" }
    ]), metadata)
    await saver.close()
    await expect(bootstrap()).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
    const durable = new DatabaseSync(durablePath, { readOnly: true })
    try {
      expect(durable.prepare("SELECT content_json FROM thread_messages WHERE thread_id = ?")
        .get(threadId)?.content_json).toBe(JSON.stringify(original.content))
      expect(durable.prepare("SELECT source_key FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)?.source_key).not.toBe(sqliteRecoveryFamilyKey(databasePath))
    } finally {
      durable.close()
    }
  }, 30_000)

  it("reuses an edited durable anchor when the newer checkpoint agrees with it", async () => {
    const threadId = "edited-durable-anchor"
    const anchor = { id: "answer", type: "ai", content: "original body" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [anchor] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const client = createClient()
    const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
    await bootstrap()
    const revised = { ...anchor, content: "durable correction" }
    const tail = { id: "new-tail", type: "human", content: "only in the new checkpoint" }
    const durable = new DatabaseSync(durablePath)
    try {
      durable.prepare("UPDATE thread_messages SET content_json = ? WHERE thread_id = ? AND message_id = ?")
        .run(JSON.stringify(revised.content), threadId, anchor.id)
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("current", 2, [revised, tail]), metadata)
      } finally { await saver.close() }
      await expect(bootstrap()).resolves.toMatchObject({ stats: { migratedMessages: 1 } })
      expect(durable.prepare("SELECT message_id FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
        .all(threadId).map((row) => row.message_id)).toEqual([anchor.id, tail.id])
    } finally { durable.close() }
  }, 30_000)

  it.each(["missing answer", "partial answer", "structured answer", "missing tool snapshot",
    "missing reasoning snapshot", "empty reasoning wrapper", "Unicode whitespace reasoning", "lossy tool snapshot",
    "untagged partial answer", "untagged conflicting answer", "untagged cumulative prefix", "untagged wide durable body"])(
    "recovers a native %s from the saved checkpoint", async (mode) => {
    const threadId = "native-checkpoint-gap"
    const reasoningFixture = mode === "missing reasoning snapshot" || mode === "empty reasoning wrapper" ||
      mode === "Unicode whitespace reasoning"
    const answer = reasoningFixture ? "<think>separate reasoning</think>published reply" : "saved checkpoint answer"
    const wideBody = mode === "untagged wide durable body" ? answer + " repeated text".repeat(440) : undefined
    const restoredContent = mode === "structured answer" ? [{ type: "text", text: answer }] : answer
    const toolFixture = mode === "missing tool snapshot" || mode === "lossy tool snapshot"
    const tools = [{ id: "saved-tool", name: "read_file",
      args: { file_path: mode === "lossy tool snapshot" ? "x".repeat(530_000) : "checkpoint-only.txt" } }]
    const messages = [{ id: "question", type: "human", content: "sent" },
      { id: "answer", type: "ai", content: restoredContent,
        ...(reasoningFixture ? { additional_kwargs: { reasoning: "separate reasoning" } } : {}),
        ...(toolFixture ? { tool_calls: tools } : {}) }]
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      db.exec(`CREATE TABLE legacy_checkpoint_transcript_migrations (
        thread_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, total_messages INTEGER NOT NULL,
        next_index INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, source_key TEXT
      ); ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1;
      ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0;`)
      if (!mode.startsWith("untagged")) {
        db.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
          (thread_id, checkpoint_id, total_messages, next_index, status, updated_at)
          VALUES (?, 'native-durable', 0, 0, 'complete', 1)`).run(threadId)
      }
      db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES (?, 'question', 'user', ?, 1, 0)`).run(threadId, JSON.stringify(messages[0].content))
      if (mode !== "missing answer") {
        const visible = mode === "structured answer" ? [{ type: "text", text: "saved checkpoint" }]
          : mode.endsWith("partial answer") || mode === "untagged cumulative prefix" ? "saved checkpoint"
          : mode === "untagged conflicting answer" ? "already saved different reply" : wideBody ?? answer
        db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
          VALUES (?, 'answer', 'assistant', ?, 1, 1)`).run(threadId, JSON.stringify(visible))
        if (mode === "untagged cumulative prefix" || wideBody) {
          db.prepare(`UPDATE thread_messages SET stream_authority = 1
            WHERE thread_id = ? AND message_id = 'answer'`).run(threadId)
        }
        if (reasoningFixture) {
          db.prepare("UPDATE thread_messages SET reasoning = ? WHERE thread_id = ? AND message_id = 'answer'")
            .run(mode === "empty reasoning wrapper" ? "<think>\n\t</think>"
              : mode === "Unicode whitespace reasoning" ? "\u3000\u202f" : "\n\t\u00a0", threadId)
        }
      }
      const client = createClient()
      const conflict = mode === "untagged conflicting answer"
      const cumulativePrefix = mode === "untagged cumulative prefix"
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: {
          migratedMessages: mode === "missing answer" ? 1 : 0,
          searchProjectionState: conflict || cumulativePrefix ? "overlap-unverified"
            : mode === "lossy tool snapshot" ? "truncated" : "complete"
        } })
      expect(db.prepare("SELECT message_id FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
        .all(threadId).map((row) => row.message_id)).toEqual(["question", "answer"])
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE thread_id = ? AND message_id = 'answer'")
        .get(threadId)?.content_json).toBe(JSON.stringify(conflict ? "already saved different reply"
          : cumulativePrefix ? "saved checkpoint" : wideBody ?? messages[1].content))
      if (reasoningFixture) {
        expect(db.prepare(`SELECT reasoning FROM thread_messages WHERE thread_id = ? AND message_id = 'answer'`)
          .get(threadId)?.reasoning).toBe("separate reasoning")
      }
      if (cumulativePrefix) {
        expect(db.prepare(`SELECT timing_checkpoint_id FROM legacy_checkpoint_transcript_migrations
          WHERE thread_id = ?`).get(threadId)?.timing_checkpoint_id).toBe("native-durable")
        db.prepare(`UPDATE thread_messages SET content_json = ?, end_at = 2
          WHERE thread_id = ? AND message_id = 'answer'`).run(JSON.stringify(answer), threadId)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
        expect(db.prepare("SELECT message_id FROM legacy_checkpoint_search_overlaps WHERE thread_id = ?")
          .all(threadId)).toEqual([])
      }
      if (toolFixture) {
        const row = db.prepare(`SELECT tool_calls_json, recovery_integrity FROM thread_messages
          WHERE thread_id = ? AND message_id = 'answer'`)
          .get(threadId)
        if (mode === "missing tool snapshot") expect(JSON.parse(String(row?.tool_calls_json))).toMatchObject(tools)
        else {
          expect(row?.recovery_integrity).toBe(0)
          expect(db.prepare(`SELECT content_key FROM legacy_checkpoint_transcript_source_ids
            WHERE thread_id = ? AND message_id = 'answer'`).get(threadId)?.content_key).toBeNull()
        }
      }
    } finally { db.close() }
  }, 30_000)

  it.each(["background", "foreground", "batched foreground"])("recovers auxiliary fields from a long %s transcript",
    async (mode) => {
    const threadId = "wide-stream-repair"
    const checkpointBody = "Initial published answer"
    const tools = [{ id: "legacy-read", name: "read_file", args: { path: "checkpoint-only.txt" } }]
    const fixtures = [
      { id: "body-head", head: checkpointBody + " persisted".repeat(1_300), fragments: [], authority: 1 },
      { id: "body-fragments", head: checkpointBody, fragments: [" continued".repeat(8_000)], authority: 1 },
      { id: "divergent-body", head: "Other published answer", fragments: [" unrelated".repeat(8_000)], authority: 1 },
      { id: "authoritative-fields", head: checkpointBody, fragments: [" kept".repeat(15_000)], authority: 7 }
    ]
    if (mode === "batched foreground") {
      const head = checkpointBody + " stored".repeat(15_000)
      fixtures.push(...Array.from({ length: 12 }, (_, index) =>
        ({ id: `batch-${index}`, head, fragments: [], authority: 1 })))
    }
    const messages = fixtures.map(({ id }) => ({
      id, type: "ai", content: checkpointBody, tool_calls: tools,
      additional_kwargs: { reasoning: "reasoning stored only in the checkpoint" }
    }))
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, ordinal, created_at, end_at, stream_authority)
        VALUES (?, ?, 'assistant', ?, ?, 1, 2, ?)`)
      const addFragment = db.prepare(`INSERT INTO thread_message_fragments
        (thread_id, message_id, content_text, created_at) VALUES (?, ?, ?, 1)`)
      for (const [index, row] of fixtures.entries()) {
        insert.run(threadId, row.id, JSON.stringify(row.head), index, row.authority)
        for (const fragment of row.fragments) addFragment.run(threadId, row.id, fragment)
      }
      const incarnation = { token: null, legacyCreatedAt:
        Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?").get(threadId)?.created_at) }
      const result = await createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined,
        mode === "background" ? { guard: { incarnation } } : undefined)
      expect(result.stats.searchProjectionState).toBe("overlap-unverified")
      const rows = db.prepare(`SELECT message_id, content_json, reasoning, tool_calls_json
        FROM thread_messages WHERE thread_id = ? ORDER BY ordinal`).all(threadId)
      const unresolved = db.prepare(`SELECT message_id FROM legacy_checkpoint_search_overlaps
        WHERE thread_id = ? ORDER BY message_id`).all(threadId)
      expect(unresolved.map((row) => row.message_id)).toEqual(["authoritative-fields", "divergent-body"])
      for (const [index, fixture] of fixtures.entries()) {
        const row = rows[index]
        const repaired = fixture.authority === 1 && fixture.head.startsWith(checkpointBody)
        expect(row.content_json).toBe(JSON.stringify(fixture.head))
        expect(row.reasoning).toBe(repaired ? messages[index].additional_kwargs.reasoning : null)
        if (repaired) expect(JSON.parse(String(row.tool_calls_json))).toMatchObject(tools)
        else expect(row.tool_calls_json).toBeNull()
      }
      expect(db.prepare("SELECT content_text FROM thread_message_fragments ORDER BY fragment_id").all()
        .map((row) => row.content_text)).toEqual(fixtures.flatMap((row) => row.fragments))
    } finally { db.close() }
  }, 30_000)

  it.each([
    { mode: "Unicode whitespace", reasoning: "\u3000\u202f", visible: false },
    { mode: "clipped empty wrapper", reasoning: `<think>${" ".repeat(119_987)}</think>`, visible: false },
    { mode: "clipped provider text", reasoning: "a".repeat(120_037) + "z", visible: true }
  ])("recovers the native reasoning alias with $mode", async ({ reasoning, visible }) => {
    const threadId = "native-reasoning-alias"
    const content = "<think>visible if standalone reasoning is blank</think>answer"
    const messages = [{ id: "answer", type: "ai", content, additional_kwargs: { reasoning_content: reasoning } }]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      db.exec(`CREATE TABLE legacy_checkpoint_transcript_migrations (
        thread_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, total_messages INTEGER NOT NULL,
        next_index INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL
      ); ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1;`)
      db.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
        VALUES (?, 'native-durable', 0, 0, 'complete', 1)`).run(threadId)
      db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES (?, 'answer', 'assistant', ?, 1, 0)`).run(threadId, JSON.stringify(content))
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      const row = db.prepare("SELECT reasoning, recovery_integrity FROM thread_messages WHERE thread_id = ?")
        .get(threadId)
      if (!visible) {
        expect(row).toMatchObject({ reasoning: null, recovery_integrity: 1 })
      } else {
        expect(row?.recovery_integrity).toBe(0)
        expect(String(row?.reasoning)).toMatch(/\[reasoning truncated\]$/)
        expect(db.prepare(`SELECT content_key FROM legacy_checkpoint_transcript_source_ids
          WHERE thread_id = ? AND checkpoint_id = ? AND message_id = 'answer'`)
          .get(threadId, legacyCheckpoint.id)?.content_key).toBeNull()
        const { page } = readThreadMessagesPage(db, {
          type: "read-page", requestId: 1, databasePath: durablePath, threadId,
          options: { recoveryCheckpointId: legacyCheckpoint.id },
          cancellationBuffer: new SharedArrayBuffer(4)
        })
        expect(page.recoveryIntegrity).toBe("unverified")
      }
    } finally { db.close() }
  }, 30_000)

  it.each([
    { mode: "Unicode whitespace", reasoning: "\u3000\u202f", state: "complete" },
    { mode: "clipped empty wrapper", reasoning: `<think>${" ".repeat(119_987)}</think>`, state: "truncated" },
    { mode: "clipped provider text", reasoning: "original explanation ".repeat(6000), state: "complete" },
    { mode: "a finalized durable overlap", reasoning: "", state: "unverified" }
  ])("resumes pre-upgrade migration with $mode", async ({ mode, reasoning, state }) => {
    const threadId = "interrupted-original-format"
    const content = "<think>inline history</think>answer"
    const messages = [
      { id: "answer", type: "ai", content, additional_kwargs: { reasoning_content: reasoning } },
      { id: "tail", type: "human", content: "unpublished historical tail" }
    ]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      const preserved = mode === "a finalized durable overlap" ? content + " with finalized live text" : content
      const createdAt = Date.parse(legacyCheckpoint.ts)
      db.exec(`CREATE TABLE legacy_checkpoint_transcript_migrations (
        thread_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, total_messages INTEGER NOT NULL,
        next_index INTEGER NOT NULL, current_fragment_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, updated_at INTEGER NOT NULL
      )`)
      db.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
        (thread_id, checkpoint_id, total_messages, next_index, status, updated_at)
        VALUES (?, ?, 2, 1, 'migrating', 1)`).run(threadId, legacyCheckpoint.id)
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, reasoning, created_at, end_at, ordinal)
        VALUES (?, 'answer', 'assistant', ?, ?, ?, ?, 0)`).run(
          threadId, JSON.stringify(preserved), reasoning.slice(0, 120_000) || null,
          createdAt, preserved === content ? null : createdAt + 1)
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { migratedMessages: 1, searchProjectionState: state } })
      expect(db.prepare("SELECT message_id, content_json FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
        .all(threadId)).toEqual([
          { message_id: "answer", content_json: JSON.stringify(preserved) },
          { message_id: "tail", content_json: JSON.stringify(messages[1].content) }
        ])
    } finally { db.close() }
  }, 30_000)

  it.each([null, "complete"])("retains unproven coverage when a newer source replaces unfinished history (%s)",
    async (unfinishedProjection) => {
    const threadId = "replaced-interrupted-checkpoint"
    const anchor = { id: "present", type: "ai", content: "copied prefix" }
    const missing = { id: "missing", type: "ai", content: "unsaved historical keyword" }
    const later = { id: "later", type: "human", content: "new question" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [anchor, missing] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      db.exec(`CREATE TABLE legacy_checkpoint_transcript_migrations (
        thread_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, total_messages INTEGER NOT NULL,
        next_index INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL,
        search_projection_state TEXT
      )`)
      db.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
        VALUES (?, ?, 2, 1, 'migrating', 1, ?)`).run(threadId, legacyCheckpoint.id, unfinishedProjection)
      db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES (?, ?, 'assistant', ?, 1, 0)`).run(threadId, anchor.id, JSON.stringify(anchor.content))
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("newer", 2, [anchor, later]), metadata)
      } finally { await saver.close() }
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { migratedMessages: 1, searchProjectionState: "unverified" } })
      expect(db.prepare(`SELECT status, search_projection_state, source_key
        FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`).get(threadId))
        .toMatchObject({ status: "complete", search_projection_state: "unverified",
          source_key: sqliteRecoveryFamilyKey(databasePath) })
    } finally { db.close() }
  }, 30_000)

  it.each(["compacted", "extended", "extended text block", "equivalent Markdown", "reordered parallel calls",
    "not yet persisted", "missing a folded match", "missing an earlier tool summary"])(
    "checks previous overlap coverage when a newer source is %s", async (mode) => {
    const threadId = "rollover-overlap"
    const body = (text: string) => mode === "extended text block" ? [{ type: "text", text }] : text
    const parallel = mode === "reordered parallel calls"
    const missingFoldedMatch = mode === "missing a folded match"
    const missingToolSummary = mode === "missing an earlier tool summary"
    const hasTools = parallel || missingToolSummary
    const folded = ["Published visible.", "", "```md", "x".repeat(24_000), "",
      "Before **release** and Before **release**", "", "y".repeat(47_000), "```"].join("\n")
    const toolCalls = (missingToolSummary ? ["src/pending-folder"] : ["source-a.ts", "source-b.ts"]).map((path) => ({
      id: path, name: "read_file", args: { path }
    }))
    const answer = { id: "answer", type: "ai",
      content: body(missingFoldedMatch ? folded : mode === "equivalent Markdown" ? "Published **answer**" : "Published answer"),
      ...(hasTools ? { tool_calls: toolCalls } : {}) }
    const anchor = { id: "anchor", type: "human", content: "next question" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [answer, anchor] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const client = createClient()
    const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
    const extended = mode.startsWith("extended")
    const canonicalFolded = missingFoldedMatch
      ? projectChatSearchPlan(createThreadSearchMessagePlan("assistant", folded, [], null)!)
          .find((part) => !part.foldedPreview)!.text.split("\n").map((line) => "    " + line).join("\n")
      : undefined
    const fullBody = body(canonicalFolded ?? (extended ? "Published answer with an appended ending" : "Published answer"))
    const storedTools = parallel ? toolCalls.toReversed() : missingToolSummary
      ? [{ ...toolCalls[0], args: { path: toolCalls[0].args.path + "/relations.ts" } }] : null
    const persisted = () => db.prepare(`UPDATE thread_messages SET content_json = ?, tool_calls_json = ?, end_at = 2
      WHERE thread_id = ? AND message_id = 'answer'`).run(JSON.stringify(fullBody),
        storedTools ? JSON.stringify(storedTools) : null, threadId)
    try {
      db.exec(`ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1;
        ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0;`)
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, ordinal, created_at, stream_authority, tool_calls_json)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      insert.run(threadId, answer.id, "assistant", JSON.stringify(body("Published")), 0, hasTools ? 5 : 1,
        parallel ? JSON.stringify(toolCalls.slice(0, 1)) : null)
      insert.run(threadId, anchor.id, "user", JSON.stringify(anchor.content), 1, 0, null)
      await expect(bootstrap()).resolves.toMatchObject({ stats: {
        searchProjectionState: "overlap-unverified"
      } })
      if (mode !== "not yet persisted") persisted()
      const saver = new SqlJsSaver(databasePath)
      try {
        const snapshot = extended ? [{ ...answer, content: fullBody }, anchor] : missingToolSummary ? [answer, anchor] : [anchor]
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("compacted", 2, snapshot), metadata)
      } finally { await saver.close() }
      const unresolved = mode === "not yet persisted" || missingFoldedMatch || missingToolSummary
      await expect(bootstrap()).resolves.toMatchObject({
        stats: { searchProjectionState: unresolved ? "overlap-unverified" : "complete" }
      })
      if (mode === "not yet persisted") {
        persisted()
        await expect(bootstrap()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      } else if (missingFoldedMatch || missingToolSummary) {
        db.prepare(`UPDATE thread_messages SET content_json = ?, tool_calls_json = ?
          WHERE thread_id = ? AND message_id = 'answer'`).run(
          JSON.stringify(answer.content), hasTools ? JSON.stringify(toolCalls) : null, threadId)
        await expect(bootstrap()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      }
      expect(db.prepare("SELECT message_id FROM legacy_checkpoint_search_overlaps WHERE thread_id = ?")
        .all(threadId)).toEqual([])
    } finally { db.close() }
  }, 30_000)

  it("keeps independent unresolved transcripts for the same message through compaction", async () => {
    const threadId = "multiple-overlap-sources"
    const first = { id: "answer", type: "ai", content: "Published first checkpoint body" }
    const second = { ...first, content: "Published latest checkpoint keyword" }
    const expected = {
      messageId: first.id, role: "assistant", providerSourceId: null, providerOccurrence: null,
      contentJson: JSON.stringify(second.content), toolCallsJson: null, reasoning: null
    }
    const proof = createLegacyOverlapProof(expected)!
    expect(coversLegacyOverlap(expected, [], proof)).toBe(true)
    expect(coversLegacyOverlap({ ...expected, contentJson: JSON.stringify(first.content) }, [], proof)).toBe(false)
    const anchor = { id: "anchor", type: "human", content: "next question" }
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages: [first, anchor] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const client = createClient()
    const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
    const save = async (id: string, version: number, messages: unknown[]) => {
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId), checkpoint(id, version, messages), metadata)
      } finally { await saver.close() }
    }
    try {
      db.exec(`ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1;
        ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0;`)
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, ordinal, created_at, stream_authority)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
      insert.run(threadId, first.id, "assistant", JSON.stringify("Published"), 0, 1)
      insert.run(threadId, anchor.id, "user", JSON.stringify(anchor.content), 1, 0)
      await expect(bootstrap()).resolves.toMatchObject({ stats: { searchProjectionState: "overlap-unverified" } })
      await save("second", 2, [second, anchor])
      await expect(bootstrap()).resolves.toMatchObject({ stats: { searchProjectionState: "overlap-unverified" } })
      const pending = db.prepare(`SELECT json_array_length(projection_proof) AS proofs
        FROM legacy_checkpoint_search_overlaps WHERE thread_id = ? AND message_id = ?`)
      expect(pending.get(threadId, first.id)?.proofs).toBe(2)
      db.prepare(`UPDATE thread_messages SET content_json = ?, end_at = 2
        WHERE thread_id = ? AND message_id = ?`).run(JSON.stringify(first.content), threadId, first.id)
      await save("compacted", 3, [anchor])
      await expect(bootstrap()).resolves.toMatchObject({ stats: { searchProjectionState: "overlap-unverified" } })
      expect(pending.get(threadId, first.id)?.proofs).toBe(1)
    } finally { db.close() }
  }, 30_000)

  it.each(["background", "foreground"])("projects contested Markdown outside the %s durable writer lock",
    async (mode) => {
    const threadId = "markdown-overlap-lock"
    const content = "Published\n\n" + (
      "A regular **Markdown** paragraph with [a label](https://example.test) and additional detail. ".repeat(2) + "\n\n"
    ).repeat(497)
    const { databasePath } = await seedLegacyInlineFixture({
      threadId, messages: [{ id: "answer", type: "ai", content }]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      db.exec(`ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle';
        ALTER TABLE threads ADD COLUMN metadata TEXT;
        ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0;`)
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, ordinal, created_at, stream_authority)
        VALUES (?, 'answer', 'assistant', '"Published"', 0, 1, 1)`).run(threadId)
      const incarnation = { token: null, legacyCreatedAt:
        Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?").get(threadId)?.created_at) }
      const durations = new SharedArrayBuffer(4)
      const client = new CheckpointRuntimeProjectionClient(async () => new Worker(`
        const { workerData } = require("node:worker_threads")
        const { DatabaseSync } = require("node:sqlite")
        const { resolve } = require("node:path")
        const execute = DatabaseSync.prototype.exec
        const started = new WeakMap()
        const longest = new Int32Array(workerData.durations)
        DatabaseSync.prototype.exec = function (sql) {
          const result = execute.call(this, sql)
          if (sql === "BEGIN IMMEDIATE" &&
              resolve(this.prepare("PRAGMA database_list").get().file) === resolve(workerData.durablePath)) {
            started.set(this, performance.now())
          } else if (sql === "COMMIT" || sql === "ROLLBACK") {
            const time = started.get(this)
            if (time !== undefined) {
              Atomics.store(longest, 0, Math.max(Atomics.load(longest, 0), Math.ceil(performance.now() - time)))
              started.delete(this)
            }
          }
          return result
        }
        require(workerData.workerBundlePath)
      `, { eval: true, workerData: { durablePath, durations, workerBundlePath } }))
      clients.push(client)
      const result = await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined,
        mode === "background" ? { guard: { incarnation } } : undefined)
      expect(result.stats.searchProjectionState).toBe("overlap-unverified")
      const longest = Atomics.load(new Int32Array(durations), 0)
      expect(longest).toBeGreaterThan(0)
      expect(longest).toBeLessThan(100)
    } finally { db.close() }
  }, 30_000)

  it.each(["standalone reasoning", "standalone reasoning plus a recoverable body", "tool argument outside the summary"])(
    "keeps search coverage complete for preserved %s differences", async (mode) => {
    const threadId = "overlap-corpus"
    const content = "Visible reply is already saved"
    const tool = { id: "call", name: "read_file", args: { path: "src/example.ts", limit: 100 } }
    const isTool = mode === "tool argument outside the summary"
    const shorterBody = mode === "standalone reasoning plus a recoverable body"
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages: [{
      id: "answer", type: "ai", content,
      ...(isTool ? { tool_calls: [tool] } : { additional_kwargs: { reasoning: "Standalone explanation" } })
    }] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const storedTools = isTool ? JSON.stringify([{ ...tool, args: { ...tool.args, limit: 10 } }]) : null
    try {
      db.exec(`ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1;
        ALTER TABLE thread_messages ADD COLUMN stream_authority INTEGER NOT NULL DEFAULT 0;`)
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, tool_calls_json, ordinal, created_at, stream_authority)
        VALUES (?, 'answer', 'assistant', ?, ?, 0, 1, ?)`)
        .run(threadId, JSON.stringify(shorterBody ? "Visible reply" : content), storedTools, isTool ? 4 : 2)
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(db.prepare("SELECT content_json, reasoning, tool_calls_json FROM thread_messages WHERE thread_id = ?")
        .get(threadId)).toMatchObject({ content_json: JSON.stringify(content), reasoning: null, tool_calls_json: storedTools })
    } finally { db.close() }
  }, 30_000)

  it.each(["structured body", "tool summary"])(
    "preserves search coverage loss after re-auditing a legacy %s", async (kind) => {
    const threadId = "lossy-legacy-projection"
    const question = { id: "question", type: "human", content: "original question" }
    const answer = { id: "answer", type: "ai",
      content: kind === "structured body" ? [{ type: "text",
        text: "旧".repeat(25_000) + " lost body needle " + "旧".repeat(185_000) }] : "original answer",
      ...(kind === "tool summary" ? { tool_calls: [{ id: "call", name: "read_file",
        args: { file_path: "x".repeat(530_000) + "/lost-tool-needle.txt" } }] } : {}) }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [answer, question]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const client = createClient()
    const bootstrap = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
    const projectionState = () => db.prepare(`SELECT source_key, search_projection_state
      FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`).get(threadId)
    try {
      await expect(bootstrap()).resolves.toMatchObject({
        stats: { migratedMessages: 2, searchProjectionState: "truncated" }
      })
      expect(projectionState()).toMatchObject({
        source_key: sqliteRecoveryFamilyKey(databasePath), search_projection_state: "truncated"
      })

      // An older migration wrote only the projected rows and a completion marker.
      db.exec(`UPDATE legacy_checkpoint_transcript_migrations SET source_key = NULL,
        search_projection_state = NULL; DELETE FROM legacy_checkpoint_transcript_source_ids;
        DELETE FROM legacy_checkpoint_transcript_imports;`)
      await expect(bootstrap()).resolves.toMatchObject({
        stats: { migratedMessages: 0, searchProjectionState: "truncated" }
      })
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id),
          checkpoint("newer", 2, [question, { id: "later", type: "ai", content: "new body" }]), metadata)
      } finally { await saver.close() }
      await expect(bootstrap()).resolves.toMatchObject({
        stats: { migratedMessages: 1, searchProjectionState: "truncated" }
      })
      expect(projectionState()?.search_projection_state).toBe("truncated")
    } finally { db.close() }
  }, 30_000)

  it.each(["unchanged source", "edited durable body", "changed provider identity",
    "hole in a bounded tail", "replaced checkpoint generation", "later native snapshot",
    "canonical native reasoning", "fragmented native reasoning", "implicit provider native reasoning",
    "later untagged native snapshot",
    "tool success flag", "tool status error", "reordered tool arguments"])(
    "checks checkpoint generation and body before a missing snapshot repair (%s)", async (mode) => {
      const threadId = "verified-checkpoint-repair"
      const canonicalReasoning = mode.endsWith("native reasoning") ? "Resolved competing requirements" : undefined
      const untaggedNative = mode === "later untagged native snapshot"
      const toolStatus = mode === "tool success flag" ? "success" as const
        : mode === "tool status error" ? "error" as const : undefined
      const reordered = mode === "reordered tool arguments"
      const serializeRuntimeMessages = Boolean(canonicalReasoning || untaggedNative || toolStatus || reordered)
      const call = { id: "call", name: "read_file", args: { path: "sample.md", options: { first: 1, last: 5 } } }
      const original: Array<{
        id: string
        type: string
        content: string
        additional_kwargs?: { reasoning: string }
        tool_calls?: (typeof call)[]
        tool_call_id?: string
        status?: "success" | "error"
      }> = [{ id: "first", type: "human", content: "original body" },
        { id: "second", type: "ai", content: "answer",
          ...(toolStatus || reordered ? { tool_calls: [call] } : {}),
          ...(canonicalReasoning ? { additional_kwargs: { reasoning: canonicalReasoning } } : {}) },
        { id: "third", type: toolStatus ? "tool" : "ai", content: "tail",
          ...(toolStatus ? { tool_call_id: call.id, status: toolStatus } : {}) }]
      const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: original })
      const durablePath = createMessageDatabase(databasePath, threadId)
      const durable = new DatabaseSync(durablePath)
      let verifier: SqlJsSaver | undefined
      const role = (message: typeof original[number]) =>
        message.type === "human" ? "user" : message.type === "tool" ? "tool" : "assistant"
      const toRuntime = (message: typeof original[number]) => persistedMessageToRuntimeMessage({
        id: message.id, role: role(message), content: message.content,
        reasoning: message.additional_kwargs?.reasoning, created_at: new Date(legacyCheckpoint.ts),
        tool_calls: message.tool_calls, tool_call_id: message.tool_call_id, status: message.status
      })!
      const save = async (messages: typeof original, id = legacyCheckpoint.id, version = 1) => {
        const writer = new SqlJsSaver(databasePath)
        try {
          const input = serializeRuntimeMessages ? messages.map(toRuntime) : messages
          await writer.put(config(threadId), checkpoint(id, version, input), metadata)
        } finally { await writer.close() }
      }
      try {
        durable.exec("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER")
        const laterNative = mode === "later native snapshot" || untaggedNative
        if (mode === "later native snapshot" || (serializeRuntimeMessages && !untaggedNative)) {
          durable.exec(`CREATE TABLE legacy_checkpoint_transcript_migrations (
            thread_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, total_messages INTEGER NOT NULL,
            next_index INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL
          );`)
          durable.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
            VALUES (?, 'native-durable', 0, 0, 'complete', 1)`).run(threadId)
        }
        await save(original)
        if (serializeRuntimeMessages) {
          const insert = durable.prepare(`INSERT INTO thread_messages
            (thread_id, message_id, role, content_json, reasoning, created_at, ordinal,
             tool_calls_json, tool_call_id, status, is_error, recovery_integrity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
          for (const [index, row] of original.entries()) {
            const fragmented = index === 1 && mode === "fragmented native reasoning"
            const storedTools = reordered && row.tool_calls
              ? [{ ...call, args: { options: { last: 5, first: 1 }, path: "sample.md" } }]
              : row.tool_calls
            const streamedTool = row.type === "tool" ? persistedMessageFromStreamPayload([toRuntime(row).toJSON()]) : null
            insert.run(threadId, row.id, role(row),
              JSON.stringify(fragmented ? "ans" : row.content), row.additional_kwargs?.reasoning ?? null,
              Date.parse(legacyCheckpoint.ts), index, storedTools ? JSON.stringify(storedTools) : null,
              row.tool_call_id ?? null, row.status ?? null, streamedTool ? Number(Boolean(streamedTool.is_error)) : null)
            if (fragmented) {
              durable.prepare(`INSERT INTO thread_message_fragments(thread_id, message_id, content_text, created_at)
                VALUES (?, ?, 'wer', 1)`).run(threadId, row.id)
              durable.prepare(`INSERT INTO thread_message_fragment_states(thread_id, message_id, total_chars, updated_at)
                VALUES (?, ?, 3, 1)`).run(threadId, row.id)
            }
            if (index === 1 && mode === "implicit provider native reasoning") {
              const [valueSnapshot] = selectStreamTranscriptValueSnapshots({ messages: [toRuntime(row).toJSON()] })
              const streamed = persistedMessageFromStreamPayload(valueSnapshot)
              expect(streamed).toMatchObject({ provider_source_id: row.id, provider_occurrence: 1 })
              durable.prepare(`UPDATE thread_messages SET provider_source_id = ?, provider_occurrence = ?
                WHERE thread_id = ? AND message_id = ?`).run(
                streamed!.provider_source_id!, streamed!.provider_occurrence!, threadId, row.id)
            }
          }
        }
        const audit = await createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        if (untaggedNative) {
          expect(audit.stats.migratedMessages).toBe(0)
          expect(durable.prepare(`SELECT timing_checkpoint_id FROM legacy_checkpoint_transcript_migrations
            WHERE thread_id = ?`).get(threadId)?.timing_checkpoint_id).toBe("native-durable")
        }
        const recoveryId = laterNative ? "new-native" : legacyCheckpoint.id
        if (mode === "edited durable body") {
          durable.prepare("UPDATE thread_messages SET content_json = ? WHERE thread_id = ? AND message_id = 'first'")
            .run(JSON.stringify("later edit"), threadId)
        } else if (mode === "changed provider identity") {
          durable.prepare(`UPDATE thread_messages SET provider_source_id = 'updated-provider', provider_occurrence = 2
            WHERE thread_id = ? AND message_id = 'second'`).run(threadId)
        } else if (mode === "hole in a bounded tail") {
          durable.prepare("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = 'second'").run(threadId)
        } else if (mode === "replaced checkpoint generation") {
          await save([{ ...original[0], content: "different generation" }, ...original.slice(1)])
        } else if (laterNative) {
          const next = { id: "native-tail", type: "human", content: "newly persisted question" }
          await save([...original, next], recoveryId, 2)
          durable.prepare(`INSERT INTO thread_messages
            (thread_id, message_id, role, content_json, created_at, ordinal, recovery_integrity)
            VALUES (?, ?, 'user', ?, ?, 3, 1)`).run(threadId, next.id, JSON.stringify(next.content),
            Date.parse(legacyCheckpoint.ts) + 5)
        }
        const raw = new DatabaseSync(databasePath)
        try {
          raw.prepare("DELETE FROM checkpoint_message_snapshots WHERE thread_id = ? AND checkpoint_id = ?")
            .run(threadId, recoveryId)
        } finally { raw.close() }
        verifier = new SqlJsSaver(databasePath, undefined, {
          recoverMissingCheckpointMessages: async (context) => {
            const { page } = readThreadMessagesPage(durable, {
              type: "read-page", requestId: 1, databasePath: durablePath, threadId,
              options: { includeVisibleMessagePresence: true, recoveryCheckpointId: context.checkpointId,
                recoveryTranscriptRevision: context.transcriptRevision,
                ...(mode === "hole in a bounded tail" ? { limit: 2 } : {}),
                notAfterCreatedAt: Date.parse(context.checkpointTs) },
              cancellationBuffer: new SharedArrayBuffer(4)
            })
            if (page.recoveryIntegrity !== "verified" ||
                (!page.hasMore && page.messages.length !== context.expectedMessageCount)) return null
            const messages = page.messages.flatMap((message) => {
              const recovered = persistedMessageToRuntimeMessage(message)
              return recovered ? [recovered] : []
            })
            return { messages, complete: !page.hasMore, boundedByHistory: page.hasMore }
          }
        })
        const repair = mode === "hole in a bounded tail"
          ? verifier.getLatestTupleForDurableTailRecovery(threadId)
          : verifier.getTuple(config(threadId))
        if (mode === "unchanged source" || laterNative || serializeRuntimeMessages) {
          const result = await repair
          expect(result?.checkpoint.channel_values.messages).toHaveLength(laterNative ? 4 : 3)
          if (canonicalReasoning) {
            expect(result?.checkpoint.channel_values.messages).toMatchObject([
              expect.anything(), { additional_kwargs: { reasoning: canonicalReasoning } }, expect.anything()
            ])
          }
        } else {
          await expect(repair).rejects.toMatchObject({ name: "CheckpointMessageSnapshotRecoveryError" })
        }
      } finally {
        await verifier?.close()
        durable.close()
      }
    }, 30_000
  )

  it.each([
    { replaced: false, stop: "during" },
    { replaced: true, stop: "during" },
    { replaced: true, stop: "after" }
  ])("resumes a prefix copy stopped $stop reservation (source replaced: $replaced)", async ({ replaced, stop }) => {
    const threadId = "resume-wide-prefix-reservation"
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [{ id: "earliest", type: "human", content: "only in the checkpoint" }]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const savedIds = Array.from({ length: 18 }, (_, index) => `saved-${index}`)
      const content = JSON.stringify("x".repeat(116_000))
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, ordinal, created_at)
        VALUES (?, ?, 'assistant', ?, ?, 1)`)
      db.exec("BEGIN")
      for (const [index, id] of savedIds.entries()) insert.run(threadId, id, content, index)
      db.exec("COMMIT")
      const client = new CheckpointRuntimeProjectionClient(async () => new Worker(`
        const { workerData } = require("node:worker_threads")
        const { DatabaseSync } = require("node:sqlite")
        const execute = DatabaseSync.prototype.exec
        DatabaseSync.prototype.exec = function (sql) {
          const result = execute.call(this, sql)
          if (sql === "COMMIT" && this.location() === workerData.durablePath) {
            const row = this.prepare("SELECT status, ordinal_reservation, next_index FROM legacy_checkpoint_transcript_migrations").get()
            const interrupt = workerData.stop === "after"
              ? row?.status === "migrating" && !row.ordinal_reservation && row.next_index === 0
              : row?.ordinal_reservation && JSON.parse(row.ordinal_reservation).range?.cursor
            if (interrupt) {
              throw new Error("interrupted after assigning a batch of ordinals")
            }
          }
          return result
        }
        require(workerData.workerBundlePath)
      `, { eval: true, workerData: { workerBundlePath, durablePath, stop } }))
      clients.push(client)
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted after assigning a batch of ordinals")
      const positions = () => db.prepare(`SELECT message_id, ordinal FROM thread_messages
        WHERE thread_id = ? ORDER BY ordinal`).all(threadId)
      const partial = positions()
      expect(partial.map((row) => row.message_id)).toEqual(savedIds)
      expect(partial[0].ordinal).toBe(stop === "after" ? 1 : 0)
      expect(partial.at(-1)?.ordinal).toBe(savedIds.length)
      expect(db.prepare("SELECT status FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)?.status).toBe(stop === "after" ? "migrating" : "reserving")
      if (replaced) {
        const saver = new SqlJsSaver(databasePath)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2, [
          { id: "new-earliest", type: "human", content: "new checkpoint generation" }
        ]))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ? WHERE checkpoint_id = ?")
            .run(type, payload, legacyCheckpoint.id)
        } finally {
          source.close()
        }
      }
      const incarnation = { token: null, legacyCreatedAt:
        Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?").get(threadId)?.created_at) }
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined,
        { guard: { incarnation } })).resolves.toMatchObject({ stats: {
        migratedMessages: 1, searchProjectionState: replaced ? "unverified" : "complete"
      } })
      if (!replaced) {
        expect(positions()).toEqual(["earliest", ...savedIds].map((message_id, ordinal) => ({ message_id, ordinal })))
      } else {
        expect(positions().map((row) => row.message_id)).toEqual(["new-earliest", ...savedIds])
      }
    } finally { db.close() }
  }, 30_000)

  it.each([
    { appended: false, edited: false },
    { appended: true, edited: false },
    { appended: true, edited: true }
  ])("resumes committed rows (source appended: $appended, durable edit: $edited)", async ({ appended, edited }) => {
    const threadId = "resume-ordered-checkpoint"
    const messages = Array.from({ length: 70 }, (_, index) => ({
      id: `m${index}`, type: "ai", content: `checkpoint message ${index}`
    }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const messageDatabasePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(messageDatabasePath)
    try {
      db.exec(`ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'idle';
        ALTER TABLE threads ADD COLUMN metadata TEXT;
        CREATE TRIGGER pause_second_batch BEFORE INSERT ON thread_messages
        WHEN NEW.message_id = 'm65' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;`)
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id,message_id,role,content_json,created_at,ordinal)
        VALUES (?, ?, 'assistant', ?, ?, ?)`)
      insert.run(threadId, "older", JSON.stringify("Earlier durable row"), 1, 0)
      insert.run(threadId, "m0", JSON.stringify("checkpoint message 0"), 2, 1)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(
        databasePath, messageDatabasePath, threadId
      )).rejects.toThrow("fixture interruption")
      expect(db.prepare("SELECT next_index, status FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)).toEqual({ next_index: 64, status: "migrating" })
      db.exec("DROP TRIGGER pause_second_batch")
      if (edited) {
        db.prepare("UPDATE thread_messages SET content_json = ? WHERE message_id = 'm14'")
          .run(JSON.stringify("newer durable edit"))
      }
      if (appended) {
        messages.push({ id: "m70", type: "ai", content: "checkpoint message 70" })
        const saver = new SqlJsSaver(databasePath)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2, messages))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ? WHERE checkpoint_id = ?")
            .run(type, payload, legacyCheckpoint.id)
        } finally {
          source.close()
        }
      }
      const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
        .get(threadId)?.created_at)
      await expect(client.bootstrapLegacyTranscript(
        databasePath, messageDatabasePath, threadId, "", undefined,
        { guard: { incarnation: { token: null, legacyCreatedAt } } }
      )).resolves.toMatchObject({ stats: { migratedMessages: appended ? 7 : 6,
        searchProjectionState: edited ? "unverified" : "complete" } })
      expect(db.prepare("SELECT message_id FROM thread_messages WHERE thread_id = ? ORDER BY ordinal")
        .all(threadId).map((row) => row.message_id)).toEqual([
        "older", ...messages.map((message) => message.id)
      ])
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'm14'").get()?.content_json)
        .toBe(JSON.stringify(edited ? "newer durable edit" : "checkpoint message 14"))
    } finally {
      db.close()
    }
  }, 30_000)

  it.each(["same ID", "new ID", "matching tail anchor", "edited copy before adoption",
    "edited copy during shift", "edited anchor during shift", "tail deleted during shift",
    "edited anchor and deleted tail", "renamed anchor during shift", "edited copy with unchanged source"])(
    "grows an interrupted reservation before a retained durable tail with %s", async (mode) => {
    const threadId = "append-before-durable-tail"
    const messages = Array.from({ length: 70 }, (_, index) => ({
      id: `m${index}`, type: "ai", content: `legacy line ${index}`
    }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec(`CREATE TRIGGER interrupt_copy BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'm65'
        BEGIN SELECT RAISE(ABORT, 'interrupted original copy'); END;`)
      const put = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, created_at, ordinal) VALUES (?, ?, 'assistant', ?, 1, ?)`)
      const tailIds = Array.from({ length: 10 }, (_, index) => `saved-${index}`)
      const body = JSON.stringify("retained text ".repeat(8_000))
      for (const [index, id] of tailIds.entries())
        put.run(threadId, id, index === 0 ? JSON.stringify("matching saved reply") : body, index)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted original copy")
      expect(db.prepare("SELECT next_index FROM legacy_checkpoint_transcript_migrations").get()?.next_index).toBe(64)
      db.exec("DROP TRIGGER interrupt_copy")
      const checkpointId = mode === "new ID" ? "newer-checkpoint" : legacyCheckpoint.id
      const unchanged = mode === "edited copy with unchanged source"
      const tailDeleted = mode === "tail deleted during shift" || mode === "edited anchor and deleted tail"
      const renamed = mode === "renamed anchor during shift"
      const beforeAdoption = mode === "edited copy before adoption" || unchanged
      const anchorEdited = mode === "edited anchor during shift" || mode === "edited anchor and deleted tail"
      const matchingAnchor = mode === "matching tail anchor" || anchorEdited || tailDeleted || renamed
      if (matchingAnchor)
        messages.push({ id: tailIds[0], type: "ai", content: "matching saved reply" })
      if (!unchanged) {
        messages.push({ id: "additional", type: "ai", content: "additional legacy reply" })
        const saver = new SqlJsSaver(databasePath)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint(checkpointId, 2, messages))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET checkpoint_id = ?, type = ?, checkpoint = ?")
            .run(checkpointId, type, payload)
        } finally { source.close() }
      }
      const incarnation = { token: null, legacyCreatedAt:
        Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?").get(threadId)?.created_at) }
      const editedId = mode === "edited copy during shift" || beforeAdoption ? "m14"
        : anchorEdited ? tailIds[0] : null
      if ((editedId && !beforeAdoption) || tailDeleted || renamed) {
        const interrupted = new CheckpointRuntimeProjectionClient(async () => new Worker(`
          const { workerData } = require("node:worker_threads")
          const { DatabaseSync } = require("node:sqlite")
          const execute = DatabaseSync.prototype.exec
          DatabaseSync.prototype.exec = function (sql) {
            const result = execute.call(this, sql)
            if (sql === "COMMIT" && this.location() === workerData.durablePath) {
              const marker = this.prepare("SELECT adopted_source_start, status FROM legacy_checkpoint_transcript_migrations").get()
              if (marker?.adopted_source_start === 70 && marker.status === "reserving")
                throw new Error("interrupted adopted reservation")
            }
            return result
          }
          require(workerData.workerBundlePath)
        `, { eval: true, workerData: { workerBundlePath, durablePath } }))
        clients.push(interrupted)
        await expect(interrupted.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .rejects.toThrow("interrupted adopted reservation")
      }
      if (editedId) db.prepare("UPDATE thread_messages SET content_json = ? WHERE message_id = ?")
        .run(JSON.stringify("durable edited during the reservation"), editedId)
      if (tailDeleted) db.prepare("DELETE FROM thread_messages WHERE message_id = ?").run(tailIds.pop()!)
      if (renamed) db.prepare(`UPDATE thread_messages SET message_id = 'canonical-anchor',
        provider_source_id = message_id, provider_occurrence = 1 WHERE message_id = ?`).run(tailIds[0])
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined,
        { guard: { incarnation } })).resolves.toMatchObject({
        stats: { checkpointId, searchProjectionState: editedId ? "unverified" : "complete",
          migratedMessages: unchanged ? 6 : 7 }
      })
      const expected = [...messages.map((item) => renamed && item.id === tailIds[0] ? "canonical-anchor" : item.id),
        ...tailIds.slice(matchingAnchor ? 1 : 0)]
      expect(db.prepare("SELECT message_id, ordinal FROM thread_messages ORDER BY ordinal").all())
        .toEqual(expected.map((message_id, ordinal) => ({ message_id, ordinal })))
      if (editedId) expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = ?")
        .get(editedId)?.content_json).toBe(JSON.stringify("durable edited during the reservation"))
    } finally { db.close() }
  }, 30_000)

  it.each([
    ["reservation published", 64, "durable"],
    ["anchor copied", 128, "durable"],
    ["copy finished", 153, "durable"],
    ["completion published", null, "durable"],
    ["source and durable ID change before copying", 64, "source"],
    ["source and durable ID change during ordinal reservation", "reserving", "source"],
    ["source and durable ID change after copying", 153, "source"],
    ["source and durable ID change after completion", null, "source"],
    ["merging two copied source members", 128, "merge"],
    ["merging two adopted source members before shifting", "reserving", "reverse-merge"],
    ["merging two adopted source members before copying", 64, "reverse-merge"],
    ["merging a committed prefix member into an adopted suffix", "reserving", "prefix-merge"],
    ["replacing an imported source ID whose durable text changed", 64, "rebound"],
    ["a new checkpoint keeps the same raw source and order", 64, "rollover"]
  ] as const)("preserves source ownership after %s", async (_phase, stopAt, change) => {
    const threadId = "renamed-legacy-member"
    const messages = Array.from({ length: 153 }, (_, index) => ({
      id: `m${index}`, type: "human", content: `checkpoint message ${index}`
    }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: messages.slice(0, 70)
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const client = createClient()
    const aliasIndex = change === "rebound" ? 14 : change === "reverse-merge" ? 80 : change === "prefix-merge" ? 63 : 79
    const canonicalId = change === "merge" ? "m80" :
      change === "reverse-merge" || change === "prefix-merge" || change === "rollover"
        ? "m79" : `canonical-m${aliasIndex}`
    const changedCheckpointId = "same-transcript-new-checkpoint"
    const expectedCoverage = change === "rollover" ? "complete" : "unverified"
    async function save(count: number, version: number, canonical = false, checkpointId = legacyCheckpoint.id) {
      const saver = new SqlJsSaver(databasePath)
      const [type, payload] = await saver.serde.dumpsTyped(
        checkpoint(checkpointId, version, messages.slice(0, count).map((message, index) =>
          canonical && index === aliasIndex
            ? persistedMessageToRuntimeMessage({
                id: canonicalId, role: "user", content: message.content, created_at: new Date(1),
                provider_source_id: `m${aliasIndex}`
              })
            : message
        ))
      )
      await saver.close()
      const source = new DatabaseSync(databasePath)
      try {
        source.prepare("UPDATE checkpoints SET checkpoint_id = ?, type = ?, checkpoint = ?")
          .run(checkpointId, type, payload)
      } finally {
        source.close()
      }
    }
    try {
      installVersionedLegacyFixtureSchema(db)
      const put = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, created_at, ordinal) VALUES (?, ?, 'user', ?, 1, ?)`)
      put.run(threadId, "older", JSON.stringify("older durable row"), 0)
      put.run(threadId, "m0", JSON.stringify(messages[0].content), 1)
      db.exec(`CREATE TRIGGER interrupt_copy BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'm65'
        BEGIN SELECT RAISE(ABORT, 'interrupted original copy'); END;`)
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted original copy")
      db.exec("DROP TRIGGER interrupt_copy")
      expect(db.prepare("SELECT next_index, append_ordinal_base FROM legacy_checkpoint_transcript_migrations").get())
        .toEqual({ next_index: 64, append_ordinal_base: 1 })
      put.run(threadId, "m79", JSON.stringify(messages[79].content), 71)
      if (change === "reverse-merge") put.run(threadId, "m80", JSON.stringify(messages[80].content), 72)
      put.run(threadId, "live-tail", JSON.stringify("newer durable row"), change === "reverse-merge" ? 73 : 72)
      await save(messages.length, 2)
      if (stopAt === null) {
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      } else {
        const interrupted = new CheckpointRuntimeProjectionClient(async () => new Worker(`
          const { workerData } = require("node:worker_threads")
          const { DatabaseSync } = require("node:sqlite")
          const execute = DatabaseSync.prototype.exec
          DatabaseSync.prototype.exec = function (sql) {
            const result = execute.call(this, sql)
            if (sql === "COMMIT" && this.location() === workerData.durablePath) {
              const phase = this.prepare("SELECT status, total_messages, next_index FROM legacy_checkpoint_transcript_migrations").get()
              if (phase?.total_messages === workerData.total &&
                  (workerData.stopAt === "reserving" ? phase?.status === "reserving" :
                    phase?.status === "migrating" && phase.next_index === workerData.stopAt))
                throw new Error("interrupted after the chosen commit")
            }
            return result
          }
          require(workerData.workerBundlePath)
        `, { eval: true, workerData: { durablePath, stopAt, workerBundlePath, total: messages.length } }))
        clients.push(interrupted)
        await expect(interrupted.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .rejects.toThrow("interrupted after the chosen commit")
      }
      const isMerge = change === "merge" || change === "reverse-merge" || change === "prefix-merge"
      const aliasSourceId = `m${aliasIndex}`
      const retiredIndex = change === "prefix-merge" ? 79 : 80
      const physicalIndex = change === "prefix-merge" ? 63 : 79
      if (isMerge) {
        const ordinal = db.prepare("SELECT MIN(ordinal) AS first FROM thread_messages WHERE message_id IN (?, ?)")
          .get(aliasSourceId, canonicalId)?.first ?? 0
        db.prepare("DELETE FROM thread_messages WHERE message_id = ?").run(aliasSourceId)
        db.prepare("UPDATE thread_messages SET ordinal = ? WHERE message_id = ?").run(Number(ordinal), canonicalId)
      }
      if (change === "rollover") {
        await save(messages.length, 3, false, changedCheckpointId)
      } else {
        db.prepare(`UPDATE thread_messages SET message_id = ?, provider_source_id = ?,
          provider_occurrence = 1, content_json = '"edited durable content"' WHERE message_id = ?`)
          .run(canonicalId, aliasSourceId, isMerge ? canonicalId : aliasSourceId)
      }
      const normalizedSource = change === "source" || change === "rebound"
      if (stopAt === null || normalizedSource) await save(messages.length, 3, normalizedSource)
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: 153, searchProjectionState: expectedCoverage } })
      if (isMerge) {
        await save(messages.length, 4)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { migratedMessages: 0, searchProjectionState: "unverified" } })
      }
      messages.push({ id: "new-legacy", type: "human", content: "another legacy row" })
      await save(messages.length, 5, normalizedSource,
        change === "rollover" ? changedCheckpointId : legacyCheckpoint.id)
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: 154, migratedMessages: 1, searchProjectionState: expectedCoverage } })
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { migratedMessages: 0, searchProjectionState: expectedCoverage } })
      const rows = db.prepare("SELECT message_id, ordinal FROM thread_messages ORDER BY ordinal").all()
      expect(rows).toEqual([
        { message_id: "older", ordinal: 0 },
        ...messages.flatMap(({ id }, index) => isMerge && index === retiredIndex ? [] : [{
          message_id: index === (isMerge ? physicalIndex : aliasIndex) ? canonicalId : id, ordinal: index + 1
        }]),
        { message_id: "live-tail", ordinal: messages.length + 1 }
      ])
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = ?").get(canonicalId)?.content_json)
        .toBe(JSON.stringify(change === "rollover" ? messages[79].content : "edited durable content"))
    } finally {
      db.close()
    }
  }, 30_000)

  it.each([true, false])("publishes one complete snapshot for a repeated provider occurrence (prefix: %s)", async (extendsEarlier) => {
    const threadId = "legacy-provider-revisions"
    const provisional = "Provisional reply"
    const final = extendsEarlier ? `${provisional}. Final searchable wording` : "Final searchable wording"
    const runtime = (id: string, content: string) => persistedMessageToRuntimeMessage({
      id, role: "assistant", content, created_at: new Date(1),
      provider_source_id: "shared-origin", provider_occurrence: 1
    })
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages: [
      runtime("temporary-id", provisional), runtime("canonical-id", final),
      { id: "later", type: "human", content: "later message" }
    ] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
        .get(threadId)?.created_at)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined, {
        guard: { incarnation: { token: null, legacyCreatedAt } }
      })).resolves.toMatchObject({
        stats: { migratedMessages: 2, searchProjectionState: extendsEarlier ? "complete" : "truncated" }
      })
      expect(db.prepare("SELECT message_id, ordinal, content_json FROM thread_messages ORDER BY ordinal").all())
        .toEqual([
          { message_id: "temporary-id", ordinal: 0, content_json: JSON.stringify(final) },
          { message_id: "later", ordinal: 2, content_json: '"later message"' }
        ])
      expect(db.prepare("SELECT source_index FROM legacy_checkpoint_transcript_source_ids WHERE message_id = 'temporary-id'")
        .get()).toEqual({ source_index: 0 })
      if (extendsEarlier) {
        db.prepare(`INSERT INTO thread_messages
          (thread_id, message_id, ordinal, role, content_json, created_at)
          VALUES (?, 'local-tail', 3, 'user', '"retained live tail"', 1)`).run(threadId)
        const saver = new SqlJsSaver(databasePath)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint("compacted", 2, [
          { id: "earlier", type: "human", content: "earlier history" },
          runtime("temporary-id", final),
          { id: "later", type: "human", content: "later message" },
          { id: "newer", type: "human", content: "newly appended history" }
        ]))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET checkpoint_id = 'compacted', type = ?, checkpoint = ?").run(type, payload)
        } finally {
          source.close()
        }
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined, {
          guard: { incarnation: { token: null, legacyCreatedAt } }
        })).resolves.toMatchObject({ stats: { checkpointId: "compacted", migratedMessages: 2 } })
        expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all())
          .toEqual(["earlier", "temporary-id", "later", "newer", "local-tail"].map((message_id) => ({ message_id })))
      }
    } finally {
      db.close()
    }
  })

  it.each([true, false])("reuses a canonical durable message without a source receipt (append: %s)", async (append) => {
    const threadId = "legacy-provider-canonical-before-copy"
    const older = { id: "older", type: "human", content: "older checkpoint row" }
    const assistant = { id: "temporary-id", type: "ai", content: "existing canonical text" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: append ? [older] : [older, assistant]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      if (append) {
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { migratedMessages: 1 } })
        const saver = new SqlJsSaver(databasePath)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2, [older, assistant]))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
        } finally {
          source.close()
        }
      }
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, provider_source_id, ordinal, created_at, role, content_json)
        VALUES (?, 'canonical-id', 'temporary-id', ?, 1, 'assistant', '"existing canonical text"')`)
        .run(threadId, Number(append))
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { migratedMessages: append ? 0 : 1 } })
      expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all())
        .toEqual([{ message_id: "older" }, { message_id: "canonical-id" }])
    } finally {
      db.close()
    }
  })

  it.each(["ordinary", "interrupted publication", "two revisions before publication", "a shifted source slot",
    "a shifted source slot before a local tail", "an authoritative durable edit",
    "a single provider snapshot", "a canonical source ID", "an explicit successor to an implicit ID",
    "a new ID for an implicit provider", "a renamed physical ID"
  ])("updates a known earlier provider revision with %s", async (mode) => {
    const threadId = "legacy-provider-revision-after-copy"
    const original = "Already copied provisional text"
    const final = "Different provisional text with the final searchable extension"
    const latest = "Second provisional revision with the newest searchable extension"
    const live = "Current authoritative live content"
    const repeated = mode === "two revisions before publication"
    const shifted = mode.startsWith("a shifted source slot")
    const edited = mode === "an authoritative durable edit"
    const canonicalId = mode === "a canonical source ID" || mode === "a new ID for an implicit provider"
    const promoted = mode === "an explicit successor to an implicit ID" || mode === "a new ID for an implicit provider"
    const physicalRename = mode === "a renamed physical ID"
    const single = mode === "a single provider snapshot" || canonicalId || promoted || physicalRename
    const localTail = repeated || mode === "a shifted source slot before a local tail"
    const runtime = (id: string, content: string, implicit = false) => persistedMessageToRuntimeMessage({
      id, role: "assistant", content, created_at: new Date(1),
      ...(implicit ? {} : { provider_source_id: promoted ? "temp" : "original-provider", provider_occurrence: 1 })
    })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [runtime("temp", original, promoted)]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: 1, migratedMessages: 1 } })
      if (edited) db.prepare(`UPDATE thread_messages SET content_json = ?, stream_authority = 1
        WHERE message_id = 'temp'`).run(JSON.stringify(live))
      if (physicalRename) db.exec("UPDATE thread_messages SET message_id = 'renamed' WHERE message_id = 'temp'")
      if (localTail) db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, ordinal, role, content_json, created_at)
        VALUES (?, 'local-tail', 1, 'user', '"retained live tail"', 1)`).run(threadId)
      async function save(version: number, prefix: string, content: string, appendAnother = false) {
        const saver = new SqlJsSaver(databasePath)
        try {
          await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("revised", version, [
          ...(shifted ? [{ id: "older", type: "human", content: "earlier missing history" }] : []),
          runtime(canonicalId ? "canonical" : "temp", single ? content : prefix),
          ...(!single ? [runtime("canonical", content)] : []),
          ...(localTail ? [{ id: "local-tail", type: "human", content: "retained live tail" }] : []),
          { id: "later", type: "human", content: "newly saved message" },
          ...(appendAnother ? [{ id: "later-again", type: "human", content: "newer checkpoint tail" }] : [])
          ]), metadata)
        } finally {
          await saver.close()
        }
      }
      await save(2, "Different provisional text", final)
      if (mode === "interrupted publication" || repeated) {
        const interrupted = new CheckpointRuntimeProjectionClient(async () => new Worker(`
          const { workerData } = require("node:worker_threads")
          const { DatabaseSync } = require("node:sqlite")
          const execute = DatabaseSync.prototype.exec
          DatabaseSync.prototype.exec = function (sql) {
            const result = execute.call(this, sql)
            if (sql === "COMMIT" && this.location() === workerData.durablePath &&
                this.prepare("SELECT previous_content_key FROM legacy_checkpoint_transcript_imports WHERE message_id = 'temp'")
                  .get()?.previous_content_key) throw new Error("interrupted after replacing the copied revision")
            return result
          }
          require(workerData.workerBundlePath)
        `, { eval: true, workerData: { durablePath, workerBundlePath } }))
        clients.push(interrupted)
        await expect(interrupted.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .rejects.toThrow("interrupted after replacing the copied revision")
        expect(db.prepare("SELECT total_messages FROM legacy_checkpoint_transcript_migrations").get()?.total_messages)
          .toBe(1)
      }
      if (repeated) await save(3, "Second provisional revision", latest)
      const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
        .get(threadId)?.created_at)
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined, {
        guard: { incarnation: { token: null, legacyCreatedAt } }
      })).resolves.toMatchObject({
        stats: { checkpointId: "revised", migratedMessages: shifted ? 2 : 1 }
      })
      const later = { message_id: "later", content_json: '"newly saved message"' }
      const tail = { message_id: "local-tail", content_json: '"retained live tail"' }
      expect(db.prepare("SELECT message_id, content_json FROM thread_messages ORDER BY ordinal").all())
        .toEqual([
          ...(shifted ? [{ message_id: "older", content_json: '"earlier missing history"' }] : []),
          { message_id: physicalRename ? "renamed" : "temp",
            content_json: JSON.stringify(edited ? live : repeated ? latest : final) },
          ...(localTail ? [tail, later] : [later])
        ])
      if (edited) {
        db.prepare(`INSERT INTO thread_messages
          (thread_id, message_id, ordinal, role, content_json, created_at)
          VALUES (?, 'local-tail', 3, 'user', '"retained live tail"', 1)`).run(threadId)
        await save(3, "Second provisional revision", latest, true)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { migratedMessages: 1, searchProjectionState: "unverified" } })
        expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all())
          .toEqual(["temp", "later", "later-again", "local-tail"].map((message_id) => ({ message_id })))
        expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'temp'").get()?.content_json)
          .toBe(JSON.stringify(live))
      }
      if (promoted && !canonicalId) {
        await save(3, "Second provisional revision", latest, true)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { migratedMessages: 1, searchProjectionState: "complete" } })
        expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'temp'").get()?.content_json)
          .toBe(JSON.stringify(latest))
      }
    } finally {
      db.close()
    }
  })

  it.each([
    ["a short implicit reply", "first reply", "final reply", false, "none"],
    ["two near-limit inline replies", "old".repeat(174_000), "new".repeat(174_000), true, "none"],
    ["a long reply interrupted while adding fragments", "first reply", "new".repeat(720_000), true, "append"],
    ["a short reply interrupted before publication", "old".repeat(720_000), "final reply", true, "publish"],
    ["a staged long reply omitted by a newer checkpoint", "old".repeat(720_000), "new".repeat(720_000), true, "omit"]
  ] as const)("replaces a completed migration-owned copy with %s", async (_case, original, updated, explicit, stop) => {
    const threadId = "legacy-completed-replacement"
    const transcript = (content: string, withTail = false) => [
      persistedMessageToRuntimeMessage({
        id: "answer", role: "assistant", content, created_at: new Date(1),
        ...(explicit ? { provider_source_id: "source-answer", provider_occurrence: 1 } : {})
      }),
      ...(withTail ? [{ id: "later", type: "human", content: "later message" }] : [])
    ]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: transcript(original, stop === "omit") })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: stop === "omit" ? 2 : 1, searchProjectionState: "complete" } })
      const save = async (version: number, messages: unknown[]) => {
        const saver = new SqlJsSaver(databasePath)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, version, messages))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
        } finally {
          source.close()
        }
      }
      const readPublishedBody = () => {
        const row = db.prepare(`SELECT content_json, fragment_generation FROM thread_messages WHERE message_id = 'answer'`).get()
        const parts = db.prepare(`SELECT content_text FROM thread_message_fragments
          WHERE message_id = 'answer' AND generation = ? ORDER BY fragment_id`).all(String(row?.fragment_generation))
        return JSON.parse(String(row?.content_json)) + parts.map((part) => part.content_text).join("")
      }
      await save(2, transcript(updated, true))
      if (stop !== "none") {
        db.exec(stop === "append" ? `CREATE TRIGGER stop_rewrite BEFORE INSERT ON thread_message_fragments
          WHEN EXISTS (SELECT 1 FROM legacy_checkpoint_transcript_imports WHERE rewrite_progress IS NOT NULL)
          BEGIN SELECT RAISE(ABORT, 'interrupted completed rewrite'); END` :
          `CREATE TRIGGER stop_rewrite BEFORE UPDATE OF content_json ON thread_messages
          WHEN OLD.message_id = 'answer' BEGIN SELECT RAISE(ABORT, 'interrupted completed rewrite'); END`)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .rejects.toThrow("interrupted completed rewrite")
        const receipt = db.prepare(`SELECT rewrite_progress FROM legacy_checkpoint_transcript_imports
          WHERE message_id = 'answer'`).get()
        expect(readPublishedBody()).toBe(original)
        if (stop === "append" || stop === "omit") {
          const staged = JSON.parse(String(receipt?.rewrite_progress))
          expect(staged.nextIndex).toBeGreaterThan(0)
          expect(db.prepare("SELECT COUNT(*) AS count FROM thread_message_fragments WHERE generation = ?")
            .get(staged.generation)?.count).toBe(staged.nextIndex)
        } else {
          expect(receipt?.rewrite_progress).toBeNull()
        }
        db.exec("DROP TRIGGER stop_rewrite")
      }
      if (stop === "omit") await save(3, [{ id: "later", type: "human", content: "later message" }])
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: stop === "omit" ? 1 : 2, searchProjectionState: "complete" } })
      expect(readPublishedBody()).toBe(stop === "omit" ? original : updated)
      expect(db.prepare(`SELECT rewrite_progress FROM legacy_checkpoint_transcript_imports WHERE message_id = 'answer'`)
        .get()?.rewrite_progress).toBeNull()
      expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all().map((row) => row.message_id))
        .toEqual(["answer", "later"])
    } finally {
      db.close()
    }
  }, 30_000)

  it.each(["revising both slots", "removing the shadow slot", "revising only the reserved suffix"])(
    "resumes a partially copied source after %s", async (mode) => {
    const threadId = "same-length-provider-revision"
    const transcript = (prefix: string, compact = false, revisedSuffix = false) => [
      ...(compact ? ["canonical"] : ["temporary", "canonical"]).map((id, index) => persistedMessageToRuntimeMessage({
        id, role: "assistant", content: index === 0 && !compact ? prefix : `${prefix} final text`,
        created_at: new Date(1), provider_source_id: "stable-reply", provider_occurrence: 1
      })),
      ...Array.from({ length: 79 }, (_, index) => ({ id: `row-${index}`, type: "human",
        content: revisedSuffix && index === 78 ? "Revised reserved tail" : `History ${index}` }))
    ]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: transcript("initial")
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec(`CREATE TRIGGER stop_copy BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'row-62'
        BEGIN SELECT RAISE(ABORT, 'interrupted provider checkpoint'); END`)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted provider checkpoint")
      db.exec("DROP TRIGGER stop_copy")
      expect(db.prepare("SELECT next_index FROM legacy_checkpoint_transcript_migrations").get()?.next_index).toBe(64)
      const saver = new SqlJsSaver(databasePath)
      const compact = mode === "removing the shadow slot"
      const revisedSuffix = mode === "revising only the reserved suffix"
      const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2,
        transcript(revisedSuffix ? "initial" : "revised", compact, revisedSuffix)))
      await saver.close()
      const source = new DatabaseSync(databasePath)
      try {
        source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
      } finally {
        source.close()
      }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: {
          totalMessages: 81, migratedMessages: 17, searchProjectionState: "complete"
        } })
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'temporary'").get()?.content_json)
        .toBe(JSON.stringify(revisedSuffix ? "initial final text" : "revised final text"))
      if (revisedSuffix) expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'row-78'")
        .get()?.content_json).toBe('"Revised reserved tail"')
    } finally {
      db.close()
    }
  })

  it.each([[false, false, false], [true, false, false], [false, true, false], [true, true, false], [true, true, true]])(
    "aligns an implicit reply ID by user turn and order (known: %s, same turn: %s, omitted prompt: %s)", async (knownLater, sameTurn, omitPrompt) => {
    const threadId = "repeat-provider-between-turns"
    const q1 = { id: "question-one", type: "human", content: "first question" }
    const boundary = sameTurn ? { id: "retained-answer", type: "ai", content: "intervening answer" }
      : { id: "question-two", type: "human", content: "different question" }
    const reply = (content: string) => ({ id: "reused", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [q1, reply("first answer"), ...(knownLater || sameTurn ? [boundary] : []),
        ...(knownLater ? [reply("second draft")] : [])]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2,
        [...(sameTurn && !omitPrompt ? [q1] : []), boundary, reply("second final")]))
      await saver.close()
      const source = new DatabaseSync(databasePath)
      try {
        source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
      } finally {
        source.close()
      }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: sameTurn && !knownLater ? "unverified" : "complete" } })
      expect(db.prepare(`SELECT content_json FROM thread_messages ORDER BY ordinal`).all()
        .map((row) => JSON.parse(String(row.content_json))))
        .toEqual(["first question", "first answer", boundary.content, "second final"])
    } finally {
      db.close()
    }
  })

  it.each([[false, false, false], [true, false, false], [false, true, false], [true, false, true]])(
    "places new rows relative to the parent (shared: %s, native: %s, interior: %s)", async (shared, native, interior) => {
    const threadId = "legacy-disjoint-descendant"
    const prior = { id: "prior", type: "ai", content: "prior published reply" }
    const anchor = { id: "shared", type: "human", content: "retained question" }
    const later = { id: "old-tail", type: "ai", content: "earlier saved answer" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [prior, ...(shared ? [anchor, later] : [])]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      if (native) {
        db.exec("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1")
        db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
          VALUES (?, 'prior', 'assistant', ?, 1, 0)`).run(threadId, JSON.stringify(prior.content))
      }
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      if (native) expect(db.prepare(`SELECT COUNT(*) AS count FROM legacy_checkpoint_transcript_imports
        WHERE owned_by_migration = 1`).get()?.count).toBe(0)
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("disjoint-child", 20,
        [...(interior ? [prior, { id: "middle", type: "human", content: "new interior prompt" }] : []),
          ...(shared ? [anchor] : []), { id: "newer", type: "human", content: "newer prompt" }]), metadata)
      await saver.close()
      const checkpointDb = new DatabaseSync(databasePath, { readOnly: true })
      try {
        expect(checkpointDb.prepare(`SELECT parent_checkpoint_id FROM checkpoints WHERE checkpoint_id = 'disjoint-child'`)
          .get()?.parent_checkpoint_id).toBe(legacyCheckpoint.id)
      } finally {
        checkpointDb.close()
      }
      if (interior) {
        db.exec(`CREATE TRIGGER stop_child_copy BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'newer'
          BEGIN SELECT RAISE(ABORT, 'interrupted child placement'); END`)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)).rejects.toThrow("interrupted child placement")
        db.exec("DROP TRIGGER stop_child_copy")
      }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { checkpointId: "disjoint-child", searchProjectionState: "complete" } })
      expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all().map((row) => row.message_id))
        .toEqual(shared ? ["prior", ...(interior ? ["middle"] : []), "shared", "old-tail", "newer"] : ["prior", "newer"])
      if (interior) {
        const updated = new SqlJsSaver(databasePath)
        try {
          await updated.put(config(threadId, legacyCheckpoint.id), checkpoint("disjoint-child", 21, [
            prior, { id: "middle", type: "human", content: "new interior prompt" },
            { id: "second-middle", type: "human", content: "another interior prompt" }, anchor,
            { id: "newer", type: "human", content: "newer prompt" },
            { id: "newest", type: "human", content: "newest prompt" }
          ]), metadata)
        } finally { await updated.close() }
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { migratedMessages: 2, searchProjectionState: "complete" } })
        expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all().map((row) => row.message_id))
          .toEqual(["prior", "middle", "second-middle", "shared", "old-tail", "newer", "newest"])
      }
    } finally {
      await saver.close()
      db.close()
    }
  })

  it.each(["reserving", "migrating"])(
    "replans an interrupted multi-range reservation using its published ancestor while %s", async (phase) => {
    const threadId = "legacy-amended-reservation"
    const answer = (id: string, content = id) => ({ id, type: "ai", content })
    const left = answer("left")
    const right = answer("right")
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [answer("old-first"), left, answer("omitted"), right, answer("old-last")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const save = async (version: number, content: string) => {
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", version, [
          answer("first"), left, answer("middle", content), right, { id: "tail", type: "human", content: "new tail" }
        ]), metadata)
      } finally { await saver.close() }
    }
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await save(2, "provisional interior")
      db.exec(phase === "reserving" ? `CREATE TRIGGER stop_reservation BEFORE UPDATE OF ordinal ON thread_messages
        WHEN OLD.message_id = 'left' BEGIN SELECT RAISE(ABORT, 'interrupted reservation'); END`
        : `CREATE TRIGGER stop_reservation BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'first'
          BEGIN SELECT RAISE(ABORT, 'interrupted reservation'); END`)
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted reservation")
      expect(db.prepare(`SELECT status, next_index, continuation_ancestor FROM legacy_checkpoint_transcript_migrations`)
        .get()).toMatchObject({ status: phase, next_index: 0, continuation_ancestor: legacyCheckpoint.id })
      expect(db.prepare("SELECT ordinal FROM thread_messages WHERE message_id = 'right'").get()?.ordinal).toBeGreaterThan(3)
      db.exec("DROP TRIGGER stop_reservation")
      await save(3, "amended interior")
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { checkpointId: "child", migratedMessages: 3 } })
      expect(db.prepare("SELECT message_id, content_json FROM thread_messages ORDER BY ordinal").all()).toEqual(
        [["old-first", "old-first"], ["first", "first"], ["left", "left"], ["omitted", "omitted"],
          ["middle", "amended interior"], ["right", "right"], ["old-last", "old-last"], ["tail", "new tail"]]
          .map(([message_id, content]) => ({ message_id, content_json: JSON.stringify(content) }))
      )
    } finally { db.close() }
  })

  it.each(["distinct payload", "same payload"])("requires a unique physical user boundary with %s", async (mode) => {
    const threadId = "legacy-repeated-user-boundary"
    const first = { id: "same-user", type: "human", content: "first question" }
    const second = { ...first, content: mode === "same payload" ? first.content : "second question" }
    const answer = (content: string) => ({ id: "same-reply", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [first, answer("first answer"), second, answer("second answer")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          [second, answer("updated second answer")]), metadata)
      } finally { await saver.close() }
      const run = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (mode === "same payload") {
          await expect(run()).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
        } else {
          await expect(run()).resolves.toMatchObject({ stats: { checkpointId: "child", searchProjectionState: "complete" } })
        }
      }
      expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
        .map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual([first.content, "first answer", second.content,
          mode === "same payload" ? "second answer" : "updated second answer"])
    } finally { db.close() }
  })

  it("preserves a witnessed reply when an unwitnessed native occurrence shares its turn", async () => {
    const threadId = "legacy-unwitnessed-reply"
    const user = { id: "question", type: "human", content: "prompt" }
    const anchor = { id: "anchor", type: "ai", content: "exact earlier reply" }
    const answer = (content: string) => ({ id: "repeat", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [user, anchor, answer("original reply")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, created_at, ordinal, provider_source_id, provider_occurrence)
        VALUES (?, ?, 'assistant', '"native reply"', 1, 3, 'repeat', 2)`)
        .run(threadId, "native-canonical")
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          [anchor, answer("unproven changed reply")]), metadata)
      } finally { await saver.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
      expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
        .map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["prompt", "exact earlier reply", "original reply", "native reply"])
    } finally { db.close() }
  })

  it("allocates a new turn without taking a certified native reply from a mixed parent", async () => {
    const threadId = "legacy-mixed-native-turn"
    const turn = (id: string, content: string) => [
      { id, type: "human", content: id }, { id: "reply", type: "ai", content }
    ]
    const first = turn("first", "native reply")
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [...first, ...turn("second", "imported reply")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER NOT NULL DEFAULT 1")
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, created_at, ordinal) VALUES (?, ?, ?, ?, 1, ?)`)
      first.forEach((message, index) =>
        insert.run(threadId, message.id, message.type === "human" ? "user" : "assistant", JSON.stringify(message.content), index))
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      expect(db.prepare(`SELECT owned_by_migration, published_checkpoint_id
        FROM legacy_checkpoint_transcript_imports WHERE message_id = 'reply'`).get()).toEqual({
        owned_by_migration: 0, published_checkpoint_id: legacyCheckpoint.id
      })
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          turn("third", "new reply")), metadata)
      } finally { await saver.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { checkpointId: "child", migratedMessages: 2 } })
      expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
        .map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["first", "native reply", "second", "imported reply", "third", "new reply"])
    } finally { db.close() }
  })

  it.each(["current anchor", "identical current anchors", "anchor changes before write"])(
    "uses current physical assistant witnesses with %s", async (mode) => {
      const threadId = "legacy-current-occurrence-witness"
      const user = (id: string) => ({ id, type: "human", content: id })
      const anchor = (content: string) => ({ id: "repeated-anchor", type: "ai", content })
      const reply = (content: string) => ({ id: "repeated-reply", type: "ai", content })
      const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
        messages: [user("first"), anchor("first anchor"), reply("first reply"),
          user("second"), anchor("second anchor"), reply("second reply")] })
      const durablePath = createMessageDatabase(databasePath, threadId)
      const db = new DatabaseSync(durablePath)
      try {
        installVersionedLegacyFixtureSchema(db)
        const client = createClient()
        await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        const change = db.prepare("UPDATE thread_messages SET content_json = ? WHERE thread_id = ? AND ordinal = ?")
        if (mode !== "anchor changes before write") change.run('"first anchor"', threadId, 4)
        if (mode === "current anchor") change.run('"new first anchor"', threadId, 1)
        const saver = new SqlJsSaver(databasePath)
        try {
          await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2, [
            anchor(mode === "anchor changes before write" ? "second anchor" : "first anchor"), reply("updated reply")
          ]), metadata)
        } finally { await saver.close() }
        if (mode === "anchor changes before write") {
          const racing = new CheckpointRuntimeProjectionClient(async () => new Worker(`
            const { workerData } = require("node:worker_threads")
            const { DatabaseSync } = require("node:sqlite")
            const prepare = DatabaseSync.prototype.prepare
            const execute = DatabaseSync.prototype.exec
            const snapshotReaders = new WeakSet()
            let changed = false
            DatabaseSync.prototype.prepare = function (sql) {
              if (sql.includes("AS source_turn_key") && sql.includes("AS partial_version")) snapshotReaders.add(this)
              return prepare.call(this, sql)
            }
            DatabaseSync.prototype.exec = function (sql) {
              const result = execute.call(this, sql)
              if (!changed && sql === "ROLLBACK" && snapshotReaders.has(this)) {
                changed = true
                const peer = new DatabaseSync(workerData.durablePath)
                try {
                  peer.prepare("UPDATE thread_messages SET content_json = ? WHERE ordinal = 1").run('"second anchor"')
                } finally { peer.close() }
              }
              return result
            }
            require(workerData.workerBundlePath)
          `, { eval: true, workerData: { workerBundlePath, durablePath } }))
          clients.push(racing)
          await expect(racing.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
            .rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
        } else if (mode === "identical current anchors") {
          await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
            .rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
        } else {
          await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
            .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
        }
        expect(db.prepare("SELECT content_json FROM thread_messages WHERE ordinal IN (2, 5) ORDER BY ordinal").all()
          .map(({ content_json }) => JSON.parse(String(content_json))))
          .toEqual(["first reply", mode === "current anchor" ? "updated reply" : "second reply"])
      } finally { db.close() }
    })

  it.each(["descendant", "sibling", "unrelated root"])("requires a reply publication ancestor for a %s", async (relation) => {
    const threadId = "legacy-reply-publication-lineage"
    const prompt = { id: "question", type: "human", content: "common question" }
    const answer = (content: string) => ({ id: "repeated-reply", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [prompt] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const save = async (id: string, parent: string | undefined, step: number, content: string) => {
      const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 4 })
      try {
        await saver.put(config(threadId, parent), checkpoint(id, step, [prompt, answer(content)]), metadata)
      } finally { await saver.close() }
    }
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await save("published", legacyCheckpoint.id, 2, "published reply")
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const parent = relation === "descendant" ? "published" : relation === "sibling" ? legacyCheckpoint.id : undefined
      await save("selected", parent, 3, "revision from selected checkpoint")
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { checkpointId: "selected",
          searchProjectionState: relation === "descendant" ? "complete" : "unverified" } })
      expect(db.prepare("SELECT message_id, content_json FROM thread_messages WHERE role = 'assistant'").all())
        .toEqual([{ message_id: "repeated-reply", content_json: JSON.stringify(
          relation === "descendant" ? "revision from selected checkpoint" : "published reply"
        ) }])
      expect(db.prepare("SELECT published_checkpoint_id FROM legacy_checkpoint_transcript_imports WHERE message_id = 'repeated-reply'")
        .get()?.published_checkpoint_id).toBe(relation === "descendant" ? "selected" : "published")
    } finally { db.close() }
  })

  it.each([
    ["descendant", "inline"], ["sibling", "inline"],
    ["descendant", "live fragments"], ["sibling", "live fragments"],
    ["descendant", "cleared reasoning"], ["sibling", "cleared reasoning"],
    ["descendant", "mixed"], ["sibling", "mixed"]
  ])("protects a certified native reply from a %s with %s history", async (relation, layout) => {
    const threadId = "legacy-native-publication-lineage"
    const question = { id: "question", type: "human", content: "shared prompt" }
    const answer = (content: string) => persistedMessageToRuntimeMessage({
      id: "reply", role: "assistant", content, created_at: new Date(1),
      provider_source_id: "reply", provider_occurrence: 1
    })
    const prefix = "published native prefix"
    const extended = prefix + " and newer text"
    const earlier = layout === "mixed" ? [{ id: "legacy", type: "human", content: "older prompt" }] : []
    const prefixMessages = [...earlier, question]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: prefixMessages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 4 })
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1")
      db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES (?, 'question', 'user', '"shared prompt"', 1, 0)`).run(threadId)
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, created_at, ordinal, provider_source_id, provider_occurrence)
        VALUES (?, 'reply', 'assistant', ?, 1, 1, 'reply', 1)`).run(threadId,
        JSON.stringify(layout === "live fragments" ? prefix.slice(0, 9) : prefix))
      if (layout === "live fragments") db.prepare(`INSERT INTO thread_message_fragments
        (thread_id, message_id, content_text, created_at) VALUES (?, 'reply', ?, 2)`).run(threadId, prefix.slice(9))
      if (layout === "cleared reasoning") db.prepare(`UPDATE thread_messages SET reasoning = '',
        stream_authority = 2 WHERE thread_id = ? AND message_id = 'reply'`).run(threadId)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("owner", 2, [...prefixMessages, answer(prefix)]), metadata)
      await recover()
      const parent = relation === "descendant" ? "owner" : legacyCheckpoint.id
      await saver.put(config(threadId, parent), checkpoint("selected", 3, [...prefixMessages, answer(extended)]), metadata)
      const result = await recover()
      expect(result.stats.searchProjectionState === "complete").toBe(relation === "descendant")
      const published = db.prepare(`SELECT m.content_json, i.published_checkpoint_id, i.owned_by_migration,
        (SELECT group_concat(content_text, '' ORDER BY fragment_id) FROM thread_message_fragments AS f
          WHERE f.thread_id = m.thread_id AND f.message_id = m.message_id AND f.generation = m.fragment_generation) AS suffix
        FROM thread_messages AS m JOIN legacy_checkpoint_transcript_imports AS i USING (thread_id, message_id)
        WHERE m.message_id = 'reply'`).get()
      expect(published).toMatchObject({
        published_checkpoint_id: relation === "descendant" ? "selected" : "owner", owned_by_migration: 0
      })
      expect(JSON.parse(String(published?.content_json)) + (published?.suffix ?? ""))
        .toBe(relation === "descendant" ? extended : prefix)
    } finally {
      await saver.close()
      db.close()
    }
  })

  it("certifies a repeated prompt inserted between two exact adjacent witnesses", async () => {
    const threadId = "legacy-reused-prompt-in-closed-interval"
    const question = { id: "question", type: "human", content: "same prompt" }
    const first = { id: "reply", type: "ai", content: "saved first reply" }
    const fence = { id: "fence", type: "human", content: "verified fence" }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [question, first, fence] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          [question, first, question, { ...first, content: "new second reply" }, fence]), metadata)
      } finally { await saver.close() }
      for (const copied of [2, 0]) {
        await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete", migratedMessages: copied } })
      }
      expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
        .map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["same prompt", "saved first reply", "same prompt", "new second reply", "verified fence"])
    } finally { db.close() }
  })

  it.each(["user", "assistant"] as const)("keeps explicit %s occurrences distinct inside an audited gap", async (role) => {
    const threadId = "native-explicit-occurrence-in-closed-gap"
    const known = { id: "known", type: "human", content: "known user" }
    const fence = { id: "fence", type: "human", content: "next known user" }
    const earlier = "native first occurrence"
    const newer = earlier + " with second occurrence text"
    const second = persistedMessageToRuntimeMessage({
      id: "reused", role, content: newer, provider_source_id: "reused", provider_occurrence: 2, created_at: new Date(1)
    })
    const answers = role === "user" ? [{ id: "new-answer", type: "ai", content: "answer to second prompt" }] : []
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages: [known, second, ...answers, fence] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const save = db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json,
        created_at, ordinal, provider_source_id, provider_occurrence) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
      save.run(threadId, "known", "user", JSON.stringify(known.content), 0, null, null)
      save.run(threadId, "reused", role, JSON.stringify(earlier), 1, "reused", 1)
      save.run(threadId, "fence", "user", JSON.stringify(fence.content), 2, null, null)
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId)).resolves.toMatchObject({
        stats: { searchProjectionState: "complete", migratedMessages: role === "user" ? 2 : 1 }
      })
      expect(db.prepare("SELECT provider_occurrence, content_json FROM thread_messages WHERE provider_source_id = 'reused' ORDER BY ordinal")
        .all()).toEqual([{ provider_occurrence: 1, content_json: JSON.stringify(earlier) },
          { provider_occurrence: 2, content_json: JSON.stringify(newer) }])
    } finally { db.close() }
  })

  it.each([false, true])("lets an exact live reply extend while preserving protected reasoning (updated: %s)", async (updated) => {
    const threadId = "legacy-recertifies-appended-native-body"
    const prompt = { id: "prompt", type: "human", content: "question" }
    const reply = (content: string, reasoning = "preserved reasoning") => persistedMessageToRuntimeMessage({
      id: "reply", role: "assistant", content, reasoning, created_at: new Date(1),
      provider_source_id: "reply", provider_occurrence: 1
    })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [prompt, reply("first body")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      db.prepare("UPDATE thread_messages SET content_json = ?, stream_authority = 2 WHERE message_id = 'reply'")
        .run(JSON.stringify("first body and a live suffix"))
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("audited-live", 2,
        [prompt, reply("first body and a live suffix")]), metadata)
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(db.prepare("SELECT published_checkpoint_id FROM legacy_checkpoint_transcript_imports WHERE message_id = 'reply'")
        .get()?.published_checkpoint_id).toBe("audited-live")
      const reasoning = updated ? "new live reasoning" : "preserved reasoning"
      if (updated) db.prepare("UPDATE thread_messages SET reasoning = ? WHERE message_id = 'reply'").run(reasoning)
      const final = "first body and a live suffix with a checkpoint suffix"
      await saver.put(config(threadId, "audited-live"), checkpoint("descendant", 3, [prompt, reply(final, reasoning)]), metadata)
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(db.prepare("SELECT content_json, reasoning, stream_authority FROM thread_messages WHERE message_id = 'reply'")
        .get()).toEqual({ content_json: JSON.stringify(final), reasoning, stream_authority: 2 })
    } finally {
      await saver.close()
      db.close()
    }
  })

  it("keeps coverage partial until a borrowed visible system message includes the selected text", async () => {
    const threadId = "legacy-native-system-coverage"
    const prompt = { id: "older-prompt", type: "human", content: "older legacy question" }
    const known = { id: "known-prompt", type: "human", content: "current native question" }
    const system = (content: string) => persistedMessageToRuntimeMessage({
      id: "system", role: "system", provider_source_id: "system", provider_occurrence: 1,
      content, created_at: new Date(1)
    })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [prompt, known, system("original visible system text")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES (?, 'known-prompt', 'user', ?, 1, 0)`).run(threadId, JSON.stringify(known.content))
      db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal,
        provider_source_id, provider_occurrence) VALUES (?, 'system', 'system', ?, 1, 1, 'system', 1)`)
        .run(threadId, JSON.stringify("original visible system text"))
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      const newer = "original visible system text with checkpoint-only suffix"
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("system-child", 2, [prompt, known, system(newer)]), metadata)
      const partial = await recover()
      expect(partial.stats.searchProjectionState).not.toBe("complete")
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'system'").get()?.content_json)
        .toBe(JSON.stringify("original visible system text"))
      db.prepare("UPDATE thread_messages SET content_json = ? WHERE message_id = 'system'").run(JSON.stringify(newer))
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
    } finally {
      await saver.close()
      db.close()
    }
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "requires a unique bridge past omitted turns (folded: %s, intervening rival: %s)", async (folded, intervening) => {
    const threadId = "legacy-turn-bridge-with-competing-raw-claim"
    const user = (id: string) => ({ id, type: "human", content: id })
    const assistant = (id: string, content: string) => persistedMessageToRuntimeMessage({
      id, role: "assistant", provider_source_id: id, provider_occurrence: 1, content, created_at: new Date(1)
    })
    const [first, second, fence] = [user("first"), user("second"), user("fence")]
    const [a1, a2] = [assistant("anchor", "first anchor"), assistant("anchor", "second anchor")]
    const [r1, r2] = [assistant("reply", "first reply"), assistant("reply", "second reply")]
    const source = intervening ? [first, user("intervening"), a1, r1, second, a2, r2, fence]
      : [first, a1, r1, second, a2, r2, fence]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: source })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      const extended = folded ? assistant("anchor", "second anchor unauthorized") : assistant("reply", "second reply unauthorized")
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("omitted", 2, [first, a2, extended, fence]), metadata)
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
      expect(db.prepare(`SELECT content_json FROM thread_messages WHERE role = 'assistant' ORDER BY ordinal`)
        .all().map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["first anchor", "first reply", "second anchor", "second reply"])
    } finally {
      await saver.close()
      db.close()
    }
  })

  it.each(["append text", "prepend text", "append reasoning", "append tool call", "restore omitted",
    "omit verified prefix", "replace text", "hide Markdown reference"])(
    "rechecks unresolved coverage after %s", async (mode) => {
    const threadId = "legacy-claim-retention"
    const user = (id: string) => ({ id, type: "human", content: id })
    const assistant = (id: string, content: string, extra: Partial<Message> = {}) => persistedMessageToRuntimeMessage({
      id, role: "assistant", provider_source_id: id, provider_occurrence: 1, content, created_at: new Date(1), ...extra
    })
    const anchor = assistant("anchor", "shared anchor")
    const before = assistant("reply", "saved prefix")
    const hiddenReference = mode === "hide Markdown reference"
    const pendingText = hiddenReference ? "saved prefix\n\n[pending text]" : "saved prefix pending text"
    const unresolved = assistant("reply", pendingText)
    const verifiedPrefix = mode === "omit verified prefix"
      ? [{ id: "old-note", type: "system", content: "already verified system note" }] : []
    const messages = [...verifiedPrefix, user("first"), anchor, before, user("second"), anchor, before]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      const save = (step: number, selected: typeof messages) => saver.put(config(threadId, legacyCheckpoint.id),
        checkpoint("ambiguous", step, selected), metadata)
      await save(2, [...verifiedPrefix, anchor, unresolved])
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
      if (mode === "restore omitted") {
        await save(3, [anchor])
        await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
      }
      db.prepare("UPDATE thread_messages SET content_json = ? WHERE message_id = 'anchor'")
        .run(JSON.stringify("updated first anchor"))
      const text = hiddenReference ? pendingText + ": https://example.invalid/ref"
        : mode.startsWith("append") ? pendingText + " plus newer words"
          : mode === "prepend text" ? "new explanation: " + pendingText
            : mode === "replace text" ? "saved prefix other words" : pendingText
      const extra: Partial<Message> = mode === "append reasoning" ? { reasoning: "detached reasoning" }
        : mode === "append tool call" ? { tool_calls: [{ id: "call", name: "read", args: { path: "file" } }] } : {}
      await save(4, [anchor, assistant("reply", text, extra)])
      await expect(recover()).resolves.toMatchObject({
        stats: { searchProjectionState: mode === "replace text" || hiddenReference ? "unverified" : "complete" }
      })
      expect(db.prepare(`SELECT content_json FROM thread_messages WHERE role = 'assistant' AND provider_source_id = 'reply'
        ORDER BY ordinal DESC LIMIT 1`).get()?.content_json).toBe(JSON.stringify(text))
    } finally {
      await saver.close()
      db.close()
    }
  })

  it.each(["pruned original", "skipped descendants", "reparented ID", "pruned reparented ID"])(
    "retains the verified checkpoint history with %s", async (mode) => {
    const threadId = "legacy-persisted-ancestry"
    const prompt = { id: "question", type: "human", content: "common question" }
    const answer = (content: string) => ({ id: "answer", type: "ai", content })
    const original = "published answer"
    const revision = "changed answer"
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [prompt, answer(original)]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const save = async (id: string, parent: string | undefined, step: number, content: string) => {
      const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 3 })
      try {
        await saver.put(config(threadId, parent), checkpoint(id, step, [prompt, answer(content)]), metadata)
      } finally { await saver.close() }
    }
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      let parent = legacyCheckpoint.id
      const reparented = mode.endsWith("reparented ID")
      const last = mode === "skipped descendants" ? 132 : reparented ? 2 : 6
      for (let index = 2; index <= last; index += 1) {
        const child = `next-${index}`
        await save(child, parent, index, original)
        if (mode !== "skipped descendants") {
          await expect(recover()).resolves.toMatchObject({ stats: { checkpointId: child, searchProjectionState: "complete" } })
        }
        parent = child
      }
      if (!reparented) {
        const source = new DatabaseSync(databasePath, { readOnly: true })
        try {
          expect(source.prepare("SELECT 1 FROM checkpoints WHERE checkpoint_id = ?").get(legacyCheckpoint.id))
            .toBeUndefined()
        } finally { source.close() }
        if (mode === "skipped descendants") {
          const source = new DatabaseSync(databasePath, { readOnly: true })
          try {
            expect(source.prepare(`SELECT ancestor_span_depth FROM checkpoint_lineage WHERE checkpoint_id = ?`)
              .get(parent)?.ancestor_span_depth).toBe(128)
          } finally { source.close() }
        }
        await save("revised", parent, last + 1, revision)
        await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      } else {
        await save("branch-root", undefined, 3, original)
        await save(parent, "branch-root", 4, revision)
        if (mode === "reparented ID") {
          await expect(recover()).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
        } else {
          for (let index = 5; index <= 7; index += 1) {
            const child = `branch-${index}`
            await save(child, parent, index, revision)
            parent = child
          }
          await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
        }
      }
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'answer'").get()?.content_json)
        .toBe(JSON.stringify(reparented ? original : revision))
    } finally { db.close() }
  }, 30_000)

  it("restores a pre-heartbeat checkpoint with its original parent and other saved ancestors", async () => {
    const threadId = "legacy-restored-heartbeat"
    const question = { id: "prompt", type: "human", content: "existing prompt" }
    const answer = (content: string) => ({ id: "reply", type: "ai", content })
    const stable = [question, answer("published reply")]
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: stable })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 3 })
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("before-heartbeat", 2, stable), metadata)
      const snapshot = await saver.getTuple(config(threadId))
      expect(snapshot?.checkpoint.id).toBe("before-heartbeat")
      let parent = "before-heartbeat"
      for (let step = 3; step <= 6; step += 1) {
        const id = `silent-${step}`
        await saver.put(config(threadId, parent), checkpoint(id, step, [...stable,
          { id: "silent", type: "ai", content: "HEARTBEAT_OK" }]), metadata)
        parent = id
      }
      await saver.restoreThreadCheckpoint(threadId, snapshot)
      expect((await saver.getTuple(config(threadId)))?.parentConfig?.configurable?.checkpoint_id)
        .toBe(legacyCheckpoint.id)
      await expect(recover()).resolves.toMatchObject({ stats: { checkpointId: "before-heartbeat", searchProjectionState: "complete" } })
      await saver.put(config(threadId, "before-heartbeat"), checkpoint("after-heartbeat", 7,
        [question, answer("revised after heartbeat")]), metadata)
      await expect(recover()).resolves.toMatchObject({ stats: { checkpointId: "after-heartbeat", searchProjectionState: "complete" } })
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'reply'").get()?.content_json)
        .toBe('"revised after heartbeat"')
    } finally {
      await saver.close()
      db.close()
    }
  })

  it("keeps both published turns when explicit provider IDs are reused", async () => {
    const threadId = "legacy-explicit-turn-reuse"
    const question = (id: string) => ({ id, role: "user" as const, content: id, created_at: new Date(1) })
    const first = { id: "reply", role: "assistant" as const, content: "first reply", created_at: new Date(1) }
    const q1 = question("first")
    const firstTurn = [q1, first].map(persistedMessageToRuntimeMessage)
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: firstTurn })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const second = { ...first, provider_source_id: "reply", provider_occurrence: 1, content: "second reply" }
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          [...firstTurn, ...[question("second"), second].map(persistedMessageToRuntimeMessage)]), metadata)
      } finally { await saver.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: "complete", migratedMessages: 2 } })
      expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
        .map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["first", "first reply", "second", "second reply"])
    } finally { db.close() }
  })

  it.each(["sibling", "descendant"])("protects visible partial fragments when a %s changes the reply", async (relation) => {
    const threadId = "legacy-active-publication-ancestry"
    const prompt = { id: "question", type: "human", content: "common question" }
    const answer = (content: string) => ({ id: "reply", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [prompt] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const save = async (id: string, parent: string, step: number, content: string) => {
      const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 4 })
      try {
        await saver.put(config(threadId, parent), checkpoint(id, step, [prompt, answer(content)]), metadata)
      } finally { await saver.close() }
    }
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      await save("wide-child", legacyCheckpoint.id, 2, "durable draft visible in search. ".repeat(65_000))
      const interrupted = new CheckpointRuntimeProjectionClient(async () => new Worker(`
        const { workerData } = require("node:worker_threads")
        const { DatabaseSync } = require("node:sqlite")
        const execute = DatabaseSync.prototype.exec
        DatabaseSync.prototype.exec = function (sql) {
          const result = execute.call(this, sql)
          if (sql === "COMMIT" && this.location() === workerData.durablePath &&
              this.prepare("SELECT partial_version FROM legacy_checkpoint_transcript_imports WHERE message_id = 'reply'")
                .get()?.partial_version > 0) throw new Error("interrupted visible fragment copy")
          return result
        }
        require(workerData.workerBundlePath)
      `, { eval: true, workerData: { workerBundlePath, durablePath } }))
      clients.push(interrupted)
      await expect(interrupted.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted visible fragment copy")
      const visible = () => db.prepare(`SELECT m.content_json, m.fragment_generation,
        (SELECT COUNT(*) FROM thread_message_fragments AS f WHERE f.thread_id = m.thread_id
          AND f.message_id = m.message_id AND f.generation = m.fragment_generation) AS parts
        FROM thread_messages AS m WHERE m.message_id = 'reply'`).get()
      const before = visible()
      expect(Number(before?.parts)).toBeGreaterThan(0)
      const parent = relation === "descendant" ? "wide-child" : legacyCheckpoint.id
      await save("newer", parent, 3, "replacement answer")
      if (relation === "descendant") {
        await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
        expect(visible()).toMatchObject({ content_json: '"replacement answer"', parts: 0 })
      } else {
        await expect(recover()).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
        expect(visible()).toEqual(before)
      }
    } finally { db.close() }
  })

  it.each(["two revisions", "matching first reply", "explicit left boundary"])(
    "aligns reused replies in a closed ordinal interval with %s", async (mode) => {
    const threadId = "legacy-closed-reply-interval"
    const question = { id: "question", type: "human", content: "common question" }
    const left = mode === "explicit left boundary"
      ? persistedMessageToRuntimeMessage({ id: "left", role: "assistant", content: "left boundary",
        created_at: new Date(1), provider_source_id: "left", provider_occurrence: 1 })
      : { id: "left", type: "ai", content: "left boundary" }
    const right = { id: "right", type: "ai", content: "right boundary" }
    const reply = (content: string) => ({ id: "reply", type: "ai", content })
    const firstDraft = mode === "matching first reply" ? "shared draft" : "first draft"
    const secondDraft = mode === "matching first reply" ? "shared draft" : "second draft"
    const firstFinal = mode === "matching first reply" ? firstDraft : "first final"
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [question, left, reply(firstDraft), reply(secondDraft), right] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2, [
          question, left, reply(firstFinal), reply("second final"), right
        ]), metadata)
      } finally { await saver.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(db.prepare("SELECT ordinal, content_json FROM thread_messages WHERE ordinal IN (2, 3) ORDER BY ordinal").all())
        .toEqual([{ ordinal: 2, content_json: JSON.stringify(firstFinal) }, { ordinal: 3, content_json: '"second final"' }])
    } finally { db.close() }
  })

  it.each(["distinct prompt", "identical prompt", "new reply in a later turn",
    "distinct declared reply", "revision of the second declaration"])(
    "checks declared IDs against the physical user turn for a %s", async (mode) => {
      const threadId = "legacy-explicit-suffix"
      const prompt = (text: string, id = "prompt") => persistedMessageToRuntimeMessage({
        id, role: "user", content: text, created_at: new Date(1), provider_source_id: id, provider_occurrence: 1
      })
      const reply = (text: string, occurrence = 1) => persistedMessageToRuntimeMessage({
        id: "reply", role: "assistant", content: text, created_at: new Date(1),
        provider_source_id: "reply", provider_occurrence: occurrence
      })
      const secondText = mode === "identical prompt" ? "first prompt" : "second prompt"
      const q1 = prompt("first prompt")
      const laterDeclaration = mode === "distinct declared reply" || mode === "revision of the second declaration"
      const q2 = prompt(secondText, mode === "new reply in a later turn" || laterDeclaration ? "later-user" : "prompt")
      const original = [q1, reply("first reply")]
      const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
        messages: mode === "new reply in a later turn" ? original
          : [...original, q2, reply("old second reply", laterDeclaration ? 2 : 1)] })
      const durablePath = createMessageDatabase(databasePath, threadId)
      const db = new DatabaseSync(durablePath)
      try {
        installVersionedLegacyFixtureSchema(db)
        const client = createClient()
        const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        await recover()
        const saver = new SqlJsSaver(databasePath)
        try {
          await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
            [q2, reply("new second reply", mode === "revision of the second declaration" ? 2 : 1)]), metadata)
        } finally { await saver.close() }
        if (mode === "identical prompt") {
          await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
        } else {
          await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
        }
        expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
          .map(({ content_json }) => JSON.parse(String(content_json)))).toEqual([
          "first prompt", "first reply", secondText,
          ...(mode === "distinct declared reply" ? ["old second reply"] : []),
          mode === "identical prompt" ? "old second reply" : "new second reply"
        ])
      } finally { db.close() }
    })

  it.each([false, true])("protects a pre-prompt reply from an unanchored suffix (declared: %s)", async (declared) => {
    const threadId = "legacy-open-prefix-and-later-user"
    const reply = (content: string) => declared
      ? persistedMessageToRuntimeMessage({ id: "reply", role: "assistant", content, created_at: new Date(1),
        provider_source_id: "reply", provider_occurrence: 1 })
      : { id: "reply", type: "ai", content }
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [reply("published opening reply"), { id: "later-prompt", type: "human", content: "later question" }] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          [reply("unanchored later reply")]), metadata)
      } finally { await saver.close() }
      if (declared) {
        await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
      } else {
        await expect(recover()).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
      }
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'reply'").get()?.content_json)
        .toBe('"published opening reply"')
    } finally { db.close() }
  })

  it.each(["tool", "system"] as const)("uses physical turn and call evidence for a reused %s ID", async (role) => {
    const threadId = "legacy-recovered-role-occurrence"
    const prompt = (id: string) => ({ id, type: "human", content: id })
    const output = (content: string, call: string) => persistedMessageToRuntimeMessage({
      id: "same-output", role, content, created_at: new Date(1),
      provider_source_id: "same-output", provider_occurrence: 1,
      ...(role === "tool" ? { tool_call_id: call } : {})
    })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [prompt("first"), output("first output", "call-1"), prompt("second"), output("old second", "call-2")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2, [
          ...(role === "system" ? [prompt("second")] : []), output("new second", "call-2")
        ]), metadata)
      } finally { await saver.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(db.prepare("SELECT content_json FROM thread_messages WHERE role = ? ORDER BY ordinal").all(role)
        .map(({ content_json }) => JSON.parse(String(content_json)))).toEqual(["first output", "new second"])
    } finally { db.close() }
  })

  it.each(["same turn", "repeated prompts", "truncated before repeated slots"])(
    "reconciles bare repeated occurrences by payload and order for %s", async (mode) => {
      const threadId = "legacy-physical-occurrence-placement"
      const prompt = (content: string) => ({ id: "question", type: "human", content })
      const reply = (content: string) => ({ id: "reply", type: "ai", content })
      const first = prompt("first prompt")
      const second = mode === "repeated prompts" ? first : prompt("second prompt")
      const third = prompt("third prompt")
      const [a, b, c] = ["first", "second", "third"].map((slot) => reply(slot + " reply"))
      const changed = reply("updated reply")
      const parent = mode === "same turn" ? [first, a, b] :
        mode === "repeated prompts" ? [first, a, second, b] : [first, a, second, b, third, c]
      const selected = mode === "same turn" ? [first, b] :
        mode === "repeated prompts" ? [first, a, second, changed] : [second, b, third, changed]
      const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: parent })
      const durablePath = createMessageDatabase(databasePath, threadId)
      const db = new DatabaseSync(durablePath)
      try {
        installVersionedLegacyFixtureSchema(db)
        const client = createClient()
        await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        const saver = new SqlJsSaver(databasePath)
        try {
          await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2, selected), metadata)
        } finally { await saver.close() }
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { checkpointId: "child", searchProjectionState: "complete" } })
        const expected = parent.slice()
        if (mode !== "same turn") expected[expected.length - 1] = changed
        expect(db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
          .map(({ content_json }) => JSON.parse(String(content_json)))).toEqual(expected.map(({ content }) => content))
      } finally { db.close() }
    })

  it("keeps distinct tool calls under one provider ID in the same turn", async () => {
    const threadId = "legacy-distinct-tool-invocations"
    const question = { id: "prompt", type: "human", content: "published prompt" }
    const tool = (call: string, content: string) => persistedMessageToRuntimeMessage({
      id: "tool", role: "tool", provider_source_id: "tool", provider_occurrence: 1,
      tool_call_id: call, content, created_at: new Date(1)
    })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [question, tool("call-1", "first output"), tool("call-2", "second output")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
          [tool("call-3", "new tool output")]), metadata)
      } finally { await saver.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { searchProjectionState: "complete", migratedMessages: 1 } })
      expect(db.prepare("SELECT tool_call_id, content_json FROM thread_messages WHERE role = 'tool' ORDER BY ordinal").all())
        .toEqual([
          { tool_call_id: "call-1", content_json: '"first output"' },
          { tool_call_id: "call-2", content_json: '"second output"' },
          { tool_call_id: "call-3", content_json: '"new tool output"' }
        ])
    } finally { db.close() }
  })

  it.each(["both exact", "second draft extends", "second draft gains fragments"])(
    "keeps independently matched drafts when the source omits a prompt and the drafts are %s", async (mode) => {
    const threadId = "legacy-drafts-with-omitted-prompts"
    const prompt = (id: string) => ({ id, type: "human", content: id })
    const assistant = (id: string, content: string) => persistedMessageToRuntimeMessage({
      id, role: "assistant", provider_source_id: id, provider_occurrence: 1, content, created_at: new Date(1)
    })
    const a1 = assistant("anchor", "first exact draft")
    const a2 = assistant("anchor", "second exact draft")
    const finalBody = "second exact draft with its extension" +
      (mode === "second draft gains fragments" ? " continued".repeat(109_000) + " exact end needle" : "")
    const final = assistant("anchor", finalBody)
    const fence = prompt("fence")
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: [
      prompt("first"), a1, assistant("reply", "first reply"),
      prompt("second"), a2, assistant("reply", "second draft"), fence
    ] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      try {
        const messages = mode === "both exact" ? [a1, a2, assistant("reply", "second final"), fence]
          : [prompt("first"), a1, a2, final, fence]
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2, messages), metadata)
      } finally { await saver.close() }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { searchProjectionState: "complete", migratedMessages: 0 } })
      }
      const rows = db.prepare(`SELECT message_id, content_json, fragment_generation FROM thread_messages
        WHERE role = 'assistant' ORDER BY ordinal`).all()
      expect(rows).toHaveLength(4)
      expect(rows.filter((_row, index) => index !== 2).map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["first exact draft", "first reply", mode === "both exact" ? "second final" : "second draft"])
      const parts = db.prepare(`SELECT content_text FROM thread_message_fragments
        WHERE message_id = ? AND generation = ? ORDER BY fragment_id`)
        .all(rows[2].message_id, rows[2].fragment_generation)
      const actual = JSON.parse(String(rows[2].content_json)) + parts.map(({ content_text }) => content_text).join("")
      const expected = mode === "both exact" ? "second exact draft" : finalBody
      expect(actual.length).toBe(expected.length)
      expect(actual.endsWith(expected.slice(-60))).toBe(true)
    } finally { db.close() }
  }, 30_000)

  it("retains a native reply when a newer prompt repeats its ID and body before a retained fence", async () => {
    const threadId = "legacy-native-prospective-prompt"
    const user = (id: string) => ({ id, type: "human", content: id })
    const answer = (content: string) => persistedMessageToRuntimeMessage({
      id: "reply", role: "assistant", provider_source_id: "reply", provider_occurrence: 1,
      content, created_at: new Date(1)
    })
    const [q1, q2, fence] = [user("first"), user("second"), user("fence")]
    const shared = "identical published body"
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [q1, answer(shared), fence] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 4 })
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1")
      const insert = db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, created_at, ordinal, provider_source_id, provider_occurrence)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
      insert.run(threadId, "first", "user", '"first"', 0, null, null)
      insert.run(threadId, "reply", "assistant", JSON.stringify(shared), 1, "reply", 1)
      insert.run(threadId, "fence", "user", '"fence"', 2, null, null)
      const client = createClient()
      const recover = () => client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      await recover()
      await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("child", 2,
        [q1, q2, answer(shared), fence]), metadata)
      await expect(recover()).resolves.toMatchObject({ stats: { migratedMessages: 2, searchProjectionState: "complete" } })
      await saver.put(config(threadId, "child"), checkpoint("grandchild", 3,
        [q2, answer(shared + " with a later extension"), fence]), metadata)
      await expect(recover()).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(db.prepare("SELECT role, content_json FROM thread_messages ORDER BY ordinal").all()
        .map(({ content_json }) => JSON.parse(String(content_json))))
        .toEqual(["first", shared, "second", shared + " with a later extension", "fence"])
    } finally {
      await saver.close()
      db.close()
    }
  })

  it("does not borrow a reply from another known turn after a headless anchor", async () => {
    const threadId = "legacy-headless-known-turn"
    const q = (id: string) => ({ id, type: "human", content: id })
    const anchor = { id: "earlier-anchor", type: "ai", content: "first turn anchor" }
    const reply = (content: string) => ({ id: "bare-reply", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [q("first"), anchor, q("second"), reply("second turn's saved reply")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const saver = new SqlJsSaver(databasePath)
      try {
        await saver.put(config(threadId, legacyCheckpoint.id), checkpoint("headless-child", 2,
          [anchor, reply("first turn's new reply")]), metadata)
      } finally { await saver.close() }
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const replies = db.prepare(`SELECT content_json FROM thread_messages
        WHERE message_id = 'bare-reply' OR provider_source_id = 'bare-reply' ORDER BY ordinal`).all()
      expect(replies.map((row) => JSON.parse(String(row.content_json))))
        .toEqual(["second turn's saved reply", "first turn's new reply"])
    } finally { db.close() }
  })

  it("keeps both replies when a headless source repeats an identical anchor from two turns", async () => {
    const threadId = "legacy-ambiguous-turn-anchor"
    const prompt = (id: string) => ({ id, type: "human", content: id })
    const anchor = { id: "same-anchor", type: "ai", content: "identical anchor body" }
    const reply = (content: string) => ({ id: "repeated-reply", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: [prompt("first"), anchor, reply("first saved reply"), prompt("second"), anchor, reply("second saved reply")] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const read = () => db.prepare("SELECT message_id, content_json, ordinal FROM thread_messages ORDER BY ordinal").all()
      const before = read()
      expect(before).toHaveLength(6)
      const saver = new SqlJsSaver(databasePath)
      const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2, [anchor, reply("ambiguous replacement")]))
      await saver.close()
      const source = new DatabaseSync(databasePath)
      try { source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload) }
      finally { source.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
      expect(read()).toEqual(before)
    } finally { db.close() }
  })

  it.each([false, true])("retains native occurrence evidence across descendants (headless ambiguity: %s)", async (headless) => {
    const threadId = "legacy-native-occurrence-witness"
    const record = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content, created_at: new Date(1) })
    const anchor = record("anchor", "assistant", "identical anchor")
    const turn = (id: string, text: string) => [record(id, "user", id), anchor, record("reply", "assistant", text)]
    const first = turn("first", "first saved answer")
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId,
      messages: first.map(persistedMessageToRuntimeMessage) })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec("ALTER TABLE thread_messages ADD COLUMN recovery_integrity INTEGER DEFAULT 1")
      const insert = db.prepare(`INSERT INTO thread_messages (thread_id, message_id, role, content_json, created_at, ordinal)
        VALUES (?, ?, ?, ?, 1, ?)`)
      for (const [index, message] of first.entries()) insert.run(threadId, message.id, message.role, JSON.stringify(message.content), index)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      expect(db.prepare(`SELECT owned_by_migration FROM legacy_checkpoint_transcript_imports WHERE message_id = 'reply'`)
        .get()?.owned_by_migration).toBe(0)
      const save = async (id: string, previous: string, version: number, rows: ReturnType<typeof record>[]) => {
        const saver = new SqlJsSaver(databasePath, undefined, { maxRootCheckpoints: 4 })
        try {
          await saver.put(config(threadId, previous), checkpoint(id, version, rows.map(persistedMessageToRuntimeMessage)), metadata)
        } finally { await saver.close() }
      }
      await save("native-child", legacyCheckpoint.id, 2, turn("second", "second saved answer"))
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const read = () => db.prepare(`SELECT content_json FROM thread_messages WHERE role = 'assistant' AND
        (message_id = 'reply' OR provider_source_id = 'reply') ORDER BY ordinal`).all()
        .map((row) => JSON.parse(String(row.content_json)))
      expect(read()).toEqual(["first saved answer", "second saved answer"])
      await save("native-grandchild", "native-child", 3, headless
        ? [anchor, record("reply", "assistant", "ambiguous answer")] : turn("third", "third saved answer"))
      const bootstrap = client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      if (headless) await expect(bootstrap).resolves.toMatchObject({ stats: { searchProjectionState: "unverified" } })
      else await expect(bootstrap).resolves.toMatchObject({ stats: { searchProjectionState: "complete" } })
      expect(read()).toEqual(["first saved answer", "second saved answer", ...(headless ? [] : ["third saved answer"])])
    } finally { db.close() }
  })

  it("preserves published replies when later durable anchors contradict source order", async () => {
    const threadId = "legacy-conflicting-anchor-order"
    const q = { id: "question", type: "human", content: "same prompt" }
    const a = { id: "first-anchor", type: "ai", content: "first stable anchor" }
    const b = { id: "second-anchor", type: "ai", content: "second stable anchor" }
    const r = (content: string) => ({ id: "repeat", type: "ai", content })
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({
      threadId, messages: [q, r("old reply stays"), a, b, r("another old reply")]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = createClient()
      await client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      const read = () => db.prepare("SELECT content_json FROM thread_messages ORDER BY ordinal").all()
      const before = read()
      const saver = new SqlJsSaver(databasePath)
      const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2,
        [q, r("unverified replacement"), { ...b, content: "second anchor revised" }, a]))
      await saver.close()
      const source = new DatabaseSync(databasePath)
      try { source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload) }
      finally { source.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
      expect(read()).toEqual(before)
    } finally { db.close() }
  })

  it.each([60, 66])("adopts a compacted source after committing 64 inline rows (start: %s)", async (start) => {
    const threadId = "legacy-compacted-published-inline"
    const transcript = Array.from({ length: 67 }, (_, index) => ({ id: `m-${index}`, type: "human", content: `Prompt ${index}` }))
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: transcript })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.exec(`CREATE TRIGGER stop_inline_copy BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'm-64'
        BEGIN SELECT RAISE(ABORT, 'interrupted after inline prefix'); END`)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)).rejects.toThrow("interrupted after inline prefix")
      db.exec("DROP TRIGGER stop_inline_copy")
      expect(db.prepare("SELECT next_index FROM legacy_checkpoint_transcript_migrations").get()?.next_index).toBe(64)
      const saver = new SqlJsSaver(databasePath)
      const latest = [...transcript.slice(start, 66), { ...transcript[66], content: "Newest reserved prompt" }]
      const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, 2, latest))
      await saver.close()
      const source = new DatabaseSync(databasePath)
      try { source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload) }
      finally { source.close() }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: 67 - start, searchProjectionState: "unverified" } })
      const rows = db.prepare("SELECT message_id, ordinal, content_json FROM thread_messages ORDER BY ordinal").all()
      expect(rows[63]).toMatchObject({ message_id: "m-63", ordinal: 63 })
      expect(rows.at(-1)).toMatchObject({ message_id: "m-66", content_json: '"Newest reserved prompt"' })
    } finally { db.close() }
  })

  it.each(["merged messages", "a conflicting raw ID"])(
    "keeps the current durable row and copies unrelated history with %s", async (mode) => {
    const threadId = "legacy-overlap-source-members"
    const merged = mode === "merged messages"
    const earlier = { id: "older", type: "human", content: "older history" }
    const source = merged
      ? [{ id: "temporary-id", type: "ai", content: "earlier text", reasoning: "Earlier visible reasoning." },
          { id: "canonical-id", type: "ai", content: "earlier text plus retained words",
            reasoning: "Earlier visible reasoning. More visible reasoning." }]
      : [{ id: "temporary-id", type: "human", content: "unrelated historical user text" }]
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages: [earlier, ...source] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const messageId = merged ? "canonical-id" : "temporary-id"
      const content = merged ? "earlier text plus retained words" : "live user text with a separate origin"
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, provider_source_id, ordinal, created_at, content_json, reasoning)
        VALUES (?, ?, ?, ?, 0, 1, ?, ?)`)
        .run(threadId, messageId, merged ? "assistant" : "user",
          merged ? "temporary-id" : "different-provider", JSON.stringify(content),
          merged ? "Earlier visible reasoning. More visible reasoning." : null)
      const legacyCreatedAt = Number(db.prepare("SELECT created_at FROM threads WHERE thread_id = ?")
        .get(threadId)?.created_at)
      await expect(createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId, "", undefined, {
        guard: { incarnation: { token: null, legacyCreatedAt } }
      })).resolves.toMatchObject({ stats: {
        migratedMessages: 1, searchProjectionState: merged ? "overlap-unverified" : "unverified"
      } })
      expect(db.prepare("SELECT message_id, content_json FROM thread_messages ORDER BY ordinal").all())
        .toEqual([
          { message_id: "older", content_json: '"older history"' },
          { message_id: messageId, content_json: JSON.stringify(content) }
        ])
    } finally {
      db.close()
    }
  })

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

  it("waits for a superseded bootstrap to acknowledge cancellation before releasing its lease", async () => {
    const posted: Array<{ requestId: number; cancellationBuffer: SharedArrayBuffer }> = []
    const emitter = new EventEmitter()
    const worker = Object.assign(emitter, {
      postMessage(message: typeof posted[number] & { type: string }) {
        if (message.type === "shutdown") {
          queueMicrotask(() => emitter.emit("message", { type: "shutdown-complete" }))
        } else {
          posted.push(message)
        }
      },
      unref: () => {},
      terminate: async () => 0
    }) as unknown as Worker
    const client = new CheckpointRuntimeProjectionClient(async () => worker)
    clients.push(client)
    let settled = false
    const previous = client.bootstrapLegacyTranscript("old.sqlite", "messages", "old", "", "window")
    const cancelled = previous.catch((error) => {
      settled = true
      return error
    })
    const latest = client.readLatestRuntimeTuple("new.sqlite", "new", "", "window")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(posted).toHaveLength(2)
    expect(Atomics.load(new Int32Array(posted[0].cancellationBuffer), 0)).toBe(1)
    expect(settled).toBe(false)
    emitter.emit("message", {
      type: "bootstrap-legacy-transcript-result",
      requestId: posted[0].requestId,
      ok: true
    })
    emitter.emit("message", {
      type: "read-latest-runtime-tuple-result",
      requestId: posted[1].requestId,
      ok: true,
      tuple: { checkpoint: { id: "new" } }
    })
    expect(await cancelled).toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
    await expect(latest).resolves.toEqual({ checkpoint: { id: "new" } })
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

  it.each([false, true])(
    "reuses native Goal message identities on cold bootstrap (partial legacy history: %s)",
    async (partialLegacyHistory) => {
      const threadId = `goal-bootstrapped-${partialLegacyHistory}`
      const marked = { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true }
      const provider = (source: string, occurrence: number) => ({
        [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: source,
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: occurrence
      })
      const { databasePath } = await seedLegacyInlineFixture({
        threadId,
        messages: [
          new HumanMessage({
            id: "root",
            content: "internal Goal setup",
            additional_kwargs: { ...marked, cmb_visible_user_message: "/goal evidence" }
          }).toJSON(),
          new AIMessage({
            id: "graph-assistant-first",
            content: "draft from checkpoint",
            additional_kwargs: provider("same-assistant", 1)
          }).toJSON(),
          new ToolMessage({
            id: "graph-tool-first",
            content: "first checkpoint result",
            tool_call_id: "same-call",
            additional_kwargs: provider("same-tool", 1)
          }).toJSON(),
          ...(partialLegacyHistory
            ? [new AIMessage({ id: "legacy-only", content: "import this earlier row" }).toJSON()]
            : []),
          new HumanMessage({
            id: "hidden",
            content: "[Continuing active goal] hidden payload",
            additional_kwargs: marked
          }).toJSON(),
          new AIMessage({
            id: "graph-assistant-second",
            content: "second checkpoint assistant",
            additional_kwargs: provider("same-assistant", 2)
          }).toJSON(),
          new ToolMessage({
            id: "graph-tool-second",
            content: "second checkpoint result",
            tool_call_id: "same-call",
            additional_kwargs: provider("same-tool", 2)
          }).toJSON(),
          new HumanMessage({
            id: "resume",
            content: "internal Goal resume",
            additional_kwargs: { ...marked, cmb_visible_user_message: "/goal resume" }
          }).toJSON()
        ]
      })
      const messageDatabasePath = createMessageDatabase(databasePath, threadId)
      const database = new DatabaseSync(messageDatabasePath)
      database.exec(`
        ALTER TABLE thread_messages ADD COLUMN fragment_generation TEXT NOT NULL DEFAULT '';
        ALTER TABLE thread_messages ADD COLUMN fork_replay_key TEXT;
        CREATE INDEX thread_message_provider_identity
          ON thread_messages(thread_id, provider_source_id, role, provider_occurrence);
        CREATE TABLE thread_graph_transcript_boundaries (
          thread_id TEXT NOT NULL,
          graph_user_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          PRIMARY KEY(thread_id, graph_user_id)
        );
      `)
      database.prepare("INSERT INTO thread_graph_transcript_boundaries VALUES (?, 'hidden', 3)")
        .run(threadId)
      const insert = database.prepare(`
        INSERT INTO thread_messages (
          thread_id, message_id, role, ordinal, provider_source_id, provider_occurrence,
          tool_call_id, created_at, content_json, content_priority, goal_id, active_window_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?, 7, 'goal', 'window')
      `)
      const originals = [
        ["root", "user", 0, null, null, null],
        ["native-first", "assistant", 1, "same-assistant", 1, null],
        ["native-tool-first", "tool", 2, "same-tool", 1, "same-call"],
        ["native-second", "assistant", 4, "same-assistant", 2, null],
        ["native-tool-second", "tool", 5, "same-tool", 2, "same-call"],
        ...(partialLegacyHistory ? [] : [["resume", "user", 6, null, null, null] as const]),
        ["unrelated-call-result", "tool", 50, "same-tool", 2, "different-call"]
      ] as const
      for (const row of originals) insert.run(threadId, ...row, JSON.stringify(row[0]))
      database.prepare("INSERT INTO thread_message_buckets VALUES (?, ?, 52, 123)")
        .run(threadId, originals.length)
      const readRows = () => database.prepare(`
        SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY ordinal
      `).all(threadId)
      const before = readRows()

      try {
        const client = createClient()
        const bootstrap = () =>
          client.bootstrapLegacyTranscript(databasePath, messageDatabasePath, threadId)
        await expect(bootstrap()).resolves.toMatchObject({
          stats: {
            totalMessages: partialLegacyHistory ? 7 : 6,
            migratedMessages: partialLegacyHistory ? 2 : 0,
            ...(partialLegacyHistory ? {} : { batches: 0 })
          }
        })
        const after = readRows()
        if (!partialLegacyHistory) {
          expect(after).toEqual(before)
        } else {
          expect(after.map(({ message_id, ordinal }) => [message_id, ordinal])).toEqual([
            ["root", 0],
            ["native-first", 1],
            ["native-tool-first", 2],
            ["legacy-only", 3],
            ["native-second", 5],
            ["native-tool-second", 6],
            ["resume", 7],
            ["unrelated-call-result", 52]
          ])
          expect(after.find((row) => row.message_id === "resume")?.content_json).toBe(
            '"/goal resume"'
          )
          const omitOrdinal = (row: Record<string, unknown>) =>
            Object.fromEntries(Object.entries(row).filter(([column]) => column !== "ordinal"))
          expect(after.filter((row) => row.goal_id === "goal").map(omitOrdinal)).toEqual(
            before.map(omitOrdinal)
          )
        }
        expect(database.prepare("SELECT ordinal FROM thread_graph_transcript_boundaries").get())
          .toMatchObject({ ordinal: partialLegacyHistory ? 4 : 3 })
        expect(database.prepare("SELECT next_ordinal FROM thread_message_buckets").get())
          .toMatchObject({ next_ordinal: partialLegacyHistory ? 54 : 52 })
        expect(database.prepare("SELECT status FROM legacy_checkpoint_transcript_migrations").get())
          .toMatchObject({ status: "complete" })
        await expect(bootstrap()).resolves.toMatchObject({ stats: { migratedMessages: 0, batches: 0 } })
        expect(readRows()).toEqual(after)
      } finally {
        database.close()
      }
    }
  )

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

  it.each(["while copying", "before reopening", "with a damaged prefix", "after a completed copy replaces it"])(
    "checks committed fragments when a message ID is changed %s", async (mode) => {
    const threadId = "renamed-fragmented-legacy-message"
    const body = `${"0123456789".repeat(215_000)}😀 end`
    const { databasePath } = await seedLegacyInlineFixture({ threadId, messages: [
      { id: "wide", type: "ai", content: body },
      { id: "later", type: "human", content: "later message" }
    ] })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      const client = new CheckpointRuntimeProjectionClient(async () => new Worker(`
        const { workerData } = require("node:worker_threads")
        const { DatabaseSync } = require("node:sqlite")
        const execute = DatabaseSync.prototype.exec
        let renamed = false
        DatabaseSync.prototype.exec = function (sql) {
          const result = execute.call(this, sql)
          if (!renamed && sql === "COMMIT" && this.location() === workerData.durablePath &&
              this.prepare("SELECT current_fragment_index FROM legacy_checkpoint_transcript_migrations")
                .get()?.current_fragment_index > 0) {
            renamed = true
            execute.call(this, [
              "BEGIN",
              "UPDATE thread_messages SET message_id = 'canonical', provider_source_id = 'wide' WHERE message_id = 'wide'",
              "UPDATE thread_message_fragment_states SET message_id = 'canonical' WHERE message_id = 'wide'",
              "UPDATE thread_message_fragments SET message_id = 'canonical' WHERE message_id = 'wide'",
              workerData.mode === "with a damaged prefix"
                ? "UPDATE thread_message_fragments SET content_text = 'changed' WHERE fragment_id = 1" : "",
              "COMMIT"
            ].filter(Boolean).join(";"))
            if (workerData.replacement !== null) {
              execute.call(this, "BEGIN")
              this.prepare("UPDATE thread_messages SET content_json = ? WHERE message_id = 'canonical'")
                .run(workerData.replacement)
              execute.call(this, "DELETE FROM thread_message_fragments; DELETE FROM thread_message_fragment_states; COMMIT")
            }
            if (workerData.mode !== "while copying") throw new Error("interrupted after fragment rename")
          }
          return result
        }
        require(workerData.workerBundlePath)
      `, { eval: true, workerData: { durablePath, mode, workerBundlePath,
        replacement: mode === "after a completed copy replaces it"
          ? JSON.stringify(normalizeMessageContent(normalizeMessageContent(body))) : null
      } }))
      clients.push(client)
      const copy = client.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      if (mode === "while copying") {
        await expect(copy).resolves.toMatchObject({ stats: { totalMessages: 2 } })
      } else {
        await expect(copy).rejects.toThrow("interrupted after fragment rename")
        const resume = createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        if (mode === "with a damaged prefix") {
          await expect(resume).rejects.toMatchObject({ name: CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED })
        } else {
          await expect(resume).resolves.toMatchObject({ stats: { totalMessages: 2 } })
        }
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM thread_message_fragments WHERE message_id = 'wide'").get()?.count)
        .toBe(0)
      const fragments = db.prepare("SELECT content_text FROM thread_message_fragments ORDER BY fragment_id").all()
      const durableBody = fragments.map(({ content_text }) => content_text).join("")
      if (mode === "with a damaged prefix") {
        expect(durableBody).toMatch(/^changed/)
        expect(db.prepare("SELECT 1 FROM thread_messages WHERE message_id = 'later'").get()).toBeUndefined()
      } else {
        expect(durableBody).toBe(mode === "after a completed copy replaces it" ? "" : body)
        expect(db.prepare("SELECT 1 FROM thread_messages WHERE message_id = 'later'").get()).toBeDefined()
      }
    } finally {
      db.close()
    }
  }, 30_000)

  it.each([
    ["another fragmented body", 62, false, false, "same"],
    ["an inline body", 62, false, false, "same"],
    ["an inline body after two committed batches", 124, false, false, "same"],
    ["an inline body after an unrelated ID changes", 62, true, false, "same"],
    ["another fragmented body interrupted before publication", 124, false, true, "same"],
    ["an inline body with an implicit ID", 124, false, false, "implicit"],
    ["an inline body with a canonical source ID", 124, false, false, "canonical"],
    ["an inline body and a revised reserved suffix", 124, false, false, "implicit-suffix"],
    ["an inline body and a shorter reserved suffix", 124, false, false, "implicit-shrink"],
    ["an inline body after reappearing in a later checkpoint", 124, false, false, "implicit-omission"],
    ["an inline body after a copied prefix is compacted", 124, false, false, "implicit-shifted"]
  ] as const)("restarts a proven active copy after the provider saves %s", async (mode, stopAt, renameTail, interruptCleanup, identity) => {
    const threadId = "legacy-active-provider-replacement"
    const transcript = (content: string, canonical = false, version = 1) => [
      ...(identity === "implicit-shifted" ? [
        ...(version === 1 ? [{ id: "older", type: "human", content: "older saved prompt" }] : []),
        { id: "question", type: "human", content: "retained question" }
      ] : []),
      persistedMessageToRuntimeMessage({
        id: canonical ? "canonical" : "wide", role: "assistant", content, created_at: new Date(1),
        ...(identity.startsWith("implicit") ? {} : { provider_source_id: "original-provider", provider_occurrence: 1 })
      }),
      ...(version > 1 && identity === "implicit-shrink" ? [] : [{ id: "later", type: "human",
        content: version > 1 && identity === "implicit-suffix" ? "revised later message" : "later message" }])
    ]
    const original = "old".repeat(720_000)
    const updated = mode.startsWith("an inline body") ? "correct final short reply" : "new".repeat(720_000)
    const { databasePath, legacyCheckpoint } = await seedLegacyInlineFixture({ threadId, messages: transcript(original) })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      if (renameTail) db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, ordinal, role, content_json, created_at)
        VALUES (?, 'local-tail', 0, 'user', '"local message"', 1)`).run(threadId)
      db.exec(`CREATE TRIGGER stop_fragment BEFORE INSERT ON thread_message_fragments
        WHEN (SELECT COUNT(*) FROM thread_message_fragments) >= ${stopAt}
        BEGIN SELECT RAISE(ABORT, 'interrupted active copy'); END`)
      const client = createClient()
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted active copy")
      db.exec("DROP TRIGGER stop_fragment")
      const receipt = db.prepare(`SELECT current_fragment_index, active_fragment_revision
        FROM legacy_checkpoint_transcript_migrations`).get()
      expect(receipt?.current_fragment_index).toBeGreaterThan(0)
      expect(typeof receipt?.active_fragment_revision).toBe("string")
      if (renameTail) db.exec("UPDATE thread_messages SET message_id = 'renamed-tail' WHERE message_id = 'local-tail'")
      const save = async (version: number, body: string) => {
        const saver = new SqlJsSaver(databasePath)
        const messages = transcript(body, identity === "canonical", version)
        const [type, payload] = await saver.serde.dumpsTyped(checkpoint(legacyCheckpoint.id, version,
          identity === "implicit-omission" && version === 2 ? messages.slice(1) : messages))
        await saver.close()
        const source = new DatabaseSync(databasePath)
        try {
          source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
        } finally {
          source.close()
        }
      }
      await save(2, updated)
      if (identity === "implicit-omission") {
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .resolves.toMatchObject({ stats: { totalMessages: 1, searchProjectionState: "unverified" } })
        expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all().map((row) => row.message_id))
          .toEqual(["wide", "later"])
        await save(3, updated)
      }
      if (interruptCleanup) {
        db.exec(`CREATE TRIGGER stop_replacement BEFORE UPDATE OF content_json ON thread_messages
          WHEN old.message_id = 'wide' BEGIN SELECT RAISE(ABORT, 'interrupted before publishing replacement'); END`)
        await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
          .rejects.toThrow("interrupted before publishing replacement")
        const remaining = db.prepare(`SELECT current_fragment_index, active_fragment_revision
          FROM legacy_checkpoint_transcript_migrations`).get()
        expect(remaining?.current_fragment_index).toBe(receipt?.current_fragment_index)
        const staged = JSON.parse(String(remaining?.active_fragment_revision))[7]
        expect(staged.nextIndex).toBeGreaterThan(0)
        expect(db.prepare("SELECT COUNT(*) AS count FROM thread_message_fragments WHERE generation = ''").get()?.count)
          .toBe(receipt?.current_fragment_index)
        db.exec("DROP TRIGGER stop_replacement")
      }
      const resumingClient = interruptCleanup ? createClient() : client
      await expect(resumingClient.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .resolves.toMatchObject({ stats: { totalMessages: identity === "implicit-shifted" ? 3 : identity === "implicit-shrink" ? 1 : 2,
          searchProjectionState: ["implicit-omission", "implicit-shifted"].includes(identity) ? "unverified" : "complete" } })
      const head = db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'wide'").get()?.content_json
      const fragments = db.prepare(`SELECT content_text FROM thread_message_fragments
        WHERE message_id = 'wide' ORDER BY fragment_id`).all()
      expect(JSON.parse(String(head)) + fragments.map((item) => item.content_text).join("")).toBe(updated)
      const later = db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'later'").get()
      if (identity === "implicit-shrink") expect(later).toBeUndefined()
      else expect(later?.content_json).toBe(JSON.stringify(identity === "implicit-suffix" ? "revised later message" : "later message"))
      if (identity === "implicit-shifted") expect(db.prepare("SELECT message_id FROM thread_messages ORDER BY ordinal").all()
        .map((row) => row.message_id)).toEqual(["older", "question", "wide", "later"])
      if (identity === "canonical") {
        const laterRevision = "third reply written through the canonical ID"
        await save(3, laterRevision)
        await resumingClient.bootstrapLegacyTranscript(databasePath, durablePath, threadId)
        expect(db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'wide'").get()?.content_json)
          .toBe(JSON.stringify(laterRevision))
      }
    } finally {
      db.close()
    }
  }, 30_000)

  it("resumes a wide stream extension after committing only a compatible prefix", async () => {
    const threadId = "stopped-wide-extension"
    const prefix = "UTF-16 boundary "
    const body = prefix + "🌱" + "x".repeat(2 * 1024 * 1024) + " ending"
    const { databasePath } = await seedLegacyInlineFixture({
      threadId, messages: [{ id: "answer", type: "ai", content: body }]
    })
    const durablePath = createMessageDatabase(databasePath, threadId)
    const db = new DatabaseSync(durablePath)
    try {
      installVersionedLegacyFixtureSchema(db)
      db.prepare(`INSERT INTO thread_messages
        (thread_id, message_id, role, content_json, ordinal, created_at)
        VALUES (?, 'answer', 'assistant', ?, 0, 1)`).run(threadId, JSON.stringify(prefix + body.charAt(prefix.length)))
      const client = new CheckpointRuntimeProjectionClient(async () => new Worker(`
        const { workerData } = require("node:worker_threads")
        const { DatabaseSync } = require("node:sqlite")
        const execute = DatabaseSync.prototype.exec
        const scratch = new DatabaseSync(":memory:")
        const prototype = Object.getPrototypeOf(scratch.prepare("SELECT 1"))
        const run = prototype.run
        scratch.close()
        let appended = false
        prototype.run = function (...args) {
          if (this.sourceSQL.startsWith("INSERT INTO thread_message_fragments")) appended = true
          return run.apply(this, args)
        }
        DatabaseSync.prototype.exec = function (sql) {
          const result = execute.call(this, sql)
          if (appended && sql === "COMMIT") {
            appended = false
            throw new Error("interrupted after committing the first extension")
          }
          return result
        }
        require(workerData.workerBundlePath)
      `, { eval: true, workerData: { workerBundlePath } }))
      clients.push(client)
      const restored = () => {
        const head = db.prepare("SELECT content_json FROM thread_messages WHERE message_id = 'answer'").get()
        const fragments = db.prepare("SELECT content_text FROM thread_message_fragments ORDER BY fragment_id").all()
        const parts = fragments.map((row) => String(row.content_text)).join("")
        const content: string = JSON.parse(String(head?.content_json)) + parts
        expect(db.prepare("SELECT total_chars FROM thread_message_fragment_states WHERE message_id = 'answer'")
          .get()?.total_chars).toBe(content.length)
        return content
      }
      await expect(client.bootstrapLegacyTranscript(databasePath, durablePath, threadId))
        .rejects.toThrow("interrupted after committing the first extension")
      const partial = restored()
      expect(partial.startsWith(prefix + "🌱")).toBe(true)
      expect(partial.length).toBeGreaterThan(prefix.length + 2)
      expect(partial.length).toBeLessThan(body.length)
      expect(body.startsWith(partial)).toBe(true)
      expect(db.prepare("SELECT status FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)?.status).toBeUndefined()
      await createClient().bootstrapLegacyTranscript(databasePath, durablePath, threadId)
      expect(restored()).toBe(body)
    } finally { db.close() }
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
