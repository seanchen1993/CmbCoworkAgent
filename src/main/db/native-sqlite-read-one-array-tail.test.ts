import { DatabaseSync, type StatementSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "./native-sqlite-adapter"

describe("actual read-one Array tail", () => {
  it.each([
    [Symbol.iterator, "getter"], [Symbol.iterator, "replacement"],
    ["map", "getter"], ["map", "replacement"]
  ] as const)("copies the actual native get result with late %s %s callback zero", (key, attack) => {
    const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
    native.exec("CREATE TABLE actual_values(id INTEGER PRIMARY KEY, body TEXT, payload BLOB)")
    native.prepare("INSERT INTO actual_values VALUES(?,?,?)").run(1, "actual body", new Uint8Array([1, 2, 3]))
    const originalPrepare = native.prepare, original = Object.getOwnPropertyDescriptor(Array.prototype, key)
    let armed = false, gets = 0, callbacks = 0, failure: unknown, failed = false
    const forbidden = () => {
      callbacks++
      native.exec("UPDATE actual_values SET body='forbidden callback'")
      throw Error("LATE_READ_ONE_ARRAY_CALLBACK")
    }
    Object.defineProperty(native, "prepare", { configurable: true, value: (sql: string) => {
      const statement = Reflect.apply(originalPrepare, native, [sql]) as StatementSync
      const get = statement.get
      Object.defineProperty(statement, "get", { configurable: true, value: (...args: unknown[]) => {
        const result = Reflect.apply(get, statement, args)
        gets++
        if (armed) Object.defineProperty(Array.prototype, key, attack === "getter"
          ? { configurable: true, get: forbidden }
          : { configurable: true, writable: true, value: forbidden })
        return result
      } })
      return statement
    } })
    let row: ReturnType<ReturnType<NativeSqliteAdapter["prepareReadOne"]>> = undefined
    try {
      const read = database.prepareReadOne(`SELECT id,body,payload,NULL AS empty,
        'own data' AS "__proto__" FROM actual_values WHERE id=?`)
      armed = true
      try { row = read([1]) } catch (error) { failed = true; failure = error }
    } finally {
      armed = false
      if (original) Object.defineProperty(Array.prototype, key, original)
      else Reflect.deleteProperty(Array.prototype, key)
      Reflect.deleteProperty(native, "prepare")
    }
    try {
      expect(failed).toBe(false)
      expect(failure).toBeUndefined()
      expect(gets).toBe(1)
      expect(callbacks).toBe(0)
      expect(row!).toEqual({ id: 1, body: "actual body", payload: new Uint8Array([1, 2, 3]),
        empty: null, ["__proto__"]: "own data" })
      expect(Object.getPrototypeOf(row!)).toBe(Object.prototype)
      expect(Object.getOwnPropertyDescriptor(row!, "__proto__")).toEqual({ value: "own data",
        writable: true, enumerable: true, configurable: true })
      expect(native.prepare("SELECT body FROM actual_values").get()).toMatchObject({ body: "actual body" })
      const blob = row!.payload
      if (!(blob instanceof Uint8Array)) throw Error("ACTUAL_READ_ONE_BLOB_REQUIRED")
      blob[0] = 9
      expect(native.prepare("SELECT payload FROM actual_values").get()?.payload).toEqual(new Uint8Array([1, 2, 3]))
    } finally { database.close({ checkpoint: false }) }
  })

  it.each(["getter", "replacement"] as const)(
    "uses the captured original native get for positional and named bindings after late %s", attack => {
    const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
    const originalPrepare = native.prepare
    const statements: StatementSync[] = []
    Object.defineProperty(native, "prepare", { configurable: true, value: (sql: string) => {
      const statement = Reflect.apply(originalPrepare, native, [sql]) as StatementSync
      statements[statements.length] = statement
      return statement
    } })
    const positional = database.prepareReadOne("SELECT ? AS value")
    const named = database.prepareReadOne("SELECT $value AS value")
    let getters = 0
    const forbidden = () => { getters++; throw Error("LATE_STATEMENT_GET") }
    try {
      for (let index = 0; index < statements.length; index++)
        Object.defineProperty(statements[index], "get", attack === "getter"
          ? { configurable: true, get: forbidden }
          : { configurable: true, writable: true, value: forbidden })
      expect(positional(["positional"])).toEqual({ value: "positional" })
      expect(named({ value: "named" })).toEqual({ value: "named" })
      expect(getters).toBe(0)
    } finally {
      Reflect.deleteProperty(native, "prepare")
      database.close({ checkpoint: false })
    }
  })

  it.each(["assertOpen-getter", "assertOpen-replacement", "closed-getter"] as const)(
    "keeps the actual post-get open check data-only after %s", attack => {
      const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
      native.exec("CREATE TABLE actual_values(body TEXT)")
      native.exec("INSERT INTO actual_values VALUES('actual open-check body')")
      const originalPrepare = native.prepare
      const field = attack === "closed-getter" ? "closed" : "assertOpen"
      const original = Object.getOwnPropertyDescriptor(database, field)
      let armed = false, callbacks = 0, failed = false, failure: unknown
      let row: ReturnType<ReturnType<NativeSqliteAdapter["prepareReadOne"]>> = undefined
      const forbidden = () => {
        callbacks++
        native.exec("UPDATE actual_values SET body='forbidden open callback'")
        throw Error("LATE_READ_ONE_OPEN_CHECK")
      }
      Object.defineProperty(native, "prepare", { configurable: true, value: (sql: string) => {
        const statement = Reflect.apply(originalPrepare, native, [sql]) as StatementSync
        const get = statement.get
        Object.defineProperty(statement, "get", { configurable: true, value: (...args: unknown[]) => {
          const result = Reflect.apply(get, statement, args)
          if (armed) Object.defineProperty(database, field, attack === "assertOpen-replacement"
            ? { configurable: true, writable: true, value: forbidden }
            : { configurable: true, enumerable: original?.enumerable ?? false, get: forbidden })
          return result
        } })
        return statement
      } })
      try {
        const read = database.prepareReadOne("SELECT body FROM actual_values")
        armed = true
        try { row = read() } catch (error) { failed = true; failure = error }
      } finally {
        armed = false
        if (original) Object.defineProperty(database, field, original)
        else Reflect.deleteProperty(database, field)
        Reflect.deleteProperty(native, "prepare")
      }
      try {
        expect(callbacks).toBe(0)
        if (attack === "closed-getter") {
          expect(failed).toBe(true)
          expect(failure).toBeInstanceOf(Error)
          expect(row).toBeUndefined()
        } else {
          expect(failed).toBe(false)
          expect(failure).toBeUndefined()
          expect(row).toEqual({ body: "actual open-check body" })
        }
        expect(native.prepare("SELECT body FROM actual_values").get()).toMatchObject({
          body: "actual open-check body" })
      } finally { database.close({ checkpoint: false }) }
    })

  it("preserves sparse, inherited-index, named and special own-data bindings", () => {
    const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
    try {
      const read = database.prepareReadOne("SELECT ? AS first,? AS second,? AS third")
      const inherited = new Array<unknown>(3)
      inherited[0] = true
      inherited[2] = null
      Object.setPrototypeOf(inherited, Object.create(Array.prototype, {
        "1": { value: "inherited", enumerable: true, configurable: true }
      }))
      expect(read(inherited)).toEqual({ first: 1, second: "inherited", third: null })
      expect(() => read(new Array<unknown>(3))).toThrow()
      const named = database.prepareReadOne("SELECT $__proto__ AS value")
      const bindings: Record<string, unknown> = {}
      Object.defineProperty(bindings, "__proto__", { value: "named own data", enumerable: true })
      expect(named(bindings)).toEqual({ value: "named own data" })
    } finally { database.close({ checkpoint: false }) }
  })

  it("reads new rows each call and rejects an old closure after actual close", () => {
    const native = new DatabaseSync(":memory:"), database = new NativeSqliteAdapter(native)
    native.exec("CREATE TABLE actual_values(value TEXT)")
    native.exec("INSERT INTO actual_values VALUES('first')")
    const read = database.prepareReadOne("SELECT value FROM actual_values")
    expect(read()).toEqual({ value: "first" })
    native.exec("UPDATE actual_values SET value='second'")
    expect(read()).toEqual({ value: "second" })
    native.exec("DELETE FROM actual_values")
    expect(read()).toBeUndefined()
    database.close({ checkpoint: false })
    expect(() => read()).toThrow()
  })
})
