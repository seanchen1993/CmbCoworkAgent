import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase, type NativeSqliteAdapter, type NativeSqliteReadOne } from
  "./native-sqlite-adapter"
import { FunctionConversationStore, type FunctionConversationRef } from "./function-conversation-store"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function queryKind(sql: string): "thread" | "target" | undefined {
  if (/^SELECT created_at, metadata FROM threads WHERE thread_id = \?$/.test(sql)) return "thread"
  if (/^SELECT s\.thread_id, s\.incarnation_key, s\.workspace,/.test(sql)) return "target"
  return undefined
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-conversation-current-query-"))
  const path = join(directory, "actual.sqlite")
  const database = openNativeSqliteDatabase(path).database
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  const native = (database as unknown as { readonly native: DatabaseSync }).native
  if (!(native instanceof DatabaseSync)) throw Error("ACTUAL_SQLITE_CONNECTION_REQUIRED")
  const nativePrepare = native.prepare.bind(native)
  const statements: Record<"thread" | "target", StatementSync[]> = { thread: [], target: [] }
  const nativeSpy = vi.spyOn(native, "prepare").mockImplementation(sql => {
    const statement = nativePrepare(sql), kind = queryKind(sql)
    if (kind) statements[kind].push(statement)
    return statement
  })
  const prepareRead = database.prepareReadOne.bind(database)
  const readers: Record<"thread" | "target", Array<{ read: NativeSqliteReadOne }>> = {
    thread: [], target: []
  }
  const readerSpy = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
    const record = { read: prepareRead(sql) }, kind = queryKind(sql)
    if (kind) readers[kind].push(record)
    return bindings => record.read(bindings)
  })
  const store = new FunctionConversationStore(database)
  const ref = insertTarget(database, store)
  return { database, store, ref, path, nativeSpy, statements, readers, readerSpy, prepareRead }
}
function insertTarget(database: NativeSqliteAdapter, store: FunctionConversationStore) {
  const threadId = randomUUID(), token = randomUUID()
  database.run("INSERT INTO threads VALUES(?,?,?)", [threadId, 1000,
    JSON.stringify({ cmb_thread_incarnation: token })])
  return store.ensureMain({ threadId, workspace: "C:/actual-current-workspace", incarnation: {
    token, legacyCreatedAt: 1000 }, checkpointNamespace: "" }, () => undefined)
}
function statement(f: ReturnType<typeof fixture>, kind: "thread" | "target", index = 0) {
  const value = f.statements[kind][index]
  if (!value) throw Error("ACTUAL_CURRENT_STATEMENT_REQUIRED")
  return value
}
function reader(f: ReturnType<typeof fixture>, kind: "thread" | "target", index = 0) {
  const value = f.readers[kind][index]
  if (!value) throw Error("ACTUAL_CURRENT_READER_REQUIRED")
  return value
}

describe("conversation current fixed queries read fresh native SQLite rows", () => {
  it("prepares two statements once and observes all changed target fields immediately", () => {
    const f = fixture()
    for (let index = 0; index < 3; index++) f.store.assertCurrent(f.ref)
    expect(f.statements.thread).toHaveLength(1); expect(f.statements.target).toHaveLength(1)
    for (const [sql, bad, good, id] of [
      ["UPDATE function_logical_sessions SET workspace=? WHERE logical_session_id=?",
        "foreign-workspace", f.ref.workspace, f.ref.logicalSessionId],
      ["UPDATE function_conversations SET checkpoint_namespace=? WHERE conversation_id=?",
        "foreign-namespace", f.ref.checkpointNamespace, f.ref.conversationId],
      ["UPDATE function_conversations SET kind=? WHERE conversation_id=?",
        "child", f.ref.kind, f.ref.conversationId]
    ]) {
      f.database.run(sql, [bad, id])
      expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
      f.database.run(sql, [good, id]); f.store.assertCurrent(f.ref)
    }
    f.database.run("DELETE FROM function_conversation_branches WHERE branch_id=?", [f.ref.branchId])
    expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    expect(f.statements.thread).toHaveLength(1); expect(f.statements.target).toHaveLength(1)
  })

  it("rejects fresh metadata, missing threads and same-ID reincarnation without cached results", () => {
    const f = fixture(), original = JSON.stringify({ cmb_thread_incarnation: f.ref.incarnation.token })
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
      JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.ref.threadId])
    expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [original, f.ref.threadId])
    f.store.assertCurrent(f.ref)
    f.database.run("DELETE FROM threads WHERE thread_id=?", [f.ref.threadId])
    expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    f.database.run("INSERT INTO threads VALUES(?,?,?)", [f.ref.threadId, 1000,
      JSON.stringify({ cmb_thread_incarnation: randomUUID() })])
    expect(() => f.store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.statements.thread).toHaveLength(1)
  })

  it("rebinds both fixed query parameters for separate targets and rejects an absent branch", () => {
    const f = fixture(), second = insertTarget(f.database, f.store)
    f.store.assertCurrent(second); f.store.assertCurrent(f.ref)
    const absent: FunctionConversationRef = { ...f.ref, branchId: randomUUID() }
    expect(() => f.store.assertCurrent(absent)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    f.store.assertCurrent(second)
    expect(f.statements.thread).toHaveLength(1); expect(f.statements.target).toHaveLength(1)
  })

  it.each(["thread", "target"] as const)(
    "evicts only a %s query that threw and preserves the actual error", kind => {
      const f = fixture(), error = Error(`ACTUAL_${kind}_GET_FAILURE`)
      vi.spyOn(reader(f, kind), "read").mockImplementationOnce(() => { throw error })
      expect(() => f.store.assertCurrent(f.ref)).toThrow(error)
      f.store.assertCurrent(f.ref); f.store.assertCurrent(f.ref)
      expect(f.statements[kind]).toHaveLength(2)
      expect(f.statements[kind === "thread" ? "target" : "thread"]).toHaveLength(1)
    })

  it("sets busy before a replacement prepare and uses a temporary statement on reentry", () => {
    const f = fixture(), failed = Error("ACTUAL_FIRST_THREAD_GET_FAILURE")
    vi.spyOn(reader(f, "thread"), "read").mockImplementationOnce(() => { throw failed })
    expect(() => f.store.assertCurrent(f.ref)).toThrow(failed)
    const prepare = f.nativeSpy.getMockImplementation()
    if (!prepare) throw Error("ACTUAL_PREPARE_REQUIRED")
    let entered = false
    f.nativeSpy.mockImplementation(sql => {
      if (queryKind(sql) === "thread" && !entered) {
        entered = true; f.store.assertCurrent(f.ref)
      }
      return prepare(sql)
    })
    f.store.assertCurrent(f.ref); f.store.assertCurrent(f.ref)
    expect(f.statements.thread).toHaveLength(3); expect(f.statements.target).toHaveLength(1)
  })

  it("keeps the parent cache when a temporary nested read fails", () => {
    const f = fixture(), parent = statement(f, "thread"), current = reader(f, "thread")
    const readParent = current.read, error = Error("ACTUAL_NESTED_READ")
    f.readerSpy.mockImplementationOnce(sql => {
      const read = f.prepareRead(sql)
      return bindings => { read(bindings); throw error }
    })
    vi.spyOn(current, "read").mockImplementationOnce(bindings => {
      expect(() => f.store.assertCurrent(f.ref)).toThrow(error)
      return readParent(bindings)
    })
    f.store.assertCurrent(f.ref); f.store.assertCurrent(f.ref)
    expect(f.statements.thread).toHaveLength(2); expect(f.statements.target).toHaveLength(1)
    expect(statement(f, "thread")).toBe(parent)
  })

  it("rejects the closed original connection and reads current data on a reopened store", () => {
    const f = fixture()
    f.database.close()
    expect(() => f.store.assertCurrent(f.ref)).toThrow("Database is closed")
    const database = openNativeSqliteDatabase(f.path).database
    cleanups.push(() => { database.close() })
    const store = new FunctionConversationStore(database)
    store.assertCurrent(f.ref)
    database.run("UPDATE function_logical_sessions SET workspace=? WHERE logical_session_id=?",
      ["reopened-other-workspace", f.ref.logicalSessionId])
    expect(() => store.assertCurrent(f.ref)).toThrow("MODS_CONVERSATION_TARGET_CHANGED")
    expect(() => f.store.assertCurrent(f.ref)).toThrow("Database is closed")
  })

  it("normalizes real read-one bindings and returns detached scalar and blob values", () => {
    const f = fixture(), read = f.database.prepareReadOne("SELECT ? AS scalar,? AS binary")
    const first = read([true, Uint8Array.from([1, 2])])
    expect(first?.scalar).toBe(1)
    if (!(first?.binary instanceof Uint8Array)) throw Error("ACTUAL_BINARY_ROW_REQUIRED")
    first.binary[0] = 99
    expect(read([false, Uint8Array.from([1, 2])])).toEqual({ scalar: 0, binary: Uint8Array.from([1, 2]) })
    const named = f.database.prepareReadOne("SELECT $actual AS value")
    expect(named({ $actual: "fresh" })).toEqual({ value: "fresh" })
    expect(() => read([() => undefined])).toThrow("Unsupported binding value")
    expect(() => f.database.prepareReadOne("UPDATE threads SET created_at=0"))
      .toThrow("Read-one requires SELECT")
    expect(f.database.exec("SELECT created_at FROM threads")[0].values).toEqual([[1000]])
  })
})
