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
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "./native-sqlite-adapter"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { ensureFunctionConversationProjectionReceiptSchema,
  functionConversationProjectionIncarnation } from "./function-conversation-projection-receipt"
import { deleteFunctionConversationThreadDataInTransaction } from "./function-conversation-cleanup"
import { readFunctionConversationRawProjection } from "./function-conversation-projection-receipt"
import { ensureFunctionConversationNativeDestinationSchema } from
  "./function-conversation-native-destination"
import { recordFunctionConversationPresentationDisposition,
  readFunctionConversationPresentationDisposition } from "./function-conversation-presentation-disposition"

let directory = ""
const isolated: NativeSqliteAdapter[] = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-conversation-cleanup-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  if (appDb.getDb().inTransaction) appDb.getDb().run("ROLLBACK")
  for (const db of isolated.splice(0)) {
    if (db.inTransaction) db.run("ROLLBACK")
    db.close()
  }
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const database = appDb.getDb(), threadId = randomUUID()
  appDb.createThread(threadId, { workspacePath: directory })
  const actual = appDb.getThreadCore(threadId)
  if (!actual) throw Error("ACTUAL_THREAD_MISSING")
  const incarnation = captureThreadIncarnation(actual), store = new FunctionConversationStore(database)
  const parent = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, () => undefined)
  const input = { threadId, incarnation, assertCurrent: () => {
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_THREAD_CHANGED")
  } }
  return { database, threadId, incarnation, store, parent, input }
}

function keep(f: ReturnType<typeof fixture>, target = f.parent, physicalThreadId = f.threadId) {
  const actual = appDb.getThreadCore(physicalThreadId)
  if (!actual) throw Error("ACTUAL_PROJECTION_MISSING")
  const incarnation = captureThreadIncarnation(actual), uuid = randomUUID()
  const native = new HumanMessage({ id: uuid, content: "complete owned canonical note",
    additional_kwargs: { isMeta: true } })
  const content = native.content
  if (typeof content !== "string") throw Error("ACTUAL_TEXT_REQUIRED")
  const guard = () => f.store.assertCurrent(target)
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({
    id: row.uuid, role: "user", content, created_at: new Date(row.createdAt),
    content_mode: "snapshot"
  }), target.kind === "child" ? { conversation: target, threadId: physicalThreadId,
    incarnation, assertCurrent: guard } : undefined)
  const row = f.store.commit(target, { uuid, inputDigest: uuid, door: "note",
    origin: { kind: "plugin", name: "actual-cleanup-fixture" },
    message: { type: "user", role: "user", isMeta: true,
      content: [{ type: "text", text: "complete owned canonical note" }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "actual-sdk-note" }, sdk: true, inbox: true },
  guard, access.write, access.verify)
  return { row, physicalThreadId, incarnation }
}

function keepPrompt(f: ReturnType<typeof fixture>, disposition: "persisted" | "blank" | "plumbing",
  target = f.parent, physicalThreadId = f.threadId) {
  const actual = appDb.getThreadCore(physicalThreadId)
  if (!actual) throw Error("ACTUAL_PROMPT_THREAD_REQUIRED")
  const incarnation = captureThreadIncarnation(actual), uuid = randomUUID()
  const text = "complete native prompt preserved for the actual next request"
  const native = new HumanMessage({ id: uuid, content: text })
  const guard = () => f.store.assertCurrent(target)
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
    role: "user", content: disposition === "persisted" ? text : "",
    recovery_integrity: disposition === "persisted" ? "verified" : "unverified",
    created_at: new Date(row.createdAt) }), target.kind === "child" ? {
    conversation: target, threadId: physicalThreadId, incarnation, assertCurrent: guard
  } : undefined)
  const selection = (row: Parameters<typeof access.write>[2]) => ({ target, row,
    threadId: physicalThreadId, incarnation, assertCurrent: guard })
  const columns = () => {
    const value = readFunctionConversationRawProjection(f.database, physicalThreadId, uuid)
    if (!value) throw Error("ACTUAL_PROMPT_COLUMNS_REQUIRED")
    return value
  }
  const row = f.store.commit(target, { uuid, inputDigest: uuid, door: "prompt",
    origin: { kind: "composer" }, message: { type: "user", content: [{ type: "text", text }] },
    nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: {
      kind: "actual-native-input", presentation: { version: 1, disposition,
        intentDigest: "c".repeat(64) } }, sdk: false, inbox: false }, guard,
  (db, ref, row) => {
    access.write(db, ref, row)
    recordFunctionConversationPresentationDisposition(db, selection(row), columns())
  }, (db, ref, row) => {
    access.verify(db, ref, row)
    readFunctionConversationPresentationDisposition(db, selection(row), columns())
  })
  return { row, incarnation, physicalThreadId }
}

function child(f: ReturnType<typeof fixture>, physicalParent = f.threadId) {
  const threadId = randomUUID(), runId = randomUUID()
  const target = f.store.createChild(f.parent, { invocationId: runId,
    checkpointNamespace: `actual-child:${runId}` }, () => undefined)
  appDb.createThread(threadId, { isInternalFlowRuntime: true, parentThreadId: physicalParent,
    modsAgentRunId: runId, workspacePath: directory })
  const actual = appDb.getThreadCore(threadId)
  if (!actual) throw Error("ACTUAL_CHILD_MISSING")
  const incarnation = captureThreadIncarnation(actual)
  const input = { threadId, incarnation, assertCurrent: () => {
    if (appDb.getDb() !== f.database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_CHILD_CHANGED")
  } }
  return { target, threadId, runId, incarnation, input }
}

function ordinaryChild(f: ReturnType<typeof fixture>, physicalParent = f.threadId) {
  const threadId = randomUUID(), runId = randomUUID()
  appDb.createThread(threadId, { isInternalFlowRuntime: true, parentThreadId: physicalParent,
    modsAgentRunId: runId, workspacePath: directory })
  const actual = appDb.getThreadCore(threadId)
  if (!actual) throw Error("ACTUAL_ORDINARY_CHILD_MISSING")
  const incarnation = captureThreadIncarnation(actual)
  return { threadId, runId, incarnation, input: { threadId, incarnation, assertCurrent: () => {
    if (appDb.getDb() !== f.database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_ORDINARY_CHILD_CHANGED")
  } } }
}

function count(f: ReturnType<typeof fixture>, table: string, column: string, value: string) {
  return f.database.exec(`SELECT COUNT(*) FROM ${table} WHERE ${column}=?`, [value])[0].values[0][0]
}
function clean(f: ReturnType<typeof fixture>, input = f.input) {
  f.database.run("BEGIN IMMEDIATE")
  deleteFunctionConversationThreadDataInTransaction(f.database, input)
  f.database.run("COMMIT")
}
function journal(f: ReturnType<typeof fixture>, targetThreadId: string, incarnation: typeof f.incarnation,
  sourceThreadId = f.threadId) {
  const plan = randomUUID()
  f.database.run(`INSERT INTO function_conversation_fork_imports
    (plan_id,target_thread_id,target_incarnation,target_json,source_digest,source_json,
      branch_map_json,selected_source_index,status) VALUES (?,?,?,?,?,?,?,?, 'preparing')`,
  [plan, targetThreadId, functionConversationProjectionIncarnation(incarnation),
    JSON.stringify({ threadId: targetThreadId, workspace: directory, incarnation,
      checkpointNamespace: "" }), "actual-source-digest", JSON.stringify({ sourceThreadId }), "{}", 0])
  f.database.run("INSERT INTO function_conversation_fork_rows VALUES (?,?,?,?)",
    [plan, 1, randomUUID(), "actual-row-digest"])
  f.database.run("INSERT INTO function_conversation_fork_checkpoints VALUES (?,?,?,?)",
    [plan, 0, randomUUID(), "actual-snapshot-digest"])
  return plan
}

describe("actual conversation data cleanup joins the original AppSQLite transaction", () => {
  it("deletes an actual unadmitted internal child without selecting its canonical parent", () => {
    const f = fixture(), parent = keepPrompt(f, "blank"), leaf = ordinaryChild(f)
    appDb.upsertThreadMessages(leaf.threadId, [{ id: randomUUID(), role: "assistant",
      content: "ordinary physical child", created_at: new Date() }])
    appDb.deleteThread(leaf.threadId)
    expect(appDb.getThreadCore(leaf.threadId)).toBeNull()
    expect(count(f, "function_conversations", "conversation_id", f.parent.conversationId)).toBe(1)
    expect(count(f, "function_conversation_rows", "uuid", parent.row.uuid)).toBe(1)
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", parent.row.uuid)).toBe(1)
  })

  it("deletes an unadmitted nested leaf while preserving its registered ancestor", () => {
    const f = fixture(), ancestor = child(f), row = keepPrompt(f, "plumbing", ancestor.target,
      ancestor.threadId), leaf = ordinaryChild(f, ancestor.threadId)
    appDb.deleteThread(leaf.threadId)
    expect(appDb.getThreadCore(leaf.threadId)).toBeNull()
    expect(appDb.getThreadCore(ancestor.threadId)).toBeDefined()
    expect(count(f, "function_conversations", "conversation_id", ancestor.target.conversationId)).toBe(1)
    expect(count(f, "function_conversation_rows", "uuid", row.row.uuid)).toBe(1)
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", row.row.uuid)).toBe(1)
  })

  it.each(["marker", "receipt", "ledger", "destination", "journal"] as const)(
    "rejects an unadmitted physical child with an actual orphan %s", evidence => {
      const f = fixture(), parent = keepPrompt(f, "blank"), leaf = ordinaryChild(f)
      const key = functionConversationProjectionIncarnation(leaf.incarnation)
      if (evidence === "marker") {
        const id = randomUUID()
        appDb.upsertThreadMessages(leaf.threadId, [{ id, role: "user", content: "orphan",
          created_at: new Date() }])
        f.database.run(`UPDATE thread_messages SET function_row_json=(SELECT function_row_json
          FROM thread_messages WHERE thread_id=? AND message_id=?)
          WHERE thread_id=? AND message_id=?`, [f.threadId, parent.row.uuid, leaf.threadId, id])
      } else if (evidence === "receipt") f.database.run(`INSERT INTO
        function_conversation_projection_receipts SELECT ?,?,uuid,target_json,canonical_receipt_id,
          canonical_row_digest,native_payload_digest,projection_json,projection_digest
          FROM function_conversation_projection_receipts WHERE uuid=?`,
      [leaf.threadId, key, parent.row.uuid])
      else if (evidence === "ledger") f.database.run(`INSERT INTO
        function_conversation_presentation_dispositions SELECT ?,?,uuid,target_json,canonical_receipt_id,
          canonical_row_digest,native_payload_digest,projection_digest,anchor_digest,intent_digest,
          disposition,version FROM function_conversation_presentation_dispositions WHERE uuid=?`,
      [leaf.threadId, key, parent.row.uuid])
      else if (evidence === "destination") {
        ensureFunctionConversationNativeDestinationSchema(f.database)
        f.database.run(`INSERT INTO function_conversation_native_destinations VALUES
          (?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), randomUUID(), "{}", "{}", leaf.runId,
          leaf.threadId, JSON.stringify(leaf.incarnation), randomUUID(),
          JSON.stringify(leaf.incarnation), "{}", "actual-orphan-digest"])
      } else journal(f, leaf.threadId, leaf.incarnation)
      expect(() => appDb.deleteThread(leaf.threadId)).toThrow("MODS_CONVERSATION_CLEANUP_CONFLICT")
      expect(appDb.getThreadCore(leaf.threadId)).toBeDefined()
      expect(count(f, "function_conversation_rows", "uuid", parent.row.uuid)).toBe(1)
    }
  )

  it("rejects a fresh orphan inserted by the final unadmitted-child source callback", () => {
    const f = fixture(), parent = keepPrompt(f, "blank"), leaf = ordinaryChild(f)
    let absenceChecks = 0, inserted = 0
    const originalExec = f.database.exec.bind(f.database)
    vi.spyOn(f.database, "exec").mockImplementation((sql, ...args) => {
      const result = originalExec(sql, ...args)
      if (sql.includes("SELECT 1 FROM function_conversation_fork_imports") &&
        sql.includes("target_incarnation=? LIMIT 1")) absenceChecks++
      return result
    })
    f.database.run("BEGIN IMMEDIATE")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, {
      ...leaf.input, assertCurrent: () => {
        leaf.input.assertCurrent()
        if (absenceChecks !== 2 || inserted) return
        f.database.run(`INSERT INTO function_conversation_presentation_dispositions
          SELECT ?,?,uuid,target_json,canonical_receipt_id,canonical_row_digest,native_payload_digest,
            projection_digest,anchor_digest,intent_digest,disposition,version
          FROM function_conversation_presentation_dispositions WHERE uuid=?`,
        [leaf.threadId, functionConversationProjectionIncarnation(leaf.incarnation), parent.row.uuid])
        inserted += f.database.getRowsModified()
      }
    })).toThrow("MODS_CONVERSATION_CLEANUP_CONFLICT")
    expect(inserted).toBe(1)
    f.database.run("ROLLBACK")
    expect(appDb.getThreadCore(leaf.threadId)).toBeDefined()
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", parent.row.uuid)).toBe(1)
  })

  it("rejects an unadmitted-child cleanup after physical incarnation replacement", () => {
    const f = fixture(), parent = keep(f), leaf = ordinaryChild(f), replacement = randomUUID()
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify({
      cmb_thread_incarnation: replacement, workspacePath: directory }), leaf.threadId])
    f.database.run("BEGIN IMMEDIATE")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database,
      { ...leaf.input, assertCurrent: () => undefined })).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    f.database.run("ROLLBACK")
    expect(appDb.getThreadCore(leaf.threadId)?.metadata).toContain(replacement)
    expect(count(f, "function_conversation_rows", "uuid", parent.row.uuid)).toBe(1)
  })

  it("retires the exact family ledgers with their actual primary receipts", () => {
    const f = fixture(), other = fixture(), a = child(f)
    const own = [keepPrompt(f, "persisted"), keepPrompt(f, "blank"),
      keepPrompt(f, "plumbing", a.target, a.threadId)]
    const foreign = keepPrompt(other, "blank")
    clean(f)
    for (const value of own) {
      expect(count(f, "function_conversation_presentation_dispositions", "uuid", value.row.uuid)).toBe(0)
      expect(count(f, "function_conversation_projection_receipts", "uuid", value.row.uuid)).toBe(0)
      expect(count(f, "function_conversation_rows", "uuid", value.row.uuid)).toBe(0)
    }
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", foreign.row.uuid)).toBe(1)
  })

  it("deletes one child's ledger while keeping actual parent and sibling ledgers", () => {
    const f = fixture(), a = child(f), b = child(f)
    const parent = keepPrompt(f, "persisted"), selected = keepPrompt(f, "blank", a.target, a.threadId)
    const sibling = keepPrompt(f, "plumbing", b.target, b.threadId)
    clean(f, a.input)
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", selected.row.uuid)).toBe(0)
    for (const value of [parent, sibling])
      expect(count(f, "function_conversation_presentation_dispositions", "uuid", value.row.uuid)).toBe(1)
  })

  it("retains a real replacement incarnation's ledger and raw body during old family cleanup", () => {
    const f = fixture(), a = child(f), old = keepPrompt(f, "blank", a.target, a.threadId)
    const token = randomUUID()
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify({
      cmb_thread_incarnation: token, workspacePath: directory }), a.threadId])
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("replacement raw body"), a.threadId, old.row.uuid])
    const actual = appDb.getThreadCore(a.threadId)
    if (!actual) throw Error("ACTUAL_REPLACEMENT_REQUIRED")
    const replacement = f.store.ensureMain({ threadId: a.threadId, workspace: directory,
      incarnation: captureThreadIncarnation(actual), checkpointNamespace: "" }, () => undefined)
    const current = keepPrompt(f, "plumbing", replacement, a.threadId)
    clean(f)
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", old.row.uuid)).toBe(0)
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", current.row.uuid)).toBe(1)
    expect(f.database.exec("SELECT content_json FROM thread_messages WHERE thread_id=? AND message_id=?",
      [a.threadId, old.row.uuid])[0].values).toEqual([[JSON.stringify("replacement raw body")]])
    expect(count(f, "thread_messages", "message_id", current.row.uuid)).toBe(1)
  })

  it.each(["missing", "altered", "orphan"] as const)(
    "rolls back actual cleanup when the selected ledger is %s", change => {
      const f = fixture(), own = keepPrompt(f, "blank")
      if (change === "missing") f.database.run(
        "DELETE FROM function_conversation_presentation_dispositions WHERE uuid=?", [own.row.uuid])
      else if (change === "altered") f.database.run(`UPDATE function_conversation_presentation_dispositions
        SET intent_digest=? WHERE uuid=?`, [randomUUID(), own.row.uuid])
      else f.database.run(`INSERT INTO function_conversation_presentation_dispositions
        SELECT thread_id,incarnation,?,target_json,canonical_receipt_id,canonical_row_digest,
          native_payload_digest,projection_digest,anchor_digest,intent_digest,disposition,version
        FROM function_conversation_presentation_dispositions WHERE uuid=?`, [randomUUID(), own.row.uuid])
      f.database.run("BEGIN")
      const writes = vi.spyOn(f.database, "run")
      expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, f.input)).toThrow()
      expect(writes.mock.calls.some(([sql]) => /^DELETE\b/.test(sql.trim()))).toBe(false)
      f.database.run("ROLLBACK")
      expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
      expect(count(f, "thread_messages", "message_id", own.row.uuid)).toBe(1)
    }
  )

  it("checks the ledger again after the original native guard's synchronous mutation", () => {
    const f = fixture(), own = keepPrompt(f, "blank")
    const original = f.database.exec.bind(f.database)
    let scanned = false, changed = false
    vi.spyOn(f.database, "exec").mockImplementation((sql, args) => {
      const result = original(sql, args)
      if (sql.includes("cleanup_rowid") && sql.includes("presentation_dispositions")) scanned = true
      return result
    })
    f.database.run("BEGIN")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, { ...f.input,
      assertCurrent: () => {
        f.input.assertCurrent()
        if (scanned && !changed) {
          changed = true
          f.database.run(`UPDATE function_conversation_presentation_dispositions
            SET disposition='plumbing' WHERE uuid=?`, [own.row.uuid])
        }
      } })).toThrow()
    expect(changed).toBe(true)
    f.database.run("ROLLBACK")
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", own.row.uuid)).toBe(1)
  })

  it("rejects a final guard reinserting the ledger and lets the original rollback restore all rows", () => {
    const f = fixture(), own = keepPrompt(f, "blank")
    const saved = f.database.exec("SELECT * FROM function_conversation_presentation_dispositions WHERE uuid=?",
      [own.row.uuid])[0]
    let inserted = false
    f.database.run("BEGIN")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, { ...f.input,
      assertCurrent: () => {
        f.input.assertCurrent()
        if (!inserted && count(f, "function_conversation_rows", "uuid", own.row.uuid) === 0) {
          inserted = true
          f.database.run(`INSERT INTO function_conversation_presentation_dispositions
            (${saved.columns.join(",")}) VALUES (${saved.columns.map(() => "?").join(",")})`, saved.values[0])
        }
      } })).toThrow()
    expect(inserted).toBe(true)
    f.database.run("ROLLBACK")
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
    expect(count(f, "function_conversation_presentation_dispositions", "uuid", own.row.uuid)).toBe(1)
  })

  it("clears only the exact main family and its complete raw projection receipts", () => {
    const f = fixture(), independent = fixture(), own = keep(f), foreign = keep(independent)
    const c = child(f), childRow = keep(f, c.target, c.threadId)
    const branch = f.store.forkBranch(f.parent,
      { parentFrontier: own.row.sequence, checkpointId: randomUUID() }, () => undefined)
    const branchRow = keep(f, branch)
    clean(f)
    expect(count(f, "function_logical_sessions", "logical_session_id", f.parent.logicalSessionId)).toBe(0)
    for (const target of [f.parent, c.target]) {
      for (const table of ["function_conversations", "function_conversation_rows",
        "function_conversation_branches", "function_conversation_inbox"])
        expect(count(f, table, "conversation_id", target.conversationId)).toBe(0)
    }
    for (const uuid of [own.row.uuid, childRow.row.uuid, branchRow.row.uuid])
      expect(count(f, "function_conversation_projection_receipts", "uuid", uuid)).toBe(0)
    expect(count(f, "thread_messages", "message_id", childRow.row.uuid)).toBe(0)
    expect(f.database.exec("SELECT message_count FROM thread_message_buckets WHERE thread_id=?",
      [c.threadId])[0].values).toEqual([[0]])
    expect(count(f, "function_conversation_rows", "uuid", foreign.row.uuid)).toBe(1)
    expect(appDb.getThreadCore(f.threadId)).toBeDefined()
  })

  it("deletes one actual child invocation while retaining parent and sibling rows", () => {
    const f = fixture(), parent = keep(f), a = child(f), b = child(f)
    const aRow = keep(f, a.target, a.threadId), bRow = keep(f, b.target, b.threadId)
    clean(f, a.input)
    expect(count(f, "function_conversation_rows", "uuid", aRow.row.uuid)).toBe(0)
    expect(count(f, "function_conversation_rows", "uuid", bRow.row.uuid)).toBe(1)
    expect(count(f, "function_conversation_rows", "uuid", parent.row.uuid)).toBe(1)
    expect(count(f, "function_conversations", "conversation_id", b.target.conversationId)).toBe(1)
    expect(count(f, "function_logical_sessions", "logical_session_id", f.parent.logicalSessionId)).toBe(1)
  })

  it("clears an empty child only from its real persisted invocation metadata", () => {
    const f = fixture(), a = child(f), b = child(f)
    clean(f, a.input)
    expect(count(f, "function_conversations", "conversation_id", a.target.conversationId)).toBe(0)
    expect(count(f, "function_conversations", "conversation_id", b.target.conversationId)).toBe(1)
  })

  it("validates each real internal ancestor run for a nested independent child", () => {
    const f = fixture(), a = child(f), nested = child(f, a.threadId)
    const aRow = keep(f, a.target, a.threadId), nestedRow = keep(f, nested.target, nested.threadId)
    clean(f, nested.input)
    expect(count(f, "function_conversation_rows", "uuid", nestedRow.row.uuid)).toBe(0)
    expect(count(f, "function_conversation_rows", "uuid", aRow.row.uuid)).toBe(1)
  })

  it("removes an old child receipt without deleting an ABA replacement's raw message", () => {
    const f = fixture(), a = child(f), old = keep(f, a.target, a.threadId)
    const replacement = randomUUID()
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify({
      cmb_thread_incarnation: replacement, workspacePath: directory }), a.threadId])
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("replacement body"), a.threadId, old.row.uuid])
    clean(f)
    expect(count(f, "function_conversation_projection_receipts", "uuid", old.row.uuid)).toBe(0)
    expect(f.database.exec("SELECT content_json FROM thread_messages WHERE thread_id=? AND message_id=?",
      [a.threadId, old.row.uuid])[0].values).toEqual([[JSON.stringify("replacement body")]])
  })

  it("clears checkpoint membership and delivery rows in the same family transaction", () => {
    const f = fixture(), own = keep(f), receipt = randomUUID()
    f.database.run(`INSERT INTO function_conversation_checkpoint_receipts VALUES
      (?,?,?,?,?,?,?,?,?,?)`, [receipt, f.parent.conversationId, f.parent.branchId, f.threadId,
      functionConversationProjectionIncarnation(f.incarnation), "", "actual-cp", "{}", "hash", "{}"])
    f.database.run("INSERT INTO function_conversation_checkpoint_members VALUES (?,?,?,?)",
      [receipt, 0, own.row.uuid, "actual-member-fixture"])
    f.database.run("INSERT INTO function_conversation_deliveries VALUES (?,?,?,?,?)",
      [f.parent.conversationId, f.parent.branchId, "actual-cp", "actual-generation", own.row.sequence])
    clean(f)
    expect(count(f, "function_conversation_checkpoint_members", "receipt_id", receipt)).toBe(0)
    expect(count(f, "function_conversation_checkpoint_receipts", "receipt_id", receipt)).toBe(0)
    expect(count(f, "function_conversation_deliveries", "conversation_id", f.parent.conversationId)).toBe(0)
  })

  it("clears only this exact target journal, never an independent fork's source reference", () => {
    const f = fixture(), unrelated = fixture(), ownPlan = journal(f, f.threadId, f.incarnation)
    const otherPlan = journal(f, unrelated.threadId, unrelated.incarnation)
    clean(f)
    for (const table of ["function_conversation_fork_imports", "function_conversation_fork_rows",
      "function_conversation_fork_checkpoints"]) {
      expect(count(f, table, "plan_id", ownPlan)).toBe(0)
      expect(count(f, table, "plan_id", otherPlan)).toBe(1)
    }
  })

  it.each(["canonical_receipt_id", "canonical_row_digest", "native_payload_digest", "projection_digest",
    "target_json"])("rejects altered receipt %s before the first DELETE", column => {
    const f = fixture(), own = keep(f)
    f.database.run(`UPDATE function_conversation_projection_receipts SET ${column}=? WHERE uuid=?`,
      [column === "target_json" ? "{}" : randomUUID(), own.row.uuid])
    f.database.run("BEGIN")
    const writes = vi.spyOn(f.database, "run")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, f.input)).toThrow()
    expect(writes.mock.calls.some(([sql]) => /^DELETE\b/.test(sql.trim()))).toBe(false)
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
  })

  it("rejects a physical child's receipt selecting a different sibling conversation", () => {
    const f = fixture(), a = child(f), b = child(f), own = keep(f, a.target, a.threadId)
    const stored = f.database.exec("SELECT target_json FROM function_conversation_projection_receipts WHERE uuid=?",
      [own.row.uuid])[0].values[0][0]
    if (typeof stored !== "string") throw Error("ACTUAL_RECEIPT_MISSING")
    const target = JSON.parse(stored)
    target.conversationId = b.target.conversationId
    f.database.run("UPDATE function_conversation_projection_receipts SET target_json=? WHERE uuid=?",
      [JSON.stringify(target), own.row.uuid])
    f.database.run("BEGIN")
    const writes = vi.spyOn(f.database, "run")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, a.input)).toThrow()
    expect(writes.mock.calls.some(([sql]) => /^DELETE\b/.test(sql.trim()))).toBe(false)
  })

  it("rejects fake child metadata and ancestor cycles without deleting a sibling", () => {
    const f = fixture(), a = child(f), own = keep(f, a.target, a.threadId)
    const row = appDb.getThreadCore(a.threadId)
    if (!row) throw Error("ACTUAL_CHILD_MISSING")
    const metadata = JSON.parse(row.metadata ?? "{}")
    metadata.parentThreadId = a.threadId
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify(metadata), a.threadId])
    f.database.run("BEGIN")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, a.input)).toThrow()
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
  })

  it("requires the original transaction and physical incarnation", () => {
    const f = fixture(), own = keep(f)
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, f.input))
      .toThrow("MODS_CONVERSATION_TRANSACTION_REQUIRED")
    f.database.run("BEGIN")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, { ...f.input,
      incarnation: { ...f.incarnation, token: randomUUID() } }))
      .toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
  })

  it("passes the original guard error and rejects asynchronous guards", () => {
    const f = fixture(), error = Error("ORIGINAL_METADATA_OR_LEASE_CHANGED")
    f.database.run("BEGIN")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database,
      { ...f.input, assertCurrent: () => { throw error } })).toThrow(error)
    const asyncGuard = (() => Promise.resolve()) as unknown as () => void
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database,
      { ...f.input, assertCurrent: asyncGuard })).toThrow("MODS_CONVERSATION_ASYNC_TRANSACTION")
  })

  it("lets the original rollback restore all rows and receipts after data retirement", () => {
    const f = fixture(), own = keep(f)
    f.database.run("BEGIN")
    deleteFunctionConversationThreadDataInTransaction(f.database, f.input)
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(0)
    f.database.run("ROLLBACK")
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
    expect(count(f, "function_conversation_projection_receipts", "uuid", own.row.uuid)).toBe(1)
  })

  it("rejects a missing ownership dependency before deleting any original family row", () => {
    const f = fixture(), own = keep(f)
    f.database.run("BEGIN")
    f.database.run("DROP TABLE function_conversation_checkpoint_members")
    const run = vi.spyOn(f.database, "run")
    expect(() => deleteFunctionConversationThreadDataInTransaction(f.database, f.input))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(run.mock.calls.some(([sql]) => /^DELETE\b/.test(sql.trim()))).toBe(false)
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(1)
  })

  it.each([false, true])("never builds schema for legacy absence; receipt-only=%s fails closed", receiptOnly => {
    const db = openNativeSqliteDatabase(join(directory, `${randomUUID()}.sqlite`)).database
    isolated.push(db)
    const token = randomUUID(), incarnation = { token, legacyCreatedAt: 1234 }
    db.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
    db.run("INSERT INTO threads VALUES (?,?,?)", ["actual-legacy", 1234,
      JSON.stringify({ cmb_thread_incarnation: token })])
    if (receiptOnly) {
      ensureFunctionConversationProjectionReceiptSchema(db)
      db.run(`INSERT INTO function_conversation_projection_receipts VALUES (?,?,?,?,?,?,?,?,?)`,
        ["actual-legacy", functionConversationProjectionIncarnation(incarnation), randomUUID(),
          "{}", "original-row-receipt", "original-row-digest", "original-native-digest",
          "original-raw-json", "original-raw-digest"])
    }
    db.run("BEGIN")
    const run = vi.spyOn(db, "run")
    const action = () => deleteFunctionConversationThreadDataInTransaction(db,
      { threadId: "actual-legacy", incarnation, assertCurrent: () => undefined })
    if (receiptOnly) expect(action).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    else expect(action).not.toThrow()
    expect(run.mock.calls.some(([sql]) => /^(CREATE|INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toBe(false)
  })

  it("fixes the input selectors before the original guard can mutate the caller object", () => {
    const f = fixture(), other = fixture(), own = keep(f), foreign = keep(other)
    const input = { ...f.input }
    input.assertCurrent = () => { input.threadId = other.threadId; input.incarnation = other.incarnation }
    clean(f, input)
    expect(count(f, "function_conversation_rows", "uuid", own.row.uuid)).toBe(0)
    expect(count(f, "function_conversation_rows", "uuid", foreign.row.uuid)).toBe(1)
  })

  it("leaves legacy ordinary threads and internal flows without canonical ownership unchanged", () => {
    const f = fixture(), ordinary = randomUUID(), flow = randomUUID()
    appDb.createThread(ordinary, { workspacePath: directory })
    appDb.createThread(flow, { workspacePath: directory, isInternalFlowRuntime: true,
      parentThreadId: ordinary, modsAgentRunId: randomUUID() })
    for (const threadId of [ordinary, flow]) {
      const actual = appDb.getThreadCore(threadId)
      if (!actual) throw Error("ACTUAL_ORDINARY_THREAD_MISSING")
      f.database.run("BEGIN")
      const run = vi.spyOn(f.database, "run")
      deleteFunctionConversationThreadDataInTransaction(f.database,
        { threadId, incarnation: captureThreadIncarnation(actual), assertCurrent: () => undefined })
      expect(run.mock.calls.some(([sql]) => /^(CREATE|INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toBe(false)
      run.mockRestore()
      f.database.run("ROLLBACK")
    }
  })
})
