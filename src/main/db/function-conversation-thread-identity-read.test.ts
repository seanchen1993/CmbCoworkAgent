import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase, type NativeSqliteReadOne } from "./native-sqlite-adapter"
import { readFunctionConversationThreadIdentityCurrent as readIdentity,
  readFunctionConversationThreadIncarnationCurrent as readIncarnation } from
  "./function-conversation-thread-identity-read"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { THREAD_RUNTIME_SCOPE_EXPRESSION, THREAD_RUNTIME_SCOPE_INDEX } from "./thread-runtime-scope-query"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"

let directory = ""
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-thread-identity-query-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await appDb.closeDatabase()
  const within = relative(resolve(tmpdir()), resolve(directory))
  if (!within || within.startsWith("..") || resolve(directory) === resolve(tmpdir()))
    throw Error("Actual isolated fixture path required")
  rmSync(directory, { recursive: true, force: true })
})

function insert(
  metadata: string | null = JSON.stringify({ incarnation: randomUUID() }),
  threadId = randomUUID(),
  createdAt = 1234
) {
  appDb
    .getDb()
    .run(
      "INSERT INTO threads(thread_id,created_at,updated_at,metadata,status,title) VALUES(?,?,?,?,?,?)",
      [threadId, createdAt, 2000, metadata, "idle", "Original title"]
    )
  return { threadId, created_at: createdAt, metadata }
}
const QUERY = "SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1"
function observe() {
  const database = appDb.getDb()
  const prepare = database.prepareReadOne.bind(database)
  const native = (database as unknown as { native: DatabaseSync }).native
  if (!(native instanceof DatabaseSync)) throw Error("ACTUAL_SQLITE_CONNECTION_REQUIRED")
  const nativePrepare = native.prepare.bind(native)
  const statements: StatementSync[] = []
  const nativeSpy = vi.spyOn(native, "prepare").mockImplementation((sql) => {
    const statement = nativePrepare(sql)
    if (sql === QUERY) statements.push(statement)
    return statement
  })
  const readers: Array<{ read: NativeSqliteReadOne }> = []
  const spy = vi.spyOn(database, "prepareReadOne").mockImplementation((sql) => {
    const record = { read: prepare(sql) }
    if (sql === QUERY) readers.push(record)
    return (bindings) => record.read(bindings)
  })
  return { database, native, prepare, nativeSpy, spy, readers, statements }
}
function record(f: ReturnType<typeof observe>) {
  const value = f.readers[0]
  if (!value) throw Error("ACTUAL_CACHED_READER_REQUIRED")
  return value
}

describe("fresh complete thread identity queries", () => {
  it("matches both complete public fields and retains the public six-column result", () => {
    const metadata = JSON.stringify({
      text: '完整🙂\u0000\n"\\'.repeat(10_000),
      cmb_thread_incarnation: randomUUID(),
      workspacePath: "C:/complete/path"
    })
    const row = insert(metadata),
      f = observe()
    const actual = readIdentity(f.database, row.threadId)
    const full = appDb.getThreadCore(row.threadId)
    expect(actual).toStrictEqual({ created_at: row.created_at, metadata })
    expect(actual).toStrictEqual({ created_at: full?.created_at, metadata: full?.metadata })
    expect(Object.keys(actual!)).toStrictEqual(["created_at", "metadata"])
    expect(Object.keys(full!)).toStrictEqual([
      "thread_id",
      "created_at",
      "updated_at",
      "metadata",
      "status",
      "title"
    ])
    const primary = f.native
      .prepare("PRAGMA table_info(threads)")
      .all()
      .find((field) => field.name === "thread_id")
    expect(primary?.pk).toBe(1)
    f.database.run("UPDATE threads SET title=?,status=?,updated_at=? WHERE thread_id=?", [
      "Edited title",
      "busy",
      3000,
      row.threadId
    ])
    expect(readIdentity(f.database, row.threadId)).toStrictEqual(actual)
    expect(appDb.getThreadCore(row.threadId)).toMatchObject({
      title: "Edited title",
      status: "busy",
      updated_at: 3000
    })
    expect(f.statements).toHaveLength(1)
  })

  it("keeps null metadata and the complete legacy timestamp and returns null for no row", () => {
    const row = insert(null, randomUUID(), 1234567890123),
      f = observe()
    expect(readIdentity(f.database, row.threadId)).toStrictEqual({
      created_at: row.created_at,
      metadata: null
    })
    expect(readIdentity(f.database, randomUUID())).toBeNull()
    expect(f.statements).toHaveLength(1)
  })

  it("reads external writer updates, deletion and recreation with the same cached statement", () => {
    const row = insert(),
      f = observe()
    const first = readIdentity(f.database, row.threadId)
    const writer = new DatabaseSync(paths.database)
    try {
      const metadata = JSON.stringify({
        cmb_thread_incarnation: randomUUID(),
        text: "新的完整正文"
      })
      writer
        .prepare("UPDATE threads SET created_at=?,metadata=? WHERE thread_id=?")
        .run(4321, metadata, row.threadId)
      expect(readIdentity(f.database, row.threadId)).toStrictEqual({ created_at: 4321, metadata })
      expect(first).toStrictEqual({ created_at: row.created_at, metadata: row.metadata })
      writer.prepare("DELETE FROM threads WHERE thread_id=?").run(row.threadId)
      expect(readIdentity(f.database, row.threadId)).toBeNull()
      const next = insert("recreated full metadata", row.threadId, 5432)
      expect(readIdentity(f.database, row.threadId)).toStrictEqual({
        created_at: next.created_at,
        metadata: next.metadata
      })
      expect(f.statements).toHaveLength(1)
    } finally {
      writer.close()
    }
  })

  it("marks the real connection busy before its native prepare callback reenters", () => {
    const first = insert(),
      second = insert("nested metadata"),
      f = observe()
    const original = f.nativeSpy.getMockImplementation()
    if (!original) throw Error("ACTUAL_NATIVE_PREPARE_REQUIRED")
    let entered = false
    f.nativeSpy.mockImplementation((sql) => {
      if (sql === QUERY && !entered) {
        entered = true
        expect(readIdentity(f.database, second.threadId)).toStrictEqual({
          created_at: second.created_at,
          metadata: second.metadata
        })
      }
      return original(sql)
    })
    expect(readIdentity(f.database, first.threadId)?.metadata).toBe(first.metadata)
    expect(f.statements).toHaveLength(2)
    expect(readIdentity(f.database, first.threadId)?.metadata).toBe(first.metadata)
    expect(f.statements).toHaveLength(2)
  })

  it("isolates nested reads from an actual SQLite projection callback", () => {
    const first = insert(),
      second = insert("nested SQLite metadata"),
      f = observe()
    let callbacks = 0,
      entered = false
    f.native.function("identity_metadata", (metadata, threadId) => {
      callbacks++
      if (!entered && threadId === first.threadId) {
        entered = true
        expect(readIdentity(f.database, second.threadId)).toStrictEqual({
          created_at: second.created_at,
          metadata: second.metadata
        })
      }
      return metadata
    })
    // Forward the real PK-backed rows; the helper still executes its exact fixed query.
    f.native.exec(`CREATE TEMP VIEW threads AS SELECT thread_id, created_at, updated_at,
      identity_metadata(metadata, thread_id) AS metadata, status, title FROM main.threads`)
    expect(readIdentity(f.database, first.threadId)).toStrictEqual({
      created_at: first.created_at,
      metadata: first.metadata
    })
    expect(entered).toBe(true)
    expect(callbacks).toBe(2)
    expect(f.statements).toHaveLength(2)
    expect(readIdentity(f.database, first.threadId)?.metadata).toBe(first.metadata)
    expect(callbacks).toBe(3)
    expect(f.statements).toHaveLength(2)
  })

  it.each(["normalize", "before-read", "after-read"] as const)(
    "propagates a real %s failure and reads freshly through a replacement statement",
    (kind) => {
      const row = insert(),
        f = observe()
      readIdentity(f.database, row.threadId)
      const reader = record(f),
        original = reader.read
      const failure = Error(`ACTUAL_IDENTITY_${kind}_FAILURE`)
      vi.spyOn(reader, "read").mockImplementationOnce((bindings) => {
        if (kind === "normalize") {
          const actual: unknown[] = [row.threadId]
          Object.defineProperty(actual, "0", {
            get() {
              throw failure
            }
          })
          return original(actual)
        }
        if (kind === "after-read") expect(original(bindings)?.metadata).toBe(row.metadata)
        throw failure
      })
      expect(() => readIdentity(f.database, row.threadId)).toThrow(failure)
      expect(readIdentity(f.database, row.threadId)?.metadata).toBe(row.metadata)
      expect(f.statements).toHaveLength(2)
      expect(readIdentity(f.database, row.threadId)?.metadata).toBe(row.metadata)
      expect(f.statements).toHaveLength(2)
    }
  )

  it("propagates undefined after an actual read without retaining the failed statement", () => {
    const row = insert(),
      f = observe()
    readIdentity(f.database, row.threadId)
    const reader = record(f),
      original = reader.read
    vi.spyOn(reader, "read").mockImplementationOnce((bindings) => {
      expect(original(bindings)?.metadata).toBe(row.metadata)
      throw undefined
    })
    let rejected = false,
      failure: unknown = "not caught"
    try {
      readIdentity(f.database, row.threadId)
    } catch (error) {
      rejected = true
      failure = error
    }
    expect(rejected).toBe(true)
    expect(failure).toBeUndefined()
    expect(readIdentity(f.database, row.threadId)?.metadata).toBe(row.metadata)
    expect(f.statements).toHaveLength(2)
  })

  it("does not let a failed temporary query evict its real outer cached statement", () => {
    const first = insert(),
      second = insert(),
      f = observe()
    readIdentity(f.database, first.threadId)
    const reader = record(f),
      original = reader.read,
      failure = Error("ACTUAL_NESTED_FAILURE")
    f.spy.mockImplementationOnce((sql) => {
      const temporary = f.prepare(sql)
      return (bindings) => {
        temporary(bindings)
        throw failure
      }
    })
    vi.spyOn(reader, "read").mockImplementationOnce((bindings) => {
      expect(() => readIdentity(f.database, second.threadId)).toThrow(failure)
      return original(bindings)
    })
    expect(readIdentity(f.database, first.threadId)?.metadata).toBe(first.metadata)
    expect(readIdentity(f.database, first.threadId)?.metadata).toBe(first.metadata)
    expect(f.statements).toHaveLength(2)
    expect(f.readers).toHaveLength(1)
  })

  it("clears a first-prepare failure before the next real query", () => {
    const row = insert(),
      f = observe(),
      failure = Error("ACTUAL_PREPARE_FAILURE")
    f.spy.mockImplementationOnce(() => {
      throw failure
    })
    expect(() => readIdentity(f.database, row.threadId)).toThrow(failure)
    expect(readIdentity(f.database, row.threadId)?.metadata).toBe(row.metadata)
    expect(readIdentity(f.database, row.threadId)?.metadata).toBe(row.metadata)
    expect(f.statements).toHaveLength(1)
  })

  it("rejects a closed native connection and isolates the reopened connection and returned rows", async () => {
    const row = insert(),
      f = observe()
    const first = readIdentity(f.database, row.threadId)
    if (!first) throw Error("ACTUAL_IDENTITY_ROW_REQUIRED")
    first.metadata = "caller mutation"
    expect(readIdentity(f.database, row.threadId)?.metadata).toBe(row.metadata)
    const oldRead = record(f).read
    vi.restoreAllMocks()
    await appDb.closeDatabase()
    expect(() => oldRead([row.threadId])).toThrow("Database is closed")
    expect(() => readIdentity(f.database, row.threadId)).toThrow("Database is closed")
    await appDb.initializeDatabase()
    const reopened = appDb.getDb()
    expect(reopened === f.database).toBe(false)
    expect(readIdentity(reopened, row.threadId)).toStrictEqual({
      created_at: row.created_at,
      metadata: row.metadata
    })
  })
})

describe("native incarnation-only reads preserve the public raw reader", () => {
  const metadata = () => JSON.stringify({ cmb_thread_incarnation: "current",
    llmFileHistory: "完整🙂".repeat(20_000), workspacePath: "C:/same/workspace" })

  it("projects only file history while raw fields, current tokens and non-TEXT values stay unchanged", () => {
    const inserted = insert(metadata()), database = appDb.getDb()
    const initial = captureThreadIncarnation(readIdentity(database, inserted.threadId)!)
    expect(readIncarnation(database, inserted.threadId)).toEqual({ created_at: inserted.created_at,
      metadata: '{"cmb_thread_incarnation":"current","workspacePath":"C:/same/workspace"}' })
    const changed = captureThreadIncarnation({ created_at: inserted.created_at,
      metadata: '{"cmb_thread_incarnation":"different"}' })
    for (const next of [metadata(), null, "{broken", "[]", "42", 123,
      '{"cmb_thread_incarnation":"first","cmb_thread_incarnation":"current","llmFileHistory":1}',
      '{"cmb_thread_incarnation":null,"llmFileHistory":1}',
      new Uint8Array(Buffer.from('{"cmb_thread_incarnation":"current","llmFileHistory":1}')),
      new Uint8Array([0, 1, 255])]) {
      database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [next, inserted.threadId])
      const persisted = database.prepareReadOne(QUERY)([inserted.threadId])
      const raw = readIdentity(database, inserted.threadId)!
      const projected = readIncarnation(database, inserted.threadId)!
      // The production column has TEXT affinity: compare against what SQLite persisted,
      // not the pre-binding JavaScript number (which SQLite may persist as text).
      expect(raw).toEqual(persisted)
      expect(projected.created_at).toBe(raw.created_at)
      expect(matchesThreadIncarnation(projected, initial)).toBe(matchesThreadIncarnation(raw, initial))
      expect(matchesThreadIncarnation(projected, changed)).toBe(matchesThreadIncarnation(raw, changed))
      if (typeof raw.metadata !== "string") expect(projected.metadata).toEqual(raw.metadata)
    }
    database.run("UPDATE threads SET created_at=created_at+1,metadata=NULL WHERE thread_id=?",
      [inserted.threadId])
    expect(readIncarnation(database, inserted.threadId)?.created_at).toBe(inserted.created_at + 1)
    database.run("DELETE FROM threads WHERE thread_id=?", [inserted.threadId])
    expect(readIncarnation(database, inserted.threadId)).toBeNull()
    insert('{"cmb_thread_incarnation":"recreated"}', inserted.threadId, inserted.created_at)
    expect(matchesThreadIncarnation(readIncarnation(database, inserted.threadId), initial)).toBe(false)
  })

  it("preserves actual numeric metadata on a table without TEXT affinity", () => {
    const database = openNativeSqliteDatabase(join(directory, "untyped.sqlite")).database
    try {
      database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata)")
      database.run(`CREATE INDEX ${THREAD_RUNTIME_SCOPE_INDEX} ON threads(thread_id, ${THREAD_RUNTIME_SCOPE_EXPRESSION})`)
      database.run("INSERT INTO threads VALUES('untyped',1234,0)")
      for (const value of [123, 123.25, -4, null, new Uint8Array([0, 1, 255])]) {
        database.run("UPDATE threads SET metadata=? WHERE thread_id='untyped'", [value])
        const raw = readIdentity(database, "untyped")!
        const projected = readIncarnation(database, "untyped")!
        expect(raw.metadata).toEqual(value)
        expect(projected).toEqual(raw)
        if (typeof value === "number") expect(typeof projected.metadata).toBe("number")
      }
    } finally { database.close() }
  })

  it("observes independent writer commits, deletion and same-time recreation through the indexed path", () => {
    const inserted = insert(metadata()), database = appDb.getDb()
    const initial = captureThreadIncarnation(readIdentity(database, inserted.threadId)!)
    expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
    const writer = new DatabaseSync(paths.database)
    try {
      const next = JSON.stringify({ cmb_thread_incarnation: "external",
        llmFileHistory: "新的文件历史".repeat(20000), workspacePath: "C:/external" })
      writer.prepare("UPDATE threads SET metadata=? WHERE thread_id=?").run(next, inserted.threadId)
      const actual = readIncarnation(database, inserted.threadId)!
      expect(actual.metadata).toBe('{"cmb_thread_incarnation":"external","workspacePath":"C:/external"}')
      expect(matchesThreadIncarnation(actual, initial)).toBe(false)
      actual.metadata = "caller mutation"
      expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe("caller mutation")
      writer.prepare("DELETE FROM threads WHERE thread_id=?").run(inserted.threadId)
      expect(readIncarnation(database, inserted.threadId)).toBeNull()
      writer.prepare("INSERT INTO threads(thread_id,created_at,updated_at,metadata,status,title) VALUES(?,?,?,?,?,?)")
        .run(inserted.threadId, inserted.created_at, 2000,
          '{"cmb_thread_incarnation":"external-recreated","llmFileHistory":1}', "idle", "Recreated")
      const recreated = readIncarnation(database, inserted.threadId)!
      expect(recreated.created_at).toBe(inserted.created_at)
      expect(recreated.metadata).toBe('{"cmb_thread_incarnation":"external-recreated"}')
      expect(matchesThreadIncarnation(recreated, initial)).toBe(false)
    } finally { writer.close() }
  })

  it.each([false, true])("honors a cached custom public closure after factory restoration (projected first %s)", projectedFirst => {
    const inserted = insert(metadata()), database = appDb.getDb()
    if (projectedFirst) expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
    const prepare = database.prepareReadOne.bind(database)
    let reads = 0
    const factory = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => { reads++; return read(bindings) }
    })
    expect(readIdentity(database, inserted.threadId)?.metadata).toBe(inserted.metadata)
    factory.mockRestore()
    expect(readIncarnation(database, inserted.threadId)?.metadata).toBe(inserted.metadata)
    expect(reads).toBe(2)
    database.run("UPDATE threads SET metadata='latest' WHERE thread_id=?", [inserted.threadId])
    expect(readIncarnation(database, inserted.threadId)?.metadata).toBe("latest")
    expect(reads).toBe(3)
  })

  it("never consults a custom core cache when its own public raw reader is native", () => {
    const inserted = insert(metadata()), database = appDb.getDb()
    const prepare = database.prepareReadOne.bind(database)
    let coreReads = 0
    const factory = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => { coreReads++; return read(bindings) }
    })
    expect(appDb.getThreadCore(inserted.threadId)?.metadata).toBe(inserted.metadata)
    factory.mockRestore()
    expect(readIdentity(database, inserted.threadId)?.metadata).toBe(inserted.metadata)
    expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
    expect(coreReads).toBe(1)
    expect(appDb.getThreadCore(inserted.threadId)?.metadata).toBe(inserted.metadata)
    expect(coreReads).toBe(2)
  })

  it.each([
    [RegExp.prototype, "test"], [RegExp.prototype, "exec"], [WeakMap.prototype, "get"],
    [WeakMap.prototype, "set"], [WeakSet.prototype, "has"], [WeakSet.prototype, "add"],
  ] as const)("uses complete raw metadata when a dispatch/interpreter field changes (%s.%s)", (owner, key) => {
    const inserted = insert(metadata()), database = appDb.getDb()
    readIdentity(database, inserted.threadId)
    expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
    const original = Object.getOwnPropertyDescriptor(owner, key)!
    const invoke = Reflect.apply, define = Object.defineProperty
    let actual: ReturnType<typeof readIncarnation>
    try {
      define(owner, key, { ...original, value: function(this: unknown, ...args: unknown[]) {
        return invoke(original.value, this, args)
      } })
      actual = readIncarnation(database, inserted.threadId)
    } finally { define(owner, key, original) }
    expect(actual!.metadata).toBe(inserted.metadata)
    expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
  })

  it.each([[Reflect, "apply"], [JSON, "parse"]] as const)(
    "keeps captured projection semantics after late Main instrumentation (%s.%s)", (owner, key) => {
      const inserted = insert(metadata()), database = appDb.getDb()
      readIdentity(database, inserted.threadId)
      const before = readIncarnation(database, inserted.threadId)!.metadata
      expect(before).not.toBe(inserted.metadata)
      const original = Object.getOwnPropertyDescriptor(owner, key)!
      const invoke = Reflect.apply, define = Object.defineProperty
      let actual: ReturnType<typeof readIncarnation>
      try {
        define(owner, key, { ...original, value: function(this: unknown, ...args: unknown[]) {
          return invoke(original.value, this, args)
        } })
        actual = readIncarnation(database, inserted.threadId)
      } finally { define(owner, key, original) }
      expect(actual!.metadata).toBe(before)
      database.run("UPDATE threads SET metadata='changed-source' WHERE thread_id=?", [inserted.threadId])
      expect(readIncarnation(database, inserted.threadId)!.metadata).toBe("changed-source")
    }
  )

  it("keeps missing and dropped optional indexes on fresh raw reads without changing identity", () => {
    const inserted = insert(metadata()), database = appDb.getDb()
    expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
    database.run(`DROP INDEX ${THREAD_RUNTIME_SCOPE_INDEX}`)
    expect(readIncarnation(database, inserted.threadId)?.metadata).toBe(inserted.metadata)
    database.run(`CREATE INDEX ${THREAD_RUNTIME_SCOPE_INDEX} ON threads(thread_id, ${THREAD_RUNTIME_SCOPE_EXPRESSION})`)
    expect(readIncarnation(database, inserted.threadId)?.metadata).toBe(inserted.metadata)
    database.run("UPDATE threads SET metadata='after index recreation' WHERE thread_id=?", [inserted.threadId])
    expect(readIncarnation(database, inserted.threadId)?.metadata).toBe("after index recreation")
  })

  it("handles an initially missing index and rejects closed connections while reopening independently", async () => {
    const inserted = insert(metadata()), database = appDb.getDb()
    database.run(`DROP INDEX ${THREAD_RUNTIME_SCOPE_INDEX}`)
    expect(readIncarnation(database, inserted.threadId)?.metadata).toBe(inserted.metadata)
    await appDb.closeDatabase()
    expect(() => readIncarnation(database, inserted.threadId)).toThrow("Database is closed")
    await appDb.initializeDatabase()
    expect(readIncarnation(appDb.getDb(), inserted.threadId)?.metadata).not.toBe(inserted.metadata)
  })

  it.each([undefined, { code: "ERR_SQLITE_ERROR", message: `no such index: ${THREAD_RUNTIME_SCOPE_INDEX}` }])(
    "propagates custom raw failures unchanged instead of treating them as an optional index (%s)", failure => {
      const inserted = insert(metadata()), database = appDb.getDb()
      const factory = vi.spyOn(database, "prepareReadOne").mockImplementation(() => () => { throw failure })
      let rejected = false, actual: unknown = "not caught"
      try { readIncarnation(database, inserted.threadId) }
      catch (error) { rejected = true; actual = error }
      factory.mockRestore()
      expect(rejected).toBe(true)
      expect(actual).toBe(failure)
      expect(readIncarnation(database, inserted.threadId)?.metadata).not.toBe(inserted.metadata)
    }
  )
})
