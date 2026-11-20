import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ThreadGroupSelector } from "../types"
import { readThreadGroupIds } from "./reader"

let database: DatabaseSync

beforeEach(() => {
  database = new DatabaseSync(":memory:")
  database.exec(`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      status TEXT NOT NULL,
      thread_values TEXT,
      title TEXT
    )
  `)
})

afterEach(() => database.close())

function insertThread(threadId: string, updatedAt: number, metadata: string | null): void {
  database
    .prepare(
      `INSERT INTO threads
       (thread_id, created_at, updated_at, metadata, status, thread_values, title)
       VALUES (?, ?, ?, ?, 'idle', '{}', ?)`
    )
    .run(threadId, updatedAt, updatedAt, metadata, threadId)
}

function readAllIds(selector: ThreadGroupSelector): string[] {
  return readThreadGroupIds(database, {
    type: "read-group-ids",
    requestId: 1,
    databasePath: ":memory:",
    cancellationBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    selector
  }).entries.map((entry) => entry.threadId)
}

describe("readThreadGroupIdsPage", () => {
  it("selects more than the renderer's first 128 workspace summaries", () => {
    for (let index = 0; index < 300; index += 1) {
      insertThread(
        `workspace-${index.toString().padStart(3, "0")}`,
        index,
        JSON.stringify({ workspacePath: "C:/repo" })
      )
    }
    insertThread("other", 500, JSON.stringify({ workspacePath: "C:/other" }))

    expect(readAllIds({ type: "workspace", workspacePath: "C:/repo" })).toHaveLength(300)
  })

  it("keeps chat, harness project, and harness feature selectors isolated", () => {
    insertThread("chat", 1, JSON.stringify({ workspacePath: "C:/repo" }))
    insertThread(
      "feature-a",
      2,
      JSON.stringify({ harnessFeature: { projectId: "project", slug: "alpha" } })
    )
    insertThread(
      "feature-b",
      3,
      JSON.stringify({ harnessFeature: { projectId: "project", slug: "beta" } })
    )
    insertThread(
      "project-session",
      4,
      JSON.stringify({ harnessProjectSession: { projectId: "project", kind: "chat" } })
    )

    expect(readAllIds({ type: "workspace", workspacePath: "C:/repo" })).toEqual(["chat"])
    expect(readAllIds({ type: "harness-feature", projectId: "project", slug: "alpha" })).toEqual([
      "feature-a"
    ])
    expect(readAllIds({ type: "harness-project", projectId: "project" })).toEqual([
      "feature-a",
      "feature-b",
      "project-session"
    ])
  })

  it("gives valid project-session metadata precedence over compatibility feature metadata", () => {
    insertThread(
      "dual-labelled",
      1,
      JSON.stringify({
        harnessProjectSession: { projectId: "project-a", kind: "chat" },
        harnessFeature: { projectId: "project-b", slug: "feature-b" }
      })
    )

    expect(
      readAllIds({ type: "harness-feature", projectId: "project-b", slug: "feature-b" })
    ).toEqual([])
    expect(readAllIds({ type: "harness-project", projectId: "project-b" })).toEqual([])
    expect(readAllIds({ type: "harness-project", projectId: "project-a" })).toEqual([
      "dual-labelled"
    ])
  })

  it("returns only ids and stable incarnation snapshots", () => {
    insertThread(
      "current",
      123,
      JSON.stringify({
        workspacePath: "C:/repo",
        cmb_thread_incarnation: "incarnation-token",
        largePrivateValue: "must-not-cross-worker-boundary"
      })
    )
    insertThread("legacy", 456, JSON.stringify({ workspacePath: "C:/repo" }))

    const result = readThreadGroupIds(database, {
      type: "read-group-ids",
      requestId: 1,
      databasePath: ":memory:",
      cancellationBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      selector: { type: "workspace", workspacePath: "C:/repo" }
    })

    expect(result.entries).toEqual([
      {
        threadId: "current",
        incarnation: { token: "incarnation-token", legacyCreatedAt: 123 }
      },
      { threadId: "legacy", incarnation: { token: null, legacyCreatedAt: 456 } }
    ])
    expect(JSON.stringify(result.entries)).not.toContain("largePrivateValue")
  })

  it("handles missing, blank, and malformed metadata without widening other groups", () => {
    insertThread("missing", 1, null)
    insertThread("blank", 2, JSON.stringify({ workspacePath: "  " }))
    insertThread("malformed", 3, "{not-json")
    insertThread("named", 4, JSON.stringify({ workspacePath: "C:/repo" }))

    expect(readAllIds({ type: "workspace", workspacePath: null })).toEqual([
      "blank",
      "malformed",
      "missing"
    ])
    expect(readAllIds({ type: "workspace", workspacePath: "C:/repo" })).toEqual(["named"])
  })
})
