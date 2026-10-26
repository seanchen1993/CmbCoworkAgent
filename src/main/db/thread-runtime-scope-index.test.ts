import { randomUUID } from "node:crypto"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"

const indexName = "idx_threads_runtime_scope_v1"
// Independent reference for the previous projection, not an imported implementation helper.
const previousExpression = `CASE WHEN json_valid(metadata)
  THEN json_remove(metadata, '$.llmFileHistory') ELSE metadata END`
let directory = ""

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-scope-index-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function insert(metadata: string | null, id = randomUUID()) {
  appDb
    .getDb()
    .run(
      "INSERT INTO threads(thread_id,created_at,updated_at,metadata,status,title) VALUES(?,?,?,?,?,?)",
      [id, 100, 200, metadata, "idle", "Original title"]
    )
  return id
}

function nativeDatabase() {
  const native = (appDb.getDb() as unknown as { readonly native: DatabaseSync }).native
  if (!(native instanceof DatabaseSync)) throw Error("ACTUAL_SQLITE_CONNECTION_REQUIRED")
  return native
}

function originalRow(id: string) {
  return (
    nativeDatabase()
      .prepare(
        `SELECT thread_id, created_at, updated_at,
    ${previousExpression} AS metadata, status, title
    FROM threads INDEXED BY sqlite_autoindex_threads_1 WHERE thread_id = ?`
      )
      .get(id) ?? null
  )
}

function currentQuery(id: string) {
  const db = appDb.getDb(),
    prepare = db.prepareReadOne.bind(db)
  let captured: string | undefined
  const spy = vi.spyOn(db, "prepareReadOne").mockImplementation((sql) => {
    if (sql.includes("AS metadata") && sql.includes("FROM threads")) captured = sql
    return prepare(sql)
  })
  try {
    appDb.getThreadRuntimeScope(id)
    if (!captured) throw Error("ACTUAL_SCOPE_QUERY_REQUIRED")
    return captured
  } finally {
    spy.mockRestore()
  }
}

describe("thread runtime scope expression index", () => {
  it("backfills an existing database and preserves metadata through reopen and file restore", async () => {
    const raw = JSON.stringify({
      cmb_thread_incarnation: "original",
      extra: { keep: true },
      llmFileHistory: { text: "x".repeat(500_000) }
    })
    const id = insert(raw),
      malformedId = insert("{bad-json")
    await appDb.closeDatabase()
    const oldDatabase = new DatabaseSync(paths.database)
    try {
      oldDatabase.exec(`DROP INDEX ${indexName}`)
    } finally {
      oldDatabase.close()
    }

    await appDb.initializeDatabase()
    expect(
      nativeDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(indexName)
    ).toBeDefined()
    expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
    expect(appDb.getThreadRuntimeScope(malformedId)?.metadata).toBe("{bad-json")
    expect(appDb.getThreadCore(id)?.metadata).toBe(raw)

    await appDb.closeDatabase()
    const originalPath = paths.database
    paths.database = join(directory, "restored.sqlite")
    copyFileSync(originalPath, paths.database)
    await appDb.initializeDatabase()
    expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
    expect(appDb.getThreadCore(id)?.metadata).toBe(raw)
  })

  it("reads the real scope query from the expression index without JSON function opcodes", () => {
    const id = insert(JSON.stringify({ extra: "kept", llmFileHistory: "x".repeat(500_000) }))
    const sql = currentQuery(id)
    const native = nativeDatabase()
    const plan = native.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(id)
    expect(plan.some((row) => String(row.detail).includes(indexName))).toBe(true)
    const code = native.prepare(`EXPLAIN ${sql}`).all(id)
    expect(code.filter((row) => /Function/.test(String(row.opcode)))).toEqual([])
    expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
  })

  it.each([
    null,
    "{broken",
    "null",
    "42",
    "[]",
    '[{"llmFileHistory":"nested kept"}]',
    '{"unknown":[false,0,null,{"k":"v"}],"llmFileHistory":"removed"}',
    '{"llmFileHistory":1,"llmFileHistory":2,"extra":3}',
    JSON.stringify({ title: "中文😀", nested: { llmFileHistory: "保留" }, llmFileHistory: "移除" })
  ])("preserves the original projection and raw bytes for %s", (raw) => {
    const id = insert(raw)
    expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
    expect(appDb.getThreadCore(id)?.metadata).toBe(raw)
  })

  it("observes direct SQL writes from a second connection and transactional rollback immediately", () => {
    const id = insert('{"cmb_thread_incarnation":"original","llmFileHistory":"old"}')
    const initial = appDb.getThreadRuntimeScope(id)!
    const other = new DatabaseSync(paths.database)
    try {
      other.exec("BEGIN")
      other
        .prepare("UPDATE threads SET metadata=?,title=?,status=?,updated_at=? WHERE thread_id=?")
        .run(
          '{"cmb_thread_incarnation":"changed","newFlag":true,"llmFileHistory":"new"}',
          "New title",
          "busy",
          300,
          id
        )
      expect(appDb.getThreadRuntimeScope(id)).toEqual(initial)
      other.exec("COMMIT")
      expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
      expect(appDb.getThreadRuntimeScope(id)).toMatchObject({
        title: "New title",
        status: "busy",
        updated_at: 300,
        metadata: '{"cmb_thread_incarnation":"changed","newFlag":true}'
      })
      const committed = appDb.getThreadRuntimeScope(id)
      other.exec("BEGIN")
      other.prepare("UPDATE threads SET metadata=? WHERE thread_id=?").run("{broken", id)
      other.exec("ROLLBACK")
      expect(appDb.getThreadRuntimeScope(id)).toEqual(committed)
    } finally {
      other.close()
    }
  })

  it("does not preserve an old incarnation across another connection's same-ID recreation", () => {
    const id = insert('{"cmb_thread_incarnation":"original"}')
    const incarnation = captureThreadIncarnation(appDb.getThreadRuntimeScope(id)!)
    const other = new DatabaseSync(paths.database)
    try {
      other.prepare("DELETE FROM threads WHERE thread_id=?").run(id)
      expect(appDb.getThreadRuntimeScope(id)).toBeNull()
      other
        .prepare("INSERT INTO threads(thread_id,created_at,updated_at,metadata) VALUES(?,?,?,?)")
        .run(id, 400, 500, '{"cmb_thread_incarnation":"replacement","extra":"retained"}')
      expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
      expect(matchesThreadIncarnation(appDb.getThreadRuntimeScope(id), incarnation)).toBe(false)
    } finally {
      other.close()
    }
  })

  it("fails closed if its required index disappears, including an already prepared reader", async () => {
    const id = insert('{"cmb_thread_incarnation":"original"}')
    expect(appDb.getThreadRuntimeScope(id)).not.toBeNull()
    appDb.getDb().run(`DROP INDEX ${indexName}`)
    expect(() => appDb.getThreadRuntimeScope(id)).toThrow(/no such index/i)
    expect(() => appDb.getThreadRuntimeScope(id)).toThrow(/no such index/i)
    // Full metadata consumers are unchanged. A normal reopen recreates the derived index.
    expect(appDb.getThreadCore(id)?.metadata).toBe('{"cmb_thread_incarnation":"original"}')
    await appDb.closeDatabase()
    await appDb.initializeDatabase()
    expect(appDb.getThreadRuntimeScope(id)).toEqual(originalRow(id))
  })
})
