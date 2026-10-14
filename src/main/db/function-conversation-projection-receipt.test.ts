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
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationProjectionReceipt,
  readFunctionConversationRawProjection, recordFunctionConversationProjectionReceipt } from
  "./function-conversation-projection-receipt"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-projection-receipt-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(text = "Actual canonical note", snapshot = false, beforeCommit?: () => void) {
  const database = appDb.getDb(), threadId = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: directory })
  const incarnation = captureThreadIncarnation(thread), store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, () => {})
  const uuid = randomUUID(), content = [{ type: "text" as const, text }]
  const access = createFunctionConversationTranscriptAccess((_ref, row) => ({
    id: row.uuid, role: "user", content,
    ...(snapshot ? { content_mode: "snapshot" as const } : {}),
    created_at: new Date(row.createdAt)
  }))
  const native = new HumanMessage({ id: uuid, content, additional_kwargs: { isMeta: true } })
  const commit = () => store.commit(target, { uuid, inputDigest: uuid, door: "note",
    origin: { kind: "plugin", name: "actual-receipt-test" },
    message: { type: "user", role: "user", isMeta: true, content },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "sdk-note" }, sdk: true, inbox: true }, () => {}, access.write, access.verify)
  beforeCommit?.()
  const row = commit()
  return { database, threadId, target, row, access, commit,
    selection: { target, row, threadId, incarnation, assertCurrent: () => store.assertCurrent(target) } }
}

describe("actual immutable native projection receipts", () => {
  it.each(["payload_digest", "bytes", "input_digest", "receipt_id", "sequence", "branch_id",
    "door", "created_at"])("rechecks canonical %s after the first current guard", field => {
    const f = fixture()
    let calls = 0
    const selection = { ...f.selection, assertCurrent: () => {
      f.selection.assertCurrent()
      if (++calls === 2) f.database.run(
        `UPDATE function_conversation_rows SET ${field}=? WHERE conversation_id=? AND uuid=?`,
        [field === "bytes" || field === "sequence" || field === "created_at" ? 999 : "changed",
          f.target.conversationId, f.row.uuid])
    } }
    expect(() => readFunctionConversationProjectionReceipt(f.database, selection)).toThrow()
    expect(calls).toBe(2)
  })

  it.each([false, true])("rejects same-length canonical text replacement, digest repaired=%s", repair => {
    const f = fixture()
    let calls = 0
    const selection = { ...f.selection, assertCurrent: () => {
      f.selection.assertCurrent()
      if (++calls !== 2) return
      const raw = String(f.database.exec(`SELECT payload_json FROM function_conversation_rows
        WHERE conversation_id=? AND uuid=?`, [f.target.conversationId, f.row.uuid])[0].values[0][0])
      const changed = raw.replace("Actual", "Forged")
      expect(changed).not.toBe(raw)
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(raw))
      f.database.run(`UPDATE function_conversation_rows SET payload_json=?
        ${repair ? ",payload_digest=?" : ""} WHERE conversation_id=? AND uuid=?`,
      [changed, ...(repair ? [createHash("sha256").update(changed).digest("hex")] : []),
        f.target.conversationId, f.row.uuid])
    } }
    expect(() => readFunctionConversationProjectionReceipt(f.database, selection)).toThrow()
    expect(calls).toBe(2)
  })

  it("keeps guard reentry and caller row mutation outside the internal pin", () => {
    const f = fixture()
    let calls = 0
    const selection = { ...f.selection, row: { ...structuredClone(f.row) }, assertCurrent: () => {
      f.selection.assertCurrent()
      if (++calls === 2) {
        expect(readFunctionConversationProjectionReceipt(f.database, f.selection).message_id)
          .toBe(f.row.uuid)
        selection.row.nativePayload += "changed"
      }
    } }
    expect(readFunctionConversationProjectionReceipt(f.database, selection).message_id).toBe(f.row.uuid)
    expect(calls).toBe(3)
    expect(() => readFunctionConversationProjectionReceipt(f.database, selection)).toThrow()
  })

  it("does not reuse a prior pin after canonical tampering is rolled back", () => {
    const f = fixture()
    readFunctionConversationProjectionReceipt(f.database, f.selection)
    f.database.run("BEGIN")
    try {
      f.database.run(`UPDATE function_conversation_rows SET payload_digest='tampered'
        WHERE conversation_id=? AND uuid=?`, [f.target.conversationId, f.row.uuid])
      expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection)).toThrow()
    } finally { f.database.run("ROLLBACK") }
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection).message_id).toBe(f.row.uuid)
  })

  it.each([false, true])("rejects canonical deletion after warming readers, reinsert=%s", reinsert => {
    const f = fixture()
    readFunctionConversationProjectionReceipt(f.database, f.selection)
    const snapshot = f.database.exec(`SELECT * FROM function_conversation_rows
      WHERE conversation_id=? AND uuid=?`, [f.target.conversationId, f.row.uuid])[0]
    let calls = 0
    f.database.run("BEGIN")
    try {
      const selection = { ...f.selection, assertCurrent: () => {
        f.selection.assertCurrent()
        if (++calls !== 2) return
        f.database.run(`DELETE FROM function_conversation_rows WHERE conversation_id=? AND uuid=?`,
          [f.target.conversationId, f.row.uuid])
        if (reinsert) {
          const values = [...snapshot.values[0]]
          values[snapshot.columns.indexOf("receipt_id")] = randomUUID()
          f.database.run(`INSERT INTO function_conversation_rows (${snapshot.columns.join(",")})
            VALUES (${snapshot.columns.map(() => "?").join(",")})`, values)
        }
      } }
      expect(() => readFunctionConversationProjectionReceipt(f.database, selection)).toThrow()
      expect(calls).toBe(2)
    } finally { f.database.run("ROLLBACK") }
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection).message_id).toBe(f.row.uuid)
  })

  it("reads fresh receipts after a warmed table is dropped, recreated and restored", () => {
    const f = fixture()
    readFunctionConversationProjectionReceipt(f.database, f.selection)
    const schema = String(f.database.exec(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='function_conversation_projection_receipts'`)[0].values[0][0])
    f.database.run("BEGIN")
    try {
      f.database.run(`CREATE TEMP TABLE receipt_lifecycle_backup AS
        SELECT * FROM function_conversation_projection_receipts`)
      f.database.run("DROP TABLE function_conversation_projection_receipts")
      expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection))
        .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
      f.database.run(schema)
      expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection))
        .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
      f.database.run(`INSERT INTO function_conversation_projection_receipts
        SELECT * FROM receipt_lifecycle_backup`)
      expect(readFunctionConversationProjectionReceipt(f.database, f.selection).message_id).toBe(f.row.uuid)
    } finally { f.database.run("ROLLBACK") }
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection).message_id).toBe(f.row.uuid)
  })

  it("records all current raw columns with keeper and projection in one committed app transaction", () => {
    const f = fixture("long note ".repeat(15000), true)
    const receipt = readFunctionConversationProjectionReceipt(f.database, f.selection)
    expect(Object.keys(receipt)).toEqual([...FUNCTION_CONVERSATION_PROJECTION_COLUMNS])
    expect(receipt.stream_authority).toBe(1)
    expect(receipt).toEqual(readFunctionConversationRawProjection(f.database, f.threadId, f.row.uuid))
    expect(JSON.stringify(receipt.content_json).length).toBeLessThan(f.row.nativePayload.length)
    expect(f.database.inTransaction).toBe(false)
    expect(f.commit().receiptId).toBe(f.row.receiptId)
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_projection_receipts
      WHERE thread_id=?`, [f.threadId])[0].values[0][0]).toBe(1)
  })

  it.each(["content_json", "stream_authority", "ordinal", "prompt_origin_json", "provider_occurrence"])(
    "rejects changed actual raw %s without replacing the receipt", field => {
      const f = fixture()
      const before = f.database.exec(`SELECT * FROM function_conversation_projection_receipts
        WHERE thread_id=?`, [f.threadId])
      const value = field === "content_json" ? JSON.stringify("tampered") :
        field === "prompt_origin_json" ? JSON.stringify({ forged: true }) : 7
      f.database.run(`UPDATE thread_messages SET ${field}=? WHERE thread_id=? AND message_id=?`,
        [value, f.threadId, f.row.uuid])
      expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection)).toThrow()
      expect(() => f.access.verify(f.database, f.target, f.row)).toThrow()
      expect(f.database.exec(`SELECT * FROM function_conversation_projection_receipts
        WHERE thread_id=?`, [f.threadId])).toEqual(before)
    }
  )

  it("does not recertify an existing projection whose original receipt is missing", () => {
    const f = fixture()
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?", [f.threadId])
    expect(() => f.commit()).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_projection_receipts
      WHERE thread_id=?`, [f.threadId])[0].values[0][0]).toBe(0)
  })

  it("requires the complete canonical row and native payload rather than stamp alone", () => {
    const f = fixture()
    for (const row of [{ ...f.row, receiptId: randomUUID() },
      { ...f.row, nativePayload: `${f.row.nativePayload} ` },
      { ...f.row, origin: { kind: "plugin", name: "another-source" } }])
      expect(() => readFunctionConversationProjectionReceipt(f.database,
        { ...f.selection, row })).toThrow()
  })

  it("rejects a residual stream fragment and a same-ID recreated thread", () => {
    const f = fixture()
    f.database.run(`INSERT INTO thread_message_fragments
      (thread_id,message_id,content_text,created_at) VALUES (?,?,?,?)`,
    [f.threadId, f.row.uuid, "late raw echo", 100])
    expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection)).toThrow()
    f.database.run("DELETE FROM thread_message_fragments WHERE thread_id=?", [f.threadId])
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.threadId])
    expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection)).toThrow()
  })

  it("rejects an orphan fragment state rather than certifying it as a canonical final projection", () => {
    const f = fixture()
    f.database.run(`INSERT INTO thread_message_fragment_states
      (thread_id,message_id,total_chars,updated_at) VALUES (?,?,?,?)`,
    [f.threadId, f.row.uuid, 0, 100])
    expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection)).toThrow()
    expect(() => f.access.verify(f.database, f.target, f.row)).toThrow()
    expect(() => f.commit()).toThrow()
  })

  it("preserves the actual source guard error and never treats it as a migration fallback", () => {
    const f = fixture(), error = new Error("ACTUAL_SOURCE_RETIRED")
    expect(() => readFunctionConversationProjectionReceipt(f.database,
      { ...f.selection, assertCurrent: () => { throw error } })).toThrow(error)
  })

  it("cannot record outside the original app transaction", () => {
    const f = fixture()
    expect(() => recordFunctionConversationProjectionReceipt(f.database, f.selection))
      .toThrow("MODS_CONVERSATION_NOT_COMMITTED")
  })

  it("uses the committed receipt after a real COMMIT acknowledgement is lost without repeating writes", () => {
    const run = appDb.getDb().run.bind(appDb.getDb())
    let lost = false
    const f = fixture("Actual lost ACK note", false, () => {
      vi.spyOn(appDb.getDb(), "run").mockImplementation((sql, args = []) => {
        const result = run(sql, args)
        if (sql === "COMMIT" && !lost) { lost = true; throw Error("LOST_COMMIT_ACK") }
        return result
      })
    })
    expect(lost).toBe(true)
    expect(f.database.inTransaction).toBe(false)
    expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection)).not.toThrow()
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_projection_receipts
      WHERE thread_id=?`, [f.threadId])[0].values[0][0]).toBe(1)
  })

  it("refuses an unknown future raw storage column instead of silently omitting it", () => {
    const f = fixture()
    f.database.run("ALTER TABLE thread_messages ADD COLUMN receipt_future_column TEXT")
    try {
      expect(() => readFunctionConversationProjectionReceipt(f.database, f.selection))
        .toThrow("MODS_CONVERSATION_PROJECTION_SCHEMA")
    } finally { f.database.run("ALTER TABLE thread_messages DROP COLUMN receipt_future_column") }
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection).message_id).toBe(f.row.uuid)
  })
})
