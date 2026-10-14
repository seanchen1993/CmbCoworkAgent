import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { FunctionConversationStore, type FunctionConversationRow,
  type FunctionConversationTranscriptWriter } from "../db/function-conversation-store"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { functionConversationNoteMessage } from "../agent/mods-conversation"
import { FunctionConversationDeliveryBridge, FUNCTION_CONVERSATION_CHANNEL,
  type FunctionConversationDeliveryBinding } from "./function-conversation-delivery"
import { functionConversationCanonicalStamp } from "./function-conversation-checkpoint-membership"
import { SqlJsSaver } from "./sqljs-saver"
import { CheckpointSnapshotInterpretations } from "../db/checkpoint-snapshot-interpretation"

// Capture native get before the adapter does, counting executions rather than prepares.
const memberSqlProbe = vi.hoisted(() => ({ enabled: false, calls: 0, queries: [] as string[],
  afterGet: undefined as ((sql: string) => void) | undefined,
  restore: undefined as (() => void) | undefined }))
vi.mock("node:sqlite", async importOriginal => {
  const actual = await importOriginal<typeof import("node:sqlite")>()
  const statements = new WeakMap<object, string>()
  const prepareDescriptor = Object.getOwnPropertyDescriptor(actual.DatabaseSync.prototype, "prepare")!
  const prepare = actual.DatabaseSync.prototype.prepare
  Object.defineProperty(actual.DatabaseSync.prototype, "prepare", { ...prepareDescriptor,
    value: function(this: import("node:sqlite").DatabaseSync, sql: string) {
      const statement = Reflect.apply(prepare, this, [sql])
      statements.set(statement, sql)
      return statement
    } })
  const prototype = actual.StatementSync.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "get")!
  const get = prototype.get
  Object.defineProperty(prototype, "get", { ...descriptor, value: function(
    this: import("node:sqlite").StatementSync, ...args: unknown[]) {
    if (memberSqlProbe.enabled) {
      memberSqlProbe.calls++
      memberSqlProbe.queries.push(statements.get(this) ?? "UNKNOWN")
    }
    const result = Reflect.apply(get, this, args)
    memberSqlProbe.afterGet?.(statements.get(this) ?? "UNKNOWN")
    return result
  } })
  memberSqlProbe.restore = () => {
    Object.defineProperty(prototype, "get", descriptor)
    Object.defineProperty(actual.DatabaseSync.prototype, "prepare", prepareDescriptor)
  }
  return actual
})
afterAll(() => memberSqlProbe.restore?.())

const close: Array<() => Promise<void>> = []
afterEach(async () => {
  memberSqlProbe.afterGet = undefined
  vi.restoreAllMocks()
  for (const cleanup of close.splice(0).reverse()) await cleanup()
})
const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-membership-"))
  const path = join(directory, "app.sqlite")
  let database = openNativeSqliteDatabase(path).database
  database.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  database.run("CREATE TABLE projection (uuid TEXT PRIMARY KEY,payload TEXT NOT NULL)")
  const incarnation = { token: randomUUID(), legacyCreatedAt: 1000 }
  database.run("INSERT INTO threads VALUES (?,?,?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: incarnation.token })])
  let store = new FunctionConversationStore(database)
  const input = { threadId: "thread", workspace: directory, incarnation, checkpointNamespace: "" }
  let target = store.ensureMain(input, () => undefined)
  const saver = new SqlJsSaver(join(directory, "graph.sqlite"))
  const controller = new AbortController()
  const guard = () => controller.signal.throwIfAborted()
  const binding = (): FunctionConversationDeliveryBinding => ({ target,
    checkpointThreadId: "thread", signal: controller.signal, assertCurrent: guard })
  const bridge = () => new FunctionConversationDeliveryBridge(store, binding)
  const write: FunctionConversationTranscriptWriter = (db, _target, row) => {
    expect(db === database).toBe(true)
    expect(db.inTransaction).toBe(true)
    db.run("INSERT INTO projection VALUES (?,?)", [row.uuid, row.nativePayload])
  }
  const verify: FunctionConversationTranscriptWriter = (db, _target, row) => {
    expect(db.exec("SELECT payload FROM projection WHERE uuid=?", [row.uuid])[0].values)
      .toEqual([[row.nativePayload]])
  }
  const note = (text: string) => {
    const id = randomUUID()
    return store.commit(target, { uuid: id, inputDigest: id, door: "note",
      origin: { kind: "plugin", name: "P" },
      message: { type: "user", role: "user", isMeta: true, content: [{ type: "text", text }] },
      nativePayload: serializeFunctionConversationNativeMessage(new HumanMessage({ id,
        content: [{ type: "text", text }], additional_kwargs: { isMeta: true } })),
      orderAnchor: { batch: id }, inbox: true, sdk: true }, guard, write, verify)
  }
  const keep = (native: BaseMessage, tool = false, door = tool ? "tool-result" : "response") => {
    if (!native.id) throw Error("native fixture requires actual UUID")
    return store.commit(target, { uuid: native.id, inputDigest: native.id,
      door, origin: { kind: "engine" },
      message: tool && ToolMessage.isInstance(native)
        ? { type: "user", role: "user", content: [{ type: "tool_result",
          tool_use_id: native.tool_call_id, content: typeof native.content === "string" ? native.content : "display" }] }
        : { type: "assistant", content: [{ type: "text", text: "display" }] },
      nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: { batch: "actual-native" },
      inbox: false, sdk: false }, guard, write, verify)
  }
  const marked = (row: FunctionConversationRow, native?: BaseMessage) => {
    const value = native ?? functionConversationNoteMessage(row, target)
    value.additional_kwargs = { ...value.additional_kwargs,
      function_row: functionConversationCanonicalStamp(target, row) }
    return value
  }
  const checkpoint = (frontier: number, messages: BaseMessage[]): Checkpoint => ({
    v: 1, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages, [FUNCTION_CONVERSATION_CHANNEL]: { version: 1,
      logicalSessionId: target.logicalSessionId, conversationId: target.conversationId,
      branchId: target.branchId, frontier } },
    channel_versions: { messages: frontier + 1, [FUNCTION_CONVERSATION_CHANNEL]: frontier + 1 },
    versions_seen: {}
  })
  const config = (checkpointId?: string) => ({ configurable: { thread_id: "thread", checkpoint_ns: "",
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}) } })
  close.push(async () => {
    controller.abort()
    await saver.close()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { get database() { return database }, get store() { return store }, get target() { return target },
    saver, controller, guard, binding, bridge, note, keep, marked, checkpoint, config,
    pending() { return database.exec("SELECT uuid FROM function_conversation_inbox ORDER BY sequence")[0]?.values ?? [] },
    reopen() {
      database.close()
      database = openNativeSqliteDatabase(path).database
      store = new FunctionConversationStore(database)
      target = store.findMain(input, guard)!
    } }
}

describe("exact native checkpoint membership and same AppDB delivery transaction", () => {
  it("executes eleven fresh SELECTs with both cut windows per main checkpoint member without removing guards", async () => {
    const f = fixture(), row = f.note("count actual reads")
    const checkpoint = f.checkpoint(1, [f.marked(row)])
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    const guard = vi.fn(f.guard)
    memberSqlProbe.calls = 0
    memberSqlProbe.queries = []
    memberSqlProbe.enabled = true
    try {
      expect(f.store.readCheckpointMember(f.target, proof, row.uuid, guard)).toEqual(row)
      expect(memberSqlProbe.calls).toBe(11)
      expect(memberSqlProbe.queries.filter(sql => /^\s*SELECT\b/i.test(sql))).toHaveLength(11)
      expect(memberSqlProbe.queries.filter(sql => sql.includes("checkpoint_namespace,c.next_sequence"))).toHaveLength(2)
      expect(guard).toHaveBeenCalledTimes(2)
      const originalHighWater = f.store.highWater.bind(f.store)
      const highWater = vi.spyOn(f.store, "highWater").mockImplementation(originalHighWater)
      memberSqlProbe.calls = 0
      memberSqlProbe.queries = []
      guard.mockClear()
      expect(f.store.readCheckpointMember(f.target, proof, row.uuid, guard)).toEqual(row)
      expect(memberSqlProbe.calls).toBe(15)
      expect(memberSqlProbe.queries.filter(sql => sql.startsWith("SELECT next_sequence"))).toHaveLength(2)
      expect(guard).toHaveBeenCalledTimes(2)
      expect(highWater).toHaveBeenCalledTimes(2)
      highWater.mockRestore()
    } finally { memberSqlProbe.enabled = false }
  })

  it.each(["sequence", "lineage", "workspace"] as const)(
    "keeps the second cut fresh after a member-index callback changes %s", async change => {
      const f = fixture(), row = f.note("late between cuts")
      const checkpoint = f.checkpoint(1, [f.marked(row)])
      await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
      const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
      let mutated = false
      // The pre-capture native probe mutates only after the real member-index SELECT.
      // Neither Store/adapter method eligibility nor the first fused cut is replaced.
      memberSqlProbe.afterGet = sql => {
        if (sql.includes("SELECT ordinal,member_json") && !mutated) {
          mutated = true
          if (change === "sequence") f.database.run("UPDATE function_conversations SET next_sequence=1")
          else if (change === "lineage") f.database.run(
            "UPDATE function_conversation_branches SET parent_branch_id=branch_id")
          else f.database.run("UPDATE function_logical_sessions SET workspace='late-workspace'")
        }
      }
      const expected = change === "sequence" ? "MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP"
        : change === "lineage" ? "MODS_CONVERSATION_BRANCH_INVALID" : "MODS_CONVERSATION_TARGET_CHANGED"
      expect(() => f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard)).toThrow(expected)
      expect(mutated).toBe(true)
    })

  it("keeps internal interpretation independent of helper prototype or Store field replacement", async () => {
    const f = fixture(), row = f.note("private interpretation")
    const checkpoint = f.checkpoint(1, [f.marked(row)])
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard)
    const fail = () => { throw Error("UNTRUSTED_INTERPRETATION") }
    const read = vi.spyOn(CheckpointSnapshotInterpretations.prototype, "read").mockImplementation(fail)
    const member = vi.spyOn(CheckpointSnapshotInterpretations.prototype, "member").mockImplementation(fail)
    Object.defineProperty(f.store, "checkpointInterpretations", { value: { read: fail, member: fail } })
    expect(f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard)).toEqual(row)
    expect(read).not.toHaveBeenCalled()
    expect(member).not.toHaveBeenCalled()
  })

  it("keeps public checkpoint cuts independent after private member interpretation is warm", async () => {
    const f = fixture(), row = f.note("independent public data")
    const checkpoint = f.checkpoint(1, [f.marked(row)])
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard)
    const point = { checkpointThreadId: "thread", checkpointIncarnation: f.target.incarnation,
      checkpointId: checkpoint.id }
    const first = f.store.readCheckpointCanonicalCut(f.target, point, f.guard)
    if (!first) throw Error("ACTUAL_CUT_REQUIRED")
    expect(Object.isFrozen(first)).toBe(false)
    const mutable = first as { highWater: number }
    mutable.highWater = 999
    expect(f.store.readCheckpointCanonicalCut(f.target, point, f.guard)?.highWater).toBe(1)
    expect(f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard)).toEqual(row)
  })

  it.each(["snapshot", "digest", "target", "member", "row", "cut", "cancel"] as const)(
    "rejects fresh %s changes after checkpoint interpretation is warm", async change => {
      const f = fixture(), row = f.note("cache remains data only")
      const checkpoint = f.checkpoint(1, [f.marked(row)])
      await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
      const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
      const guard = vi.fn(f.guard)
      expect(f.store.readCheckpointMember(f.target, proof, row.uuid, guard)).toEqual(row)
      const calls = guard.mock.calls.length
      guard.mockClear()
      expect(f.store.readCheckpointMember(f.target, proof, row.uuid, guard)).toEqual(row)
      expect(guard).toHaveBeenCalledTimes(calls)
      expect(calls).toBe(2)
      if (change === "cancel") f.controller.abort(Error("ACTUAL_CACHE_CANCEL"))
      else if (change === "snapshot") f.database.run(
        "UPDATE function_conversation_checkpoint_receipts SET snapshot_json='{}'")
      else if (change === "digest") f.database.run(
        "UPDATE function_conversation_checkpoint_receipts SET snapshot_digest='changed'")
      else if (change === "target") f.database.run(
        "UPDATE function_conversation_checkpoint_receipts SET target_json='{}'")
      else if (change === "member") f.database.run(
        "UPDATE function_conversation_checkpoint_members SET member_json='{}'")
      else if (change === "row") f.database.run(
        "UPDATE function_conversation_rows SET payload_json='{}' WHERE uuid=?", [row.uuid])
      else f.database.run("UPDATE function_conversations SET next_sequence=1")
      expect(() => f.store.readCheckpointMember(f.target, proof, row.uuid, guard)).toThrow()
    })

  it("separates intake 6, pending note 7 and actual assistant/tool keepers 8/9", async () => {
    const f = fixture()
    const consumed = Array.from({ length: 6 }, (_, index) => f.note(`consumed-${index}`))
    const pending = f.note("future pending note")
    const ai = new AIMessage({ id: randomUUID(), content: "answer",
      tool_calls: [{ id: "actual-tool", name: "read_file", args: { path: "actual.txt" }, type: "tool_call" }],
      response_metadata: { actualProvider: "provider-id" }, usage_metadata: {
        input_tokens: 3, output_tokens: 4, total_tokens: 7 } })
    const tool = new ToolMessage({ id: randomUUID(), content: "actual result", tool_call_id: "actual-tool",
      artifact: { original: "full artifact" }, status: "success", metadata: { native: true } })
    const assistantRow = f.keep(ai), toolRow = f.keep(tool, true)
    expect([pending.sequence, assistantRow.sequence, toolRow.sequence]).toEqual([7, 8, 9])
    const checkpoint = f.checkpoint(6, [...consumed.map(row => f.marked(row)),
      f.marked(assistantRow, ai), f.marked(toolRow, tool)])
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    expect(f.pending()).toEqual([[pending.uuid]])
    const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    expect(f.store.readCheckpointMember(f.target, proof, assistantRow.uuid, f.guard)).toEqual(assistantRow)
    expect(f.store.readCheckpointMember(f.target, proof, toolRow.uuid, f.guard)).toEqual(toolRow)
    expect(() => f.store.readCheckpointMember(f.target, proof, pending.uuid, f.guard))
      .toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CHECKPOINT")
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_checkpoint_members")[0].values)
      .toEqual([[8]])
  })

  it("persists membership and rejects copied proofs, while a genuine exact read rebinds after DB reopen", async () => {
    const f = fixture(), row = f.note("whole canonical content")
    const checkpoint = f.checkpoint(1, [f.marked(row)])
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    const old = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    expect(() => f.store.readCheckpointMember(f.target, { ...old }, row.uuid, f.guard))
      .toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    f.reopen()
    expect(() => f.store.readCheckpointMember(f.target, old, row.uuid, f.guard))
      .toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    expect(f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard)).toEqual(row)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_checkpoint_receipts")[0].values)
      .toEqual([[1]])
  })

  it.each(["body", "duplicate", "damaged stamp", "foreign stamp"])(
    "rejects %s from a real Saver tuple without clearing inbox or minting membership", async kind => {
      const f = fixture(), row = f.note("original"), native = f.marked(row)
      if (kind === "body") native.content = "changed canonical content"
      if (kind === "damaged stamp") native.additional_kwargs.function_row_invalid = true
      if (kind === "foreign stamp") native.additional_kwargs.function_row = {
        ...functionConversationCanonicalStamp(f.target, row), conversationId: randomUUID()
      }
      const messages = kind === "duplicate" ? [native, native] : [native]
      const checkpoint = f.checkpoint(1, messages)
      await expect(f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata))
        .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
      expect(f.pending()).toEqual([[row.uuid]])
      expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_checkpoint_receipts")[0].values)
        .toEqual([[0]])
      expect((await f.saver.getTuple(f.config(checkpoint.id)))?.checkpoint.id).toBe(checkpoint.id)
    })

  it("does not expand the preparation cut to include a keeper admitted after preparation", async () => {
    const f = fixture(), first = f.note("first"), checkpoint = f.checkpoint(1, [f.marked(first)])
    const observer = f.bridge().bindSaver(f.saver), prepared = observer.prepare(f.config(), checkpoint)!
    const later = f.keep(new AIMessage({ id: randomUUID(), content: "late keeper" }))
    checkpoint.channel_values.messages = [...checkpoint.channel_values.messages as BaseMessage[],
      f.marked(later, new AIMessage({ id: later.uuid, content: "late keeper" }))]
    await expect(f.saver.putWithCommitObserver(f.config(), checkpoint, metadata,
      receipt => observer.observed(prepared, receipt)))
      .rejects.toThrow("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    expect(f.pending()).toEqual([[first.uuid]])
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values).toEqual([[0]])
  })

  it("compares metadata omitted by the display instead of trusting the same UUID and text", async () => {
    const f = fixture(), id = randomUUID(), native = new AIMessage({ id, content: "actual" })
    const row = f.keep(native)
    const raw = f.database.exec("SELECT payload_json FROM function_conversation_rows WHERE uuid=?", [id])[0]
    expect(typeof raw.values[0][0]).toBe("string")
    // Full payload identity is checked independently of the bounded public display projection.
    native.additional_kwargs = { original: "not part of the actual canonical payload" }
    const checkpoint = f.checkpoint(0, [f.marked(row, native)])
    await expect(f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_checkpoint_receipts")[0].values)
      .toEqual([[0]])
  })

  it("compares complete tool artifacts and call identity even when visible text is unchanged", async () => {
    const f = fixture(), tool = new ToolMessage({ id: randomUUID(), content: "same visible result",
      tool_call_id: "original-tool", artifact: { native: "original" }, status: "success" })
    const row = f.keep(tool, true)
    const changed = new ToolMessage({ id: tool.id, content: tool.content, tool_call_id: "other-tool",
      artifact: { native: "changed" }, status: "success" })
    await expect(f.bridge().wrap(f.saver).put(f.config(),
      f.checkpoint(0, [f.marked(row, changed)]), metadata))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_deliveries")[0].values).toEqual([[0]])
  })

  it.each(["response", "note"])("does not let an actual ToolMessage borrow a user %s door", async door => {
    const f = fixture(), tool = new ToolMessage({ id: randomUUID(), content: "tool",
      tool_call_id: "actual-tool" }), row = f.keep(tool, true, door)
    await expect(f.bridge().wrap(f.saver).put(f.config(), f.checkpoint(0, [f.marked(row, tool)]), metadata))
      .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_checkpoint_receipts")[0].values)
      .toEqual([[0]])
  })

  it("rolls back members, delivery and inbox together on a native ACK write failure", async () => {
    const f = fixture(), row = f.note("retained after failed ACK")
    const checkpoint = f.checkpoint(1, [f.marked(row)])
    const run = f.database.run.bind(f.database)
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      if (sql.startsWith("INSERT INTO function_conversation_deliveries")) throw Error("actual ACK write failed")
      return run(sql, args)
    })
    await expect(f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata))
      .rejects.toThrow("actual ACK write failed")
    expect(f.pending()).toEqual([[row.uuid]])
    for (const table of ["function_conversation_checkpoint_receipts", "function_conversation_checkpoint_members",
      "function_conversation_deliveries"]) expect(f.database.exec(`SELECT COUNT(*) FROM ${table}`)[0].values)
      .toEqual([[0]])
    expect(f.database.inTransaction).toBe(false)
  })

  it("uses private same-transaction row verification without relaxing public readRowAtCut", async () => {
    const f = fixture(), row = f.note("same transaction"), checkpoint = f.checkpoint(1, [f.marked(row)])
    const read = f.store.readRowAtCut.bind(f.store)
    vi.spyOn(f.store, "readRowAtCut").mockImplementation((...args) => {
      expect(f.database.inTransaction).toBe(false)
      return read(...args)
    })
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    f.database.run("BEGIN IMMEDIATE")
    try { expect(() => read(f.target, row.uuid, { frontier: 1 }, f.guard))
      .toThrow("MODS_CONVERSATION_NOT_COMMITTED") } finally { f.database.run("ROLLBACK") }
    expect(f.pending()).toEqual([])
  })

  it("expires old read membership on real Saver close/reopen without renewing its DB receipt", async () => {
    const f = fixture(), row = f.note("actual retained row")
    const checkpoint = f.checkpoint(1, [f.marked(row)])
    await f.bridge().wrap(f.saver).put(f.config(), checkpoint, metadata)
    const proof = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    await f.saver.close()
    await f.saver.initialize()
    expect(() => f.store.readCheckpointMember(f.target, proof, row.uuid, f.guard))
      .toThrow("SQLJS_SAVER_READ_LIFETIME_EXPIRED")
    const current = await f.bridge().bindSaver(f.saver).captureRecovery(f.config(checkpoint.id), f.binding())
    expect(f.store.readCheckpointMember(f.target, current, row.uuid, f.guard)).toEqual(row)
  })
})
