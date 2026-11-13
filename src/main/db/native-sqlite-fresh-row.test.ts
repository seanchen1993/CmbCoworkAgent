import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { expect, it } from "vitest"
import {
  NativeSqliteAdapter, openNativeSqliteDatabase,
  readFunctionConversationNativeSqliteCurrentExecution
} from "./native-sqlite-adapter"

const invoke = Reflect.apply, own = Object.getOwnPropertyDescriptor
const define = Object.defineProperty, prototype = Object.getPrototypeOf

it.each(["ordinary", "fixed"] as const)(
  "preserves complete %s native row shape and independent blob storage", mode => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-fresh-native-row-"))
    const within = relative(resolve(tmpdir()), resolve(directory))
    if (!within || within.startsWith("..") || isAbsolute(within))
      throw Error("Actual isolated fixture path required")
    const path = join(directory, "actual.sqlite")
    const database = openNativeSqliteDatabase(path).database
    try {
      database.run("CREATE TABLE actual(id INTEGER PRIMARY KEY, body TEXT, payload BLOB)")
      const input = new Uint8Array([0, 1, 128, 255])
      database.run("INSERT INTO actual VALUES (?,?,?)", [1, "actual\u0000🙂", input])
      const execution = readFunctionConversationNativeSqliteCurrentExecution(database)!
      expect(execution).toBeDefined()
      const sql = `SELECT id,body,payload AS a,payload AS b,NULL AS empty,3.25 AS fraction,
        'own-proto' AS "__proto__",'own-constructor' AS constructor FROM actual WHERE id=?`
      const read = mode === "fixed" ? execution.prepareReadOne(sql) : database.prepareReadOne(sql)
      const first = read([1])!, second = read([1])!
      expect(prototype(first)).toBe(Object.prototype)
      expect(Reflect.ownKeys(first)).toEqual([
        "id", "body", "a", "b", "empty", "fraction", "__proto__", "constructor"
      ])
      for (const key of Reflect.ownKeys(first)) expect(own(first, key)).toEqual({
        value: first[key as string], enumerable: true, writable: true, configurable: true
      })
      const oracle = new DatabaseSync(path, { readOnly: true })
      try {
        expect(first.body).toBe(oracle.prepare(sql).get(1)!.body)
        expect(oracle.prepare("SELECT hex(body) AS stored_bytes FROM actual").get()!.stored_bytes)
          .toBe(Buffer.from("actual\u0000🙂").toString("hex").toUpperCase())
      } finally { oracle.close() }
      expect(first["__proto__"]).toBe("own-proto")
      expect(first.constructor).toBe("own-constructor")
      if (!(first.a instanceof Uint8Array) || !(first.b instanceof Uint8Array) ||
        !(second.a instanceof Uint8Array)) throw Error("ACTUAL_BLOBS_REQUIRED")
      expect(first).not.toBe(second)
      expect(first.a).not.toBe(first.b)
      expect(first.a.buffer).not.toBe(first.b.buffer)
      expect(first.a.buffer).not.toBe(second.a.buffer)
      first.a[0] = 99
      input[1] = 99
      expect(first.b).toEqual(new Uint8Array([0, 1, 128, 255]))
      expect(second.a).toEqual(first.b)
      expect(read([1])!.a).toEqual(first.b)
      database.run("UPDATE actual SET body=?,payload=?", ["fresh", new Uint8Array([9, 7])])
      expect(read([1])!).toMatchObject({ body: "fresh", a: new Uint8Array([9, 7]) })
      expect(read([99])).toBeUndefined()
    } finally {
      database.close({ checkpoint: false })
      rmSync(directory, { recursive: true, force: true })
    }
    expect(() => database.prepareReadOne("SELECT 1")).toThrow("closed")
  }
)

it("keeps native array-return mode on the original Object row contract", () => {
  const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
  const prepare = native.prepare
  define(native, "prepare", { configurable: true, value(sql: string) {
    const statement = invoke(prepare, native, [sql]) as StatementSync
    statement.setReturnArrays(true)
    return statement
  } })
  try {
    const read = database.prepareReadOne("SELECT 7 AS value, x'0001FF' AS payload")
    const row = read()!
    expect(Array.isArray(row)).toBe(false)
    expect(prototype(row)).toBe(Object.prototype)
    expect(row).toEqual({ 0: 7, 1: new Uint8Array([0, 1, 255]) })
    const blob = row["1"]
    if (!(blob instanceof Uint8Array)) throw Error("ACTUAL_BLOB_REQUIRED")
    blob[0] = 99
    expect(read()!["1"]).toEqual(new Uint8Array([0, 1, 255]))
  } finally { database.close({ checkpoint: false }) }
})

it("retains the dynamic typed-array copy callback installed by actual SQL execution", () => {
  const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
  let entered = 0, callbacks = 0
  native.function("actual_change", () => {
    entered++
    define(Uint8Array, Symbol.hasInstance, { configurable: true, value: () => {
      callbacks++
      return false
    } })
    return 1
  })
  try {
    let result: ReturnType<ReturnType<NativeSqliteAdapter["prepareReadOne"]>>
    try {
      result = database.prepareReadOne(
        "SELECT actual_change() AS marker, 7 AS value, x'0102' AS payload")()
    } finally { Reflect.deleteProperty(Uint8Array, Symbol.hasInstance) }
    expect(entered).toBe(1)
    expect(callbacks).toBe(3)
    expect(result!).toEqual({ marker: 1, value: 7, payload: new Uint8Array([1, 2]) })
  } finally { database.close({ checkpoint: false }) }
})

it("preserves native bigint scalar mode without changing its public row prototype", () => {
  const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
  const prepare = native.prepare
  define(native, "prepare", { configurable: true, value(sql: string) {
    const statement = invoke(prepare, native, [sql]) as StatementSync
    statement.setReadBigInts(true)
    return statement
  } })
  try {
    const row = database.prepareReadOne("SELECT 9223372036854775807 AS value")()!
    expect(row.value).toBe(9223372036854775807n)
    expect(prototype(row)).toBe(Object.prototype)
  } finally { database.close({ checkpoint: false }) }
})
