import { randomUUID } from "node:crypto"
import type { Worker } from "node:worker_threads"
import { types } from "node:util"
import { stat } from "node:fs/promises"
import { NativeSqliteAdapter, type NativeSqliteValue } from "../db/native-sqlite-adapter"
import { checkpointWalInBackground } from "../db/wal-checkpoint"
import {
  resolveCheckpointDatabaseIdentity,
  assertCheckpointDatabasePathCurrent,
  assertCheckpointDatabaseFileIdentity
} from "./checkpoint-database-identity"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"
import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../shared/mods/v2/resource-budgets"
import {
  LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
  LEGACY_TRANSCRIPT_WRITE_ERRORS,
  type LegacyTranscriptWriterData,
  type LegacyTranscriptMarker,
  type LegacyTranscriptWriteRow,
  type LegacyTranscriptWriteCommand,
  type LegacyTranscriptWriteAcknowledgement,
  type LegacyTranscriptWriteResult,
  type LegacyTranscriptWriteError,
  legacyTranscriptWriteRowBytes
} from "./legacy-transcript-write-protocol"

const limits = FUNCTION_MOD_RESOURCE_BUDGETS.legacyTranscriptBridgeWriter
const admission = new BoundedWorkerAdmission(
  limits.active,
  limits.wait,
  "Legacy transcript Main writer"
)
const markerTable = "legacy_checkpoint_transcript_migrations"
// A failed run() wrapper can throw after BEGIN or before ROLLBACK. This fixed
// native dispatch avoids run()'s post-effect changes() read during cleanup.
const rollbackExecution = NativeSqliteAdapter.prototype.exec
const closeExecution = NativeSqliteAdapter.prototype.close
const markUnusableExecution = NativeSqliteAdapter.prototype.markUnusable
const timeProjection = `json_extract(thread_values,'$.messageTimes','$.messageTimeOrder',
  '$.internalGoalMessageTimes','$.internalGoalMessageTimeOrder')`
const brand = Symbol("legacy-transcript-main-writer")
export interface LegacyTranscriptWriter {
  readonly [brand]: true
  readonly workerData: LegacyTranscriptWriterData
}
interface TimingSource {
  token: string
  source: string
  live: string | null
  index: number
  checkpointId: string
}
interface Actor {
  worker: Worker
  database: NativeSqliteAdapter
  threadId: string
  namespace: string
  incarnation: ThreadIncarnation
  guard: () => void
  data: LegacyTranscriptWriterData
  controller: AbortController
  sequence: number
  commands: number
  busy: boolean
  cancelled: boolean
  workerSettled: boolean
  drain: Promise<void>
  resolveDrain(): void
  source?: { checkpointId: string; totalMessages: number }
  timing?: TimingSource
  recoveryIntegrity?: boolean
  fragment?: { index: number; total: number; row: LegacyTranscriptWriteRow }
  cleanupPending?: boolean
  retainedAdmission?: () => void
}
const actors = new WeakMap<LegacyTranscriptWriter, Actor>()
function fail(code: LegacyTranscriptWriteError): never {
  throw Object.assign(Error(code), { code })
}
const row = (
  database: NativeSqliteAdapter,
  sql: string,
  values: readonly unknown[] = []
): NativeSqliteValue[] | undefined => database.exec(sql, values)[0]?.values[0]
const hasTable = (database: NativeSqliteAdapter, name: string): boolean =>
  !!row(database, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", [name])

function noNativeOwner(actor: Actor): boolean {
  const database = actor.database
  const incarnation = JSON.stringify(
    actor.incarnation.token === null
      ? ["legacy", actor.incarnation.legacyCreatedAt]
      : ["token", actor.incarnation.token]
  )
  if (
    hasTable(database, "function_logical_sessions") &&
    row(
      database,
      "SELECT 1 FROM function_logical_sessions WHERE thread_id=? AND incarnation_key=? LIMIT 1",
      [actor.threadId, incarnation]
    )
  )
    return false
  if (
    hasTable(database, "function_conversation_native_destinations") &&
    row(
      database,
      `SELECT 1 FROM function_conversation_native_destinations
     WHERE destination_thread_id=? AND destination_incarnation=? LIMIT 1`,
      [actor.threadId, JSON.stringify(actor.incarnation)]
    )
  )
    return false
  return true
}
function current(actor: Actor, writing = false): void {
  if (actor.cleanupPending) fail("LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE")
  if (actor.cancelled || actor.workerSettled || actor.controller.signal.aborted)
    fail("LEGACY_TRANSCRIPT_WRITE_CANCELLED")
  if (actor.guard() !== undefined) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  if (writing && !noNativeOwner(actor)) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
}
function releaseDrain(actor: Actor): void {
  if (actor.cleanupPending && databaseIsClosed(actor.database)) {
    actor.cleanupPending = false
    actor.retainedAdmission?.()
    actor.retainedAdmission = undefined
  }
  if (actor.workerSettled && actor.commands === 0 && !actor.cleanupPending) {
    actor.timing = undefined
    actor.resolveDrain()
  }
}

function databaseIsClosed(database: NativeSqliteAdapter): boolean {
  const closed = Object.getOwnPropertyDescriptor(database, "closed")
  return !!closed && "value" in closed && closed.value === true
}

function closeUnavailableDatabase(actor: Actor): never {
  // A failed rollback cannot leave this global AppDB connection available to
  // later Main writes in the abandoned transaction. Restart is required.
  try {
    Reflect.apply(closeExecution, actor.database, [{ checkpoint: false }])
  } catch {
    /* A failed close is not a resource-release proof either. */
  }
  actor.cleanupPending = !databaseIsClosed(actor.database)
  if (actor.cleanupPending) Reflect.apply(markUnusableExecution, actor.database, [])
  return fail("LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE")
}

export function createLegacyTranscriptWriter(input: {
  actualWorker: Worker
  workerGeneration: number
  requestId: number
  threadId: string
  checkpointNamespace: string
  incarnation: ThreadIncarnation
  actualDatabase: NativeSqliteAdapter
  assertCurrent(): void
}): LegacyTranscriptWriter {
  const data = Object.freeze({
    protocol: LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
    nonce: randomUUID(),
    workerGeneration: input.workerGeneration,
    requestId: input.requestId
  })
  let resolveDrain!: () => void
  const actor: Actor = {
    worker: input.actualWorker,
    database: input.actualDatabase,
    threadId: input.threadId,
    namespace: input.checkpointNamespace,
    incarnation: Object.freeze({
      token: input.incarnation.token,
      legacyCreatedAt: input.incarnation.legacyCreatedAt
    }),
    guard: input.assertCurrent,
    data,
    controller: new AbortController(),
    sequence: 0,
    commands: 0,
    busy: false,
    cancelled: false,
    workerSettled: false,
    drain: new Promise((resolve) => {
      resolveDrain = resolve
    }),
    resolveDrain: () => resolveDrain()
  }
  current(actor)
  const handle = Object.freeze({ [brand]: true as const, workerData: data })
  actors.set(handle, actor)
  return handle
}
function actual(handle: LegacyTranscriptWriter): Actor {
  const actor = actors.get(handle)
  if (!actor) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  return actor
}

/** Inspect the original opaque owner before client retention/posting. JSON cannot replace it. */
export function readLegacyTranscriptWriterData(
  handle: LegacyTranscriptWriter,
  expected: {
    actualWorker: Worker
    workerGeneration: number
    requestId: number
    threadId: string
    checkpointNamespace: string
  }
): LegacyTranscriptWriterData {
  const actor = actual(handle)
  if (
    actor.worker !== expected.actualWorker ||
    actor.data.workerGeneration !== expected.workerGeneration ||
    actor.data.requestId !== expected.requestId ||
    actor.threadId !== expected.threadId ||
    actor.namespace !== expected.checkpointNamespace
  )
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  return actor.data
}
export function cancelLegacyTranscriptWriter(handle: LegacyTranscriptWriter): void {
  const actor = actual(handle)
  actor.cancelled = true
  actor.controller.abort(Error("LEGACY_TRANSCRIPT_WRITE_CANCELLED"))
}
/** The client calls after the actual Worker final/exit; Main work/ACKs must also finish. */
export function settleLegacyTranscriptWriter(handle: LegacyTranscriptWriter): Promise<void> {
  const actor = actual(handle)
  actor.workerSettled = true
  cancelLegacyTranscriptWriter(handle)
  releaseDrain(actor)
  return actor.drain
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const names = Reflect.ownKeys(value)
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    result[key] = field.value
  }
  return result
}
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  return Number(value)
}
const text = (value: unknown): string => {
  if (typeof value !== "string") fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  return value
}
const nullableText = (value: unknown): string | null => (value === null ? null : text(value))
function entries(value: unknown, minimum = 0): unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length < minimum ||
    value.length > limits.rowsPerBatch
  )
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const result: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !("value" in field)) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    result.push(field.value)
  }
  return result
}
const fields = [
  "recoveryIntegrity",
  "messageId",
  "providerSourceId",
  "providerOccurrence",
  "role",
  "contentJson",
  "reasoning",
  "toolCallsJson",
  "toolCallId",
  "name",
  "status",
  "isError",
  "createdAt",
  "estimatedBytes"
]
function copyRow(value: unknown): LegacyTranscriptWriteRow {
  const source = object(value, fields)
  if (
    typeof source.role !== "string" ||
    !["user", "assistant", "system", "tool"].includes(source.role) ||
    !(source.recoveryIntegrity === 0 || source.recoveryIntegrity === 1) ||
    !(source.isError === null || source.isError === 0 || source.isError === 1) ||
    typeof source.createdAt !== "number" ||
    !Number.isFinite(source.createdAt)
  )
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const messageId = text(source.messageId)
  if (!messageId) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const occurrence = source.providerOccurrence === null ? null : integer(source.providerOccurrence)
  if (occurrence === 0) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  return Object.freeze({
    recoveryIntegrity: Number(source.recoveryIntegrity),
    messageId,
    providerSourceId: nullableText(source.providerSourceId),
    providerOccurrence: occurrence,
    role: source.role as LegacyTranscriptWriteRow["role"],
    contentJson: text(source.contentJson),
    reasoning: nullableText(source.reasoning),
    toolCallsJson: nullableText(source.toolCallsJson),
    toolCallId: nullableText(source.toolCallId),
    name: nullableText(source.name),
    status: nullableText(source.status),
    isError: source.isError as number | null,
    createdAt: source.createdAt,
    estimatedBytes: integer(source.estimatedBytes)
  })
}
function point(value: Record<string, unknown>) {
  const checkpointId = text(value.checkpointId)
  if (!checkpointId) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  return { checkpointId, totalMessages: integer(value.totalMessages) }
}
function copyCommand(value: unknown): LegacyTranscriptWriteCommand {
  if (!value || typeof value !== "object" || types.isProxy(value))
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const kindField = Object.getOwnPropertyDescriptor(value, "kind")
  const kind = kindField && "value" in kindField ? kindField.value : undefined
  if (kind === "read-state") {
    object(value, ["kind"])
    return { kind }
  }
  if (kind === "reserve")
    return { kind, ...point(object(value, ["kind", "checkpointId", "totalMessages"])) }
  if (kind === "finish") {
    const source = object(value, [
      "kind",
      "checkpointId",
      "totalMessages",
      "index",
      "fragmentIndex"
    ])
    return {
      kind,
      ...point(source),
      index: integer(source.index),
      fragmentIndex: integer(source.fragmentIndex)
    }
  }
  if (kind === "timing-source") {
    const source = object(value, ["kind", "checkpointId"])
    return { kind, checkpointId: text(source.checkpointId) }
  }
  if (kind === "timing-page") {
    const source = object(value, [
      "kind",
      "checkpointId",
      "timingToken",
      "index",
      "complete",
      "entries"
    ])
    if (typeof source.complete !== "boolean") fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    const time = (value: unknown): number | null => {
      if (value === null) return null
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 8.64e15)
        fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
      return value
    }
    return {
      kind,
      checkpointId: text(source.checkpointId),
      timingToken: text(source.timingToken),
      index: integer(source.index),
      complete: source.complete,
      entries: entries(source.entries).map((value) => {
        const entry = object(value, ["messageId", "startAt", "endAt"])
        return Object.freeze({
          messageId: text(entry.messageId),
          startAt: time(entry.startAt),
          endAt: time(entry.endAt)
        })
      })
    }
  }
  if (kind === "copy") {
    const modeField = Object.getOwnPropertyDescriptor(value, "mode")
    const mode = modeField && "value" in modeField ? modeField.value : undefined
    const common = ["kind", "mode", "checkpointId", "totalMessages", "index", "fragmentIndex"]
    if (mode === "rows") {
      const source = object(value, [...common, "rows"])
      const rows = Object.freeze(entries(source.rows, 1).map(copyRow))
      if (
        rows.length > 1 &&
        rows.reduce((sum, entry) => sum + legacyTranscriptWriteRowBytes(entry), 0) >
          limits.batchBytes
      )
        fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
      return {
        kind,
        mode,
        ...point(source),
        index: integer(source.index),
        fragmentIndex: integer(source.fragmentIndex),
        rows
      }
    }
    if (mode === "fragments") {
      const source = object(value, [
        ...common,
        "row",
        "fragments",
        "totalFragments",
        "nextFragmentIndex",
        "complete"
      ])
      if (typeof source.complete !== "boolean") fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
      const fragments = Object.freeze(
        entries(source.fragments).map((value) => {
          const fragment = text(value)
          if (fragment.length > 16 * 1024) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
          return fragment
        })
      )
      const message = copyRow(source.row)
      if (
        fragments.length > 1 &&
        legacyTranscriptWriteRowBytes(message) +
          fragments.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8") + 256, 0) >
          limits.batchBytes
      )
        fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
      return {
        kind,
        mode,
        ...point(source),
        index: integer(source.index),
        fragmentIndex: integer(source.fragmentIndex),
        row: message,
        fragments,
        totalFragments: integer(source.totalFragments),
        nextFragmentIndex: integer(source.nextFragmentIndex),
        complete: source.complete
      }
    }
  }
  return fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
}

function readMarker(actor: Actor): LegacyTranscriptMarker | null {
  if (!hasTable(actor.database, markerTable)) return null
  const columns = actor.database.exec(`PRAGMA table_info(${markerTable})`)[0]?.values ?? []
  const fragment = columns.some((value) => value[1] === "current_fragment_index")
  const values = row(
    actor.database,
    `SELECT checkpoint_id,total_messages,next_index,
    ${fragment ? "current_fragment_index" : "0"},status FROM ${markerTable} WHERE thread_id=?`,
    [actor.threadId]
  )
  if (!values) return null
  if (
    typeof values[0] !== "string" ||
    !values[0] ||
    !["migrating", "complete"].includes(String(values[4])) ||
    !values.slice(1, 4).every((value) => Number.isSafeInteger(value) && Number(value) >= 0) ||
    Number(values[2]) > Number(values[1]) ||
    (values[4] === "complete" && (values[2] !== values[1] || values[3] !== 0))
  )
    fail("LEGACY_CHECKPOINT_TRANSCRIPT_SOURCE_UNAVAILABLE")
  return Object.freeze({
    checkpointId: values[0],
    totalMessages: Number(values[1]),
    nextIndex: Number(values[2]),
    fragmentIndex: Number(values[3]),
    status: values[4] as LegacyTranscriptMarker["status"]
  })
}
function ensureMarkerSchema(database: NativeSqliteAdapter): void {
  database.run(`CREATE TABLE IF NOT EXISTS ${markerTable} (thread_id TEXT PRIMARY KEY,
    checkpoint_id TEXT NOT NULL,total_messages INTEGER NOT NULL,next_index INTEGER NOT NULL,
    current_fragment_index INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,updated_at INTEGER NOT NULL)`)
  if (
    !(database.exec(`PRAGMA table_info(${markerTable})`)[0]?.values ?? []).some(
      (value) => value[1] === "current_fragment_index"
    )
  )
    database.run(
      `ALTER TABLE ${markerTable} ADD COLUMN current_fragment_index INTEGER NOT NULL DEFAULT 0`
    )
}
function transaction<T>(actor: Actor, work: () => T): T {
  current(actor, true)
  const database = actor.database
  if (database.inTransaction) fail("LEGACY_TRANSCRIPT_WRITE_BUSY")
  let commitAttempted = false
  try {
    database.run("BEGIN IMMEDIATE")
    current(actor, true)
    const result = work()
    current(actor, true)
    commitAttempted = true
    database.run("COMMIT")
    return result
  } catch (error) {
    let open = false
    try {
      open = database.inTransaction
    } catch {
      if (!databaseIsClosed(database)) {
        closeUnavailableDatabase(actor)
      }
    }
    if (open) {
      try {
        database.run("ROLLBACK")
      } catch {
        // The native dispatch avoids run()'s post-effect readChanges() wrapper.
        try {
          if (database.inTransaction) Reflect.apply(rollbackExecution, database, ["ROLLBACK"])
        } catch {
          /* Check the actual resource below, not the wrapper's error alone. */
        }
      }
      let stillOpen = false
      try {
        stillOpen = database.inTransaction
      } catch {
        stillOpen = !databaseIsClosed(database)
      }
      if (stillOpen) {
        closeUnavailableDatabase(actor)
      }
    } else if (commitAttempted) fail("LEGACY_TRANSCRIPT_WRITE_COMMIT_UNKNOWN")
    throw error
  }
}
function bindSource(actor: Actor, checkpointId: string, totalMessages: number): void {
  if (
    actor.source &&
    (actor.source.checkpointId !== checkpointId || actor.source.totalMessages !== totalMessages)
  )
    fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  actor.source ??= Object.freeze({ checkpointId, totalMessages })
}
function requireMarker(
  actor: Actor,
  command: { checkpointId: string; totalMessages?: number; index?: number; fragmentIndex?: number }
): LegacyTranscriptMarker {
  const marker = readMarker(actor)
  if (
    !marker ||
    marker.checkpointId !== command.checkpointId ||
    (command.totalMessages !== undefined && marker.totalMessages !== command.totalMessages) ||
    (command.index !== undefined && marker.nextIndex !== command.index) ||
    (command.fragmentIndex !== undefined && marker.fragmentIndex !== command.fragmentIndex)
  )
    fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  bindSource(actor, marker.checkpointId, marker.totalMessages)
  return marker
}
function progress(
  actor: Actor,
  inserted = 0,
  fragmentOwned?: boolean
): LegacyTranscriptWriteResult {
  return {
    marker: readMarker(actor),
    inserted,
    ...(fragmentOwned === undefined ? {} : { fragmentOwned })
  }
}
function insertMessage(
  actor: Actor,
  message: LegacyTranscriptWriteRow,
  index: number,
  total: number
): number {
  const database = actor.database
  const recovery = (actor.recoveryIntegrity ??= (
    database.exec("PRAGMA table_info(thread_messages)")[0]?.values ?? []
  ).some((value) => value[1] === "recovery_integrity"))
  database.run(
    `INSERT OR IGNORE INTO thread_messages (thread_id,message_id,provider_source_id,
    provider_occurrence,role,content_json,reasoning,tool_calls_json,tool_call_id,name,status,is_error,
    content_priority,goal_id,active_window_id,created_at,start_at,end_at,ordinal${recovery ? ",recovery_integrity" : ""})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,NULL,?${recovery ? ",?" : ""})`,
    [
      actor.threadId,
      message.messageId,
      message.providerSourceId,
      message.providerOccurrence,
      message.role,
      message.contentJson,
      message.reasoning,
      message.toolCallsJson,
      message.toolCallId,
      message.name,
      message.status,
      message.isError,
      message.createdAt,
      index,
      ...(recovery ? [message.recoveryIntegrity] : [])
    ]
  )
  const inserted = database.getRowsModified()
  if (!inserted)
    database.run(
      `UPDATE thread_messages SET ordinal=?
    WHERE thread_id=? AND message_id=? AND ordinal>=?`,
      [index, actor.threadId, message.messageId, total]
    )
  return inserted
}
function copy(
  actor: Actor,
  command: Extract<LegacyTranscriptWriteCommand, { kind: "copy" }>
): LegacyTranscriptWriteResult {
  const state = requireMarker(actor, command)
  if (state.status !== "migrating" || command.index >= state.totalMessages)
    fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  let inserted = 0,
    next = command.index,
    fragment = 0,
    fragmentOwned: boolean | undefined
  if (command.mode === "rows") {
    if (command.fragmentIndex !== 0 || command.index + command.rows.length > state.totalMessages)
      fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    for (const message of command.rows)
      inserted += insertMessage(actor, message, next++, state.totalMessages)
  } else {
    if (
      command.fragmentIndex > command.totalFragments ||
      command.nextFragmentIndex !== command.fragmentIndex + command.fragments.length ||
      command.nextFragmentIndex > command.totalFragments ||
      command.complete !== (command.nextFragmentIndex === command.totalFragments) ||
      (!command.complete && command.fragments.length === 0)
    )
      fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    const prior = actor.fragment
    if (
      prior &&
      (prior.index !== command.index ||
        prior.total !== command.totalFragments ||
        fields.some(
          (key) =>
            prior.row[key as keyof LegacyTranscriptWriteRow] !==
            command.row[key as keyof LegacyTranscriptWriteRow]
        ))
    )
      fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
    actor.fragment ??= { index: command.index, total: command.totalFragments, row: command.row }
    inserted =
      command.fragmentIndex === 0
        ? insertMessage(actor, command.row, command.index, state.totalMessages)
        : 0
    fragmentOwned = command.fragmentIndex > 0 || inserted > 0
    if (fragmentOwned) {
      let characters = 0
      for (let index = 0; index < command.fragments.length; index++) {
        const value = command.fragments[index]
        actor.database.run(
          `INSERT INTO thread_message_fragments(thread_id,message_id,content_text,created_at)
          VALUES (?,?,?,?)`,
          [
            actor.threadId,
            command.row.messageId,
            value,
            command.row.createdAt + command.fragmentIndex + index
          ]
        )
        characters += value.length
      }
      if (characters)
        actor.database.run(
          `INSERT INTO thread_message_fragment_states(thread_id,message_id,total_chars,updated_at)
        VALUES (?,?,?,?) ON CONFLICT(thread_id,message_id) DO UPDATE SET
        total_chars=thread_message_fragment_states.total_chars+excluded.total_chars,updated_at=excluded.updated_at`,
          [actor.threadId, command.row.messageId, characters, Date.now()]
        )
    }
    const complete = command.complete || !fragmentOwned
    next += complete ? 1 : 0
    fragment = complete ? 0 : command.nextFragmentIndex
  }
  actor.database.run(
    `UPDATE thread_message_buckets SET message_count=message_count+?,updated_at=? WHERE thread_id=?`,
    [inserted, Date.now(), actor.threadId]
  )
  actor.database.run(
    `UPDATE ${markerTable} SET next_index=?,current_fragment_index=?,updated_at=?
    WHERE thread_id=? AND checkpoint_id=? AND next_index=? AND current_fragment_index=? AND status='migrating'`,
    [
      next,
      fragment,
      Date.now(),
      actor.threadId,
      state.checkpointId,
      command.index,
      command.fragmentIndex
    ]
  )
  if (actor.database.getRowsModified() !== 1) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  return progress(actor, inserted, fragmentOwned)
}

function timingSource(actor: Actor, checkpointId: string): LegacyTranscriptWriteResult {
  const state = requireMarker(actor, { checkpointId })
  if (state.status !== "complete") fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  const database = actor.database
  const columns = database.exec("PRAGMA table_info(threads)")[0]?.values ?? []
  if (
    !columns.some((value) => value[1] === "thread_values") ||
    !hasTable(database, "thread_legacy_message_times")
  )
    return { timing: null }
  const live = row(
    database,
    `SELECT CASE WHEN json_valid(thread_values) THEN ${timeProjection} END
    FROM threads WHERE thread_id=?`,
    [actor.threadId]
  )?.[0]
  const archived = row(
    database,
    "SELECT values_json,applied_checkpoint_id FROM thread_legacy_message_times WHERE thread_id=?",
    [actor.threadId]
  )
  const liveSource = typeof live === "string" && live !== "[null,null,null,null]" ? live : null
  const source = liveSource ?? (typeof archived?.[0] === "string" ? archived[0] : null)
  if (!source || (archived?.[0] === source && archived[1] === checkpointId)) return { timing: null }
  // All JSON work is native SQL/Worker work. Main never decodes full thread_values or times.
  database.run(
    `INSERT INTO thread_legacy_message_times(thread_id,values_json) VALUES (?,?)
    ON CONFLICT(thread_id) DO UPDATE SET values_json=excluded.values_json,applied_checkpoint_id=NULL
    WHERE thread_legacy_message_times.values_json IS ?`,
    [actor.threadId, source, archived?.[0] ?? null]
  )
  if (database.getRowsModified() !== 1) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  const timing: TimingSource = {
    token: randomUUID(),
    source,
    live: liveSource,
    index: 0,
    checkpointId
  }
  actor.timing = timing
  return { timing: { timingToken: timing.token, source } }
}
function timingPage(
  actor: Actor,
  command: Extract<LegacyTranscriptWriteCommand, { kind: "timing-page" }>
): LegacyTranscriptWriteResult {
  const timing = actor.timing,
    state = requireMarker(actor, { checkpointId: command.checkpointId })
  if (
    !timing ||
    timing.token !== command.timingToken ||
    timing.checkpointId !== command.checkpointId ||
    timing.index !== command.index ||
    command.index + command.entries.length > state.totalMessages ||
    command.complete !== (command.index + command.entries.length === state.totalMessages)
  )
    fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  const matches = row(
    actor.database,
    `SELECT 1 FROM threads WHERE thread_id=?
    AND (CASE WHEN json_valid(thread_values) THEN NULLIF(${timeProjection},'[null,null,null,null]') END) IS ?
    AND EXISTS(SELECT 1 FROM thread_legacy_message_times WHERE thread_id=? AND values_json IS ?)`,
    [actor.threadId, timing.live, actor.threadId, timing.source]
  )
  if (!matches) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  for (const entry of command.entries) {
    if (entry.endAt !== null && entry.startAt !== null && entry.endAt < entry.startAt)
      fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    if (entry.startAt === null && entry.endAt === null) continue
    actor.database.run(
      `UPDATE thread_messages SET
      start_at=COALESCE(start_at,CASE WHEN end_at IS NULL OR ?<=end_at THEN ? END),
      end_at=COALESCE(end_at,CASE WHEN start_at IS NULL OR ?>=start_at THEN ? END),
      created_at=CASE WHEN start_at IS NULL AND ? IS NOT NULL AND (end_at IS NULL OR ?<=end_at)
        THEN ? ELSE created_at END WHERE thread_id=? AND message_id=?`,
      [
        entry.startAt,
        entry.startAt,
        entry.endAt,
        entry.endAt,
        entry.startAt,
        entry.startAt,
        entry.startAt,
        actor.threadId,
        entry.messageId
      ]
    )
  }
  if (command.complete)
    actor.database.run(
      `UPDATE thread_legacy_message_times SET applied_checkpoint_id=?
    WHERE thread_id=? AND values_json IS ?`,
      [command.checkpointId, actor.threadId, timing.source]
    )
  return { nextIndex: command.index + command.entries.length, complete: command.complete }
}
function apply(actor: Actor, command: LegacyTranscriptWriteCommand): LegacyTranscriptWriteResult {
  if (command.kind === "read-state")
    return { marker: readMarker(actor), ordinary: noNativeOwner(actor) }
  if (command.kind === "reserve") {
    const old = readMarker(actor)
    bindSource(actor, command.checkpointId, command.totalMessages)
    if (old) {
      requireMarker(actor, command)
      return progress(actor)
    }
    const summary = row(
      actor.database,
      `SELECT COUNT(*),COALESCE(MAX(ordinal),-1)+1
      FROM thread_messages WHERE thread_id=?`,
      [actor.threadId]
    )!
    if (command.totalMessages > 0 && Number(summary[0]) > 0)
      actor.database.run("UPDATE thread_messages SET ordinal=ordinal+? WHERE thread_id=?", [
        command.totalMessages,
        actor.threadId
      ])
    actor.database.run(
      `INSERT INTO thread_message_buckets(thread_id,message_count,next_ordinal,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET message_count=excluded.message_count,
      next_ordinal=excluded.next_ordinal,updated_at=excluded.updated_at`,
      [actor.threadId, Number(summary[0]), Number(summary[1]) + command.totalMessages, Date.now()]
    )
    actor.database.run(
      `INSERT INTO ${markerTable}(thread_id,checkpoint_id,total_messages,next_index,
      current_fragment_index,status,updated_at) VALUES (?,?,?,0,0,'migrating',?)`,
      [actor.threadId, command.checkpointId, command.totalMessages, Date.now()]
    )
    return progress(actor)
  }
  if (command.kind === "copy") return copy(actor, command)
  if (command.kind === "finish") {
    const state = requireMarker(actor, command)
    if (state.nextIndex !== state.totalMessages || state.fragmentIndex !== 0)
      fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
    const summary = row(
      actor.database,
      "SELECT COUNT(*),COALESCE(MAX(ordinal),-1)+1 FROM thread_messages WHERE thread_id=?",
      [actor.threadId]
    )!
    actor.database.run(
      "UPDATE thread_message_buckets SET message_count=?,next_ordinal=?,updated_at=? WHERE thread_id=?",
      [Number(summary[0]), Number(summary[1]), Date.now(), actor.threadId]
    )
    actor.database.run(
      `UPDATE ${markerTable} SET next_index=total_messages,status='complete',updated_at=?
      WHERE thread_id=? AND checkpoint_id=? AND next_index=? AND current_fragment_index=0`,
      [Date.now(), actor.threadId, state.checkpointId, state.totalMessages]
    )
    if (actor.database.getRowsModified() !== 1) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
    return progress(actor)
  }
  if (command.kind === "timing-source") return timingSource(actor, command.checkpointId)
  return timingPage(actor, command)
}

/** Defer only the original reserve transaction's automatic checkpoint. Main may
 * serve other work while native PASSIVE maintenance runs; this command's credit
 * and ACK remain held until actual maintenance exit and policy restoration.
 */
async function reserveWithWalMaintenance(
  actor: Actor,
  command: Extract<LegacyTranscriptWriteCommand, { kind: "reserve" }>
): Promise<LegacyTranscriptWriteResult> {
  const database = actor.database
  const pages = Number(row(database, "PRAGMA wal_autocheckpoint")?.[0])
  if (!Number.isSafeInteger(pages) || pages < 0)
    fail("LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE")
  const work = () => {
    ensureMarkerSchema(database)
    return transaction(actor, () => apply(actor, command))
  }
  // Respect a connection whose owner already disabled automatic checkpoints.
  if (pages === 0) return work()
  const main = (database.exec("PRAGMA database_list")[0]?.values ?? []).find(
    (entry) => entry[1] === "main"
  )
  const path = main?.[2]
  // In-memory adapters have no WAL/file lifecycle to maintain.
  if (typeof path !== "string" || !path) return work()
  const pageSize = Number(row(database, "PRAGMA page_size")?.[0])
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    fail("LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE")
  current(actor, true)
  const identity = await resolveCheckpointDatabaseIdentity(path, { createParent: false })
  current(actor, true)
  const file = identity.capturedFile && Object.freeze({ ...identity.capturedFile })
  if (!file) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
  await assertCheckpointDatabasePathCurrent(identity)
  current(actor, true)
  await assertCheckpointDatabaseFileIdentity(identity.path, file)
  current(actor, true)
  let result: LegacyTranscriptWriteResult
  try {
    // Set before DDL as well as BEGIN: even schema publication can commit.
    database.run("PRAGMA wal_autocheckpoint = 0")
    result = work()
    let bytes = 0
    try {
      bytes = (await stat(`${identity.path}-wal`)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn("[DB] Reserve WAL size observation failed")
    }
    // File size is an allocation high-water hint, not a live-frame proof.
    if (bytes >= 32 + pages * (pageSize + 24))
      await checkpointWalInBackground(identity.path, { freshAfterCurrent: true, identity, file })
  } finally {
    // Cancellation/source revocation must not strand the old connection's policy.
    // Never restore against a replacement connection, and never mask a failed
    // restore with the later source/file checks.
    if (!databaseIsClosed(database)) {
      try {
        database.run(`PRAGMA wal_autocheckpoint = ${pages}`)
      } catch {
        closeUnavailableDatabase(actor)
      }
    }
  }
  await assertCheckpointDatabasePathCurrent(identity)
  await assertCheckpointDatabaseFileIdentity(identity.path, file)
  current(actor, true)
  return result
}

function code(error: unknown, actor: Actor): LegacyTranscriptWriteError {
  if (error instanceof Error && error.message === "LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE")
    return "LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE"
  if (actor.cancelled || actor.controller.signal.aborted) return "LEGACY_TRANSCRIPT_WRITE_CANCELLED"
  if (error instanceof Error && error.name === "WORKER_ADMISSION_CAPACITY_EXCEEDED")
    return "LEGACY_TRANSCRIPT_WRITE_BUSY"
  const value = error instanceof Error ? error.message : undefined
  return LEGACY_TRANSCRIPT_WRITE_ERRORS.includes(value as LegacyTranscriptWriteError)
    ? (value as LegacyTranscriptWriteError)
    : "LEGACY_TRANSCRIPT_WRITE_FAILED"
}
/** ACK is sent here once; the client must not post the returned diagnostic value again. */
export async function handleLegacyTranscriptWriterCommand(
  handle: LegacyTranscriptWriter,
  actualWorker: Worker,
  wire: unknown
): Promise<LegacyTranscriptWriteAcknowledgement> {
  const actor = actual(handle)
  if (actor.worker !== actualWorker) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const message = object(wire, [
    "type",
    "protocol",
    "nonce",
    "workerGeneration",
    "requestId",
    "sequence",
    "command"
  ])
  if (
    message.type !== "legacy-transcript-write" ||
    message.protocol !== actor.data.protocol ||
    message.nonce !== actor.data.nonce ||
    message.workerGeneration !== actor.data.workerGeneration ||
    message.requestId !== actor.data.requestId
  )
    fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
  const sequence = integer(message.sequence)
  actor.commands++ // Retain through queued admission, actual SQL and ACK dispatch.
  let release: (() => void) | undefined,
    claimed = false
  try {
    let reply: LegacyTranscriptWriteAcknowledgement
    const previousTiming = actor.timing
    const previousFragment = actor.fragment
    try {
      if (actor.busy || sequence !== actor.sequence + 1) fail("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
      actor.busy = claimed = true
      actor.sequence = sequence
      const command = copyCommand(message.command) // Owned fields before the first await.
      current(actor)
      release = await admission.acquire(actor.controller.signal)
      await new Promise<void>((resolve) => setImmediate(resolve))
      current(actor, command.kind !== "read-state")
      const result =
        command.kind === "read-state"
          ? apply(actor, command)
          : command.kind === "reserve"
            ? await reserveWithWalMaintenance(actor, command)
            : transaction(actor, () => apply(actor, command))
      if (command.kind === "read-state") current(actor)
      else if (command.kind === "reserve") current(actor, true)
      if (
        command.kind === "copy" &&
        command.mode === "fragments" &&
        "marker" in result &&
        result.marker?.nextIndex !== command.index
      )
        actor.fragment = undefined
      // Timing progress is published only after the actual COMMIT.
      if (command.kind === "timing-page" && actor.timing) {
        actor.timing.index = command.index + command.entries.length
        if (command.complete) actor.timing = undefined
      }
      reply = { ...actor.data, type: "legacy-transcript-write-ack", sequence, ok: true, result }
    } catch (error) {
      actor.timing = previousTiming
      actor.fragment = previousFragment
      reply = {
        ...actor.data,
        type: "legacy-transcript-write-ack",
        sequence,
        ok: false,
        error: { code: code(error, actor) }
      }
    }
    // Even a cancelled producer receives its rejection, so its original ACK waiter can drain.
    actor.worker.postMessage(reply)
    return reply
  } finally {
    if (actor.cleanupPending) actor.retainedAdmission ??= release
    else release?.()
    if (claimed) actor.busy = false
    actor.commands--
    releaseDrain(actor)
  }
}
