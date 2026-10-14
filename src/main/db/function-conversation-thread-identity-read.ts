import type { ThreadIncarnationRow } from "../services/thread-incarnation"
import type { NativeSqliteAdapter, NativeSqliteReadOne } from "./native-sqlite-adapter"

const QUERY = "SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1"
const statements = new WeakMap<NativeSqliteAdapter, NativeSqliteReadOne>()
const inUse = new WeakSet<NativeSqliteAdapter>()
const statementGet = WeakMap.prototype.get
const statementSet = WeakMap.prototype.set
const statementDelete = WeakMap.prototype.delete
const useHas = WeakSet.prototype.has
const useAdd = WeakSet.prototype.add
const useDelete = WeakSet.prototype.delete

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
      read = database.prepareReadOne(QUERY)
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
