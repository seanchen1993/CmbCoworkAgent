import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-read-one-bindings-"))
  const { database } = openNativeSqliteDatabase(join(root, "actual.sqlite"))
  return {
    database,
    close() {
      try { database.close({ checkpoint: false }) }
      finally { rmSync(root, { recursive: true, force: true }) }
    }
  }
}

describe("native read-one binding data properties", () => {
  it.each(["get", "set"] as const)(
    "does not inherit a descriptor %s for positional or named bindings", key => {
      const f = fixture()
      const positional = f.database.prepareReadOne("SELECT ? AS value")
      const named = f.database.prepareReadOne("SELECT $amount AS value")
      const original = Object.getOwnPropertyDescriptor(Object.prototype, key)
      let positionalRow: unknown, namedRow: unknown, failure: unknown
      try {
        Object.defineProperty(Object.prototype, key, {
          value: () => { throw Error("INHERITED_BINDING_DESCRIPTOR") },
          configurable: true
        })
        try {
          positionalRow = positional([true])
          namedRow = named({ amount: 7 })
        } catch (error) { failure = error }
      } finally {
        if (original) Object.defineProperty(Object.prototype, key, original)
        else Reflect.deleteProperty(Object.prototype, key)
      }
      try {
        expect(failure).toBeUndefined()
        expect(positionalRow).toEqual({ value: 1 })
        expect(namedRow).toEqual({ value: 7 })
      } finally { f.close() }
    }
  )

  it("keeps original inherited source indices and evaluates each source getter once", () => {
    const f = fixture()
    let inheritedReads = 0, ownReads = 0
    const prototype = Object.create(Array.prototype)
    Object.defineProperty(prototype, "0", {
      get() { inheritedReads++; return true }, configurable: true
    })
    const bindings = new Array<unknown>(2)
    Object.setPrototypeOf(bindings, prototype)
    Object.defineProperty(bindings, "1", {
      get() { ownReads++; return 9 }, configurable: true
    })
    try {
      const read = f.database.prepareReadOne("SELECT ? AS first, ? AS second")
      expect(read(bindings)).toEqual({ first: 1, second: 9 })
      expect(inheritedReads).toBe(1)
      expect(ownReads).toBe(1)
    } finally { f.close() }
  })

  it("uses captured descriptor constructors and rechecks a real close from a source getter", () => {
    const f = fixture()
    const read = f.database.prepareReadOne("SELECT ? AS first, ? AS second")
    const closeRead = f.database.prepareReadOne("SELECT $amount AS value")
    const define = Object.defineProperty
    const originalCreate = Object.getOwnPropertyDescriptor(Object, "create")!
    const originalDefine = Object.getOwnPropertyDescriptor(Object, "defineProperty")!
    const restore = () => {
      define(Object, "create", originalCreate)
      define(Object, "defineProperty", originalDefine)
    }
    const bindings = [11, 12]
    define(bindings, "0", { get() {
      define(Object, "create", { ...originalCreate, value: () => { throw Error("LATE_OBJECT_CREATE") } })
      define(Object, "defineProperty", { ...originalDefine, value: () => { throw Error("LATE_OBJECT_DEFINE") } })
      return 11
    } })
    // Only normalization uses the temporary globals. Row copying retains its original dispatch.
    define(bindings, "1", { get() { restore(); return 12 } })
    let row: unknown, failure: unknown
    try { row = read(bindings) }
    catch (error) { failure = error }
    finally { restore() }
    try {
      expect(failure).toBeUndefined()
      expect(row).toEqual({ first: 11, second: 12 })
      const source = Object.create(null) as Record<string, unknown>
      Object.defineProperty(source, "amount", {
        enumerable: true,
        get() { f.database.close({ checkpoint: false }); return 12 }
      })
      expect(() => closeRead(source)).toThrow("Database is closed")
    } finally { f.close() }
  })
})
