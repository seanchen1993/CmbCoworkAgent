import { DatabaseSync, StatementSync } from "node:sqlite"
import { types } from "node:util"
import { NativeSqliteAdapter } from "./native-sqlite-adapter"

const currentDescriptor = Object.getOwnPropertyDescriptor, currentPrototype = Object.getPrototypeOf
const currentApply = Reflect.apply
const nativePrepare = DatabaseSync.prototype.prepare, nativeGet = StatementSync.prototype.get
const publicReadOne = NativeSqliteAdapter.prototype.prepareReadOne
const currentArrayIsArray = Array.isArray, currentNumber = Number
const currentSafeInteger = Number.isSafeInteger
const currentEntries = Object.entries, currentDefine = Object.defineProperty
const currentObject = Object, currentArray = Array, currentReflect = Reflect
const currentUint8Array = Uint8Array, currentFunction = Function, currentIsProxy = types.isProxy
const currentHasInstanceKey = Symbol.hasInstance
const currentTypedConstructor = currentPrototype(currentUint8Array)
const currentHasInstance = currentDescriptor(currentFunction.prototype, currentHasInstanceKey)!.value
function currentDataField(receiver: object, key: PropertyKey, value: unknown): boolean {
  const field = currentDescriptor(receiver, key)
  return !!field && "value" in field && field.value === value
}

export function originalCurrentDispatch(database: NativeSqliteAdapter): boolean {
  // Fixed readers still traverse these origin/row helpers; an override must keep the old windows.
  if (!currentDataField(globalThis, "Object", currentObject) ||
    !currentDataField(globalThis, "Array", currentArray) ||
    !currentDataField(globalThis, "Reflect", currentReflect) ||
    !currentDataField(globalThis, "Uint8Array", currentUint8Array) ||
    !currentDataField(globalThis, "Function", currentFunction) ||
    !currentDataField(currentObject, "getOwnPropertyDescriptor", currentDescriptor) ||
    !currentDataField(currentObject, "getPrototypeOf", currentPrototype) ||
    !currentDataField(currentNumber, "isSafeInteger", currentSafeInteger)) return false
  if (types.isProxy !== currentIsProxy ||
    currentDescriptor(currentUint8Array, currentHasInstanceKey) ||
    currentPrototype(currentUint8Array) !== currentTypedConstructor ||
    currentDescriptor(currentTypedConstructor, currentHasInstanceKey) ||
    currentPrototype(currentTypedConstructor) !== currentFunction.prototype ||
    !currentDataField(currentFunction.prototype, currentHasInstanceKey, currentHasInstance) ||
    currentPrototype(currentArray.prototype) !== currentObject.prototype ||
    currentPrototype(currentObject.prototype) !== null) return false
  // Joined transfer deduplication binds four primitives, including the previous raw metadata.
  // Array normalization must not call an inherited setter for any of those positions.
  for (let index = 0; index < 4; index++)
    if (currentDescriptor(currentArray.prototype, index) ||
      currentDescriptor(currentObject.prototype, index)) return false
  if (types.isProxy(database) || currentPrototype(database) !== NativeSqliteAdapter.prototype) return false
  const field = currentDescriptor(database, "native")
  if (!field || !("value" in field) || !field.value ||
    types.isProxy(field.value) || currentPrototype(field.value) !== DatabaseSync.prototype ||
    currentDescriptor(field.value, "prepare") || currentDescriptor(database, "prepareReadOne")) return false
  const prepare = currentDescriptor(DatabaseSync.prototype, "prepare")
  const get = currentDescriptor(StatementSync.prototype, "get")
  const read = currentDescriptor(NativeSqliteAdapter.prototype, "prepareReadOne")
  const apply = currentDescriptor(Reflect, "apply")
  const entries = currentDescriptor(Object, "entries"), define = currentDescriptor(Object, "defineProperty")
  const array = currentDescriptor(Array, "isArray")
  return !!prepare && "value" in prepare && prepare.value === nativePrepare &&
    !!get && "value" in get && get.value === nativeGet &&
    !!read && "value" in read && read.value === publicReadOne &&
    !!apply && "value" in apply && apply.value === currentApply &&
    !!entries && "value" in entries && entries.value === currentEntries &&
    !!define && "value" in define && define.value === currentDefine &&
    !!array && "value" in array && array.value === currentArrayIsArray
}
