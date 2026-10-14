import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeSqliteReadOne } from "./native-sqlite-adapter"
import { readFunctionConversationThreadIdentityCurrent as readIdentity } from "./function-conversation-thread-identity-read"

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
