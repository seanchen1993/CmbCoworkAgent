import { createHash } from "node:crypto"
import type { ModObject } from "../../shared/mods/types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import {
  sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnation
} from "../services/thread-incarnation"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import {
  FUNCTION_CONVERSATION_PROJECTION_COLUMNS,
  functionConversationProjectionIncarnation,
  functionConversationProjectionStamp,
  readFunctionConversationProjectionReceipt
} from "./function-conversation-projection-receipt"
import type { NativeSqliteAdapter, NativeSqliteValue } from "./native-sqlite-adapter"
import { assertFunctionConversationNativeDestinationCleanupInTransaction } from
  "./function-conversation-native-destination"
import { readFunctionConversationPresentationDispositionData,
  type FunctionConversationPresentationDisposition } from
  "./function-conversation-presentation-disposition"

export interface FunctionConversationCleanupInput {
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  /** Original native DB/thread/metadata/lease guard. No execution identity is constructed here. */
  assertCurrent(): void
}

type SqlRow = Record<string, NativeSqliteValue>
type Thread = { created_at: number; metadata: string | null }
type Session = { id: string; threadId: string; incarnation: string; workspace: string }
type Conversation = { id: string; session: Session; kind: "main" | "child";
  invocation: string; namespace: string }
type ChildSelection = { readonly owner: Conversation } | { readonly ordinary: true }
type ProjectionKey = { threadId: string; incarnation: string; uuid: string; removeRaw: boolean;
  receiptDigest: string; presentation: FunctionConversationPresentationDisposition; owner: Conversation }

const CORE = Object.freeze([
  "function_logical_sessions", "function_conversations", "function_conversation_branches",
  "function_conversation_rows", "function_conversation_inbox", "function_conversation_deliveries",
  "function_conversation_checkpoint_receipts", "function_conversation_checkpoint_members"
])
const JOURNAL = Object.freeze([
  "function_conversation_fork_imports", "function_conversation_fork_rows",
  "function_conversation_fork_checkpoints"
])
const PROJECTIONS = "function_conversation_projection_receipts"
const PRESENTATIONS = "function_conversation_presentation_dispositions"
const RECEIPT_FIELDS = Object.freeze(["thread_id", "incarnation", "uuid", "target_json",
  "canonical_receipt_id", "canonical_row_digest", "native_payload_digest", "projection_json",
  "projection_digest"])
const TARGET_FIELDS = Object.freeze([
  "logicalSessionId", "conversationId", "branchId", "threadId", "workspace", "incarnation",
  "checkpointNamespace", "kind"
])

function fail(code = "MODS_CONVERSATION_CLEANUP_CONFLICT"): never {
  throw new ModFunctionError(code)
}
function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value)) fail()
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
function projectionKey(value: { threadId: string; incarnation: string; uuid: string }): string {
  return JSON.stringify([value.threadId, value.incarnation, value.uuid])
}
function receiptDigest(value: SqlRow): string {
  return hash(JSON.stringify(RECEIPT_FIELDS.map(key => [key, text(value[key])])))
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(values => Object.fromEntries(
    result.columns.map((name, index) => [name, values[index]]))) : []
}
function sync(guard: () => void): void {
  const result: unknown = guard()
  if (result && typeof (result as { then?: unknown }).then === "function")
    fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
}
function thread(db: NativeSqliteAdapter, id: string): Thread | undefined {
  const row = query(db, "SELECT created_at,metadata FROM threads WHERE thread_id=?", [id])[0]
  return row ? { created_at: integer(row.created_at),
    metadata: row.metadata === null ? null : text(row.metadata, true) } : undefined
}
function session(row: SqlRow): Session {
  return { id: text(row.logical_session_id), threadId: text(row.thread_id),
    incarnation: text(row.incarnation_key), workspace: text(row.workspace) }
}
function conversations(db: NativeSqliteAdapter, owner: Session): Conversation[] {
  return query(db, "SELECT * FROM function_conversations WHERE logical_session_id=?", [owner.id])
    .map(row => {
      if (row.kind !== "main" && row.kind !== "child") fail()
      const id = text(row.conversation_id), root = text(row.root_branch_id)
      if (!query(db, `SELECT 1 FROM function_conversation_branches
        WHERE branch_id=? AND conversation_id=?`, [root, id]).length) fail()
      if (integer(row.next_sequence) < 1) fail()
      return { id, session: owner, kind: row.kind,
        invocation: text(row.invocation_id, row.kind === "main"),
        namespace: text(row.checkpoint_namespace, true) }
    })
}

/** Actual internal metadata and each persisted ancestor invocation are required, including empties. */
function childOwner(db: NativeSqliteAdapter, threadId: string, original: Thread): ChildSelection | undefined {
  let raw: unknown
  try { raw = JSON.parse(original.metadata ?? "{}") as unknown } catch { return undefined }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const originalMetadata = object(raw)
  if (originalMetadata.isInternalFlowRuntime !== true) return undefined
  if (typeof originalMetadata.modsAgentRunId !== "string" || !originalMetadata.modsAgentRunId ||
    typeof originalMetadata.parentThreadId !== "string" || !originalMetadata.parentThreadId ||
    typeof originalMetadata.workspacePath !== "string" || !originalMetadata.workspacePath)
    return undefined
  const workspace = text(originalMetadata.workspacePath), runs: string[] = []
  const seen = new Set<string>()
  let id = threadId, row = original
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(id)) fail()
    seen.add(id)
    const metadata = object(parse(row.metadata ?? "{}"))
    if (metadata.isInternalFlowRuntime !== true ||
      typeof metadata.workspacePath !== "string" ||
      !isSameWorkspacePath(metadata.workspacePath, workspace)) fail()
    runs.push(text(metadata.modsAgentRunId))
    const parentId = text(metadata.parentThreadId)
    const parent = thread(db, parentId)
    if (!parent) fail("MODS_CONVERSATION_THREAD_CHANGED")
    const parentMetadata = object(parse(parent.metadata ?? "{}"))
    const candidates = query(db, `SELECT * FROM function_logical_sessions
      WHERE thread_id=? AND incarnation_key=?`, [parentId,
      functionConversationProjectionIncarnation(captureThreadIncarnation(parent))])
    if (candidates.length > 1) fail()
    if (candidates.length) {
      if (typeof parentMetadata.workspacePath !== "string" ||
        !isSameWorkspacePath(parentMetadata.workspacePath, workspace)) fail()
      const owner = session(candidates[0]), family = conversations(db, owner)
      if (family.filter(value => value.kind === "main" && value.invocation === "").length !== 1)
        fail()
      const entries = runs.map(run => family.filter(value =>
        value.kind === "child" && value.invocation === run))
      if (entries.some(values => values.length > 1)) fail()
      // Physical creation precedes native conversation admission. An unadmitted leaf must not
      // select a registered ancestor's conversation as its cleanup owner.
      if (!entries[0].length) return { ordinary: true }
      if (entries.some(values => values.length !== 1)) fail()
      return { owner: entries[0][0] }
    }
    // An ordinary internal flow with no canonical ancestor remains the original delete path.
    // A persisted projection, if present, must still join an actual selected owner below.
    if (parentMetadata.isInternalFlowRuntime !== true) return undefined
    if (typeof parentMetadata.workspacePath !== "string" ||
      !isSameWorkspacePath(parentMetadata.workspacePath, workspace)) fail()
    id = parentId
    row = parent
  }
  return fail()
}

function assertOrdinaryChild(db: NativeSqliteAdapter, id: string, original: Thread,
  incarnation: ThreadIncarnation): void {
  const selection = childOwner(db, id, original)
  if (!selection || !("ordinary" in selection)) fail()
  const tables = new Set(query(db, "SELECT name FROM sqlite_master WHERE type='table'")
    .map(row => text(row.name)))
  if (tables.has("thread_messages") && query(db, "PRAGMA table_info(thread_messages)")
    .some(column => column.name === "function_row_json") && query(db, `SELECT 1 FROM thread_messages
      WHERE thread_id=? AND function_row_json IS NOT NULL LIMIT 1`, [id]).length) fail()
  const key = functionConversationProjectionIncarnation(incarnation)
  for (const table of [PROJECTIONS, PRESENTATIONS]) {
    if (tables.has(table) && query(db, `SELECT 1 FROM ${table}
      WHERE thread_id=? AND incarnation=? LIMIT 1`, [id, key]).length) fail()
  }
  if (tables.has("function_conversation_native_destinations") && query(db, `SELECT 1 FROM
    function_conversation_native_destinations WHERE
      (checkpoint_thread_id=? AND checkpoint_incarnation=?) OR
      (destination_thread_id=? AND destination_incarnation=?) LIMIT 1`,
  [id, JSON.stringify(incarnation), id, JSON.stringify(incarnation)]).length) fail()
  if (tables.has(JOURNAL[0]) && query(db, `SELECT 1 FROM function_conversation_fork_imports
    WHERE target_thread_id=? AND target_incarnation=? LIMIT 1`, [id, key]).length) fail()
}

function canonical(db: NativeSqliteAdapter, owner: Conversation, uuid: string): FunctionConversationRow {
  const row = query(db, `SELECT * FROM function_conversation_rows
    WHERE conversation_id=? AND uuid=?`, [owner.id, uuid])[0]
  if (!row) fail()
  const encoded = text(row.payload_json), payload = object(parse(encoded))
  if (hash(encoded) !== row.payload_digest || Buffer.byteLength(encoded) !== integer(row.bytes) ||
    Object.keys(payload).length !== 5 || Object.keys(payload).some(key =>
      !["origin", "message", "nativePayload", "orderAnchor", "inbox"].includes(key)) ||
    typeof payload.inbox !== "boolean") fail()
  const branchId = text(row.branch_id), sequence = integer(row.sequence)
  const next = query(db, "SELECT next_sequence FROM function_conversations WHERE conversation_id=?",
    [owner.id])[0]
  if (!next || !sequence || sequence >= integer(next.next_sequence) ||
    !query(db, `SELECT 1 FROM function_conversation_branches
    WHERE conversation_id=? AND branch_id=?`, [owner.id, branchId]).length) fail()
  // Property order is the original immutable projection receipt's full-row digest contract.
  return { uuid, sequence, receiptId: text(row.receipt_id), branchId,
    inputDigest: text(row.input_digest), door: text(row.door),
    origin: object(payload.origin), message: object(payload.message),
    nativePayload: text(payload.nativePayload), orderAnchor: object(payload.orderAnchor),
    createdAt: integer(row.created_at), inbox: payload.inbox, bytes: integer(row.bytes) }
}

function validateProjection(db: NativeSqliteAdapter, stored: SqlRow, owner: Conversation,
  guard: () => void): ProjectionKey {
  const encoded = text(stored.target_json), target = object(parse(encoded))
  if (Object.keys(target).length !== TARGET_FIELDS.length || Object.keys(target).some(key =>
    !TARGET_FIELDS.includes(key)) || target.logicalSessionId !== owner.session.id ||
    target.conversationId !== owner.id || target.threadId !== owner.session.threadId ||
    target.workspace !== owner.session.workspace || target.incarnation !== owner.session.incarnation ||
    target.kind !== owner.kind || target.checkpointNamespace !== owner.namespace) fail()
  const uuid = text(stored.uuid), row = canonical(db, owner, uuid)
  if (target.branchId !== row.branchId) fail()
  const actualRoot = thread(db, owner.session.threadId)
  if (!actualRoot || functionConversationProjectionIncarnation(captureThreadIncarnation(actualRoot))
    !== owner.session.incarnation) fail("MODS_CONVERSATION_THREAD_CHANGED")
  const ref: FunctionConversationRef = { logicalSessionId: owner.session.id,
    conversationId: owner.id, branchId: row.branchId, threadId: owner.session.threadId,
    workspace: owner.session.workspace, incarnation: captureThreadIncarnation(actualRoot),
    checkpointNamespace: owner.namespace, kind: owner.kind }
  if (JSON.stringify({ ...ref, incarnation: owner.session.incarnation }) !== encoded) fail()
  if (stored.canonical_receipt_id !== row.receiptId ||
    stored.canonical_row_digest !== hash(JSON.stringify(row)) ||
    stored.native_payload_digest !== hash(row.nativePayload)) fail()
  const raw = text(stored.projection_json), columns = object(parse(raw))
  if (hash(raw) !== stored.projection_digest ||
    Object.keys(columns).length !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length ||
    Object.keys(columns).some(key => !FUNCTION_CONVERSATION_PROJECTION_COLUMNS.some(value =>
      value === key)) || Object.values(columns).some(value =>
      !(value === null || typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))))) fail()
  const physical = text(stored.thread_id), inc = text(stored.incarnation)
  const key = parse(inc)
  if (!Array.isArray(key) || key.length !== 2 || JSON.stringify(key) !== inc ||
    (key[0] !== "token" && key[0] !== "legacy")) fail()
  if (key[0] === "token") text(key[1])
  else integer(key[1])
  if (columns.thread_id !== physical || columns.message_id !== uuid) fail()
  const stamp = parse(text(columns.function_row_json))
  validateFunctionConversationTranscriptStamp(stamp)
  if (!sameFunctionConversationTranscriptStamp(stamp,
    functionConversationProjectionStamp(ref, row))) fail()
  const physicalRow = thread(db, physical)
  const matching = physicalRow && functionConversationProjectionIncarnation(
    captureThreadIncarnation(physicalRow)) === inc
  const hasRaw = matching && query(db, `SELECT 1 FROM thread_messages
    WHERE thread_id=? AND message_id=?`, [physical, uuid]).length > 0
  if (hasRaw && physicalRow) {
    readFunctionConversationProjectionReceipt(db, { target: ref, row, threadId: physical,
      incarnation: captureThreadIncarnation(physicalRow), assertCurrent: guard })
    if (query(db, `SELECT 1 FROM thread_message_fragments
      WHERE thread_id=? AND message_id=? LIMIT 1`, [physical, uuid]).length ||
      query(db, `SELECT 1 FROM thread_message_fragment_states
      WHERE thread_id=? AND message_id=? LIMIT 1`, [physical, uuid]).length) fail()
  }
  // The original sealed record is fully validated above. For an old physical incarnation this
  // authenticates only its ledger; it does not claim that the replacement's UI bytes are sealed.
  const recoveryIntegrity = columns.recovery_integrity
  if (recoveryIntegrity !== null && recoveryIntegrity !== 0 && recoveryIntegrity !== 1) fail()
  const presentation = readFunctionConversationPresentationDispositionData(db, {
    threadId: physical, incarnation: inc, uuid, targetJson: encoded,
    canonicalReceiptId: text(stored.canonical_receipt_id),
    canonicalRowDigest: text(stored.canonical_row_digest),
    nativePayloadDigest: text(stored.native_payload_digest),
    projectionDigest: text(stored.projection_digest), orderAnchor: row.orderAnchor,
    role: text(columns.role), door: row.door, messageType: text(row.message.type),
    contentJson: text(columns.content_json), recoveryIntegrity
  })
  return { threadId: physical, incarnation: inc, uuid, removeRaw: Boolean(hasRaw),
    receiptDigest: receiptDigest(stored), presentation, owner }
}

/** Pages keep only exact keys, never a family's native/visible bodies. No source callbacks. */
function scanRetirementKeys(db: NativeSqliteAdapter, table: typeof PROJECTIONS | typeof PRESENTATIONS,
  id: string, incarnation: string, owners: readonly Conversation[], visit: (key: string) => void): void {
  if (!query(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]).length)
    return
  const seen = new Set<string>()
  const scan = (condition: string, args: readonly unknown[]) => {
    let cursor = 0
    while (true) {
      const page = query(db, `SELECT rowid AS cleanup_rowid,thread_id,incarnation,uuid
        FROM ${table} WHERE rowid>? AND (${condition}) ORDER BY rowid LIMIT 64`,
      [cursor, ...args])
      if (!page.length) break
      for (const row of page) {
        const key = projectionKey({ threadId: text(row.thread_id),
          incarnation: text(row.incarnation), uuid: text(row.uuid) })
        if (!seen.has(key)) { visit(key); seen.add(key) }
      }
      cursor = integer(page[page.length - 1].cleanup_rowid)
    }
  }
  scan("thread_id=? AND incarnation=?", [id, incarnation])
  for (const owner of owners) scan(`canonical_receipt_id IN
    (SELECT receipt_id FROM function_conversation_rows WHERE conversation_id=?) OR
    (json_valid(target_json) AND json_extract(target_json,'$.conversationId')=?)`, [owner.id, owner.id])
}

/** Pure data retirement inside the caller's original transaction; all ownership is preflighted. */
export function deleteFunctionConversationThreadDataInTransaction(db: NativeSqliteAdapter,
  input: FunctionConversationCleanupInput): void {
  const id = text(input.threadId), incarnation = Object.freeze({ token: input.incarnation.token,
    legacyCreatedAt: integer(input.incarnation.legacyCreatedAt) })
  const key = functionConversationProjectionIncarnation(incarnation)
  const guard = input.assertCurrent.bind(input)
  let original: Thread | undefined
  const current = () => {
    sync(guard)
    if (!db.inTransaction) fail("MODS_CONVERSATION_TRANSACTION_REQUIRED")
    const row = thread(db, id)
    if (!row || !matchesThreadIncarnation(row, incarnation) ||
      (original && (row.metadata !== original.metadata || row.created_at !== original.created_at)))
      fail("MODS_CONVERSATION_THREAD_CHANGED")
    return row
  }
  original = current()
  const tables = new Set(query(db, "SELECT name FROM sqlite_master WHERE type='table'")
    .map(row => text(row.name)))
  const hasCore = CORE.some(name => tables.has(name)), hasJournal = JOURNAL.some(name => tables.has(name))
  if ((hasCore && CORE.some(name => !tables.has(name))) ||
    (hasJournal && JOURNAL.some(name => !tables.has(name))))
    fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  const physicalReceipts = tables.has(PROJECTIONS) ? query(db, `SELECT thread_id,incarnation,uuid
    FROM ${PROJECTIONS}
    WHERE thread_id=? AND incarnation=?`, [id, key]) : []
  if (physicalReceipts.length && !hasCore) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (hasCore && !tables.has(PROJECTIONS)) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  const own = hasCore ? query(db, `SELECT * FROM function_logical_sessions
    WHERE thread_id=? AND incarnation_key=?`, [id, key]) : []
  if (own.length > 1) fail()
  const family = own.length ? conversations(db, session(own[0])) : []
  if (own.length && family.filter(value => value.kind === "main" && value.invocation === "").length !== 1)
    fail()
  const child = hasCore ? childOwner(db, id, original) : undefined
  if (own.length && child) fail()
  const ordinaryChild = child && "ordinary" in child
  if (ordinaryChild) assertOrdinaryChild(db, id, original, incarnation)
  const selected = child && "owner" in child ? [child.owner] : family
  const byConversation = new Map(selected.map(value => [value.id, value]))
  const receiptKeys: ProjectionKey[] = []
  if (tables.has(PROJECTIONS)) {
    // Load only one conversation's receipt page at a time, never all raw transcript bodies.
    const seen = new Set<string>()
    const validate = (receipt: SqlRow) => {
      const identity = JSON.stringify([receipt.thread_id, receipt.incarnation, receipt.uuid])
      if (seen.has(identity)) return
      const target = object(parse(text(receipt.target_json)))
      const owner = byConversation.get(text(target.conversationId))
      if (!owner) fail()
      receiptKeys.push(validateProjection(db, receipt, owner, current))
      seen.add(identity)
    }
    for (const key of physicalReceipts) {
      const receipt = query(db, `SELECT * FROM ${PROJECTIONS}
        WHERE thread_id=? AND incarnation=? AND uuid=?`,
      [key.thread_id, key.incarnation, key.uuid])[0]
      if (!receipt) fail()
      validate(receipt)
    }
    for (const owner of selected) {
      let cursor = 0
      while (true) {
        const page = query(db, `SELECT p.rowid AS cleanup_rowid,p.* FROM ${PROJECTIONS} p
          LEFT JOIN function_conversation_rows r ON r.receipt_id=p.canonical_receipt_id
          WHERE p.rowid>? AND (r.conversation_id=? OR
            (json_valid(p.target_json) AND json_extract(p.target_json,'$.conversationId')=?))
          ORDER BY p.rowid LIMIT 64`, [cursor, owner.id, owner.id])
        if (!page.length) break
        for (const receipt of page) validate(receipt)
        cursor = integer(page[page.length - 1].cleanup_rowid)
      }
    }
  }
  const byProjection = new Map(receiptKeys.map(value => [projectionKey(value), value]))
  const presentationKeys = new Set<string>()
  scanRetirementKeys(db, PRESENTATIONS, id, key, selected, identity => {
    if (!byProjection.has(identity)) fail()
    presentationKeys.add(identity)
  })
  const journals = tables.has(JOURNAL[0]) ? query(db, `SELECT plan_id,target_json
    FROM function_conversation_fork_imports WHERE target_thread_id=? AND target_incarnation=?`,
  [id, key]) : []
  if (journals.length && !hasCore) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  for (const journal of journals) {
    const target = object(parse(text(journal.target_json)))
    if (Object.keys(target).length !== 4 || target.threadId !== id ||
      typeof target.workspace !== "string" || !target.workspace ||
      typeof target.checkpointNamespace !== "string" ||
      JSON.stringify(target.incarnation) !== JSON.stringify(incarnation)) fail()
    text(journal.plan_id)
  }
  const buckets = new Map<string, { count: number; removed: number }>()
  for (const receipt of receiptKeys) {
    if (!receipt.removeRaw) continue
    const prior = buckets.get(receipt.threadId)
    if (prior) { prior.removed++; continue }
    const bucket = query(db, "SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [receipt.threadId])[0]
    const actual = query(db, "SELECT COUNT(*) AS count,MAX(ordinal) AS maximum FROM thread_messages WHERE thread_id=?",
      [receipt.threadId])[0]
    if (!bucket || !actual || integer(bucket.message_count) !== integer(actual.count) ||
      (actual.maximum !== null && integer(bucket.next_ordinal) <= integer(actual.maximum))) fail()
    buckets.set(receipt.threadId, { count: integer(actual.count), removed: 1 })
  }
  current()
  // There are no awaits or callbacks between this final preflight and the exact deletion plan.
  if (tables.has("function_conversation_native_destinations"))
    assertFunctionConversationNativeDestinationCleanupInTransaction(db, selected.map(owner => owner.id),
      () => { current() })
  // No host callback follows this fresh full-record/ledger tail until the deletion plan completes.
  for (const receipt of receiptKeys) {
    const stored = query(db, `SELECT * FROM ${PROJECTIONS}
      WHERE thread_id=? AND incarnation=? AND uuid=?`,
    [receipt.threadId, receipt.incarnation, receipt.uuid])[0]
    if (!stored || receiptDigest(stored) !== receipt.receiptDigest) fail()
    const latest = validateProjection(db, stored, receipt.owner, () => undefined)
    if (latest.removeRaw !== receipt.removeRaw ||
      latest.presentation.kind !== receipt.presentation.kind ||
      latest.presentation.fingerprint !== receipt.presentation.fingerprint) fail()
  }
  const latestPresentations = new Set<string>()
  scanRetirementKeys(db, PRESENTATIONS, id, key, selected, identity => {
    if (!presentationKeys.has(identity)) fail()
    latestPresentations.add(identity)
  })
  if (latestPresentations.size !== presentationKeys.size) fail()
  const latestProjections = new Set<string>()
  scanRetirementKeys(db, PROJECTIONS, id, key, selected, identity => {
    if (!byProjection.has(identity)) fail()
    latestProjections.add(identity)
  })
  if (latestProjections.size !== byProjection.size) fail()
  if (ordinaryChild) assertOrdinaryChild(db, id, original, incarnation)
  for (const receipt of receiptKeys) {
    if (receipt.removeRaw) {
      db.run("DELETE FROM thread_messages WHERE thread_id=? AND message_id=?",
        [receipt.threadId, receipt.uuid])
    }
    db.run(`DELETE FROM ${PROJECTIONS} WHERE thread_id=? AND incarnation=? AND uuid=?`,
      [receipt.threadId, receipt.incarnation, receipt.uuid])
    if (tables.has(PRESENTATIONS)) {
      db.run(`DELETE FROM ${PRESENTATIONS} WHERE thread_id=? AND incarnation=? AND uuid=?`,
        [receipt.threadId, receipt.incarnation, receipt.uuid])
      if (db.getRowsModified() !== (presentationKeys.has(projectionKey(receipt)) ? 1 : 0)) fail()
    }
  }
  for (const [threadId, bucket] of buckets) db.run(
    "UPDATE thread_message_buckets SET message_count=? WHERE thread_id=?",
    [bucket.count - bucket.removed, threadId])
  for (const owner of selected) {
    if (tables.has("function_conversation_native_destinations"))
      db.run("DELETE FROM function_conversation_native_destinations WHERE conversation_id=?", [owner.id])
    db.run(`DELETE FROM function_conversation_checkpoint_members WHERE receipt_id IN
      (SELECT receipt_id FROM function_conversation_checkpoint_receipts WHERE conversation_id=?)`,
    [owner.id])
    for (const table of ["function_conversation_checkpoint_receipts", "function_conversation_inbox",
      "function_conversation_deliveries", "function_conversation_rows", "function_conversation_branches"])
      db.run(`DELETE FROM ${table} WHERE conversation_id=?`, [owner.id])
    db.run("DELETE FROM function_conversations WHERE conversation_id=?", [owner.id])
  }
  if (own.length) db.run("DELETE FROM function_logical_sessions WHERE logical_session_id=?",
    [session(own[0]).id])
  for (const journal of journals) {
    for (const table of ["function_conversation_fork_rows", "function_conversation_fork_checkpoints"])
      db.run(`DELETE FROM ${table} WHERE plan_id=?`, [journal.plan_id])
    db.run("DELETE FROM function_conversation_fork_imports WHERE plan_id=?", [journal.plan_id])
  }
  current()
  if (ordinaryChild) assertOrdinaryChild(db, id, original, incarnation)
  // A synchronous final guard cannot reinsert a selected ledger and still report retirement.
  scanRetirementKeys(db, PRESENTATIONS, id, key, selected, () => { fail() })
  scanRetirementKeys(db, PROJECTIONS, id, key, selected, () => { fail() })
  for (const receipt of receiptKeys) {
    if (query(db, `SELECT 1 FROM ${PROJECTIONS}
      WHERE thread_id=? AND incarnation=? AND uuid=?`,
    [receipt.threadId, receipt.incarnation, receipt.uuid]).length ||
      tables.has(PRESENTATIONS) && query(db, `SELECT 1 FROM ${PRESENTATIONS}
        WHERE thread_id=? AND incarnation=? AND uuid=?`,
      [receipt.threadId, receipt.incarnation, receipt.uuid]).length) fail()
  }
}
