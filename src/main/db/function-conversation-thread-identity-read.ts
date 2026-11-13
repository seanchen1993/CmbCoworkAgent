import { types } from "node:util"
import type { ThreadIncarnationRow } from
  "../services/thread-incarnation"
import type { NativeSqliteAdapter, NativeSqliteReadOne } from "./native-sqlite-adapter"
import { originalCurrentDispatch } from "./native-read-dispatch"
import { THREAD_RUNTIME_SCOPE_EXPRESSION, THREAD_RUNTIME_SCOPE_INDEX } from
  "./thread-runtime-scope-query"

const QUERY = "SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1"
const statements = new WeakMap<NativeSqliteAdapter, NativeSqliteReadOne>()
const inUse = new WeakSet<NativeSqliteAdapter>()
const statementGet = WeakMap.prototype.get
const statementSet = WeakMap.prototype.set
const statementDelete = WeakMap.prototype.delete
const useHas = WeakSet.prototype.has
const useAdd = WeakSet.prototype.add
const useDelete = WeakSet.prototype.delete
const apply = Reflect.apply
const descriptor = Object.getOwnPropertyDescriptor
const isProxy = types.isProxy
const isNativeError = types.isNativeError
const originalDispatch = originalCurrentDispatch
const pureReaders = new WeakSet<NativeSqliteReadOne>()
const identityFields = [
  [WeakMap.prototype, "get", statementGet],
  [WeakMap.prototype, "set", statementSet],
  [WeakMap.prototype, "delete", statementDelete],
  [WeakSet.prototype, "has", useHas],
  [WeakSet.prototype, "add", useAdd],
  [WeakSet.prototype, "delete", useDelete],
  [RegExp.prototype, "test", RegExp.prototype.test],
  [RegExp.prototype, "exec", RegExp.prototype.exec]
] as const

function originalIdentityDispatch(database: NativeSqliteAdapter): boolean {
  if (originalCurrentDispatch !== originalDispatch || !originalDispatch(database)) return false
  for (let index = 0; index < identityFields.length; index++) {
    const expected = identityFields[index]
    const field = descriptor(expected[0], expected[1])
    if (!field || !("value" in field) || field.value !== expected[2]) return false
  }
  return true
}

function currentStatement(database: NativeSqliteAdapter): NativeSqliteReadOne | undefined {
  return Reflect.apply(statementGet, statements, [database]) as NativeSqliteReadOne | undefined
}

/** Read complete current identity data; the cached statement never caches a row or authority. */
export function readFunctionConversationThreadIdentityCurrent(
  database: NativeSqliteAdapter,
  threadId: string
): ThreadIncarnationRow | null {
  const temporary = Reflect.apply(useHas, inUse, [database]) as boolean
  if (!temporary) Reflect.apply(useAdd, inUse, [database])
  let read: NativeSqliteReadOne | undefined
  try {
    read = temporary ? database.prepareReadOne(QUERY) : currentStatement(database)
    if (!read) {
      const pure = originalIdentityDispatch(database)
      read = database.prepareReadOne(QUERY)
      if (pure && originalIdentityDispatch(database)) apply(useAdd, pureReaders, [read])
      Reflect.apply(statementSet, statements, [database, read])
    }
    const row = read([threadId])
    return row ? (row as unknown as ThreadIncarnationRow) : null
  } catch (error) {
    if (!temporary && currentStatement(database) === read)
      Reflect.apply(statementDelete, statements, [database])
    throw error
  } finally {
    if (!temporary) Reflect.apply(useDelete, inUse, [database])
  }
}

const INCARNATION_QUERY = `SELECT created_at,
  CASE WHEN typeof(metadata)='text' THEN ${THREAD_RUNTIME_SCOPE_EXPRESSION}
    ELSE metadata END AS metadata
  FROM threads INDEXED BY ${THREAD_RUNTIME_SCOPE_INDEX} WHERE thread_id = ? LIMIT 1`
// A null reader means this connection lacks the optional index. It keeps using fresh raw
// reads rather than retrying a failed preparation on every guard. No row or verdict is cached.
const incarnationStatements = new WeakMap<NativeSqliteAdapter, NativeSqliteReadOne | null>()

function pureIdentityInputs(database: NativeSqliteAdapter): boolean {
  if (!originalIdentityDispatch(database)) return false
  const prior = apply(statementGet, statements, [database]) as NativeSqliteReadOne | undefined
  return !prior || apply(useHas, pureReaders, [prior]) === true
}

function missingScopeIndex(error: unknown): boolean {
  if (!error || typeof error !== "object" || isProxy(error) || !isNativeError(error)) return false
  const code = descriptor(error, "code"), message = descriptor(error, "message")
  return !!code && "value" in code && code.value === "ERR_SQLITE_ERROR" &&
    !!message && "value" in message &&
    message.value === `no such index: ${THREAD_RUNTIME_SCOPE_INDEX}`
}

/** Incarnation-only native consumer; custom readers always retain their complete raw input. */
export function readFunctionConversationThreadIncarnationCurrent(
  database: NativeSqliteAdapter,
  threadId: string
): ThreadIncarnationRow | null {
  if (!pureIdentityInputs(database) || apply(useHas, inUse, [database]))
    return readFunctionConversationThreadIdentityCurrent(database, threadId)
  let read = apply(statementGet, incarnationStatements, [database]) as
    NativeSqliteReadOne | null | undefined
  if (read === null) return readFunctionConversationThreadIdentityCurrent(database, threadId)
  apply(useAdd, inUse, [database])
  let fallback = false
  let row: ReturnType<NativeSqliteReadOne>
  try {
    if (!read) {
      read = database.prepareReadOne(INCARNATION_QUERY)
      if (pureIdentityInputs(database)) apply(statementSet, incarnationStatements, [database, read])
      else fallback = true
    }
    if (!fallback) row = read([threadId])
  } catch (error) {
    if (apply(statementGet, incarnationStatements, [database]) === read)
      apply(statementDelete, incarnationStatements, [database])
    if (!missingScopeIndex(error)) throw error
    if (pureIdentityInputs(database)) apply(statementSet, incarnationStatements, [database, null])
    fallback = true
  } finally {
    // Only this call owns this marker. Reentrant raw reads are temporary and cannot remove it.
    apply(useDelete, inUse, [database])
  }
  // Release our marker before falling back so a previously cached public custom closure is
  // honored. An actual nested call still sees the outer marker and uses the original temporary path.
  if (fallback || !pureIdentityInputs(database))
    return readFunctionConversationThreadIdentityCurrent(database, threadId)
  return row ? (row as unknown as ThreadIncarnationRow) : null
}
