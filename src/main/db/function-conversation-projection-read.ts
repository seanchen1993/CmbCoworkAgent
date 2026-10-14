import { createHash } from "node:crypto"
import { types } from "node:util"
import { canonicalRowFingerprint as rawFingerprint } from "./canonical-row-fingerprint"
import type { ModObject } from "../../shared/mods/types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { sameFunctionConversationTranscriptStamp, validateFunctionConversationTranscriptStamp }
  from "../../shared/mods/v2/conversation-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation, type ThreadIncarnation }
  from "../services/thread-incarnation"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, functionConversationProjectionIncarnation,
  functionConversationProjectionStamp, validateFunctionConversationRawProjection,
  type FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"
import type { NativeSqliteAdapter, NativeSqliteReadOne, NativeSqliteValue }
  from "./native-sqlite-adapter"
import { readFunctionConversationPresentationDispositionData,
  revalidateFunctionConversationPresentationDispositionData,
  type FunctionConversationPresentationDisposition,
  type FunctionConversationPresentationDispositionData } from
  "./function-conversation-presentation-disposition"

export interface FunctionConversationProjectionSealInput {
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  readonly messageId: string
  assertCurrent(): void
}
const readScopeBrand: unique symbol = Symbol("native-projection-read")
export interface FunctionConversationProjectionReadScope { readonly [readScopeBrand]: true }
type SqlRow = Record<string, NativeSqliteValue>
interface Observation {
  readonly bindings: readonly string[]
  readonly rawFingerprint: string
  readonly columnsDigest: string
  readonly presentation: FunctionConversationPresentationDisposition
}
export interface FunctionConversationProjectionPresentationSummary {
  readonly columnsDigest: string
  readonly presentation: FunctionConversationPresentationDisposition
}
interface ReadScope {
  readonly database: NativeSqliteAdapter
  readonly observations: Map<string, Observation>
  state: "active" | "suspended" | "finalizing" | "closed"
  failure?: unknown
  failed: boolean
}
const scopes = new WeakMap<FunctionConversationProjectionReadScope, ReadScope>()
// Summary observations never retain UI columns or native/keeper bodies. Columns are loaded only
// when a consumer actually requests a visible row, against that original complete observation.
const observedColumns = new WeakMap<Observation, FunctionConversationProjectionColumns>()
const sealedPresentations = new WeakMap<FunctionConversationProjectionColumns, {
  readonly token: FunctionConversationProjectionReadScope
  readonly observation: Observation
}>()
const statements = new WeakMap<NativeSqliteAdapter, Map<string, NativeSqliteReadOne>>()
const inUse = new WeakMap<NativeSqliteAdapter, Set<string>>()
const RECEIPTS = "function_conversation_projection_receipts"
const PRESENTATIONS = "function_conversation_presentation_dispositions"
const TARGET_FIELDS = Object.freeze(["logicalSessionId", "conversationId", "branchId", "threadId",
  "workspace", "incarnation", "checkpointNamespace", "kind"])
const RECEIPT_FIELDS = Object.freeze(["thread_id", "incarnation", "uuid", "target_json",
  "canonical_receipt_id", "canonical_row_digest", "native_payload_digest", "projection_json",
  "projection_digest"])
const KEEPER_FIELDS = Object.freeze(["conversation_id", "uuid", "sequence", "receipt_id",
  "branch_id", "input_digest", "door", "payload_json", "payload_digest", "created_at", "bytes"])
const COLUMN_NAMES = FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(name => `'${name}'`).join(",")
// Enumerate the schema once per fresh SQL statement. Both aggregates describe the same
// current schema; this is query composition, never a cached schema version or permission.
const SCHEMA_COLUMNS_QUERY = `SELECT COUNT(*) AS schema_count,
  COALESCE(SUM(name NOT IN (${COLUMN_NAMES})),0) AS schema_extra
  FROM pragma_table_info('thread_messages')`
const SCHEMA_QUERY = `SELECT
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='${RECEIPTS}') AS receipt_schema,
  schema.schema_count,schema.schema_extra FROM (${SCHEMA_COLUMNS_QUERY}) schema`
const CONVERSATION = "CASE WHEN json_valid(r.target_json) THEN json_extract(r.target_json,'$.conversationId') END"
const BRANCH = "CASE WHEN json_valid(r.target_json) THEN json_extract(r.target_json,'$.branchId') END"
const READ_QUERY = `SELECT
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='${RECEIPTS}') AS receipt_schema,
  ${FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(name => `p.${name} AS projection_${name}`).join(",")},
  ${RECEIPT_FIELDS.map(name => `r.${name} AS receipt_${name}`).join(",")},
  ${KEEPER_FIELDS.map(name => `k.${name} AS keeper_${name}`).join(",")},
  pt.created_at AS physical_created_at,pt.metadata AS physical_metadata,
  lt.created_at AS logical_created_at,lt.metadata AS logical_metadata,
  s.thread_id AS target_thread_id,s.incarnation_key AS target_incarnation_key,
  s.workspace AS target_workspace,c.logical_session_id AS target_logical_session_id,
  c.kind AS target_kind,c.checkpoint_namespace AS target_checkpoint_namespace,
  c.next_sequence AS target_next_sequence,b.conversation_id AS target_conversation_id,
  b.branch_id AS target_branch_id,
  EXISTS(SELECT 1 FROM thread_message_fragments f WHERE f.thread_id=w.thread_id
    AND f.message_id=w.uuid) AS fragments,
  EXISTS(SELECT 1 FROM thread_message_fragment_states f WHERE f.thread_id=w.thread_id
    AND f.message_id=w.uuid) AS fragment_states,
  schema.schema_count,schema.schema_extra
  FROM (SELECT ? AS thread_id,? AS incarnation,? AS uuid) w
  CROSS JOIN (${SCHEMA_COLUMNS_QUERY}) schema
  LEFT JOIN threads pt ON pt.thread_id=w.thread_id
  LEFT JOIN ${RECEIPTS} r ON r.thread_id=w.thread_id AND r.incarnation=w.incarnation AND r.uuid=w.uuid
  LEFT JOIN thread_messages p ON p.thread_id=w.thread_id AND p.message_id=w.uuid
  LEFT JOIN function_conversation_rows k ON k.conversation_id=${CONVERSATION} AND k.uuid=w.uuid
  LEFT JOIN function_conversations c ON c.conversation_id=${CONVERSATION}
  LEFT JOIN function_logical_sessions s ON s.logical_session_id=c.logical_session_id
  LEFT JOIN function_conversation_branches b ON b.conversation_id=c.conversation_id
    AND b.branch_id=${BRANCH}
  LEFT JOIN threads lt ON lt.thread_id=s.thread_id`

function fail(code = "MODS_CONVERSATION_PROJECTION_CONFLICT"): never {
  throw new ModFunctionError(code)
}
function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) fail()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function object(value: unknown): ModObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  return value as ModObject
}
function parse(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return fail() }
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
function assertSync(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return
  if (types.isProxy(value) || types.isPromise(value)) fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
  let current: object | null = value
  while (current) {
    if (types.isProxy(current)) fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
    const then = Object.getOwnPropertyDescriptor(current, "then")
    if (then && (!("value" in then) || typeof then.value === "function"))
      fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
    current = Object.getPrototypeOf(current)
  }
}
function readOne(db: NativeSqliteAdapter, sql: string, bindings: readonly string[]): SqlRow | undefined {
  let busy = inUse.get(db)
  if (!busy) { busy = new Set(); inUse.set(db, busy) }
  const temporary = busy.has(sql)
  if (!temporary) busy.add(sql)
  let cached = statements.get(db)
  if (!cached) { cached = new Map(); statements.set(db, cached) }
  let read: NativeSqliteReadOne | undefined
  try {
    read = temporary ? db.prepareReadOne(sql) : cached.get(sql)
    if (!read) { read = db.prepareReadOne(sql); cached.set(sql, read) }
    return read(bindings)
  } catch (error) {
    if (!temporary && cached.get(sql) === read) cached.delete(sql)
    throw error
  } finally { if (!temporary) busy.delete(sql) }
}
function assertProjectionSchema(schema: SqlRow | undefined): void {
  if (!schema?.receipt_schema) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (schema.schema_count !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length || schema.schema_extra !== 0)
    fail("MODS_CONVERSATION_PROJECTION_SCHEMA")
}
function fresh(db: NativeSqliteAdapter, bindings: readonly string[]): SqlRow {
  let row: SqlRow | undefined
  try {
    // One statement observes the receipt table's type, complete schema and all sealed data.
    // Both A and final B execute this statement anew; only SQL compilation is reused.
    row = readOne(db, READ_QUERY, bindings)
  } catch (error) {
    // Missing tables/columns can prevent preparation before the schema facts are returned.
    // Preserve the original migration/schema classification without caching those facts.
    assertProjectionSchema(readOne(db, SCHEMA_QUERY, []))
    throw error
  }
  if (!row) fail()
  assertProjectionSchema(row)
  return row
}
function scopeOf(token: FunctionConversationProjectionReadScope,
  database?: NativeSqliteAdapter): ReadScope {
  const scope = scopes.get(token)
  if (!scope) fail()
  if (scope.state !== "active" || (database && scope.database !== database)) {
    const error = new ModFunctionError("MODS_CONVERSATION_PROJECTION_CONFLICT")
    scope.failed = true; scope.failure = error
    throw error
  }
  if (scope.failed) throw scope.failure
  return scope
}

export function assertFunctionConversationProjectionReadScope(token: FunctionConversationProjectionReadScope,
  db: NativeSqliteAdapter): void { scopeOf(token, db) }

/** Presence only. A remaining private receipt must never be downgraded to an ordinary row. */
export function hasFunctionConversationProjectionMarker(db: NativeSqliteAdapter, threadId: string,
  uuid: string): boolean {
  const bindings = [text(threadId), text(uuid)]
  if (hasProjectionMarkerColumn(db)) {
    const row = readOne(db, "SELECT function_row_json FROM thread_messages WHERE thread_id=? AND message_id=?",
      bindings)
    if (row && row.function_row_json !== null) return true
  }
  for (const table of [RECEIPTS, PRESENTATIONS]) {
    if (!hasProjectionEvidenceTable(db, table)) continue
    const receipt = readOne(db, `SELECT EXISTS(SELECT 1 FROM ${table}
      WHERE thread_id=? AND uuid=?) AS present`, bindings)
    // An old incarnation or remaining ledger triggers the full seal; neither grants a read.
    if (receipt?.present) return true
  }
  return false
}

function hasProjectionMarkerColumn(db: NativeSqliteAdapter): boolean {
  return Boolean(readOne(db, `SELECT EXISTS(SELECT 1 FROM pragma_table_info('thread_messages')
    WHERE name='function_row_json') AS present`, [])?.present)
}
function hasProjectionEvidenceTable(db: NativeSqliteAdapter, table: string): boolean {
  return Boolean(readOne(db, `SELECT EXISTS(SELECT 1 FROM sqlite_master
    WHERE type='table' AND name=?) AS present`, [table])?.present)
}
export function hasFunctionConversationProjectionReceiptSchema(db: NativeSqliteAdapter): boolean {
  return hasProjectionEvidenceTable(db, RECEIPTS)
}

/** Fresh presence data, never a seal. Bound parameters are shared by both sides of the UNION. */
export function findFunctionConversationProjectionMarkers(db: NativeSqliteAdapter, threadId: string,
  candidates: readonly string[]): ReadonlySet<string> {
  const selected = text(threadId)
  const ids = [...new Set(candidates.filter(id => id !== "").map(id => text(id)))]
  const found = new Set<string>(), sources: string[] = []
  if (hasProjectionMarkerColumn(db)) sources.push(`SELECT p.message_id AS uuid FROM thread_messages p
    JOIN wanted w ON w.uuid=p.message_id
    WHERE p.thread_id=(SELECT thread_id FROM selected) AND p.function_row_json IS NOT NULL`)
  for (const table of [RECEIPTS, PRESENTATIONS]) {
    if (hasProjectionEvidenceTable(db, table)) sources.push(`SELECT r.uuid FROM ${table} r
      JOIN wanted w ON w.uuid=r.uuid WHERE r.thread_id=(SELECT thread_id FROM selected)`)
  }
  if (!sources.length) return found
  for (let offset = 0; offset < ids.length; offset += 512) {
    const chunk = ids.slice(offset, offset + 512)
    const sql = `SELECT json_group_array(uuid) AS uuids FROM (
      WITH wanted(uuid) AS (VALUES ${chunk.map(() => "(?)").join(",")}),
        selected(thread_id) AS (VALUES (?))
      ${sources.join(" UNION ")})`
    // Only the statement is reusable; rows and schema presence are read anew on every call.
    const row = readOne(db, sql, [...chunk, selected])
    const values = parse(text(row?.uuids))
    if (!Array.isArray(values) || values.length > chunk.length) fail()
    for (const value of values) found.add(text(value))
  }
  return found
}

/** Host-only explicit synchronous composition. No public read borrows an ambient operation. */
export function withFunctionConversationProjectionReadScope<T>(db: NativeSqliteAdapter,
  run: (scope: FunctionConversationProjectionReadScope) => T): T {
  const token: FunctionConversationProjectionReadScope = Object.freeze({ [readScopeBrand]: true as const })
  const scope: ReadScope = { database: db, observations: new Map(), state: "active", failed: false }
  scopes.set(token, scope)
  try {
    const value = run(token)
    assertSync(value)
    if (scope.failed) throw scope.failure
    scope.state = "finalizing"
    // No host callback executes from here to the return. All selected values are fresh again.
    for (const prior of scope.observations.values()) {
      const actual = fresh(db, prior.bindings)
      if (rawFingerprint(actual) !== prior.rawFingerprint) fail()
      revalidateFunctionConversationPresentationDispositionData(db, prior.presentation)
    }
    return value
  } finally { scope.state = "closed"; scope.observations.clear() }
}

/** Suspend this exact reader during arbitrary native callbacks. Public re-entry is independent. */
export function runFunctionConversationProjectionGuard<T>(token: FunctionConversationProjectionReadScope,
  run: () => T): T {
  const scope = scopeOf(token)
  scope.state = "suspended"
  try {
    const value = run()
    assertSync(value)
    return value
  } catch (error) { scope.failed = true; scope.failure = error; throw error }
  finally { scope.state = "active" }
}

function thread(row: SqlRow, prefix: string, incarnation?: ThreadIncarnation) {
  if (row[`${prefix}_created_at`] === null) fail("MODS_CONVERSATION_THREAD_CHANGED")
  const value = { created_at: integer(row[`${prefix}_created_at`]),
    metadata: row[`${prefix}_metadata`] === null ? null : text(row[`${prefix}_metadata`], true) }
  if (incarnation && !matchesThreadIncarnation(value, incarnation))
    fail("MODS_CONVERSATION_THREAD_CHANGED")
  return value
}
function target(row: SqlRow): FunctionConversationRef {
  const encoded = text(row.receipt_target_json), value = object(parse(encoded))
  if (Object.keys(value).length !== TARGET_FIELDS.length ||
    Object.keys(value).some(key => !TARGET_FIELDS.includes(key))) fail()
  const incarnation = Object.freeze(captureThreadIncarnation(thread(row, "logical")))
  const key = text(value.incarnation)
  if (functionConversationProjectionIncarnation(incarnation) !== key)
    fail("MODS_CONVERSATION_THREAD_CHANGED")
  if (value.kind !== "main" && value.kind !== "child") fail()
  const result: FunctionConversationRef = Object.freeze({ logicalSessionId: text(value.logicalSessionId),
    conversationId: text(value.conversationId), branchId: text(value.branchId),
    threadId: text(value.threadId), workspace: text(value.workspace), incarnation,
    checkpointNamespace: text(value.checkpointNamespace, true), kind: value.kind })
  if (JSON.stringify({ ...result, incarnation: key }) !== encoded) fail()
  if (row.target_thread_id !== result.threadId || row.target_workspace !== result.workspace ||
    row.target_incarnation_key !== key || row.target_logical_session_id !== result.logicalSessionId ||
    row.target_kind !== result.kind || row.target_checkpoint_namespace !== result.checkpointNamespace ||
    row.target_conversation_id !== result.conversationId || row.target_branch_id !== result.branchId)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  return result
}
function canonical(row: SqlRow, selected: FunctionConversationRef, uuid: string): FunctionConversationRow {
  const encoded = text(row.keeper_payload_json), bytes = integer(row.keeper_bytes)
  if (hash(encoded) !== row.keeper_payload_digest || Buffer.byteLength(encoded) !== bytes) fail()
  const payload = object(parse(encoded))
  if (Object.keys(payload).length !== 5 || Object.keys(payload).some(key =>
    !["origin", "message", "nativePayload", "orderAnchor", "inbox"].includes(key)) ||
    typeof payload.inbox !== "boolean") fail()
  const sequence = integer(row.keeper_sequence)
  if (sequence < 1 || sequence >= integer(row.target_next_sequence) || row.keeper_uuid !== uuid ||
    row.keeper_conversation_id !== selected.conversationId || row.keeper_branch_id !== selected.branchId)
    fail()
  return Object.freeze({ uuid, sequence, receiptId: text(row.keeper_receipt_id),
    branchId: text(row.keeper_branch_id), inputDigest: text(row.keeper_input_digest),
    door: text(row.keeper_door), origin: object(payload.origin), message: object(payload.message),
    nativePayload: text(payload.nativePayload), orderAnchor: object(payload.orderAnchor),
    createdAt: integer(row.keeper_created_at), inbox: payload.inbox, bytes })
}
function validate(raw: SqlRow, bindings: readonly string[], incarnation: ThreadIncarnation):
  Readonly<{ columns: FunctionConversationProjectionColumns
    presentationFacts: FunctionConversationPresentationDispositionData }> {
  const [threadId, key, uuid] = bindings
  thread(raw, "physical", incarnation)
  if (raw.receipt_uuid === null) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (raw.schema_count !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length || raw.schema_extra !== 0)
    fail("MODS_CONVERSATION_PROJECTION_SCHEMA")
  const selected = target(raw), row = canonical(raw, selected, uuid)
  const projected: SqlRow = Object.fromEntries(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(name =>
    [name, raw[`projection_${name}`]]))
  const columns = validateFunctionConversationRawProjection(projected, threadId, uuid)
  const stamp = parse(text(columns.function_row_json))
  validateFunctionConversationTranscriptStamp(stamp)
  if (!sameFunctionConversationTranscriptStamp(stamp, functionConversationProjectionStamp(selected, row)))
    fail()
  if (columns.role === "tool") {
    const content = row.message.content
    if (typeof columns.tool_call_id !== "string" || !columns.tool_call_id ||
      row.message.type !== "user" || row.message.isMeta === true ||
      !["tool-result", "tool-message"].includes(row.door) || !Array.isArray(content) ||
      content.length !== 1 || !content[0] || typeof content[0] !== "object" || Array.isArray(content[0]) ||
      content[0].type !== "tool_result" || content[0].tool_use_id !== columns.tool_call_id) fail()
  } else if (columns.role !== (row.message.type === "attachment" ? "user" : row.message.type)) fail()
  if (raw.fragments !== 0 || raw.fragment_states !== 0) fail()
  const encoded = JSON.stringify(columns)
  const expected: SqlRow = { thread_id: threadId, incarnation: key, uuid,
    target_json: text(raw.receipt_target_json), canonical_receipt_id: row.receiptId,
    canonical_row_digest: hash(JSON.stringify(row)), native_payload_digest: hash(row.nativePayload),
    projection_json: encoded, projection_digest: hash(encoded) }
  if (RECEIPT_FIELDS.some(name => expected[name] !== raw[`receipt_${name}`])) fail()
  return Object.freeze({ columns, presentationFacts: Object.freeze({ threadId, incarnation: key,
    uuid, targetJson: text(raw.receipt_target_json), canonicalReceiptId: row.receiptId,
    canonicalRowDigest: text(raw.receipt_canonical_row_digest),
    nativePayloadDigest: text(raw.receipt_native_payload_digest),
    projectionDigest: text(raw.receipt_projection_digest), orderAnchor: row.orderAnchor,
    role: text(columns.role), door: row.door, messageType: text(row.message.type),
    contentJson: text(columns.content_json), recoveryIntegrity: columns.recovery_integrity }) })
}

/** Data from this exact active full-seal scope. Copies and retired scopes cannot select it. */
export function readSealedFunctionConversationProjectionPresentation(db: NativeSqliteAdapter,
  token: FunctionConversationProjectionReadScope, columns: FunctionConversationProjectionColumns):
  FunctionConversationPresentationDisposition {
  const scope = scopeOf(token, db), proof = sealedPresentations.get(columns)
  if (!proof || proof.token !== token ||
    scope.observations.get(JSON.stringify(proof.observation.bindings)) !== proof.observation) fail()
  return proof.observation.presentation
}

/** Read-only data integrity. No authority, schema creation, receipt replacement or COMMIT proof. */
function readObservation(db: NativeSqliteAdapter, input: FunctionConversationProjectionSealInput,
  token: FunctionConversationProjectionReadScope, includeColumns: boolean): Observation {
  const scope = scopeOf(token, db), threadId = text(input.threadId), uuid = text(input.messageId)
  const incarnation = Object.freeze({ token: input.incarnation.token,
    legacyCreatedAt: integer(input.incarnation.legacyCreatedAt) })
  if (incarnation.token !== null) text(incarnation.token)
  const bindings = Object.freeze([threadId, functionConversationProjectionIncarnation(incarnation), uuid])
  const guard = input.assertCurrent.bind(input), key = JSON.stringify(bindings)
  try {
    runFunctionConversationProjectionGuard(token, guard)
    let observation = scope.observations.get(key)
    if (!observation) {
      const raw = fresh(db, bindings), validated = validate(raw, bindings, incarnation)
      const presentation = readFunctionConversationPresentationDispositionData(db,
        validated.presentationFacts)
      observation = Object.freeze({ bindings, rawFingerprint: rawFingerprint(raw),
        columnsDigest: hash(JSON.stringify(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(
          key => validated.columns[key]))), presentation })
      scope.observations.set(key, observation)
      if (includeColumns) {
        observedColumns.set(observation, validated.columns)
        sealedPresentations.set(validated.columns, { token, observation })
      }
    } else if (includeColumns && !observedColumns.has(observation)) {
      // The caller cannot upgrade a summary by supplying a digest or an old renderer row.
      // Reconstruct columns from the actual original database, including all native/member facts.
      const raw = fresh(db, bindings), validated = validate(raw, bindings, incarnation)
      if (rawFingerprint(raw) !== observation.rawFingerprint ||
        hash(JSON.stringify(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(
          key => validated.columns[key]))) !== observation.columnsDigest) fail()
      revalidateFunctionConversationPresentationDispositionData(db, observation.presentation)
      observedColumns.set(observation, validated.columns)
      sealedPresentations.set(validated.columns, { token, observation })
    }
    runFunctionConversationProjectionGuard(token, guard)
    return observation
  } catch (error) { scope.failed = true; scope.failure = error; throw error }
}

/** Full A/B validation with only fixed-size data retained for each selected member. */
export function readStoredFunctionConversationProjectionPresentationSummary(db: NativeSqliteAdapter,
  input: FunctionConversationProjectionSealInput, token?: FunctionConversationProjectionReadScope):
  FunctionConversationProjectionPresentationSummary {
  if (!token) return withFunctionConversationProjectionReadScope(db, scope =>
    readStoredFunctionConversationProjectionPresentationSummary(db, input, scope))
  const observation = readObservation(db, input, token, false)
  return Object.freeze({ columnsDigest: observation.columnsDigest,
    presentation: observation.presentation })
}

/** Read-only data integrity. No authority, schema creation, receipt replacement or COMMIT proof. */
export function readStoredFunctionConversationProjection(db: NativeSqliteAdapter,
  input: FunctionConversationProjectionSealInput, token?: FunctionConversationProjectionReadScope):
  FunctionConversationProjectionColumns {
  if (!token) return withFunctionConversationProjectionReadScope(db, scope =>
    readStoredFunctionConversationProjection(db, input, scope))
  const observation = readObservation(db, input, token, true)
  const columns = observedColumns.get(observation)
  if (!columns) fail()
  return columns
}
