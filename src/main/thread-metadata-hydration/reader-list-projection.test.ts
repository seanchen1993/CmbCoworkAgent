import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_IM_CHANNEL_ID } from "../../shared/im-gateway-contract"
import { readThreadSummaryPage } from "./reader"

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
