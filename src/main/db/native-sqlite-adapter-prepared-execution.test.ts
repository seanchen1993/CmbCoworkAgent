import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { DatabaseSync, StatementSync } from "node:sqlite"
import { describe, expect, it, vi } from "vitest"
import {
  captureFunctionConversationNativeSqlitePreparedExecution as capture,
  openNativeSqliteDatabase,
  NativeSqliteAdapter
} from "./native-sqlite-adapter"

const ownDescriptor = Object.getOwnPropertyDescriptor
const defineProperty = Object.defineProperty
const deleteProperty = Reflect.deleteProperty

function withDatabase(work: (database: NativeSqliteAdapter) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-prepared-"))
  const database = openNativeSqliteDatabase(join(directory, "actual.sqlite")).database
  try {
    work(database)
  } finally {
    vi.restoreAllMocks()
    database.close()
    expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true)
    expect(basename(directory).startsWith("cmb-native-prepared-")).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
}

function replaceOwn(receiver: object, key: PropertyKey, descriptor: PropertyDescriptor): () => void {
  const original = ownDescriptor(receiver, key)
  defineProperty(receiver, key, descriptor)
  return () => {
    if (original) defineProperty(receiver, key, original)
    else deleteProperty(receiver, key)
  }
}

describe("prepared native fixed execution", () => {
  it("writes real transactions and reads fresh primitive and independent blob values", () => {
    withDatabase(database => {
      const execution = capture(database)!
      execution.assertDataCurrent(true)
      execution.run("CREATE TABLE actual(value, flag, absent, bytes BLOB)")
      execution.run("BEGIN IMMEDIATE")
      expect(() => execution.assertDataCurrent(true)).toThrow("requires autocommit")
      execution.assertDataCurrent()
      execution.run("INSERT INTO actual VALUES (?, ?, ?, ?)", ["payload", true, undefined,
        new Uint8Array([1, 2, 3])])
      execution.run("COMMIT")
      const read = execution.prepareReadOne("SELECT * FROM actual")
      const row = read()!
      expect(row.value).toBe("payload")
      expect(row.flag).toBe(1)
      expect(row.absent).toBeNull()
      expect(row.bytes).toEqual(new Uint8Array([1, 2, 3]))
      const bytes = row.bytes as Uint8Array
      bytes[0] = 9
      expect(read()!.bytes).toEqual(new Uint8Array([1, 2, 3]))
      expect(execution.prepareReadOne("SELECT json_type(?, '$.value') AS kind")(['{"value":true}'])?.kind)
        .toBe("true")
      expect(execution.prepareReadOne("PRAGMA main.data_version")()?.data_version).toBeDefined()
      expect(() => execution.prepareReadOne("PRAGMA main.data_version=1")).toThrow()
      execution.assertDataCurrent(true)
    })
  })

  it("rejects foreign and Proxy adapters without invoking their properties", () => {
    withDatabase(database => {
      let callbacks = 0
      const proxy = new Proxy(database, { get() { callbacks++; throw new Error("unexpected") },
        getOwnPropertyDescriptor() { callbacks++; throw new Error("unexpected") } })
      expect(capture(proxy)).toBeUndefined()
      expect(capture(Object.create(NativeSqliteAdapter.prototype))).toBeUndefined()
      expect(capture({})).toBeUndefined()
      expect(callbacks).toBe(0)
      const native = new DatabaseSync(":memory:")
      try { expect(capture(new NativeSqliteAdapter(native))).toBeUndefined() }
      finally { native.close() }
    })
  })

  it("rejects changed own resource descriptors before running accessors", () => {
    withDatabase(database => {
      const execution = capture(database)!
      let callbacks = 0
      const restore = replaceOwn(database, "native", { configurable: true,
        get() { callbacks++; throw new Error("unexpected") } })
      try {
        expect(() => execution.assertDataCurrent()).toThrow("resource changed")
        expect(() => execution.run("CREATE TABLE forbidden(value)")).toThrow("resource changed")
        expect(callbacks).toBe(0)
      } finally { restore() }
      expect(database.prepareReadOne("SELECT count(*) AS n FROM sqlite_schema WHERE name='forbidden'")()?.n)
        .toBe(0)
    })
  })

  it("rejects closed and unavailable resources", () => {
    withDatabase(database => {
      const execution = capture(database)!
      const original = ownDescriptor(database, "unusable")!
      database.markUnusable()
      try { expect(() => execution.assertDataCurrent()).toThrow("resource changed") }
      finally { defineProperty(database, "unusable", original) }
      database.close()
      expect(() => execution.prepareReadOne("SELECT 1")).toThrow()
    })
  })

  it("rejects binding accessors, sparse arrays, objects and shared blobs without callbacks", () => {
    withDatabase(database => {
      const execution = capture(database)!
      const read = execution.prepareReadOne("SELECT ? AS value")
      let callbacks = 0
      const accessor = [0]
      Object.defineProperty(accessor, "0", { get() { callbacks++; return 1 } })
      const proxy = new Proxy([1], { get() { callbacks++; return 1 } })
      expect(() => read(accessor)).toThrow("own data")
      expect(() => read(proxy)).toThrow("positional bindings")
      expect(() => read(new Array(1))).toThrow("own data")
      expect(() => read({ value: 1 })).toThrow("positional bindings")
      expect(() => read([{ valueOf() { callbacks++; return 1 } }])).toThrow("Unsupported")
      expect(() => read([new Uint8Array(new SharedArrayBuffer(4))])).toThrow("Unsupported")
      expect(callbacks).toBe(0)
    })
  })

  it("bypasses late adapter, native prototype, array and global operation replacements", () => {
    withDatabase(database => {
      const execution = capture(database)!
      execution.run("CREATE TABLE actual(value)")
      const read = execution.prepareReadOne("SELECT value FROM actual")
      const restores: Array<() => void> = []
      let callbacks = 0
      const unexpected = () => { callbacks++; throw new Error("unexpected late dispatch") }
      const install = (receiver: object, key: PropertyKey) => {
        restores.push(replaceOwn(receiver, key, { configurable: true, writable: true,
          value: unexpected }))
      }
      // Install the array hooks last and restore in a numeric loop: the assertions/framework
      // themselves use these operations, so no test framework code runs inside this interval.
      install(database, "run")
      install(database, "exec")
      install(DatabaseSync.prototype, "prepare")
      install(StatementSync.prototype, "get")
      install(StatementSync.prototype, "run")
      install(Object, "getOwnPropertyDescriptor")
      install(Object, "getPrototypeOf")
      install(Object, "defineProperty")
      install(Reflect, "apply")
      install(Array.prototype, "map")
      install(Array.prototype, Symbol.iterator)
      let value: unknown
      try {
        execution.assertDataCurrent(true)
        execution.run("BEGIN")
        execution.run("INSERT INTO actual VALUES (?)", [17])
        execution.run("COMMIT")
        value = read()?.value
      } finally {
        for (let index = restores.length - 1; index >= 0; index--) restores[index]()
      }
      expect(value).toBe(17)
      expect(callbacks).toBe(0)
    })
  })

  it("rolls back the original owned handle even after its wrapper becomes invalid", () => {
    withDatabase(database => {
      const execution = capture(database)!
      execution.run("CREATE TABLE actual(value)")
      execution.run("BEGIN")
      execution.run("INSERT INTO actual VALUES (1)")
      let callbacks = 0
      const restore = replaceOwn(database, "native", { configurable: true,
        get() { callbacks++; throw new Error("unexpected") } })
      try {
        expect(() => execution.run("COMMIT")).toThrow("resource changed")
        execution.run("ROLLBACK")
        expect(callbacks).toBe(0)
      } finally { restore() }
      expect(execution.prepareReadOne("SELECT count(*) AS n FROM actual")()?.n).toBe(0)
      execution.assertDataCurrent(true)
    })
  })

  it("keeps the ordinary adapter dispatch and last-row-count behavior", () => {
    withDatabase(database => {
      database.run("CREATE TABLE actual(value)")
      const original = DatabaseSync.prototype.prepare
      const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql) {
        return Reflect.apply(original, this, [sql])
      })
      database.run("INSERT INTO actual VALUES (?)", [1])
      expect(spy).toHaveBeenCalled()
      expect(database.getRowsModified()).toBe(1)
    })
  })

  it.each(["lower", "count", "total_changes", "length", "typeof", "json_extract", "json_type", "sum", "coalesce"])(
    "rejects late SQL function replacement %s without invoking it", name => {
      withDatabase(database => {
        const execution = capture(database)!
        const native = ownDescriptor(database, "native")!.value as DatabaseSync
        let callbacks = 0
        native.function(name, { varargs: true }, () => { callbacks++; return 1 })
        expect(() => execution.assertDataCurrent(true)).toThrow("SQL function replaced")
        expect(callbacks).toBe(0)
      })
    }
  )

  it("rejects a main function-list shadow before executing its view", () => {
    withDatabase(database => {
      const execution = capture(database)!
      const native = ownDescriptor(database, "native")!.value as DatabaseSync
      let callbacks = 0
      native.function("lower", () => { callbacks++; return "lower" })
      native.exec("CREATE VIEW main.pragma_function_list AS SELECT lower() AS name, 0 AS builtin")
      expect(() => execution.assertDataCurrent()).toThrow("Function-list schema changed")
      expect(callbacks).toBe(0)
    })
  })

  it("uses the genuine main function list despite an empty TEMP shadow", () => {
    withDatabase(database => {
      const execution = capture(database)!
      const native = ownDescriptor(database, "native")!.value as DatabaseSync
      native.exec("CREATE TEMP TABLE pragma_function_list(name, builtin)")
      execution.assertDataCurrent(true)
      let callbacks = 0
      native.function("LoWeR", { varargs: true }, () => { callbacks++; return "lower" })
      expect(() => execution.assertDataCurrent()).toThrow("SQL function replaced")
      expect(callbacks).toBe(0)
    })
  })

  it.each([
    "CREATE TABLE actual(value INTEGER CHECK(custom_js(value)>0))",
    "CREATE TABLE actual(value INTEGER, derived INTEGER GENERATED ALWAYS AS (custom_js(value)) STORED)",
    "CREATE TABLE actual(value INTEGER); CREATE INDEX actual_expression ON actual(custom_js(value))"
  ])("blocks schema JS callbacks without a DDL parser: %s", ddl => {
    withDatabase(database => {
      const native = ownDescriptor(database, "native")!.value as DatabaseSync
      let callbacks = 0
      native.function("custom_js", { deterministic: true, varargs: true }, () => { callbacks++; return 1 })
      native.exec(ddl)
      const execution = capture(database)!
      execution.assertDataCurrent(true)
      expect(() => execution.run("INSERT INTO actual(value) VALUES (?)", [1])).toThrow("unsafe use")
      expect(callbacks).toBe(0)
      expect(execution.prepareReadOne("SELECT count(*) AS n FROM actual")()?.n).toBe(0)
    })
  })

  it("rejects a late restored schema trust flag and still permits owned rollback", () => {
    withDatabase(database => {
      const execution = capture(database)!
      const native = ownDescriptor(database, "native")!.value as DatabaseSync
      execution.run("CREATE TABLE actual(value)")
      execution.run("BEGIN")
      execution.run("INSERT INTO actual VALUES (1)")
      native.exec("PRAGMA trusted_schema=ON")
      expect(() => execution.assertDataCurrent()).toThrow("schema trust changed")
      execution.run("ROLLBACK")
      expect(native.prepare("SELECT count(*) AS n FROM actual").get()?.n).toBe(0)
    })
  })

  it("retains the original schema policy on an ordinary-only connection", () => {
    withDatabase(database => {
      const native = ownDescriptor(database, "native")!.value as DatabaseSync
      expect(native.prepare("PRAGMA trusted_schema").get()?.trusted_schema).toBe(1)
      let callbacks = 0
      native.function("custom_js", () => { callbacks++; return 1 })
      database.run("CREATE TABLE actual(value CHECK(custom_js()>0))")
      database.run("INSERT INTO actual VALUES (1)")
      expect(callbacks).toBe(1)
      expect(native.prepare("PRAGMA trusted_schema").get()?.trusted_schema).toBe(1)
    })
  })
})
