import { createHash, randomUUID } from "node:crypto"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { isFunctionConversationNotice } from "../../shared/mods/v2/conversation-transcript"
import {
  functionConversationCanonicalStamp,
  functionConversationMembershipDigest,
  functionConversationRowDigest,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCanonicalCut,
  type FunctionConversationCheckpointMembershipProof,
  type FunctionConversationCheckpointMembershipSnapshot
} from "../checkpointer/function-conversation-checkpoint-membership"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import type {
  FunctionConversationRef,
  FunctionConversationRow,
  FunctionConversationStore,
  FunctionConversationTranscriptWriter
} from "./function-conversation-store"
import type { NativeSqliteAdapter, NativeSqliteValue } from "./native-sqlite-adapter"
import { denyFunctionConversationForkReady } from "./function-conversation-fork-gate"
import { assertFunctionConversationForkTranscriptDataTail,
  type FunctionConversationForkTranscriptDataTail } from "./function-conversation-fork-transcript"
export { assertFunctionConversationForkReady } from "./function-conversation-fork-gate"

type Guard = () => void
type SqlRow = Record<string, NativeSqliteValue>
const stores = new WeakMap<FunctionConversationStore, NativeSqliteAdapter>()
const planBrand = Symbol("function-conversation-fork-plan")

export interface FunctionConversationForkPlan { readonly [planBrand]: true }
export interface FunctionConversationForkSource {
  readonly target: FunctionConversationRef
  readonly membership: FunctionConversationCheckpointMembershipProof
}
export interface FunctionConversationForkTarget {
  readonly threadId: string
  readonly workspace: string
  readonly incarnation: ThreadIncarnation
  readonly checkpointNamespace: string
}
export interface FunctionConversationForkEntry {
  readonly sourceIndex: number
  readonly sourceCheckpointId: string
  readonly target: FunctionConversationRef
  readonly frontier: number
  readonly canonicalCut: FunctionConversationCanonicalCut
}
export interface FunctionConversationForkView {
  readonly planId: string
  readonly target: FunctionConversationRef
  readonly branchMap: Readonly<Record<string, string>>
  readonly entries: readonly FunctionConversationForkEntry[]
  readonly selectedSourceIndex: number
  readonly copiedThrough: number
  readonly rowsComplete: boolean
  readonly ready: boolean
}
export interface FunctionConversationForkPageResult {
  readonly copied: number
  readonly copiedThrough: number
  readonly complete: boolean
}

interface Source extends FunctionConversationForkSource {
  readonly snapshot: FunctionConversationCheckpointMembershipSnapshot
  readonly checkpointDataFingerprint: string
  readonly timestamp: number
  readonly members: ReadonlySet<string>
}
interface Branch {
  sourceId: string
  targetId: string
  parentSourceId: string | null
  parentCut: number
  sourceCheckpointId: string | null
  depth: number
}
interface Plan {
  readonly store: FunctionConversationStore
  readonly db: NativeSqliteAdapter
  readonly id: string
  readonly sources: readonly Source[]
  readonly branches: readonly Branch[]
  readonly selected: number
  readonly highWater: number
  readonly sourceDigest: string
  readonly assertSource: Guard
  target?: FunctionConversationForkTarget
  targetGuard?: Guard
  view?: Omit<FunctionConversationForkView, "copiedThrough" | "rowsComplete" | "ready">
  targetJson?: string
  verifyTranscript?: FunctionConversationTranscriptWriter
  transcriptDataTail?: FunctionConversationForkTranscriptDataTail
  closed: boolean
}
const plans = new WeakMap<FunctionConversationForkPlan, Plan>()
const PAGE_ROWS = 64
const PAGE_BYTES = 4 * 1024 * 1024

function fail(code = "MODS_CONVERSATION_FORK_PROOF"): never {
  throw new ModFunctionError(code)
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length) fail()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function incarnationKey(incarnation: ThreadIncarnation): string {
  return JSON.stringify(incarnation.token === null
    ? ["legacy", integer(incarnation.legacyCreatedAt)] : ["token", text(incarnation.token)])
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(values => Object.fromEntries(
    result.columns.map((name, index) => [name, values[index]]))) : []
}
function sync(run: Guard): void {
  const value: unknown = run()
  if (value && typeof (value as { then?: unknown }).then === "function")
    fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
}
function assertThread(db: NativeSqliteAdapter, target: FunctionConversationForkTarget): void {
  const row = query(db, "SELECT created_at,metadata FROM threads WHERE thread_id=?", [target.threadId])[0]
  if (!row || !matchesThreadIncarnation({ created_at: Number(row.created_at),
    metadata: typeof row.metadata === "string" ? row.metadata : null }, target.incarnation))
    fail("MODS_CONVERSATION_THREAD_CHANGED")
}
function decode(row: SqlRow): FunctionConversationRow {
  const payloadJson = text(row.payload_json)
  // The Store digest is SHA256 of the exact encoded payload, not its parsed object.
  if (createHash("sha256").update(payloadJson).digest("hex") !== row.payload_digest ||
    Buffer.byteLength(payloadJson) !== row.bytes) fail("MODS_CONVERSATION_STORE_CORRUPT")
  const payload = JSON.parse(payloadJson) as Record<string, unknown>
  const result = { uuid: text(row.uuid), sequence: integer(row.sequence), receiptId: text(row.receipt_id),
    branchId: text(row.branch_id), inputDigest: text(row.input_digest), door: text(row.door),
    origin: payload.origin, message: payload.message, nativePayload: text(payload.nativePayload),
    // Match the Store's decoded row field order: persisted membership hashes the exact row JSON.
    orderAnchor: payload.orderAnchor, inbox: payload.inbox === true,
    bytes: integer(row.bytes), createdAt: integer(row.created_at) }
  if (!result.sequence || !result.origin || typeof result.origin !== "object" || Array.isArray(result.origin) ||
    !result.message || typeof result.message !== "object" || Array.isArray(result.message) ||
    !result.orderAnchor || typeof result.orderAnchor !== "object" || Array.isArray(result.orderAnchor)) fail()
  return result as FunctionConversationRow
}

/** Only the real Store constructor installs this one-time native database association. */
export function bindFunctionConversationForkStore(store: FunctionConversationStore,
  database: NativeSqliteAdapter): void {
  if (stores.has(store)) fail()
  stores.set(store, database)
}
export function ensureFunctionConversationForkSchema(db: NativeSqliteAdapter): void {
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_fork_imports (
    plan_id TEXT PRIMARY KEY NOT NULL, target_thread_id TEXT NOT NULL,
    target_incarnation TEXT NOT NULL, target_json TEXT NOT NULL, source_digest TEXT NOT NULL,
    source_json TEXT NOT NULL, branch_map_json TEXT NOT NULL,
    selected_source_index INTEGER NOT NULL, copied_through INTEGER NOT NULL DEFAULT 0,
    rows_complete INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('preparing','ready')),
    UNIQUE(target_thread_id,target_incarnation)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_fork_checkpoints (
    plan_id TEXT NOT NULL, source_index INTEGER NOT NULL,
    checkpoint_id TEXT NOT NULL, snapshot_digest TEXT NOT NULL,
    PRIMARY KEY(plan_id,source_index)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_fork_rows (
    plan_id TEXT NOT NULL, sequence INTEGER NOT NULL, uuid TEXT NOT NULL, row_digest TEXT NOT NULL,
    PRIMARY KEY(plan_id,sequence), UNIQUE(plan_id,uuid)
  )`)
}

function actual(plan: FunctionConversationForkPlan): Plan {
  const value = plans.get(plan)
  if (!value || value.closed || stores.get(value.store) !== value.db) fail()
  return value
}
function assertSource(plan: Plan): void {
  sync(plan.assertSource)
  for (const source of plan.sources) {
    const current = readFunctionConversationCheckpointMembership(source.membership, plan.store, source.target)
    if (current.snapshotDigest !== source.snapshot.snapshotDigest ||
      functionConversationMembershipDigest(current) !== functionConversationMembershipDigest(source.snapshot)) fail()
  }
  assertSourceData(plan)
  sync(plan.assertSource)
}
function assertSourceData(plan: Plan): void {
  for (const source of plan.sources) {
    plan.store.assertCheckpointCanonicalCut(source.target, source.snapshot.cut)
    if (sourceCheckpointData(plan.db, source.target, source.snapshot) !==
      source.checkpointDataFingerprint) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  }
  for (const branch of plan.branches) {
    const row = query(plan.db, `SELECT * FROM function_conversation_branches
      WHERE conversation_id=? AND branch_id=?`, [plan.sources[0].target.conversationId, branch.sourceId])[0]
    if (!row || row.parent_branch_id !== branch.parentSourceId || row.parent_frontier !== branch.parentCut ||
      row.source_checkpoint_id !== branch.sourceCheckpointId || row.depth !== branch.depth) fail()
  }
}
function sourceCheckpointData(db: NativeSqliteAdapter, target: FunctionConversationRef,
  snapshot: FunctionConversationCheckpointMembershipSnapshot): string {
  const receipt = query(db, `SELECT * FROM function_conversation_checkpoint_receipts
    WHERE conversation_id=? AND branch_id=? AND checkpoint_thread_id=? AND checkpoint_incarnation=?
    AND checkpoint_namespace=? AND checkpoint_id=?`, [target.conversationId, target.branchId,
    snapshot.checkpointThreadId, snapshot.checkpointIncarnation, snapshot.namespace,
    snapshot.checkpointId])[0]
  const targetJson = JSON.stringify({ logicalSessionId: target.logicalSessionId,
    conversationId: target.conversationId, branchId: target.branchId, threadId: target.threadId,
    workspace: target.workspace, incarnation: incarnationKey(target.incarnation),
    checkpointNamespace: target.checkpointNamespace, kind: target.kind })
  if (!receipt || receipt.target_json !== targetJson || receipt.snapshot_digest !== snapshot.snapshotDigest ||
    receipt.snapshot_json !== JSON.stringify(snapshot)) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  const members = query(db, `SELECT * FROM function_conversation_checkpoint_members
    WHERE receipt_id=? ORDER BY ordinal`, [receipt.receipt_id])
  if (members.length !== snapshot.members.length || members.some((member, index) =>
    member.ordinal !== snapshot.members[index].ordinal || member.uuid !== snapshot.members[index].uuid ||
    member.member_json !== JSON.stringify(snapshot.members[index]))) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  return createHash("sha256").update(JSON.stringify([receipt, members])).digest("hex")
}
function journal(plan: Plan): SqlRow {
  if (!plan.targetGuard) fail()
  sync(plan.targetGuard)
  return journalData(plan)
}
function journalData(plan: Plan): SqlRow {
  if (!plan.target || !plan.targetGuard || !plan.view || !plan.targetJson || plan.closed ||
    stores.get(plan.store) !== plan.db) fail()
  assertThread(plan.db, plan.target)
  const value = query(plan.db, "SELECT * FROM function_conversation_fork_imports WHERE plan_id=?", [plan.id])[0]
  if (!value || value.target_thread_id !== plan.target.threadId ||
    value.target_incarnation !== incarnationKey(plan.target.incarnation) ||
    value.target_json !== plan.targetJson || value.source_digest !== plan.sourceDigest ||
    value.source_json !== JSON.stringify(plan.sources.map(source => source.snapshot)) ||
    value.branch_map_json !== JSON.stringify(plan.view.branchMap) ||
    value.selected_source_index !== plan.selected || !["preparing", "ready"].includes(String(value.status))) fail()
  plan.store.assertCurrent(plan.view.target)
  for (const branch of plan.branches) {
    const row = query(plan.db, `SELECT * FROM function_conversation_branches
      WHERE conversation_id=? AND branch_id=?`, [plan.view.target.conversationId, branch.targetId])[0]
    if (!row || row.parent_branch_id !== (branch.parentSourceId === null ? null : plan.view.branchMap[branch.parentSourceId]) ||
      row.parent_frontier !== branch.parentCut || row.source_checkpoint_id !== branch.sourceCheckpointId ||
      row.depth !== branch.depth) fail()
  }
  return value
}
function assertPlan(plan: Plan): SqlRow {
  assertSource(plan)
  const value = journal(plan)
  sync(plan.targetGuard!)
  return value
}
function assertPlanData(plan: Plan): SqlRow {
  assertSourceData(plan)
  return journalData(plan)
}
function nativeDataTail(plan: Plan,
  expected?: readonly { readonly uuid: string; readonly branchId?: string }[]): void {
  if (!plan.transcriptDataTail) return
  if (!plan.target) fail()
  assertFunctionConversationForkTranscriptDataTail(plan.transcriptDataTail, plan.db, expected,
    { source: plan.sources[0].target.threadId, target: plan.target.threadId })
}

function makeView(plan: Plan, target: FunctionConversationForkTarget, logicalSessionId: string,
  conversationId: string, branchMap: Readonly<Record<string, string>>): NonNullable<Plan["view"]> {
  const ref = (sourceId: string): FunctionConversationRef => Object.freeze({ ...target,
    logicalSessionId, conversationId, branchId: text(branchMap[sourceId]), kind: "main" as const })
  const entries = Object.freeze(plan.sources.map((source, sourceIndex) => Object.freeze({
    sourceIndex, sourceCheckpointId: source.snapshot.checkpointId, target: ref(source.target.branchId),
    frontier: source.snapshot.frontier, canonicalCut: Object.freeze({ highWater: source.snapshot.cut.highWater,
      lineage: Object.freeze(source.snapshot.cut.lineage.map(entry => Object.freeze({
        branchId: text(branchMap[entry.branchId]), cut: entry.cut }))),
      lineageDigest: functionConversationMembershipDigest(source.snapshot.cut.lineage.map(entry => ({
        branchId: text(branchMap[entry.branchId]), cut: entry.cut }))) }) })))
  return Object.freeze({ planId: plan.id, target: entries[plan.selected].target,
    branchMap, entries, selectedSourceIndex: plan.selected })
}

/** Mint while the source's actual Saver/read binding is still live, before closing its scope. */
export function prepareForkImport(store: FunctionConversationStore, input: {
  readonly sources: readonly FunctionConversationForkSource[]
  readonly selectedSourceIndex: number
  readonly assertSource: Guard
}): FunctionConversationForkPlan {
  const db = stores.get(store)
  if (!db || db.inTransaction || !Array.isArray(input.sources) || input.sources.length < 1) fail()
  const selected = integer(input.selectedSourceIndex)
  if (selected >= input.sources.length || typeof input.assertSource !== "function") fail()
  sync(input.assertSource)
  const sources: Source[] = input.sources.map(source => {
    const snapshot = readFunctionConversationCheckpointMembership(source.membership, store, source.target)
    const timestamp = Date.parse(snapshot.checkpointTs)
    if (source.target.kind !== "main" || !Number.isSafeInteger(timestamp) || timestamp < 0) fail()
    return { target: source.target, membership: source.membership, snapshot: structuredClone(snapshot),
      checkpointDataFingerprint: sourceCheckpointData(db, source.target, snapshot),
      timestamp, members: new Set(snapshot.members.map(member => member.uuid)) }
  })
  const first = sources[0].target
  if (sources.some(source => source.target.logicalSessionId !== first.logicalSessionId ||
    source.target.conversationId !== first.conversationId || source.target.threadId !== first.threadId ||
    source.target.workspace !== first.workspace || source.target.checkpointNamespace !== first.checkpointNamespace ||
    incarnationKey(source.target.incarnation) !== incarnationKey(first.incarnation)) ||
    new Set(sources.map(source => source.snapshot.checkpointId)).size !== sources.length) fail()
  const branchIds = new Set(sources.flatMap(source => source.snapshot.cut.lineage.map(entry => entry.branchId)))
  const branches: Branch[] = Array.from(branchIds, sourceId => {
    const row = query(db, `SELECT * FROM function_conversation_branches
      WHERE branch_id=? AND conversation_id=?`, [sourceId, first.conversationId])[0]
    if (!row || (row.parent_branch_id !== null && !branchIds.has(text(row.parent_branch_id)))) fail()
    return { sourceId, targetId: randomUUID(), parentSourceId: row.parent_branch_id === null ? null : text(row.parent_branch_id),
      parentCut: integer(row.parent_frontier), sourceCheckpointId: row.source_checkpoint_id === null
        ? null : text(row.source_checkpoint_id), depth: integer(row.depth) }
  }).sort((a, b) => a.depth - b.depth)
  if (branches.filter(branch => branch.parentSourceId === null).length !== 1) fail()
  const sourceDigest = functionConversationMembershipDigest(sources.map(source => source.snapshot))
  const plan: Plan = { store, db, id: randomUUID(), sources, branches, selected,
    highWater: Math.max(...sources.map(source => source.snapshot.cut.highWater)),
    sourceDigest, assertSource: input.assertSource, closed: false }
  assertSource(plan)
  const token = Object.freeze({ [planBrand]: true as const })
  plans.set(token, plan)
  return token
}

/** Join the actual createThreadInTransaction call. No nested BEGIN or saveToDisk occurs. */
export function beginForkImportInTransaction(token: FunctionConversationForkPlan,
  input: FunctionConversationForkTarget, assertTarget: Guard): void {
  const plan = actual(token), db = plan.db
  if (!db.inTransaction || plan.target || typeof assertTarget !== "function") fail()
  assertSource(plan)
  const target = Object.freeze({ threadId: text(input.threadId), workspace: text(input.workspace),
    incarnation: Object.freeze({ ...input.incarnation }), checkpointNamespace: input.checkpointNamespace })
  if (typeof target.checkpointNamespace !== "string" || target.incarnation.token === null ||
    target.workspace !== plan.sources[0].target.workspace || target.threadId === plan.sources[0].target.threadId)
    fail()
  sync(assertTarget)
  assertThread(db, target)
  if (query(db, "SELECT 1 FROM function_logical_sessions WHERE thread_id=?", [target.threadId]).length ||
    query(db, "SELECT 1 FROM function_conversation_fork_imports WHERE target_thread_id=?", [target.threadId]).length) fail()
  const logicalSessionId = randomUUID(), conversationId = randomUUID()
  const branchMap = Object.freeze(Object.fromEntries(plan.branches.map(branch => [branch.sourceId, branch.targetId])))
  const root = plan.branches.find(branch => branch.parentSourceId === null)!
  const view = makeView(plan, target, logicalSessionId, conversationId, branchMap)
  const targetJson = JSON.stringify(target)
  db.run("INSERT INTO function_logical_sessions VALUES (?,?,?,?)", [logicalSessionId,
    target.threadId, incarnationKey(target.incarnation), target.workspace])
  db.run(`INSERT INTO function_conversations VALUES (?,?,?,?,?,?,?)`, [conversationId,
    logicalSessionId, "main", "", target.checkpointNamespace, root.targetId, plan.highWater + 1])
  for (const branch of plan.branches) db.run("INSERT INTO function_conversation_branches VALUES (?,?,?,?,?,?)", [
    branch.targetId, conversationId, branch.parentSourceId === null ? null : branchMap[branch.parentSourceId],
    branch.parentCut, branch.sourceCheckpointId, branch.depth])
  db.run(`INSERT INTO function_conversation_fork_imports
    (plan_id,target_thread_id,target_incarnation,target_json,source_digest,source_json,branch_map_json,
     selected_source_index,status) VALUES (?,?,?,?,?,?,?,?, 'preparing')`, [plan.id, target.threadId,
    incarnationKey(target.incarnation), targetJson, plan.sourceDigest,
    JSON.stringify(plan.sources.map(source => source.snapshot)), JSON.stringify(branchMap), plan.selected])
  plan.target = target
  plan.targetGuard = assertTarget
  plan.view = view
  plan.targetJson = targetJson
  assertPlan(plan)
}

/** Rebind data-only journal progress to new native source/target proofs; no Hook or write replay. */
export function resumeForkImport(store: FunctionConversationStore, input: {
  readonly sources: readonly FunctionConversationForkSource[]
  readonly selectedSourceIndex: number
  readonly assertSource: Guard
  readonly target: FunctionConversationForkTarget
  readonly assertTarget: Guard
  readonly verifyTranscript: FunctionConversationTranscriptWriter
}): FunctionConversationForkPlan {
  const freshToken = prepareForkImport(store, input), fresh = actual(freshToken)
  const target = Object.freeze({ threadId: text(input.target.threadId), workspace: text(input.target.workspace),
    incarnation: Object.freeze({ ...input.target.incarnation }), checkpointNamespace: input.target.checkpointNamespace })
  sync(input.assertTarget)
  assertThread(fresh.db, target)
  const row = query(fresh.db, `SELECT * FROM function_conversation_fork_imports
    WHERE target_thread_id=? AND target_incarnation=?`, [target.threadId, incarnationKey(target.incarnation)])[0]
  if (!row || row.target_json !== JSON.stringify(target) || row.source_digest !== fresh.sourceDigest ||
    row.source_json !== JSON.stringify(fresh.sources.map(source => source.snapshot)) ||
    row.selected_source_index !== fresh.selected || typeof input.verifyTranscript !== "function") fail()
  const map: unknown = JSON.parse(text(row.branch_map_json))
  if (!map || typeof map !== "object" || Array.isArray(map)) fail()
  const mapping = map as Record<string, unknown>
  if (Object.keys(mapping).length !== fresh.branches.length ||
    fresh.branches.some(branch => typeof mapping[branch.sourceId] !== "string") ||
    new Set(Object.values(mapping)).size !== fresh.branches.length) fail()
  const branchMap = Object.freeze(Object.fromEntries(fresh.branches.map(branch => [branch.sourceId, text(mapping[branch.sourceId])])))
  const metadata = query(fresh.db, `SELECT s.logical_session_id,s.workspace,c.conversation_id,
    c.root_branch_id,c.checkpoint_namespace,c.next_sequence FROM function_logical_sessions s
    JOIN function_conversations c ON c.logical_session_id=s.logical_session_id
    WHERE s.thread_id=? AND s.incarnation_key=? AND c.kind='main' AND c.invocation_id=''`, [
    target.threadId, incarnationKey(target.incarnation)])[0]
  const root = fresh.branches.find(branch => branch.parentSourceId === null)!
  if (!metadata || metadata.workspace !== target.workspace || metadata.checkpoint_namespace !== target.checkpointNamespace ||
    metadata.root_branch_id !== branchMap[root.sourceId] || metadata.next_sequence !== fresh.highWater + 1) fail()
  const resumed: Plan = { ...fresh, id: text(row.plan_id), target, targetGuard: input.assertTarget,
    targetJson: JSON.stringify(target), verifyTranscript: input.verifyTranscript,
    branches: fresh.branches.map(branch => ({ ...branch, targetId: branchMap[branch.sourceId] })) }
  resumed.view = makeView(resumed, target, text(metadata.logical_session_id), text(metadata.conversation_id), branchMap)
  fresh.closed = true
  assertPlan(resumed)
  const token = Object.freeze({ [planBrand]: true as const })
  plans.set(token, resumed)
  return token
}

export function readForkImportView(token: FunctionConversationForkPlan): FunctionConversationForkView {
  const plan = actual(token)
  if (plan.db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  const row = assertPlan(plan)
  return Object.freeze({ ...plan.view!, copiedThrough: integer(row.copied_through),
    rowsComplete: row.rows_complete === 1, ready: row.status === "ready" })
}

/** Native guard only, including within the Store's original ACK transaction; returns no receipt. */
export function assertForkImportCurrent(token: FunctionConversationForkPlan): void {
  assertPlan(actual(token))
}

/** The original plan's complete pure-data tail, after every native source/proof callback. */
export function assertForkImportDataCurrent(token: FunctionConversationForkPlan): void {
  assertPlanData(actual(token))
}

/** The real host binds its original access even for an empty/resumed native import. */
export function bindForkImportTranscriptDataTail(token: FunctionConversationForkPlan,
  tail: FunctionConversationForkTranscriptDataTail): void {
  const plan = actual(token)
  if (plan.transcriptDataTail && plan.transcriptDataTail !== tail) fail()
  assertPlan(plan)
  assertPlanData(plan)
  if (!plan.target) fail()
  assertFunctionConversationForkTranscriptDataTail(tail, plan.db, [],
    { source: plan.sources[0].target.threadId, target: plan.target.threadId })
  plan.transcriptDataTail = tail
}

/** Exact imported row at an authenticated source entry; public UUIDs cannot mint this plan. */
export function readForkImportRow(token: FunctionConversationForkPlan, sourceIndex: number,
  uuid: string): FunctionConversationRow {
  const plan = actual(token), index = integer(sourceIndex)
  if (plan.db.inTransaction || index >= plan.sources.length) fail()
  assertPlan(plan)
  const source = plan.sources[index]
  const original = plan.store.readRowAtCut(source.target, text(uuid), {
    frontier: source.snapshot.cut.highWater }, () => assertPlan(plan))
  if (!source.snapshot.cut.lineage.some(entry => entry.branchId === original.branchId &&
    original.sequence <= entry.cut) || !(source.members.has(uuid) ||
    (original.inbox && original.sequence <= source.snapshot.frontier) ||
    noticeInsideCut(source, original))) fail()
  const raw = query(plan.db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?", [
    plan.view!.target.conversationId, uuid])[0]
  const marker = query(plan.db, "SELECT * FROM function_conversation_fork_rows WHERE plan_id=? AND uuid=?", [plan.id, uuid])[0]
  if (!raw || !marker) fail()
  const kept = decode(raw)
  assertCopied(plan, original, kept)
  if (functionConversationRowDigest(kept) !== marker.row_digest) fail()
  assertPlan(plan)
  return kept
}

function noticeInsideCut(source: Source, row: FunctionConversationRow): boolean {
  return row.createdAt <= source.timestamp && isFunctionConversationNotice({
    function_row: functionConversationCanonicalStamp(source.target, row)
  })
}

function eligible(plan: Plan, row: FunctionConversationRow): boolean {
  return plan.sources.some(source => source.snapshot.cut.lineage.some(entry =>
    entry.branchId === row.branchId && row.sequence <= entry.cut) &&
    (source.members.has(row.uuid) || (row.inbox && row.sequence <= source.snapshot.frontier) ||
      noticeInsideCut(source, row)))
}
function copyRow(plan: Plan, source: FunctionConversationRow): FunctionConversationRow {
  const branchId = plan.view!.branchMap[source.branchId]
  if (!branchId) fail()
  // The canonical serializer strips the host stamp. Its original full native payload is retained.
  return Object.freeze({ ...source, branchId, receiptId: randomUUID() })
}
function payload(row: FunctionConversationRow): string {
  return JSON.stringify({ origin: row.origin, message: row.message, nativePayload: row.nativePayload,
    orderAnchor: row.orderAnchor, inbox: row.inbox })
}
function assertCopied(plan: Plan, source: FunctionConversationRow, copied: FunctionConversationRow): void {
  const raw = query(plan.db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?", [
    plan.view!.target.conversationId, copied.uuid])[0]
  if (!raw || functionConversationRowDigest(decode(raw)) !== functionConversationRowDigest(copied) ||
    copied.branchId !== plan.view!.branchMap[source.branchId] || copied.receiptId === source.receiptId ||
    copied.uuid !== source.uuid || copied.sequence !== source.sequence || copied.inputDigest !== source.inputDigest ||
    copied.door !== source.door || copied.createdAt !== source.createdAt || copied.inbox !== source.inbox ||
    copied.bytes !== source.bytes ||
    raw.payload_json !== payload(source)) fail("MODS_CONVERSATION_FORK_ROW_CONFLICT")
}

/** Each page is a real app SQLite transaction; no whole-conversation array or tail clamp. */
export function copyForkImportPage(token: FunctionConversationForkPlan,
  write: FunctionConversationTranscriptWriter, verify: FunctionConversationTranscriptWriter,
  dataTail?: FunctionConversationForkTranscriptDataTail
): FunctionConversationForkPageResult {
  const plan = actual(token), db = plan.db
  if (db.inTransaction || typeof write !== "function" || typeof verify !== "function") fail()
  if (plan.transcriptDataTail && dataTail !== plan.transcriptDataTail) fail()
  if (dataTail) {
    if (!plan.target || plan.transcriptDataTail !== undefined && plan.transcriptDataTail !== dataTail) fail()
    assertFunctionConversationForkTranscriptDataTail(dataTail, db, [],
      { source: plan.sources[0].target.threadId, target: plan.target!.threadId })
    plan.transcriptDataTail = dataTail
  }
  const prior = assertPlan(plan)
  if (prior.status !== "preparing") fail()
  plan.verifyTranscript = verify
  const cursor = integer(prior.copied_through)
  if (prior.rows_complete === 1) {
    if (plan.transcriptDataTail) {
      verifyForkRows(plan, true)
      assertPlan(plan)
      verifyForkRows(plan, false)
    }
    assertPlanData(plan)
    nativeDataTail(plan)
    return { copied: 0, copiedThrough: cursor, complete: true }
  }
  const cuts = plan.sources.flatMap(source => source.snapshot.cut.lineage)
  const raw = query(db, `SELECT * FROM function_conversation_rows
    WHERE conversation_id=? AND sequence>? AND (${cuts.map(() => "(branch_id=? AND sequence<=?)").join(" OR ")})
    ORDER BY sequence LIMIT ?`, [plan.sources[0].target.conversationId, cursor,
    ...cuts.flatMap(entry => [entry.branchId, entry.cut]), PAGE_ROWS])
  const selected: Array<{ raw: SqlRow; source: FunctionConversationRow; copied: FunctionConversationRow }> = []
  let through = cursor, bytes = 0, stopped = false
  for (const original of raw) {
    const row = decode(original)
    if (eligible(plan, row)) {
      if (selected.length > 0 && bytes + row.bytes > PAGE_BYTES) { stopped = true; break }
      selected.push({ raw: original, source: row, copied: copyRow(plan, row) })
      bytes += row.bytes
    }
    through = row.sequence
  }
  const complete = !stopped && raw.length < PAGE_ROWS
  assertPlan(plan)
  const verifyPage = () => {
    const current = assertPlan(plan)
    if (current.copied_through !== through || current.rows_complete !== Number(complete)) fail()
    for (const entry of selected) {
      assertCopied(plan, entry.source, entry.copied)
      sync(() => verify(db, Object.freeze({ ...plan.view!.target, branchId: entry.copied.branchId }), entry.copied))
    }
    assertPlan(plan)
    const final = assertPlanData(plan)
    if (final.copied_through !== through || final.rows_complete !== Number(complete)) fail()
    for (const entry of selected) {
      const sourceRaw = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
        [plan.sources[0].target.conversationId, entry.source.uuid])[0]
      const copiedRaw = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
        [plan.view!.target.conversationId, entry.copied.uuid])[0]
      if (!sourceRaw || !copiedRaw || JSON.stringify(sourceRaw) !== JSON.stringify(entry.raw)) fail()
      const source = decode(sourceRaw), copied = decode(copiedRaw)
      assertCopied(plan, source, copied)
      const marker = query(db, "SELECT * FROM function_conversation_fork_rows WHERE plan_id=? AND uuid=?",
        [plan.id, copied.uuid])[0]
      if (!marker || marker.sequence !== copied.sequence ||
        marker.row_digest !== functionConversationRowDigest(copied)) fail()
    }
    nativeDataTail(plan, selected.map(entry => ({ uuid: entry.copied.uuid, branchId: entry.copied.branchId })))
  }
  let attempted = false
  db.run("BEGIN IMMEDIATE")
  try {
    const current = assertPlan(plan)
    if (current.copied_through !== cursor || current.rows_complete !== 0 || current.status !== "preparing") fail()
    for (const entry of selected) {
      const sourceNow = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?", [
        plan.sources[0].target.conversationId, entry.source.uuid])[0]
      if (!sourceNow || JSON.stringify(sourceNow) !== JSON.stringify(entry.raw)) fail()
      const encoded = payload(entry.copied)
      db.run("INSERT INTO function_conversation_rows VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        plan.view!.target.conversationId, entry.copied.uuid, entry.copied.branchId, entry.copied.sequence,
        entry.copied.receiptId, entry.copied.inputDigest, entry.raw.payload_digest, encoded,
        entry.copied.door, entry.copied.createdAt, Buffer.byteLength(encoded)])
      const target = Object.freeze({ ...plan.view!.target, branchId: entry.copied.branchId })
      sync(() => write(db, target, entry.copied))
      sync(() => verify(db, target, entry.copied))
      db.run("INSERT INTO function_conversation_fork_rows VALUES (?,?,?,?)", [
        plan.id, entry.copied.sequence, entry.copied.uuid, functionConversationRowDigest(entry.copied)])
    }
    db.run(`UPDATE function_conversation_fork_imports SET copied_through=?,rows_complete=?
      WHERE plan_id=? AND status='preparing' AND copied_through=? AND rows_complete=0`, [
      through, Number(complete), plan.id, cursor])
    if (db.getRowsModified() !== 1) fail()
    verifyPage()
    attempted = true
    db.run("COMMIT")
  } catch (error) {
    try { db.run("ROLLBACK") } catch { /* Unknown commit: exact verification only, never replay. */ }
    if (!attempted || db.inTransaction) throw error
    try { verifyPage() } catch { throw error }
  }
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  verifyPage()
  return Object.freeze({ copied: selected.length, copiedThrough: through, complete })
}

/** Called within the actual target Saver observer/read scope. It cannot copy a source ACK. */
export function recordForkImportCheckpoint(token: FunctionConversationForkPlan, sourceIndex: number,
  proof: FunctionConversationCheckpointMembershipProof): void {
  const plan = actual(token), row = assertPlan(plan), index = integer(sourceIndex)
  if (row.rows_complete !== 1 || row.status !== "preparing" || index >= plan.sources.length) fail()
  const entry = plan.view!.entries[index], source = plan.sources[index].snapshot
  const targetSnapshot = readFunctionConversationCheckpointMembership(proof, plan.store, entry.target)
  const check = () => {
    assertPlan(plan)
    const actualSnapshot = readFunctionConversationCheckpointMembership(proof, plan.store, entry.target)
    if (actualSnapshot !== targetSnapshot || actualSnapshot.checkpointId !== source.checkpointId ||
      actualSnapshot.checkpointThreadId !== plan.target!.threadId ||
      actualSnapshot.checkpointIncarnation !== incarnationKey(plan.target!.incarnation) ||
      actualSnapshot.namespace !== plan.target!.checkpointNamespace ||
      actualSnapshot.frontier !== source.frontier || actualSnapshot.checkpointTs !== source.checkpointTs ||
      actualSnapshot.nativeSnapshotDigest !== source.nativeSnapshotDigest ||
      actualSnapshot.nativeMessageCount !== source.nativeMessageCount ||
      actualSnapshot.members.length !== source.members.length ||
      actualSnapshot.members.some((member, offset) => {
        const original = source.members[offset]
        return member.ordinal !== original.ordinal || member.uuid !== original.uuid ||
          member.sequence !== original.sequence || member.branchId !== plan.view!.branchMap[original.branchId] ||
          member.nativeDigest !== original.nativeDigest || member.rowReceiptId === original.rowReceiptId
      })) fail("MODS_CONVERSATION_FORK_CHECKPOINT_CONFLICT")
  }
  check()
  const state = { version: 1, logicalSessionId: entry.target.logicalSessionId,
    conversationId: entry.target.conversationId, branchId: entry.target.branchId, frontier: source.frontier }
  const generation = functionConversationMembershipDigest({ id: targetSnapshot.checkpointId,
    ts: targetSnapshot.checkpointTs, state, thread: plan.target!.threadId,
    namespace: entry.target.checkpointNamespace, membership: targetSnapshot.snapshotDigest })
  const delivery = plan.store.captureCheckpointDelivery(entry.target, { checkpointId: source.checkpointId,
    generation, frontier: source.frontier }, check)
  plan.store.recordCheckpointDelivery(entry.target, delivery, check, proof, database => {
    if (database !== plan.db) fail()
    const previous = query(database, "SELECT * FROM function_conversation_fork_checkpoints WHERE plan_id=? AND source_index=?", [plan.id, index])[0]
    if (previous && (previous.checkpoint_id !== source.checkpointId ||
      previous.snapshot_digest !== targetSnapshot.snapshotDigest)) fail()
    if (!previous) database.run("INSERT INTO function_conversation_fork_checkpoints VALUES (?,?,?,?)", [
      plan.id, index, source.checkpointId, targetSnapshot.snapshotDigest])
    check()
  })
}

function verifyForkRows(plan: Plan, callbacks: boolean): void {
  const db = plan.db
  if (!plan.verifyTranscript) fail()
  let sequence = 0
  for (;;) {
    const page = query(db, "SELECT * FROM function_conversation_fork_rows WHERE plan_id=? AND sequence>? ORDER BY sequence LIMIT ?", [plan.id, sequence, PAGE_ROWS])
    for (const marker of page) {
      const raw = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?", [
        plan.view!.target.conversationId, marker.uuid])[0]
      if (!raw) fail()
      const kept = decode(raw)
      if (kept.sequence !== marker.sequence || functionConversationRowDigest(kept) !== marker.row_digest) fail()
      const sourceRaw = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?", [
        plan.sources[0].target.conversationId, kept.uuid])[0]
      if (!sourceRaw) fail()
      const source = decode(sourceRaw)
      if (!eligible(plan, source)) fail()
      assertCopied(plan, source, kept)
      for (const entry of plan.sources) {
        const member = entry.snapshot.members.find(member => member.uuid === source.uuid)
        if (member && member.rowDigest !== functionConversationRowDigest(source)) fail()
      }
      if (callbacks) sync(() => plan.verifyTranscript!(db,
        Object.freeze({ ...plan.view!.target, branchId: kept.branchId }), kept))
      else nativeDataTail(plan, [{ uuid: kept.uuid, branchId: kept.branchId }])
      sequence = kept.sequence
    }
    if (page.length < PAGE_ROWS) break
  }
  // A forged/damaged progress flag is not proof that compacted notes or notices were copied.
  const cuts = plan.sources.flatMap(source => source.snapshot.cut.lineage)
  let sourceSequence = 0
  for (;;) {
    const page = query(db, `SELECT * FROM function_conversation_rows WHERE conversation_id=?
      AND sequence>? AND (${cuts.map(() => "(branch_id=? AND sequence<=?)").join(" OR ")})
      ORDER BY sequence LIMIT ?`, [plan.sources[0].target.conversationId, sourceSequence,
      ...cuts.flatMap(entry => [entry.branchId, entry.cut]), PAGE_ROWS])
    for (const raw of page) {
      const source = decode(raw)
      sourceSequence = source.sequence
      if (!eligible(plan, source)) continue
      const marker = query(db, "SELECT * FROM function_conversation_fork_rows WHERE plan_id=? AND uuid=?", [plan.id, source.uuid])[0]
      const target = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?", [
        plan.view!.target.conversationId, source.uuid])[0]
      if (!marker || !target) fail()
      const kept = decode(target)
      if (functionConversationRowDigest(kept) !== marker.row_digest) fail()
      assertCopied(plan, source, kept)
    }
    if (page.length < PAGE_ROWS) break
  }
  if (query(db, `SELECT 1 FROM function_conversation_rows r WHERE conversation_id=?
    AND NOT EXISTS (SELECT 1 FROM function_conversation_fork_rows f WHERE f.plan_id=?
      AND f.uuid=r.uuid AND f.sequence=r.sequence) LIMIT 1`, [plan.view!.target.conversationId, plan.id]).length ||
    query(db, "SELECT 1 FROM function_conversation_inbox WHERE conversation_id=? LIMIT 1", [plan.view!.target.conversationId]).length) fail()
}

/** All imported rows and exact target checkpoint receipts must exist before clearing the gate. */
export function finishForkImport(token: FunctionConversationForkPlan,
  selectedProof: FunctionConversationCheckpointMembershipProof): void {
  const plan = actual(token), db = plan.db
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  const checkpoints = query(db, "SELECT * FROM function_conversation_fork_checkpoints WHERE plan_id=? ORDER BY source_index", [plan.id])
  // Pin the actual full receipt/index rows before BEGIN, then compare under its write lock.
  const pinned: Array<{ sql: string; args: unknown[]; json: string }> = []
  const check = () => {
    const row = assertPlan(plan)
    if (row.rows_complete !== 1) fail()
    if (checkpoints.length !== plan.sources.length || checkpoints.some((entry, index) =>
      entry.source_index !== index || entry.checkpoint_id !== plan.sources[index].snapshot.checkpointId)) fail()
    const selected = readFunctionConversationCheckpointMembership(selectedProof, plan.store, plan.view!.target)
    if (selected.snapshotDigest !== checkpoints[plan.selected].snapshot_digest) fail()
    for (const checkpoint of checkpoints) {
      const entry = plan.view!.entries[Number(checkpoint.source_index)]
      const stored = plan.store.readCheckpointRecoverySnapshot(entry.target, {
        checkpointThreadId: plan.target!.threadId, checkpointIncarnation: plan.target!.incarnation,
        checkpointId: String(checkpoint.checkpoint_id) }, () => assertPlan(plan))
      if (stored.snapshot.snapshotDigest !== checkpoint.snapshot_digest) fail()
    }
    verifyForkRows(plan, true)
    assertPlan(plan)
  }
  // The full reads above require committed data, and are completed before the synchronous CAS.
  check()
  for (const checkpoint of checkpoints) {
    const entry = plan.view!.entries[Number(checkpoint.source_index)]
    const sql = `SELECT * FROM function_conversation_checkpoint_receipts WHERE conversation_id=?
      AND branch_id=? AND checkpoint_thread_id=? AND checkpoint_incarnation=? AND checkpoint_namespace=? AND checkpoint_id=?`
    const args = [entry.target.conversationId, entry.target.branchId, plan.target!.threadId,
      incarnationKey(plan.target!.incarnation), plan.target!.checkpointNamespace, checkpoint.checkpoint_id]
    const receipt = query(db, sql, args)
    pinned.push({ sql, args, json: JSON.stringify(receipt) })
    if (receipt.length !== 1) fail()
    const memberSql = "SELECT * FROM function_conversation_checkpoint_members WHERE receipt_id=? ORDER BY ordinal"
    const memberArgs = [receipt[0].receipt_id]
    pinned.push({ sql: memberSql, args: memberArgs, json: JSON.stringify(query(db, memberSql, memberArgs)) })
  }
  const finalData = () => {
    const row = assertPlanData(plan)
    if (row.rows_complete !== 1 ||
      JSON.stringify(query(db, "SELECT * FROM function_conversation_fork_checkpoints WHERE plan_id=? ORDER BY source_index",
        [plan.id])) !== JSON.stringify(checkpoints)) fail()
    for (const capture of pinned) if (JSON.stringify(query(db, capture.sql, capture.args)) !== capture.json) fail()
    verifyForkRows(plan, false)
    // Includes ordinary visible copies recorded by this same access, as well as canonical rows.
    nativeDataTail(plan)
    return row
  }
  const prior = assertPlan(plan)
  const fresh = finalData()
  if (fresh.status !== prior.status) fail()
  if (prior.status === "ready") return
  db.run("BEGIN IMMEDIATE")
  try {
    assertPlan(plan)
    if (JSON.stringify(query(db, "SELECT * FROM function_conversation_fork_checkpoints WHERE plan_id=? ORDER BY source_index", [plan.id])) !== JSON.stringify(checkpoints)) fail()
    for (const capture of pinned) if (JSON.stringify(query(db, capture.sql, capture.args)) !== capture.json) fail()
    verifyForkRows(plan, true)
    readFunctionConversationCheckpointMembership(selectedProof, plan.store, plan.view!.target)
    assertPlan(plan)
    if (finalData().status !== "preparing") fail()
    db.run("UPDATE function_conversation_fork_imports SET status='ready' WHERE plan_id=? AND status='preparing'", [plan.id])
    if (db.getRowsModified() !== 1) fail()
    if (journalData(plan).status !== "ready") fail()
    db.run("COMMIT")
  } catch (error) {
    try { db.run("ROLLBACK") } catch { /* Keep the preparing gate unless exact ready data is durable. */ }
    if (db.inTransaction) throw error
    try {
      check()
      if (finalData().status !== "ready") throw error
    } catch { throw error }
  }
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  check()
  if (finalData().status !== "ready") fail()
}

/**
 * Revoke this exact target even after Source authority has expired. This is not a Saver close
 * receipt: actual backend work remains owned by the host until its true finally.
 */
export function quarantineForkImport(token: FunctionConversationForkPlan): void {
  const plan = plans.get(token)
  if (!plan || stores.get(plan.store) !== plan.db) fail()
  if (!plan.target) { plan.closed = true; return }
  const { db, target } = plan
  assertThread(db, target)
  denyFunctionConversationForkReady(db, target)
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  const check = (): SqlRow => {
    assertThread(db, target)
    if (!plan.view || !plan.targetJson) fail()
    const row = query(db, "SELECT * FROM function_conversation_fork_imports WHERE plan_id=?", [plan.id])[0]
    if (!row || row.target_thread_id !== target.threadId ||
      row.target_incarnation !== incarnationKey(target.incarnation) ||
      row.target_json !== plan.targetJson || row.source_digest !== plan.sourceDigest ||
      row.source_json !== JSON.stringify(plan.sources.map(source => source.snapshot)) ||
      row.branch_map_json !== JSON.stringify(plan.view.branchMap) ||
      row.selected_source_index !== plan.selected ||
      !["preparing", "ready"].includes(String(row.status))) fail()
    return row
  }
  check()
  let commitAttempted = false
  try {
    db.run("BEGIN IMMEDIATE")
    const prior = check()
    db.run(`UPDATE function_conversation_fork_imports SET status='preparing'
      WHERE plan_id=? AND status=?`, [plan.id, prior.status])
    if (db.getRowsModified() !== 1 || check().status !== "preparing") fail()
    commitAttempted = true
    db.run("COMMIT")
  } catch (error) {
    try { db.run("ROLLBACK") } catch { /* Keep the native denied marker on uncertain durability. */ }
    if (!commitAttempted || db.inTransaction) throw error
    try { if (check().status !== "preparing") throw error } catch { throw error }
  }
  if (db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  if (check().status !== "preparing") fail()
}

/** Retire native admission only. The host quarantines a begun import before calling this. */
export function abortForkImport(token: FunctionConversationForkPlan): void {
  const plan = plans.get(token)
  if (!plan) fail()
  plan.closed = true
}

/** Root has removed this exact target's external files and app rows in its cleanup transaction. */
export function clearForkImportJournalInTransaction(token: FunctionConversationForkPlan,
  assertFilesRetired: Guard): void {
  const plan = plans.get(token)
  if (!plan || !plan.target || !plan.targetJson || !plan.db.inTransaction ||
    stores.get(plan.store) !== plan.db || typeof assertFilesRetired !== "function") fail()
  const target = plan.target
  const assertRetired = () => {
    if (!plan.db.inTransaction ||
      query(plan.db, "SELECT 1 FROM threads WHERE thread_id=?", [target.threadId]).length ||
      query(plan.db, "SELECT 1 FROM function_logical_sessions WHERE thread_id=?", [target.threadId]).length)
      fail()
    if (query(plan.db, `SELECT 1 FROM sqlite_master WHERE type='table'
      AND name='function_conversation_presentation_dispositions'`).length && query(plan.db,
      `SELECT 1 FROM function_conversation_presentation_dispositions
        WHERE thread_id=? AND incarnation=? LIMIT 1`,
      [target.threadId, incarnationKey(target.incarnation)]).length) fail()
  }
  sync(assertFilesRetired)
  assertRetired()
  const row = query(plan.db, "SELECT * FROM function_conversation_fork_imports WHERE plan_id=?", [plan.id])[0]
  if (row && (row.target_thread_id !== plan.target.threadId ||
    row.target_incarnation !== incarnationKey(plan.target.incarnation) ||
    row.target_json !== plan.targetJson || row.source_digest !== plan.sourceDigest)) fail()
  plan.db.run("DELETE FROM function_conversation_fork_checkpoints WHERE plan_id=?", [plan.id])
  plan.db.run("DELETE FROM function_conversation_fork_rows WHERE plan_id=?", [plan.id])
  plan.db.run("DELETE FROM function_conversation_fork_imports WHERE plan_id=?", [plan.id])
  sync(assertFilesRetired)
  assertRetired()
  plan.closed = true
}
