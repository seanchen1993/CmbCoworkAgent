import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { FunctionConversationStore, type FunctionConversationRow,
  type FunctionConversationTranscriptWriter } from "../db/function-conversation-store"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { functionConversationNoteMessage } from "../agent/mods-conversation"
import { FunctionConversationDeliveryBridge, type FunctionConversationDeliveryBinding } from "./function-conversation-delivery"
import { functionConversationCanonicalStamp, functionConversationMembershipDigest } from "./function-conversation-checkpoint-membership"
import { recoverMissingFunctionConversationMessages } from "./function-conversation-recovery"
import { SqlJsSaver, type SqlJsSaverFunctionConversationRecoveryReceipt } from "./sqljs-saver"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture(maxRootCheckpoints = 3) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-snapshot-recovery-"))
  const app = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  app.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  app.run("CREATE TABLE projection (uuid TEXT PRIMARY KEY,payload TEXT NOT NULL)")
  const incarnation = { token: randomUUID(), legacyCreatedAt: 1000 }
  app.run("INSERT INTO threads VALUES (?,?,?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: incarnation.token })])
  const store = new FunctionConversationStore(app)
  const target = store.ensureMain({ threadId: "thread", workspace: directory,
    incarnation, checkpointNamespace: "" }, () => undefined)
  const controller = new AbortController(), guard = () => controller.signal.throwIfAborted()
  const binding = (): FunctionConversationDeliveryBinding => ({ target,
    checkpointThreadId: "thread", signal: controller.signal, assertCurrent: guard })
  const path = join(directory, "graph.sqlite"), savers: SqlJsSaver[] = []
  const createSaver = (handler?: (saver: SqlJsSaver, receipt: SqlJsSaverFunctionConversationRecoveryReceipt,
    recover: () => readonly BaseMessage[]) => Promise<readonly BaseMessage[]>) => {
    const saver: SqlJsSaver = new SqlJsSaver(path, undefined, { maxRootCheckpoints,
      recoverFunctionConversationMessages: async receipt => {
        const recover = () => recoverMissingFunctionConversationMessages({ store, saver, receipt,
          capture: () => binding() })
        return handler ? handler(saver, receipt, recover) : recover()
      } })
    savers.push(saver)
    return saver
  }
  const initial = createSaver(), bridge = new FunctionConversationDeliveryBridge(store, binding)
  const write: FunctionConversationTranscriptWriter = (db, _target, row) => {
    expect(db === app && db.inTransaction).toBe(true)
    db.run("INSERT INTO projection VALUES (?,?)", [row.uuid, row.nativePayload])
  }
  const verify: FunctionConversationTranscriptWriter = (db, _target, row) => {
    expect(db.exec("SELECT payload FROM projection WHERE uuid=?", [row.uuid])[0].values)
      .toEqual([[row.nativePayload]])
  }
  const note = (text: string) => {
    const id = randomUUID(), native = new HumanMessage({ id, content: [{ type: "text", text }],
      additional_kwargs: { isMeta: true } })
    return store.commit(target, { uuid: id, inputDigest: id, door: "note", origin: { kind: "plugin", name: "P" },
      message: { type: "user", role: "user", isMeta: true, content: [{ type: "text", text }] },
      nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: { batch: id },
      inbox: true, sdk: true }, guard, write, verify)
  }
  const keep = (native: AIMessage | ToolMessage) => {
    if (!native.id) throw Error("Actual keeper UUID required")
    const tool = ToolMessage.isInstance(native)
    return store.commit(target, { uuid: native.id, inputDigest: native.id,
      door: tool ? "tool-result" : "response", origin: { kind: "engine" },
      message: tool ? { type: "user", role: "user", content: [{ type: "tool_result",
        tool_use_id: native.tool_call_id, content: "display" }] }
        : { type: "assistant", content: [{ type: "text", text: "display" }] },
      nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: { batch: native.id },
      inbox: false, sdk: false }, guard, write, verify)
  }
  const marked = (row: FunctionConversationRow, original?: BaseMessage) => {
    const native = original ?? functionConversationNoteMessage(row, target)
    native.additional_kwargs = { ...native.additional_kwargs, function_row: functionConversationCanonicalStamp(target, row) }
    return native
  }
  const checkpoint = (frontier: number, messages: BaseMessage[], order = 1): Checkpoint => ({
    v: 1, id: randomUUID(), ts: new Date(1_700_000_000_000 + order).toISOString(),
    channel_values: { messages, todos: [{ text: "original non-message channel" }], cmbFunctionConversation: {
      version: 1, logicalSessionId: target.logicalSessionId, conversationId: target.conversationId,
      branchId: target.branchId, frontier } },
    channel_versions: { messages: order, cmbFunctionConversation: order }, versions_seen: {}
  })
  const config = (id?: string) => ({ configurable: { thread_id: "thread", checkpoint_ns: "",
    ...(id ? { checkpoint_id: id } : {}) } })
  const graph = <T>(run: (db: ReturnType<typeof openNativeSqliteDatabase>["database"]) => T): T => {
    const db = openNativeSqliteDatabase(path).database
    try { return run(db) } finally { db.close() }
  }
  const breakSnapshots = async () => {
    await initial.close()
    graph(db => db.run("DELETE FROM checkpoint_message_snapshots"))
  }
  cleanups.push(async () => {
    controller.abort()
    for (const saver of savers) await saver.close()
    app.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { app, store, target, controller, guard, binding, initial, createSaver, note, keep, marked,
    checkpoint, config, graph, breakSnapshots,
    put: (cp: Checkpoint, parent?: string) => bridge.wrap(initial).put(config(parent), cp, metadata),
    snapshots: () => graph(db => Number(db.exec("SELECT COUNT(*) FROM checkpoint_message_snapshots")[0].values[0][0])),
    pending: () => app.exec("SELECT uuid FROM function_conversation_inbox ORDER BY sequence")[0]?.values ?? [] }
}

describe("original native checkpoint recovery from exact persisted membership", () => {
  it("restores complete classes/tool/provider metadata while excluding a future pending note", async () => {
    const f = fixture(), used = f.note("consumed"), pending = f.note("future")
    const ai = new AIMessage({ id: randomUUID(), content: "answer", tool_calls: [{ id: "call", name: "read",
      args: { path: "actual.txt" }, type: "tool_call" }], response_metadata: { provider: "actual occurrence" },
      usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
    const tool = new ToolMessage({ id: randomUUID(), tool_call_id: "call", content: "failed output",
      status: "error", artifact: { complete: [1, 2, 3] }, metadata: { original: true } })
    const messages = [f.marked(used), f.marked(f.keep(ai), ai), f.marked(f.keep(tool), tool)]
    const cp = f.checkpoint(1, messages)
    await f.put(cp)
    await f.breakSnapshots()
    const saver = f.createSaver(), tuple = await saver.getTuple(f.config(cp.id))
    const restored = tuple?.checkpoint.channel_values.messages as BaseMessage[]
    expect(restored.map(message => message.toDict())).toEqual(messages.map(message => message.toDict()))
    expect(ToolMessage.isInstance(restored[2])).toBe(true)
    expect(tuple?.checkpoint.channel_values.todos).toEqual(cp.channel_values.todos)
    expect(tuple?.checkpoint.channel_values.cmbFunctionConversation).toEqual(cp.channel_values.cmbFunctionConversation)
    expect(f.pending()).toEqual([[pending.uuid]])
    expect(f.snapshots()).toBe(1)
  })

  it("recovers a retained exact historical checkpoint without folding in later rows", async () => {
    const f = fixture(), first = f.note("historical"), a = f.checkpoint(1, [f.marked(first)])
    await f.put(a)
    const later = f.note("later pending"), b = f.checkpoint(1, [f.marked(first)], 2)
    await f.put(b, a.id)
    await f.breakSnapshots()
    const tuple = await f.createSaver().getTuple(f.config(a.id))
    expect(tuple?.checkpoint.id).toBe(a.id)
    expect((tuple?.checkpoint.channel_values.messages as BaseMessage[]).map(message => message.id)).toEqual([first.uuid])
    expect(f.pending()).toEqual([[later.uuid]])
  })

  it("does not reconstruct an entire checkpoint pruned by native default-one retention", async () => {
    const f = fixture(1), row = f.note("kept"), a = f.checkpoint(1, [f.marked(row)])
    await f.put(a)
    await f.put(f.checkpoint(1, [f.marked(row)], 2), a.id)
    await f.breakSnapshots()
    const callback = vi.fn(async (_saver: SqlJsSaver, _receipt: SqlJsSaverFunctionConversationRecoveryReceipt,
      recover: () => readonly BaseMessage[]) => recover())
    expect(await f.createSaver(callback).getTuple(f.config(a.id))).toBeUndefined()
    expect(callback).not.toHaveBeenCalled()
  })

  it("rejects a mixed unmarked graph rather than treating the canonical subset as the whole snapshot", async () => {
    const f = fixture(), row = f.note("canonical"), cp = f.checkpoint(1, [f.marked(row),
      new HumanMessage({ id: "unmarked-old-row", content: "original legacy" })])
    await f.put(cp)
    await f.breakSnapshots()
    await expect(f.createSaver().getTuple(f.config(cp.id))).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.snapshots()).toBe(0)
  })

  it("cannot turn a put without a persisted delivery receipt into full recovery", async () => {
    const f = fixture(), row = f.note("pending ACK"), cp = f.checkpoint(1, [f.marked(row)])
    await f.initial.put(f.config(), cp, metadata)
    await f.breakSnapshots()
    await expect(f.createSaver().getTuple(f.config(cp.id))).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.pending()).toEqual([[row.uuid]])
    expect(f.snapshots()).toBe(0)
  })

  it.each(["count", "ordinal", "payload"])("rejects corrupted %s even with a recomputed public snapshot digest", async kind => {
    const f = fixture(), row = f.note("original"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    if (kind === "payload") f.app.run("UPDATE function_conversation_rows SET payload_json=? WHERE uuid=?", ["damaged", row.uuid])
    else {
      const receipt = f.app.exec("SELECT receipt_id,snapshot_json FROM function_conversation_checkpoint_receipts")[0].values[0]
      const data = JSON.parse(String(receipt[1]))
      delete data.snapshotDigest
      if (kind === "count") data.nativeMessageCount = 2
      else {
        data.members[0].ordinal = 1
        f.app.run("UPDATE function_conversation_checkpoint_members SET ordinal=1,member_json=? WHERE receipt_id=?",
          [JSON.stringify(data.members[0]), receipt[0]])
      }
      const digest = functionConversationMembershipDigest(data)
      f.app.run("UPDATE function_conversation_checkpoint_receipts SET snapshot_json=?,snapshot_digest=? WHERE receipt_id=?",
        [JSON.stringify({ ...data, snapshotDigest: digest }), digest, receipt[0]])
    }
    await expect(f.createSaver().getTuple(f.config(cp.id))).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.snapshots()).toBe(0)
  })

  it("keeps callback data mutations away from the original channels and checks every returned message", async () => {
    const f = fixture(), row = f.note("original"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    const saver = f.createSaver(async (actual, receipt, recover) => {
      const copy = actual.readFunctionConversationRecoveryCheckpoint(receipt)
      copy.checkpoint.channel_values.todos = [{ text: "callback replacement" }]
      copy.checkpoint.channel_values.cmbFunctionConversation = { frontier: 999 }
      if (copy.config.configurable) copy.config.configurable.thread_id = "fake-thread"
      return recover()
    })
    const tuple = await saver.getTuple(f.config(cp.id))
    expect(tuple?.checkpoint.channel_values.todos).toEqual(cp.channel_values.todos)
    expect(tuple?.checkpoint.channel_values.cmbFunctionConversation).toEqual(cp.channel_values.cmbFunctionConversation)
  })

  it("rejects a callback replacing the proved array with a different native message", async () => {
    const f = fixture(), row = f.note("original"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    const saver = f.createSaver(async (_actual, _receipt, recover) => {
      recover()
      return [new HumanMessage({ id: row.uuid, content: "changed after proof" })]
    })
    await expect(saver.getTuple(f.config(cp.id))).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.snapshots()).toBe(0)
  })

  it("requires private registered verification, and rejects copied/cross/expired raw receipts", async () => {
    const f = fixture(), row = f.note("original"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    let captured: SqlJsSaverFunctionConversationRecoveryReceipt | undefined
    const second = f.createSaver(), saver = f.createSaver(async (actual, receipt, recover) => {
      captured = receipt
      expect(() => actual.readFunctionConversationRecoveryCheckpoint({ ...receipt })).toThrow("SQLJS_SAVER_RECOVERY_RECEIPT_INVALID")
      expect(() => second.readFunctionConversationRecoveryCheckpoint(receipt)).toThrow("SQLJS_SAVER_RECOVERY_RECEIPT_INVALID")
      return recover()
    })
    await saver.getTuple(f.config(cp.id))
    const finishedReceipt = captured
    if (!finishedReceipt) throw Error("actual native callback not entered")
    expect(() => saver.readFunctionConversationRecoveryCheckpoint(finishedReceipt)).toThrow("SQLJS_SAVER_RECOVERY_RECEIPT_INVALID")
    await saver.close()
    f.graph(db => db.run("DELETE FROM checkpoint_message_snapshots"))
    const unverified = f.createSaver(async () => [f.marked(row)])
    await expect(unverified.getTuple(f.config(cp.id))).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.snapshots()).toBe(0)
  })

  it("holds the real namespace gate until a deferred recovery finishes before second-Saver pruning", async () => {
    const f = fixture(1), row = f.note("old actual"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    const entered = deferred<void>(), release = deferred<void>()
    const saver = f.createSaver(async (_actual, _receipt, recover) => {
      const messages = recover()
      entered.resolve()
      await release.promise
      return messages
    })
    const reading = saver.getTuple(f.config(cp.id))
    void reading.catch(() => undefined)
    await entered.promise
    const writer = f.createSaver(), next = f.checkpoint(1, [f.marked(row)], 2)
    let settled = false
    const later = writer.put(f.config(cp.id), next, metadata).then(() => { settled = true })
    try {
      expect(settled).toBe(false)
      expect(f.graph(db => db.exec("SELECT checkpoint_id FROM checkpoints")[0].values)).toEqual([[cp.id]])
    } finally { release.resolve() }
    expect((await reading)?.checkpoint.id).toBe(cp.id)
    await later
    expect(settled).toBe(true)
    expect(await saver.getTuple(f.config(cp.id))).toBeUndefined()
  })

  it.each(["cancel", "incarnation"])("rejects %s during actual serde before repair without releasing canonical facts", async kind => {
    const f = fixture(), row = f.note("original"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    const saver = f.createSaver(), delegate = saver.serde
    const entered = deferred<void>(), release = deferred<void>()
    saver.serde = { loadsTyped: (type, value) => delegate.loadsTyped(type, value),
      dumpsTyped: async value => {
        if (Array.isArray(value)) { entered.resolve(); await release.promise }
        return delegate.dumpsTyped(value)
      } }
    const reading = saver.getTuple(f.config(cp.id))
    void reading.catch(() => undefined)
    await entered.promise
    if (kind === "cancel") f.controller.abort()
    else f.app.run("UPDATE threads SET metadata=? WHERE thread_id='thread'", [JSON.stringify({ cmb_thread_incarnation: randomUUID() })])
    release.resolve()
    await expect(reading).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.snapshots()).toBe(0)
    expect(f.app.exec("SELECT COUNT(*) FROM function_conversation_rows")[0].values).toEqual([[1]])
  })

  it("does not let a receipt borrow a close/reopened Saver while its callback is still outstanding", async () => {
    const f = fixture(), row = f.note("original"), cp = f.checkpoint(1, [f.marked(row)])
    await f.put(cp)
    await f.breakSnapshots()
    const entered = deferred<void>(), release = deferred<void>()
    let captured: SqlJsSaverFunctionConversationRecoveryReceipt | undefined
    const saver = f.createSaver(async (_actual, receipt, recover) => {
      captured = receipt
      const messages = recover()
      entered.resolve()
      await release.promise
      return messages
    })
    const reading = saver.getTuple(f.config(cp.id))
    void reading.catch(() => undefined)
    await entered.promise
    await saver.close()
    await saver.initialize()
    const oldReceipt = captured
    if (!oldReceipt) throw Error("native receipt missing")
    expect(() => saver.readFunctionConversationRecoveryCheckpoint(oldReceipt)).toThrow("SQLJS_SAVER_RECOVERY_RECEIPT_EXPIRED")
    release.resolve()
    await expect(reading).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED" })
    expect(f.snapshots()).toBe(0)
  })
})
