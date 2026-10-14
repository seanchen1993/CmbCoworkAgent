import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { captureThreadIncarnation } from "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore, type FunctionConversationRow } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { captureFunctionConversationForkTranscriptAccess,
  captureFunctionConversationForkVisibleSource, assertFunctionConversationForkTranscriptDataTail } from
  "./function-conversation-fork-transcript"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationProjectionReceipt,
  readFunctionConversationRawProjection } from
  "./function-conversation-projection-receipt"
import * as projectionReceipts from "./function-conversation-projection-receipt"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import { recordFunctionConversationPresentationDisposition,
  readFunctionConversationPresentationDisposition } from "./function-conversation-presentation-disposition"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-fork-raw-transcript-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const database = appDb.getDb(), store = new FunctionConversationStore(database)
  const sourceId = randomUUID(), targetId = randomUUID()
  const sourceInc = captureThreadIncarnation(appDb.createThread(sourceId, { workspacePath: directory }))
  const targetInc = captureThreadIncarnation(appDb.createThread(targetId, { workspacePath: directory }))
  const ref = (threadId: string, incarnation: typeof sourceInc) => store.ensureMain({ threadId,
    incarnation, workspace: directory, checkpointNamespace: "" }, () => {})
  const source = ref(sourceId, sourceInc), target = ref(targetId, targetInc)
  let alive = true
  let sourceEffect: (() => void) | undefined
  const sourceGuard = () => {
    if (!alive) throw Error("ACTUAL_SOURCE_RETIRED")
    sourceEffect?.()
    store.assertCurrent(source)
  }
  const targetGuard = () => store.assertCurrent(target)
  const access = captureFunctionConversationForkTranscriptAccess({
    source: { threadId: sourceId, incarnation: sourceInc, assertCurrent: sourceGuard },
    target: { threadId: targetId, incarnation: targetInc, assertCurrent: targetGuard }
  })
  const transact = <T>(work: () => T): T => {
    database.run("BEGIN IMMEDIATE")
    try { const result = work(); database.run("COMMIT"); return result }
    catch (error) { database.run("ROLLBACK"); throw error }
  }
  const keep = (text: string, tool = false, disposition?: "persisted" | "blank" | "plumbing") => {
    const uuid = randomUUID(), content = [{ type: "text" as const, text }]
    const native = tool ? new ToolMessage({ id: uuid, content: text, tool_call_id: "actual-tool-call",
      name: "actual-tool", status: "success", artifact: { full: "actual artifact" } }) :
      new HumanMessage({ id: uuid, content,
        additional_kwargs: disposition === undefined ? { isMeta: true } : {} })
    const hidden = disposition === "blank" || disposition === "plumbing"
    const projection = createFunctionConversationTranscriptAccess((_ref, row) => ({ id: row.uuid,
      role: tool ? "tool" : "user", content: hidden ? "" : tool ? text : content,
      ...(tool ? { tool_call_id: "actual-tool-call", name: "actual-tool", status: "success" } : {}),
      ...(hidden ? { recovery_integrity: "unverified" as const } : {}),
      content_mode: "snapshot", created_at: new Date(row.createdAt)
    }), undefined, ToolMessage.isInstance(native) ? native : undefined)
    const selection = (row: FunctionConversationRow) => ({ target: source, row, threadId: sourceId,
      incarnation: sourceInc, assertCurrent: sourceGuard })
    const columns = () => {
      const actual = readFunctionConversationRawProjection(database, sourceId, uuid)
      if (!actual) throw Error("ACTUAL_PROMPT_PROJECTION_REQUIRED")
      return actual
    }
    return store.commit(source, { uuid, inputDigest: uuid,
      door: disposition === undefined ? tool ? "tool-result" : "note" : "prompt",
      origin: disposition !== undefined ? { kind: "composer" } :
        tool ? { kind: "tool", tool: "actual-tool" } : { kind: "plugin", name: "raw-fork" },
      message: tool ? { type: "user", role: "user", content: [{ type: "tool_result",
        tool_use_id: "actual-tool-call", content: text }] } :
        { type: "user", role: "user", ...(disposition === undefined ? { isMeta: true } : {}), content },
      nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: { native: uuid,
        ...(disposition === undefined ? {} : { presentation: { version: 1, disposition,
          intentDigest: "d".repeat(64) } }) },
      sdk: !tool && disposition === undefined, inbox: !tool && disposition === undefined }, sourceGuard,
    (db, ref, row) => {
      projection.write(db, ref, row)
      if (disposition !== undefined)
        recordFunctionConversationPresentationDisposition(db, selection(row), columns())
    }, (db, ref, row) => {
      projection.verify(db, ref, row)
      if (disposition !== undefined)
        readFunctionConversationPresentationDisposition(db, selection(row), columns())
    })
  }
  const copied = (original: FunctionConversationRow): FunctionConversationRow => Object.freeze({
    ...original, branchId: target.branchId, receiptId: randomUUID()
  })
  const insertCanonical = (row: FunctionConversationRow) => {
    const payload = JSON.stringify({ origin: row.origin, message: row.message,
      nativePayload: row.nativePayload, orderAnchor: row.orderAnchor, inbox: row.inbox })
    database.run("INSERT INTO function_conversation_rows VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [target.conversationId, row.uuid, row.branchId, row.sequence, row.receiptId, row.inputDigest,
        createHash("sha256").update(payload).digest("hex"), payload, row.door, row.createdAt,
        Buffer.byteLength(payload)])
    database.run("UPDATE function_conversations SET next_sequence=? WHERE conversation_id=?",
      [row.sequence + 1, target.conversationId])
  }
  const copy = (row: FunctionConversationRow) => {
    const result = copied(row)
    transact(() => { insertCanonical(result); access.writeCanonical(database, source, row, target, result) })
    return result
  }
  return { database, store, sourceId, targetId, sourceInc, targetInc, source, target, access,
    transact, keep, copy, copied, insertCanonical, retire: () => { alive = false },
    setSourceEffect: (effect: () => void) => { sourceEffect = effect } }
}

describe("actual raw native fork transcript copy", () => {
  it("requires the genuine original access capability even for an empty native data tail", () => {
    const f = fixture(), tail = f.access.dataTail
    expect(() => assertFunctionConversationForkTranscriptDataTail(tail, f.database, [],
      { source: f.sourceId, target: f.targetId })).not.toThrow()
    expect(() => assertFunctionConversationForkTranscriptDataTail(Object.assign({}, tail),
      f.database, [])).toThrow()
    expect(() => assertFunctionConversationForkTranscriptDataTail(tail, f.database, [],
      { source: f.targetId, target: f.sourceId })).toThrow()
  })

  it("rejects an earlier ledger changed by a later row guard after both real adapters verified", () => {
    const f = fixture(), first = f.keep("first full prompt", false, "blank")
    const second = f.keep("second full prompt", false, "blank")
    const a = f.copy(first), b = f.copy(second)
    f.access.verifyCanonical(f.database, f.source, first, f.target, a)
    let changes = 0
    f.setSourceEffect(() => {
      if (changes++) return
      f.database.run(`UPDATE function_conversation_presentation_dispositions SET disposition='plumbing'
        WHERE thread_id=? AND uuid=?`, [f.targetId, a.uuid])
    })
    expect(() => f.access.verifyCanonical(f.database, f.source, second, f.target, b)).not.toThrow()
    f.setSourceEffect(() => {})
    const guards = vi.fn(() => { throw Error("DATA_TAIL_MUST_NOT_RUN_SOURCE_CALLBACK") })
    f.setSourceEffect(guards)
    expect(() => assertFunctionConversationForkTranscriptDataTail(f.access.dataTail, f.database,
      [{ uuid: a.uuid, branchId: a.branchId }, { uuid: b.uuid, branchId: b.branchId }])).toThrow()
    expect(guards).not.toHaveBeenCalled()
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(2)
  })

  it("cannot refresh a genuine ordinary first observation after matching source/target rewrites", () => {
    const f = fixture(), uuid = randomUUID(), selector = { messageId: uuid, role: "assistant" as const }
    appDb.upsertThreadMessages(f.sourceId, [{ id: uuid, role: "assistant", content: "first",
      created_at: new Date(1) }])
    f.transact(() => f.access.copyPersistedVisible(f.database, selector))
    expect(() => assertFunctionConversationForkTranscriptDataTail(f.access.dataTail, f.database,
      [{ uuid }])).not.toThrow()
    f.database.run("UPDATE thread_messages SET content_json=? WHERE message_id=?",
      [JSON.stringify("changed same bytes in both rows"), uuid])
    expect(() => f.access.verifyPersistedVisible(f.database, selector)).toThrow()
    expect(() => assertFunctionConversationForkTranscriptDataTail(f.access.dataTail, f.database,
      [{ uuid }])).toThrow()
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(1)
  })

  it("checks original ordinary fragment/absence facts after a later canonical guard", () => {
    const f = fixture(), uuid = randomUUID(), provider = randomUUID()
    const selector = { messageId: uuid, role: "assistant" as const,
      providerSourceId: provider, providerOccurrence: 2 }
    appDb.upsertThreadMessages(f.sourceId, [{ id: uuid, role: "assistant", content: "ordinary base",
      provider_source_id: provider, provider_occurrence: 2,
      created_at: new Date(1) }])
    expect(appDb.appendThreadMessageTextDelta(f.sourceId, { id: uuid, role: "assistant",
      content: " delta", provider_source_id: provider, provider_occurrence: 2,
      created_at: new Date(2) })).toBe(true)
    expect(f.database.exec(`SELECT content_text FROM thread_message_fragments
      WHERE thread_id=? AND message_id=?`, [f.sourceId, uuid])[0].values).toEqual([[" delta"]])
    f.transact(() => f.access.copyPersistedVisible(f.database, selector))
    expect(f.database.exec(`SELECT content_text FROM thread_message_fragments
      WHERE thread_id=? AND message_id=?`, [f.targetId, uuid])[0].values).toEqual([[" delta"]])
    const original = f.keep("later canonical", false, "blank"), copied = f.copy(original)
    f.access.verifyPersistedVisible(f.database, selector)
    let changed = false
    f.setSourceEffect(() => {
      if (changed) return
      changed = true
      f.database.run("UPDATE thread_message_fragments SET content_text='changed fragment' WHERE thread_id=? AND message_id=?",
        [f.targetId, uuid])
    })
    expect(() => f.access.verifyCanonical(f.database, f.source, original, f.target, copied)).not.toThrow()
    expect(changed).toBe(true)
    expect(f.database.exec(`SELECT content_text FROM thread_message_fragments
      WHERE thread_id=? AND message_id=?`, [f.targetId, uuid])[0].values)
      .toEqual([["changed fragment"]])
    f.setSourceEffect(() => {})
    expect(() => assertFunctionConversationForkTranscriptDataTail(f.access.dataTail, f.database,
      [{ uuid }, { uuid: copied.uuid, branchId: copied.branchId }])).toThrow()
  })

  it.each(["persisted", "blank", "plumbing"] as const)(
    "recalculates the target %s ledger from its new actual ref and primary receipt", disposition => {
      const f = fixture(), original = f.keep("full native input remains intact", false, disposition)
      const sourceLedger = f.database.exec(`SELECT * FROM function_conversation_presentation_dispositions
        WHERE thread_id=? AND uuid=?`, [f.sourceId, original.uuid])[0]
      const copied = f.copy(original)
      const values = readFunctionConversationRawProjection(f.database, f.targetId, copied.uuid)
      if (!values) throw Error("ACTUAL_TARGET_COLUMNS_REQUIRED")
      const result = readFunctionConversationPresentationDisposition(f.database, {
        target: f.target, row: copied, threadId: f.targetId, incarnation: f.targetInc,
        assertCurrent: () => f.store.assertCurrent(f.target) }, values)
      expect(result.kind).toBe(disposition === "persisted" ? "visible" : disposition)
      expect(copied.nativePayload).toBe(original.nativePayload)
      expect(copied.orderAnchor).toEqual(original.orderAnchor)
      expect(copied.receiptId).not.toBe(original.receiptId)
      const targetLedger = f.database.exec(`SELECT target_json,canonical_receipt_id,projection_digest
        FROM function_conversation_presentation_dispositions WHERE thread_id=? AND uuid=?`,
      [f.targetId, copied.uuid])[0].values[0]
      expect(targetLedger[0]).toContain(f.target.conversationId)
      expect(targetLedger[1]).toBe(copied.receiptId)
      expect(f.database.exec(`SELECT * FROM function_conversation_presentation_dispositions
        WHERE thread_id=? AND uuid=?`, [f.sourceId, original.uuid])[0]).toEqual(sourceLedger)
      expect(() => f.access.verifyCanonical(f.database, f.source, original, f.target, copied)).not.toThrow()
    }
  )

  it.each(["missing", "altered"] as const)("rejects a %s source ledger before any target copy", change => {
    const f = fixture(), original = f.keep("complete prompt", false, "blank")
    if (change === "missing") f.database.run(`DELETE FROM function_conversation_presentation_dispositions
      WHERE thread_id=? AND uuid=?`, [f.sourceId, original.uuid])
    else f.database.run(`UPDATE function_conversation_presentation_dispositions
      SET disposition='plumbing' WHERE thread_id=? AND uuid=?`, [f.sourceId, original.uuid])
    expect(() => f.copy(original)).toThrow()
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(0)
    expect(f.store.readReceipt(f.target, original.uuid)).toBeUndefined()
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_presentation_dispositions
      WHERE thread_id=?`, [f.targetId])[0].values).toEqual([[0]])
  })

  it("never repairs an existing target's removed ledger during replay", () => {
    const f = fixture(), original = f.keep("native prompt", false, "blank"), copied = f.copy(original)
    f.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=?",
      [f.targetId])
    expect(() => f.transact(() => f.access.writeCanonical(f.database, f.source, original, f.target, copied)))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(() => f.access.verifyCanonical(f.database, f.source, original, f.target, copied))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_presentation_dispositions
      WHERE thread_id=?`, [f.targetId])[0].values).toEqual([[0]])
  })

  it("rechecks the original source ledger after a synchronous native guard changes it", () => {
    const f = fixture(), original = f.keep("native prompt", false, "blank"), copied = f.copy(original)
    const readReceipt = projectionReceipts.readFunctionConversationProjectionReceipt
    let changed = false, targetRead = false
    vi.spyOn(projectionReceipts, "readFunctionConversationProjectionReceipt")
      .mockImplementation((database, selection) => {
        const result = readReceipt(database, selection)
        if (selection.threadId === f.targetId) targetRead = true
        return result
      })
    f.setSourceEffect(() => {
      if (changed || !targetRead) return
      changed = true
      f.database.run(`UPDATE function_conversation_presentation_dispositions
        SET disposition='plumbing' WHERE thread_id=? AND uuid=?`, [f.sourceId, original.uuid])
    })
    expect(() => f.access.verifyCanonical(f.database, f.source, original, f.target, copied)).toThrow()
    expect(targetRead).toBe(true)
    expect(changed).toBe(true)
    expect(f.database.exec(`SELECT disposition FROM function_conversation_presentation_dispositions
      WHERE thread_id=? AND uuid=?`, [f.sourceId, original.uuid])[0].values).toEqual([["plumbing"]])
  })

  it("copies the exact long-note storage bytes and snapshot flags without normalizing a display reader", () => {
    const f = fixture(), original = f.keep("long native note ".repeat(15000))
    const source = readFunctionConversationRawProjection(f.database, f.sourceId, original.uuid)!
    const copied = f.copy(original)
    const target = readFunctionConversationProjectionReceipt(f.database, { target: f.target,
      row: copied, threadId: f.targetId, incarnation: f.targetInc, assertCurrent: () => {} })
    for (const column of FUNCTION_CONVERSATION_PROJECTION_COLUMNS)
      if (column !== "thread_id" && column !== "function_row_json")
        expect(target[column]).toBe(source[column])
    expect(target.stream_authority).toBe(1)
    expect(copied.nativePayload).toBe(original.nativePayload)
    expect(copied.receiptId).not.toBe(original.receiptId)
    expect(() => f.access.verifyCanonical(f.database, f.source, original, f.target, copied)).not.toThrow()
  })

  it("keeps actual ToolMessage routing, status and full native artifact", () => {
    const f = fixture(), original = f.keep("actual tool result", true), copied = f.copy(original)
    const raw = readFunctionConversationRawProjection(f.database, f.targetId, copied.uuid)!
    expect(raw.role).toBe("tool")
    expect(raw.tool_call_id).toBe("actual-tool-call")
    expect(raw.status).toBe("success")
    expect(copied.nativePayload).toContain("actual artifact")
    expect(() => f.access.verifyCanonical(f.database, f.source, original, f.target, copied)).not.toThrow()
  })

  it.each(["content_json", "stream_authority", "ordinal", "status"])(
    "rolls back the whole target copy when source %s no longer matches its actual receipt", field => {
      const f = fixture(), original = f.keep("actual tool result", true)
      const value = field === "content_json" ? JSON.stringify("changed") :
        field === "status" ? "error" : 6
      f.database.run(`UPDATE thread_messages SET ${field}=? WHERE thread_id=? AND message_id=?`,
        [value, f.sourceId, original.uuid])
      expect(() => f.copy(original)).toThrow()
      expect(f.store.readReceipt(f.target, original.uuid)).toBeUndefined()
      expect(appDb.getThreadMessageCount(f.targetId)).toBe(0)
    }
  )

  it("rejects a missing original projection receipt instead of certifying the current display", () => {
    const f = fixture(), original = f.keep("missing actual receipt")
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?", [f.sourceId])
    expect(() => f.copy(original)).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(0)
  })

  it("rejects a residual canonical fragment state even when no fragment body remains", () => {
    const f = fixture(), original = f.keep("actual retained state")
    f.database.run(`INSERT INTO thread_message_fragment_states
      (thread_id,message_id,total_chars,updated_at) VALUES (?,?,?,?)`,
    [f.sourceId, original.uuid, 0, 100])
    expect(() => f.copy(original)).toThrow()
    expect(f.store.readReceipt(f.target, original.uuid)).toBeUndefined()
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(0)
  })

  it("does not recertify an existing target whose receipt was removed", () => {
    const f = fixture(), original = f.keep("target receipt"), copied = f.copy(original)
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?", [f.targetId])
    expect(() => f.transact(() => f.access.writeCanonical(f.database, f.source, original, f.target, copied)))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_projection_receipts
      WHERE thread_id=?`, [f.targetId])[0].values[0][0]).toBe(0)
  })

  it("preserves source ordering when canonical is copied before both ordinary neighbours", () => {
    const f = fixture(), first = randomUUID(), last = randomUUID()
    appDb.upsertThreadMessages(f.sourceId, [{ id: first, role: "user", content: "first",
      created_at: new Date(1) }])
    const original = f.keep("hidden middle note")
    appDb.upsertThreadMessages(f.sourceId, [{ id: last, role: "assistant", content: "last",
      created_at: new Date(3) }],
      { preserveExistingOrder: true })
    f.copy(original)
    f.transact(() => {
      expect(f.access.copyPersistedVisible(f.database, { messageId: first, role: "user" })).toBe(true)
      expect(f.access.copyPersistedVisible(f.database, { messageId: last, role: "assistant" })).toBe(true)
    })
    const actual = f.database.exec(`SELECT message_id,ordinal FROM thread_messages
      WHERE thread_id=? ORDER BY ordinal`, [f.targetId])[0].values
    expect(actual.map(row => row[0])).toEqual([first, original.uuid, last])
    expect(actual.map(row => row[1])).toEqual([0, 1, 2])
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(3)
    expect(f.database.exec("SELECT next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [f.targetId])[0].values[0][0]).toBe(3)
  })

  it("copies actual ordinary stream fragments and state without flattening or losing flags", () => {
    const f = fixture(), id = randomUUID(), provider = randomUUID()
    appDb.upsertThreadMessages(f.sourceId, [{ id, role: "assistant", content: "base",
      provider_source_id: provider, provider_occurrence: 2, created_at: new Date(1) }])
    expect(appDb.appendThreadMessageTextDelta(f.sourceId, { id, role: "assistant",
      content: " appended delta", provider_source_id: provider, provider_occurrence: 2,
      created_at: new Date() })).toBe(true)
    f.transact(() => expect(f.access.copyPersistedVisible(f.database, { messageId: id,
      role: "assistant", providerSourceId: provider, providerOccurrence: 2 })).toBe(true))
    const source = readFunctionConversationRawProjection(f.database, f.sourceId, id)!
    const target = readFunctionConversationRawProjection(f.database, f.targetId, id)!
    expect(target).toEqual({ ...source, thread_id: f.targetId })
    expect(appDb.getThreadMessages(f.targetId)[0].content).toBe("base appended delta")
    f.transact(() => expect(f.access.copyPersistedVisible(f.database, { messageId: id,
      role: "assistant", providerSourceId: provider, providerOccurrence: 2 })).toBe(true))
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(1)
  })

  it("reads back a committed ordinary copy without rerunning a writer or accepting an open txn", () => {
    const f = fixture(), id = randomUUID(), provider = randomUUID()
    const selector = { messageId: id, role: "assistant" as const,
      providerSourceId: provider, providerOccurrence: 2 }
    appDb.upsertThreadMessages(f.sourceId, [{ id, role: "assistant", content: "actual original",
      provider_source_id: provider, provider_occurrence: 2, created_at: new Date(1) }])
    f.transact(() => f.access.copyPersistedVisible(f.database, selector))
    const run = vi.spyOn(f.database, "run")
    expect(() => f.access.verifyPersistedVisible(f.database, selector)).not.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(() => f.transact(() => f.access.verifyPersistedVisible(f.database, selector)))
      .toThrow("MODS_CONVERSATION_NOT_COMMITTED")
    expect(() => f.access.verifyPersistedVisible(f.database,
      { ...selector, providerOccurrence: 1 })).toThrow()
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("changed actual source"), f.sourceId, id])
    expect(() => f.access.verifyPersistedVisible(f.database, selector)).toThrow()
    expect(() => f.transact(() => f.access.copyPersistedVisible(f.database, selector))).toThrow()
  })

  it("preflights a real visible source before any target is created and preserves missing rows", () => {
    const threadId = randomUUID(), id = randomUUID(), provider = randomUUID()
    const incarnation = captureThreadIncarnation(appDb.createThread(threadId,
      { workspacePath: directory }))
    appDb.upsertThreadMessages(threadId, [{ id, role: "assistant", content: "actual base",
      provider_source_id: provider, provider_occurrence: 2, created_at: new Date(1) }])
    appDb.appendThreadMessageTextDelta(threadId, { id, role: "assistant", content: " actual tail",
      provider_source_id: provider, provider_occurrence: 2, created_at: new Date() })
    const source = captureFunctionConversationForkVisibleSource({
      source: { threadId, incarnation, assertCurrent: () => {} },
      canonicalMessageId: messageId => appDb.getThreadMessageCanonicalId(threadId, messageId)
    })
    const selector = { messageId: id, role: "assistant" as const,
      providerSourceId: provider, providerOccurrence: 2 }
    const run = vi.spyOn(appDb.getDb(), "run")
    expect(source.preflightVisible(selector)).toBe(true)
    expect(source.preflightVisible({ messageId: randomUUID(), role: "user" })).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(() => source.preflightVisible({ ...selector, role: "user" })).toThrow()
    expect(() => source.preflightVisible({ ...selector, providerOccurrence: 1 })).toThrow()
    appDb.getDb().run("UPDATE thread_message_fragment_states SET total_chars=-1 WHERE thread_id=?",
      [threadId])
    expect(() => source.preflightVisible(selector)).toThrow()
  })

  it("never borrows an alias or downgrades malformed marked source data during preflight", () => {
    const f = fixture(), original = f.keep("actual marked preflight")
    const nativeSource = { threadId: f.sourceId, incarnation: f.sourceInc, assertCurrent: () => {} }
    const source = captureFunctionConversationForkVisibleSource({ source: nativeSource,
      canonicalMessageId: id => appDb.getThreadMessageCanonicalId(f.sourceId, id) })
    expect(source.preflightVisible({ messageId: original.uuid, role: "user" })).toBe(true)
    const alias = captureFunctionConversationForkVisibleSource({ source: nativeSource,
      canonicalMessageId: () => randomUUID() })
    expect(() => alias.preflightVisible({ messageId: original.uuid, role: "user" })).toThrow()
    f.database.run("UPDATE thread_messages SET function_row_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify({ uuid: original.uuid }), f.sourceId, original.uuid])
    expect(() => source.preflightVisible({ messageId: original.uuid, role: "user" })).toThrow()
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(0)
  })

  it("uses genuine missing rows only, and never downgrades marked, role or provider conflicts", () => {
    const f = fixture(), original = f.keep("marked"), id = randomUUID()
    appDb.upsertThreadMessages(f.sourceId, [{ id, role: "user", content: "ordinary",
      provider_source_id: "actual-provider", provider_occurrence: 2, created_at: new Date(1) }])
    f.transact(() => expect(f.access.copyPersistedVisible(f.database,
      { messageId: randomUUID(), role: "assistant" })).toBe(false))
    for (const selector of [{ messageId: original.uuid, role: "user" as const },
      { messageId: id, role: "assistant" as const },
      { messageId: id, role: "user" as const, providerSourceId: "wrong-provider" },
      { messageId: id, role: "user" as const, providerOccurrence: 1 }])
      expect(() => f.transact(() => f.access.copyPersistedVisible(f.database, selector))).toThrow()
    expect(appDb.getThreadMessageCount(f.targetId)).toBe(0)
  })

  it("rejects another actual DB, a retired source and target same-ID ABA", () => {
    const f = fixture(), original = f.keep("guarded"), copied = f.copied(original)
    const other = openNativeSqliteDatabase(join(directory, `${randomUUID()}.sqlite`)).database
    try {
      expect(() => f.access.writeCanonical(other, f.source, original, f.target, copied)).toThrow()
    } finally { other.close() }
    f.retire()
    expect(() => f.copy(original)).toThrow("ACTUAL_SOURCE_RETIRED")
    const second = fixture(), row = second.keep("target ABA")
    second.database.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), second.targetId])
    expect(() => second.copy(row)).toThrow()
  })
})
