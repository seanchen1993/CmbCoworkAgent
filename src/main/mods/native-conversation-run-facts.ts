import { statSync, realpathSync } from "node:fs"
import { DatabaseSync, StatementSync } from "node:sqlite"
import { types } from "node:util"
import { getDb } from "../db"
import { NativeSqliteAdapter, readFunctionConversationNativeSqliteCurrentExecution }
  from "../db/native-sqlite-adapter"
import { readFunctionConversationThreadIdentityCurrent } from "../db/function-conversation-thread-identity-read"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import { matchesThreadIncarnation, type ThreadIncarnationRow } from "../services/thread-incarnation"

const descriptor = Object.getOwnPropertyDescriptor, prototypeOf = Object.getPrototypeOf
const hasInstanceKey = Symbol.hasInstance
const typedConstructor = prototypeOf(Uint8Array)
const functionHasInstance = descriptor(Function.prototype, hasInstanceKey)!
const originalProxy = types.isProxy
const originalStat = statSync, originalRealpath = realpathSync
const originalThread = readFunctionConversationThreadIdentityCurrent, originalDb = getDb
const originalLease = getLocalThreadRunLease, originalMatches = matchesThreadIncarnation
const fields: Array<readonly [object, PropertyKey, PropertyDescriptor]> = []
function capture(receiver: object, key: PropertyKey): void {
  const field = descriptor(receiver, key)
  if (!field) throw Error("NATIVE_FACTS_INTRINSIC_MISSING")
  fields[fields.length] = [receiver, key, field]
}
// These are exactly the operations used by the physical facts window, its original registry
// readers, and the fixed native read-one adapter. Unknown replacements keep the two old windows.
for (const key of ["Object", "Array", "Reflect", "JSON", "Number", "BigInt", "Function", "Map", "WeakMap", "WeakSet",
  "Uint8Array", "AbortSignal"]) capture(globalThis, key)
for (const key of ["getOwnPropertyDescriptor", "getPrototypeOf", "freeze", "keys", "entries",
  "defineProperty"]) capture(Object, key)
for (const key of ["apply", "get"]) capture(Reflect, key)
for (const key of ["parse", "stringify"]) capture(JSON, key)
capture(Array, "isArray")
capture(Number, "isFinite")
capture(Map.prototype, "get")
capture(AbortSignal.prototype, "throwIfAborted")
capture(AbortSignal.prototype, "aborted")
capture(NativeSqliteAdapter.prototype, "prepareReadOne")
capture(DatabaseSync.prototype, "prepare")
capture(StatementSync.prototype, "get")
const absentKeys = ["toJSON", "workspacePath", "cmb_thread_incarnation"] as const

function same(receiver: object, key: PropertyKey, expected: PropertyDescriptor): boolean {
  const field = descriptor(receiver, key)
  return !!field && field.value === expected.value && field.get === expected.get &&
    field.set === expected.set && field.writable === expected.writable &&
    field.enumerable === expected.enumerable && field.configurable === expected.configurable
}

export function nativeRunFactsCurrent(database: NativeSqliteAdapter): boolean {
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (!same(field[0], field[1], field[2])) return false
  }
  if (types.isProxy !== originalProxy || descriptor(Uint8Array, hasInstanceKey) ||
    prototypeOf(Uint8Array) !== typedConstructor || descriptor(typedConstructor, hasInstanceKey) ||
    prototypeOf(typedConstructor) !== Function.prototype ||
    !same(Function.prototype, hasInstanceKey, functionHasInstance) ||
    prototypeOf(Array.prototype) !== Object.prototype || prototypeOf(Object.prototype) !== null ||
    descriptor(Array.prototype, "0") || descriptor(Object.prototype, "0")) return false
  if (statSync !== originalStat || realpathSync !== originalRealpath ||
    getDb !== originalDb || getLocalThreadRunLease !== originalLease ||
    readFunctionConversationThreadIdentityCurrent !== originalThread ||
    matchesThreadIncarnation !== originalMatches) return false
  for (let index = 0; index < absentKeys.length; index++)
    if (descriptor(Object.prototype, absentKeys[index])) return false
  if (descriptor(Array.prototype, "toJSON") || types.isProxy(database) ||
    prototypeOf(database) !== NativeSqliteAdapter.prototype || descriptor(database, "prepareReadOne"))
    return false
  const native = descriptor(database, "native")
  return !!native && "value" in native && !types.isProxy(native.value) &&
    prototypeOf(native.value) === DatabaseSync.prototype && !descriptor(native.value, "prepare")
}

/** The original Stats method chain, observed from the actual native stat result at admission. */
export function captureNativeRunStatMethods(stat: object): () => boolean {
  const chain: Array<readonly [object, object | null, PropertyDescriptor | undefined,
    PropertyDescriptor | undefined]> = []
  let value: object | null = stat
  // Native instances differ on each read; retain and recheck the observed prototype relationships.
  value = prototypeOf(value)
  while (value) {
    const parent = prototypeOf(value)
    chain[chain.length] = [value, parent, descriptor(value, "isDirectory"),
      descriptor(value, "_checkModeProperty")]
    value = parent
  }
  return () => {
    for (let index = 0; index < chain.length; index++) {
      const item = chain[index], field = descriptor(item[0], "isDirectory")
      if (prototypeOf(item[0]) !== item[1]) return false
      if (item[2] ? !same(item[0], "isDirectory", item[2]) : field !== undefined) return false
      if (item[3] ? !same(item[0], "_checkModeProperty", item[3]) :
        descriptor(item[0], "_checkModeProperty") !== undefined) return false
    }
    return true
  }
}

/** Own fixed native get, never a cached public reader that might have captured an override. */
export function prepareNativeRunFactsRead(database: NativeSqliteAdapter, threadId: string):
  (() => ThreadIncarnationRow | null) | undefined {
  if (!nativeRunFactsCurrent(database)) return undefined
  const native = readFunctionConversationNativeSqliteCurrentExecution(database)
  if (!native) return undefined
  const read = native.prepareReadOne("SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1")
  return () => {
    native.assertDataCurrent()
    const row = read([threadId])
    return row ? row as unknown as ThreadIncarnationRow : null
  }
}
