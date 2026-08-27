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
  CheckpointRuntimeProjectionWorkerUnavailableError
} from "./runtime-projection-client"
import {
  commitPreparedRuntimeProjection,
  prepareLatestRuntimeProjectionMigration
} from "./runtime-projection-store"
import { SqlJsSaver } from "./sqljs-saver"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"
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
