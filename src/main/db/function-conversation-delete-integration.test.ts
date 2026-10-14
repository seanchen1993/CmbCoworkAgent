import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { functionConversationProjectionIncarnation } from "./function-conversation-projection-receipt"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-conversation-delete-integration-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  if (appDb.getDb().inTransaction) appDb.getDb().run("ROLLBACK")
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const database = appDb.getDb(), threadId = randomUUID()
  const original = appDb.createThread(threadId, { workspacePath: directory })
  const incarnation = captureThreadIncarnation(original)
  const store = new FunctionConversationStore(database)
  const parent = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, () => undefined)
  return { database, threadId, incarnation, store, parent }
}

function keep(f: ReturnType<typeof fixture>, target = f.parent, physicalThreadId = f.threadId) {
  const actual = appDb.getThreadCore(physicalThreadId)
  if (!actual) throw Error("ACTUAL_PROJECTION_MISSING")
  const incarnation = captureThreadIncarnation(actual), uuid = randomUUID()
  const native = new HumanMessage({ id: uuid, content: "complete actual canonical note",
    additional_kwargs: { isMeta: true } })
  const content = native.content
  if (typeof content !== "string") throw Error("ACTUAL_TEXT_REQUIRED")
  const guard = () => {
    if (appDb.getDb() !== f.database ||
      !matchesThreadIncarnation(appDb.getThreadCore(physicalThreadId), incarnation))
      throw Error("ACTUAL_PROJECTION_CHANGED")
    f.store.assertCurrent(target)
  }
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({
    id: row.uuid, role: "user", content,
    created_at: new Date(row.createdAt), content_mode: "snapshot"
  }), target.kind === "child" ? { conversation: target, threadId: physicalThreadId,
    incarnation, assertCurrent: guard } : undefined)
  const row = f.store.commit(target, { uuid, inputDigest: uuid, door: "note",
    origin: { kind: "plugin", name: "actual-delete-integration" },
    message: { type: "user", role: "user", isMeta: true,
      content: [{ type: "text", text: "complete actual canonical note" }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "actual-sdk-note" }, sdk: true, inbox: true },
  guard, access.write, access.verify)
  return { row, physicalThreadId, incarnation }
}

function child(f: ReturnType<typeof fixture>) {
  const threadId = randomUUID(), runId = randomUUID()
  const target = f.store.createChild(f.parent, { invocationId: runId,
    checkpointNamespace: `actual-child:${runId}` }, () => undefined)
  const actual = appDb.createThread(threadId, { isInternalFlowRuntime: true,
    parentThreadId: f.threadId, modsAgentRunId: runId, workspacePath: directory })
  return { target, threadId, incarnation: captureThreadIncarnation(actual) }
}

function count(table: string, column: string, value: string) {
  return appDb.getDb().exec(`SELECT COUNT(*) FROM ${table} WHERE ${column}=?`, [value])[0].values[0][0]
}
function raw(threadId: string, uuid: string) {
  return appDb.getDb().exec("SELECT * FROM thread_messages WHERE thread_id=? AND message_id=?",
    [threadId, uuid])[0].values
}

// Only persisted data retirement is in scope here. Native Saver close, backend retirement and
// actual fork imports are tested in their host suites; this existing journal is a deletion fixture.
function targetJournal(f: ReturnType<typeof fixture>, sourceThreadId: string) {
  const planId = randomUUID()
  f.database.run(`INSERT INTO function_conversation_fork_imports
    (plan_id,target_thread_id,target_incarnation,target_json,source_digest,source_json,
      branch_map_json,selected_source_index,status) VALUES (?,?,?,?,?,?,?,?, 'preparing')`,
  [planId, f.threadId, functionConversationProjectionIncarnation(f.incarnation),
    JSON.stringify({ threadId: f.threadId, workspace: directory,
      incarnation: f.incarnation, checkpointNamespace: "" }), "actual-source-digest",
    JSON.stringify({ sourceThreadId }), "{}", 0])
  f.database.run("INSERT INTO function_conversation_fork_rows VALUES (?,?,?,?)",
    [planId, 1, randomUUID(), "actual-row-digest"])
  f.database.run("INSERT INTO function_conversation_fork_checkpoints VALUES (?,?,?,?)",
    [planId, 0, randomUUID(), "actual-snapshot-digest"])
  return planId
}

describe("actual AppDB thread deletion joins canonical data retirement", () => {
  it("keeps ordinary deletion and missing-row deletion free of conversation schema writes", () => {
    const thread = appDb.createThread(randomUUID()), uuid = randomUUID()
    appDb.upsertThreadMessages(thread.thread_id,
      [{ id: uuid, role: "user", content: "old ordinary message", created_at: new Date() }])
    expect(appDb.getDb().exec("SELECT name FROM sqlite_master WHERE name LIKE 'function_%'")[0]
      .values).toEqual([])
    appDb.deleteThread(thread.thread_id)
    expect(appDb.getThreadCore(thread.thread_id)).toBeNull()
    expect(raw(thread.thread_id, uuid)).toEqual([])
    appDb.deleteThread(thread.thread_id)
    expect(appDb.getDb().exec("SELECT name FROM sqlite_master WHERE name LIKE 'function_%'")[0]
      .values).toEqual([])
  })

  it("deletes the actual main family while preserving another main family and its raw rows", () => {
    const f = fixture(), unrelated = fixture(), main = keep(f), foreign = keep(unrelated)
    const a = child(f), b = child(f)
    const first = keep(f, a.target, a.threadId), second = keep(f, b.target, b.threadId)
    appDb.deleteThread(f.threadId)
    expect(appDb.getThreadCore(f.threadId)).toBeNull()
    expect(count("function_logical_sessions", "logical_session_id", f.parent.logicalSessionId)).toBe(0)
    for (const target of [f.parent, a.target, b.target]) {
      for (const table of ["function_conversations", "function_conversation_rows",
        "function_conversation_branches", "function_conversation_inbox"])
        expect(count(table, "conversation_id", target.conversationId)).toBe(0)
    }
    for (const note of [main, first, second]) {
      expect(count("function_conversation_projection_receipts", "uuid", note.row.uuid)).toBe(0)
      expect(raw(note.physicalThreadId, note.row.uuid)).toEqual([])
    }
    // The original parent delete does not pretend to delete or retire its separate child threads.
    for (const threadId of [a.threadId, b.threadId]) {
      expect(appDb.getThreadCore(threadId)).not.toBeNull()
      expect(appDb.getDb().exec("SELECT message_count FROM thread_message_buckets WHERE thread_id=?",
        [threadId])[0].values).toEqual([[0]])
    }
    expect(appDb.getThreadCore(unrelated.threadId)).not.toBeNull()
    expect(count("function_conversation_rows", "uuid", foreign.row.uuid)).toBe(1)
    expect(raw(unrelated.threadId, foreign.row.uuid)).toHaveLength(1)
  })

  it("deletes only one physical child invocation and keeps the parent and sibling canonical data", () => {
    const f = fixture(), parent = keep(f), a = child(f), b = child(f)
    const own = keep(f, a.target, a.threadId), sibling = keep(f, b.target, b.threadId)
    appDb.deleteThread(a.threadId)
    expect(appDb.getThreadCore(a.threadId)).toBeNull()
    expect(count("function_conversations", "conversation_id", a.target.conversationId)).toBe(0)
    expect(count("function_conversation_rows", "uuid", own.row.uuid)).toBe(0)
    expect(count("function_conversation_projection_receipts", "uuid", own.row.uuid)).toBe(0)
    expect(count("function_conversation_rows", "uuid", parent.row.uuid)).toBe(1)
    expect(count("function_conversation_rows", "uuid", sibling.row.uuid)).toBe(1)
    expect(raw(f.threadId, parent.row.uuid)).toHaveLength(1)
    expect(raw(b.threadId, sibling.row.uuid)).toHaveLength(1)
    expect(appDb.getThreadCore(b.threadId)).not.toBeNull()
  })

  it("leaves an independent fork target alive when its source family is deleted", () => {
    const source = fixture(), target = fixture(), original = keep(source), copied = keep(target)
    const planId = targetJournal(target, source.threadId)
    appDb.deleteThread(source.threadId)
    expect(count("function_conversation_rows", "uuid", original.row.uuid)).toBe(0)
    expect(appDb.getThreadCore(target.threadId)).not.toBeNull()
    expect(count("function_conversation_rows", "uuid", copied.row.uuid)).toBe(1)
    expect(raw(target.threadId, copied.row.uuid)).toHaveLength(1)
    expect(count("function_conversation_fork_imports", "plan_id", planId)).toBe(1)
    expect(count("function_conversation_fork_rows", "plan_id", planId)).toBe(1)
    expect(count("function_conversation_fork_checkpoints", "plan_id", planId)).toBe(1)
  })

  it("deletes only the current target journal as part of actual target deletion", () => {
    const f = fixture(), independent = fixture(), own = keep(f), foreign = keep(independent)
    const ownPlan = targetJournal(f, independent.threadId)
    const foreignPlan = targetJournal(independent, f.threadId)
    appDb.deleteThread(f.threadId)
    for (const table of ["function_conversation_fork_imports", "function_conversation_fork_rows",
      "function_conversation_fork_checkpoints"]) {
      expect(count(table, "plan_id", ownPlan)).toBe(0)
      expect(count(table, "plan_id", foreignPlan)).toBe(1)
    }
    expect(count("function_conversation_rows", "uuid", own.row.uuid)).toBe(0)
    expect(raw(independent.threadId, foreign.row.uuid)).toHaveLength(1)
  })

  it("removes an old child receipt without deleting its replacement incarnation raw row", () => {
    const f = fixture(), a = child(f), old = keep(f, a.target, a.threadId)
    const replacement = randomUUID()
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify({
      cmb_thread_incarnation: replacement, workspacePath: directory }), a.threadId])
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("replacement body"), a.threadId, old.row.uuid])
    appDb.deleteThread(f.threadId)
    expect(count("function_conversation_projection_receipts", "uuid", old.row.uuid)).toBe(0)
    expect(count("function_conversation_rows", "uuid", old.row.uuid)).toBe(0)
    expect(captureThreadIncarnation(appDb.getThreadCore(a.threadId)!).token).toBe(replacement)
    expect(f.database.exec("SELECT content_json FROM thread_messages WHERE thread_id=? AND message_id=?",
      [a.threadId, old.row.uuid])[0].values).toEqual([[JSON.stringify("replacement body")]])
  })

  it("rolls back raw rows, canonical receipts and aliases when the original thread DELETE fails", () => {
    const f = fixture(), note = keep(f), from = randomUUID(), to = randomUUID()
    appDb.upsertThreadMessages(f.threadId,
      [{ id: from, role: "user", content: "ordinary alias source", created_at: new Date() }])
    expect(appDb.replaceThreadMessageId(f.threadId, from, to, "user")).toBe(true)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, from)).toBe(to)
    const before = raw(f.threadId, note.row.uuid), aliasBefore = raw(f.threadId, to)
    const originalRun = f.database.run.bind(f.database)
    const spy = vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      if (sql === "DELETE FROM threads WHERE thread_id = ?") throw Error("original thread DELETE failed")
      return originalRun(sql, args)
    })
    expect(() => appDb.deleteThread(f.threadId)).toThrow("original thread DELETE failed")
    spy.mockRestore()
    expect(f.database.inTransaction).toBe(false)
    expect(appDb.getThreadCore(f.threadId)).not.toBeNull()
    expect(raw(f.threadId, note.row.uuid)).toEqual(before)
    expect(raw(f.threadId, to)).toEqual(aliasBefore)
    expect(count("function_conversation_rows", "uuid", note.row.uuid)).toBe(1)
    expect(count("function_conversation_projection_receipts", "uuid", note.row.uuid)).toBe(1)
    expect(count("function_conversation_inbox", "uuid", note.row.uuid)).toBe(1)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, from)).toBe(to)
    appDb.deleteThread(f.threadId)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, from)).toBe(from)
    expect(raw(f.threadId, to)).toEqual([])
  })

  it("joins Store deletion to the caller transaction without clearing ordinary raw rows or committing", () => {
    const f = fixture(), note = keep(f), a = child(f), childNote = keep(f, a.target, a.threadId)
    const ordinary = randomUUID()
    appDb.upsertThreadMessages(f.threadId,
      [{ id: ordinary, role: "user", content: "ordinary remains", created_at: new Date() }])
    expect(() => f.store.deleteThreadInTransaction(f.threadId))
      .toThrow("MODS_CONVERSATION_TRANSACTION_REQUIRED")
    f.database.run("BEGIN IMMEDIATE")
    f.store.deleteThreadInTransaction(f.threadId)
    expect(f.database.inTransaction).toBe(true)
    expect(appDb.getThreadCore(f.threadId)).not.toBeNull()
    expect(count("function_conversation_rows", "uuid", note.row.uuid)).toBe(0)
    expect(raw(a.threadId, childNote.row.uuid)).toEqual([])
    expect(raw(f.threadId, ordinary)).toHaveLength(1)
    f.database.run("ROLLBACK")
    expect(raw(f.threadId, note.row.uuid)).toHaveLength(1)
    expect(raw(a.threadId, childNote.row.uuid)).toHaveLength(1)
    expect(count("function_conversation_rows", "uuid", note.row.uuid)).toBe(1)
    appDb.deleteThread(f.threadId)
    expect(raw(f.threadId, ordinary)).toEqual([])
  })

  it("refuses corrupt ownership before any original data deletion and leaves unrelated aliases intact", () => {
    const f = fixture(), note = keep(f), from = randomUUID(), to = randomUUID()
    appDb.upsertThreadMessages(f.threadId,
      [{ id: from, role: "user", content: "ordinary", created_at: new Date() }])
    expect(appDb.replaceThreadMessageId(f.threadId, from, to, "user")).toBe(true)
    f.database.run("UPDATE function_conversation_projection_receipts SET canonical_row_digest='corrupt' WHERE uuid=?",
      [note.row.uuid])
    const originalRun = f.database.run.bind(f.database), deletes: string[] = []
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      if (sql.startsWith("DELETE ")) deletes.push(sql)
      return originalRun(sql, args)
    })
    expect(() => appDb.deleteThread(f.threadId)).toThrow()
    expect(deletes).toEqual([])
    expect(f.database.inTransaction).toBe(false)
    expect(appDb.getThreadCore(f.threadId)).not.toBeNull()
    expect(raw(f.threadId, note.row.uuid)).toHaveLength(1)
    expect(count("function_conversation_rows", "uuid", note.row.uuid)).toBe(1)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, from)).toBe(to)
  })
})
