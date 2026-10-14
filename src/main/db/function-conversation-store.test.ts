import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import {
  FunctionConversationStore,
  type FunctionConversationCommit,
  type FunctionConversationRef,
  type FunctionConversationTranscriptWriter,
  type FunctionConversationTranscriptVerifier,
  type FunctionConversationDeliveryProof
} from "./function-conversation-store"

// Observe the real native prepare before the adapter/Store capture their method identities.
// Wrapping prepareReadOne after import would change eligibility and only test the fallback path.
const sqlProbe = vi.hoisted(() => ({
  enabled: false, statements: [] as string[], restore: undefined as (() => void) | undefined
}))
vi.mock("node:sqlite", async importOriginal => {
  const actual = await importOriginal<typeof import("node:sqlite")>()
  const prototype = actual.DatabaseSync.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "prepare")!
  const prepare = prototype.prepare
  Object.defineProperty(prototype, "prepare", { ...descriptor,
    value: function(this: import("node:sqlite").DatabaseSync, sql: string) {
      if (sqlProbe.enabled && /^\s*SELECT\b/i.test(sql)) sqlProbe.statements.push(sql)
      return Reflect.apply(prepare, this, [sql])
    } })
  sqlProbe.restore = () => Object.defineProperty(prototype, "prepare", descriptor)
  return actual
})
afterAll(() => { sqlProbe.enabled = false; sqlProbe.restore?.() })

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-function-conversation-"))
  const path = join(directory, "app.sqlite")
  let db = openNativeSqliteDatabase(path).database
  db.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
  db.run("CREATE TABLE projection (uuid TEXT PRIMARY KEY, payload TEXT NOT NULL)")
  const token = randomUUID()
  db.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1000,
    JSON.stringify({ cmb_thread_incarnation: token })])
  let store = new FunctionConversationStore(db)
  cleanups.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  const input = { threadId: "thread", workspace: "C:/workspace", incarnation: {
    token, legacyCreatedAt: 1000
  }, checkpointNamespace: "" }
  const ref = store.ensureMain(input, () => undefined)
  const writer = vi.fn<FunctionConversationTranscriptWriter>((database, _target, row) => {
    expect(database.inTransaction).toBe(true)
    database.run("INSERT INTO projection VALUES (?, ?)", [row.uuid, JSON.stringify(row)])
  })
  const verify = vi.fn<FunctionConversationTranscriptVerifier>((database, target, row) => {
    expect(database).toBe(db)
    expect(target.branchId).toBe(row.branchId)
    const result = database.exec("SELECT payload FROM projection WHERE uuid = ?", [row.uuid])[0]
    if (result?.values.length !== 1 || result.values[0][0] !== JSON.stringify(row))
      throw Error("CANONICAL_TRANSCRIPT_NOT_COMMITTED")
  })
  return { get db() { return db }, get store() { return store }, ref, input, writer, verify, path,
    reopen() { db.close(); db = openNativeSqliteDatabase(path).database
      store = new FunctionConversationStore(db) } }
}

function note(uuid = randomUUID(), text = "note"): FunctionConversationCommit {
  return { uuid, inputDigest: `digest:${uuid}`, door: "note", origin: { kind: "plugin", name: "P" },
    message: { type: "user", role: "user", isMeta: true, content: [{ type: "text", text }] },
    nativePayload: JSON.stringify({ type: "human", content: text, extra: { actual: true } }),
    orderAnchor: { request: "request-1", batch: "batch-1" }, inbox: true, sdk: true }
}

function commit(f: ReturnType<typeof fixture>, input = note(), target = f.ref) {
  return f.store.commit(target, input, () => undefined, f.writer, f.verify)
}

describe("FunctionConversationStore actual SQLite", () => {
  it("keeps cut getter evaluation before the final current read", () => {
    const f = fixture()
    const cut = f.store.captureCheckpointCanonicalCut(f.ref, () => undefined)
    let reads = 0
    const hostile = { ...cut, get highWater() {
      if (++reads === 2) f.db.run("UPDATE function_logical_sessions SET workspace='late'")
      return cut.highWater
    } }
    expect(() => f.store.assertCheckpointCanonicalCut(f.ref, hostile))
      .toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    expect(reads).toBe(2)
  })

  it.each(["assertCurrent", "highWater"] as const)("preserves an overridden %s cut callback", name => {
    const f = fixture()
    const cut = f.store.captureCheckpointCanonicalCut(f.ref, () => undefined)
    const original = f.store[name].bind(f.store)
    const callback = vi.spyOn(f.store, name).mockImplementation(target => {
      f.db.run("UPDATE function_logical_sessions SET workspace='late'")
      return original(target)
    })
    expect(() => f.store.assertCheckpointCanonicalCut(f.ref, cut))
      .toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    expect(callback).toHaveBeenCalled()
    callback.mockRestore()
  })

  it("does not bypass a cached high-water reader after its public method is restored", () => {
    const f = fixture()
    const cut = f.store.captureCheckpointCanonicalCut(f.ref, () => undefined)
    f.reopen()
    const original = f.db.prepareReadOne.bind(f.db)
    let late = false, calls = 0
    const prepare = vi.spyOn(f.db, "prepareReadOne").mockImplementation(sql => {
      const read = original(sql)
      return bindings => {
        if (sql.startsWith("SELECT next_sequence")) {
          calls++
          if (late) throw Error("CACHED_HIGH_WATER_CALLBACK")
        }
        return read(bindings)
      }
    })
    f.store.highWater(f.ref)
    prepare.mockRestore()
    late = true
    expect(() => f.store.assertCheckpointCanonicalCut(f.ref, cut)).toThrow("CACHED_HIGH_WATER_CALLBACK")
    expect(calls).toBe(2)
  })

  it.each([false, true])(
    "finishes source callbacks before final verification and returns fresh SQL (lost COMMIT: %s)", lost => {
      const f = fixture(), input = note()
      const originalRun = f.db.run.bind(f.db)
      const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
        const result = originalRun(sql, args)
        if (lost && sql === "COMMIT") throw Error("ACTUAL_COMMIT_ACK_LOST")
        return result
      })
      let verified: Parameters<FunctionConversationTranscriptVerifier>[2] | undefined
      let afterVerification = false, lateGuards = 0, finalVerifications = 0
      const guard = () => { if (afterVerification) lateGuards++ }
      const row = f.store.commit(f.ref, input, guard, f.writer, (database, target, actual) => {
        f.verify(database, target, actual)
        if (!database.inTransaction) {
          verified = actual
          afterVerification = true
          finalVerifications++
        }
      })
      expect(verified).toBeDefined()
      expect(lateGuards).toBe(0)
      expect(Object.is(row, verified)).toBe(false)
      expect(row).toEqual(f.store.readReceipt(f.ref, input.uuid))
      expect(f.writer).toHaveBeenCalledTimes(1)
      expect(finalVerifications).toBe(1)
      spy.mockRestore()
    })

  it("does not return a canonical object mutated by the last verifier after actual COMMIT", () => {
    const f = fixture(), input = note()
    expect(() => f.store.commit(f.ref, input, () => {}, f.writer, (database, target, row) => {
      f.verify(database, target, row)
      if (!database.inTransaction) row.message.content = [{ type: "text", text: "callback mutation" }]
    })).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
    expect(f.db.inTransaction).toBe(false)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.store.readReceipt(f.ref, input.uuid)?.message).toEqual(input.message)
    expect(f.db.exec("SELECT COUNT(*) FROM projection WHERE uuid=?", [input.uuid])[0].values)
      .toEqual([[1]])
  })

  it.each(["toJSON", "getter", "proxy"])(
    "rejects verifier-installed %s without executing it after the final seal", kind => {
      const f = fixture(), input = note()
      let executions = 0
      const effect = () => {
        executions++
        f.db.run("DELETE FROM projection WHERE uuid=?", [input.uuid])
      }
      expect(() => f.store.commit(f.ref, input, () => {}, f.writer, (database, target, row) => {
        f.verify(database, target, row)
        if (database.inTransaction) return
        const original = JSON.parse(JSON.stringify(row.message)) as typeof row.message
        const content = original.content
        if (!Array.isArray(content)) throw Error("Actual fixture content must be an array")
        if (kind === "toJSON") Object.defineProperty(row.message, "toJSON", {
          enumerable: true, configurable: true, writable: true,
          value() { effect(); return original }
        })
        else if (kind === "getter") Object.defineProperty(row.message, "content", {
          enumerable: true, configurable: true, get() { effect(); return content }
        })
        else Object.defineProperty(row.message, "content", {
          enumerable: true, configurable: true, writable: true,
          value: new Proxy(content, {
            get(value, key, receiver) { effect(); return Reflect.get(value, key, receiver) },
            ownKeys(value) { effect(); return Reflect.ownKeys(value) }
          })
        })
      })).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
      expect(executions).toBe(0)
      expect(f.db.inTransaction).toBe(false)
      expect(f.writer).toHaveBeenCalledTimes(1)
      expect(f.store.readReceipt(f.ref, input.uuid)?.message).toEqual(input.message)
      expect(f.db.exec("SELECT COUNT(*) FROM projection WHERE uuid=?", [input.uuid])[0].values)
        .toEqual([[1]])
    })

  it("finds the existing main without creating durable metadata and rejects stale incarnations", () => {
    const f = fixture()
    expect(f.store.findMain(f.input, () => undefined)).toEqual(f.ref)
    f.db.run("DELETE FROM function_conversation_branches")
    f.db.run("DELETE FROM function_conversations")
    f.db.run("DELETE FROM function_logical_sessions")
    expect(f.store.findMain(f.input, () => undefined)).toBeUndefined()
    expect(f.db.exec("SELECT COUNT(*) FROM function_logical_sessions")[0].values).toEqual([[0]])
    const stale = { ...f.input, incarnation: { ...f.input.incarnation, token: randomUUID() } }
    expect(() => f.store.findMain(stale, () => undefined)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
  })

  it("persists main UUID, row, transcript, inbox and receipt across database reopen", () => {
    const f = fixture(), row = commit(f)
    f.reopen()
    const rebound = f.store.ensureMain(f.input, () => undefined)
    expect(rebound).toEqual(f.ref)
    expect(f.store.readReceipt(rebound, row.uuid)).toEqual(row)
    expect(f.db.exec("SELECT uuid FROM projection")[0].values).toEqual([[row.uuid]])
    expect(f.store.captureInbox(rebound, 0).rows).toEqual([row])
  })

  it("rolls back row, inbox, receipt, sequence and transcript together when writer fails", () => {
    const f = fixture(), input = note()
    const writer: FunctionConversationTranscriptWriter = (db, _target, row) => {
      db.run("INSERT INTO projection VALUES (?, ?)", [row.uuid, "temporary"])
      throw Error("writer rejected")
    }
    expect(() => f.store.commit(f.ref, input, () => undefined, writer, f.verify))
      .toThrow("writer rejected")
    expect(f.store.highWater(f.ref)).toBe(0)
    expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
    expect(f.db.exec("SELECT * FROM projection")[0].values).toEqual([])
    expect(f.db.exec("SELECT * FROM function_conversation_inbox")[0].values).toEqual([])
  })

  it("requires synchronous writer and rejects a nested transaction", () => {
    const f = fixture()
    const writer = (() => Promise.resolve()) as unknown as FunctionConversationTranscriptWriter
    expect(() => f.store.commit(f.ref, note(), () => undefined, writer, f.verify))
      .toThrow("MODS_CONVERSATION_ASYNC_TRANSACTION")
    f.db.run("BEGIN")
    try { expect(() => commit(f)).toThrow("MODS_CONVERSATION_NESTED_TRANSACTION") }
    finally { f.db.run("ROLLBACK") }
    expect(f.store.highWater(f.ref)).toBe(0)
  })

  it("reuses only the exact canonical receipt, never identical text or changed UUID payload", () => {
    const f = fixture(), input = note(), first = commit(f, input)
    expect(commit(f, input)).toEqual(first)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(() => commit(f, { ...input, message: { ...input.message,
      content: [{ type: "text", text: "different" }] } }))
      .toThrow("MODS_CONVERSATION_ROW_CONFLICT")
    const second = commit(f, note(undefined, "note"))
    expect(second.uuid).not.toBe(first.uuid)
    expect(second.sequence).toBe(2)
  })

  it("recovers an exact committed key after ambiguous COMMIT without replaying the writer", () => {
    const f = fixture(), input = note(), original = f.db.run.bind(f.db)
    let once = true
    const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      const result = original(sql, args)
      if (sql === "COMMIT" && once) { once = false; throw Error("commit acknowledgement lost") }
      return result
    })
    const row = commit(f, input)
    spy.mockRestore()
    expect(f.store.readReceipt(f.ref, input.uuid)?.receiptId).toBe(row.receiptId)
    expect(f.db.inTransaction).toBe(false)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.store.highWater(f.ref)).toBe(1)
    const reader = new DatabaseSync(f.path, { readOnly: true })
    try {
      expect(reader.prepare("SELECT payload FROM projection WHERE uuid = ?").get(row.uuid)?.payload)
        .toBe(JSON.stringify(row))
      expect(reader.prepare("SELECT receipt_id FROM function_conversation_rows WHERE uuid = ?")
        .get(row.uuid)?.receipt_id).toBe(row.receiptId)
    } finally { reader.close() }
  })

  it("refuses same-connection uncommitted rows when both COMMIT and ROLLBACK fail", () => {
    const f = fixture(), input = note(), original = f.db.run.bind(f.db)
    const reader = new DatabaseSync(f.path, { readOnly: true })
    const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      if (sql === "COMMIT") throw Error("COMMIT rejected before native execution")
      if (sql === "ROLLBACK") throw Error("ROLLBACK rejected before native execution")
      return original(sql, args)
    })
    try {
      expect(() => commit(f, input)).toThrow("COMMIT rejected before native execution")
      expect(f.db.inTransaction).toBe(true)
      expect(f.store.readReceipt(f.ref, input.uuid)).toBeDefined()
      expect(f.db.exec("SELECT uuid FROM projection")[0].values).toEqual([[input.uuid]])
      expect(reader.prepare("SELECT COUNT(*) AS count FROM function_conversation_rows").get()?.count)
        .toBe(0)
      expect(reader.prepare("SELECT COUNT(*) AS count FROM projection").get()?.count).toBe(0)
      expect(spy.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1)
      expect(spy.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(1)
      expect(f.writer).toHaveBeenCalledTimes(1)
      expect(() => commit(f, input)).toThrow("MODS_CONVERSATION_NESTED_TRANSACTION")
      expect(f.writer).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      original("ROLLBACK")
      reader.close()
    }
    expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
    expect(f.db.exec("SELECT * FROM projection")[0].values).toEqual([])
  })

  it("requires a complete canonical row before sidecar commit and on exact receipt reuse", () => {
    const f = fixture(), input = note()
    const noWrite = vi.fn<FunctionConversationTranscriptWriter>(() => {
      // Deliberately omit the canonical writer to verify that a sidecar row cannot ACK.
    })
    expect(() => f.store.commit(f.ref, input, () => undefined, noWrite, f.verify))
      .toThrow("CANONICAL_TRANSCRIPT_NOT_COMMITTED")
    expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
    expect(f.db.inTransaction).toBe(false)
    const row = commit(f, input)
    f.db.run("DELETE FROM projection WHERE uuid = ?", [row.uuid])
    expect(() => commit(f, input)).toThrow("CANONICAL_TRANSCRIPT_NOT_COMMITTED")
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.store.readReceipt(f.ref, row.uuid)?.receiptId).toBe(row.receiptId)
  })

  it("does not ACK uncertain COMMIT recovery when canonical data differs from its receipt", () => {
    const f = fixture(), input = note(), original = f.db.run.bind(f.db)
    let cut = true
    const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
      const result = original(sql, args)
      if (sql === "COMMIT" && cut) {
        cut = false
        original("UPDATE projection SET payload = ? WHERE uuid = ?", ["different metadata", input.uuid])
        throw Error("Actual COMMIT reply lost")
      }
      return result
    })
    try {
      expect(() => commit(f, input)).toThrow("CANONICAL_TRANSCRIPT_NOT_COMMITTED")
      expect(f.db.inTransaction).toBe(false)
      expect(f.store.readReceipt(f.ref, input.uuid)).toBeDefined()
      expect(f.writer).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })

  it("rejects an asynchronous canonical verifier and rolls back the native write", () => {
    const f = fixture(), input = note()
    const verify: FunctionConversationTranscriptVerifier = () => Promise.resolve()
    expect(() => f.store.commit(f.ref, input, () => undefined, f.writer, verify))
      .toThrow("MODS_CONVERSATION_ASYNC_TRANSACTION")
    expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
    expect(f.db.exec("SELECT * FROM projection")[0].values).toEqual([])
  })

  it("does not ACK after owner expires at writer boundary", () => {
    const f = fixture(), input = note(), secret = "private note body"
    let live = true
    const guard = () => { if (!live) throw Error("source expired") }
    const writer: FunctionConversationTranscriptWriter = (db, _target, row) => {
      db.run("INSERT INTO projection VALUES (?, ?)", [row.uuid, secret])
      live = false
    }
    expect(() => f.store.commit(f.ref, input, guard, writer, f.verify)).toThrow("source expired")
    expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
  })

  it("separates notices from inbox and preserves host native payload including media", () => {
    const f = fixture(), input = note()
    const notice = commit(f, { ...input, door: "notice", inbox: false,
      message: { type: "system", content: [{ type: "text", text: "notice" }] },
      nativePayload: '{"notice":{"artifact":"actual"}}' })
    expect(f.store.captureInbox(f.ref, 0).rows).toEqual([])
    expect(f.store.readRows(f.ref)[0]).toEqual(notice)
    expect(f.store.readRows(f.ref)[0].message).not.toHaveProperty("role")
  })

  it("honors per-conversation 64 row quota inside transaction and never evicts ACK rows", () => {
    const f = fixture()
    for (let index = 0; index < 64; index++) commit(f)
    const rejected = note()
    expect(() => commit(f, rejected)).toThrow("MODS_CONVERSATION_INBOX_LIMIT")
    expect(f.store.readReceipt(f.ref, rejected.uuid)).toBeUndefined()
    f.reopen()
    expect(f.store.captureInbox(f.ref, 0).rows).toHaveLength(64)
    expect(f.db.exec("SELECT COUNT(*) FROM projection")[0].values[0][0]).toBe(64)
  })

  it("enforces logical session aggregate quota across distinct actual child invocations", () => {
    const f = fixture()
    const targets: FunctionConversationRef[] = [f.ref]
    for (let index = 0; index < 4; index++) targets.push(f.store.createChild(f.ref,
      { invocationId: randomUUID(), checkpointNamespace: `child:${index}` }, () => undefined))
    for (const target of targets.slice(0, 4))
      for (let index = 0; index < 64; index++) commit(f, note(), target)
    expect(() => commit(f, note(), targets[4])).toThrow("MODS_CONVERSATION_INBOX_LIMIT")
    expect(f.store.highWater(targets[4])).toBe(0)
  })

  it("counts full UTF-8 kept payload bytes and leaves an over-budget note wholly unsaved", () => {
    const f = fixture(), large = "中".repeat(100_000)
    let saved = 0
    while (saved < 64) {
      const input = note(undefined, large)
      try { commit(f, input); saved++ }
      catch (error) {
        expect(String(error)).toContain("MODS_CONVERSATION_INBOX_LIMIT")
        expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
        break
      }
    }
    expect(saved).toBeGreaterThan(0)
    expect(saved).toBeLessThan(64)
    expect(f.db.exec("SELECT SUM(bytes) FROM function_conversation_inbox")[0].values[0][0])
      .toBeLessThanOrEqual(16 * 1024 * 1024)
  })

  it("uses exact host delivery proof, keeps history for rollback, excludes future sibling branches", () => {
    const f = fixture(), first = commit(f)
    const branch = f.store.forkBranch(f.ref, { parentFrontier: first.sequence, checkpointId: "cp-parent" }, () => undefined)
    const futureParent = commit(f), child = commit(f, note(), branch)
    expect(f.store.captureInbox(branch, 0).rows.map((row) => row.uuid)).toEqual([first.uuid, child.uuid])
    expect(f.store.readRows(branch).map((row) => row.uuid)).not.toContain(futureParent.uuid)
    expect(() => f.store.recordCheckpointDelivery(branch,
      { checkpointId: "fake" } as unknown as FunctionConversationDeliveryProof, () => undefined))
      .toThrow("MODS_CONVERSATION_DELIVERY_PROOF")
    const proof = f.store.captureCheckpointDelivery(branch,
      { checkpointId: "cp-child", generation: "actual-put-generation", frontier: child.sequence }, () => undefined)
    f.store.recordCheckpointDelivery(branch, proof, () => undefined)
    expect(f.store.captureInbox(branch, child.sequence).rows).toEqual([])
    expect(f.store.captureInbox(branch, 0).rows.map((row) => row.uuid)).toEqual([first.uuid, child.uuid])
    expect(f.db.exec("SELECT uuid FROM function_conversation_inbox")[0].values).toEqual([[futureParent.uuid]])
    f.reopen()
    expect(f.store.selectBranch(f.ref, branch.branchId, () => undefined)).toEqual(branch)
    expect(f.store.readRows(branch).map((row) => row.uuid)).toEqual([first.uuid, child.uuid])
  })

  it("keeps high-water fixed and isolates delete/recreate even at identical timestamp", () => {
    const f = fixture(), first = commit(f), cut = f.store.highWater(f.ref)
    commit(f)
    expect(f.store.captureInbox(f.ref, 0, cut).rows).toEqual([first])
    f.db.run("DELETE FROM threads WHERE thread_id = ?", ["thread"])
    f.db.run("INSERT INTO threads VALUES (?, ?, ?)", ["thread", 1000,
      JSON.stringify({ cmb_thread_incarnation: randomUUID() })])
    expect(() => f.store.readRows(f.ref)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    const metadata = String(f.db.exec("SELECT metadata FROM threads")[0].values[0][0])
    const ref = f.store.ensureMain({ ...f.input,
      incarnation: { token: JSON.parse(metadata).cmb_thread_incarnation, legacyCreatedAt: 1000 } }, () => undefined)
    expect(ref.logicalSessionId).not.toBe(f.ref.logicalSessionId)
    expect(f.store.readRows(ref)).toEqual([])
  })

  it("supports native messages larger than SDK JSON boundary without projecting metadata away", () => {
    const f = fixture(), input = note()
    const large = "x".repeat(1024 * 1024 + 1)
    const row = commit(f, { ...input, sdk: false, inbox: false, door: "response",
      message: { type: "assistant", content: [{ type: "text", text: large }] },
      nativePayload: JSON.stringify({ content: large, usage: { total: 7 }, artifact: { bytes: [1, 2] } }) })
    expect(row.message.content).toEqual([{ type: "text", text: large }])
    expect(JSON.parse(row.nativePayload).artifact).toEqual({ bytes: [1, 2] })
  })
})

describe("FunctionConversationStore current identity JOIN", () => {
  it.each([
    ["thread missing", "DELETE FROM threads", "MODS_CONVERSATION_THREAD_CHANGED"],
    ["thread replaced", "UPDATE threads SET metadata='{}'", "MODS_CONVERSATION_THREAD_CHANGED"],
    ["workspace", "UPDATE function_logical_sessions SET workspace='other'", "MODS_CONVERSATION_TARGET_CHANGED"],
    ["incarnation", "UPDATE function_logical_sessions SET incarnation_key='other'", "MODS_CONVERSATION_TARGET_CHANGED"],
    ["namespace", "UPDATE function_conversations SET checkpoint_namespace='other'", "MODS_CONVERSATION_TARGET_CHANGED"],
    ["kind", "UPDATE function_conversations SET kind='child'", "MODS_CONVERSATION_TARGET_CHANGED"],
    ["branch missing", "DELETE FROM function_conversation_branches", "MODS_CONVERSATION_TARGET_CHANGED"]
  ])("reads fresh %s facts and preserves recoverable public errors", (_name, mutation, error) => {
    const f = fixture()
    f.store.assertCurrent(f.ref)
    f.db.run("SAVEPOINT changed_identity")
    f.db.run(mutation)
    expect(() => f.store.assertCurrent(f.ref)).toThrow(error)
    f.db.run("ROLLBACK TO changed_identity")
    f.db.run("RELEASE changed_identity")
    expect(() => f.store.assertCurrent(f.ref)).not.toThrow()
  })

  it("preserves private assertThread overrides before checking the target", () => {
    const f = fixture()
    const store = f.store as unknown as { assertThread(target: FunctionConversationRef): void }
    const original = store.assertThread
    let calls = 0
    store.assertThread = function(target) {
      calls++
      original.call(this, target)
      f.db.run("UPDATE function_logical_sessions SET workspace='changed'")
    }
    try { expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED") }
    finally { delete (store as { assertThread?: unknown }).assertThread }
    expect(calls).toBe(1)
  })

  it("retains JSON parse callbacks and the subsequent fresh target check", () => {
    const f = fixture()
    const parse = JSON.parse
    let calls = 0
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      calls++
      f.db.run("UPDATE function_logical_sessions SET workspace='changed'")
      return parse(text, reviver)
    })
    try { expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED") }
    finally { spy.mockRestore() }
    expect(calls).toBeGreaterThan(0)
  })

  it("does not bypass readers compiled while the public read factory was wrapped", () => {
    const f = fixture()
    f.reopen()
    const prepare = f.db.prepareReadOne.bind(f.db)
    let callbacks = 0, mutate = false
    const spy = vi.spyOn(f.db, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return args => {
        callbacks++
        const row = read(args)
        if (mutate && sql.includes("SELECT created_at"))
          f.db.run("UPDATE function_logical_sessions SET workspace='changed'")
        return row
      }
    })
    try { f.store.assertCurrent(f.ref) } finally { spy.mockRestore() }
    callbacks = 0
    mutate = true
    expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    expect(callbacks).toBe(2)
  })

  it("retains getter-bearing target behavior instead of treating it as pure data", () => {
    const f = fixture()
    let reads = 0
    const target = Object.freeze({ ...f.ref, get threadId() { reads++; return f.ref.threadId } })
    f.store.assertCurrent(target)
    expect(reads).toBeGreaterThan(0)
  })

  it.each([null, "malformed", "[]", "{}"])("preserves legacy metadata %s", metadata => {
    const f = fixture()
    f.db.run("UPDATE threads SET metadata=?", [metadata])
    const legacy = Object.freeze({ ...f.ref,
      incarnation: Object.freeze({ token: null, legacyCreatedAt: 1000 }) })
    f.db.run("UPDATE function_logical_sessions SET incarnation_key=?", [JSON.stringify(["legacy", 1000])])
    expect(() => f.store.assertCurrent(legacy)).not.toThrow()
    f.db.run("UPDATE threads SET created_at=1001")
    expect(() => f.store.assertCurrent(legacy)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
  })
})

it("compiles one fresh identity SELECT for a genuine current execution", () => {
  const f = fixture()
  f.reopen()
  sqlProbe.statements = []
  sqlProbe.enabled = true
  try {
    f.store.assertCurrent(f.ref)
    expect(sqlProbe.statements).toHaveLength(1)
    expect(sqlProbe.statements[0]).toContain("physical_thread_id")
    expect(sqlProbe.statements[0]).toContain("LEFT JOIN function_conversations")
    expect(sqlProbe.statements[0]).toContain("LEFT JOIN function_conversation_branches")
  } finally { sqlProbe.enabled = false }
  class GenericStore extends FunctionConversationStore {}
  const generic = new GenericStore(f.db)
  sqlProbe.statements = []
  sqlProbe.enabled = true
  try {
    generic.assertCurrent(f.ref)
    expect(sqlProbe.statements).toHaveLength(2)
    expect(sqlProbe.statements[0]).toBe("SELECT created_at, metadata FROM threads WHERE thread_id = ?")
    expect(sqlProbe.statements[1]).toContain("FROM function_conversations c JOIN function_logical_sessions")
  } finally { sqlProbe.enabled = false }
  f.db.run("UPDATE function_logical_sessions SET workspace='changed'")
  expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
  expect(sqlProbe.statements).toHaveLength(2)
})

it("keeps a fresh target read after a typed-array row-copy callback", () => {
  const f = fixture()
  let changed = false
  Object.defineProperty(Uint8Array, Symbol.hasInstance, { configurable: true, value: () => {
    if (!changed) {
      changed = true
      f.db.run("UPDATE function_logical_sessions SET workspace='late callback'")
    }
    return false
  } })
  try { expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED") }
  finally { Reflect.deleteProperty(Uint8Array, Symbol.hasInstance) }
  expect(changed).toBe(true)
})
