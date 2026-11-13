import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { HumanMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase, NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { FunctionConversationStore, persistPreparedFunctionConversationMembership } from "../db/function-conversation-store"
import { functionConversationNoteMessage } from "../agent/mods-conversation"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { FunctionConversationDeliveryBridge, FUNCTION_CONVERSATION_CHANNEL,
  readFunctionConversationBridgePreparation } from "./function-conversation-delivery"
import { capturePreparedConversationMembership, captureCommittedConversationMembership,
  functionConversationMembershipDigest, readPreparedFunctionConversationCheckpointMembership,
  readFunctionConversationCheckpointMembership, type FunctionConversationCheckpointMembershipProof }
  from "./function-conversation-checkpoint-membership"
import { preparedNativeStorageBytesDigest } from "./function-conversation-canonical-display-worker"
import { SqlJsSaver, readSqlJsSaverPreparedConversationData,
  type SqlJsSaverPreparedCheckpointReceipt } from "./sqljs-saver"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }

function fixture(legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-prepared-data-"))
  const database = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  const incarnation = { token: legacy ? null : randomUUID(), legacyCreatedAt: 1000 }
  database.run("INSERT INTO threads VALUES (?,?,?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: incarnation.token })])
  const store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId: "thread", workspace: directory,
    incarnation, checkpointNamespace: "" }, () => undefined)
  const graphPath = join(directory, "graph.sqlite")
  const saver = new SqlJsSaver(graphPath)
  const controller = new AbortController()
  const bridge = new FunctionConversationDeliveryBridge(store, () => ({ target,
    checkpointThreadId: "thread", signal: controller.signal, assertCurrent: () => undefined }))
  cleanup.push(async () => {
    controller.abort()
    try { await saver.close() } finally { database.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  const content = [{ type: "text" as const, text: "actual note" }]
  const uuid = randomUUID()
  const row = store.commit(target, { uuid, inputDigest: "actual-input", door: "note",
    origin: { kind: "plugin", name: "P" },
    message: { type: "user", role: "user", isMeta: true, content },
    nativePayload: serializeFunctionConversationNativeMessage(new HumanMessage({
      id: uuid, content, additional_kwargs: { isMeta: true } })),
    orderAnchor: { batch: "actual" }, inbox: true, sdk: true }, () => undefined,
  () => undefined, () => undefined)
  const config = (id?: string) => ({ configurable: { thread_id: "thread", checkpoint_ns: "",
    ...(id ? { checkpoint_id: id } : {}) } })
  const message = functionConversationNoteMessage(row, target)
  const checkpoint = (): Checkpoint => ({ v: 1, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages: [message], [FUNCTION_CONVERSATION_CHANNEL]: {
      version: 1, logicalSessionId: target.logicalSessionId, conversationId: target.conversationId,
      branchId: target.branchId, frontier: 1 } }, channel_versions: {}, versions_seen: {} })
  const count = (table: string) => database.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
  return { database, store, saver, target, bridge, config, checkpoint, message, row, count,
    graphPath, controller }
}

describe("actual prepared native checkpoint data", () => {
  it("persists only data before native COMMIT, is idempotent, and never brands a prepared token committed", async () => {
    const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    let receipt: SqlJsSaverPreparedCheckpointReceipt | undefined
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => {
      throw Error("unexpected COMMIT")
    }, undefined, undefined, undefined, async actual => {
      receipt = actual
      await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, actual)
      const snapshot = readPreparedFunctionConversationCheckpointMembership(actual, f.store, f.target)
      expect(snapshot.members).toHaveLength(1)
      expect(() => readFunctionConversationCheckpointMembership(actual as unknown as
        FunctionConversationCheckpointMembershipProof, f.store, f.target)).toThrow("MEMBERSHIP")
      const seal = persistPreparedFunctionConversationMembership(f.store, f.target, actual, () => undefined)
      const changes = f.database.exec("SELECT total_changes()")[0].values[0][0]
      persistPreparedFunctionConversationMembership(f.store, f.target, actual, () => undefined)()
      expect(f.database.exec("SELECT total_changes()")[0].values[0][0]).toBe(changes)
      seal()
      expect(f.count("function_conversation_checkpoint_receipts")).toBe(1)
      expect(f.count("function_conversation_checkpoint_members")).toBe(1)
      expect(f.count("function_conversation_inbox")).toBe(1)
      expect(f.count("function_conversation_deliveries")).toBe(0)
      expect((Reflect.get(f.saver, "db") as NativeSqliteAdapter).exec(
        "SELECT COUNT(*) FROM checkpoints")[0].values).toEqual([[0]])
      throw Error("stop after actual data")
    })).rejects.toThrow("stop after actual data")
    expect(receipt).toBeDefined()
    expect(() => readSqlJsSaverPreparedConversationData(f.saver, receipt!)).toThrow("PREPARED_DATA_INVALID")
    expect(f.count("function_conversation_deliveries")).toBe(0)
  })

  it("keeps both genuine prepared roles and legacy staged-write lookup on own data slots", async () => {
    const f = fixture(), legacy = f.checkpoint()
    const previousData = Object.getOwnPropertyDescriptor(Object.prototype, "data")
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "descriptor")
    const previousWrites = Object.getOwnPropertyDescriptor(Object.prototype, "sourceWrites")
    let getterCalls = 0, wrongData: unknown, wrongDescriptor: unknown, legacyFailure: unknown
    const restore = (key: string, previous: PropertyDescriptor | undefined) => {
      if (previous) Object.defineProperty(Object.prototype, key, previous)
      else Reflect.deleteProperty(Object.prototype, key)
    }
    try {
      await f.saver.putWithCommitObserver(f.config(), legacy, metadata, () => undefined,
        undefined, undefined, receipt => {
          Object.defineProperty(Object.prototype, "data", { configurable: true,
            get() { getterCalls++; throw Error("inherited prepared data") } })
          try { readSqlJsSaverPreparedConversationData(f.saver, receipt) }
          catch (error) { wrongData = error }
          finally { restore("data", previousData) }
          Object.defineProperty(Object.prototype, "sourceWrites", { configurable: true,
            get() { getterCalls++; throw Error("inherited staged writes") } })
        })
    } catch (error) { legacyFailure = error }
    finally { restore("sourceWrites", previousWrites); restore("data", previousData) }
    expect(legacyFailure).toBeUndefined()
    expect(wrongData).toBeInstanceOf(Error)
    expect(String(wrongData)).toContain("PREPARED_DATA_INVALID")
    await expect(f.saver.putWithCommitObserver(f.config(legacy.id), f.checkpoint(), metadata,
      () => undefined, undefined, undefined, undefined, receipt => {
        Object.defineProperty(Object.prototype, "descriptor", { configurable: true,
          get() { getterCalls++; throw Error("inherited legacy descriptor") } })
        try { f.saver.readPreparedCheckpoint(receipt) }
        catch (error) { wrongDescriptor = error }
        finally { restore("descriptor", previousDescriptor) }
        throw Error("qualified role checks")
      })).rejects.toThrow("qualified role checks")
    expect(wrongDescriptor).toBeInstanceOf(Error)
    expect(String(wrongDescriptor)).toContain("PREPARED_RECEIPT_INVALID")
    expect(getterCalls).toBe(0)
    expect(f.count("function_conversation_deliveries")).toBe(0)
  })

  it("joins only the original Bridge, observer, preparation and actual Saver data token", async () => {
    const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
      undefined, undefined, undefined, async receipt => {
        let fakeCalls = 0
        const fakeBridge = { cooperativeObservers: new WeakMap([[observer, { saver: f.saver,
          readPreparation: () => { fakeCalls++; throw Error("fake Bridge data") } }]]) }
        await expect(capturePreparedConversationMembership(fakeBridge as unknown as
          FunctionConversationDeliveryBridge, observer, prepared, f.saver, receipt)).rejects.toThrow()
        const fakeSaver = Object.create(SqlJsSaver.prototype) as SqlJsSaver
        Object.defineProperty(fakeSaver, "preparedCheckpointReceipts", { value: new WeakMap([[receipt,
          { active: true, data: { assertCurrent: () => { fakeCalls++ } } }]]) })
        expect(() => readSqlJsSaverPreparedConversationData(fakeSaver, receipt)).toThrow()
        expect(fakeCalls).toBe(0)
        await expect(capturePreparedConversationMembership(f.bridge, {}, prepared, f.saver, receipt))
          .rejects.toThrow("PROOF")
        await expect(capturePreparedConversationMembership(f.bridge, observer,
          Object.freeze({ ...prepared }), f.saver, receipt)).rejects.toThrow("PROOF")
        await expect(capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver,
          Object.freeze({ ...receipt }))).rejects.toThrow("PREPARED_DATA_INVALID")
        throw Error("qualified rejections")
      })).rejects.toThrow("qualified rejections")
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
  })

  it("rejects foreign keys and reads the genuine data record without late WeakMap.get dispatch", async () => {
    const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
      undefined, undefined, undefined, async receipt => {
        const descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get")!
        let calls = 0
        let actualId: unknown, actualFrontier: unknown, foreignError: unknown
        try {
          Object.defineProperty(WeakMap.prototype, "get", { ...descriptor,
            value: () => { calls++; throw Error("late WeakMap get") } })
          actualId = readSqlJsSaverPreparedConversationData(f.saver, receipt).checkpoint.id
          actualFrontier = readFunctionConversationBridgePreparation(f.bridge, observer, prepared, f.saver).state.frontier
          try { readSqlJsSaverPreparedConversationData(f.saver, Object.freeze({ ...receipt })) }
          catch (error) { foreignError = error }
        } finally { Object.defineProperty(WeakMap.prototype, "get", descriptor) }
        expect(calls).toBe(0)
        expect(actualId).toBe(checkpoint.id)
        expect(actualFrontier).toBe(1)
        expect(foreignError).toBeInstanceOf(Error)
        expect((foreignError as Error).message).toBe("SQLJS_SAVER_PREPARED_DATA_INVALID")
        throw Error("fixed weak-map qualification")
      })).rejects.toThrow("fixed weak-map qualification")
  })

  it("reuses the same prepared receipt data at the actual post-COMMIT ACK", async () => {
    const f = fixture(), checkpoint = f.checkpoint()
    let receiptId: unknown, preparedCalls = 0
    await f.bridge.wrap(f.saver, undefined, undefined, { prepared: () => {
      preparedCalls++
      receiptId = f.database.exec("SELECT receipt_id FROM function_conversation_checkpoint_receipts")[0].values[0][0]
      expect(f.count("function_conversation_deliveries")).toBe(0)
      expect(f.count("function_conversation_inbox")).toBe(1)
    } }).put(f.config(), checkpoint, metadata)
    expect(preparedCalls).toBe(1)
    expect(f.database.exec("SELECT receipt_id FROM function_conversation_checkpoint_receipts")[0].values)
      .toEqual([[receiptId]])
    expect(f.count("function_conversation_checkpoint_members")).toBe(1)
    expect(f.count("function_conversation_deliveries")).toBe(1)
    expect(f.count("function_conversation_inbox")).toBe(0)
  })

  it.each(["canonical", "custom-order"] as const)(
    "keeps prepared and original committed snapshot digests identical for %s cut fields", async order => {
      const f = fixture(), checkpoint = f.checkpoint()
      const original = f.store.captureCheckpointCanonicalCut(f.target, () => undefined)
      const cut = order === "canonical" ? original : Object.freeze({
        lineageDigest: original.lineageDigest, highWater: original.highWater, lineage: original.lineage })
      const observer = f.bridge.bindSaver(f.saver, () => cut)
      const prepared = observer.prepare(f.config(), checkpoint)!
      let preparedJson: string | undefined, preparedDigest: string | undefined
      await f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, receipt => {
        const proof = captureCommittedConversationMembership(f.store, f.saver, receipt, {
          target: f.target, checkpointThreadId: "thread", checkpointIncarnation: f.target.incarnation,
          cut, frontier: 1, stateDigest: functionConversationMembershipDigest(
            checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]), assertCurrent: () => undefined })
        const committed = readFunctionConversationCheckpointMembership(proof, f.store, f.target)
        expect(committed.snapshotDigest).toBe(preparedDigest)
        expect(JSON.stringify(committed)).toBe(preparedJson)
        observer.observed(prepared, receipt)
      }, undefined, undefined, undefined, async receipt => {
        await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, receipt)
        const snapshot = readPreparedFunctionConversationCheckpointMembership(receipt, f.store, f.target)
        preparedJson = JSON.stringify(snapshot)
        preparedDigest = snapshot.snapshotDigest
        persistPreparedFunctionConversationMembership(f.store, f.target, receipt, () => undefined)()
      })
      expect(preparedDigest).toBeDefined()
      expect(f.count("function_conversation_checkpoint_receipts")).toBe(1)
      expect(f.count("function_conversation_deliveries")).toBe(1)
    })

  it("keeps facts and the final AppDB seal in original own slots despite inherited setters", async () => {
    const f = fixture(), checkpoint = f.checkpoint()
    const facts = Object.getOwnPropertyDescriptor(Object.prototype, "facts")
    const seal = Object.getOwnPropertyDescriptor(Object.prototype, "dataSeal")
    let calls = 0
    try {
      for (const key of ["facts", "dataSeal"]) Object.defineProperty(Object.prototype, key, {
        configurable: true, set() { calls++ }
      })
      await f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)
    } finally {
      if (facts) Object.defineProperty(Object.prototype, "facts", facts)
      else Reflect.deleteProperty(Object.prototype, "facts")
      if (seal) Object.defineProperty(Object.prototype, "dataSeal", seal)
      else Reflect.deleteProperty(Object.prototype, "dataSeal")
    }
    expect(calls).toBe(0)
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(1)
    expect(f.count("function_conversation_deliveries")).toBe(1)
    expect(f.count("function_conversation_inbox")).toBe(0)
  })

  it("does not expose its prepared candidate through a late replacement Object.freeze", async () => {
    const f = fixture(), checkpoint = f.checkpoint()
    await f.saver.initialize()
    const descriptor = Object.getOwnPropertyDescriptor(Object, "freeze")!
    let installed = false, candidates = 0, legacyReached = false
    try {
      await f.bridge.wrap(f.saver, () => {
        if (installed) return
        installed = true
        Object.defineProperty(Object, "freeze", { ...descriptor, value: (value: unknown) => {
          if (value && typeof value === "object" && "snapshotDigest" in value && "members" in value)
            candidates++
          return value
        } })
      }, undefined, { prepared: () => {
        Object.defineProperty(Object, "freeze", descriptor)
        legacyReached = true
      } }).put(f.config(), checkpoint, metadata)
    } finally { Object.defineProperty(Object, "freeze", descriptor) }
    expect(legacyReached).toBe(true)
    expect(candidates).toBe(0)
    expect(f.count("function_conversation_deliveries")).toBe(1)
  })

  it("rejects a valid new branch lineage between actual Worker facts and prepared data persistence", async () => {
    const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
      undefined, undefined, undefined, async receipt => {
        await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, receipt)
        const parent = randomUUID()
        f.database.run("INSERT INTO function_conversation_branches VALUES (?,?,NULL,0,NULL,0)",
          [parent, f.target.conversationId])
        f.database.run(`UPDATE function_conversation_branches SET parent_branch_id=?,parent_frontier=0,depth=1
          WHERE branch_id=?`, [parent, f.target.branchId])
        // Identity remains current; the original one-point cut must not acquire this later parent.
        f.store.assertCurrent(f.target)
        persistPreparedFunctionConversationMembership(f.store, f.target, receipt, () => undefined)
      })).rejects.toThrow("MEMBERSHIP")
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
    expect(f.count("function_conversation_deliveries")).toBe(0)
    expect(f.count("function_conversation_inbox")).toBe(1)
  })

  it.each([1.5, Number.POSITIVE_INFINITY])(
    "rejects a non-integral or unbounded next_sequence %s at the native cut seal", async sequence => {
      const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
      const prepared = observer.prepare(f.config(), checkpoint)!
      await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
        undefined, undefined, undefined, async receipt => {
          await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, receipt)
          f.database.run("UPDATE function_conversations SET next_sequence=? WHERE conversation_id=?",
            [sequence, f.target.conversationId])
          persistPreparedFunctionConversationMembership(f.store, f.target, receipt, () => undefined)
        })).rejects.toThrow("MEMBERSHIP")
      expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
      expect(f.count("function_conversation_deliveries")).toBe(0)
    })

  it("rejects a different actual legacy epoch even when late Number maps it to the stale target", async () => {
    const f = fixture(true), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    const number = Object.getOwnPropertyDescriptor(globalThis, "Number")!
    const original = Number
    let actualFacts = false
    try {
      f.database.run("UPDATE threads SET created_at=2000 WHERE thread_id='thread'")
      Object.defineProperty(globalThis, "Number", { ...number, value: new Proxy(original, {
        apply(target, receiver, args) {
          return args[0] === 2000 ? 1000 : Reflect.apply(target, receiver, args)
        }
      }) })
      await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
        undefined, undefined, undefined, async receipt => {
          await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, receipt)
          actualFacts = true
          persistPreparedFunctionConversationMembership(f.store, f.target, receipt, () => undefined)
        })).rejects.toThrow("MEMBERSHIP")
    } finally { Object.defineProperty(globalThis, "Number", number) }
    expect(actualFacts).toBe(true)
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
    expect(f.count("function_conversation_deliveries")).toBe(0)
    expect(f.count("function_conversation_inbox")).toBe(1)
  })

  it("rejects an inherited Array toJSON ancestor before its getter can run or restore itself", async () => {
    const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    const prototype = Object.getPrototypeOf(Array.prototype)
    let calls = 0
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
      undefined, undefined, undefined, async receipt => {
        let rejection: unknown
        const ancestor = new Proxy(Object.create(prototype), { get(target, key, receiver) {
          if (key === "toJSON") {
            calls++
            Object.setPrototypeOf(Array.prototype, prototype)
            return undefined
          }
          return Reflect.get(target, key, receiver)
        } })
        try {
          Object.setPrototypeOf(Array.prototype, ancestor)
          try { await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, receipt) }
          catch (error) { rejection = error }
        } finally { Object.setPrototypeOf(Array.prototype, prototype) }
        expect(rejection).toBeInstanceOf(Error)
        expect((rejection as Error).message).toBe("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
        expect(calls).toBe(0)
        throw Error("qualified Array ancestor rejection")
      })).rejects.toThrow("qualified Array ancestor rejection")
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
  })

  it.each(["receipt", "member", "row"] as const)(
    "rejects %s tampering after data persistence and before native COMMIT", async mutation => {
      const f = fixture(), checkpoint = f.checkpoint()
      await expect(f.bridge.wrap(f.saver, undefined, undefined, { prepared: () => {
        if (mutation === "receipt") f.database.run("DELETE FROM function_conversation_checkpoint_receipts")
        else if (mutation === "member") f.database.run("DELETE FROM function_conversation_checkpoint_members")
        else f.database.run("UPDATE function_conversation_rows SET input_digest='changed'")
      } }).put(f.config(), checkpoint, metadata)).rejects.toThrow("MEMBERSHIP")
      expect(f.count("function_conversation_deliveries")).toBe(0)
      expect(f.count("function_conversation_inbox")).toBe(1)
      expect((Reflect.get(f.saver, "db") as NativeSqliteAdapter).exec(
        "SELECT COUNT(*) FROM checkpoints")[0].values).toEqual([[0]])
    })

  it.each(["uppercase-temp", "fourth-table-trigger"] as const)(
    "rejects %s before any native CP mutation", async mutation => {
      const f = fixture(), checkpoint = f.checkpoint()
      await expect(f.bridge.wrap(f.saver, undefined, undefined, { prepared: () => {
        const database = Reflect.get(f.saver, "db") as NativeSqliteAdapter
        database.run(mutation === "uppercase-temp" ? "CREATE TEMP TABLE CHECKPOINTS(value)" :
          "CREATE TRIGGER corrupt_runtime AFTER INSERT ON checkpoint_runtime_projections BEGIN DELETE FROM checkpoints; END")
      } }).put(f.config(), checkpoint, metadata)).rejects.toThrow("PREPARED_SCHEMA_UNSUPPORTED")
      expect(f.count("function_conversation_deliveries")).toBe(0)
    })

  it.each(["main-trigger", "temp-trigger", "temp-shadow"] as const)(
    "rejects prepared AppDB %s before it can delete inbox or create a delivery", async mutation => {
      const f = fixture(), checkpoint = f.checkpoint()
      if (mutation === "temp-shadow") f.database.run(
        "CREATE TEMP TABLE FUNCTION_CONVERSATION_CHECKPOINT_RECEIPTS(value)")
      else f.database.run(`CREATE ${mutation === "temp-trigger" ? "TEMP " : ""}TRIGGER corrupt_data
        AFTER INSERT ON main.function_conversation_checkpoint_receipts
        BEGIN DELETE FROM function_conversation_inbox; END`)
      await expect(f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)).rejects.toThrow("MEMBERSHIP")
      expect(f.count("function_conversation_inbox")).toBe(1)
      expect(f.count("function_conversation_deliveries")).toBe(0)
      expect(f.database.exec("SELECT COUNT(*) FROM main.function_conversation_checkpoint_receipts")[0].values)
        .toEqual([[0]])
    })

  it("uses the original native window and lifetime after the host guard replaces their prototype methods", async () => {
    const f = fixture(), checkpoint = f.checkpoint()
    const window = Object.getOwnPropertyDescriptor(SqlJsSaver.prototype, "prepareNativeDataWindow")!
    const lifetime = Object.getOwnPropertyDescriptor(SqlJsSaver.prototype, "captureReadLifetime")!
    let replaced = false, fakeCalls = 0
    try {
      await expect(f.bridge.wrap(f.saver, () => {
        if (replaced) return
        replaced = true
        Object.defineProperty(SqlJsSaver.prototype, "prepareNativeDataWindow", { ...window,
          value: () => { fakeCalls++; return { assertCurrent() {}, assertRaw() {} } } })
        Object.defineProperty(SqlJsSaver.prototype, "captureReadLifetime", { ...lifetime,
          value: () => { fakeCalls++; return () => undefined } })
      }, undefined, { prepared: () => {
        ;(Reflect.get(f.saver, "db") as NativeSqliteAdapter).run("CREATE TEMP TABLE CHECKPOINTS(value)")
      } }).put(f.config(), checkpoint, metadata)).rejects.toThrow("PREPARED_SCHEMA_UNSUPPORTED")
      expect(replaced).toBe(true)
      expect(fakeCalls).toBe(0)
    } finally {
      Object.defineProperty(SqlJsSaver.prototype, "prepareNativeDataWindow", window)
      Object.defineProperty(SqlJsSaver.prototype, "captureReadLifetime", lifetime)
    }
  })

  it("rejects same-generation prefix bytes changed by the original prepared callback", async () => {
    const f = fixture(), first = f.checkpoint()
    await f.bridge.wrap(f.saver).put(f.config(), first, metadata)
    const second = f.checkpoint()
    await expect(f.bridge.wrap(f.saver, undefined, undefined, { prepared: () => {
      const database = Reflect.get(f.saver, "db") as NativeSqliteAdapter
      database.run("UPDATE checkpoint_message_snapshots SET suffix='[]' WHERE checkpoint_id=?", [first.id])
    } }).put(f.config(first.id), second, metadata)).rejects.toThrow("PREPARED_SOURCE_CHANGED")
    expect((Reflect.get(f.saver, "db") as NativeSqliteAdapter).exec(
      "SELECT COUNT(*) FROM main.checkpoints WHERE checkpoint_id=?", [second.id])[0].values).toEqual([[0]])
  })

  it("keeps the original parent rebase and calls the legacy prepared hook only once", async () => {
    const f = fixture(), first = f.checkpoint()
    await f.bridge.wrap(f.saver).put(f.config(), first, metadata)
    const second = f.checkpoint()
    let calls = 0
    await f.bridge.wrap(f.saver, undefined, undefined, { prepared: () => {
      calls++
      const database = Reflect.get(f.saver, "db") as NativeSqliteAdapter
      database.run("UPDATE checkpoint_message_snapshots SET generation=generation||'-changed' WHERE checkpoint_id=?", [first.id])
    } }).put(f.config(first.id), second, metadata)
    expect(calls).toBe(1)
    expect((await f.saver.getTuple(f.config(second.id)))?.checkpoint.channel_values.messages).toHaveLength(1)
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(2)
  })

  it("keeps a Bridge checkpoint without conversation state on the original ordinary path", async () => {
    const f = fixture(), checkpoint = f.checkpoint()
    delete checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
    await f.saver.initialize()
    const database = Reflect.get(f.saver, "db") as NativeSqliteAdapter
    database.run("CREATE TABLE ordinary_audit(value)")
    database.run(`CREATE TRIGGER ordinary_projection AFTER INSERT ON checkpoint_runtime_projections
      BEGIN INSERT INTO ordinary_audit VALUES (1); END`)
    const changes = f.database.exec("SELECT total_changes()")[0].values[0][0]
    await f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata)
    expect(database.exec("SELECT COUNT(*) FROM ordinary_audit")[0].values).toEqual([[1]])
    expect(f.database.exec("SELECT total_changes()")[0].values[0][0]).toBe(changes)
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
    expect(f.count("function_conversation_inbox")).toBe(1)
  })

  it("uses fixed prepared writes and parent reads while preserving ordinary post-COMMIT dispatch", async () => {
    const f = fixture(), first = f.checkpoint()
    await f.bridge.wrap(f.saver).put(f.config(), first, metadata)
    const second = f.checkpoint(), graph = Reflect.get(f.saver, "db") as NativeSqliteAdapter
    const originalRun = NativeSqliteAdapter.prototype.run, originalExec = NativeSqliteAdapter.prototype.exec
    let sealed = false, committed = false, callbacks = 0
    const run = vi.spyOn(NativeSqliteAdapter.prototype, "run").mockImplementation(function (
      this: NativeSqliteAdapter, ...args: Parameters<NativeSqliteAdapter["run"]>) {
      if (!committed && (this === f.database || this === graph && sealed)) {
        callbacks++
        throw Error("unexpected public prepared write")
      }
      return Reflect.apply(originalRun, this, args)
    })
    const exec = vi.spyOn(NativeSqliteAdapter.prototype, "exec").mockImplementation(function (
      this: NativeSqliteAdapter, ...args: Parameters<NativeSqliteAdapter["exec"]>) {
      if (this === graph && sealed && !committed) {
        callbacks++
        throw Error("unexpected public prepared parent read")
      }
      return Reflect.apply(originalExec, this, args)
    })
    try {
      await f.bridge.wrap(f.saver, undefined, () => { committed = true }, {
        prepared: () => { sealed = true }
      }).put(f.config(first.id), second, metadata)
    } finally { run.mockRestore(); exec.mockRestore() }
    expect(sealed).toBe(true)
    expect(committed).toBe(true)
    expect(callbacks).toBe(0)
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(2)
    expect(f.count("function_conversation_deliveries")).toBe(2)
  })

  it("qualifies the parent read after the final Host callback before a schema JS function can run", async () => {
    const f = fixture(), first = f.checkpoint()
    await f.bridge.wrap(f.saver).put(f.config(), first, metadata)
    const graph = Reflect.get(f.saver, "db") as NativeSqliteAdapter
    expect(graph.exec("SELECT message_count FROM main.checkpoint_message_snapshots WHERE checkpoint_id=?",
      [first.id])[0].values).toEqual([[1]])
    const second = f.checkpoint()
    expect((second.channel_values.messages as HumanMessage[])[0])
      .toBe((first.channel_values.messages as HumanMessage[])[0])
    let armed = false, changed = false, callbacks = 0
    const native = Reflect.get(graph, "native") as { function(name: string, fn: (value: number) => number): void }
    native.function("prepared_parent_udf", value => { callbacks++; return value })
    const guard = () => {
      if (!armed || changed) return
      changed = true
      graph.run("PRAGMA trusted_schema=ON")
      graph.run("ALTER TABLE checkpoint_message_snapshots RENAME TO owned_parent_snapshot")
      graph.run(`CREATE VIEW checkpoint_message_snapshots AS SELECT thread_id,checkpoint_ns,
        checkpoint_id,parent_checkpoint_id,prefix_length,prepared_parent_udf(message_count) AS message_count,
        generation,type,suffix FROM owned_parent_snapshot`)
    }
    try {
      await expect(f.bridge.wrap(f.saver, guard, undefined, { prepared: receipt => {
        expect(f.saver.readPreparedCheckpoint(receipt).parentCheckpointId).toBe(first.id)
        armed = true
      } }).put(f.config(first.id), second, metadata)).rejects.toThrow("schema trust")
    } finally {
      if (changed) {
        graph.run("DROP VIEW main.checkpoint_message_snapshots")
        graph.run("ALTER TABLE owned_parent_snapshot RENAME TO checkpoint_message_snapshots")
      }
    }
    expect(changed).toBe(true)
    expect(callbacks).toBe(0)
    expect(graph.exec("SELECT COUNT(*) FROM main.checkpoints WHERE checkpoint_id=?",
      [second.id])[0].values).toEqual([[0]])
    expect(f.count("function_conversation_deliveries")).toBe(1)
  })

  it("does not borrow an existing prepared index from an outer uncommitted AppDB transaction", async () => {
    const f = fixture(), checkpoint = f.checkpoint(), observer = f.bridge.bindSaver(f.saver)
    const prepared = observer.prepare(f.config(), checkpoint)!
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata, () => undefined,
      undefined, undefined, undefined, async receipt => {
        await capturePreparedConversationMembership(f.bridge, observer, prepared, f.saver, receipt)
        const seal = persistPreparedFunctionConversationMembership(f.store, f.target, receipt, () => undefined)
        f.database.run("BEGIN IMMEDIATE")
        try {
          expect(() => persistPreparedFunctionConversationMembership(f.store, f.target, receipt,
            () => undefined)).toThrow("autocommit")
          expect(() => seal()).toThrow("autocommit")
        } finally { f.database.run("ROLLBACK") }
        seal()
        throw Error("qualified outer transaction rejection")
      })).rejects.toThrow("qualified outer transaction rejection")
    expect(f.count("function_conversation_checkpoint_receipts")).toBe(1)
    expect(f.count("function_conversation_deliveries")).toBe(0)
    expect(f.count("function_conversation_inbox")).toBe(1)
  })

  it.each(["mutate-bytes", "release-batch"] as const)(
    "rejects the last source callback %s before any native destination or staged write commits", async attack => {
      const f = fixture(), sourceCheckpoint = f.checkpoint()
      delete sourceCheckpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
      const sourceConfig = await f.saver.put(f.config(), sourceCheckpoint, metadata)
      const source = await f.saver.readCompactionCheckpoint(sourceConfig)
      if (!source) throw Error("actual source required")
      let armed = false, attacked = false
      let boundFrozen: boolean[] = [], lateFreezeInstalled = false, mapped = 0, descriptorGetters = 0
      const batch = f.saver.createCompactionWriteBatch(sourceConfig, () => {
        source.assertCurrent()
        if (!armed || attacked) return
        attacked = true
        if (attack === "release-batch") f.saver.releaseCompactionWriteBatch(batch)
        else {
          const records = Reflect.get(f.saver, "compactionWriteBatches") as WeakMap<object, {
            operations: { taskId: string; rows: { idx: number; channel: string; type: string;
              value: Uint8Array; bytesDigest: string }[] }[];
            descriptor: NonNullable<ReturnType<SqlJsSaver["readCommittedCompactionWrites"]>>
          }>
          const record = records.get(batch)!, row = record.operations[0].rows[0]
          expect(row.value).toBeInstanceOf(Uint8Array)
          row.value[0] ^= 1
          row.bytesDigest = preparedNativeStorageBytesDigest(row.value)
          // Both mutable checksums are forged; the put must retain the original descriptor.
          record.descriptor = Object.freeze({ ...record.descriptor,
            operations: Object.freeze([{ taskId: record.operations[0].taskId,
              rows: Object.freeze([Object.freeze({ idx: row.idx, channel: row.channel,
                type: row.type, bytesDigest: row.bytesDigest })]) }]) })
        }
      })
      await f.saver.stageCompactionWrites(batch, sourceConfig, [["messages", "actual staged body"]], "actual-task")
      const destination = f.checkpoint()
      try {
        await expect(f.bridge.wrap(f.saver, undefined, undefined, { prepared: receipt => {
          const originalFreeze = Object.getOwnPropertyDescriptor(Object, "freeze")!
          const originalMap = Object.getOwnPropertyDescriptor(Array.prototype, "map")!
          const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "descriptor")
          const actual = (Reflect.get(f.saver, "compactionWriteBatches") as WeakMap<object,
            { operations: { rows: unknown[] }[] }>).get(batch)!
          try {
            Object.defineProperty(Array.prototype, "map", { ...originalMap,
              value: function (this: unknown[], ...args: unknown[]) {
                if (this === actual.operations || this === actual.operations[0].rows) {
                  mapped++
                  return new Proxy([], { get() { throw Error("fake descriptor map") } })
                }
                return Reflect.apply(originalMap.value, this, args)
              } })
            Object.defineProperty(Object.prototype, "descriptor", { configurable: true,
              get() { descriptorGetters++; throw Error("inherited batch descriptor") } })
            Object.defineProperty(Object, "freeze", { ...originalFreeze, value: (value: unknown) => value })
            lateFreezeInstalled = true
            const descriptor = f.saver.bindPreparedCompactionWrites(receipt, batch)
            boundFrozen = [Object.isFrozen(descriptor), Object.isFrozen(descriptor.operations),
              Object.isFrozen(descriptor.operations[0]), Object.isFrozen(descriptor.operations[0].rows),
              Object.isFrozen(descriptor.operations[0].rows[0])]
          } finally {
            Object.defineProperty(Object, "freeze", originalFreeze)
            Object.defineProperty(Array.prototype, "map", originalMap)
            if (originalDescriptor) Object.defineProperty(Object.prototype, "descriptor", originalDescriptor)
            else Reflect.deleteProperty(Object.prototype, "descriptor")
          }
          armed = true
        } }).put(sourceConfig, destination, metadata)).rejects.toThrow("COMPACTION_BATCH_INVALID")
      } finally { f.saver.releaseCompactionWriteBatch(batch) }
      expect(lateFreezeInstalled).toBe(true)
      expect(boundFrozen).toEqual([true, true, true, true, true])
      expect(mapped).toBe(0)
      expect(descriptorGetters).toBe(0)
      expect(attacked).toBe(true)
      const graph = Reflect.get(f.saver, "db") as NativeSqliteAdapter
      expect(graph.exec("SELECT COUNT(*) FROM main.checkpoints WHERE checkpoint_id=?",
        [destination.id])[0].values).toEqual([[0]])
      expect(graph.exec("SELECT COUNT(*) FROM main.writes WHERE checkpoint_id=?",
        [sourceCheckpoint.id])[0].values).toEqual([[0]])
      expect(f.count("function_conversation_checkpoint_receipts")).toBe(1)
      expect(f.count("function_conversation_deliveries")).toBe(0)
      expect(f.count("function_conversation_inbox")).toBe(1)
    })

  it.each(["before-source", "after-source"] as const)(
    "passes the actual binding abort signal %s and holds the put until the real Worker final", async phase => {
      const f = fixture(), checkpoint = f.checkpoint()
      await f.saver.initialize()
      const actualPath = (Reflect.get(f.saver, "databaseIdentity") as { path: string }).path
      const original = Worker.prototype.postMessage
      let ownedRequest: Readonly<{ worker: Worker; requestId: number }> | undefined
      let bodyPosts = 0, aborted = false
      const events: string[] = []
      const observe = (frame: { type?: unknown; requestId?: unknown }) => {
        if (frame.type === "prepared-native-data-result" && frame.requestId === ownedRequest?.requestId)
          events.push("physical-final")
      }
      const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker, ...args: Parameters<Worker["postMessage"]>) {
        const frame = args[0] as { type?: unknown; databasePath?: unknown; requestId?: unknown; ok?: unknown }
        if (frame?.type === "prepared-native-data" && frame.databasePath === actualPath &&
          typeof frame.requestId === "number") {
          ownedRequest = { worker: this, requestId: frame.requestId }
          this.on("message", observe)
        }
        const owned = ownedRequest !== undefined && this === ownedRequest.worker &&
          frame?.requestId === ownedRequest.requestId
        if (owned && frame.type === "prepared-native-source-response" && frame.ok === true) bodyPosts++
        const returned = Reflect.apply(original, this, args)
        if (owned && !aborted && (phase === "before-source" && frame.type === "prepared-native-data" ||
          phase === "after-source" && frame.type === "prepared-native-source-response" && frame.ok === true)) {
          aborted = true
          f.controller.abort(Error("actual binding abort"))
        }
        return returned
      })
      try {
        await expect(f.bridge.wrap(f.saver).put(f.config(), checkpoint, metadata).catch(error => {
          events.push("put-rejected")
          throw error
        })).rejects.toThrow()
      } finally {
        spy.mockRestore()
        ownedRequest?.worker.off("message", observe)
      }
      expect(aborted).toBe(true)
      expect(bodyPosts).toBe(phase === "before-source" ? 0 : 1)
      expect(events).toEqual(["physical-final", "put-rejected"])
      expect(f.count("function_conversation_checkpoint_receipts")).toBe(0)
      expect(f.count("function_conversation_deliveries")).toBe(0)
      expect(f.count("function_conversation_inbox")).toBe(1)
      expect((Reflect.get(f.saver, "db") as NativeSqliteAdapter).exec(
        "SELECT COUNT(*) FROM main.checkpoints")[0].values).toEqual([[0]])
    })
})
