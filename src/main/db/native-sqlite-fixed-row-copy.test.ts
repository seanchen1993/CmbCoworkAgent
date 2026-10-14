import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  openNativeSqliteDatabase,
  readFunctionConversationNativeSqliteCurrentExecution
} from "./native-sqlite-adapter"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-fixed-native-row-"))
  const path = join(directory, "actual.sqlite")
  cleanups.push(() => {
    const within = relative(resolve(tmpdir()), resolve(directory))
    if (!within || within.startsWith("..") || resolve(directory) === resolve(tmpdir()))
      throw Error("Actual isolated fixture path required")
    rmSync(directory, { recursive: true, force: true })
  })
  const database = openNativeSqliteDatabase(path).database
  cleanups.push(() => database.close())
  database.run("CREATE TABLE actual_values(id INTEGER PRIMARY KEY, body TEXT, payload BLOB)")
  const body = JSON.stringify('完整🙂\n"\\\u0000'.repeat(2000))
  const payload = new Uint8Array(65536)
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251
  database.run("INSERT INTO actual_values VALUES(?,?,?)", [1, body, payload])
  const execution = readFunctionConversationNativeSqliteCurrentExecution(database)
  if (!execution) throw Error("Actual constructor-owned native execution required")
  return { directory, path, database, execution, body, payload }
}

describe("complete fresh native row copies", () => {
  it("preserves the original native SQLite result for bare text containing a null byte", () => {
    const f = fixture()
    const body = "before\u0000完整🙂after"
    f.database.run("INSERT INTO actual_values VALUES(?,?,?)", [3, body, f.payload])
    const sql = "SELECT body,hex(body) AS stored_bytes,payload FROM actual_values WHERE id=?"
    const ordinary = f.database.prepareReadOne(sql)([3])
    const actual = f.execution.prepareReadOne(sql)([3])
    expect(actual).toStrictEqual(ordinary)
    expect(Reflect.ownKeys(actual!)).toStrictEqual(Reflect.ownKeys(ordinary!))
    for (const key of Reflect.ownKeys(ordinary!)) {
      expect(Object.getOwnPropertyDescriptor(actual!, key)).toStrictEqual(
        Object.getOwnPropertyDescriptor(ordinary!, key)
      )
    }
    expect(actual?.stored_bytes).toBe(Buffer.from(body).toString("hex").toUpperCase())
    // Node's original native SQLite text reader ends at NUL; the fixed copy preserves it.
    expect(actual?.body).toBe("before")
    expect(actual?.payload).toEqual(f.payload)
  })

  it("matches the ordinary complete row, own field order, prototype and flags", () => {
    const f = fixture()
    const sql = `SELECT id,body,payload,NULL AS empty,3.25 AS decimal,
      'own-proto' AS "__proto__",'own-constructor' AS constructor FROM actual_values WHERE id=?`
    const ordinary = f.database.prepareReadOne(sql)([1])
    const actual = f.execution.prepareReadOne(sql)([1])
    expect(actual).toStrictEqual(ordinary)
    expect(Object.keys(actual!)).toEqual(Object.keys(ordinary!))
    expect(Object.getPrototypeOf(actual!)).toBe(Object.prototype)
    expect(Reflect.ownKeys(actual!)).toStrictEqual(Reflect.ownKeys(ordinary!))
    for (const key of Reflect.ownKeys(ordinary!)) {
      expect(Object.getOwnPropertyDescriptor(actual!, key)).toStrictEqual(
        Object.getOwnPropertyDescriptor(ordinary!, key)
      )
    }
    expect(Object.getOwnPropertyDescriptor(actual!, "__proto__")).toEqual({
      value: "own-proto",
      writable: true,
      enumerable: true,
      configurable: true
    })
    expect(actual?.body).toBe(f.body)
    expect(actual?.payload).toEqual(f.payload)
  })

  it("copies the whole blob independently for each returned row and the actual database", () => {
    const f = fixture()
    const read = f.execution.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
    const first = read([1]),
      second = read([1])
    if (!(first?.payload instanceof Uint8Array) || !(second?.payload instanceof Uint8Array))
      throw Error("Actual complete SQLite blobs required")
    expect(first.payload).not.toBe(second.payload)
    first.payload.fill(255)
    first.body = "changed copy"
    expect(second.payload).toEqual(f.payload)
    expect(second.body).toBe(f.body)
    expect(read([1])).toStrictEqual({ body: f.body, payload: f.payload })
    expect(
      f.database.prepareReadOne("SELECT payload FROM actual_values WHERE id=?")([1])?.payload
    ).toEqual(f.payload)
  })

  it("distinguishes an absent row from complete null and empty field values", () => {
    const f = fixture()
    const read = f.execution.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
    expect(read([999])).toBeUndefined()
    f.database.run("INSERT INTO actual_values VALUES(?,?,?)", [2, "", null])
    expect(read([2])).toStrictEqual({ body: "", payload: null })
    expect(f.execution.prepareReadOne("SELECT NULL AS body,0 AS count")()).toStrictEqual({
      body: null,
      count: 0
    })
  })

  it("reads a new committed row through the same fixed statement after an independent writer", () => {
    const f = fixture()
    const read = f.execution.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
    expect(read([1])).toStrictEqual({ body: f.body, payload: f.payload })
    const writer = new DatabaseSync(f.path)
    cleanups.push(() => writer.close())
    const updated = new Uint8Array([9, 0, 8, 255])
    writer
      .prepare("UPDATE actual_values SET body=?,payload=? WHERE id=?")
      .run("fresh committed body", updated, 1)
    expect(read([1])).toStrictEqual({ body: "fresh committed body", payload: updated })
  })

  it("does not call a late Object.keys replacement while copying the genuine native result", () => {
    const f = fixture()
    const read = f.execution.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
    let calls = 0
    const spy = vi.spyOn(Object, "keys").mockImplementation(() => {
      calls++
      throw Error("Late external keys callback must not enter the native copy")
    })
    let actual: ReturnType<typeof read>
    try {
      actual = read([1])
    } finally {
      spy.mockRestore()
    }
    expect(calls).toBe(0)
    expect(actual).toStrictEqual({ body: f.body, payload: f.payload })
  })

  it("rejects a real database close performed by the original binding getter", () => {
    const f = fixture()
    const read = f.execution.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
    let calls = 0
    const bindings = [1]
    Object.defineProperty(bindings, "0", {
      enumerable: true,
      configurable: true,
      get() {
        calls++
        f.database.close()
        return 1
      }
    })
    expect(() => read(bindings)).toThrow()
    expect(calls).toBe(1)
    expect(() => read([1])).toThrow()
    expect(() => f.execution.assertDataCurrent()).toThrow()
  })

  it("keeps the ordinary dynamic method and result-copy path independent of the fixed origin", () => {
    const f = fixture()
    const native = Object.getOwnPropertyDescriptor(f.database, "native")?.value as DatabaseSync
    const prepare = native.prepare.bind(native)
    let ordinaryGets = 0
    const spy = vi.spyOn(native, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql)
      const get = statement.get
      Object.defineProperty(statement, "get", {
        configurable: true,
        value: function (this: typeof statement, ...args: Parameters<typeof get>) {
          ordinaryGets++
          return Reflect.apply(get, this, args)
        }
      })
      return statement
    })
    const sql = "SELECT body,payload FROM actual_values WHERE id=?"
    expect(f.database.prepareReadOne(sql)([1])).toStrictEqual({ body: f.body, payload: f.payload })
    expect(ordinaryGets).toBe(1)
    expect(f.execution.prepareReadOne(sql)([1])).toStrictEqual({ body: f.body, payload: f.payload })
    expect(ordinaryGets).toBe(1)
    spy.mockRestore()
  })
})
