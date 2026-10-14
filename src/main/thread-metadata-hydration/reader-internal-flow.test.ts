import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ThreadGroupSelector } from "../types"
import { readThreadGroupIds, readThreadHydrationProjection, readThreadSummaryPage } from "./reader"

let database: DatabaseSync
const cancellation = () => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)

beforeEach(() => {
  database = new DatabaseSync(":memory:")
  database.exec(`CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    metadata TEXT, status TEXT, title TEXT, thread_values TEXT
  )`)
})
afterEach(() => database.close())

function insert(id: string, updated: number, metadata: unknown) {
  database
    .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 'idle', ?, '{}')")
    .run(
      id,
      updated,
      updated,
      typeof metadata === "string" ? metadata : JSON.stringify(metadata),
      id
    )
}
function page(limit = 128, beforeUpdatedAt?: number, beforeThreadId?: string) {
  return readThreadSummaryPage(database, {
    type: "read-list-page",
    requestId: 1,
    databasePath: ":memory:",
    cancellationBuffer: cancellation(),
    limit,
    byteBudget: 512 * 1024,
    ...(beforeUpdatedAt === undefined ? {} : { beforeUpdatedAt, beforeThreadId })
  })
}
function group(selector: ThreadGroupSelector) {
  return readThreadGroupIds(database, {
    type: "read-group-ids",
    requestId: 2,
    databasePath: ":memory:",
    cancellationBuffer: cancellation(),
    selector
  }).entries.map((row) => row.threadId)
}

describe("internal DIY runtime directory boundary", () => {
  it("filters before pagination so internal rows cannot consume a page or strand a cursor", () => {
    for (let index = 0; index < 150; index++)
      insert(`internal-${index}`, 1000 + index, {
        isInternalFlowRuntime: true,
        parentThreadId: "parent",
        workspacePath: "project"
      })
    insert("first", 9, { workspacePath: "project" })
    insert("middle-internal", 8, { isInternalFlowRuntime: true })
    insert("second", 7, { agentMode: "workflow" })
    insert("last", 6, { workflowRunId: "legacy", parentThreadId: "parent" })
    const first = page(1)
    expect(first.threads.map((row) => row.thread_id)).toEqual(["first"])
    expect(first.hasMore).toBe(true)
    const second = page(1, first.beforeUpdatedAt!, first.beforeThreadId!)
    expect(second.threads.map((row) => row.thread_id)).toEqual(["second"])
    const last = page(1, second.beforeUpdatedAt!, second.beforeThreadId!)
    expect(last.threads.map((row) => row.thread_id)).toEqual(["last"])
    expect(last).toMatchObject({ hasMore: false, beforeUpdatedAt: null, beforeThreadId: null })
  })

  it("hides exactly boolean true and preserves legacy/malformed metadata semantics", () => {
    insert("hidden", 1, { isInternalFlowRuntime: true })
    insert("false", 2, { isInternalFlowRuntime: false })
    insert("text", 3, { isInternalFlowRuntime: "true" })
    insert("number", 4, { isInternalFlowRuntime: 1 })
    insert("absent", 5, { parentThreadId: "parent", workflowRunId: "legacy" })
    insert("malformed", 6, "{bad-json")
    insert("null", 7, null)
    expect(page().threads.map((row) => row.thread_id)).toEqual([
      "null",
      "malformed",
      "absent",
      "number",
      "text",
      "false"
    ])
    expect(group({ type: "workspace", workspacePath: null })).toEqual([
      "absent",
      "false",
      "malformed",
      "null",
      "number",
      "text"
    ])
  })

  it("does not expose internal runtime ids to destructive workspace or Harness group selections", () => {
    for (const internal of [false, true]) {
      const prefix = internal ? "internal" : "public"
      insert(`${prefix}-workspace`, 1, {
        workspacePath: "project",
        isInternalFlowRuntime: internal
      })
      insert(`${prefix}-feature`, 2, {
        harnessFeature: { projectId: "p", slug: "feature" },
        isInternalFlowRuntime: internal
      })
      insert(`${prefix}-project`, 3, {
        harnessProjectSession: { projectId: "p", kind: "chat" },
        isInternalFlowRuntime: internal
      })
    }
    expect(group({ type: "workspace", workspacePath: "project" })).toEqual(["public-workspace"])
    expect(group({ type: "harness-feature", projectId: "p", slug: "feature" })).toEqual([
      "public-feature"
    ])
    expect(group({ type: "harness-project", projectId: "p" })).toEqual([
      "public-feature",
      "public-project"
    ])
  })

  it("keeps explicit internal identity lookup available without putting it in the directory", () => {
    insert("child", 1, {
      isInternalFlowRuntime: true,
      parentThreadId: "parent",
      workspacePath: "project"
    })
    expect(page()).toMatchObject({
      threads: [],
      hasMore: false,
      beforeUpdatedAt: null,
      beforeThreadId: null
    })
    const result = readThreadHydrationProjection(database, {
      type: "read-thread",
      requestId: 3,
      databasePath: ":memory:",
      cancellationBuffer: cancellation(),
      threadId: "child"
    })
    expect(result.thread?.metadata).toMatchObject({
      isInternalFlowRuntime: true,
      parentThreadId: "parent"
    })
  })
})
