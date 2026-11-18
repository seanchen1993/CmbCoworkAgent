import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { afterEach, expect, it, vi } from "vitest"
import { isDevelopmentThreadMetadata } from "../../shared/mods/development-scope"
import { THREAD_RUNTIME_SCOPE_EXPRESSION } from "../db/thread-runtime-scope-query"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"

const source = ts.createSourceFile(
  "mods.ts",
  readFileSync(new URL("./mods.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
let contextSource = ""
function visit(node: ts.Node): void {
  if (ts.isNewExpression(node) && node.expression.getText(source) === "ModDevelopmentService") {
    const options = node.arguments?.[0]
    if (options && ts.isObjectLiteralExpression(options)) {
      const context = options.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === "context"
      )
      if (context && ts.isPropertyAssignment(context))
        contextSource = context.initializer.getText(source)
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)
if (!contextSource) throw Error("Production creator context missing")

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture(extra: Record<string, unknown> = {}) {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  database.exec(
    "CREATE TABLE threads(thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)"
  )
  const metadata = {
    workspacePath: "workspace",
    agentMode: "normal",
    cmb_thread_incarnation: "first",
    tenantId: "fixture-tenant",
    llmFileHistory: { text: "x".repeat(512 * 1024) },
    ...extra
  }
  const write = (value: unknown, createdAt = 1) =>
    database
      .prepare("INSERT OR REPLACE INTO threads VALUES ('thread', ?, ?)")
      .run(createdAt, JSON.stringify(value))
  write(metadata)
  const getThreadRuntimeScope = vi.fn(
    (threadId: string) =>
      database
        .prepare(
          `SELECT created_at, ${THREAD_RUNTIME_SCOPE_EXPRESSION} AS metadata FROM threads WHERE thread_id=?`
        )
        .get(threadId) ?? null
  )
  const getThreadCore = vi.fn(() => {
    throw Error("Full metadata must not be read")
  })
  const writableThreadScope = vi.fn((threadId: string) => {
    const row = getThreadRuntimeScope(threadId)
    if (!row) throw Error("MODS_THREAD_MISSING")
    const data = JSON.parse(String(row.metadata))
    if (typeof data.workspacePath !== "string") throw Error("MODS_WORKSPACE_REQUIRED")
    if (
      data.remoteState === "historical" ||
      (data.targetKind === "inbox" && data.remoteReadOnly === true)
    )
      throw Error("MODS_THREAD_READ_ONLY")
    return data.workspacePath
  })
  const context = runInNewContext(
    ts.transpileModule(`(${contextSource})`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      writableThreadScope,
      getThreadCore,
      getThreadRuntimeScope,
      captureThreadIncarnation,
      matchesThreadIncarnation,
      isDevelopmentThreadMetadata
    }
  ) as (threadId: string) => { scope: { workspace: string }; assertCurrent(): void }
  return { database, metadata, write, context, getThreadCore, getThreadRuntimeScope }
}

it("keeps creator identity checks on fresh compact rows without reading file history", () => {
  const f = fixture()
  const context = f.context("thread")
  expect(context.scope.workspace).toBe("workspace")
  for (let index = 0; index < 30; index++) context.assertCurrent()
  expect(f.getThreadCore).not.toHaveBeenCalled()
  expect(f.getThreadRuntimeScope.mock.calls.length).toBeGreaterThan(30)
  expect(JSON.parse(String(f.getThreadRuntimeScope("thread")?.metadata))).toEqual({
    workspacePath: "workspace",
    agentMode: "normal",
    cmb_thread_incarnation: "first",
    tenantId: "fixture-tenant"
  })
  f.write({ ...f.metadata, llmFileHistory: { text: "different file history" } })
  expect(() => context.assertCurrent()).not.toThrow()
})

it.each([
  { harnessFeature: { projectId: "project", slug: "feature" }, harnessProjectId: "project" },
  { harnessProjectSession: { projectId: "project", kind: "discussion" } },
  { hostProjectRuntime: { projectId: "project" } },
  { parentThreadId: "parent" },
  { workflowRunId: "run" },
  { pluginId: "plugin" },
  { agentMode: "coordinator" }
])("continues rejecting non-ordinary creator identity %j", (extra) => {
  const f = fixture(extra)
  expect(() => f.context("thread")).toThrow("DEVELOPMENT_ORDINARY_LOCAL_THREAD_REQUIRED")
  expect(f.getThreadCore).not.toHaveBeenCalled()
})

it.each([
  { cmb_thread_incarnation: "replacement" },
  { workspacePath: "other-workspace" },
  { harnessProjectSession: { projectId: "project", kind: "discussion" } },
  { remoteState: "historical" },
  { targetKind: "inbox", remoteReadOnly: true }
])("revokes captured creator context after current metadata changes %j", (patch) => {
  const f = fixture()
  const context = f.context("thread")
  f.write({ ...f.metadata, ...patch })
  expect(() => context.assertCurrent()).toThrow()
  expect(f.getThreadCore).not.toHaveBeenCalled()
})

it("rejects deletion, malformed current metadata and legacy thread recreation", () => {
  const f = fixture({ cmb_thread_incarnation: undefined })
  const context = f.context("thread")
  f.database.prepare("UPDATE threads SET metadata='{malformed' WHERE thread_id='thread'").run()
  expect(() => context.assertCurrent()).toThrow()
  f.database.prepare("DELETE FROM threads WHERE thread_id='thread'").run()
  expect(() => context.assertCurrent()).toThrow()
  f.write(f.metadata, 2)
  expect(() => context.assertCurrent()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
})
