import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync, StatementSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "./native-sqlite-adapter"

const define = Object.defineProperty
const descriptor = Object.getOwnPropertyDescriptor
const entries = Object.entries
const apply = Reflect.apply
const cleanups: Array<() => void> = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-ordinary-native-copy-"))
  const path = join(directory, "actual.sqlite")
  cleanups.push(() => {
    const within = relative(resolve(tmpdir()), resolve(directory))
    if (!within || within.startsWith("..") || resolve(directory) === resolve(tmpdir()))
      throw Error("Actual isolated fixture path required")
    rmSync(directory, { recursive: true, force: true })
  })
  const native = new DatabaseSync(path)
  const database = new NativeSqliteAdapter(native)
  cleanups.push(() => database.close())
  native.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE actual_values(id INTEGER,body TEXT,payload BLOB)"
  )
  const body = JSON.stringify('完整🙂\n"\\\u0000'.repeat(2000))
  const payload = new Uint8Array(65536)
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251
  native.prepare("INSERT INTO actual_values VALUES(?,?,?)").run(1, body, payload)
  return { database, native, path, body, payload }
}

const sql = `SELECT id,body,payload,NULL AS empty,3.25 AS decimal,
  'own-proto' AS "__proto__",'own-constructor' AS constructor FROM actual_values WHERE id=?`

it("matches the original loop's complete native row, field order, prototype and every descriptor", () => {
  const f = fixture()
  const read = f.database.prepareReadOne(sql)
  const actual = read([1])!
  let ordinary: typeof actual | undefined
  const originalField = descriptor(Object, "defineProperty")!
  let definitions = 0
  define(Object, "defineProperty", {
    ...originalField,
    value: function (...args: Parameters<typeof define>) {
      definitions++
      return apply(define, Object, args)
    }
  })
  try {
    ordinary = read([1])
  } finally {
    define(Object, "defineProperty", originalField)
  }
  expect(definitions).toBe(7)
  expect(actual).toStrictEqual(ordinary)
  expect(Reflect.ownKeys(actual)).toStrictEqual(Reflect.ownKeys(ordinary!))
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype)
  for (const key of Reflect.ownKeys(ordinary!))
    expect(descriptor(actual, key)).toStrictEqual(descriptor(ordinary!, key))
  expect(actual.body).toBe(f.body)
  expect(actual.payload).toEqual(f.payload)
  expect(read([999])).toBeUndefined()
})

it("returns every blob independently and reads the next committed independent writer update", () => {
  const f = fixture()
  const read = f.database.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
  const first = read([1])!,
    second = read([1])!
  if (!(first.payload instanceof Uint8Array) || !(second.payload instanceof Uint8Array))
    throw Error("Actual full SQLite blobs required")
  expect(first.payload).not.toBe(second.payload)
  first.payload.fill(255)
  expect(second).toStrictEqual({ body: f.body, payload: f.payload })
  expect(read([1])).toStrictEqual(second)
  const writer = new DatabaseSync(f.path)
  cleanups.push(() => writer.close())
  const updated = new Uint8Array([255, 0, 7, 9])
  writer.prepare("UPDATE actual_values SET body=?,payload=? WHERE id=1").run("fresh body", updated)
  expect(read([1])).toStrictEqual({ body: "fresh body", payload: updated })
})

it.each(["entries", "defineProperty"] as const)(
  "keeps a late %s function's original dynamic call count and complete results",
  (key) => {
    const f = fixture(),
      read = f.database.prepareReadOne(sql)
    const original = descriptor(Object, key)!
    let calls = 0
    const replacement = (...args: unknown[]) => {
      calls++
      return apply(original.value, Object, args)
    }
    define(Object, key, { ...original, value: replacement })
    let actual: ReturnType<typeof read>
    try {
      actual = read([1])
    } finally {
      define(Object, key, original)
    }
    expect(calls).toBe(key === "entries" ? 1 : 7)
    expect(actual?.body).toBe(f.body)
    expect(actual?.payload).toEqual(f.payload)
    expect(Reflect.ownKeys(actual!)).toEqual([
      "id",
      "body",
      "payload",
      "empty",
      "decimal",
      "__proto__",
      "constructor"
    ])
  }
)

it.each(["entries", "defineProperty"] as const)(
  "keeps a late %s getter and does not consult an inherited descriptor value getter",
  (key) => {
    const f = fixture(),
      read = f.database.prepareReadOne(sql)
    const original = descriptor(Object, key)!,
      inherited = descriptor(Object.prototype, "value")
    let getters = 0,
      inheritedGetters = 0
    const getterField: PropertyDescriptor = {
      configurable: original.configurable,
      enumerable: original.enumerable,
      get() {
        getters++
        return original.value
      }
    }
    define(Object, key, getterField)
    // Prepare a data-property descriptor before installing this deliberately hostile getter.
    const inheritedField: PropertyDescriptor = {
      configurable: true,
      get() {
        inheritedGetters++
        throw Error("Inherited descriptor value must not execute")
      }
    }
    define(Object.prototype, "value", inheritedField)
    let actual: ReturnType<typeof read>
    try {
      actual = read([1])
    } finally {
      if (inherited) define(Object.prototype, "value", inherited)
      else delete (Object.prototype as { value?: unknown }).value
      define(Object, key, original)
    }
    expect(getters).toBe(key === "entries" ? 1 : 7)
    expect(inheritedGetters).toBe(0)
    expect(actual?.body).toBe(f.body)
    expect(actual?.payload).toEqual(f.payload)
  }
)

it.each(["entries", "defineProperty"] as const)(
  "preserves a changed %s data descriptor without changing the original result",
  (key) => {
    const f = fixture(),
      read = f.database.prepareReadOne(sql)
    const original = descriptor(Object, key)!
    const changed = { ...original, writable: !original.writable }
    define(Object, key, changed)
    let actual: ReturnType<typeof read>, observed: PropertyDescriptor | undefined
    try {
      actual = read([1])
      observed = descriptor(Object, key)
    } finally {
      define(Object, key, original)
    }
    expect(observed).toEqual(changed)
    expect(actual?.body).toBe(f.body)
    expect(actual?.payload).toEqual(f.payload)
  }
)

it("uses the original loop when actual SQL execution changes Object.entries after the pre-call gate", () => {
  const f = fixture(),
    original = descriptor(Object, "entries")!
  let callbacks = 0,
    copies = 0
  f.native.function("actual_change", () => {
    callbacks++
    define(Object, "entries", {
      ...original,
      value: (...args: Parameters<typeof entries>) => {
        copies++
        return apply(entries, Object, args)
      }
    })
    return 1
  })
  const read = f.database.prepareReadOne(
    "SELECT actual_change() AS marker,body,payload FROM actual_values WHERE id=?"
  )
  let actual: ReturnType<typeof read>
  try {
    actual = read([1])
  } finally {
    define(Object, "entries", original)
  }
  expect(callbacks).toBe(1)
  expect(copies).toBe(1)
  expect(actual).toStrictEqual({ marker: 1, body: f.body, payload: f.payload })
})

it.each(["data", "getter"] as const)(
  "does not mistake a fake Reflect.apply %s restored inside its call for an original native row",
  (mode) => {
    const f = fixture(),
      read = f.database.prepareReadOne("SELECT body FROM actual_values WHERE id=?")
    const original = descriptor(Reflect, "apply")!,
      symbol = Symbol("not an ordinary entry")
    let calls = 0
    const replacement = (
      target: (...args: never[]) => unknown,
      receiver: unknown,
      args: unknown[]
    ) => {
      if (target === StatementSync.prototype.get) {
        calls++
        define(Reflect, "apply", original)
        return { body: "fake row", [symbol]: "must stay omitted by the original loop" }
      }
      return apply(target, receiver, args)
    }
    define(
      Reflect,
      "apply",
      mode === "data"
        ? { ...original, value: replacement }
        : {
            configurable: original.configurable,
            enumerable: original.enumerable,
            get: () => replacement
          }
    )
    let actual: ReturnType<typeof read>
    try {
      actual = read([1])
    } finally {
      define(Reflect, "apply", original)
    }
    expect(calls).toBe(1)
    expect(actual).toStrictEqual({ body: "fake row" })
    expect(Reflect.ownKeys(actual!)).toEqual(["body"])
  }
)

it("keeps the original dynamic global Object receiver and its entries observation", () => {
  const f = fixture(),
    read = f.database.prepareReadOne("SELECT body,payload FROM actual_values WHERE id=?")
  const original = descriptor(globalThis, "Object")!
  let calls = 0
  const replacement = {
    getPrototypeOf: Object.getPrototypeOf,
    getOwnPropertyDescriptor: descriptor,
    defineProperty: define,
    entries(value: object) {
      calls++
      return entries(value)
    }
  }
  define(globalThis, "Object", { ...original, value: replacement })
  let actual: ReturnType<typeof read>
  try {
    actual = read([1])
  } finally {
    define(globalThis, "Object", original)
  }
  expect(calls).toBe(1)
  expect(actual).toStrictEqual({ body: f.body, payload: f.payload })
})

it("retains original native receiver failure rather than copying a fabricated statement", () => {
  const f = fixture()
  const prepared = vi.spyOn(f.native, "prepare").mockReturnValue({
    get: StatementSync.prototype.get
  } as StatementSync)
  const read = f.database.prepareReadOne("SELECT body FROM actual_values")
  try {
    expect(() => read()).toThrow(TypeError)
  } finally {
    prepared.mockRestore()
  }
})

it("still rejects an actual database close performed by the original binding getter", () => {
  const f = fixture(),
    read = f.database.prepareReadOne("SELECT body FROM actual_values WHERE id=?")
  const bindings = [1]
  let getters = 0
  define(bindings, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getters++
      f.database.close()
      return 1
    }
  })
  expect(() => read(bindings)).toThrow("Database is closed")
  expect(getters).toBe(1)
  expect(() => read([1])).toThrow("Database is closed")
})
