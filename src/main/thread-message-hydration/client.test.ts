import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ThreadMessageHydrationClient,
  ThreadMessageHydrationRequestCancelledError,
  ThreadMessageHydrationWorkerUnavailableError
} from "./client"

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
  `)
  return { database, path }
}

function createWorkerClient(path: string): ThreadMessageHydrationClient {
  const client = new ThreadMessageHydrationClient(
    async () =>
      new Worker(workerBundlePath, {
        name: "thread-message-hydration-test"
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
})
