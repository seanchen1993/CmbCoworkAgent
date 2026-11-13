import { DatabaseSync, StatementSync } from "node:sqlite"
import { types } from "node:util"
import { NativeSqliteAdapter } from "./native-sqlite-adapter"

const currentDescriptor = Object.getOwnPropertyDescriptor
const currentPrototype = Object.getPrototypeOf
const currentIsProxy = types.isProxy
const nativePrepare = DatabaseSync.prototype.prepare
const nativeGet = StatementSync.prototype.get
const publicReadOne = NativeSqliteAdapter.prototype.prepareReadOne
const currentUint8Array = Uint8Array
const typedConstructor = currentPrototype(currentUint8Array)
const functionPrototype = Function.prototype
const hasInstanceKey = Symbol.hasInstance
const nativeHasInstance = currentDescriptor(functionPrototype, hasInstanceKey)!.value

/** Qualify actual callback-free SQLite dispatch, rather than poll unrelated Main globals. */
export function originalCurrentDispatch(database: NativeSqliteAdapter): boolean {
  // Native row copying actually executes `value instanceof Uint8Array` after SQLite returns.
  // A customized operand/hasInstance can run a callback that invalidates the joined row.
  const operand = currentDescriptor(globalThis, "Uint8Array")
  const hasInstance = currentDescriptor(functionPrototype, hasInstanceKey)
  if (!operand || !("value" in operand) || operand.value !== currentUint8Array ||
    currentDescriptor(currentUint8Array, hasInstanceKey) ||
    currentPrototype(currentUint8Array) !== typedConstructor ||
    currentDescriptor(typedConstructor, hasInstanceKey) ||
    currentPrototype(typedConstructor) !== functionPrototype ||
    !hasInstance || !("value" in hasInstance) || hasInstance.value !== nativeHasInstance)
    return false
  if (currentIsProxy(database) || currentPrototype(database) !== NativeSqliteAdapter.prototype)
    return false
  const field = currentDescriptor(database, "native")
  if (
    !field ||
    !("value" in field) ||
    !field.value ||
    currentIsProxy(field.value) ||
    currentPrototype(field.value) !== DatabaseSync.prototype ||
    currentDescriptor(field.value, "prepare") ||
    currentDescriptor(database, "prepareReadOne")
  )
    return false
  const prepare = currentDescriptor(DatabaseSync.prototype, "prepare")
  const get = currentDescriptor(StatementSync.prototype, "get")
  const read = currentDescriptor(NativeSqliteAdapter.prototype, "prepareReadOne")
  return (
    !!prepare &&
    "value" in prepare &&
    prepare.value === nativePrepare &&
    !!get &&
    "value" in get &&
    get.value === nativeGet &&
    !!read &&
    "value" in read &&
    read.value === publicReadOne
  )
}
