import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import {
  FunctionConversationStore,
  type FunctionConversationRow,
  type FunctionConversationTranscriptWriter
} from "../db/function-conversation-store"
import { SqlJsSaver, type SqlJsSaverOptions, type SqlJsSaverCommittedCheckpointReceipt } from "./sqljs-saver"
import { productionMainCheckpointOptions } from "./function-conversation-runtime.test-fixture"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { functionConversationNoteMessage } from "../agent/mods-conversation"
import {
  FUNCTION_CONVERSATION_CHANNEL,
  FunctionConversationDeliveryBridge,
  type FunctionConversationDeliveryBinding,
  type FunctionConversationPreparedCheckpoint
} from "./function-conversation-delivery"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function fixture(namespace = "", options: SqlJsSaverOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-conversation-delivery-"))
  const database = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  database.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
  database.run("CREATE TABLE projection (uuid TEXT PRIMARY KEY, payload TEXT NOT NULL)")
  const token = randomUUID()
  database.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: token })])
  const store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId: "thread", workspace: directory,
    incarnation: { token, legacyCreatedAt: 1000 }, checkpointNamespace: namespace },
  () => undefined)
  const graphPath = join(directory, "graph.sqlite")
  const saver = new SqlJsSaver(graphPath, undefined, options)
  const controller = new AbortController()
  let current: FunctionConversationDeliveryBinding = {
    target, checkpointThreadId: "thread", signal: controller.signal, assertCurrent: () => undefined
  }
  const bridge = new FunctionConversationDeliveryBridge(store, () => current)
  const observer = bridge.bindSaver(saver)
  const write: FunctionConversationTranscriptWriter = (db, _target, row) => {
    expect(db).toBe(database)
    expect(db.inTransaction).toBe(true)
    db.run("INSERT INTO projection VALUES (?, ?)", [row.uuid, JSON.stringify(row.message)])
  }
  const verify: FunctionConversationTranscriptWriter = (db, _target, row) => {
    expect(db).toBe(database)
    const saved = db.exec("SELECT payload FROM projection WHERE uuid = ?", [row.uuid])[0]
    expect(saved.values).toEqual([[JSON.stringify(row.message)]])
  }
  const note = (text = "kept note") => {
    const uuid = randomUUID()
    return store.commit(target, { uuid, inputDigest: `digest:${uuid}`, door: "note",
      origin: { kind: "plugin", name: "P" },
      message: { type: "user", role: "user", isMeta: true,
        content: [{ type: "text", text }] },
      nativePayload: serializeFunctionConversationNativeMessage(new HumanMessage({ id: uuid,
        content: [{ type: "text", text }], additional_kwargs: { isMeta: true } })),
      orderAnchor: { batch: "actual-batch" }, inbox: true, sdk: true },
    () => undefined, write, verify)
  }
  const config = (id?: string): RunnableConfig => ({ configurable: {
    thread_id: "thread", checkpoint_ns: namespace, ...(id ? { checkpoint_id: id } : {})
  } })
  const checkpoint = (frontier: number, row?: FunctionConversationRow): Checkpoint => ({
    v: 1, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages: row ? [functionConversationNoteMessage(row, target)] : [],
      [FUNCTION_CONVERSATION_CHANNEL]: { version: 1, logicalSessionId: target.logicalSessionId,
        conversationId: target.conversationId, branchId: target.branchId, frontier } },
    channel_versions: { messages: frontier + 1, [FUNCTION_CONVERSATION_CHANNEL]: frontier + 1 },
    versions_seen: {}
  })
  cleanups.push(async () => {
    controller.abort()
    await saver.close()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { store, database, target, saver, graphPath, controller, bridge, observer, config, checkpoint, note,
    get binding() { return current },
    replaceBinding(binding: FunctionConversationDeliveryBinding) { current = binding },
    pending() {
      return database.exec("SELECT COUNT(*) FROM function_conversation_inbox")[0].values[0][0]
    }
  }
}

describe("FunctionConversationDeliveryBridge actual SqlJsSaver receipts", () => {
  it("records delivery only after actual checkpoint commit while retaining the canonical row", async () => {
    const f = fixture(), row = f.note(), checkpoint = f.checkpoint(1, row)
    const prepared = f.observer.prepare(f.config(), checkpoint)
    expect(f.pending()).toBe(1)
    const result = await f.saver.put(f.config(), checkpoint, metadata)
    expect(f.pending()).toBe(1)
    await f.observer.committed(prepared, result)
    expect(f.pending()).toBe(0)
    expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
    const tuple = await f.saver.getTuple(f.config(checkpoint.id))
    expect(tuple?.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]).toEqual(
      checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
    expect(f.database.exec("SELECT checkpoint_id, frontier FROM function_conversation_deliveries")[0]
      .values).toEqual([[checkpoint.id, 1]])
  })

  it("convenience wrapper calls the native saver and performs the same strict delivery", async () => {
    const f = fixture(), row = f.note(), checkpoint = f.checkpoint(1, row)
    const publicRead = vi.spyOn(SqlJsSaver.prototype, "getTuple").mockImplementation(() => {
      throw Error("public read would re-enter the held namespace gate")
    })
    const result = await f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)
    expect(result.configurable?.checkpoint_id).toBe(checkpoint.id)
    expect(f.pending()).toBe(0)
    expect(publicRead).not.toHaveBeenCalled()
    publicRead.mockRestore()
    expect((await f.saver.getTuple(result))?.checkpoint.id).toBe(checkpoint.id)
  })

  it("refuses copied, cross-saver and replayed native preparations", async () => {
    const f = fixture(), row = f.note(), checkpoint = f.checkpoint(1, row)
    const prepared = f.observer.prepare(f.config(), checkpoint)!
    const result = await f.saver.put(f.config(), checkpoint, metadata)
    await expect(f.observer.committed({ ...prepared }, result))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_PROOF")
    const other = new SqlJsSaver(join(tmpdir(), `unused-${randomUUID()}.sqlite`))
    try {
      await expect(f.bridge.bindSaver(other).committed(prepared, result))
        .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_PROOF")
    } finally { await other.close() }
    await f.observer.committed(prepared, result)
    await expect(f.observer.committed(prepared, result))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_PROOF")
  })

  it("cannot authenticate an uncommitted checkpoint using its public result-shaped JSON", async () => {
    const f = fixture(), checkpoint = f.checkpoint(1, f.note())
    const prepared = f.observer.prepare(f.config(), checkpoint)
    await expect(f.observer.committed(prepared, f.config(checkpoint.id)))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_NOT_COMMITTED")
    expect(f.pending()).toBe(1)
    await expect(f.observer.committed({} as FunctionConversationPreparedCheckpoint,
      f.config(checkpoint.id))).rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_PROOF")
  })

  it("fails a saved but changed frontier rather than acknowledging the prepared candidate", async () => {
    const f = fixture(), checkpoint = f.checkpoint(1, f.note())
    const prepared = f.observer.prepare(f.config(), checkpoint)
    checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL] = {
      ...checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL] as object, frontier: 0
    }
    const result = await f.saver.put(f.config(), checkpoint, metadata)
    await expect(f.observer.committed(prepared, result))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    expect(f.pending()).toBe(1)
  })

  it("never borrows a new authority after the original preparation expires", async () => {
    const f = fixture(), checkpoint = f.checkpoint(1, f.note())
    const prepared = f.observer.prepare(f.config(), checkpoint)
    const result = await f.saver.put(f.config(), checkpoint, metadata)
    f.controller.abort(Error("original owner canceled"))
    f.replaceBinding({ ...f.binding, signal: new AbortController().signal })
    await expect(f.observer.committed(prepared, result)).rejects.toThrow("original owner canceled")
    expect(f.pending()).toBe(1)
    await f.observer.recover(result, f.binding)
    expect(f.pending()).toBe(0)
  })

  it("recovers the exact successful checkpoint after a lost delivery ACK without taking latest", async () => {
    const f = fixture("", { maxRootCheckpoints: productionMainCheckpointOptions().maxRootCheckpoints })
    const row = f.note()
    const first = f.checkpoint(1, row), second = f.checkpoint(0)
    second.ts = new Date(Date.parse(first.ts) + 1).toISOString()
    const exact = await f.saver.put(f.config(), first, metadata)
    await f.saver.put(exact, second, metadata)
    expect(f.pending()).toBe(1)
    await expect(f.observer.recover(f.config(), f.binding))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_REQUIRED")
    await f.observer.recover(exact, f.binding)
    expect(f.database.exec("SELECT checkpoint_id FROM function_conversation_deliveries")[0]
      .values).toEqual([[first.id]])
    expect(f.pending()).toBe(0)
    expect(f.store.captureInbox(f.target, 0).rows.map(item => item.uuid)).toEqual([row.uuid])
  })

  it("rejects an exact checkpoint pruned by native default retention without borrowing latest", async () => {
    const f = fixture(), row = f.note()
    const first = f.checkpoint(1, row), second = f.checkpoint(0)
    second.ts = new Date(Date.parse(first.ts) + 1).toISOString()
    const exact = await f.saver.put(f.config(), first, metadata)
    const later = await f.saver.put(exact, second, metadata)
    expect(await f.saver.getTuple(exact)).toBeUndefined()
    expect((await f.saver.getTuple(later))?.checkpoint.id).toBe(second.id)
    await expect(f.observer.recover(exact, f.binding))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_NOT_COMMITTED")
    await expect(f.observer.recover(f.config(), f.binding))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_REQUIRED")
    expect(f.pending()).toBe(1)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0]
      .values).toEqual([[0]])
    expect(f.store.captureInbox(f.target, 0).rows.map(item => item.uuid)).toEqual([row.uuid])
  })

  it("rejects foreign namespaces and durable branch state instead of same-thread fallback", async () => {
    const f = fixture("actual-child"), checkpoint = f.checkpoint(1, f.note())
    expect(() => f.observer.prepare({ configurable: { thread_id: "thread", checkpoint_ns: "" } },
      checkpoint)).toThrow("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL] = {
      ...checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL] as object, branchId: randomUUID()
    }
    expect(() => f.observer.prepare(f.config(), checkpoint))
      .toThrow("MODS_CONVERSATION_STATE_CHANGED")
    expect(f.pending()).toBe(1)
  })

  it("leaves uncommitted inbox intact when the native saver fails", async () => {
    const f = fixture(), checkpoint = f.checkpoint(1, f.note())
    await f.saver.retire()
    await expect(f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)).rejects.toThrow()
    expect(f.pending()).toBe(1)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0]
      .values[0][0]).toBe(0)
  })

  it("does not produce delivery for a native checkpoint without the host conversation channel", async () => {
    const f = fixture(), checkpoint = f.checkpoint(0)
    delete checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
    const nativeObserver = vi.spyOn(SqlJsSaver.prototype, "putWithCommitObserver")
    expect(f.observer.prepare(f.config(), checkpoint)).toBeUndefined()
    const result = await f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)
    expect(nativeObserver).not.toHaveBeenCalled()
    await f.observer.recover(result, f.binding)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0]
      .values[0][0]).toBe(0)
  })

  it("ACKs the genuine fixed checkpoint before another actual Saver can prune it", async () => {
    const f = fixture(), row = f.note(), first = f.checkpoint(1, row), second = f.checkpoint(0)
    second.ts = new Date(Date.parse(first.ts) + 1).toISOString()
    const prepared = f.observer.prepare(f.config(), first)!
    const entered = deferred<SqlJsSaverCommittedCheckpointReceipt>(), release = deferred<void>()
    const keeping = f.saver.putWithCommitObserver(f.config(), first, metadata, async (receipt) => {
      entered.resolve(receipt)
      await release.promise
      f.observer.observed(prepared, receipt)
      expect(f.pending()).toBe(0)
    })
    const receipt = await entered.promise
    const competing = new SqlJsSaver(f.graphPath)
    const reader = openNativeSqliteDatabase(f.graphPath).database
    cleanups.push(async () => { reader.close(); await competing.close() })
    const later = competing.putWithCommitObserver(f.config(first.id), second, metadata, () => {
      expect(f.pending()).toBe(0)
    })
    try {
      expect(reader.exec("SELECT checkpoint_id FROM checkpoints")[0].values).toEqual([[first.id]])
      expect(f.pending()).toBe(1)
      expect(() => f.observer.observed({ ...prepared }, receipt))
        .toThrow("MODS_CONVERSATION_CHECKPOINT_PROOF")
      expect(f.pending()).toBe(1)
    } finally { release.resolve() }
    await keeping
    await later
    expect(reader.exec("SELECT checkpoint_id FROM checkpoints")[0].values).toEqual([[second.id]])
    expect(f.database.exec("SELECT checkpoint_id, frontier FROM function_conversation_deliveries")[0].values)
      .toEqual([[first.id, 1]])
    expect(() => f.observer.observed(prepared, receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    await expect(f.observer.recover(f.config(first.id), f.binding))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_NOT_COMMITTED")
    expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
  })

  it.each(["cancel", "old epoch"])("does not ACK a native COMMIT after %s at exact-read admission", async (kind) => {
    const f = fixture(), checkpoint = f.checkpoint(1, f.note())
    await f.saver.initialize()
    let epoch = 1
    const original = f.binding
    f.replaceBinding({ ...original, assertCurrent() {
      if (epoch !== 1) throw Error("original binding epoch expired")
    } })
    const entered = deferred<void>(), release = deferred<void>()
    const load = f.saver.serde.loadsTyped.bind(f.saver.serde)
    vi.spyOn(f.saver.serde, "loadsTyped").mockImplementationOnce(async (type, data) => {
      entered.resolve()
      await release.promise
      return load(type, data)
    })
    const saving = f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)
    const outcome = saving.then(() => undefined, (error: unknown) => error)
    await entered.promise
    const reader = openNativeSqliteDatabase(f.graphPath).database
    cleanups.push(async () => { reader.close() })
    try {
      expect(reader.exec("SELECT checkpoint_id FROM checkpoints")[0].values).toEqual([[checkpoint.id]])
      if (kind === "cancel") f.controller.abort(Error("original scope canceled"))
      else epoch += 1
      // A new capture is live, but it cannot replace the binding already prepared for this COMMIT.
      f.replaceBinding({ ...original, signal: new AbortController().signal })
    } finally { release.resolve() }
    expect(await outcome).toMatchObject({ message: kind === "cancel"
      ? "original scope canceled" : "original binding epoch expired" })
    expect(f.pending()).toBe(1)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values)
      .toEqual([[0]])
    await f.observer.recover(f.config(checkpoint.id), f.binding)
    expect(f.pending()).toBe(0)
  })

  it("rejects foreign native commit receipts and closes ACK admission before a real Saver reopens", async () => {
    const f = fixture(), checkpoint = f.checkpoint(1, f.note())
    const prepared = f.observer.prepare(f.config(), checkpoint)!
    const entered = deferred<SqlJsSaverCommittedCheckpointReceipt>(), release = deferred<void>()
    const saving = f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, async (receipt) => {
      entered.resolve(receipt)
      await release.promise
      f.observer.observed(prepared, receipt)
    })
    const outcome = saving.then(() => undefined, (error: unknown) => error)
    const receipt = await entered.promise
    try {
      expect(() => f.observer.observed(prepared, { ...receipt }))
        .toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
      await f.saver.close()
      await f.saver.initialize()
      expect(() => f.observer.observed(prepared, receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
      expect(f.pending()).toBe(1)
    } finally { release.resolve() }
    expect(await outcome).toMatchObject({ message: "SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED" })
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values).toEqual([[0]])
    await f.observer.recover(f.config(checkpoint.id), f.binding)
    expect(f.pending()).toBe(0)
  })

  it("retains an already committed delivery fact when the caller loses the observer result", async () => {
    const f = fixture(), row = f.note(), checkpoint = f.checkpoint(1, row)
    const prepared = f.observer.prepare(f.config(), checkpoint)!
    const failure = Error("result lost after actual delivery ACK")
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, (receipt) => {
      f.observer.observed(prepared, receipt)
      expect(f.pending()).toBe(0)
      throw failure
    })).rejects.toBe(failure)
    expect(f.pending()).toBe(0)
    expect(f.store.readReceipt(f.target, row.uuid)).toEqual(row)
    expect((await f.saver.getTuple(f.config(checkpoint.id)))?.checkpoint.id).toBe(checkpoint.id)
    await f.observer.recover(f.config(checkpoint.id), f.binding)
    expect(f.database.exec("SELECT checkpoint_id, frontier FROM function_conversation_deliveries")[0].values)
      .toEqual([[checkpoint.id, 1]])
  })
})
