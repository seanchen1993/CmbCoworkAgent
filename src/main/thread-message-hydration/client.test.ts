import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  THREAD_MESSAGE_HYDRATION_MAX_ACTIVE_REQUESTS,
  THREAD_MESSAGE_HYDRATION_WORKER_RESOURCE_LIMITS,
  ThreadMessageHydrationClient,
  ThreadMessageHydrationRequestCancelledError,
  ThreadMessageHydrationWorkerUnavailableError
} from "./client"
import { isThreadMessagePageContinuousWithBoundary } from "../../renderer/src/lib/thread-message-pages"
import {
  THREAD_CONVERSATION_PRESENCE_SCAN_BYTE_BUDGET,
  THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT
} from "./page-reader"

const temporaryDirectories: string[] = []
const clients: ThreadMessageHydrationClient[] = []
const databases: DatabaseSync[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-hydration-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "thread-message-hydration-worker.cjs")
  await build({
    entryPoints: [
      fileURLToPath(new URL("./thread-message-hydration-worker.ts", import.meta.url))
    ],
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

function createDatabase(): { database: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "cmb-hydration-worker-"))
  temporaryDirectories.push(directory)
  const path = join(directory, "threads.sqlite")
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec(`
    PRAGMA journal_mode = WAL;
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
    CREATE TABLE legacy_checkpoint_transcript_migrations (
      thread_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      current_fragment_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_goal_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      goal_id TEXT,
      active_window_id TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  return { database, path }
}

function createWorkerClient(path: string): ThreadMessageHydrationClient {
  const client = new ThreadMessageHydrationClient(
    async () =>
      new Worker(workerBundlePath, {
        name: "thread-message-hydration-test",
        resourceLimits: THREAD_MESSAGE_HYDRATION_WORKER_RESOURCE_LIMITS
      }),
    () => path
  )
  clients.push(client)
  return client
}

function insertShapeFixture(database: DatabaseSync): void {
  const insert = database.prepare(`
    INSERT INTO thread_messages (
      thread_id, message_id, provider_source_id, provider_occurrence, role,
      content_json, tool_calls_json, tool_call_id, name, status, is_error,
      content_priority, goal_id, active_window_id, created_at, start_at, end_at, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run(
    "shape",
    "m-0",
    null,
    null,
    "user",
    JSON.stringify("oldest"),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    1_700_000_000_000,
    null,
    null,
    0
  )
  insert.run(
    "shape",
    "m-1",
    "provider-1",
    2,
    "assistant",
    JSON.stringify("base-"),
    null,
    null,
    "assistant-name",
    "streaming",
    1,
    3,
    "goal-1",
    "window-1",
    1_700_000_000_100,
    1_700_000_000_050,
    1_700_000_000_150,
    1
  )
  insert.run(
    "shape",
    "m-2",
    null,
    null,
    "assistant",
    JSON.stringify([{ type: "text", text: "structured" }]),
    JSON.stringify([{ id: "call-1", name: "search", args: { query: "worker" } }]),
    "tool-link",
    null,
    "complete",
    0,
    null,
    null,
    null,
    1_700_000_000_200,
    null,
    null,
    2
  )
  database
    .prepare(
      `INSERT INTO thread_message_buckets
       (thread_id, message_count, next_ordinal, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run("shape", 3, 3, Date.now())
  const fragmentInsert = database.prepare(
    `INSERT INTO thread_message_fragments
     (thread_id, message_id, content_text, created_at) VALUES (?, ?, ?, ?)`
  )
  fragmentInsert.run("shape", "m-1", "tail-", 1)
  fragmentInsert.run("shape", "m-1", "one", 2)
  database
    .prepare(
      `INSERT INTO thread_message_fragment_states
       (thread_id, message_id, total_chars, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run("shape", "m-1", 8, Date.now())
}

function insertLargeFixture(database: DatabaseSync): void {
  const insert = database.prepare(`
    INSERT INTO thread_messages (
      thread_id, message_id, role, content_json, created_at, ordinal
    ) VALUES (?, ?, 'assistant', ?, ?, ?)
  `)
  const content = JSON.stringify({
    type: "text",
    text: "界".repeat(3_500),
    nested: Array.from({ length: 20 }, (_, index) => ({ index, value: "v".repeat(20) }))
  })
  database.exec("BEGIN")
  for (let index = 0; index < 1_000; index += 1) {
    insert.run("large", `large-${String(index).padStart(4, "0")}`, content, index, index)
  }
  database
    .prepare(
      `INSERT INTO thread_message_buckets
       (thread_id, message_count, next_ordinal, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run("large", 1_000, 1_000, Date.now())
  database.exec("COMMIT")
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const database of databases.splice(0)) {
    if (database.isOpen) database.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("thread message hydration worker", () => {
  it("runs oversized-row parsing inside a bounded worker heap", () => {
    expect(THREAD_MESSAGE_HYDRATION_WORKER_RESOURCE_LIMITS).toEqual({
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4
    })
  })

  it("reads two explicit forward pages across dense, repeated, and sparse ordinals", async () => {
    const { database, path } = createDatabase()
    const insert = database.prepare(`
      INSERT INTO thread_messages (
        thread_id, message_id, role, content_json, created_at, ordinal
      ) VALUES (?, ?, 'assistant', ?, ?, ?)
    `)
    const insertFixture = (
      threadId: string,
      rows: ReadonlyArray<{ id: string; ordinal: number }>
    ): void => {
      for (const row of rows) {
        insert.run(threadId, row.id, JSON.stringify(row.id), row.ordinal, row.ordinal)
      }
      const nextOrdinal = rows.reduce(
        (maximum, row) => Math.max(maximum, row.ordinal + 1),
        0
      )
      database
        .prepare(
          `INSERT INTO thread_message_buckets
           (thread_id, message_count, next_ordinal, updated_at) VALUES (?, ?, ?, ?)`
        )
        .run(threadId, rows.length, nextOrdinal, Date.now())
    }
    database.exec("BEGIN")
    insertFixture(
      "forward-dense",
      Array.from({ length: 1_200 }, (_, ordinal) => ({
        id: `dense-${ordinal.toString().padStart(4, "0")}`,
        ordinal
      }))
    )
    insertFixture("forward-repeated", [
      { id: "repeated-boundary", ordinal: 100 },
      ...Array.from({ length: 501 }, (_, index) => ({
        id: `repeated-top-${index.toString().padStart(4, "0")}`,
        ordinal: 599
      }))
    ])
    insertFixture(
      "target-repeated",
      Array.from({ length: 1_200 }, (_, index) => ({
        id: `target-repeated-${index.toString().padStart(4, "0")}`,
        ordinal: 777
      }))
    )
    insertFixture("forward-sparse", [
      { id: "sparse-boundary", ordinal: 100 },
      { id: "sparse-0150", ordinal: 150 },
      { id: "sparse-0300", ordinal: 300 },
      { id: "sparse-0598", ordinal: 598 },
      ...Array.from({ length: 499 }, (_, index) => {
        const ordinal = 600 + index
        return { id: `sparse-${ordinal.toString().padStart(4, "0")}`, ordinal }
      })
    ])
    insertFixture("forward-oversized", [
      { id: "oversized-anchor", ordinal: 0 },
      { id: "oversized-newer-one", ordinal: 1 },
      { id: "oversized-newer-two", ordinal: 2 }
    ])
    database
      .prepare(
        `UPDATE thread_messages
         SET content_json = ?
         WHERE thread_id = 'forward-oversized' AND message_id = 'oversized-anchor'`
      )
      .run(JSON.stringify("x".repeat(2_000_000)))
    database.exec("COMMIT")
    database.close()
    const client = createWorkerClient(path)
    const readForward = async (threadId: string, anchorMessageId: string) =>
      client.readPage(threadId, {
        anchorMessageId,
        limit: 500
      })

    const denseFirst = await readForward("forward-dense", "dense-0100")
    const denseSecond = await readForward(
      "forward-dense",
      denseFirst.messages.at(-1)?.id ?? "missing-dense-tail"
    )
    expect(denseFirst.verifiedAnchorMessageId).toBe("dense-0100")
    expect(denseFirst.messages[0]?.id).toBe("dense-0101")
    expect(denseFirst.messages.at(-1)?.id).toBe("dense-0600")
    expect(denseSecond.verifiedAnchorMessageId).toBe("dense-0600")
    expect(denseSecond.messages[0]?.id).toBe("dense-0601")
    expect(denseSecond.messages.at(-1)?.id).toBe("dense-1100")

    const repeatedFirst = await readForward("forward-repeated", "repeated-boundary")
    const repeatedAnchor = repeatedFirst.messages.at(-1)?.id ?? "missing-repeated-tail"
    const repeatedSecond = await readForward("forward-repeated", repeatedAnchor)
    expect(repeatedFirst.verifiedAnchorMessageId).toBe("repeated-boundary")
    expect(repeatedFirst.messages[0]?.id).toBe("repeated-top-0000")
    expect(repeatedSecond.verifiedAnchorMessageId).toBe(repeatedAnchor)
    expect(repeatedSecond.messages[0]?.id).toBe("repeated-top-0500")
    expect(repeatedSecond.messages.at(-1)?.id).toBe("repeated-top-0500")
    expect(
      new Set(
        [...repeatedFirst.messages, ...repeatedSecond.messages].map((message) => message.id)
      ).size
    ).toBe(501)
    expect(
      new Set([
        "repeated-boundary",
        ...repeatedFirst.messages.map((message) => message.id),
        ...repeatedSecond.messages.map((message) => message.id)
      ]).size
    ).toBe(502)

    const exactTarget = await client.readPage("target-repeated", {
      targetMessageId: "target-repeated-0500",
      limit: 500
    })
    expect(exactTarget.messages).toHaveLength(500)
    expect(exactTarget.messages[0]?.id).toBe("target-repeated-0001")
    expect(exactTarget.messages.at(-1)?.id).toBe("target-repeated-0500")
    expect(exactTarget).toMatchObject({
      beforeOrdinal: 777,
      beforeMessageId: "target-repeated-0001",
      hasMore: true
    })

    const sparseFirst = await readForward("forward-sparse", "sparse-boundary")
    const sparseAnchor = sparseFirst.messages.at(-1)?.id ?? "missing-sparse-tail"
    const sparseSecond = await readForward("forward-sparse", sparseAnchor)
    expect(sparseFirst.verifiedAnchorMessageId).toBe("sparse-boundary")
    expect(sparseFirst.messages[0]?.id).toBe("sparse-0150")
    expect(sparseFirst.messages.at(-1)?.id).toBe("sparse-1096")
    expect(sparseSecond.verifiedAnchorMessageId).toBe("sparse-1096")
    expect(sparseSecond.messages[0]?.id).toBe("sparse-1097")
    expect(sparseSecond.messages.at(-1)?.id).toBe("sparse-1098")
    expect(
      isThreadMessagePageContinuousWithBoundary(sparseSecond.messages, sparseAnchor)
    ).toBe(false)
    expect(
      new Set([
        "sparse-boundary",
        ...sparseFirst.messages.map((message) => message.id),
        ...sparseSecond.messages.map((message) => message.id)
      ]).size
    ).toBe(503)

    const oversized = await client.readPage("forward-oversized", {
      anchorMessageId: "oversized-anchor",
      limit: 2,
      byteBudget: 4_096
    })
    expect(oversized.verifiedAnchorMessageId).toBe("oversized-anchor")
    expect(oversized.messages.map((message) => message.id)).toEqual([
      "oversized-newer-one",
      "oversized-newer-two"
    ])
    const forwardEnd = await client.readPage("forward-oversized", {
      anchorMessageId: "oversized-newer-two",
      limit: 2,
      byteBudget: 4_096
    })
    expect(forwardEnd).toMatchObject({
      messages: [],
      hasMore: false,
      verifiedAnchorMessageId: "oversized-newer-two"
    })
  }, 30_000)

  it("preserves cursor, fragment, structured, date, and tool fields", async () => {
    const { database, path } = createDatabase()
    insertShapeFixture(database)
    database.close()
    const client = createWorkerClient(path)

    const latest = await client.readPage("shape", { limit: 2 })
    expect(latest.messages.map((message) => message.id)).toEqual(["m-1", "m-2"])
    expect(latest).toMatchObject({
      beforeOrdinal: 1,
      beforeMessageId: "m-1",
      hasMore: true,
      total: 3
    })
    expect(latest.messages[0]).toMatchObject({
      provider_source_id: "provider-1",
      provider_occurrence: 2,
      content: "base-tail-one",
      name: "assistant-name",
      status: "streaming",
      is_error: true,
      content_priority: 3,
      goal_id: "goal-1",
      active_window_id: "window-1"
    })
    expect(latest.messages[0].created_at).toEqual(new Date(1_700_000_000_100))
    expect(latest.messages[0].start_at).toEqual(new Date(1_700_000_000_050))
    expect(latest.messages[0].end_at).toEqual(new Date(1_700_000_000_150))
    expect(latest.messages[1].content).toEqual([{ type: "text", text: "structured" }])
    expect(latest.messages[1].tool_calls).toEqual([
      { id: "call-1", name: "search", args: { query: "worker" } }
    ])
    expect(latest.messages[1].tool_call_id).toBe("tool-link")

    const older = await client.readPage("shape", {
      beforeOrdinal: latest.beforeOrdinal ?? undefined,
      beforeMessageId: latest.beforeMessageId ?? undefined,
      limit: 2
    })
    expect(older.messages.map((message) => message.id)).toEqual(["m-0"])
    expect(older.hasMore).toBe(false)
    expect(older.beforeOrdinal).toBeNull()
    expect(older.beforeMessageId).toBeNull()
  }, 30_000)

  it("resolves visible-conversation presence only when initial hydration requests it", async () => {
    const { database, path } = createDatabase()
    database
      .prepare(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES ('presence', ?, ?, ?, ?, ?)`
      )
      .run(
        "internal-goal",
        "user",
        JSON.stringify(
          "[Starting active goal]\n<untrusted_objective>keep working</untrusted_objective>"
        ),
        1,
        0
      )
    database
      .prepare(
        `INSERT INTO thread_message_buckets (
           thread_id, message_count, next_ordinal, updated_at
         ) VALUES ('presence', 1, 1, ?)`
      )
      .run(Date.now())

    const client = createWorkerClient(path)
    const internalOnly = await client.readPage("presence", {
      limit: 1,
      includeVisibleMessagePresence: true
    })
    expect(internalOnly.total).toBe(1)
    expect(internalOnly.hasVisibleMessages).toBe(true)
    expect(internalOnly.legacyCheckpointMigrationStatus).toBeNull()

    database
      .prepare(
        `UPDATE thread_messages
         SET content_json = ?
         WHERE thread_id = 'presence' AND message_id = 'internal-goal'`
      )
      .run(
        JSON.stringify(
          "[Continuing active goal]\n<untrusted_objective>keep working</untrusted_objective>"
        )
      )
    const continuingOnly = await client.readPage("presence", {
      limit: 1,
      includeVisibleMessagePresence: true
    })
    expect(continuingOnly.hasVisibleMessages).toBe(false)

    database
      .prepare(
        `INSERT INTO thread_goal_events (thread_id, message, created_at)
         VALUES ('presence', '__cmb_goal_user_message__:/goal resume', 1)`
      )
      .run()
    const visibleGoalEvent = await client.readPage("presence", {
      limit: 1,
      includeVisibleMessagePresence: true
    })
    expect(visibleGoalEvent.hasVisibleMessages).toBe(true)
    database.prepare("DELETE FROM thread_goal_events WHERE thread_id = 'presence'").run()

    const ordinaryPage = await client.readPage("presence", { limit: 1 })
    expect(ordinaryPage.hasVisibleMessages).toBeUndefined()
    expect(ordinaryPage.legacyCheckpointMigrationStatus).toBeUndefined()

    database
      .prepare(
        `INSERT INTO legacy_checkpoint_transcript_migrations (
           thread_id, checkpoint_id, total_messages, next_index,
           current_fragment_index, status, updated_at
         ) VALUES ('presence', 'checkpoint-1', 2, 1, 0, 'migrating', ?)`
      )
      .run(Date.now())
    const interrupted = await client.readPage("presence", {
      limit: 1,
      includeVisibleMessagePresence: true
    })
    expect(interrupted.legacyCheckpointMigrationStatus).toBe("migrating")

    database
      .prepare(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES ('presence', 'real-user', 'user', ?, 2, 1)`
      )
      .run(JSON.stringify("继续修复"))
    database
      .prepare(
        `UPDATE thread_message_buckets
         SET message_count = 2, next_ordinal = 2, updated_at = ?
         WHERE thread_id = 'presence'`
      )
      .run(Date.now())
    database
      .prepare(
        `UPDATE legacy_checkpoint_transcript_migrations
         SET next_index = total_messages, status = 'complete', updated_at = ?
         WHERE thread_id = 'presence'`
      )
      .run(Date.now())

    const withConversation = await client.readPage("presence", {
      limit: 1,
      includeVisibleMessagePresence: true
    })
    expect(withConversation.hasVisibleMessages).toBe(true)
    expect(withConversation.legacyCheckpointMigrationStatus).toBe("complete")
  }, 30_000)

  it("bounds exact presence work while resolving ordinary long internal histories", async () => {
    const { database, path } = createDatabase()
    const insert = database.prepare(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, ?, 'user', ?, ?, ?)`
    )
    const internalContent = JSON.stringify(
      "[Continuing active goal]\n<untrusted_objective>keep working</untrusted_objective>"
    )
    database.exec("BEGIN")
    for (let ordinal = 0; ordinal < 512; ordinal += 1) {
      insert.run("presence-long-internal", `internal-${ordinal}`, internalContent, ordinal, ordinal)
    }
    for (let ordinal = 0; ordinal <= THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT; ordinal += 1) {
      insert.run("presence-over-budget", `internal-${ordinal}`, internalContent, ordinal, ordinal)
    }
    const aggregatePayload = "x".repeat(512 * 1024)
    const aggregateRows =
      Math.ceil(THREAD_CONVERSATION_PRESENCE_SCAN_BYTE_BUDGET / aggregatePayload.length) + 2
    const aggregateInternalContent = JSON.stringify(
      `[Continuing active goal]\n<untrusted_objective>${aggregatePayload}</untrusted_objective>`
    )
    for (let ordinal = 0; ordinal < aggregateRows; ordinal += 1) {
      insert.run(
        "presence-over-byte-budget",
        `internal-${ordinal}`,
        aggregateInternalContent,
        ordinal,
        ordinal
      )
    }
    database
      .prepare(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES ('presence-oversized-internal', 'huge', 'user', ?, 0, 0)`
      )
      .run(
        JSON.stringify(
          `[Continuing active goal]\n<untrusted_objective>${"x".repeat(2 * 1024 * 1024)}</untrusted_objective>`
        )
      )
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run("presence-long-internal", 512, 512, Date.now())
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run(
        "presence-over-budget",
        THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT + 1,
        THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT + 1,
        Date.now()
      )
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run("presence-over-byte-budget", aggregateRows, aggregateRows, Date.now())
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES (?, 1, 1, ?)`
      )
      .run("presence-oversized-internal", Date.now())
    database.exec("COMMIT")

    const client = createWorkerClient(path)
    await expect(
      client.readPage("presence-long-internal", {
        limit: 1,
        includeVisibleMessagePresence: true
      })
    ).resolves.toMatchObject({ hasVisibleMessages: false })
    await expect(
      client.readPage("presence-over-budget", {
        limit: 1,
        includeVisibleMessagePresence: true
      })
    ).resolves.toMatchObject({ hasVisibleMessages: true })
    await expect(
      client.readPage("presence-over-byte-budget", {
        limit: 1,
        includeVisibleMessagePresence: true
      })
    ).resolves.toMatchObject({ hasVisibleMessages: true })
    await expect(
      client.readPage("presence-oversized-internal", {
        limit: 1,
        includeVisibleMessagePresence: true
      })
    ).resolves.toMatchObject({ hasVisibleMessages: true })
  }, 30_000)

  it("projects one oversized structured row without breaking the IPC page budget", async () => {
    const { database, path } = createDatabase()
    const insert = database.prepare(`
      INSERT INTO thread_messages (
        thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
      ) VALUES ('oversized', ?, 'assistant', ?, ?, ?, ?)
    `)
    insert.run("older", JSON.stringify("older message"), null, 1, 0)
    insert.run(
      "huge",
      JSON.stringify(
        Array.from({ length: 80 }, (_, index) => ({
          type: "text",
          text: `${index}:`.padEnd(60_000, "界")
        }))
      ),
      JSON.stringify([
        { id: "call-huge", name: "write_file", args: { content: "x".repeat(1_000_000) } }
      ]),
      2,
      1
    )
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES ('oversized', 2, 2, ?)`
      )
      .run(Date.now())
    database.close()

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const client = createWorkerClient(path)
    const latest = await client.readPage("oversized", { limit: 128, byteBudget: 128 * 1024 })
    clearInterval(ticker)

    expect(ticks).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(latest))).toBeLessThanOrEqual(128 * 1024)
    expect(latest.messages).toHaveLength(1)
    expect(latest.messages[0]?.id).toBe("huge")
    expect(latest.messages[0]?.content).toContain("完整消息过大")
    expect(latest.messages[0]?.tool_calls?.[0]).toMatchObject({
      id: "call-huge",
      name: "write_file",
      args: { __hydration_truncated: true }
    })
    expect(latest.truncatedMessageIds).toEqual(["huge"])
    expect(latest.hasMore).toBe(true)

    const older = await client.readPage("oversized", {
      beforeOrdinal: latest.beforeOrdinal ?? undefined,
      beforeMessageId: latest.beforeMessageId ?? undefined,
      limit: 128,
      byteBudget: 128 * 1024
    })
    expect(older.messages.map((message) => message.id)).toEqual(["older"])
    expect(older.hasMore).toBe(false)
  }, 30_000)

  it("marks field-level content, tool-call, and fragment clamps as lossy", async () => {
    const { database, path } = createDatabase()
    const insert = database.prepare(`
      INSERT INTO thread_messages (
        thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal
      ) VALUES ('lossy-fields', ?, 'assistant', ?, ?, ?, ?)
    `)
    insert.run("long-text", JSON.stringify("x".repeat(120_001)), null, 1, 0)
    insert.run(
      "many-tools",
      JSON.stringify("tools"),
      JSON.stringify(
        Array.from({ length: 51 }, (_, index) => ({
          id: `call-${index}`,
          name: "noop",
          args: {}
        }))
      ),
      2,
      1
    )
    insert.run("fragment-overflow", JSON.stringify("base"), null, 3, 2)
    database
      .prepare(
        `INSERT INTO thread_message_fragments
         (thread_id, message_id, content_text, created_at)
         VALUES ('lossy-fields', 'fragment-overflow', ?, 3)`
      )
      .run("z".repeat(120_001))
    database
      .prepare(
        `INSERT INTO thread_message_fragment_states
         (thread_id, message_id, total_chars, updated_at)
         VALUES ('lossy-fields', 'fragment-overflow', 120001, 3)`
      )
      .run()
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at)
         VALUES ('lossy-fields', 3, 3, ?)`
      )
      .run(Date.now())
    database.close()

    const page = await createWorkerClient(path).readPage("lossy-fields", { limit: 10 })
    expect(page.messages).toHaveLength(3)
    expect(new Set(page.truncatedMessageIds)).toEqual(
      new Set(["long-text", "many-tools", "fragment-overflow"])
    )
  })

  it("keeps the main event-loop ticker moving while parsing a large page", async () => {
    const { database, path } = createDatabase()
    insertShapeFixture(database)
    insertLargeFixture(database)
    database.close()
    const client = createWorkerClient(path)
    await client.readPage("shape", { limit: 1 })

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const page = await client.readPage("large", { limit: 1_000 })
      expect(page.messages.length).toBeGreaterThan(100)
      expect(page.total).toBe(1_000)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  }, 30_000)

  it("cancels only the previous foreground request for the same renderer", async () => {
    const { database, path } = createDatabase()
    insertShapeFixture(database)
    insertLargeFixture(database)
    database.close()
    const client = createWorkerClient(path)
    await client.readPage("shape", { limit: 1 })

    const staleOutcome = client
      .readPage("large", { limit: 1_000, requestScope: "foreground-hydration" }, 17)
      .then(
        () => "completed" as const,
        (error: unknown) => error
      )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const latest = client.readPage(
      "shape",
      { limit: 1, requestScope: "foreground-hydration" },
      17
    )
    const independent = client.readPage("shape", { limit: 1 })

    expect(await staleOutcome).toBeInstanceOf(ThreadMessageHydrationRequestCancelledError)
    await expect(latest).resolves.toMatchObject({ total: 3 })
    await expect(independent).resolves.toMatchObject({ total: 3 })
    expect(client.getDiagnostics().cancelledRequests).toBe(1)

    const foregroundNotCancelled = client.readPage(
      "large",
      { limit: 1_000, requestScope: "foreground-hydration" },
      23
    )
    const backgroundPage = client.readPage("shape", { limit: 1 })
    await expect(foregroundNotCancelled).resolves.toMatchObject({ total: 1_000 })
    await expect(backgroundPage).resolves.toMatchObject({ total: 3 })
    expect(client.getDiagnostics().cancelledRequests).toBe(1)
  }, 30_000)

  it("rebuilds after a worker crash without a stale exit killing the replacement", async () => {
    const { database, path } = createDatabase()
    insertShapeFixture(database)
    database.close()
    let starts = 0
    const client = new ThreadMessageHydrationClient(
      async () => {
        starts += 1
        if (starts === 1) {
          return new Worker("throw new Error('intentional hydration worker crash')", {
            eval: true
          })
        }
        return new Worker(workerBundlePath, { name: "thread-message-hydration-replacement" })
      },
      () => path
    )
    clients.push(client)

    await expect(client.readPage("shape", { limit: 1 })).rejects.toBeInstanceOf(
      ThreadMessageHydrationWorkerUnavailableError
    )
    await expect(client.readPage("shape", { limit: 1 })).resolves.toMatchObject({ total: 3 })
    expect(starts).toBe(2)
    expect(client.getDiagnostics().workerRestarts).toBe(1)
  }, 30_000)

  it("treats exit(0) before a response as failure and starts a replacement", async () => {
    const { database, path } = createDatabase()
    insertShapeFixture(database)
    database.close()
    let starts = 0
    const client = new ThreadMessageHydrationClient(
      async () => {
        starts += 1
        return starts === 1
          ? new Worker("", { eval: true })
          : new Worker(workerBundlePath, { name: "thread-message-clean-exit-replacement" })
      },
      () => path
    )
    clients.push(client)

    await expect(client.readPage("shape", { limit: 1 })).rejects.toBeInstanceOf(
      ThreadMessageHydrationWorkerUnavailableError
    )
    await expect(client.readPage("shape", { limit: 1 })).resolves.toMatchObject({ total: 3 })
    expect(starts).toBe(2)
  }, 30_000)

  it("cleans a failed dispatch and hard-bounds retained requests", async () => {
    const worker = new FakeHydrationWorker()
    const client = new ThreadMessageHydrationClient(
      async () => worker as unknown as Worker,
      () => "C:\\fixture.db"
    )
    clients.push(client)
    worker.postError = new Error("dispatch failed")
    await expect(client.readPage("thread", { limit: 1 })).rejects.toBeInstanceOf(
      ThreadMessageHydrationWorkerUnavailableError
    )

    worker.postError = null
    const retained = Array.from({ length: THREAD_MESSAGE_HYDRATION_MAX_ACTIVE_REQUESTS }, () =>
      client.readPage("thread", { limit: 1 }).catch((error) => error)
    )
    await Promise.resolve()
    await expect(client.readPage("overflow", { limit: 1 })).rejects.toThrow("capacity exceeded")
    await client.close()
    await Promise.all(retained)
  })
})

class FakeHydrationWorker extends EventEmitter {
  postError: Error | null = null

  postMessage(): void {
    if (this.postError) throw this.postError
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}
import { EventEmitter } from "node:events"
