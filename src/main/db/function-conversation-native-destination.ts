import { createHash } from "node:crypto"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import type { FunctionConversationRef } from "./function-conversation-store"
import type { NativeSqliteAdapter, NativeSqliteValue, NativeSqliteReadOne } from "./native-sqlite-adapter"

export interface FunctionConversationNativeDestination {
  readonly parent: FunctionConversationRef
  readonly invocationId: string
  readonly checkpointThreadId: string
  readonly checkpointIncarnation: ThreadIncarnation
  readonly destinationThreadId: string
  readonly destinationIncarnation: ThreadIncarnation
  readonly originalMetadata: string
  assertCurrent(): void
}

const dataScopeBrand = Symbol("function-conversation-native-destination-data-scope")
export interface FunctionConversationNativeDestinationDataScope {
  readonly [dataScopeBrand]: true
}
interface ScopeThread {
  readonly id: string
  readonly incarnation: ThreadIncarnation
  readonly createdAt: number
  readonly metadata: string | null
}
interface DestinationData {
  readonly database: NativeSqliteAdapter
  readonly target: FunctionConversationRef
  readonly parent: FunctionConversationRef
  readonly threads: readonly { readonly id: string; readonly incarnation: ThreadIncarnation }[]
  assertCurrent(): void
  readThreads(): readonly ScopeThread[]
  reading: boolean
  failed: boolean
}

const table = "function_conversation_native_destinations"
const destinationData = new WeakMap<FunctionConversationNativeDestination, DestinationData>()
const destinationWeakGet = WeakMap.prototype.get, destinationWeakSet = WeakMap.prototype.set
const destinationWeakDelete = WeakMap.prototype.delete
function readData<K extends object, V>(records: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(destinationWeakGet, records, [key]) as V | undefined
}
const dataScopes = new WeakMap<FunctionConversationNativeDestinationDataScope, {
  readonly destination: FunctionConversationNativeDestination
  readonly original: DestinationData
  threads?: readonly ScopeThread[]
}>()
type SqlRow = Record<string, NativeSqliteValue>
type MappingEntries = readonly (readonly [string, NativeSqliteValue])[]
const threadSql = "SELECT created_at,metadata FROM threads WHERE thread_id=?"
const refSql = `SELECT c.invocation_id,c.kind,c.checkpoint_namespace,s.thread_id,
    s.incarnation_key,s.workspace FROM function_conversations c
    JOIN function_logical_sessions s ON s.logical_session_id=c.logical_session_id
    JOIN function_conversation_branches b ON b.conversation_id=c.conversation_id
    WHERE c.conversation_id=? AND s.logical_session_id=? AND b.branch_id=?`
const mappingSql = `SELECT * FROM ${table} WHERE conversation_id=? AND branch_id=?`
interface DestinationReaders {
  readonly thread: NativeSqliteReadOne
  readonly ref: NativeSqliteReadOne
  readonly mapping: NativeSqliteReadOne
}

/** One fresh, coherent data read. Original source callbacks stay outside this statement. */
function destinationSnapshot(db: NativeSqliteAdapter, original: MappingEntries,
  target: FunctionConversationRef, parent: FunctionConversationRef,
  checkpointThreadId: string, checkpoint: ThreadIncarnation,
  destinationThreadId: string, destination: ThreadIncarnation,
  invocationId: string, originalMetadata: string): () => readonly ScopeThread[] {
  let prefix = "__cmb_native_destination_"
  while (true) {
    let collision = false
    for (let index = 0; index < original.length; index++) {
      if (original[index][0].startsWith(prefix)) { collision = true; break }
    }
    if (!collision) break
    prefix += "x_"
  }
  let upper = ""
  for (let index = 0; index < prefix.length - 1; index++) upper += prefix[index]
  upper += "`"
  const threads = ["target_thread", "parent_thread", "checkpoint_thread", "destination_thread"]
  const refs = ["target_ref", "parent_ref"]
  const fields = ["invocation_id", "kind", "checkpoint_namespace", "thread_id",
    "incarnation_key", "workspace"]
  const schema = query(db,
    "SELECT rowid AS schema_rowid,sql FROM main.sqlite_schema WHERE type='table' AND name=?",
    [table])[0]
  const originalSchema = text(schema?.sql), schemaRowId = schema?.schema_rowid
  if (typeof schemaRowId !== "number" || !Number.isSafeInteger(schemaRowId)) fail()
  const schemaLiteral = `'${originalSchema.replace(/'/g, "''")}'`
  // Pin every originally captured mapping column. A later column can never overwrite a
  // host alias, even if writable_schema conceals its declaration in sqlite_schema.sql.
  const columns = [
    ...original.map(([name]) => `m."${name.replace(/"/g, "\"\"")}"`),
    ...threads.flatMap(name => ["created_at", "metadata"].map(field =>
      `${name}.${field} AS "${prefix}${name}_${field}"`)),
    ...refs.flatMap(name => fields.map(field => {
      const relation = ["thread_id", "incarnation_key", "workspace"].includes(field)
        ? `${name}_session` : name
      return `${relation}.${field} AS "${prefix}${name}_${field}"`
    })),
    // CASE short-circuits SQLite's expensive table-info virtual table on the ordinary
    // unchanged main schema. This is only a structural shortcut: all relation rows are
    // still read afresh in this statement, after every original source callback.
    // TEMP shadows and changed schemas retain the full original collision diagnostic.
    `CASE WHEN NOT EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name='${table}')
      AND (SELECT sql FROM main.sqlite_schema
        WHERE rowid=${schemaRowId} AND type='table' AND name='${table}')
        = ${schemaLiteral} THEN 0
      ELSE EXISTS(SELECT 1 FROM pragma_table_info('${table}')
      WHERE name COLLATE BINARY >= '${prefix}' AND name COLLATE BINARY < '${upper}')
      END AS "${prefix}alias_collisions"`]
  const read = db.prepareReadOne(`SELECT ${columns.join(",")}
    FROM ${table} m
    JOIN threads target_thread ON target_thread.thread_id=?
    JOIN threads parent_thread ON parent_thread.thread_id=?
    JOIN threads checkpoint_thread ON checkpoint_thread.thread_id=?
    JOIN threads destination_thread ON destination_thread.thread_id=?
    JOIN function_conversations target_ref ON target_ref.conversation_id=m.conversation_id
    JOIN function_logical_sessions target_ref_session
      ON target_ref_session.logical_session_id=target_ref.logical_session_id
    JOIN function_conversation_branches target_ref_branch
      ON target_ref_branch.conversation_id=target_ref.conversation_id
        AND target_ref_branch.branch_id=m.branch_id
    JOIN function_conversations parent_ref ON parent_ref.conversation_id=?
    JOIN function_logical_sessions parent_ref_session
      ON parent_ref_session.logical_session_id=parent_ref.logical_session_id
    JOIN function_conversation_branches parent_ref_branch
      ON parent_ref_branch.conversation_id=parent_ref.conversation_id AND parent_ref_branch.branch_id=?
    WHERE m.conversation_id=? AND m.branch_id=? AND target_ref_session.logical_session_id=?
      AND parent_ref_session.logical_session_id=?`)
  const values = Object.freeze([target.threadId, parent.threadId, checkpointThreadId,
    destinationThreadId, parent.conversationId, parent.branchId, target.conversationId,
    target.branchId, target.logicalSessionId, parent.logicalSessionId])
  // Only fixed SQL alias strings are reused. Every read and incarnation interpretation stays fresh.
  const createdAtKeys: string[] = [], metadataKeys: string[] = [], refKeys: string[][] = []
  for (let index = 0; index < threads.length; index++) {
    createdAtKeys[index] = `${prefix}${threads[index]}_created_at`
    metadataKeys[index] = `${prefix}${threads[index]}_metadata`
  }
  for (let index = 0; index < refs.length; index++) {
    const keys: string[] = []
    for (let field = 0; field < fields.length; field++)
      keys[field] = `${prefix}${refs[index]}_${fields[field]}`
    refKeys[index] = keys
  }
  const aliasCollisionsKey = `${prefix}alias_collisions`
  const checkThread = (row: SqlRow, index: number, incarnation: ThreadIncarnation) => {
    const createdAt = row[createdAtKeys[index]], rawMetadata = row[metadataKeys[index]]
    if (typeof createdAt !== "number" ||
      (rawMetadata !== null && typeof rawMetadata !== "string") ||
      !matchesThreadIncarnation({ created_at: createdAt, metadata: rawMetadata }, incarnation)) fail()
  }
  const checkRef = (row: SqlRow, index: number, ref: FunctionConversationRef) => {
    const keys = refKeys[index]
    if (row[keys[1]] !== ref.kind ||
      row[keys[2]] !== ref.checkpointNamespace ||
      row[keys[3]] !== ref.threadId ||
      row[keys[4]] !== incarnationKey(ref.incarnation) ||
      row[keys[5]] !== ref.workspace) fail()
  }
  return () => {
    const row = read(values)
    if (!row || row[aliasCollisionsKey] !== 0) fail()
    for (let index = 0; index < original.length; index++) {
      const entry = original[index]
      if (row[entry[0]] !== entry[1]) fail()
    }
    checkThread(row, 0, target.incarnation)
    checkThread(row, 1, parent.incarnation)
    checkThread(row, 2, checkpoint)
    checkThread(row, 3, destination)
    checkRef(row, 0, target)
    checkRef(row, 1, parent)
    // The original child relation must still agree with its recorded invocation.
    if (row[refKeys[0][0]] !== invocationId) fail()
    if (row[metadataKeys[3]] !== originalMetadata) fail()
    const result: ScopeThread[] = []
    const incarnations = [target.incarnation, parent.incarnation, checkpoint, destination]
    for (let index = 0; index < threads.length; index++) {
      result[index] = { id: values[index], incarnation: incarnations[index],
        createdAt: row[createdAtKeys[index]] as number,
        metadata: row[metadataKeys[index]] as string | null }
    }
    return result
  }
}
function fail(code = "MODS_CONVERSATION_DESTINATION_CHANGED"): never {
  throw new ModFunctionError(code)
}
function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value)) fail()
  return value
}
function query(db: NativeSqliteAdapter, sql: string, values: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, values)[0]
  return result ? result.values.map(row => Object.fromEntries(result.columns.map(
    (key, index) => [key, row[index]]))) : []
}
function sync(guard: () => void): void {
  if (guard() !== undefined) fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
}
function fixedIncarnation(value: ThreadIncarnation): ThreadIncarnation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (value.token !== null && (typeof value.token !== "string" || !value.token)) ||
    !Number.isSafeInteger(value.legacyCreatedAt) || value.legacyCreatedAt < 0) fail()
  return Object.freeze({ token: value.token, legacyCreatedAt: value.legacyCreatedAt })
}
function fixedRef(ref: FunctionConversationRef): FunctionConversationRef {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) fail()
  if (ref.kind !== "main" && ref.kind !== "child") fail()
  return Object.freeze({ logicalSessionId: text(ref.logicalSessionId),
    conversationId: text(ref.conversationId), branchId: text(ref.branchId),
    threadId: text(ref.threadId), workspace: text(ref.workspace),
    incarnation: fixedIncarnation(ref.incarnation),
    checkpointNamespace: text(ref.checkpointNamespace, true), kind: ref.kind })
}
function incarnationKey(value: ThreadIncarnation): string {
  return JSON.stringify(value.token === null ? ["legacy", value.legacyCreatedAt] : ["token", value.token])
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }
function assertThread(db: NativeSqliteAdapter, id: string, incarnation: ThreadIncarnation,
  read?: NativeSqliteReadOne): SqlRow {
  const row = read ? read([id]) : query(db, threadSql, [id])[0]
  if (!row || typeof row.created_at !== "number" ||
    (row.metadata !== null && typeof row.metadata !== "string") ||
    !matchesThreadIncarnation({ created_at: row.created_at, metadata: row.metadata }, incarnation)) fail()
  return row
}
function assertRef(db: NativeSqliteAdapter, ref: FunctionConversationRef,
  readers?: DestinationReaders): SqlRow {
  assertThread(db, ref.threadId, ref.incarnation, readers?.thread)
  const values = [ref.conversationId, ref.logicalSessionId, ref.branchId]
  const row = readers ? readers.ref(values) : query(db, refSql, values)[0]
  if (!row || row.kind !== ref.kind || row.checkpoint_namespace !== ref.checkpointNamespace ||
    row.thread_id !== ref.threadId || row.incarnation_key !== incarnationKey(ref.incarnation) ||
    row.workspace !== ref.workspace) fail()
  return row
}
function metadata(value: string, parent: FunctionConversationRef, physical: string,
  invocationId: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { fail() }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail()
  const fields = parsed as Record<string, unknown>
  if (fields.isInternalFlowRuntime !== true || fields.isFunctionConversationProjection !== true ||
    fields.parentThreadId !== physical || fields.workspacePath !== parent.workspace ||
    fields.modsAgentRunId !== invocationId) fail()
}

export function ensureFunctionConversationNativeDestinationSchema(db: NativeSqliteAdapter): void {
  db.run(`CREATE TABLE IF NOT EXISTS ${table} (
    conversation_id TEXT NOT NULL,branch_id TEXT NOT NULL,target_json TEXT NOT NULL,
    parent_json TEXT NOT NULL,invocation_id TEXT NOT NULL,checkpoint_thread_id TEXT NOT NULL,
    checkpoint_incarnation TEXT NOT NULL,destination_thread_id TEXT NOT NULL,
    destination_incarnation TEXT NOT NULL,metadata_json TEXT NOT NULL,metadata_digest TEXT NOT NULL,
    PRIMARY KEY(conversation_id,branch_id),UNIQUE(destination_thread_id,destination_incarnation)
  )`)
}

/** Fresh native creation only, inside the original child-creation transaction. Never recertifies. */
export function recordFunctionConversationNativeDestinationInTransaction(db: NativeSqliteAdapter,
  child: FunctionConversationRef, input: FunctionConversationNativeDestination): void {
  const target = fixedRef(child), parent = fixedRef(input.parent)
  const checkpointIncarnation = fixedIncarnation(input.checkpointIncarnation)
  const destinationIncarnation = fixedIncarnation(input.destinationIncarnation)
  const invocationId = text(input.invocationId), checkpointThreadId = text(input.checkpointThreadId)
  const destinationThreadId = text(input.destinationThreadId), originalMetadata = text(input.originalMetadata)
  const guard = input.assertCurrent.bind(input)
  sync(guard)
  if (!db.inTransaction) fail("MODS_CONVERSATION_TRANSACTION_REQUIRED")
  const row = assertRef(db, target)
  assertRef(db, parent)
  if (target.kind !== "child" || target.logicalSessionId !== parent.logicalSessionId ||
    target.threadId !== parent.threadId || target.workspace !== parent.workspace ||
    row.invocation_id !== invocationId || !target.checkpointNamespace ||
    checkpointThreadId === destinationThreadId) fail()
  assertThread(db, checkpointThreadId, checkpointIncarnation)
  const destination = assertThread(db, destinationThreadId, destinationIncarnation)
  if (destination.metadata !== originalMetadata) fail()
  metadata(originalMetadata, parent, checkpointThreadId, invocationId)
  if (query(db, `SELECT 1 FROM ${table} WHERE conversation_id=? AND branch_id=?`,
    [target.conversationId, target.branchId]).length) fail()
  const values = [target.conversationId, target.branchId, JSON.stringify(target), JSON.stringify(parent),
    invocationId, checkpointThreadId, JSON.stringify(checkpointIncarnation), destinationThreadId,
    JSON.stringify(destinationIncarnation), originalMetadata, hash(originalMetadata)]
  db.run(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?,?,?,?)`, values)
  const stored = query(db, `SELECT * FROM ${table} WHERE conversation_id=? AND branch_id=?`,
    [target.conversationId, target.branchId])[0]
  const columns = ["conversation_id", "branch_id", "target_json", "parent_json", "invocation_id",
    "checkpoint_thread_id", "checkpoint_incarnation", "destination_thread_id",
    "destination_incarnation", "metadata_json", "metadata_digest"]
  if (!stored || columns.some((key, index) => stored[key] !== values[index])) fail()
  sync(guard)
  if (!db.inTransaction) fail("MODS_CONVERSATION_TRANSACTION_REQUIRED")
}

/** Read data only. The caller must separately authenticate the original native checkpoint. */
export function readFunctionConversationNativeDestination(db: NativeSqliteAdapter,
  child: FunctionConversationRef, parentRef: FunctionConversationRef,
  guard: () => void): FunctionConversationNativeDestination {
  const target = fixedRef(child), parent = fixedRef(parentRef)
  sync(guard)
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  // Fixed statements belong to this original connection. Each invocation still reads fresh data.
  const readers: DestinationReaders = Object.freeze({ thread: db.prepareReadOne(threadSql),
    ref: db.prepareReadOne(refSql), mapping: db.prepareReadOne(mappingSql) })
  const conversation = assertRef(db, target, readers)
  assertRef(db, parent, readers)
  const row = readers.mapping([target.conversationId, target.branchId])
  if (!row) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (row.target_json !== JSON.stringify(target) || row.parent_json !== JSON.stringify(parent) ||
    target.kind !== "child" || target.logicalSessionId !== parent.logicalSessionId ||
    row.invocation_id !== conversation.invocation_id) fail()
  let checkpoint: ThreadIncarnation, destination: ThreadIncarnation
  try {
    checkpoint = fixedIncarnation(JSON.parse(text(row.checkpoint_incarnation)))
    destination = fixedIncarnation(JSON.parse(text(row.destination_incarnation)))
  } catch { return fail() }
  const checkpointThreadId = text(row.checkpoint_thread_id), destinationThreadId = text(row.destination_thread_id)
  const originalMetadata = text(row.metadata_json), invocationId = text(row.invocation_id)
  if (row.checkpoint_incarnation !== JSON.stringify(checkpoint) ||
    row.destination_incarnation !== JSON.stringify(destination) ||
    checkpointThreadId === destinationThreadId) fail()
  const mappingKeys = Object.keys(row)
  const mappingEntries: Array<readonly [string, NativeSqliteValue]> = []
  let originalDigest: NativeSqliteValue | undefined
  for (let index = 0; index < mappingKeys.length; index++) {
    const key = mappingKeys[index], value = row[key]
    mappingEntries[index] = Object.freeze([key, value] as const)
    if (key === "metadata_digest") originalDigest = value
  }
  const readThreads = destinationSnapshot(db, Object.freeze(mappingEntries), target, parent,
    checkpointThreadId, checkpoint, destinationThreadId, destination, invocationId, originalMetadata)
  const dataCurrent = () => { readThreads() }
  const current = () => { sync(guard); dataCurrent() }
  current()
  if (hash(originalMetadata) !== originalDigest) fail()
  metadata(originalMetadata, parent, checkpointThreadId, invocationId)
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  const result = Object.freeze({ parent, invocationId, checkpointThreadId,
    checkpointIncarnation: checkpoint, destinationThreadId, destinationIncarnation: destination,
    originalMetadata, assertCurrent: current })
  Reflect.apply(destinationWeakSet, destinationData, [result, { database: db, target, parent,
    threads: Object.freeze([{ id: target.threadId, incarnation: target.incarnation },
      { id: parent.threadId, incarnation: parent.incarnation },
      { id: checkpointThreadId, incarnation: checkpoint },
      { id: destinationThreadId, incarnation: destination }]),
    assertCurrent: dataCurrent, readThreads, reading: false, failed: false }])
  return result
}

function sameIncarnation(first: ThreadIncarnation, second: ThreadIncarnation): boolean {
  return first.token === second.token && (first.token !== null ||
    first.legacyCreatedAt === second.legacyCreatedAt)
}
function sameRef(first: FunctionConversationRef, second: FunctionConversationRef): boolean {
  return first.logicalSessionId === second.logicalSessionId &&
    first.conversationId === second.conversationId && first.branchId === second.branchId &&
    first.threadId === second.threadId && first.workspace === second.workspace &&
    first.kind === second.kind && first.checkpointNamespace === second.checkpointNamespace &&
    sameIncarnation(first.incarnation, second.incarnation)
}

/** Pure coverage facts from the original mapping reader; this does not authenticate a caller. */
export function matchesFunctionConversationNativeDestinationData(
  destination: FunctionConversationNativeDestination, database: NativeSqliteAdapter,
  target: FunctionConversationRef, parent: FunctionConversationRef): boolean {
  const original = readData(destinationData, destination)
  return !!original && original.database === database && sameRef(original.target, target) &&
    sameRef(original.parent, parent)
}
export function coversFunctionConversationNativeDestinationThread(
  destination: FunctionConversationNativeDestination, database: NativeSqliteAdapter,
  threadId: string, incarnation: ThreadIncarnation): boolean {
  const original = readData(destinationData, destination)
  if (!original || original.database !== database) return false
  for (let index = 0; index < original.threads.length; index++) {
    const thread = original.threads[index]
    if (thread.id === threadId && sameIncarnation(thread.incarnation, incarnation)) return true
  }
  return false
}

/** A fresh complete JOIN, usable only by synchronous module-owned data checkers. */
export function withFunctionConversationNativeDestinationDataScope(
  destination: FunctionConversationNativeDestination, database: NativeSqliteAdapter,
  inspect: (scope: FunctionConversationNativeDestinationDataScope) => void): void {
  const original = readData(destinationData, destination)
  if (!original || original.database !== database) fail()
  if (original.reading || original.failed) { original.failed = true; fail() }
  original.reading = true
  const scope = Object.freeze({ [dataScopeBrand]: true as const })
  const record = { destination, original, threads: undefined as readonly ScopeThread[] | undefined }
  try {
    record.threads = original.readThreads()
    if (original.failed || readData(destinationData, destination) !== original) fail()
    Reflect.apply(destinationWeakSet, dataScopes, [scope, record])
    if (inspect(scope) !== undefined || original.failed ||
      readData(destinationData, destination) !== original) fail()
  } catch (error) { original.failed = true; throw error }
  finally {
    record.threads = undefined
    Reflect.apply(destinationWeakDelete, dataScopes, [scope])
    original.reading = false
  }
}

export function assertFunctionConversationNativeDestinationScopeThread(
  scope: FunctionConversationNativeDestinationDataScope,
  destination: FunctionConversationNativeDestination, database: NativeSqliteAdapter,
  threadId: string, incarnation: ThreadIncarnation): void {
  const record = readData(dataScopes, scope), original = readData(destinationData, destination)
  if (!record || record.destination !== destination || record.original !== original ||
    !original || original.database !== database || !original.reading || original.failed ||
    !record.threads) fail()
  for (let index = 0; index < record.threads.length; index++) {
    const thread = record.threads[index]
    if (thread.id === threadId && sameIncarnation(thread.incarnation, incarnation) &&
      matchesThreadIncarnation({ created_at: thread.createdAt, metadata: thread.metadata }, incarnation))
      return
  }
  fail()
}

/** Complete original mapping data only, after every caller and native source guard. */
export function assertFunctionConversationNativeDestinationDataCurrent(
  destination: FunctionConversationNativeDestination, database: NativeSqliteAdapter): void {
  const original = readData(destinationData, destination)
  if (!original || original.database !== database) fail()
  original.assertCurrent()
  if (readData(destinationData, destination) !== original) fail()
}

/** Data deletion preflight. ABA replacement destinations are retained; only the old mapping is removed. */
export function assertFunctionConversationNativeDestinationCleanupInTransaction(db: NativeSqliteAdapter,
  conversationIds: readonly string[], guard: () => void): void {
  sync(guard)
  if (!db.inTransaction) fail("MODS_CONVERSATION_TRANSACTION_REQUIRED")
  for (const id of conversationIds) {
    for (const row of query(db, `SELECT * FROM ${table} WHERE conversation_id=?`, [text(id)])) {
      let target: FunctionConversationRef, parent: FunctionConversationRef
      let checkpoint: ThreadIncarnation, destination: ThreadIncarnation
      try {
        target = fixedRef(JSON.parse(text(row.target_json)))
        parent = fixedRef(JSON.parse(text(row.parent_json)))
        checkpoint = fixedIncarnation(JSON.parse(text(row.checkpoint_incarnation)))
        destination = fixedIncarnation(JSON.parse(text(row.destination_incarnation)))
      } catch { fail() }
      const actual = assertRef(db, target)
      assertRef(db, parent)
      if (target.conversationId !== id || row.conversation_id !== id || row.branch_id !== target.branchId ||
        target.logicalSessionId !== parent.logicalSessionId || target.kind !== "child" ||
        row.invocation_id !== actual.invocation_id || row.target_json !== JSON.stringify(target) ||
        row.parent_json !== JSON.stringify(parent)) fail()
      const originalMetadata = text(row.metadata_json), physical = text(row.checkpoint_thread_id)
      const destinationId = text(row.destination_thread_id)
      if (hash(originalMetadata) !== row.metadata_digest ||
        row.checkpoint_incarnation !== JSON.stringify(checkpoint) ||
        row.destination_incarnation !== JSON.stringify(destination)) fail()
      metadata(originalMetadata, parent, physical, text(row.invocation_id))
      const current = query(db, "SELECT created_at,metadata FROM threads WHERE thread_id=?", [destinationId])[0]
      if (current && typeof current.created_at === "number" &&
        (current.metadata === null || typeof current.metadata === "string") &&
        matchesThreadIncarnation({ created_at: current.created_at, metadata: current.metadata }, destination) &&
        current.metadata !== originalMetadata) fail()
    }
  }
  sync(guard)
}
