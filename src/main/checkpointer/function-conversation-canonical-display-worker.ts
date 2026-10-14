import { createHash } from "node:crypto"
import { types } from "node:util"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from
  "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ModObject } from "../../shared/mods/types"
import { hasInvalidFunctionConversationTranscriptStamp, readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import { captureNativeMessageForOccurrence, constructCapturedNativeMessage } from
  "../agent/native-message-capture-data"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import type { FunctionConversationRef, FunctionConversationRow } from "../db/function-conversation-store"
import { assertStoredProjectionReceipt } from "../db/function-conversation-projection-seal"
import { withFunctionConversationProjectionReadScope,
  readSealedFunctionConversationProjectionPresentation,
  type FunctionConversationProjectionSealInput } from "../db/function-conversation-projection-read"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, functionConversationProjectionStamp,
  type FunctionConversationProjectionColumns } from "../db/function-conversation-projection-receipt"
import { NativeSqliteAdapter, type NativeSqliteValue } from "../db/native-sqlite-adapter"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import type { FunctionConversationCheckpointMembershipSnapshot } from
  "./function-conversation-checkpoint-membership"

/** Both reads belong to this original full-seal scope; the Worker owns its readonly transaction. */
export function readCanonicalDisplayProjection(db: NativeSqliteAdapter,
  input: FunctionConversationProjectionSealInput) {
  return withFunctionConversationProjectionReadScope(db, scope => {
    const columns = assertStoredProjectionReceipt(db, input, scope)
    const presentation = readSealedFunctionConversationProjectionPresentation(db, scope, columns)
    return { columns, presentation }
  })
}

/** Native request selection. This data alone is never a Main-process publication capability. */
export interface CanonicalCheckpointDisplaySelection {
  readonly messageDatabasePath: string
  readonly threadId: string
  readonly workspace: string
  readonly incarnation: ThreadIncarnation
  readonly checkpointId: string
}
export interface CanonicalCheckpointDisplayContext {
  readonly checkpointId: string
  readonly namespace: string
  readonly checkpointTs: string
  readonly parentCheckpointId: string | null
  readonly state: unknown
}
export interface CanonicalCheckpointDisplayMembershipWitness {
  readonly conversationId: string
  readonly branchId: string
  readonly threadId: string
  readonly incarnation: string
  readonly namespace: string
  readonly checkpointId: string
  readonly stateJson: string
  readonly fingerprint: string
}
export interface CanonicalCheckpointDisplayOmissions {
  readonly count: number
  readonly digest: string
}

/** Small streaming evidence only. Its caller must authenticate every row and its real ordinal. */
export function createCanonicalCheckpointDisplayOmissionDigest() {
  const digest = createHash("sha256").update("[")
  let count = 0, closed = false
  return {
    append(rawIndex: number, uuid: string, columnsDigest: string,
      presentation: { readonly kind: "visible" | "blank" | "plumbing"; readonly fingerprint: string }) {
      if (closed || !Number.isSafeInteger(rawIndex) || rawIndex < 0 || !uuid ||
        presentation.kind === "visible") fail()
      if (count) digest.update(",")
      digest.update(JSON.stringify([rawIndex, uuid, columnsDigest, presentation.kind,
        presentation.fingerprint]))
      count++
    },
    finish(): CanonicalCheckpointDisplayOmissions {
      if (closed) fail()
      closed = true
      return Object.freeze({ count, digest: digest.update("]").digest("hex") })
    }
  }
}

/** Exact persisted native membership evidence; no source callback or authority is minted. */
export function canonicalCheckpointDisplayMembershipFingerprint(db: NativeSqliteAdapter,
  witness: Omit<CanonicalCheckpointDisplayMembershipWitness, "fingerprint" | "stateJson">): string {
  const receipts = query(db, `SELECT receipt_id,target_json,snapshot_digest,snapshot_json
    FROM function_conversation_checkpoint_receipts
    WHERE conversation_id=? AND branch_id=? AND checkpoint_thread_id=?
    AND checkpoint_incarnation=? AND checkpoint_namespace=? AND checkpoint_id=?`,
  [witness.conversationId, witness.branchId, witness.threadId,
    witness.incarnation, witness.namespace, witness.checkpointId])
  if (receipts.length !== 1) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  const receipt = receipts[0], digest = createHash("sha256").update("[")
  let cursor = -1, count = 0
  for (;;) {
    const members = query(db, `SELECT ordinal,uuid,member_json FROM function_conversation_checkpoint_members
      WHERE receipt_id=? AND ordinal>? ORDER BY ordinal LIMIT 64`, [receipt.receipt_id, cursor])
    if (!members.length) break
    for (const member of members) {
      if (count++) digest.update(",")
      digest.update(JSON.stringify({ ...receipt, ...member }))
    }
    cursor = integer(members[members.length - 1].ordinal)
  }
  // Preserve the exact old LEFT JOIN digest, including its one NULL-member row for an empty CP.
  if (!count) digest.update(JSON.stringify({ ...receipt, ordinal: null, uuid: null, member_json: null }))
  return digest.update("]").digest("hex")
}
type SqlRow = Record<string, NativeSqliteValue>
function fail(code = "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"): never {
  throw new ModFunctionError(code)
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }
// Same persisted data digest as membership.ts; importing its Saver capability into a Worker
// would pull the Main worker factory into the isolated reader. Real Saver golden tests pin it.
function functionConversationMembershipDigest(value: unknown): string { return hash(JSON.stringify(value)) }
function functionConversationRowDigest(value: FunctionConversationRow): string {
  return functionConversationMembershipDigest(value)
}
export function canonicalDisplayColumnsDigest(columns: FunctionConversationProjectionColumns): string {
  return hash(JSON.stringify(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key => columns[key])))
}
/** A pure, descriptor-only tail fingerprint for a native Worker DTO, including real Dates. */
export function canonicalDisplayValueDigest(value: unknown): string {
  return canonicalValueDigest(value, false)
}

const humanPrototype = HumanMessage.prototype, aiPrototype = AIMessage.prototype
const systemPrototype = SystemMessage.prototype, toolPrototype = ToolMessage.prototype
const nativeMessageSymbol = Symbol.for("langchain.message")

/** Checkpoint control channels can contain actual SDK messages inside a queued model task. */
export function canonicalCheckpointValueDigest(value: unknown): string {
  return canonicalValueDigest(value, true)
}

function canonicalValueDigest(value: unknown, nativeMessages: boolean): string {
  type Task = { kind: "value"; value: unknown } | { kind: "exit"; object: object }
  const digest = createHash("sha256"), tasks: Task[] = [{ kind: "value", value }]
  const ancestors = new WeakSet<object>()
  let expanded = 1
  while (tasks.length) {
    const task = tasks.pop()
    if (!task) fail()
    if (task.kind === "exit") { ancestors.delete(task.object); continue }
    const current = task.value
    if (current === null || typeof current === "string" || typeof current === "boolean" ||
      typeof current === "number" && Number.isFinite(current) || current === undefined) {
      digest.update(`${typeof current}:${JSON.stringify(current)};`)
      continue
    }
    if (!current || typeof current !== "object" || types.isProxy(current) || ancestors.has(current)) fail()
    const prototype = Object.getPrototypeOf(current)
    if (prototype === Date.prototype) {
      if (Reflect.ownKeys(current).length) fail()
      const time = Date.prototype.getTime.call(current)
      if (!Number.isFinite(time)) fail()
      digest.update(`date:${time};`)
      continue
    }
    const array = Array.isArray(current)
    const nativeType = nativeMessages ? prototype === humanPrototype ? "human" :
      prototype === aiPrototype ? "ai" : prototype === systemPrototype ? "system" :
      prototype === toolPrototype ? "tool" : undefined : undefined
    if (array ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null && nativeType === undefined) fail()
    if (nativeType !== undefined) {
      // Validate typed data without invoking message methods; still visit every own field below.
      captureNativeMessageForOccurrence(current as BaseMessage, "checkpoint-control-digest")
    }
    ancestors.add(current)
    tasks.push({ kind: "exit", object: current })
    const keys = Reflect.ownKeys(current), values: unknown[] = []
    digest.update(nativeType === undefined ? array ? "array;" : "object;" : `native:${nativeType};`)
    for (const key of keys) {
      if (typeof key !== "string" && (nativeType === undefined || key !== nativeMessageSymbol)) fail()
      const field = Object.getOwnPropertyDescriptor(current, key)
      if (!field || !("value" in field)) fail()
      if (typeof key === "symbol" && field.value !== true) fail()
      digest.update(typeof key === "symbol" ? "native-message-symbol;" : JSON.stringify(key))
      values.push(field.value)
    }
    if (expanded + values.length > 1_000_000) fail()
    expanded += values.length
    digest.update(`${values.length};`)
    for (let index = values.length - 1; index >= 0; index--)
      tasks.push({ kind: "value", value: values[index] })
  }
  return digest.digest("hex")
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail()
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) fail()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function modObject(value: unknown): ModObject {
  // This value is parsed from the digest-checked canonical JSON row, never from a guest object.
  return object(value) as ModObject
}
function query(db: NativeSqliteAdapter, sql: string, values: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, values)[0]
  return result ? result.values.map(row => Object.fromEntries(result.columns.map(
    (key, index) => [key, row[index]]))) : []
}

/** Reject executable structure before inspecting a stored constructor envelope. */
export function copyCanonicalCheckpointDisplayJson(raw: unknown, guard: () => void): unknown {
  const box: { value?: unknown } = {}
  const tasks: Array<{ value: unknown; assign(value: unknown): void }> = [
    { value: raw, assign: value => { box.value = value } }
  ]
  const seen = new WeakSet<object>()
  let expanded = 1
  while (tasks.length) {
    guard()
    const task = tasks.pop()
    if (!task) fail()
    const value = task.value
    if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value)) {
      task.assign(value)
      continue
    }
    if (!value || typeof value !== "object" || types.isProxy(value) || seen.has(value)) fail()
    seen.add(value)
    const arrayValue = Array.isArray(value) ? value : undefined
    const array = arrayValue !== undefined, prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      fail()
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) fail()
    const fields = keys.flatMap(key => {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field || !("value" in field)) fail()
      if (array && key === "length") return []
      if (!field.enumerable || array && (typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (arrayValue?.length ?? 0))) fail()
      return [{ key, value: field.value }]
    })
    const count = arrayValue ? arrayValue.length : fields.length
    if (expanded + count > 1_000_000 || array && fields.length !== count) fail()
    expanded += count
    const output: Record<string, unknown> | unknown[] = array ? new Array(count) : Object.create(null)
    task.assign(output)
    // Preserve the native serializer's original object-key order. LIFO traversal must only
    // fill existing data fields, otherwise nested metadata and lc_kwargs serialize backwards.
    for (const field of fields) Object.defineProperty(output, field.key, {
      value: undefined, enumerable: true, configurable: true, writable: true
    })
    for (const field of fields) tasks.push({ value: field.value, assign: copied => {
      Object.defineProperty(output, field.key, { value: copied, enumerable: true,
        configurable: true, writable: true })
    } })
  }
  return box.value
}

/** Only descriptor-safe JSON read by the native SQLite iterator reaches a native constructor. */
function nativeCopy(raw: unknown, guard: () => void): BaseMessage {
  const record = object(copyCanonicalCheckpointDisplayJson(raw, guard))
  let type: unknown = record.type, data: Record<string, unknown>
  if (type === "constructor") {
    if (record.lc !== 1 || !Array.isArray(record.id) || record.id.length !== 3 ||
      record.id.slice(0, 2).join("/") !== "langchain_core/messages") fail()
    const name = record.id[2]
    type = name === "HumanMessage" ? "human" : name === "AIMessage" ? "ai" :
      name === "SystemMessage" ? "system" : name === "ToolMessage" ? "tool" : undefined
    data = object(record.kwargs)
  } else {
    data = record.data === undefined ? record : object(record.data)
  }
  if (type !== "human" && type !== "ai" && type !== "system" && type !== "tool") fail()
  const copied = { ...data }
  // Serializable's known v1 getter has the snake wire alias. Restore only that exact alias.
  if (type === "ai" && object(copied.response_metadata ?? {}).output_version === "v1") {
    if (Object.hasOwn(copied, "contentBlocks") || !Array.isArray(copied.content) ||
      !Array.isArray(copied.content_blocks) ||
      JSON.stringify(copied.content_blocks) !== JSON.stringify(copied.content)) fail()
    copied.contentBlocks = copied.content_blocks
    delete copied.content_blocks
  }
  if (!(typeof copied.content === "string" || Array.isArray(copied.content)) ||
    (copied.id !== undefined && (typeof copied.id !== "string" || !copied.id))) fail()
  const originalId = copied.id
  const safe = constructCapturedNativeMessage(type, { ...copied,
    id: typeof originalId === "string" ? originalId : "unmarked-worker-history-copy" })
  Object.defineProperty(safe, "id", { value: originalId, enumerable: true,
    writable: true, configurable: true })
  return safe
}

/** No Store construction, writes, ACKs or full native-message array allocations. */
export function createCanonicalCheckpointDisplayVerifier(db: NativeSqliteAdapter,
  selection: CanonicalCheckpointDisplaySelection, context: CanonicalCheckpointDisplayContext,
  assertCancelled: () => void): {
    project(raw: unknown, ordinal: number): FunctionConversationProjectionColumns | null | undefined
    finish(messageCount: number): CanonicalCheckpointDisplayMembershipWitness | undefined
    omissions(): CanonicalCheckpointDisplayOmissions
    membership(): { readonly target: FunctionConversationRef;
      readonly snapshot: FunctionConversationCheckpointMembershipSnapshot } | undefined
  } {
  const guard = () => {
    assertCancelled()
    const thread = query(db, "SELECT created_at,metadata FROM threads WHERE thread_id=?",
      [selection.threadId])[0]
    if (!thread || typeof thread.created_at !== "number" ||
      (thread.metadata !== null && typeof thread.metadata !== "string") ||
      !matchesThreadIncarnation({ created_at: thread.created_at, metadata: thread.metadata },
        selection.incarnation)) fail("MODS_CONVERSATION_THREAD_CHANGED")
  }
  guard()
  if (selection.checkpointId !== context.checkpointId || context.namespace !== "") fail()
  const state = context.state === undefined || context.state === null ? undefined : object(context.state)
  let snapshot: FunctionConversationCheckpointMembershipSnapshot | undefined
  let target: FunctionConversationRef | undefined
  const members = new Map<number, FunctionConversationCheckpointMembershipSnapshot["members"][number]>()
  if (state) {
    if (state.version !== 1 || !Number.isSafeInteger(state.frontier) || Number(state.frontier) < 0 ||
      Object.keys(state).length !== 5 || Object.keys(state).some(key =>
        !["version", "logicalSessionId", "conversationId", "branchId", "frontier"].includes(key))) fail()
    const receipt = query(db, `SELECT receipt.*,session.thread_id AS owner_thread,
      session.incarnation_key AS owner_incarnation,session.workspace AS owner_workspace,
      conversation.kind AS owner_kind,conversation.checkpoint_namespace AS owner_namespace,
      conversation.next_sequence AS owner_next_sequence
      FROM function_conversation_checkpoint_receipts receipt
      JOIN function_conversations conversation ON conversation.conversation_id=receipt.conversation_id
      JOIN function_logical_sessions session ON session.logical_session_id=conversation.logical_session_id
      WHERE receipt.conversation_id=? AND receipt.branch_id=? AND receipt.checkpoint_thread_id=?
      AND receipt.checkpoint_namespace=? AND receipt.checkpoint_id=?`, [state.conversationId,
      state.branchId, selection.threadId, context.namespace, context.checkpointId])[0]
    const incarnation = JSON.stringify(selection.incarnation.token === null
      ? ["legacy", selection.incarnation.legacyCreatedAt] : ["token", selection.incarnation.token])
    if (!receipt || receipt.owner_kind !== "main" || receipt.owner_thread !== selection.threadId ||
      receipt.owner_incarnation !== incarnation || receipt.owner_workspace !== selection.workspace ||
      receipt.owner_namespace !== context.namespace || receipt.checkpoint_incarnation !== incarnation) fail()
    target = Object.freeze({ logicalSessionId: text(state.logicalSessionId),
      conversationId: text(state.conversationId), branchId: text(state.branchId),
      threadId: selection.threadId, workspace: selection.workspace,
      incarnation: selection.incarnation, checkpointNamespace: context.namespace, kind: "main" })
    const targetJson = JSON.stringify({ ...target, incarnation })
    if (receipt.target_json !== targetJson) fail()
    const parsed = object(JSON.parse(text(receipt.snapshot_json)))
    const { snapshotDigest, ...facts } = parsed
    if (snapshotDigest !== receipt.snapshot_digest || functionConversationMembershipDigest(facts) !== snapshotDigest ||
      parsed.checkpointId !== context.checkpointId || parsed.namespace !== context.namespace ||
      parsed.checkpointThreadId !== selection.threadId || parsed.checkpointIncarnation !== incarnation ||
      parsed.checkpointTs !== context.checkpointTs || parsed.parentCheckpointId !== context.parentCheckpointId ||
      parsed.stateDigest !== functionConversationMembershipDigest(state) || parsed.frontier !== state.frontier ||
      !Array.isArray(parsed.members)) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    snapshot = parsed as unknown as FunctionConversationCheckpointMembershipSnapshot
    integer(snapshot.nativeMessageCount)
    const cut = object(snapshot.cut), highWater = integer(cut.highWater)
    if (highWater >= integer(receipt.owner_next_sequence)) fail()
    const lineage: Array<{ branchId: string; cut: number }> = []
    let branchId: string | null = target.branchId, frontier = highWater
    while (branchId !== null) {
      if (lineage.length > 32 || lineage.some(item => item.branchId === branchId)) fail()
      const branch: SqlRow | undefined = query(db,
        "SELECT * FROM function_conversation_branches WHERE conversation_id=? AND branch_id=?",
        [target.conversationId, branchId])[0]
      if (!branch || integer(branch.depth) > 32) fail()
      lineage.push({ branchId, cut: frontier })
      frontier = Math.min(frontier, integer(branch.parent_frontier))
      branchId = branch.parent_branch_id === null ? null : text(branch.parent_branch_id)
    }
    if (functionConversationMembershipDigest(lineage) !== cut.lineageDigest ||
      JSON.stringify(lineage) !== JSON.stringify(cut.lineage)) fail()
    const stored = query(db, `SELECT ordinal,uuid,member_json FROM function_conversation_checkpoint_members
      WHERE receipt_id=? ORDER BY ordinal`, [receipt.receipt_id])
    if (stored.length !== snapshot.members.length) fail()
    for (let index = 0; index < snapshot.members.length; index++) {
      const member = snapshot.members[index]
      if (!member || integer(member.ordinal) >= snapshot.nativeMessageCount || members.has(member.ordinal) ||
        stored[index].ordinal !== member.ordinal || stored[index].uuid !== member.uuid ||
        stored[index].member_json !== JSON.stringify(member)) fail()
      members.set(member.ordinal, member)
    }
  }
  const nativeDigest = createHash("sha256").update("[")
  const omissionDigest = createCanonicalCheckpointDisplayOmissionDigest()
  let finished = false, omitted: CanonicalCheckpointDisplayOmissions | undefined
  let visited = 0, visitedMembers = 0
  return {
    project(raw, ordinal) {
      if (finished) fail()
      assertCancelled()
      if (ordinal !== visited++) fail()
      if (!snapshot) {
        // The original unmarked formatter does not require a native constructor or ID.
        // A mark without the actual CP membership must never borrow that legacy path.
        if (hasInvalidFunctionConversationTranscriptStamp(raw) ||
          readFunctionConversationTranscriptStamp(raw)) fail()
        return undefined
      }
      const native = nativeCopy(raw, assertCancelled)
      const copied = captureNativeMessageForOccurrence(native, "unmarked-worker-history-copy", assertCancelled)
      if (copied.snapshot.executionSuppressed || hasInvalidFunctionConversationTranscriptStamp(native)) fail()
      const stamp = readFunctionConversationTranscriptStamp(native), member = members.get(ordinal)
      const payload = stamp ? serializeFunctionConversationNativeMessage(native) : JSON.stringify(native.toDict())
      if (ordinal) nativeDigest.update(",")
      nativeDigest.update(JSON.stringify(payload))
      if (!stamp) { if (member) fail(); return undefined }
      if (!member || !target || !snapshot || native.id !== member.uuid) fail()
      visitedMembers++
      const kept = readCanonicalCheckpointDisplayMemberRow(db, target, snapshot, member)
      const expected = functionConversationProjectionStamp(target, kept)
      if (payload !== kept.nativePayload ||
        !sameFunctionConversationTranscriptStamp(stamp, expected)) fail()
      const projection = readCanonicalDisplayProjection(db, { threadId: selection.threadId,
        incarnation: selection.incarnation, messageId: kept.uuid, assertCurrent: guard })
      if (projection.presentation.kind !== "visible") {
        omissionDigest.append(ordinal, kept.uuid, canonicalDisplayColumnsDigest(projection.columns),
          projection.presentation)
        return null
      }
      return projection.columns
    },
    finish(count) {
      if (finished) fail()
      guard()
      if (count !== visited || (snapshot && (visited !== snapshot.nativeMessageCount ||
        visitedMembers !== snapshot.members.length || nativeDigest.update("]").digest("hex") !==
          snapshot.nativeSnapshotDigest))) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
      omitted = omissionDigest.finish()
      finished = true
      if (!snapshot || !target) return undefined
      const evidence = { conversationId: target.conversationId, branchId: target.branchId,
        threadId: selection.threadId, incarnation: snapshot.checkpointIncarnation,
        namespace: context.namespace, checkpointId: context.checkpointId }
      return { ...evidence, stateJson: JSON.stringify(state),
        fingerprint: canonicalCheckpointDisplayMembershipFingerprint(db, evidence) }
    },
    omissions() {
      if (!finished || !omitted) fail()
      return omitted
    },
    membership() {
      return snapshot && target ? { target, snapshot } : undefined
    }
  }
}

/** Data-only member join; neither its target nor a public UUID creates a checkpoint source. */
export function readCanonicalCheckpointDisplayMemberRow(db: NativeSqliteAdapter,
  target: FunctionConversationRef, snapshot: FunctionConversationCheckpointMembershipSnapshot,
  member: FunctionConversationCheckpointMembershipSnapshot["members"][number]): FunctionConversationRow {
  const row = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
    [target.conversationId, member.uuid])[0]
  if (!row || hash(text(row.payload_json)) !== row.payload_digest ||
    Buffer.byteLength(text(row.payload_json)) !== row.bytes) fail()
  const body = object(JSON.parse(text(row.payload_json)))
  const kept: FunctionConversationRow = { uuid: text(row.uuid), sequence: integer(row.sequence),
    receiptId: text(row.receipt_id), branchId: text(row.branch_id), inputDigest: text(row.input_digest),
    door: text(row.door), origin: modObject(body.origin), message: modObject(body.message),
    nativePayload: text(body.nativePayload), orderAnchor: modObject(body.orderAnchor),
    inbox: body.inbox === true, bytes: integer(row.bytes), createdAt: integer(row.created_at) }
  const cut = snapshot.cut.lineage.find(item => item.branchId === kept.branchId)
  const expected = functionConversationProjectionStamp(target, kept)
  if (!cut || kept.uuid !== member.uuid || kept.sequence < 1 || kept.sequence > cut.cut ||
    kept.sequence !== member.sequence || kept.receiptId !== member.rowReceiptId ||
    kept.branchId !== member.branchId || kept.createdAt !== member.createdAt ||
    functionConversationRowDigest(kept) !== member.rowDigest ||
    functionConversationMembershipDigest(kept.nativePayload) !== member.nativeDigest ||
    functionConversationMembershipDigest(expected) !== member.stampDigest) fail()
  return kept
}
