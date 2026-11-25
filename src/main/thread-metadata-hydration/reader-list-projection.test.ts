import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_IM_CHANNEL_ID } from "../../shared/im-gateway-contract"
import { readThreadGroupIds, readThreadHydrationProjection, readThreadSummaryPage } from "./reader"

/**
 * UAT regression: the bounded thread-list page projects metadata to an
 * allowlist. IM session identity (imDeliveryContext / targetKind /
 * remoteState / remoteThread / remoteReadOnly) was missing from it, so remote
 * inbox and Feature-bound sessions silently degraded to plain local threads in
 * the renderer (sidebar grouping, chat banner, read-only gates).
 */
const TEMPORARY_DIRECTORIES: string[] = []

function temporaryDatabasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cmb-list-projection-"))
  TEMPORARY_DIRECTORIES.push(directory)
  return join(directory, name)
}

afterEach(() => {
  while (TEMPORARY_DIRECTORIES.length > 0) {
    rmSync(TEMPORARY_DIRECTORIES.pop()!, { recursive: true, force: true })
  }
})

function createThreadsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      status TEXT DEFAULT 'idle',
      thread_values TEXT,
      title TEXT
    )
  `)
}

function readFirstRow(database: DatabaseSync): Record<string, unknown> {
  const now = Date.now()
  database
    .prepare(
      `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
       VALUES (?, ?, ?, ?, 'idle', ?)`
    )
    .run("thread-1", now, now, JSON.stringify(imThreadMetadata), "远程收件箱")
  const page = readThreadSummaryPage(database, {
    type: "read-list-page",
    requestId: 1,
    databasePath: ":memory:",
    cancellationBuffer: new SharedArrayBuffer(new Int32Array(1).byteLength),
    limit: 10,
    byteBudget: 256 * 1024
  })
  const thread = page.threads[0]
  if (!thread) throw new Error("page returned no threads")
  return thread.metadata as Record<string, unknown>
}

const imThreadMetadata = {
  title: "远程收件箱",
  workspacePath: "/tmp/workspace",
  agentMode: "normal",
  targetKind: "inbox",
  remoteThread: true,
  remoteReadOnly: true,
  remoteState: "active",
  memoryEnabled: false,
  imDeliveryContext: {
    provider: DEFAULT_IM_CHANNEL_ID,
    principalId: "principal-1",
    conversationKey: "conv-1",
    targetId: "target-1"
  },
  harnessFeature: {
    projectId: "project-1",
    slug: "feature-1",
    source: "im"
  },
  llmFileHistory: [{ path: "/tmp/workspace/a.ts", mode: "generate" }]
}

describe("thread list metadata projection", () => {
  it("returns only the settings needed to create a side conversation from a large parent", () => {
    const database = new DatabaseSync(":memory:")
    try {
      createThreadsTable(database)
      const settings = {
        workspacePath: "/tmp/project", model: "custom:test", subagentsEnabled: false,
        memoryEnabled: true, outputStyle: "concise", conciseModeEnabled: false
      }
      const insert = database.prepare("INSERT OR REPLACE INTO threads (thread_id, created_at, updated_at, metadata) VALUES ('parent', 1, 1, ?)")
      const read = () => readThreadHydrationProjection(database, {
        type: "read-thread", threadId: "parent", sideParent: true, requestId: 1, databasePath: ":memory:",
        cancellationBuffer: new SharedArrayBuffer(4)
      }).thread
      insert.run(JSON.stringify({
        ...settings, llmFileHistory: { "big.ts": [{ content: "x".repeat(255 * 1024) }] },
        otherMetadata: "y".repeat(100_000)
      }))
      expect(read()?.metadata).toEqual(settings)
      for (const blocked of [
        { botId: "bot" }, { remoteReadOnly: true }, { remoteState: "active" },
        { targetKind: "inbox", imDeliveryContext: {} },
        { harnessFeature: { projectId: "project", slug: "feature" } },
        { harnessProjectSession: { projectId: "project", kind: "session" } }
      ]) {
        insert.run(JSON.stringify({ ...settings, ...blocked }))
        expect(read()).toBeNull()
      }
    } finally {
      database.close()
    }
  })

  it("keeps a child out of the directory and available for direct hydration", () => {
    const database = new DatabaseSync(":memory:")
    try {
      createThreadsTable(database)
      const parentId = "00000000-0000-4000-8000-000000000001"
      const childId = `btw-${parentId}-00000000-0000-4000-8000-000000000002`
      const workspacePath = "/tmp/shared-workspace"
      const insert = database.prepare("INSERT INTO threads (thread_id, created_at, updated_at, metadata) VALUES (?, ?, ?, ?)")
      insert.run(parentId, 1, 1, JSON.stringify({ workspacePath }))
      insert.run(childId, 2, 2, JSON.stringify({ workspacePath, btwParentId: parentId }))
      const request = { requestId: 1, databasePath: ":memory:", cancellationBuffer: new SharedArrayBuffer(4) }

      expect(readThreadSummaryPage(database, { ...request, type: "read-list-page", limit: 1, byteBudget: 65_536 })
        .threads.map(thread => thread.thread_id)).toEqual([parentId])
      expect(readThreadGroupIds(database, { ...request, type: "read-group-ids", selector: { type: "workspace", workspacePath } })
        .entries.map(entry => entry.threadId)).toEqual([parentId])
      expect(readThreadHydrationProjection(database, { ...request, type: "read-thread", threadId: childId })
        .thread?.metadata).toEqual({ workspacePath, btwParentId: parentId })
      insert.run("btw-notes", 3, 3, JSON.stringify({ workspacePath }))
      expect(readThreadSummaryPage(database, { ...request, type: "read-list-page", limit: 2, byteBudget: 65_536 })
        .threads.map(thread => thread.thread_id)).toEqual(["btw-notes", parentId])
    } finally {
      database.close()
    }
  })

  it("keeps IM session identity fields in the bounded list page", () => {
    const database = new DatabaseSync(temporaryDatabasePath("im-list.sqlite"))
    try {
      createThreadsTable(database)
      const metadata = readFirstRow(database)

      expect(metadata.targetKind).toBe("inbox")
      expect(metadata.remoteThread).toBe(true)
      expect(metadata.remoteReadOnly).toBe(true)
      expect(metadata.remoteState).toBe("active")
      expect(metadata.imDeliveryContext).toEqual({
        provider: DEFAULT_IM_CHANNEL_ID,
        principalId: "principal-1",
        conversationKey: "conv-1",
        targetId: "target-1"
      })
      expect((metadata.harnessFeature as Record<string, unknown>).slug).toBe("feature-1")
      // Payload hogs stay excluded from the bounded projection.
      expect(metadata.llmFileHistory).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it("keeps IM session identity when metadata is large enough to fill the budget", () => {
    const database = new DatabaseSync(temporaryDatabasePath("im-list-large.sqlite"))
    try {
      createThreadsTable(database)
      const now = Date.now()
      // Fill the per-row 16,384-char budget with large known-string keys so the
      // non-priority projection has nothing left; IM identity keys must still
      // survive because they are processed ahead of budget exhaustion.
      const largeMetadata = {
        ...imThreadMetadata,
        projectName: "p".repeat(8_192),
        workspacePath: "w".repeat(8_192)
      }
      database
        .prepare(
          `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
           VALUES (?, ?, ?, ?, 'idle', ?)`
        )
        .run("thread-1", now, now, JSON.stringify(largeMetadata), "远程收件箱")
      const page = readThreadSummaryPage(database, {
        type: "read-list-page",
        requestId: 1,
        databasePath: ":memory:",
        cancellationBuffer: new SharedArrayBuffer(new Int32Array(1).byteLength),
        limit: 10,
        byteBudget: 256 * 1024
      })
      const metadata = (page.threads[0] as unknown as { metadata?: Record<string, unknown> })
        .metadata as Record<string, unknown>

      expect(metadata.targetKind).toBe("inbox")
      expect(metadata.remoteState).toBe("active")
      expect(metadata.imDeliveryContext).toEqual({
        provider: DEFAULT_IM_CHANNEL_ID,
        principalId: "principal-1",
        conversationKey: "conv-1",
        targetId: "target-1"
      })
    } finally {
      database.close()
    }
  })
})
