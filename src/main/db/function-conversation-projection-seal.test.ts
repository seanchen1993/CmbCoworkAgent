import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { captureThreadIncarnation } from "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS,
  readFunctionConversationRawProjection } from "./function-conversation-projection-receipt"
import { assertStoredProjectionReceipt } from "./function-conversation-projection-seal"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-projection-seal-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  const db = appDb.getDb()
  if (db.inTransaction) db.run("ROLLBACK")
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function fixture(options: { child?: boolean; legacy?: boolean; long?: boolean } = {}) {
  const database = appDb.getDb(), logicalThreadId = randomUUID()
  appDb.createThread(logicalThreadId, { workspacePath: directory })
  if (options.legacy) database.run("UPDATE threads SET metadata='{}' WHERE thread_id=?",
    [logicalThreadId])
  const logicalThread = appDb.getThreadCore(logicalThreadId)
  if (!logicalThread) throw Error("ACTUAL_LOGICAL_THREAD_MISSING")
  const logicalIncarnation = captureThreadIncarnation(logicalThread)
  const store = new FunctionConversationStore(database)
  const parent = store.ensureMain({ threadId: logicalThreadId, workspace: directory,
    incarnation: logicalIncarnation, checkpointNamespace: "" }, () => undefined)
  const target = options.child ? store.createChild(parent, {
    invocationId: randomUUID(), checkpointNamespace: "actual-native-child"
  }, () => undefined) : parent
  const physicalThreadId = options.child ? randomUUID() : logicalThreadId
  if (options.child) appDb.createThread(physicalThreadId, {
    parentThreadId: logicalThreadId, workspacePath: directory
  })
  const physicalThread = appDb.getThreadCore(physicalThreadId)
  if (!physicalThread) throw Error("ACTUAL_PHYSICAL_THREAD_MISSING")
  const incarnation = captureThreadIncarnation(physicalThread)
  const uuid = randomUUID(), content = [{ type: "text" as const,
    text: options.long ? "original canonical text ".repeat(10_000) : "original canonical text" }]
  const guard = () => {
    if (appDb.getDb() !== database) throw Error("ACTUAL_DB_CHANGED")
    store.assertCurrent(target)
  }
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({
    id: row.uuid, role: "user", content, content_mode: "snapshot",
    created_at: new Date(row.createdAt)
  }), options.child ? { conversation: target, threadId: physicalThreadId, incarnation,
    assertCurrent: guard } : undefined)
  const native = new HumanMessage({ id: uuid, content, additional_kwargs: { isMeta: true } })
  const row = store.commit(target, { uuid, inputDigest: uuid, door: "note",
    origin: { kind: "plugin", name: "actual-seal-source" },
    message: { type: "user", role: "user", isMeta: true, content },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "sdk-note" }, sdk: true, inbox: true }, guard, access.write, access.verify)
  const input = { threadId: physicalThreadId, incarnation, messageId: uuid, assertCurrent: guard }
  const receipt = () => database.exec(`SELECT target_json FROM function_conversation_projection_receipts
    WHERE thread_id=? AND uuid=?`, [physicalThreadId, uuid])[0].values[0][0]
  return { database, target, row, input, receipt, logicalThreadId, physicalThreadId }
}

describe("native read-only stored projection seal", () => {
  it("joins actual keeper and original 23 columns without normalizing, writing or creating schema", () => {
    const f = fixture({ long: true })
    const run = vi.spyOn(f.database, "run")
    const exec = vi.spyOn(f.database, "exec")
    const columns = assertStoredProjectionReceipt(f.database, f.input)
    expect(Object.keys(columns)).toEqual([...FUNCTION_CONVERSATION_PROJECTION_COLUMNS])
    expect(columns).toEqual(readFunctionConversationRawProjection(f.database,
      f.physicalThreadId, f.row.uuid))
    expect(columns.stream_authority).toBe(1)
    expect(Object.isFrozen(columns)).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(exec.mock.calls.every(([sql]) => /^(SELECT|PRAGMA)\b/.test(sql.trim()))).toBe(true)
  })

  it("can fence an ordinary writer's original transaction without claiming a commit receipt", () => {
    const f = fixture()
    f.database.run("BEGIN")
    expect(assertStoredProjectionReceipt(f.database, f.input).message_id).toBe(f.row.uuid)
    expect(f.database.inTransaction).toBe(true)
    f.database.run("ROLLBACK")
  })

  it("restores the stored legacy incarnation key from the actual logical thread", () => {
    const f = fixture({ legacy: true })
    expect(f.input.incarnation.token).toBeNull()
    expect(assertStoredProjectionReceipt(f.database, f.input).message_id).toBe(f.row.uuid)
  })

  it("validates a child's actual separate projection without changing its logical parent identity", () => {
    const f = fixture({ child: true })
    expect(f.target.threadId).toBe(f.logicalThreadId)
    expect(f.physicalThreadId === f.logicalThreadId).toBe(false)
    expect(assertStoredProjectionReceipt(f.database, f.input).thread_id).toBe(f.physicalThreadId)
    expect(f.database.exec("SELECT COUNT(*) FROM thread_messages WHERE thread_id=?",
      [f.logicalThreadId])[0].values[0][0]).toBe(0)
  })

  it.each(["content_json", "ordinal", "stream_authority", "provider_occurrence", "prompt_origin_json"])(
    "rejects a changed sealed raw %s", field => {
      const f = fixture()
      const value = field === "content_json" ? JSON.stringify("changed") :
        field === "prompt_origin_json" ? JSON.stringify({ forged: true }) : 7
      f.database.run(`UPDATE thread_messages SET ${field}=? WHERE thread_id=? AND message_id=?`,
        [value, f.physicalThreadId, f.row.uuid])
      expect(() => assertStoredProjectionReceipt(f.database, f.input)).toThrow()
    }
  )

  it.each(["bytes", "payload_digest", "receipt_id", "sequence"])(
    "rejects changed actual keeper %s before accepting the stamp", field => {
      const f = fixture(), value = field === "bytes" ? f.row.bytes + 1 :
        field === "sequence" ? 0 : randomUUID()
      f.database.run(`UPDATE function_conversation_rows SET ${field}=?
        WHERE conversation_id=? AND uuid=?`, [value, f.target.conversationId, f.row.uuid])
      expect(() => assertStoredProjectionReceipt(f.database, f.input)).toThrow()
    }
  )

  it("rejects altered native payload even when the keeper's own hash and byte count are replaced", () => {
    const f = fixture()
    const raw = f.database.exec(`SELECT payload_json FROM function_conversation_rows
      WHERE conversation_id=? AND uuid=?`, [f.target.conversationId, f.row.uuid])[0].values[0][0]
    if (typeof raw !== "string") throw Error("ACTUAL_PAYLOAD_MISSING")
    const payload = JSON.parse(raw)
    payload.nativePayload += " "
    const encoded = JSON.stringify(payload)
    f.database.run(`UPDATE function_conversation_rows SET payload_json=?,payload_digest=?,bytes=?
      WHERE conversation_id=? AND uuid=?`, [encoded, hash(encoded), Buffer.byteLength(encoded),
      f.target.conversationId, f.row.uuid])
    expect(() => assertStoredProjectionReceipt(f.database, f.input)).toThrow()
  })

  it.each(["extra", "incarnation-object", "kind", "namespace", "logicalSessionId", "branchId"])(
    "rejects target envelope %s rather than constructing a replacement owner", change => {
      const f = fixture(), raw = f.receipt()
      if (typeof raw !== "string") throw Error("ACTUAL_TARGET_MISSING")
      const target = JSON.parse(raw)
      if (change === "extra") target.extra = true
      else if (change === "incarnation-object") target.incarnation = f.input.incarnation
      else if (change === "kind") target.kind = "child"
      else if (change === "namespace") target.checkpointNamespace = "another-native-loop"
      else target[change] = randomUUID()
      f.database.run(`UPDATE function_conversation_projection_receipts SET target_json=?
        WHERE thread_id=? AND uuid=?`, [JSON.stringify(target), f.physicalThreadId, f.row.uuid])
      expect(() => assertStoredProjectionReceipt(f.database, f.input)).toThrow()
    }
  )

  it("does not recertify a marked projection when its original receipt is absent", () => {
    const f = fixture()
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?",
      [f.physicalThreadId])
    expect(() => assertStoredProjectionReceipt(f.database, f.input))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_projection_receipts
      WHERE thread_id=?`, [f.physicalThreadId])[0].values[0][0]).toBe(0)
  })

  it.each(["fragment", "state"])("rejects residual %s including an orphaned stream state", kind => {
    const f = fixture()
    if (kind === "fragment") f.database.run(`INSERT INTO thread_message_fragments
      (thread_id,message_id,content_text,created_at) VALUES (?,?,?,?)`,
    [f.physicalThreadId, f.row.uuid, "late raw echo", 100])
    else f.database.run(`INSERT INTO thread_message_fragment_states
      (thread_id,message_id,total_chars,updated_at) VALUES (?,?,?,?)`,
    [f.physicalThreadId, f.row.uuid, 0, 100])
    expect(() => assertStoredProjectionReceipt(f.database, f.input)).toThrow()
  })

  it.each(["physical", "logical"])("rejects %s ABA with the same public thread ID", location => {
    const f = fixture({ child: true }), id = location === "physical"
      ? f.physicalThreadId : f.logicalThreadId
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), id])
    expect(() => assertStoredProjectionReceipt(f.database,
      { ...f.input, assertCurrent: () => undefined })).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
  })

  it("propagates original native guard failure and rejects an asynchronous guard", () => {
    const f = fixture(), error = Error("ACTUAL_OWNER_RETIRED")
    expect(() => assertStoredProjectionReceipt(f.database, { ...f.input,
      assertCurrent: () => { throw error } })).toThrow(error)
    expect(() => assertStoredProjectionReceipt(f.database, { ...f.input,
      assertCurrent: () => Promise.resolve() })).toThrow("MODS_CONVERSATION_ASYNC_TRANSACTION")
  })

  it("fixes the input selector before a host guard can mutate the caller's object", () => {
    const f = fixture()
    const input = { ...f.input, assertCurrent: () => { input.messageId = randomUUID() } }
    expect(assertStoredProjectionReceipt(f.database, input).message_id).toBe(f.row.uuid)
  })
})
