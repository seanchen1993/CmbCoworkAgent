import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { HumanMessage } from "@langchain/core/messages"
import { emptyCheckpoint, type Checkpoint, type CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { SqlJsSaver } from "./sqljs-saver"

let root: string
let saver: SqlJsSaver
let path: string
const threadId = "actual-shared-read-thread", namespace = "actual-child:namespace"
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmb-shared-pending-read-"))
  path = join(root, "checkpoint.sqlite")
  saver = new SqlJsSaver(path)
})
afterEach(async () => {
  await saver.close()
  if (!basename(root).startsWith("cmb-shared-pending-read-")) throw Error("UNOWNED_TEST_ROOT")
  rmSync(root, { recursive: true, force: true })
})
const state = { version: 1, logicalSessionId: "session", conversationId: "child", branchId: "branch", frontier: 1 }
async function pending(seed = "actual ordinary seed") {
  const checkpoint: Checkpoint = { ...emptyCheckpoint(), id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages: [new HumanMessage({ id: "seed", content: seed })] } }
  const config = { configurable: { thread_id: threadId, checkpoint_ns: namespace } }
  await saver.put(config, checkpoint, { source: "loop", step: 1, parents: {} })
  const exact = { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } }
  await saver.putWrites(exact, [["cmbFunctionConversation", state],
    ["messages", [new HumanMessage({ id: "note", content: "actual saved note" })]],
    ["branch:to:model_request", null]], "actual-original-task")
  return exact
}
function mutate(work: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path)
  try { work(database) } finally { database.close() }
}

describe("Shared pending checkpoint data reader", () => {
  it("retains the one actual SDK tuple and all namespace rows without minting membership", async () => {
    const config = await pending()
    mutate(database => database.prepare(`INSERT INTO writes
      (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value) VALUES (?,?,?,?,?,?,?,?)`)
      .run(threadId, namespace, "older-orphan", "old-task", 0, "branch:to:before_model", "json", "null"))
    const read = await saver.getTupleForSharedConversation(config)
    expect(read.tuple?.checkpoint.id).toBe(config.configurable.checkpoint_id)
    expect(read.tuple?.pendingWrites).toHaveLength(3)
    expect(read.pendingNamespace?.writes).toHaveLength(4)
    expect(read.pendingNamespace?.writes.some(row => row.checkpointId === "older-orphan")).toBe(true)
    expect(read.pendingNamespace?.writes.filter(row => row.checkpointId === config.configurable.checkpoint_id)
      .every(row => row.taskId === "actual-original-task")).toBe(true)
    await read.pendingNamespace!.revalidateAdmissionCurrent()
  })

  it("rejects selected-source mutation while retaining the original actual input object", async () => {
    const config = await pending(), read = await saver.getTupleForSharedConversation(config)
    const actual = read.tuple!.pendingWrites![0][2]
    mutate(database => database.prepare(`UPDATE writes SET value='null'
      WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND channel='cmbFunctionConversation'`)
      .run(threadId, namespace, config.configurable.checkpoint_id))
    expect(() => read.pendingNamespace!.assertAdmissionCurrent()).toThrow("SHARED_SOURCE_CHANGED")
    expect(read.tuple!.pendingWrites![0][2]).toBe(actual)
    expect(() => read.pendingNamespace!.assertInputDataCurrent()).not.toThrow()
  })

  it.each(["append", "replace"] as const)("rejects same-array raw message %s", async mutation => {
    const config = await pending(), read = await saver.getTupleForSharedConversation(config)
    const messages = read.tuple!.checkpoint.channel_values.messages as HumanMessage[]
    if (mutation === "append") messages.push(new HumanMessage("foreign"))
    else messages[0] = new HumanMessage({ id: messages[0].id, content: messages[0].content })
    expect(() => read.pendingNamespace!.assertInputDataCurrent()).toThrow("SHARED_SOURCE_CHANGED")
  })

  it("rejects a same-value checkpoint getter without executing it", async () => {
    const config = await pending(), read = await saver.getTupleForSharedConversation(config)
    const checkpoint = read.tuple!.checkpoint
    let calls = 0
    Object.defineProperty(read.tuple!, "checkpoint", { configurable: true,
      get() { calls++; return checkpoint } })
    expect(() => read.pendingNamespace!.assertInputDataCurrent()).toThrow("SHARED_SOURCE_CHANGED")
    expect(calls).toBe(0)
  })

  it.each(["same-file-handle", "generation"] as const)(
    "rejects original %s replacement before the actual tuple continuation", async mutation => {
      const config = await pending()
      const target = saver as unknown as { db: NativeSqliteAdapter; commitObserverGeneration: number
        getTupleUnlocked(...args: unknown[]): Promise<CheckpointTuple | undefined> }
      const originalHandle = target.db, originalGeneration = target.commitObserverGeneration
      const other = mutation === "same-file-handle" ? openNativeSqliteDatabase(path).database : undefined
      const original = target.getTupleUnlocked
      let switched = false
      const spy = vi.spyOn(target, "getTupleUnlocked").mockImplementation(async function (...args) {
        const tuple = await Reflect.apply(original, target, args)
        expect(tuple?.checkpoint.id).toBe(config.configurable.checkpoint_id)
        switched = true
        if (other) target.db = other
        else target.commitObserverGeneration++
        return tuple
      })
      try {
        await expect(saver.getTupleForSharedConversation(config)).rejects.toThrow("SQLJS_SAVER_SHARED_SOURCE_CHANGED")
        expect(switched).toBe(true)
      } finally {
        target.db = originalHandle
        target.commitObserverGeneration = originalGeneration
        spy.mockRestore()
        other?.close({ checkpoint: false })
      }
    })

  it("allows unrelated namespace writes during the short source fence", async () => {
    const config = await pending(), read = await saver.getTupleForSharedConversation(config)
    await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: "other-namespace" } },
      { ...emptyCheckpoint(), id: randomUUID(), ts: new Date().toISOString(), channel_values: {} },
      { source: "loop", step: 0, parents: {} })
    expect(() => read.pendingNamespace!.assertAdmissionCurrent()).not.toThrow()
  })

  it("does not borrow a warm same-generation external-message suffix", async () => {
    const config = await pending("Q".repeat(96 * 1024))
    await saver.getTuple(config)
    const [type, bytes] = await saver.serde.dumpsTyped([
      new HumanMessage({ id: "seed", content: "R".repeat(96 * 1024) })])
    mutate(database => database.prepare(`UPDATE checkpoint_message_snapshots SET type=?,suffix=?
      WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
      .run(type, bytes, threadId, namespace, config.configurable.checkpoint_id))
    const read = await saver.getTupleForSharedConversation(config)
    const messages = read.tuple!.checkpoint.channel_values.messages as HumanMessage[]
    expect(messages[0].content).toBe("R".repeat(96 * 1024))
    const [, changed] = await saver.serde.dumpsTyped([
      new HumanMessage({ id: "seed", content: "S".repeat(96 * 1024) })])
    mutate(database => database.prepare(`UPDATE checkpoint_message_snapshots SET suffix=?
      WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
      .run(changed, threadId, namespace, config.configurable.checkpoint_id))
    expect(() => read.pendingNamespace!.assertAdmissionCurrent()).toThrow("SHARED_SOURCE_CHANGED")
    expect(messages[0].content).toBe("R".repeat(96 * 1024))
  })

  it("rejects extra large namespace payloads before decoding them", async () => {
    const config = await pending()
    mutate(database => database.prepare(`INSERT INTO writes
      (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value)
      VALUES (?,?,?,?,?,?,?,zeroblob(67108865))`)
      .run(threadId, namespace, "old-orphan", "old-task", 0, "messages", "json"))
    await expect(saver.getTupleForSharedConversation(config)).rejects.toThrow("SHARED_SOURCE_CHANGED")
  })

  it("does not scan unrelated pending payloads for the complete history branch", async () => {
    const checkpoint: Checkpoint = { ...emptyCheckpoint(), id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { cmbFunctionConversation: state, messages: [] } }
    const config = { configurable: { thread_id: threadId, checkpoint_ns: namespace } }
    await saver.put(config, checkpoint, { source: "loop", step: 1, parents: {} })
    mutate(database => database.prepare(`INSERT INTO writes
      (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value) VALUES (?,?,?,?,?,?,?,?)`)
      .run(threadId, namespace, "old-orphan", "old-task", 0, "messages", "not-a-codec", "invalid"))
    const read = await saver.getTupleForSharedConversation(config)
    expect(read.pendingNamespace).toBeUndefined()
    expect(read.tuple?.checkpoint.channel_values.cmbFunctionConversation).toEqual(state)
  })

  it("rejects uncommitted pending input and reads the original point after owned rollback", async () => {
    const config = await pending()
    const database = Reflect.get(saver, "db") as NativeSqliteAdapter
    database.run("BEGIN IMMEDIATE")
    try {
      database.run(`UPDATE main.writes SET value=? WHERE thread_id=? AND checkpoint_ns=?
        AND checkpoint_id=? AND channel='cmbFunctionConversation'`,
      [JSON.stringify({ ...state, frontier: 2 }), threadId, namespace, config.configurable.checkpoint_id])
      expect(database.exec(`SELECT value FROM main.writes WHERE thread_id=? AND checkpoint_ns=?
        AND checkpoint_id=? AND channel='cmbFunctionConversation'`,
      [threadId, namespace, config.configurable.checkpoint_id])[0].values)
        .toEqual([[JSON.stringify({ ...state, frontier: 2 })]])
      await expect(saver.getTupleForSharedConversation(config)).rejects.toThrow("requires autocommit")
      expect(Reflect.get(saver, "db")).toBe(database)
    } finally { database.run("ROLLBACK") }
    expect(Reflect.get(saver, "db")).toBe(database)
    const read = await saver.getTupleForSharedConversation(config)
    expect(read.pendingNamespace?.writes).toHaveLength(3)
    expect(read.tuple?.pendingWrites?.find(row => row[1] === "cmbFunctionConversation")?.[2]).toEqual(state)
    expect(Reflect.get(saver, "db")).toBe(database)
    expect(() => read.pendingNamespace!.assertAdmissionCurrent()).not.toThrow()
  })

  it("keeps the actual raw checkpoint row in an own slot without inherited accessors", async () => {
    const config = await pending()
    const database = Reflect.get(saver, "db") as NativeSqliteAdapter
    const target = saver as unknown as {
      getTupleUnlocked(...args: unknown[]): Promise<CheckpointTuple | undefined>
    }
    const original = target.getTupleUnlocked
    const ownDescriptor = Object.getOwnPropertyDescriptor, define = Object.defineProperty,
      remove = Reflect.deleteProperty
    let entered = false, callbacks = 0
    const spy = vi.spyOn(target, "getTupleUnlocked").mockImplementation(async function (...args) {
      entered = true
      const previous = ownDescriptor(Object.prototype, "row")
      define(Object.prototype, "row", { configurable: true,
        get() { callbacks++; return undefined }, set() { callbacks++ } })
      try { return await Reflect.apply(original, target, args) }
      finally {
        if (previous) define(Object.prototype, "row", previous)
        else remove(Object.prototype, "row")
      }
    })
    let read: Awaited<ReturnType<SqlJsSaver["getTupleForSharedConversation"]>>
    try { read = await saver.getTupleForSharedConversation(config) }
    finally { spy.mockRestore() }
    expect(entered).toBe(true)
    expect(callbacks).toBe(0)
    expect(read.tuple?.checkpoint.id).toBe(config.configurable.checkpoint_id)
    expect(read.tuple?.pendingWrites).toHaveLength(3)
    expect(read.pendingNamespace?.writes).toHaveLength(3)
    await read.pendingNamespace!.revalidateAdmissionCurrent()
    expect(Reflect.get(saver, "db")).toBe(database)
    await saver.close()
    expect(Reflect.get(saver, "db")).toBeNull()
  })

  it("never reopens a closed Saver from a captured admission fence", async () => {
    const config = await pending(), read = await saver.getTupleForSharedConversation(config)
    await saver.close()
    expect(Reflect.get(saver, "db")).toBeNull()
    expect(() => read.pendingNamespace!.assertAdmissionCurrent()).toThrow("SQLJS_SAVER_SHARED_SOURCE_CHANGED")
    expect(Reflect.get(saver, "db")).toBeNull()
    await expect(read.pendingNamespace!.revalidateAdmissionCurrent()).rejects.toThrow("SQLJS_SAVER_SHARED_SOURCE_CHANGED")
    expect(Reflect.get(saver, "db")).toBeNull()
  })
})
