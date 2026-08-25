import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ThreadMetadataHydrationClient } from "./client"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../../shared/goal-events"
import type { Thread } from "../types"

let buildDirectory = ""
let workerPath = ""
const temporaryDirectories: string[] = []
const clients: ThreadMetadataHydrationClient[] = []

beforeAll(async () => {
  buildDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-metadata-worker-build-"))
  workerPath = join(buildDirectory, "thread-metadata-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./thread-metadata-hydration-worker.ts", import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(buildDirectory, { recursive: true, force: true })
})

function fixture(): { database: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "cmb-thread-metadata-worker-"))
  temporaryDirectories.push(directory)
  const path = join(directory, "threads.sqlite")
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      status TEXT NOT NULL,
      thread_values TEXT,
      title TEXT
    );
    CREATE TABLE thread_goal_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      goal_id TEXT,
      active_window_id TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_thread_goal_events_thread_order
      ON thread_goal_events(thread_id, created_at, event_id);
  `)
  return { database, path }
}

function clientFor(path: string): ThreadMetadataHydrationClient {
  const client = new ThreadMetadataHydrationClient(
    async () => new Worker(workerPath, { name: "thread-metadata-test" }),
    () => path
  )
  clients.push(client)
  return client
}

describe("ThreadMetadataHydrationClient", () => {
  it("parses a large thread list without blocking the caller event loop", async () => {
    const { database, path } = fixture()
    const insert = database.prepare(
      `INSERT INTO threads
       (thread_id, created_at, updated_at, metadata, status, thread_values, title)
       VALUES (?, ?, ?, ?, 'idle', '{}', ?)`
    )
    const padding = "x".repeat(8_192)
    database.exec("BEGIN")
    for (let index = 0; index < 1_000; index += 1) {
      insert.run(
        `thread-${index}`,
        index,
        index,
        JSON.stringify({ workspacePath: `C:/workspace/${index}`, padding }),
        `Thread ${index}`
      )
    }
    database.exec("COMMIT")
    database.close()

    let ticks = 0
    let maxTickGapMs = 0
    let lastTickAt = performance.now()
    const timer = setInterval(() => {
      ticks += 1
      const now = performance.now()
      maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt)
      lastTickAt = now
    }, 1)
    const client = clientFor(path)
    const threads: Thread[] = []
    let beforeUpdatedAt: number | undefined
    let beforeThreadId: string | undefined
    let maxPageBytes = 0
    let maxPageRows = 0
    while (true) {
      const page = await client.readListPage(
        {
          ...(beforeUpdatedAt === undefined ? {} : { beforeUpdatedAt }),
          ...(beforeThreadId === undefined ? {} : { beforeThreadId }),
          limit: 128,
          byteBudget: 512 * 1024
        },
        1
      )
      threads.push(...page.threads)
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)))
      maxPageRows = Math.max(maxPageRows, page.threads.length)
      if (!page.hasMore || page.beforeUpdatedAt === null || page.beforeThreadId === null) break
      beforeUpdatedAt = page.beforeUpdatedAt
      beforeThreadId = page.beforeThreadId
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    clearInterval(timer)

    expect(threads).toHaveLength(1_000)
    expect(threads[0]?.thread_id).toBe("thread-999")
    expect(String(threads[0]?.metadata?.padding)).toHaveLength(512)
    expect(maxPageRows).toBeLessThanOrEqual(128)
    expect(maxPageBytes).toBeLessThanOrEqual(512 * 1024 + 1024)
    expect(ticks).toBeGreaterThan(1)
    expect(maxTickGapMs).toBeLessThan(25)
  })

  it("removes legacy lifetime payloads before returning a selected thread", async () => {
    const { database, path } = fixture()
    database
      .prepare(
        `INSERT INTO threads
         (thread_id, created_at, updated_at, metadata, status, thread_values, title)
         VALUES (?, 1, 2, ?, 'idle', ?, 'Selected')`
      )
      .run(
        "selected",
        JSON.stringify({
          workspacePath: "C:/selected",
          llmFileHistory: { "large.ts": [{ content: "x".repeat(2_000_000) }] },
          llmModifiedFiles: Array.from({ length: 20_000 }, (_, index) => `file-${index}`)
        }),
        JSON.stringify({
          keep: { compact: true },
          subagentTranscripts: { huge: "x".repeat(2_000_000) },
          messageTimes: { huge: "x".repeat(100_000) }
        })
      )
    database.close()

    const client = clientFor(path)
    const first = client.readThread("selected")
    const duplicate = client.readThread("selected")
    const workspacePath = client.readWorkspacePath("selected")
    expect(duplicate).toBe(first)
    const selected = await first

    expect(selected?.thread_values).toEqual({})
    expect(selected?.metadata).toEqual({ workspacePath: "C:/selected" })
    await expect(workspacePath).resolves.toBe("C:/selected")
  })

  it("projects a large Git context off-thread with a bounded response", async () => {
    const { database, path } = fixture()
    database
      .prepare(
        `INSERT INTO threads
         (thread_id, created_at, updated_at, metadata, status, thread_values, title)
         VALUES ('git-heavy', 1, 2, ?, 'idle', '{}', 'Git heavy')`
      )
      .run(
        JSON.stringify({
          workspacePath: "C:/git-heavy",
          isWorktree: true,
          worktreeBranch: "codex/perf",
          worktreeBaseCommit: "abc123",
          gitContext: {
            workspacePath: "C:/git-heavy",
            checkedAt: new Date().toISOString(),
            isGitRepo: true,
            isWorktreePath: true,
            gitRoot: "C:/git-heavy"
          },
          llmModifiedFiles: Array.from({ length: 20_000 }, (_, index) => `src/file-${index}.ts`),
          llmFileHistory: {
            "src/huge.ts": [{ exists: true, content: "x".repeat(12_000_000) }]
          }
        })
      )
    database.close()

    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    const projection = await clientFor(path).readGitContext("git-heavy", 17, "git-panel")
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    clearInterval(timer)

    expect(ticks).toBeGreaterThan(1)
    expect(projection.trackedFilesTruncated).toBe(true)
    expect(projection.metadata.workspacePath).toBe("C:/git-heavy")
    expect(projection.metadata.gitContext).toMatchObject({ isGitRepo: true })
    expect(projection.metadata.llmModifiedFiles).toHaveLength(512)
    expect(projection.metadata).not.toHaveProperty("llmFileHistory")
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(300 * 1024)
  })

  it("cancels an older selected-task metadata read without cancelling background reads", async () => {
    const { database, path } = fixture()
    const insert = database.prepare(
      `INSERT INTO threads
       (thread_id, created_at, updated_at, metadata, status, thread_values, title)
       VALUES (?, 1, 2, ?, 'idle', '{}', ?)`
    )
    insert.run("foreground-a", JSON.stringify({ workspacePath: "C:/a" }), "A")
    insert.run("foreground-b", JSON.stringify({ workspacePath: "C:/b" }), "B")
    insert.run("background", JSON.stringify({ workspacePath: "C:/background" }), "Background")
    database.close()

    const client = clientFor(path)
    const first = client.readThread("foreground-a", 7)
    const background = client.readThread("background")
    const second = client.readThread("foreground-b", 7)

    await expect(first).rejects.toMatchObject({
      name: "THREAD_METADATA_HYDRATION_CANCELLED"
    })
    await expect(second).resolves.toMatchObject({ thread_id: "foreground-b" })
    await expect(background).resolves.toMatchObject({ thread_id: "background" })
  })

  it("hydrates large goal-event history off-thread with a hard response budget", async () => {
    const { database, path } = fixture()
    const insert = database.prepare(
      `INSERT INTO thread_goal_events
       (thread_id, goal_id, active_window_id, message, created_at)
       VALUES ('goal-thread', 'goal-1', 'window-1', ?, ?)`
    )
    const payload = "界".repeat(80_000)
    database.exec("BEGIN")
    for (let index = 0; index < 60; index += 1) {
      insert.run(
        index < 10 ? `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal continue ${payload}` : payload,
        index
      )
    }
    database.exec("COMMIT")
    database.close()

    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    const result = await clientFor(path).readGoalEvents("goal-thread", {
      restore: true,
      recentLimit: 20,
      scanLimit: 60,
      byteBudget: 512 * 1024
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    clearInterval(timer)

    expect(ticks).toBeGreaterThan(1)
    expect(result.truncated).toBe(true)
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.events.map((event) => event.created_at)).toEqual(
      [...result.events.map((event) => event.created_at)].sort((left, right) => left - right)
    )
    expect(
      result.events.reduce((bytes, event) => bytes + Buffer.byteLength(event.message) + 160, 0)
    ).toBeLessThanOrEqual(512 * 1024)
    expect(
      Math.max(...result.events.map((event) => Buffer.byteLength(event.message)))
    ).toBeLessThanOrEqual(128 * 1024)
  })
})
