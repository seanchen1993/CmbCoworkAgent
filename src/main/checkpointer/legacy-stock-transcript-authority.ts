import { lstatSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { isDevelopmentThreadMetadata } from "../../shared/mods/development-scope"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import {
  matchesThreadIncarnationSnapshot,
  THREAD_INCARNATION_METADATA_KEY,
  type ThreadIncarnationSnapshot
} from "../../shared/thread-incarnation"
import { functionConversationTranscriptFields } from "../../shared/mods/v2/conversation-transcript"
import { sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import type { CheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  SEARCH_BACKFILL_METADATA_BYTE_LIMIT
} from "./runtime-projection-protocol"

/** The original Main-locked request transports data, never a SQL capability. */
export interface StockLegacyTranscriptAuthority {
  readonly messageDatabaseFile: CheckpointDatabaseFileIdentity
  readonly checkpointFamilyKey: string
  readonly incarnation: ThreadIncarnationSnapshot
  readonly workspace: string
  readonly projectReservation?: {
    readonly projectId: string
    readonly kind: string
    readonly checkpointId: string
  }
}

export function legacyReservationProject(metadata: Record<string, unknown>) {
  if (!isOrdinaryFlowMetadata(metadata) ||
    (metadata.agentMode !== undefined && metadata.agentMode !== "normal") ||
    typeof metadata.workspacePath !== "string" || !isAbsolute(metadata.workspacePath)) return undefined
  const session = asRecord(metadata.harnessProjectSession)
  if (!session || typeof session.projectId !== "string" || typeof session.kind !== "string")
    return undefined
  return { projectId: session.projectId, kind: session.kind }
}

const nativeOwners = [
  ["function_logical_sessions", "thread_id"],
  ["function_conversation_native_destinations", "destination_thread_id"],
  ["function_conversation_native_destinations", "checkpoint_thread_id"],
  ["function_conversation_projection_receipts", "thread_id"],
  ["function_conversation_checkpoint_receipts", "checkpoint_thread_id"]
] as const

function protectedSource(): never {
  throw Error("MODS_CONVERSATION_MIGRATION_REQUIRED")
}

function changed(): never {
  throw Object.assign(Error("Ordinary legacy transcript source changed"), {
    name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
  })
}

function cancellationCurrent(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) changed()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function assertStockCheckpointIsOrdinary(checkpoint: Record<string, unknown>,
  cancellation: Int32Array): void {
  const channels = asRecord(checkpoint.channel_values)
  const conversation = channels?.cmbFunctionConversation
  if (conversation !== undefined) {
    // LangChain persists an unset channel as a tagged undefined value.
    const serialized = asRecord(conversation)
    if (!serialized || serialized.lc !== 2 || serialized.type !== "undefined" ||
      Object.keys(serialized).length !== 2) protectedSource()
  }
  const messages = Array.isArray(channels?.messages) ? channels.messages : []
  for (let index = 0; index < messages.length; index++) {
    if (index % 64 === 0) cancellationCurrent(cancellation)
    const fields = functionConversationTranscriptFields(messages[index])
    if (fields.function_row || fields.function_row_invalid) protectedSource()
  }
}

function fileMatches(path: string, expected: CheckpointDatabaseFileIdentity): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return false
    const file = statSync(path, { bigint: true })
    return file.isFile() && file.nlink === 1n && String(file.dev) === expected.dev &&
      String(file.ino) === expected.ino && String(file.birthtimeNs) === expected.birthtime
  } catch { return false }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database.prepare("SELECT type FROM main.sqlite_schema WHERE name=? COLLATE NOCASE")
    .get(table)
  if (row && row.type !== "table") protectedSource()
  return row !== undefined
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name=?")
    .get(table, column) !== undefined
}

function assertThreadIsOrdinary(database: DatabaseSync, threadId: string,
  authority: StockLegacyTranscriptAuthority): void {
  const metadata = hasColumn(database, "threads", "metadata") ? "metadata" : "NULL"
  const thread = database.prepare(`SELECT created_at,
    CASE WHEN octet_length(${metadata}) <= ${SEARCH_BACKFILL_METADATA_BYTE_LIMIT} THEN ${metadata}
      WHEN ${metadata} IS NOT NULL THEN '[' END AS metadata
    FROM main.threads WHERE thread_id=?`)
    .get(threadId)
  if (!thread) changed()
  let token: string | null = null
  let workspace = ""
  const reservation = authority.projectReservation
  if (reservation && thread.metadata === null) protectedSource()
  if (thread.metadata !== null) {
    if (typeof thread.metadata !== "string") protectedSource()
    let parsed: Record<string, unknown> | undefined
    try { parsed = asRecord(JSON.parse(thread.metadata)) } catch { protectedSource() }
    if (!parsed || parsed.isFunctionConversationProjection === true) protectedSource()
    const project = reservation && legacyReservationProject(parsed)
    if (reservation
      ? project?.projectId !== reservation.projectId || project?.kind !== reservation.kind
      : !isDevelopmentThreadMetadata(parsed))
      protectedSource()
    const stored = parsed[THREAD_INCARNATION_METADATA_KEY]
    if (typeof stored === "string" && stored) token = stored
    if (typeof parsed.workspacePath === "string") workspace = parsed.workspacePath
  }
  if (workspace !== authority.workspace ||
    !matchesThreadIncarnationSnapshot({ token, legacyCreatedAt: Number(thread.created_at) }, authority.incarnation))
    changed()
  if (stockLegacyHasNativeOwnership(database, threadId)) protectedSource()
}

/** The same durable ownership check also excludes native archives from timing probes. */
export function stockLegacyHasNativeOwnership(database: DatabaseSync, threadId: string): boolean {
  for (const [table, column] of nativeOwners) {
    if (tableExists(database, table) && database.prepare(`SELECT 1 FROM main.${table}
      WHERE ${column}=? LIMIT 1`).get(threadId)) return true
  }
  return hasColumn(database, "thread_messages", "function_row_json") &&
    Boolean(database.prepare(`SELECT 1 FROM main.thread_messages
      WHERE thread_id=? AND function_row_json IS NOT NULL LIMIT 1`).get(threadId))
}

function assertProjectReservation(database: DatabaseSync, threadId: string,
  reservation: NonNullable<StockLegacyTranscriptAuthority["projectReservation"]>, initial: boolean): void {
  const row = database.prepare(`SELECT checkpoint_id, status, scoped_order,
    CASE WHEN json_valid(ordinal_reservation) THEN 1 ELSE 0 END AS has_reservation
    FROM main.legacy_checkpoint_transcript_migrations WHERE thread_id=?`).get(threadId)
  if (row?.checkpoint_id !== reservation.checkpointId || row.scoped_order !== 1 ||
    (row.status === "reserving" ? row.has_reservation !== 1 :
      initial || (row.status !== "migrating" && row.status !== "complete"))) changed()
}

// No public transport calls this adapter with SQL. Only the fixed, extracted UAT routines
// call its mutation methods, with the same bound conversation ID as their original query.
class StockLegacyDatabase extends DatabaseSync {
  private batch = false

  constructor(path: string, timeout: number, private readonly assertCurrent: (db: DatabaseSync) => void) {
    super(path, { timeout })
  }

  private begin(): void {
    super.exec("BEGIN IMMEDIATE")
    this.batch = true
    try { this.assertCurrent(this) } catch (error) { this.rollback(); throw error }
  }

  private rollback(): void {
    try {
      if (this.isTransaction) super.exec("ROLLBACK")
    } finally { this.batch = false }
  }

  private commit(): void {
    try {
      if (!this.batch || !this.isTransaction) changed()
      this.assertCurrent(this)
      super.exec("COMMIT")
    } catch (error) { this.rollback(); throw error }
    finally { this.batch = false }
  }

  private write<T>(work: () => T): T {
    if (this.batch) {
      if (!this.isTransaction) changed()
      return work()
    }
    this.begin()
    try {
      const value = work()
      this.commit()
      return value
    } catch (error) { this.rollback(); throw error }
  }

  override exec(sql: string): void {
    const command = sql.trim()
    if (command === "BEGIN IMMEDIATE") return this.begin()
    if (command === "COMMIT") return this.commit()
    if (command === "ROLLBACK") return this.rollback()
    if (/^(?:SAVEPOINT|RELEASE|ROLLBACK TO) (?:legacy_search_batch|attempt_ordinal_reservation)$/.test(command) ||
      command === "ROLLBACK TO legacy_search_batch; RELEASE legacy_search_batch") {
      if (!this.batch || !this.isTransaction) changed()
      return super.exec(sql)
    }
    // This connection has no other transaction-control PRAGMA or writable ATTACH path.
    if (command === "PRAGMA synchronous = NORMAL" || command === "PRAGMA wal_autocheckpoint = 0" ||
      command === "PRAGMA wal_checkpoint(PASSIVE)")
      return super.exec(sql)
    this.write(() => super.exec(sql))
  }

  override prepare(sql: string): StatementSync {
    const statement = super.prepare(sql)
    const run = statement.run.bind(statement) as (...bindings: unknown[]) => ReturnType<StatementSync["run"]>
    statement.run = ((...bindings: unknown[]) => this.write(() => run(...bindings))) as StatementSync["run"]
    return statement
  }
}

export function createStockLegacyTranscriptAccess(input: {
  checkpointDatabasePath: string
  messageDatabasePath: string
  threadId: string
  cancellation: Int32Array
  authority: StockLegacyTranscriptAuthority
}) {
  const { checkpointDatabasePath, messageDatabasePath, threadId, cancellation } = input
  const authority = Object.freeze({ ...input.authority,
    messageDatabaseFile: Object.freeze({ ...input.authority.messageDatabaseFile }),
    incarnation: Object.freeze({ ...input.authority.incarnation }),
    projectReservation: input.authority.projectReservation && Object.freeze({ ...input.authority.projectReservation }) })
  const messagePath = realpathSync.native(messageDatabasePath)
  const assertFiles = () => {
    cancellationCurrent(cancellation)
    if (lstatSync(messageDatabasePath).isSymbolicLink() ||
      resolve(realpathSync.native(messageDatabasePath)) !== resolve(messagePath) ||
      !fileMatches(messagePath, authority.messageDatabaseFile) ||
      sqliteRecoveryFamilyKey(checkpointDatabasePath) !== authority.checkpointFamilyKey) changed()
  }
  const assertCurrent = (database: DatabaseSync) => {
    assertFiles()
    assertThreadIsOrdinary(database, threadId, authority)
    if (authority.projectReservation) assertProjectReservation(database, threadId, authority.projectReservation, false)
  }
  return Object.freeze({
    assertFiles,
    projectCheckpointId: authority.projectReservation?.checkpointId,
    openWriter(timeout: number): DatabaseSync {
      assertFiles()
      const database = new StockLegacyDatabase(messagePath, timeout, assertCurrent)
      try { assertCurrent(database); return database }
      catch (error) { database.close(); throw error }
    },
    assertOrdinary(): void {
      assertFiles()
      const database = new DatabaseSync(messagePath, { readOnly: true, timeout: 100 })
      try {
        assertCurrent(database)
        if (authority.projectReservation) assertProjectReservation(database, threadId, authority.projectReservation, true)
      } finally { database.close() }
    }
  })
}

export type StockLegacyTranscriptAccess = ReturnType<typeof createStockLegacyTranscriptAccess>
