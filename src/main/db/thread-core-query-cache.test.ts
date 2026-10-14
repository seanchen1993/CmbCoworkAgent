import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeSqliteReadOne } from "./native-sqlite-adapter"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"

let directory = ""
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-thread-core-query-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function insertThread(threadId = randomUUID(), title = "Original title") {
  appDb.getDb().run(
    "INSERT INTO threads(thread_id,created_at,updated_at,metadata,status,title) VALUES(?,?,?,?,?,?)",
    [threadId, 100, 200, JSON.stringify({ cmb_thread_incarnation: randomUUID() }), "idle", title]
  )
  return threadId
}
function isCoreQuery(sql: string) {
  return /^SELECT thread_id, created_at, updated_at, metadata, status, title\s+FROM threads/.test(sql)
}
function observeCorePreparations() {
  const database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
  // Observe the real SQLite statement, without adding a production test accessor.
  const native = (database as unknown as { readonly native: DatabaseSync }).native
  if (!(native instanceof DatabaseSync)) throw Error("ACTUAL_SQLITE_CONNECTION_REQUIRED")
  const nativePrepare = native.prepare.bind(native), statements: StatementSync[] = []
  const nativeSpy = vi.spyOn(native, "prepare").mockImplementation(sql => {
    const statement = nativePrepare(sql)
    if (isCoreQuery(sql)) statements.push(statement)
    return statement
  })
  const readers: Array<{ read: NativeSqliteReadOne }> = []
  const spy = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
    const record = { read: prepare(sql) }
    if (isCoreQuery(sql)) readers.push(record)
    return bindings => record.read(bindings)
  })
  return { database, prepare, spy, nativeSpy, statements, readers }
}
function actualStatement(statements: readonly StatementSync[], index = 0) {
  const statement = statements[index]
  if (!statement) throw Error("Actual thread-core statement was not prepared")
  return statement
}
function actualReader(f: ReturnType<typeof observeCorePreparations>, index = 0) {
  const reader = f.readers[index]
  if (!reader) throw Error("ACTUAL_READ_ONE_REQUIRED")
  return reader
}

describe("thread-core prepared read-one queries with fresh native SQLite rows", () => {
  it("prepares once while reading every changed metadata, incarnation, title and status", () => {
    const id = insertThread(), f = observeCorePreparations(), first = appDb.getThreadCore(id)
    if (!first) throw Error("Actual first row was not returned")
    const incarnation = captureThreadIncarnation(first)
    const metadata = JSON.stringify({ cmb_thread_incarnation: randomUUID(), workspacePath: "new-path" })
    f.database.run("UPDATE threads SET metadata=?,title=?,status=?,updated_at=? WHERE thread_id=?",
      [metadata, "Changed title", "busy", 300, id])
    expect(appDb.getThreadCore(id)).toEqual({ thread_id: id, created_at: 100, updated_at: 300,
      metadata, status: "busy", title: "Changed title" })
    expect(first.title).toBe("Original title"); expect(first.metadata).not.toBe(metadata)
    expect(matchesThreadIncarnation(appDb.getThreadCore(id), incarnation)).toBe(false)
    expect(f.statements).toHaveLength(1)
  })

  it("freshly binds distinct IDs and missing rows and detaches each returned scalar record", () => {
    const a = insertThread(), b = insertThread(randomUUID(), "Other title")
    const f = observeCorePreparations(), first = appDb.getThreadCore(a)
    if (!first) throw Error("Actual first row was not returned")
    first.title = "Caller mutation"
    expect(appDb.getThreadCore(b)?.title).toBe("Other title")
    expect(appDb.getThreadCore(randomUUID())).toBeNull()
    const again = appDb.getThreadCore(a)
    expect(again).not.toBe(first); expect(again?.title).toBe("Original title")
    expect(Object.keys(again ?? {}).sort()).toEqual(
      ["thread_id", "created_at", "updated_at", "metadata", "status", "title"].sort())
    expect(f.statements).toHaveLength(1)
  })

  it("observes delete and same-ID recreation rather than preserving the old incarnation", () => {
    const id = insertThread(), f = observeCorePreparations(), original = appDb.getThreadCore(id)
    f.database.run("DELETE FROM threads WHERE thread_id=?", [id])
    expect(appDb.getThreadCore(id)).toBeNull()
    insertThread(id, "Recreated")
    const next = appDb.getThreadCore(id)
    expect(next?.title).toBe("Recreated"); expect(next?.metadata).not.toBe(original?.metadata)
    expect(f.statements).toHaveLength(1)
  })

  it("marks the connection busy before prepare so a synchronous nested query is temporary", () => {
    const a = insertThread(), b = insertThread(randomUUID(), "Nested"), f = observeCorePreparations()
    let entered = false
    const nativePrepare = f.nativeSpy.getMockImplementation()
    if (!nativePrepare) throw Error("ACTUAL_PREPARE_REQUIRED")
    f.nativeSpy.mockImplementation(sql => {
      if (isCoreQuery(sql) && !entered) {
        entered = true; expect(appDb.getThreadCore(b)?.title).toBe("Nested")
      }
      return nativePrepare(sql)
    })
    expect(appDb.getThreadCore(a)?.title).toBe("Original title")
    expect(f.statements).toHaveLength(2)
    expect(appDb.getThreadCore(a)?.title).toBe("Original title")
    expect(f.statements).toHaveLength(2)
  })

  it("keeps the parent statement intact when its reader reenters on the same connection", () => {
    const a = insertThread(), b = insertThread(randomUUID(), "Nested"), f = observeCorePreparations()
    appDb.getThreadCore(a)
    const reader = actualReader(f), read = reader.read
    vi.spyOn(reader, "read").mockImplementationOnce(bindings => {
      expect(appDb.getThreadCore(b)?.title).toBe("Nested")
      return read(bindings)
    })
    expect(appDb.getThreadCore(a)?.thread_id).toBe(a)
    expect(f.statements).toHaveLength(2)
    expect(appDb.getThreadCore(a)?.thread_id).toBe(a)
    expect(f.statements).toHaveLength(2)
  })

  it.each(["normalize", "before-read", "after-read"] as const)(
    "keeps a real %s failure visible, evicts that statement and clears its busy mark", method => {
      const id = insertThread(), f = observeCorePreparations()
      appDb.getThreadCore(id)
      const reader = actualReader(f), read = reader.read
      const failure = Error(`ACTUAL_${method}_FAILURE`)
      if (method === "normalize") {
        vi.spyOn(reader, "read").mockImplementationOnce(() => {
          const bindings: unknown[] = [id]
          Object.defineProperty(bindings, "0", { get() { throw failure } })
          return read(bindings)
        })
      } else vi.spyOn(reader, "read").mockImplementationOnce(bindings => {
        if (method === "before-read") throw failure
        expect(read(bindings)?.thread_id).toBe(id)
        throw failure
      })
      expect(() => appDb.getThreadCore(id)).toThrow(failure)
      expect(appDb.getThreadCore(id)?.thread_id).toBe(id)
      expect(f.statements).toHaveLength(2)
      expect(appDb.getThreadCore(id)?.thread_id).toBe(id)
      expect(f.statements).toHaveLength(2)
    })

  it("evicts a statement when its reader throws after reading the real row", () => {
    const id = insertThread(), f = observeCorePreparations()
    appDb.getThreadCore(id)
    const cached = actualStatement(f.statements), reader = actualReader(f), read = reader.read
    const failure = Error("ACTUAL_AFTER_GET_FAILURE")
    vi.spyOn(reader, "read").mockImplementationOnce(bindings => {
      expect(read(bindings)?.thread_id).toBe(id); throw failure
    })
    expect(() => appDb.getThreadCore(id)).toThrow(failure)
    expect(appDb.getThreadCore(id)?.thread_id).toBe(id)
    expect(f.statements).toHaveLength(2)
    expect(actualStatement(f.statements, 1)).not.toBe(cached)
  })

  it("preserves the original parent failure when a temporary nested read also fails", () => {
    const a = insertThread(), b = insertThread(), f = observeCorePreparations()
    appDb.getThreadCore(a)
    const nestedError = Error("ACTUAL_NESTED_FAILURE"), parentError = Error("ACTUAL_PARENT_FAILURE")
    f.spy.mockImplementationOnce(sql => {
      const read = f.prepare(sql)
      return bindings => { read(bindings); throw nestedError }
    })
    vi.spyOn(actualReader(f), "read").mockImplementationOnce(() => {
      expect(() => appDb.getThreadCore(b)).toThrow(nestedError)
      throw parentError
    })
    expect(() => appDb.getThreadCore(a)).toThrow(parentError)
    expect(appDb.getThreadCore(a)?.thread_id).toBe(a)
    expect(f.statements).toHaveLength(3)
  })

  it("does not retain a busy mark when preparing the first query throws", () => {
    const id = insertThread(), f = observeCorePreparations(), failure = Error("ACTUAL_PREPARE_FAILURE")
    f.spy.mockImplementationOnce(() => { throw failure })
    expect(() => appDb.getThreadCore(id)).toThrow(failure)
    expect(appDb.getThreadCore(id)?.thread_id).toBe(id)
    expect(f.statements).toHaveLength(1)
    expect(appDb.getThreadCore(id)?.thread_id).toBe(id)
    expect(f.statements).toHaveLength(1)
  })

  it("isolates a failed nested statement without evicting its active parent", () => {
    const a = insertThread(), b = insertThread(), f = observeCorePreparations()
    appDb.getThreadCore(a)
    const cached = actualStatement(f.statements), reader = actualReader(f), read = reader.read
    const failure = Error("ACTUAL_NESTED_READ_FAILURE")
    f.spy.mockImplementationOnce(sql => {
      const read = f.prepare(sql)
      return bindings => { read(bindings); throw failure }
    })
    vi.spyOn(reader, "read").mockImplementationOnce(bindings => {
      expect(() => appDb.getThreadCore(b)).toThrow(failure)
      return read(bindings)
    })
    expect(appDb.getThreadCore(a)?.thread_id).toBe(a)
    expect(appDb.getThreadCore(a)?.thread_id).toBe(a)
    expect(f.statements).toHaveLength(2)
    expect(actualStatement(f.statements)).toBe(cached)
  })

  it("rejects the old read closure after close and reads fresh rows on the reopened connection", async () => {
    const id = insertThread(), first = observeCorePreparations()
    expect(appDb.getThreadCore(id)?.thread_id).toBe(id)
    const oldRead = first.readers[0]?.read
    if (!oldRead) throw Error("ACTUAL_READ_ONE_REQUIRED")
    expect(first.statements).toHaveLength(1)
    await appDb.closeDatabase()
    expect(() => oldRead([id])).toThrow("Database is closed")
    expect(() => appDb.getThreadCore(id)).toThrow("Database not initialized")
    await appDb.initializeDatabase()
    const next = observeCorePreparations()
    expect(next.database === first.database).toBe(false)
    next.database.run("UPDATE threads SET title=? WHERE thread_id=?", ["Reopened", id])
    expect(appDb.getThreadCore(id)?.title).toBe("Reopened")
    expect(next.statements).toHaveLength(1)
    expect(actualStatement(next.statements) === actualStatement(first.statements)).toBe(false)
  })
})
