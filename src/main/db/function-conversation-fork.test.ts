import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { FunctionConversationDeliveryBridge } from "../checkpointer/function-conversation-delivery"
import { captureCommittedConversationMembership, captureConversationCheckpointRead,
  functionConversationCanonicalStamp, functionConversationMembershipDigest,
  type FunctionConversationCheckpointMembershipProof } from "../checkpointer/function-conversation-checkpoint-membership"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationStore, type FunctionConversationRef,
  type FunctionConversationRow, type FunctionConversationTranscriptWriter } from "./function-conversation-store"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import { abortForkImport, assertFunctionConversationForkReady, beginForkImportInTransaction,
  copyForkImportPage, finishForkImport, prepareForkImport, readForkImportRow, readForkImportView,
  quarantineForkImport, recordForkImportCheckpoint, resumeForkImport,
  clearForkImportJournalInTransaction,
  type FunctionConversationForkPlan } from "./function-conversation-fork"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-canonical-fork-"))
  const path = join(directory, "app.sqlite")
  let db = openNativeSqliteDatabase(path).database
  db.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  db.run("CREATE TABLE projection (thread_id TEXT,uuid TEXT,payload TEXT,PRIMARY KEY(thread_id,uuid))")
  const sourceIncarnation = { token: randomUUID(), legacyCreatedAt: 1000 }
  db.run("INSERT INTO threads VALUES (?,?,?)", ["source", 1000,
    JSON.stringify({ cmb_thread_incarnation: sourceIncarnation.token })])
  let store = new FunctionConversationStore(db)
  const target = store.ensureMain({ threadId: "source", workspace: directory,
    incarnation: sourceIncarnation, checkpointNamespace: "" }, () => undefined)
  const sourceController = new AbortController(), targetController = new AbortController()
  const sourceGuard = () => sourceController.signal.throwIfAborted()
  const targetGuard = () => targetController.signal.throwIfAborted()
  const sourceSaver = new SqlJsSaver(join(directory, "source.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const targetSaver = new SqlJsSaver(join(directory, "target.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const bridge = new FunctionConversationDeliveryBridge(store, () => ({ target,
    checkpointThreadId: "source", signal: sourceController.signal, assertCurrent: sourceGuard }))
  const sourceCheckpoint = bridge.wrap(sourceSaver)
  const write: FunctionConversationTranscriptWriter = (actual, ref, row) => {
    expect(Object.is(actual, db) && actual.inTransaction).toBe(true)
    actual.run("INSERT INTO projection VALUES (?,?,?)", [ref.threadId, row.uuid, JSON.stringify(row)])
  }
  const verify: FunctionConversationTranscriptWriter = (actual, ref, row) => {
    const raw = actual.exec("SELECT payload FROM projection WHERE thread_id=? AND uuid=?", [ref.threadId, row.uuid])[0]
    if (raw?.values.length !== 1 || raw.values[0][0] !== JSON.stringify(row)) throw Error("PROJECTION_MISMATCH")
  }
  const keep = (native: BaseMessage, options: {
    inbox?: boolean; target?: FunctionConversationRef; toolSystem?: boolean
  } = {}) => {
    if (!native.id) throw Error("Actual UUID required")
    const tool = ToolMessage.isInstance(native), system = native.getType() === "system"
    return store.commit(options.target ?? target, { uuid: native.id, inputDigest: native.id,
      door: options.inbox ? "note" : tool ? "tool-result" : system
        ? options.toolSystem ? "tool-message" : "notice" : "response",
      origin: options.toolSystem ? { kind: "tool", tool: "ActualTool" } : { kind: "engine" },
      message: system ? { type: "system", content: [{ type: "text", text: "display" }] }
        : tool ? { type: "user", role: "user", content: [{ type: "tool_result",
          tool_use_id: native.tool_call_id, content: "display" }] }
          : { type: options.inbox ? "user" : "assistant", ...(options.inbox ? { role: "user", isMeta: true } : {}),
            content: [{ type: "text", text: "display" }] },
      nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: { batch: native.id },
      inbox: options.inbox === true, sdk: false }, sourceGuard, write, verify)
  }
  const note = (text: string) => keep(new HumanMessage({ id: randomUUID(), content: text,
    additional_kwargs: { isMeta: true } }), { inbox: true })
  const native = (row: FunctionConversationRow, ref = target) => {
    const message = deserializeFunctionConversationNativeMessage(row.nativePayload)
    message.additional_kwargs = { ...message.additional_kwargs, function_row: functionConversationCanonicalStamp(ref, row) }
    return message
  }
  const checkpoint = (ref: FunctionConversationRef, frontier: number, messages: BaseMessage[]): Checkpoint => ({
    v: 1, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages, todos: [{ text: "native other channel" }], cmbFunctionConversation: {
      version: 1, logicalSessionId: ref.logicalSessionId, conversationId: ref.conversationId,
      branchId: ref.branchId, frontier } },
    channel_versions: { messages: 1, cmbFunctionConversation: 1 }, versions_seen: {}
  })
  const saveSource = async (frontier: number, kept: FunctionConversationRow[]) => {
    const cp = checkpoint(target, frontier, kept.map(row => native(row)))
    const config = await sourceCheckpoint.put({ configurable: { thread_id: "source", checkpoint_ns: "" } }, cp, metadata)
    const cut = store.readCheckpointCanonicalCut(target, { checkpointThreadId: "source",
      checkpointIncarnation: sourceIncarnation, checkpointId: cp.id }, sourceGuard)
    if (!cut) throw Error("Actual persisted cut required")
    const source = await captureConversationCheckpointRead(store, sourceSaver, config, () => ({ target,
      checkpointThreadId: "source", checkpointIncarnation: sourceIncarnation, cut, frontier,
      stateDigest: functionConversationMembershipDigest(cp.channel_values.cmbFunctionConversation), assertCurrent: sourceGuard }), sourceGuard)
    if (!source.proof) throw Error("Native read proof required")
    return { proof: source.proof, tuple: source.tuple }
  }
  const begin = (membership: FunctionConversationCheckpointMembershipProof) => {
    const plan = prepareForkImport(store, { sources: [{ target, membership }], selectedSourceIndex: 0,
      assertSource: sourceGuard })
    const incarnation = { token: randomUUID(), legacyCreatedAt: 2000 }
    const input = { threadId: "fork", workspace: directory, incarnation, checkpointNamespace: "" }
    db.run("BEGIN IMMEDIATE")
    try {
      db.run("INSERT INTO threads VALUES (?,?,?)", [input.threadId, 2000,
        JSON.stringify({ cmb_thread_incarnation: incarnation.token })])
      beginForkImportInTransaction(plan, input, targetGuard)
      db.run("COMMIT")
    } catch (error) { db.run("ROLLBACK"); throw error }
    return { plan, input }
  }
  const copy = (plan: FunctionConversationForkPlan) => {
    for (;;) { if (copyForkImportPage(plan, write, verify).complete) return }
  }
  const saveTarget = async (plan: FunctionConversationForkPlan, original: Checkpoint,
    complete = true) => {
    const view = readForkImportView(plan), entry = view.entries[0]
    const messages = (original.channel_values.messages as BaseMessage[]).map(message => {
      if (!message.id) throw Error("Actual marked UUID required")
      return native(readForkImportRow(plan, 0, message.id), entry.target)
    })
    const cp: Checkpoint = { ...original, channel_values: { ...original.channel_values, messages,
      cmbFunctionConversation: { version: 1, logicalSessionId: entry.target.logicalSessionId,
        conversationId: entry.target.conversationId, branchId: entry.target.branchId, frontier: entry.frontier } } }
    await targetSaver.putWithCommitObserver({ configurable: { thread_id: "fork", checkpoint_ns: "" } }, cp,
      metadata, receipt => {
        const proof = captureCommittedConversationMembership(store, targetSaver, receipt, { target: entry.target,
          checkpointThreadId: "fork", checkpointIncarnation: view.target.incarnation, cut: entry.canonicalCut,
          frontier: entry.frontier, stateDigest: functionConversationMembershipDigest(cp.channel_values.cmbFunctionConversation),
          assertCurrent: targetGuard })
        recordForkImportCheckpoint(plan, 0, proof)
        if (complete) finishForkImport(plan, proof)
      })
    return cp
  }
  cleanups.push(async () => {
    sourceController.abort(); targetController.abort()
    await sourceSaver.close(); await targetSaver.close()
    db.close(); rmSync(directory, { recursive: true, force: true })
  })
  return { directory, path, get db() { return db }, get store() { return store }, target, sourceIncarnation,
    sourceSaver, targetSaver, sourceController, targetController, sourceGuard, keep, note, native,
    saveSource, begin, copy, saveTarget, write, verify,
    reopen() { db.close(); db = openNativeSqliteDatabase(path).database; store = new FunctionConversationStore(db) } }
}

describe("conversation-aware fork journal actual SQLite and native Saver", () => {
  it("keeps the exact fork journal while its retired target still has a presentation ledger", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    const values = [input.threadId, JSON.stringify(["token", input.incarnation.token]), randomUUID(),
      "{}", "actual-retired-receipt", "a".repeat(64), "b".repeat(64), "c".repeat(64),
      "d".repeat(64), "e".repeat(64), "blank", 1]
    f.db.run("BEGIN")
    f.db.run(`INSERT INTO function_conversation_presentation_dispositions
      VALUES (${values.map(() => "?").join(",")})`, values)
    f.db.run("DELETE FROM threads WHERE thread_id=?", [input.threadId])
    f.db.run("DELETE FROM function_logical_sessions WHERE thread_id=?", [input.threadId])
    expect(() => clearForkImportJournalInTransaction(plan, () => undefined)).toThrow(
      "MODS_CONVERSATION_FORK_PROOF")
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_fork_imports")[0].values).toEqual([[1]])
    f.db.run("ROLLBACK")
  })

  it("rechecks target ledger absence after the original files-retired guard", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    f.db.run("BEGIN")
    f.db.run("DELETE FROM threads WHERE thread_id=?", [input.threadId])
    f.db.run("DELETE FROM function_logical_sessions WHERE thread_id=?", [input.threadId])
    let guards = 0
    expect(() => clearForkImportJournalInTransaction(plan, () => {
      if (++guards !== 2) return
      f.db.run(`INSERT INTO function_conversation_presentation_dispositions VALUES
        (?,?,?,?,?,?,?,?,?,?,?,?)`, [input.threadId, JSON.stringify(["token", input.incarnation.token]),
        randomUUID(), "{}", "actual-retired-receipt", "a".repeat(64), "b".repeat(64),
        "c".repeat(64), "d".repeat(64), "e".repeat(64), "blank", 1])
    })).toThrow("MODS_CONVERSATION_FORK_PROOF")
    expect(guards).toBe(2)
    f.db.run("ROLLBACK")
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_fork_imports")[0].values).toEqual([[1]])
  })

  it("copies exact members and compacted consumed notes, excluding pending and preserving sequence gaps", async () => {
    const f = await fixture(), consumed = f.note("already consumed"), pending = f.note("future")
    const assistant = f.keep(new AIMessage({ id: randomUUID(), content: "full assistant",
      tool_calls: [{ id: "call", name: "tool", args: { actual: true } }] }))
    const tool = f.keep(new ToolMessage({ id: randomUUID(), content: "full tool", tool_call_id: "call",
      status: "error", artifact: { full: "artifact" } }))
    const source = await f.saveSource(consumed.sequence, [assistant, tool])
    const { plan, input } = f.begin(source.proof)
    expect(() => f.store.findMain(input, () => undefined)).toThrow("MODS_CONVERSATION_FORK_PREPARING")
    f.copy(plan)
    const view = readForkImportView(plan)
    expect(view.target.logicalSessionId).not.toBe(f.target.logicalSessionId)
    expect(view.target.conversationId).not.toBe(f.target.conversationId)
    expect(f.store.highWater(view.target)).toBe(tool.sequence)
    expect(f.store.readReceipt(view.target, pending.uuid)).toBeUndefined()
    expect(f.store.readReceipt(view.target, consumed.uuid)?.inbox).toBe(true)
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_inbox WHERE conversation_id=?", [view.target.conversationId])[0].values).toEqual([[0]])
    const copied = readForkImportRow(plan, 0, tool.uuid)
    expect(copied.nativePayload).toBe(tool.nativePayload)
    expect(copied.receiptId).not.toBe(tool.receiptId)
    // Membership and the import manifest use the Store's exact decoded row serialization.
    expect(JSON.stringify(copied))
      .toBe(JSON.stringify(f.store.readReceipt(view.target, tool.uuid)))
    const cp = await f.saveTarget(plan, source.tuple.checkpoint)
    expect(cp.channel_values.todos).toEqual(source.tuple.checkpoint.channel_values.todos)
    expect(readForkImportView(plan).ready).toBe(true)
    expect(f.store.captureInbox(f.target, consumed.sequence).rows.map(row => row.uuid))
      .toEqual([pending.uuid])
    expect(f.db.exec("SELECT uuid FROM function_conversation_inbox WHERE conversation_id=? ORDER BY sequence",
      [f.target.conversationId])[0].values).toEqual([[pending.uuid]])
    const selected = view.entries[0].target
    expect(f.store.captureInbox(selected, consumed.sequence).rows).toEqual([])
    f.reopen()
    expect(() => f.store.assertForkImportReady(input)).not.toThrow()
    expect(f.store.findMain(input, () => undefined)?.conversationId).toBe(view.target.conversationId)
    expect(f.store.readReceipt(selected, tool.uuid)?.nativePayload).toBe(tool.nativePayload)
  })

  it("keeps a consumed note omitted by compaction and leaves all source inbox facts unchanged", async () => {
    const f = await fixture(), consumed = f.note("compacted"), pending = f.note("pending")
    const source = await f.saveSource(consumed.sequence, [])
    const { plan } = f.begin(source.proof)
    f.copy(plan)
    const imported = readForkImportRow(plan, 0, consumed.uuid)
    expect(imported.inbox).toBe(true)
    expect(() => readForkImportRow(plan, 0, pending.uuid)).toThrow()
    await f.saveTarget(plan, source.tuple.checkpoint)
    expect(f.store.readReceipt(f.target, consumed.uuid)?.receiptId).toBe(consumed.receiptId)
    // A rollback to frontier 0 must still see historical notes, while the original checkpoint's
    // frontier and physical pending table contain only the future note.
    expect(f.store.captureInbox(f.target, 0).rows.map(row => row.uuid))
      .toEqual([consumed.uuid, pending.uuid])
    expect(f.store.captureInbox(f.target, consumed.sequence).rows.map(row => row.uuid))
      .toEqual([pending.uuid])
    expect(f.db.exec("SELECT uuid FROM function_conversation_inbox WHERE conversation_id=? ORDER BY sequence",
      [f.target.conversationId])[0].values).toEqual([[pending.uuid]])
  })

  it("persists the preparing gate across app database reopen and does not load a main authority", async () => {
    const f = await fixture(), source = await f.saveSource(0, [])
    const { plan, input } = f.begin(source.proof)
    f.copy(plan)
    f.reopen()
    expect(() => f.store.findMain(input, () => undefined)).toThrow("MODS_CONVERSATION_FORK_PREPARING")
    expect(() => f.store.ensureMain(input, () => undefined)).toThrow("MODS_CONVERSATION_FORK_PREPARING")
    expect(() => f.store.assertForkImportReady(input)).toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("resumes committed journal data only from newly captured original native proofs after app restart", async () => {
    const f = await fixture(), keeper = f.keep(new AIMessage({ id: randomUUID(), content: "body" }))
    const source = await f.saveSource(0, [keeper]), { plan, input } = f.begin(source.proof)
    f.copy(plan)
    const before = readForkImportView(plan)
    f.reopen()
    const original = f.store.findMain({ threadId: "source", workspace: f.directory,
      incarnation: f.sourceIncarnation, checkpointNamespace: "" }, f.sourceGuard)
    if (!original) throw Error("Actual durable main required")
    const cut = f.store.readCheckpointCanonicalCut(original, { checkpointThreadId: "source",
      checkpointIncarnation: f.sourceIncarnation, checkpointId: source.tuple.checkpoint.id }, f.sourceGuard)
    if (!cut) throw Error("Original persisted cut required")
    const read = await captureConversationCheckpointRead(f.store, f.sourceSaver, source.tuple.config, () => ({
      target: original, checkpointThreadId: "source", checkpointIncarnation: f.sourceIncarnation,
      cut, frontier: 0, stateDigest: functionConversationMembershipDigest(source.tuple.checkpoint.channel_values.cmbFunctionConversation),
      assertCurrent: f.sourceGuard }), f.sourceGuard)
    if (!read.proof) throw Error("New actual read proof required")
    const resumed = resumeForkImport(f.store, { sources: [{ target: original, membership: read.proof }],
      selectedSourceIndex: 0, assertSource: f.sourceGuard, target: input,
      assertTarget: () => f.targetController.signal.throwIfAborted(), verifyTranscript: f.verify })
    const after = readForkImportView(resumed)
    expect(after.planId).toBe(before.planId)
    expect(after.target).toEqual(before.target)
    expect(after.copiedThrough).toBe(before.copiedThrough)
    expect(after.ready).toBe(false)
    expect(copyForkImportPage(resumed, f.write, f.verify).copied).toBe(0)
    await f.saveTarget(resumed, source.tuple.checkpoint)
    expect(readForkImportView(resumed).ready).toBe(true)
  })

  it("rejects copied plans, copied native proofs and a closed source Saver", async () => {
    const f = await fixture(), source = await f.saveSource(0, [])
    expect(() => prepareForkImport(f.store, { sources: [{ target: f.target,
      membership: { ...source.proof } }], selectedSourceIndex: 0, assertSource: f.sourceGuard })).toThrow()
    const { plan } = f.begin(source.proof)
    expect(() => readForkImportView({ ...plan })).toThrow("MODS_CONVERSATION_FORK_PROOF")
    await f.sourceSaver.close()
    expect(() => f.copy(plan)).toThrow("SQLJS_SAVER_READ_LIFETIME_EXPIRED")
  })

  it("rolls back imported rows, projection and page cursor together when the real writer fails", async () => {
    const f = await fixture(), keeper = f.keep(new AIMessage({ id: randomUUID(), content: "body" }))
    const source = await f.saveSource(0, [keeper]), { plan } = f.begin(source.proof)
    const write: FunctionConversationTranscriptWriter = (db, target, row) => {
      f.write(db, target, row); throw Error("real writer failed")
    }
    expect(() => copyForkImportPage(plan, write, f.verify)).toThrow("real writer failed")
    const view = readForkImportView(plan)
    expect(view.copiedThrough).toBe(0)
    expect(f.store.readReceipt(view.target, keeper.uuid)).toBeUndefined()
    expect(f.db.exec("SELECT * FROM projection WHERE thread_id='fork'")[0].values).toEqual([])
  })

  it("does not repeat the writer after an actual COMMIT succeeds but its acknowledgement is lost", async () => {
    const f = await fixture(), keeper = f.keep(new AIMessage({ id: randomUUID(), content: "body" }))
    const source = await f.saveSource(0, [keeper]), { plan } = f.begin(source.proof)
    const original = f.db.run.bind(f.db), writer = vi.fn(f.write)
    let first = true
    vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      const value = original(sql, args)
      if (sql === "COMMIT" && first) { first = false; throw Error("lost ACK") }
      return value
    })
    expect(copyForkImportPage(plan, writer, f.verify).complete).toBe(true)
    expect(writer).toHaveBeenCalledTimes(1)
    expect(copyForkImportPage(plan, writer, f.verify).copied).toBe(0)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it("does not acknowledge uncommitted page data when COMMIT and ROLLBACK both fail before execution", async () => {
    const f = await fixture(), keeper = f.keep(new AIMessage({ id: randomUUID(), content: "body" }))
    const source = await f.saveSource(0, [keeper]), { plan } = f.begin(source.proof)
    const original = f.db.run.bind(f.db), writer = vi.fn(f.write)
    const reader = openNativeSqliteDatabase(f.path).database
    const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw Error("native operation not entered")
      return original(sql, args)
    })
    try {
      expect(() => copyForkImportPage(plan, writer, f.verify)).toThrow("native operation not entered")
      expect(f.db.inTransaction).toBe(true)
      expect(() => readForkImportView(plan)).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
      expect(reader.exec("SELECT COUNT(*) FROM projection WHERE thread_id='fork'")[0].values).toEqual([[0]])
      expect(reader.exec("SELECT copied_through FROM function_conversation_fork_imports")[0].values).toEqual([[0]])
      expect(writer).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore(); original("ROLLBACK"); reader.close() }
  })

  it("keeps a single over-4MiB canonical row complete and respects the 64-row page work bound", async () => {
    const f = await fixture()
    const big = f.keep(new AIMessage({ id: randomUUID(), content: "原".repeat(1_500_000) }))
    const rows = [big]
    for (let index = 0; index < 65; index += 1) rows.push(f.keep(new AIMessage({ id: randomUUID(), content: String(index) })))
    const source = await f.saveSource(0, rows), { plan } = f.begin(source.proof)
    const first = copyForkImportPage(plan, f.write, f.verify)
    expect(first.copied).toBe(1)
    expect(first.complete).toBe(false)
    const second = copyForkImportPage(plan, f.write, f.verify)
    expect(second.copied).toBe(64)
    expect(second.complete).toBe(false)
    const last = copyForkImportPage(plan, f.write, f.verify)
    expect(last.copied).toBe(1)
    expect(last.complete).toBe(true)
    expect(readForkImportRow(plan, 0, big.uuid).nativePayload).toBe(big.nativePayload)
  })

  it("refuses target delete-recreate ABA and never borrows the new thread incarnation", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan } = f.begin(source.proof)
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id='fork'", [JSON.stringify({ cmb_thread_incarnation: randomUUID() })])
    expect(() => f.copy(plan)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
  })

  it("leaves the persisted gate after native admission is canceled or explicitly aborted", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    f.sourceController.abort(Error("source canceled"))
    expect(() => f.copy(plan)).toThrow("source canceled")
    abortForkImport(plan)
    expect(() => readForkImportView(plan)).toThrow("MODS_CONVERSATION_FORK_PROOF")
    expect(() => assertFunctionConversationForkReady(f.db, input)).toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("quarantines a ready import after close failure even when Source authority has expired", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    f.copy(plan)
    await f.saveTarget(plan, source.tuple.checkpoint)
    expect(readForkImportView(plan).ready).toBe(true)
    f.sourceController.abort(Error("Source revoked after ready"))
    const close = vi.spyOn(f.targetSaver, "close").mockRejectedValue(Error("actual close not entered"))
    await expect(f.targetSaver.close()).rejects.toThrow("actual close not entered")
    quarantineForkImport(plan)
    abortForkImport(plan)
    close.mockRestore()
    expect(f.db.exec("SELECT status FROM function_conversation_fork_imports")[0].values)
      .toEqual([["preparing"]])
    expect(() => assertFunctionConversationForkReady(f.db, input))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    expect(() => f.store.findMain(input, () => undefined))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    expect(() => readForkImportView(plan)).toThrow("MODS_CONVERSATION_FORK_PROOF")
    expect(f.db.exec("SELECT COUNT(*) FROM threads WHERE thread_id='fork'")[0].values).toEqual([[1]])
    f.reopen()
    expect(() => assertFunctionConversationForkReady(f.db, input))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("accepts quarantine lost-COMMIT ACK only from exact committed preparing data", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    f.copy(plan)
    await f.saveTarget(plan, source.tuple.checkpoint)
    const original = f.db.run.bind(f.db), reader = openNativeSqliteDatabase(f.path).database
    let commits = 0, updates = 0
    vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      if (sql.startsWith("UPDATE function_conversation_fork_imports SET status='preparing'")) updates += 1
      const value = original(sql, args)
      if (sql === "COMMIT") { commits += 1; throw Error("quarantine lost ACK") }
      return value
    })
    try {
      expect(() => quarantineForkImport(plan)).not.toThrow()
      expect(f.db.inTransaction).toBe(false)
      expect(commits).toBe(1)
      expect(updates).toBe(1)
      expect(reader.exec("SELECT status FROM function_conversation_fork_imports")[0].values)
        .toEqual([["preparing"]])
      expect(() => assertFunctionConversationForkReady(f.db, input))
        .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    } finally { reader.close() }
  })

  it.each([false, true])("keeps native denial when quarantine COMMIT fails before execution (rollback failure %s)",
    async rollbackFails => {
      const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
      f.copy(plan)
      await f.saveTarget(plan, source.tuple.checkpoint)
      const original = f.db.run.bind(f.db), reader = openNativeSqliteDatabase(f.path).database
      const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
        if (sql === "COMMIT" || (rollbackFails && sql === "ROLLBACK"))
          throw Error("quarantine native operation not entered")
        return original(sql, args)
      })
      try {
        expect(() => quarantineForkImport(plan)).toThrow("quarantine native operation not entered")
        expect(f.db.inTransaction).toBe(rollbackFails)
        expect(reader.exec("SELECT status FROM function_conversation_fork_imports")[0].values)
          .toEqual([["ready"]])
        expect(() => assertFunctionConversationForkReady(f.db, input))
          .toThrow("MODS_CONVERSATION_FORK_PREPARING")
      } finally {
        spy.mockRestore()
        if (f.db.inTransaction) original("ROLLBACK")
        reader.close()
      }
      // The failed durable operation is not reported as success, and later reads cannot clear denial.
      expect(f.db.exec("SELECT status FROM function_conversation_fork_imports")[0].values)
        .toEqual([["ready"]])
      expect(() => assertFunctionConversationForkReady(f.db, input))
        .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    })

  it("rejects an outer transaction without releasing its native denied marker", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    f.db.run("BEGIN")
    try {
      expect(() => quarantineForkImport(plan)).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
      expect(f.db.inTransaction).toBe(true)
    } finally { f.db.run("ROLLBACK") }
    expect(() => assertFunctionConversationForkReady(f.db, input))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("does not modify a replacement incarnation or borrow copied plan data", async () => {
    const f = await fixture(), source = await f.saveSource(0, []), { plan, input } = f.begin(source.proof)
    expect(() => quarantineForkImport({ ...plan })).toThrow("MODS_CONVERSATION_FORK_PROOF")
    const replacement = { token: randomUUID(), legacyCreatedAt: 2000 }
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id='fork'", [
      JSON.stringify({ cmb_thread_incarnation: replacement.token })])
    expect(() => quarantineForkImport(plan)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(() => assertFunctionConversationForkReady(f.db, { ...input, incarnation: replacement }))
      .not.toThrow()
    expect(f.db.exec("SELECT status FROM function_conversation_fork_imports")[0].values)
      .toEqual([["preparing"]])
  })

  it("keeps native denial on immutable journal mismatch and closes an unbegun private plan only", async () => {
    const f = await fixture(), source = await f.saveSource(0, [])
    const unbegun = prepareForkImport(f.store, { sources: [{ target: f.target, membership: source.proof }],
      selectedSourceIndex: 0, assertSource: f.sourceGuard })
    quarantineForkImport(unbegun)
    expect(() => readForkImportView(unbegun)).toThrow("MODS_CONVERSATION_FORK_PROOF")
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_fork_imports")[0].values).toEqual([[0]])
    const { plan, input } = f.begin(source.proof)
    f.db.run("UPDATE function_conversation_fork_imports SET source_json='[]'")
    expect(() => quarantineForkImport(plan)).toThrow("MODS_CONVERSATION_FORK_PROOF")
    // A compromised ready flag cannot override the native failure latch.
    f.db.run("UPDATE function_conversation_fork_imports SET status='ready'")
    expect(() => assertFunctionConversationForkReady(f.db, input))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("requires newly committed target membership and rechecks the actual projection before ready", async () => {
    const f = await fixture(), keeper = f.keep(new AIMessage({ id: randomUUID(), content: "body" }))
    const source = await f.saveSource(0, [keeper]), { plan } = f.begin(source.proof)
    f.copy(plan)
    expect(() => recordForkImportCheckpoint(plan, 0, source.proof)).toThrow()
    f.db.run("UPDATE projection SET payload='wrong' WHERE thread_id='fork'")
    await expect(f.saveTarget(plan, source.tuple.checkpoint)).rejects.toThrow("PROJECTION_MISMATCH")
    expect(readForkImportView(plan).ready).toBe(false)
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_fork_checkpoints")[0].values).toEqual([[1]])
  })

  it("does not trust a corrupted complete cursor when a consumed compacted note was never imported", async () => {
    const f = await fixture(), consumed = f.note("compacted canonical note")
    const source = await f.saveSource(consumed.sequence, []), { plan } = f.begin(source.proof)
    f.db.run("UPDATE function_conversation_fork_imports SET rows_complete=1,copied_through=?", [consumed.sequence])
    expect(copyForkImportPage(plan, f.write, f.verify).complete).toBe(true)
    await expect(f.saveTarget(plan, source.tuple.checkpoint)).rejects.toThrow("MODS_CONVERSATION_FORK_PROOF")
    expect(readForkImportView(plan).ready).toBe(false)
  })

  it("imports only notices inside the fixed original time and branch cut without adding graph messages", async () => {
    const f = await fixture(), notice = f.keep(new SystemMessage({ id: randomUUID(), content: "idle notice" }))
    const source = await f.saveSource(0, [])
    f.keep(new SystemMessage({ id: randomUUID(), content: "later notice" }))
    const { plan } = f.begin(source.proof)
    f.copy(plan)
    expect(readForkImportRow(plan, 0, notice.uuid).message.type).toBe("system")
    const cp = await f.saveTarget(plan, source.tuple.checkpoint)
    expect(cp.channel_values.messages).toEqual([])
  })

  it("does not import a nonmember ToolSystem inside the notice time and sequence cut", async () => {
    const f = await fixture()
    const side = f.keep(new SystemMessage({ id: randomUUID(), content: "future tool side message" }),
      { toolSystem: true })
    const notice = f.keep(new SystemMessage({ id: randomUUID(), content: "visible notice" }))
    const source = await f.saveSource(0, []), { plan } = f.begin(source.proof)
    expect(side.createdAt).toBeLessThanOrEqual(Date.parse(source.tuple.checkpoint.ts))
    f.copy(plan)
    expect(() => readForkImportRow(plan, 0, side.uuid)).toThrow("MODS_CONVERSATION_FORK_PROOF")
    expect(f.db.exec(`SELECT COUNT(*) FROM function_conversation_rows r
      JOIN function_conversations c ON c.conversation_id=r.conversation_id
      JOIN function_logical_sessions s ON s.logical_session_id=c.logical_session_id
      WHERE s.thread_id='fork' AND r.uuid=?`, [side.uuid])[0].values).toEqual([[0]])
    expect(f.db.exec("SELECT COUNT(*) FROM projection WHERE thread_id='fork' AND uuid=?",
      [side.uuid])[0].values).toEqual([[0]])
    expect(readForkImportRow(plan, 0, notice.uuid).door).toBe("notice")
  })

  it("imports an actual checkpoint member ToolSystem with its full native class and tool origin", async () => {
    const f = await fixture()
    const side = f.keep(new SystemMessage({ id: randomUUID(), content: "actual tool system",
      additional_kwargs: { actualToolMetadata: { result: "complete" } } }), { toolSystem: true })
    const source = await f.saveSource(0, [side]), { plan } = f.begin(source.proof)
    f.copy(plan)
    const copied = readForkImportRow(plan, 0, side.uuid)
    expect(copied.nativePayload).toBe(side.nativePayload)
    expect(copied.origin).toEqual({ kind: "tool", tool: "ActualTool" })
    expect(copied.door).toBe("tool-message")
    const cp = await f.saveTarget(plan, source.tuple.checkpoint)
    const message = (cp.channel_values.messages as BaseMessage[])[0]
    expect(message).toBeInstanceOf(SystemMessage)
    expect(serializeFunctionConversationNativeMessage(message)).toBe(side.nativePayload)
  })

  it("permits old non-conversation threads without constructing a Store or schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-old-fork-ready-"))
    const db = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
    try {
      expect(() => assertFunctionConversationForkReady(db, { threadId: "old",
        incarnation: { token: null, legacyCreatedAt: 1 } })).not.toThrow()
      expect(db.exec("SELECT name FROM sqlite_master WHERE name LIKE 'function_%'")[0].values).toEqual([])
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
