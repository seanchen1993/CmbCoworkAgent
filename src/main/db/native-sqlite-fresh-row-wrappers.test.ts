import { DatabaseSync, StatementSync } from "node:sqlite"
import { types } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import type { NativeSqliteValue } from "./native-sqlite-adapter"

const own = Object.getOwnPropertyDescriptor, define = Object.defineProperty
const prototype = Object.getPrototypeOf, invoke = Reflect.apply
const nativeGet = StatementSync.prototype.get, nativeSource = Function.prototype.toString
const restore: Array<() => void> = []
type Row = Record<string, NativeSqliteValue>

afterEach(() => {
  for (let index = restore.length - 1; index >= 0; index--) restore[index]()
  restore.length = 0
  vi.resetModules()
})

function replace(receiver: object, key: PropertyKey, value: unknown): () => void {
  const original = own(receiver, key)!
  define(receiver, key, { ...original, value })
  let restored = false
  const undo = () => {
    if (restored) return
    restored = true
    define(receiver, key, original)
  }
  restore.push(undo)
  return undo
}

it.each(["plain", "own-toString", "bound", "proxy"] as const)(
  "retains the copy contract of a pre-import %s get wrapper holding the actual raw row", async mode => {
    vi.resetModules()
    const native = new DatabaseSync(":memory:")
    const sql = "SELECT 7 AS value,x'0001FF' AS payload,'own' AS \"__proto__\""
    const boundStatement = native.prepare(sql)
    let raw: Row | undefined, disguisedCalls = 0
    const wrapped = function(this: StatementSync, ...args: unknown[]) {
      raw = invoke(nativeGet, this, args) as Row
      return raw
    }
    if (mode === "own-toString") define(wrapped, "toString", { value: () => {
      disguisedCalls++
      return invoke(nativeSource, nativeGet, [])
    } })
    const replacement = mode === "bound" ? wrapped.bind(boundStatement) : mode === "proxy"
      ? new Proxy(wrapped, { apply: (target, receiver, args) => invoke(target, receiver, args) })
      : wrapped
    const undo = replace(StatementSync.prototype, "get", replacement)
    try {
      const { NativeSqliteAdapter } = await import("./native-sqlite-adapter")
      const database = new NativeSqliteAdapter(native)
      const result = database.prepareReadOne(sql)()!
      undo()
      expect(raw).toBeDefined()
      expect(prototype(raw!)).toBeNull()
      expect(prototype(result)).toBe(Object.prototype)
      expect(result).not.toBe(raw)
      expect(result.payload).not.toBe(raw!.payload)
      expect(disguisedCalls).toBe(0)
      if (!(result.payload instanceof Uint8Array) || !(raw!.payload instanceof Uint8Array))
        throw Error("ACTUAL_BLOBS_REQUIRED")
      result.payload[0] = 99
      expect(raw!.payload).toEqual(new Uint8Array([0, 1, 255]))
      database.close({ checkpoint: false })
    } finally { undo(); if (native.isOpen) native.close() }
  }
)

it.each(["getPrototypeOf", "getOwnPropertyDescriptor", "setPrototypeOf", "isArray", "isProxy", "keys"] as const)(
  "does not expose native raw rows to a pre-import %s wrapper", async key => {
    vi.resetModules()
    const receiver = key === "isProxy" ? types : key === "isArray" ? Array : Object
    const original = own(receiver, key)!.value as (...args: unknown[]) => unknown
    let rawExposures = 0, copiedRows = 0
    const wrapped = (...args: unknown[]) => {
      const value = args[0]
      if (value && typeof value === "object" && own(value, "payload") && own(value, "value")) {
        if (prototype(value) === null) rawExposures++
        else if (key === "keys") copiedRows++
      }
      return invoke(original, receiver, args)
    }
    const undo = replace(receiver, key, wrapped)
    let module: typeof import("./native-sqlite-adapter")
    try { module = await import("./native-sqlite-adapter") }
    finally { undo() }
    const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
    try {
      const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
      const first = read()!, second = read()!
      expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
      expect(prototype(first)).toBe(Object.prototype)
      expect(rawExposures).toBe(0)
      if (key === "keys") expect(copiedRows).toBe(2)
      expect(first.payload).not.toBe(second.payload)
    } finally { database.close({ checkpoint: false }) }
  }
)

it("keeps a pre-import typed-array constructor wrapper on the original blob-copy path", async () => {
  vi.resetModules()
  const Bytes = Uint8Array
  let armed = false, observed: Uint8Array | undefined
  const wrapped = function(value: number | ArrayLike<number>) {
    if (armed && value instanceof Bytes) observed = value
    return typeof value === "number" ? new Bytes(value) : new Bytes(value)
  }
  define(wrapped, "prototype", { value: Bytes.prototype })
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(Bytes))
  const undo = replace(globalThis, "Uint8Array", wrapped)
  const native = new DatabaseSync(":memory:")
  try {
    const { NativeSqliteAdapter } = await import("./native-sqlite-adapter")
    const database = new NativeSqliteAdapter(native)
    const read = database.prepareReadOne("SELECT x'0001FF' AS payload")
    armed = true
    const row = read()!
    armed = false
    undo()
    expect(observed).toBeDefined()
    expect(row.payload).not.toBe(observed)
    if (!(row.payload instanceof Bytes)) throw Error("ACTUAL_BLOB_REQUIRED")
    row.payload[0] = 99
    expect(observed).toEqual(new Bytes([0, 1, 255]))
    database.close({ checkpoint: false })
  } finally { armed = false; undo(); if (native.isOpen) native.close() }
})

it("treats an optional source-detector exception as copy fallback without failing import", async () => {
  vi.resetModules()
  let detectorCalls = 0
  const replacement = function(this: unknown) {
    if (this === replacement) { detectorCalls++; throw Error("OPTIONAL_DETECTOR_FAILURE") }
    return invoke(nativeSource, this, [])
  }
  const undo = replace(Function.prototype, "toString", replacement)
  let module: typeof import("./native-sqlite-adapter")
  try { module = await import("./native-sqlite-adapter") }
  finally { undo() }
  const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
  try {
    const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
    const first = read()!, second = read()!
    expect(detectorCalls).toBeGreaterThan(0)
    expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
    expect(prototype(first)).toBe(Object.prototype)
    expect(first.payload).not.toBe(second.payload)
  } finally { database.close({ checkpoint: false }) }
})

it("does not pass new function inputs to an initial prototype shim that rejects them", async () => {
  vi.resetModules()
  let functionInputs = 0
  const undo = replace(Object, "getPrototypeOf", (value: unknown) => {
    if (typeof value === "function") { functionInputs++; throw Error("FUNCTION_INPUT_FORBIDDEN") }
    return prototype(value)
  })
  let module: typeof import("./native-sqlite-adapter")
  try { module = await import("./native-sqlite-adapter") }
  finally { undo() }
  const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
  try {
    expect(functionInputs).toBe(0)
    const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
    const first = read()!, second = read()!
    expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
    expect(prototype(first)).toBe(Object.prototype)
    expect(first.payload).not.toBe(second.payload)
  } finally { database.close({ checkpoint: false }) }
})

it.each(["toString", "setPrototypeOf"] as const)(
  "retains copy fallback when an additional initial %s capture getter throws", async key => {
    vi.resetModules()
    const receiver = key === "toString" ? Function.prototype : Object
    const original = own(receiver, key)!
    let captures = 0
    define(receiver, key, { configurable: true, enumerable: original.enumerable, get() {
      captures++
      throw Error("OPTIONAL_CAPTURE_GETTER_FAILURE")
    } })
    let module: typeof import("./native-sqlite-adapter")
    try { module = await import("./native-sqlite-adapter") }
    finally { define(receiver, key, original) }
    const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
    try {
      const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
      const first = read()!, second = read()!
      expect(captures).toBeGreaterThan(0)
      expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
      expect(prototype(first)).toBe(Object.prototype)
      expect(first.payload).not.toBe(second.payload)
    } finally { database.close({ checkpoint: false }) }
  }
)

it.each([null, Function.prototype])(
  "keeps copy fallback for an initial nonstandard typed-array constructor chain", async parent => {
    vi.resetModules()
    const original = prototype(Uint8Array)
    Object.setPrototypeOf(Uint8Array, parent)
    let module: typeof import("./native-sqlite-adapter")
    try { module = await import("./native-sqlite-adapter") }
    finally { Object.setPrototypeOf(Uint8Array, original) }
    const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
    try {
      const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
      const first = read()!, second = read()!
      expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
      expect(prototype(first)).toBe(Object.prototype)
      expect(first.payload).not.toBe(second.payload)
    } finally { database.close({ checkpoint: false }) }
  }
)

it("keeps copying when an initial getter returns native setPrototypeOf but changes the byte operand", async () => {
  vi.resetModules()
  const Bytes = Uint8Array, setPrototype = Object.setPrototypeOf
  const originalBytes = own(globalThis, "Uint8Array")!, originalSet = own(Object, "setPrototypeOf")!
  let armed = false, constructorCalls = 0, observed: Uint8Array | undefined, captures = 0
  let firstCaptureStack: string | undefined
  const wrapped = function(value: number | ArrayLike<number>) {
    if (armed && value instanceof Bytes) { constructorCalls++; observed = value }
    return typeof value === "number" ? new Bytes(value) : new Bytes(value)
  }
  define(wrapped, "prototype", { value: Bytes.prototype })
  setPrototype(wrapped, prototype(Bytes))
  define(Object, "setPrototypeOf", { configurable: true, enumerable: originalSet.enumerable, get() {
    if (captures === 0) firstCaptureStack = new Error().stack
    captures++
    define(globalThis, "Uint8Array", { ...originalBytes, value: wrapped })
    return setPrototype
  } })
  const native = new DatabaseSync(":memory:")
  try {
    let module: typeof import("./native-sqlite-adapter")
    try { module = await import("./native-sqlite-adapter") }
    finally { define(Object, "setPrototypeOf", originalSet) }
    const database = new module.NativeSqliteAdapter(native)
    const read = database.prepareReadOne("SELECT x'0001FF' AS payload")
    armed = true
    const first = read()!, firstObserved = observed, second = read()!
    armed = false
    define(globalThis, "Uint8Array", originalBytes)
    expect(captures).toBeGreaterThan(0)
    expect(firstCaptureStack).toContain("captureFreshNativeRowTransfer")
    expect(constructorCalls).toBe(2)
    expect(firstObserved).toBeDefined()
    expect(first.payload).not.toBe(firstObserved)
    expect(prototype(first)).toBe(Object.prototype)
    if (!(first.payload instanceof Bytes)) throw Error("ACTUAL_BLOB_REQUIRED")
    first.payload[0] = 99
    expect(firstObserved).toEqual(new Bytes([0, 1, 255]))
    expect(second.payload).toEqual(new Bytes([0, 1, 255]))
    database.close({ checkpoint: false })
  } finally {
    armed = false
    define(Object, "setPrototypeOf", originalSet)
    define(globalThis, "Uint8Array", originalBytes)
    if (native.isOpen) native.close()
  }
})

it("keeps escaped raw rows private from results when an initial Reflect Proxy masks its later apply", async () => {
  vi.resetModules()
  const originalReflect = Reflect, nativeReflectGet = Reflect.get
  let armed = false, claims = 0, nativeCalls = 0, raw: Row | undefined
  const wrappedApply = (target: (...args: never[]) => unknown, receiver: unknown, args: unknown[]) => {
    const result = invoke(target, receiver, args)
    if (target === nativeGet) { nativeCalls++; raw = result as Row }
    return result
  }
  const proxy = new Proxy(originalReflect, {
    get(target, key, receiver) {
      return key === "apply" && armed ? wrappedApply : invoke(nativeReflectGet, originalReflect,
        [target, key, receiver])
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === "apply" && armed) claims++
      return own(target, key)
    }
  })
  const undo = replace(globalThis, "Reflect", proxy)
  const native = new DatabaseSync(":memory:")
  try {
    const { NativeSqliteAdapter } = await import("./native-sqlite-adapter")
    const database = new NativeSqliteAdapter(native)
    armed = true
    const result = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")()!
    armed = false
    undo()
    expect(claims).toBeGreaterThan(0)
    expect(nativeCalls).toBe(1)
    expect(raw).toBeDefined()
    expect(prototype(raw!)).toBeNull()
    expect(prototype(result)).toBe(Object.prototype)
    expect(result).not.toBe(raw)
    expect(result.payload).not.toBe(raw!.payload)
    if (!(result.payload instanceof Uint8Array)) throw Error("ACTUAL_BLOB_REQUIRED")
    result.payload[0] = 99
    expect(raw!.payload).toEqual(new Uint8Array([0, 1, 255]))
    database.close({ checkpoint: false })
  } finally { armed = false; undo(); if (native.isOpen) native.close() }
})

it("uses the captured native Symbol key when a native-returning source getter changes its namespace", async () => {
  vi.resetModules()
  const FunctionCtor = Function, SymbolCtor = Symbol, Bytes = Uint8Array
  const originalSymbol = own(globalThis, "Symbol")!, sourceField = own(FunctionCtor.prototype, "toString")!
  const trueKey = SymbolCtor.hasInstance, fakeKey = SymbolCtor("fake.hasInstance")
  const originalBytesInstance = own(Bytes, trueKey)
  const nativeInstance = own(FunctionCtor.prototype, trueKey)!.value
  const fakeSymbol = (...args: unknown[]) => invoke(SymbolCtor, undefined, args)
  Object.setPrototypeOf(fakeSymbol, SymbolCtor)
  define(fakeSymbol, "hasInstance", { value: fakeKey })
  define(FunctionCtor.prototype, fakeKey, { configurable: true, value: nativeInstance })
  let callbacks = 0, captures = 0, firstCaptureStack: string | undefined
  define(FunctionCtor.prototype, "toString", {
    configurable: true, enumerable: sourceField.enumerable, get() {
      if (captures === 0) firstCaptureStack = new Error().stack
      captures++
      define(globalThis, "Symbol", { ...originalSymbol, value: fakeSymbol })
      define(Bytes, trueKey, { configurable: true, value(value: unknown) {
        callbacks++
        return invoke(nativeInstance, Bytes, [value])
      } })
      return nativeSource
    }
  })
  const restoreNamespace = () => {
    define(FunctionCtor.prototype, "toString", sourceField)
    define(globalThis, "Symbol", originalSymbol)
    if (originalBytesInstance) define(Bytes, trueKey, originalBytesInstance)
    else Reflect.deleteProperty(Bytes, trueKey)
    Reflect.deleteProperty(FunctionCtor.prototype, fakeKey)
  }
  const native = new DatabaseSync(":memory:")
  try {
    let module: typeof import("./native-sqlite-adapter")
    try { module = await import("./native-sqlite-adapter") }
    finally { define(FunctionCtor.prototype, "toString", sourceField) }
    const database = new module.NativeSqliteAdapter(native)
    const result = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")()!
    restoreNamespace()
    expect(captures).toBeGreaterThan(0)
    expect(firstCaptureStack).toContain("captureFreshNativeRowTransfer")
    expect(callbacks).toBe(2)
    expect(result).toEqual({ value: 7, payload: new Bytes([0, 1, 255]) })
    expect(prototype(result)).toBe(Object.prototype)
    database.close({ checkpoint: false })
  } finally { restoreNamespace(); if (native.isOpen) native.close() }
})

it("never exposes owned native rows to an anonymous metadata-shaped cold predicate", async () => {
  vi.resetModules()
  const actual = types.isProxy
  let selfCalls = 0, coldCalls = 0, rawExposures = 0
  const forward = (value: unknown) => {
    coldCalls++
    if (value === candidate) selfCalls++
    if (value && typeof value === "object" && prototype(value) === null &&
      own(value, "payload") && own(value, "value")) rawExposures++
    return actual(value)
  }
  const candidate: typeof types.isProxy = forward.bind(undefined)
  define(candidate, "name", { value: "" })
  define(candidate, "length", { value: 0 })
  const undo = replace(types, "isProxy", candidate)
  let module: typeof import("./native-sqlite-adapter")
  try { module = await import("./native-sqlite-adapter") }
  finally { undo() }
  const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
  try {
    const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
    const first = read()!, second = read()!
    expect(selfCalls).toBe(1)
    expect(coldCalls).toBeGreaterThan(1)
    expect(rawExposures).toBe(0)
    expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
    expect(prototype(first)).toBe(Object.prototype)
    expect(first.payload).not.toBe(second.payload)
  } finally { database.close({ checkpoint: false }) }
})

it("opts out ordinary bound, forwarding Proxy and own-toString predicate wrappers", async () => {
  for (const mode of ["bound", "proxy", "own-toString"] as const) {
    vi.resetModules()
    const actual = types.isProxy
    let selfCalls = 0
    const forward = (value: unknown) => {
      if (value === candidate) selfCalls++
      return actual(value)
    }
    const candidate: typeof types.isProxy = mode === "bound" ? forward.bind(undefined) : mode === "proxy"
      ? new Proxy(actual, { apply(target, receiver, args) {
        if (args[0] === candidate) selfCalls++
        return invoke(target, receiver, args)
      } }) : forward
    if (mode === "own-toString") define(candidate, "toString", {
      value: () => invoke(nativeSource, actual, [])
    })
    const undo = replace(types, "isProxy", candidate)
    let module: typeof import("./native-sqlite-adapter")
    try { module = await import("./native-sqlite-adapter") }
    finally { undo() }
    const native = new DatabaseSync(":memory:"), database = new module.NativeSqliteAdapter(native)
    try {
      const read = database.prepareReadOne("SELECT 7 AS value,x'0001FF' AS payload")
      const first = read()!, second = read()!
      expect(selfCalls).toBe(mode === "proxy" ? 1 : 0)
      expect(prototype(first)).toBe(Object.prototype)
      expect(first).toEqual({ value: 7, payload: new Uint8Array([0, 1, 255]) })
      expect(first.payload).not.toBe(second.payload)
    } finally { database.close({ checkpoint: false }) }
  }
})
