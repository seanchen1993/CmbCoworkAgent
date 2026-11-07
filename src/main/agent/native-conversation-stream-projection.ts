import { createHash } from "node:crypto"
import { types } from "node:util"
import { performance } from "node:perf_hooks"
import type { BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { STREAM_MESSAGE_CONTENT_MODE_KEY, STREAM_MESSAGE_REASONING_MODE_KEY,
  STREAM_MESSAGE_TOOL_CALLS_MODE_KEY } from "../../shared/stream-message-wire-mode"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY, MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY }
  from "../../shared/message-role-collision"
import { getDb, withCanonicalThreadMessageReadScope, type CanonicalThreadMessageReadScope }
  from "../db"
import { FunctionConversationStore, readFunctionConversationStoreCurrentExecution,
  isFunctionConversationNativeCheckpointStore, readFunctionConversationCheckpointReadOrigins,
  type FunctionConversationRef,
  type FunctionConversationRow }
  from "../db/function-conversation-store"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import type { ThreadMessageWrite } from "../types"
import type { FunctionConversationPresentationDisposition } from
  "../db/function-conversation-presentation-disposition"
import { functionConversationCanonicalStamp, functionConversationMembershipDigest,
  readFunctionConversationCheckpointMembership, type FunctionConversationCheckpointMembershipProof,
  type FunctionConversationCheckpointMember } from
  "../checkpointer/function-conversation-checkpoint-membership"
import { captureNativeMessage, captureNativeMessageForOccurrence,
  constructCapturedNativeMessage } from "./native-message-capture"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { readFunctionConversationIntakePublication, type FunctionConversationIntakePublication }
  from "./mods-conversation"
import { readFunctionConversationSharedHistoricalTarget,
  readFunctionConversationSharedProducer, type FunctionConversationSharedProducer,
  type FunctionConversationSharedProducerView,
  type FunctionConversationSharedHistoricalTarget } from "../mods/v2/conversation-shared-restore"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import { readFunctionConversationNativeMainPolicySource, isFunctionConversationNativeMainRuntime }
  from "../mods/native-conversation-policy-source"
import { matchesFunctionConversationNativeDestinationData,
  assertFunctionConversationNativeDestinationDataCurrent }
  from "../db/function-conversation-native-destination"
import { nativeConversationFairness } from "./function-conversation-native-fairness"

interface Entry {
  readonly message: BaseMessage
  readonly nativeDigest: string
  readonly rowDigest: string
  readonly snapshotDigest: string
  readonly role: ThreadMessageWrite["role"]
  readonly layout: Readonly<Record<string, unknown>>
  readonly presentation: FunctionConversationPresentationDisposition
  readonly uuid: string
  readonly owner: Owner
  readonly readRow?: () => FunctionConversationRow
}
interface PreparedEntry {
  readonly entry: Entry
  readonly previous?: Entry
}
interface Owner {
  readonly runtime: NativeConversationStreamProjectionRuntime
  readonly store: FunctionConversationStore
  readonly signal: AbortSignal
  readonly shared?: FunctionConversationSharedProducerView
  assertSignalData(): void
  initialHistoricalRead?: { failed: boolean }
  pendingHistory?: { failed: boolean; drained: Promise<void> }
  hasRegisteredHistory: boolean
  closed: boolean
}
interface Wire { readonly entry: Entry; readonly digest: string }
const natives = new WeakMap<object, Entry>()
const wires = new WeakMap<object, Wire>()
interface HistoricalFirstRead {
  readonly store: FunctionConversationStore
  readonly target: FunctionConversationRef
  readonly proof: FunctionConversationCheckpointMembershipProof
  readonly read: () => FunctionConversationRow
  readonly assertStoreDataCurrent: () => void
  reading: boolean
  failed: boolean
}
// Only registerHistorical creates these closures. A caller-supplied read or a Store override
// cannot claim that its first operation is the original complete runtime guard.
const historicalFirstReads = new WeakMap<() => FunctionConversationRow, HistoricalFirstRead>()
// Capture the hoisted accessor, not the not-yet-initialized class in a cyclic import. Its
// immutable result was captured by the Store module itself immediately after defining the class.
const checkpointReadOrigins = readFunctionConversationCheckpointReadOrigins
const ownDescriptor = Object.getOwnPropertyDescriptor, prototypeOf = Object.getPrototypeOf
function originalHistoricalStore(store: FunctionConversationStore): boolean {
  const { prototype: originalStorePrototype, memberDescriptor: originalMemberDescriptor,
    readMember: originalMemberRead } = checkpointReadOrigins()
  if (types.isProxy(store) || prototypeOf(store) !== originalStorePrototype ||
    ownDescriptor(store, "readCheckpointMember")) return false
  const current = ownDescriptor(originalStorePrototype, "readCheckpointMember")
  return !!current && "value" in current && current.value === originalMemberRead &&
    current.writable === originalMemberDescriptor.writable &&
    current.enumerable === originalMemberDescriptor.enumerable &&
    current.configurable === originalMemberDescriptor.configurable
}
const projectionWeakGet = WeakMap.prototype.get, projectionWeakSet = WeakMap.prototype.set
const projectionSetConstructor = Set
const projectionSetHas = Set.prototype.has, projectionSetAdd = Set.prototype.add
const projectionSetDelete = Set.prototype.delete, projectionSetValues = Set.prototype.values
const projectionSetNext = Object.getPrototypeOf(new Set().values()).next as
  (this: Iterator<unknown>) => IteratorResult<unknown>
function privateValue<K extends object, V>(values: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(projectionWeakGet, values, [key]) as V | undefined
}
function publishPrivate<K extends object, V>(values: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(projectionWeakSet, values, [key, value])
}
function eachPrivateSet<T>(values: Set<T>, inspect: (value: T) => void): void {
  const iterator = Reflect.apply(projectionSetValues, values, []) as Iterator<T>
  while (true) {
    const next = Reflect.apply(projectionSetNext, iterator, []) as IteratorResult<T>
    if (next.done) return
    inspect(next.value)
  }
}
export type NativeConversationStreamProjectionRuntime = Pick<FunctionNativeConversationRuntime,
  "owner" | "run" | "database" | "target" | "destination" | "signal" | "assertCurrent"> &
  Partial<Pick<FunctionNativeConversationRuntime, "binding" | "capturePolicy">>
export interface NativeConversationStreamProjectionSharedSource {
  readonly proof: FunctionConversationSharedProducer
  readonly authority: ModRuntimeAuthority
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_STREAM_PROJECTION_INVALID") }
function assertHistoryIdle(owner: Owner): void {
  if (owner.pendingHistory) { owner.pendingHistory.failed = true; fail() }
}
function object(value: unknown): value is object {
  return value !== null && typeof value === "object"
}

/** Descriptor-only wire fingerprint: neither a getter, Proxy nor toJSON can mint a receipt. */
function dataText(value: unknown): string {
  const active = new Set<object>()
  let nodes = 0
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > 1_000_000 || depth > 128) fail()
    if (input === null) return "null"
    if (typeof input === "string" || typeof input === "boolean") return JSON.stringify(input)
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input)
    if (!object(input) || types.isProxy(input) || Reflect.apply(projectionSetHas, active, [input])) fail()
    const array = Array.isArray(input), prototype: unknown = Object.getPrototypeOf(input)
    if (array ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null) fail()
    Reflect.apply(projectionSetAdd, active, [input])
    try {
      const properties = Object.getOwnPropertyDescriptors(input)
      if (Reflect.ownKeys(properties).some(key => typeof key !== "string")) fail()
      if (array) {
        const length = properties.length?.value
        if (!Number.isSafeInteger(length) || length < 0 || length > 1_000_000 - nodes) fail()
        for (const key of Object.keys(properties)) {
          if (key === "length") continue
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail()
        }
        const output: string[] = []
        for (let index = 0; index < length; index += 1) {
          const property = properties[String(index)]
          if (!property || !("value" in property) || !property.enumerable) fail()
          output.push(visit(property.value, depth + 1))
        }
        return `[${output.join(",")}]`
      }
      return `{${Object.keys(properties).map(key => {
        const property = properties[key]
        if (!("value" in property) || !property.enumerable) fail()
        return `${JSON.stringify(key)}:${visit(property.value, depth + 1)}`
      }).join(",")}}`
    } finally { Reflect.apply(projectionSetDelete, active, [input]) }
  }
  return visit(value, 0)
}
function digest(value: unknown): string {
  return createHash("sha256").update(dataText(value)).digest("hex")
}
const stringify = JSON.stringify
const throwIfAborted = AbortSignal.prototype.throwIfAborted
function decodedDigest(value: unknown): string {
  // Only private fresh Store.decode/DB-reader results use this path. Wire objects never do.
  return createHash("sha256").update(stringify(value)).digest("hex")
}
function snapshotDigest(snapshot: ThreadMessageWrite): string {
  // These dates are created by the native DB reader, never obtained from stream metadata.
  return decodedDigest({ ...snapshot, created_at: Date.prototype.getTime.call(snapshot.created_at),
    ...(snapshot.start_at ? { start_at: Date.prototype.getTime.call(snapshot.start_at) } : {}),
    ...(snapshot.end_at ? { end_at: Date.prototype.getTime.call(snapshot.end_at) } : {}) })
}
function withOwnerRead<T>(owner: Owner, run: (reader: CanonicalThreadMessageReadScope) => T): T {
  return withCanonicalThreadMessageReadScope(owner.runtime.destination.threadId, run)
}
function assertEntryData(entry: Entry): void {
  const { runtime } = entry.owner
  const signal = runtime.signal
  Reflect.apply(throwIfAborted, signal, [])
  if (entry.owner.closed || getDb() !== runtime.database) fail()
  const captured = captureNativeMessage(entry.message, () => Reflect.apply(throwIfAborted, signal, []))
  if (captured.executionSuppressed || captured.digest !== entry.nativeDigest) fail()
}
function current(entry: Entry, reader?: CanonicalThreadMessageReadScope, partitioned = false):
  { snapshot: ThreadMessageWrite; row: FunctionConversationRow } {
  assertHistoryIdle(entry.owner)
  if (!reader) {
    const result = withOwnerRead(entry.owner, actual => current(entry, actual))
    assertEntryData(entry)
    return result
  }
  const { runtime, store } = entry.owner
  if (entry.owner.closed) fail()
  runtime.signal.throwIfAborted()
  const first = entry.readRow && privateValue(historicalFirstReads, entry.readRow)
  if (first?.failed || first?.reading) { if (first) first.failed = true; fail() }
  const covered = first && first.store === store && originalHistoricalStore(store) &&
    isFunctionConversationNativeMainRuntime(runtime) ? first : undefined
  if (covered) covered.reading = true
  try {
    // The private original Store method starts with the same complete source guard. Run it
    // before inspecting native data, then retain the final guard and the reader's full A/B seal.
    covered?.assertStoreDataCurrent()
    const firstRow = covered ? reader.runGuard(covered.read) : undefined
    if (!covered) reader.runGuard(() => runtime.assertCurrent())
    if (getDb() !== runtime.database) fail()
    const captured = captureNativeMessage(entry.message, () => runtime.signal.throwIfAborted())
    if (captured.executionSuppressed || captured.digest !== entry.nativeDigest) fail()
    const row = covered ? firstRow : reader.runGuard(() => entry.readRow ? entry.readRow() :
      store.readReceipt(runtime.target.ref, entry.uuid))
    if (!row || decodedDigest(row) !== entry.rowDigest) fail()
    const observed = reader.requireSnapshotAndPresentation(entry.uuid)
    if (!observed || snapshotDigest(observed.snapshot) !== entry.snapshotDigest) fail()
    const { snapshot, presentation } = observed
    if (!presentation || presentation.kind !== entry.presentation.kind ||
      presentation.fingerprint !== entry.presentation.fingerprint) fail()
    if (!partitioned) {
      const partition = reader.partition([snapshot])
      if (partition.canonicalCount !== 1 || partition.ordinary.length !== 0) fail()
    }
    reader.runGuard(() => runtime.assertCurrent())
    runtime.signal.throwIfAborted()
    if (covered?.failed || entry.owner.closed || getDb() !== runtime.database ||
      captureNativeMessage(entry.message, () => runtime.signal.throwIfAborted()).digest !== entry.nativeDigest)
      fail()
    return { snapshot, row }
  } catch (error) { if (covered) covered.failed = true; throw error }
  finally { if (covered) covered.reading = false }
}
function ownData(value: object, name: string): unknown {
  if (types.isProxy(value)) fail()
  const property = Object.getOwnPropertyDescriptor(value, name)
  if (!property) return undefined
  if (!("value" in property)) fail()
  return property.value
}
function arrayItems(value: readonly unknown[]): unknown[] {
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  const length = ownData(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 1_000_000)
    fail()
  return Array.from({ length }, (_unused, index) => ownData(value, String(index)))
}

/** Conservative serialization strategy only. This does not certify or omit any message. */
export function requiresFullNativeConversationValuesProjection(messages: readonly unknown[]): boolean {
  return arrayItems(messages).some(message => {
    if (!object(message)) return false
    const entry = privateValue(natives, message) ?? privateValue(wires, message)?.entry
    return entry !== undefined && entry.presentation.kind !== "visible"
  })
}
function marked(value: object): boolean {
  const kwargs = ownData(value, "kwargs")
  const additional = ownData(value, "additional_kwargs") ??
    (object(kwargs) ? ownData(kwargs, "additional_kwargs") : undefined)
  if (!object(additional)) return false
  if (types.isProxy(additional)) fail()
  return Object.hasOwn(additional, "function_row") ||
    Object.hasOwn(additional, "function_row_invalid")
}
function validateMessage(value: unknown, owner: Owner, reader: CanonicalThreadMessageReadScope,
  checkedWires: Array<{ value: object; wire: Wire }>, checkedEntries: Set<Entry>): void {
  if (!object(value)) return
  const entry = privateValue(natives, value) ?? privateValue(wires, value)?.entry
  if (entry) {
    if (entry.owner !== owner) fail()
    Reflect.apply(projectionSetAdd, checkedEntries, [entry])
    const wire = privateValue(wires, value)
    if (wire) {
      if (digest(value) !== wire.digest) fail()
      checkedWires.push({ value, wire })
    }
    current(entry, reader, true)
  } else if (marked(value)) fail()
}

interface HistoricalBatchItem { value: object; entry: Entry; first: HistoricalFirstRead }
function selectHistoricalBatch(candidates: readonly { value: object; entry: Entry }[],
  owner: Owner): HistoricalBatchItem[] | undefined {
  if (owner.shared || !isFunctionConversationNativeMainRuntime(owner.runtime)) return
  const selected: HistoricalBatchItem[] = []
  for (let index = 0; index < candidates.length; index++) {
    const { value, entry } = candidates[index]
    if (entry.owner !== owner) return
    if (!entry.readRow) continue
    const first = privateValue(historicalFirstReads, entry.readRow)
    // An unknown read may have observable callbacks. Keep its original ordering and guards.
    if (!first || first.store !== owner.store) return
    if (first.failed || first.reading) { first.failed = true; fail() }
    if (selected.length && (first.target !== selected[0].first.target ||
      first.proof !== selected[0].first.proof)) return
    selected.push({ value, entry, first })
  }
  if (selected.length < 2 || !isFunctionConversationNativeCheckpointStore(owner.store,
    selected[0].first.target)) return
  return selected
}

function historicalBatch(values: readonly unknown[], owner: Owner): HistoricalBatchItem[] | undefined {
  if (owner.shared || !isFunctionConversationNativeMainRuntime(owner.runtime)) return
  const candidates: Array<{ value: object; entry: Entry }> = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (!object(value)) continue
    const entry = privateValue(natives, value) ?? privateValue(wires, value)?.entry
    if (entry) candidates.push({ value, entry })
  }
  return selectHistoricalBatch(candidates, owner)
}

function readHistoricalBatchRows(batch: readonly HistoricalBatchItem[], owner: Owner,
  reader: CanonicalThreadMessageReadScope, active: HistoricalFirstRead[]): FunctionConversationRow[] {
  const uuids: string[] = []
  const activeLookup = new projectionSetConstructor<HistoricalFirstRead>()
  for (let index = 0; index < active.length; index++)
    Reflect.apply(projectionSetAdd, activeLookup, [active[index]])
  for (let index = 0; index < batch.length; index++) {
    const { first, entry } = batch[index]
    const alreadyActive = Reflect.apply(projectionSetHas, activeLookup, [first]) as boolean
    if (first.failed || first.reading && !alreadyActive) { first.failed = true; fail() }
    if (!alreadyActive) {
      first.reading = true
      active[active.length] = first
      Reflect.apply(projectionSetAdd, activeLookup, [first])
    }
    uuids.push(entry.uuid)
  }
  // Latch the complete set before any source guard can re-enter. Callers retain these
  // latches through the read scope's fresh-B seal and release them without callbacks.
  for (let index = 0; index < batch.length; index++) batch[index].first.assertStoreDataCurrent()
  const first = batch[0].first
  const guard = () => {
    owner.runtime.assertCurrent()
    if (!isFunctionConversationNativeMainRuntime(owner.runtime) ||
      !isFunctionConversationNativeCheckpointStore(owner.store, first.target)) fail()
  }
  const rows = reader.runGuard(() => Reflect.apply(checkpointReadOrigins().readMembers, owner.store,
    [first.target, first.proof, uuids, guard]) as FunctionConversationRow[])
  if (!isFunctionConversationNativeMainRuntime(owner.runtime) ||
    !isFunctionConversationNativeCheckpointStore(owner.store, first.target) || rows.length !== batch.length)
    fail()
  for (let index = 0; index < batch.length; index++) if (batch[index].first.failed) fail()
  return rows
}

function readInitialHistoricalRows(owner: Owner, target: FunctionConversationRef,
  proof: FunctionConversationCheckpointMembershipProof, members: readonly { uuid: string }[],
  reader: CanonicalThreadMessageReadScope): Array<FunctionConversationRow | undefined> | undefined {
  if (owner.shared || target.kind !== "main" || members.length < 2 ||
    !isFunctionConversationNativeMainRuntime(owner.runtime) || !originalHistoricalStore(owner.store) ||
    !isFunctionConversationNativeCheckpointStore(owner.store, target)) return
  const execution = readFunctionConversationStoreCurrentExecution(owner.store, owner.runtime.database)
  if (!execution) return
  const operation = { failed: false }, uuids: string[] = []
  for (let index = 0; index < members.length; index++) uuids[index] = members[index].uuid
  owner.initialHistoricalRead = operation
  const data = () => {
    if (operation.failed || owner.initialHistoricalRead !== operation || owner.closed ||
      getDb() !== owner.runtime.database || !isFunctionConversationNativeMainRuntime(owner.runtime) ||
      !isFunctionConversationNativeCheckpointStore(owner.store, target)) fail()
    execution.assertDataCurrent()
  }
  const guard = () => { owner.runtime.assertCurrent(); data() }
  try {
    data()
    const rows = reader.runGuard(() => Reflect.apply(checkpointReadOrigins().readMembers, owner.store,
      [target, proof, uuids, guard]) as FunctionConversationRow[])
    data()
    if (rows.length !== members.length) fail()
    for (let index = 0; index < rows.length; index++)
      if (rows[index].uuid !== uuids[index]) fail()
    return rows
  } catch (error) { operation.failed = true; throw error }
  finally { owner.initialHistoricalRead = undefined }
}

function validateHistoricalBatch(batch: readonly HistoricalBatchItem[], owner: Owner,
  reader: CanonicalThreadMessageReadScope, checkedWires: Array<{ value: object; wire: Wire }>,
  checkedEntries: Set<Entry>, active: HistoricalFirstRead[]): void {
  const rows = readHistoricalBatchRows(batch, owner, reader, active)
  // No source callback separates these checks. The original batch checks every live member/cut;
  // the caller retains the final runtime guard and all native/wire checks before fresh seal B.
  for (let index = 0; index < batch.length; index++) {
    const { value, entry, first: source } = batch[index]
    if (source.failed) fail()
    assertEntryData(entry)
    if (decodedDigest(rows[index]) !== entry.rowDigest) fail()
    const observed = reader.requireSnapshotAndPresentation(entry.uuid)
    if (!observed || snapshotDigest(observed.snapshot) !== entry.snapshotDigest ||
      observed.presentation.kind !== entry.presentation.kind ||
      observed.presentation.fingerprint !== entry.presentation.fingerprint) fail()
    Reflect.apply(projectionSetAdd, checkedEntries, [entry])
    const wire = privateValue(wires, value)
    if (wire) {
      if (wire.entry !== entry || digest(value) !== wire.digest) fail()
      checkedWires.push({ value, wire })
    }
  }
}

function prepareEntry(owner: Owner, message: BaseMessage, row: FunctionConversationRow,
  reader: CanonicalThreadMessageReadScope, readRow?: () => FunctionConversationRow,
  reuse = false): PreparedEntry {
  const { runtime, store } = owner
  const previous = privateValue(natives, message)
  if (owner.closed || (previous && (!reuse ||
    (previous.owner !== owner && !previous.owner.closed)))) fail()
  reader.runGuard(() => runtime.assertCurrent())
  runtime.signal.throwIfAborted()
  const captured = captureNativeMessage(message, () => runtime.signal.throwIfAborted())
  if (captured.executionSuppressed || captured.data.id !== row.uuid) fail()
  const additional = captured.data.additional_kwargs
  if (!object(additional) || dataText(ownData(additional, "function_row")) !==
    dataText(functionConversationCanonicalStamp(runtime.target.ref, row))) fail()
  const safe = constructCapturedNativeMessage(captured.type, { ...captured.data })
  if (serializeFunctionConversationNativeMessage(safe) !== row.nativePayload) fail()
  const actual = reader.runGuard(() => readRow ? readRow() : store.readReceipt(runtime.target.ref, row.uuid))
  if (!actual || decodedDigest(actual) !== digest(row)) fail()
  const observed = reader.requireSnapshotAndPresentation(row.uuid)
  if (!observed) fail()
  const { snapshot, presentation } = observed
  const partition = reader.partition([snapshot])
  if (partition.canonicalCount !== 1 || partition.ordinary.length !== 0) fail()
  reader.runGuard(() => runtime.assertCurrent())
  runtime.signal.throwIfAborted()
  // The final native guard can synchronously re-enter. Recheck raw data without another SQL
  // pass before publishing; neither this copy nor another field renews any source lifetime.
  if (owner.closed || getDb() !== runtime.database ||
    captureNativeMessage(message, () => runtime.signal.throwIfAborted()).digest !== captured.digest) fail()
  const entry: Entry = Object.freeze({ owner, message, uuid: row.uuid, nativeDigest: captured.digest,
    rowDigest: decodedDigest(actual), snapshotDigest: snapshotDigest(snapshot), role: snapshot.role,
    layout: createLayoutView(snapshot, actual), presentation,
    ...(readRow ? { readRow } : {}) })
  if (previous?.owner === owner) {
    // Authenticate the new source first, but never refresh a prior receipt's expired source.
    current(previous, reader)
    if (previous.uuid !== entry.uuid || previous.nativeDigest !== entry.nativeDigest ||
      previous.rowDigest !== entry.rowDigest || previous.snapshotDigest !== entry.snapshotDigest ||
      previous.presentation.kind !== entry.presentation.kind ||
      previous.presentation.fingerprint !== entry.presentation.fingerprint)
      fail()
    return Object.freeze({ entry: previous, previous })
  }
  return Object.freeze({ entry, ...(previous ? { previous } : {}) })
}

function finishEntryGuards(owner: Owner, prepared: readonly PreparedEntry[],
  reader: CanonicalThreadMessageReadScope, active?: HistoricalFirstRead[]): void {
  const { runtime } = owner
  reader.runGuard(() => runtime.assertCurrent())
  if (active) {
    // New entries have not been published to natives. Select their private prepared values
    // directly; reused entries must retain their original owner and membership provenance.
    const candidates: Array<{ value: object; entry: Entry }> = []
    for (let index = 0; index < prepared.length; index++) {
      const { entry } = prepared[index]
      candidates.push({ value: entry.message, entry })
    }
    const batch = selectHistoricalBatch(candidates, owner)
    if (batch) {
      const rows = readHistoricalBatchRows(batch, owner, reader, active)
      for (let index = 0; index < batch.length; index++)
        if (decodedDigest(rows[index]) !== batch[index].entry.rowDigest) fail()
      return
    }
  }
  for (let index = 0; index < prepared.length; index++) {
    const { entry } = prepared[index]
    if (entry.readRow) {
      const row = reader.runGuard(entry.readRow)
      if (decodedDigest(row) !== entry.rowDigest) fail()
    }
  }
}
function adoptEntries(owner: Owner, prepared: readonly PreparedEntry[]): void {
  const { runtime } = owner
  owner.assertSignalData()
  Reflect.apply(throwIfAborted, owner.signal, [])
  if (owner.closed || getDb() !== runtime.database) fail()
  // All comparisons precede publication. No callback runs between the CAS checks and sets.
  for (let index = 0; index < prepared.length; index++) {
    const entry = prepared[index].entry, previousField =
      Object.getOwnPropertyDescriptor(prepared[index], "previous")
    if (previousField && !("value" in previousField)) fail()
    const previous = previousField?.value as Entry | undefined
    if (privateValue(natives, entry.message) !== previous) fail()
    assertEntryData(entry)
  }
  for (let index = 0; index < prepared.length; index++) {
    const entry = prepared[index].entry
    publishPrivate(natives, entry.message, entry)
  }
}

interface HistoricalInput {
  message: BaseMessage
  serialized: string
  fingerprint: string
  member: boolean
  originalId?: string
}
function captureHistoricalInput(message: BaseMessage,
  member: FunctionConversationCheckpointMember | undefined, signal: AbortSignal,
  abort = () => Reflect.apply(throwIfAborted, signal, [])): HistoricalInput {
  if (member) {
    const captured = captureNativeMessage(message, abort)
    if (captured.executionSuppressed || captured.data.id !== member.uuid) fail()
    return { message, member: true, fingerprint: captured.digest,
      serialized: serializeFunctionConversationNativeMessage(constructCapturedNativeMessage(
        captured.type, { ...captured.data })) }
  }
  if (marked(message)) fail()
  const captured = captureNativeMessageForOccurrence(message, "unmarked-history-copy", abort)
  if (captured.snapshot.executionSuppressed) fail()
  const safe = constructCapturedNativeMessage(captured.snapshot.type, { ...captured.snapshot.data })
  Object.defineProperty(safe, "id", { value: captured.originalId, enumerable: true,
    writable: true, configurable: true })
  return { message, member: false, fingerprint: captured.originalDigest,
    originalId: captured.originalId, serialized: stringify(safe.toDict()) }
}
function assertHistoricalInputData(messages: readonly BaseMessage[], inputs: readonly HistoricalInput[],
  signal: AbortSignal): void {
  if (types.isProxy(messages) || Object.getPrototypeOf(messages) !== Array.prototype ||
    ownData(messages, "length") !== inputs.length) fail()
  const abort = () => Reflect.apply(throwIfAborted, signal, [])
  for (let index = 0; index < inputs.length; index++) {
    const value = inputs[index]
    if (ownData(messages, String(index)) !== value.message) fail()
    if (value.member) {
      const captured = captureNativeMessage(value.message, abort)
      if (captured.executionSuppressed || captured.digest !== value.fingerprint) fail()
    } else {
      const captured = captureNativeMessageForOccurrence(value.message, "unmarked-history-copy", abort)
      if (captured.snapshot.executionSuppressed || captured.originalDigest !== value.fingerprint ||
        captured.originalId !== value.originalId) fail()
    }
  }
}
function prepareHistoricalMember(owner: Owner, message: BaseMessage,
  member: FunctionConversationCheckpointMember, row: FunctionConversationRow,
  target: FunctionConversationRef, proof: FunctionConversationCheckpointMembershipProof,
  reader: CanonicalThreadMessageReadScope,
  bridge?: ReturnType<typeof readFunctionConversationSharedHistoricalTarget>): PreparedEntry {
  const { runtime, store } = owner
  const readRow = () => {
    bridge?.assertCurrent()
    const current = store.readCheckpointMember(target, proof, member.uuid,
      runtime.assertCurrent.bind(runtime))
    bridge?.assertDataCurrent()
    return current
  }
  if (!bridge && !owner.shared && target.kind === "main" && originalHistoricalStore(store)) {
    const actualStore = readFunctionConversationStoreCurrentExecution(store, runtime.database)
    if (actualStore) publishPrivate(historicalFirstReads, readRow, {
      store, reading: false, failed: false, assertStoreDataCurrent: actualStore.assertDataCurrent,
      target, proof,
      read: () => Reflect.apply(checkpointReadOrigins().readMember, store,
        [target, proof, member.uuid, () => runtime.assertCurrent()]) as FunctionConversationRow })
  }
  return prepareEntry(owner, message, row, reader, readRow, true)
}

async function prepareNativeHistoricalAsync(owner: Owner, messages: readonly BaseMessage[],
  proof: FunctionConversationCheckpointMembershipProof, signal: AbortSignal,
  operation: NonNullable<Owner["pendingHistory"]>, drained: () => void): Promise<void> {
  const { runtime, store } = owner, target = runtime.target.ref
  const active: HistoricalFirstRead[] = []
  const data = () => {
    Reflect.apply(throwIfAborted, signal, [])
    owner.assertSignalData()
    if (operation.failed || owner.pendingHistory !== operation || owner.closed || owner.hasRegisteredHistory ||
      getDb() !== runtime.database || !isFunctionConversationNativeMainRuntime(runtime) ||
      !isFunctionConversationNativeCheckpointStore(store, target)) fail()
  }
  const current = () => { data(); runtime.assertCurrent(); data() }
  try {
    const fairness = nativeConversationFairness(signal, current)
    const fixed = arrayItems(messages)
    const admitted = withOwnerRead(owner, reader => {
      reader.runGuard(current)
      const membership = reader.runGuard(() => readFunctionConversationCheckpointMembership(proof, store, target))
      const kept = reader.runGuard(() => store.readCheckpointRecoverySnapshot(target, {
        checkpointThreadId: runtime.target.checkpointThreadId,
        checkpointIncarnation: runtime.destination.incarnation,
        checkpointId: membership.checkpointId
      }, current))
      if (fixed.length !== membership.nativeMessageCount ||
        kept.snapshot.snapshotDigest !== membership.snapshotDigest) fail()
      const initialRows = readInitialHistoricalRows(owner, target, proof, membership.members, reader)
      data()
      return { membership, initialRows }
    })
    await fairness()
    const { membership, initialRows } = admitted
    const members = new Map(membership.members.map(member => [member.ordinal, member]))
    const prepared: PreparedEntry[] = [], inputs: HistoricalInput[] = []
    let index = 0, initialIndex = 0
    while (index < fixed.length) {
      withOwnerRead(owner, reader => {
        reader.runGuard(current)
        if (reader.runGuard(() => readFunctionConversationCheckpointMembership(proof, store, target)) !== membership)
          fail()
        const since = performance.now()
        do {
          const value = fixed[index], member = members.get(index)
          if (!object(value) || ownData(messages, "length") !== fixed.length ||
            ownData(messages, String(index)) !== value) fail()
          const message = value as BaseMessage
          const captured = captureHistoricalInput(message, member, signal)
          inputs.push(captured)
          if (member) {
            const row = initialRows ? initialRows[initialIndex]! :
              reader.runGuard(() => store.readCheckpointMember(target, proof, member.uuid, current))
            if (initialRows) {
              if (!row || row.uuid !== member.uuid) fail()
              initialRows[initialIndex++] = undefined
            }
            prepared.push(prepareHistoricalMember(owner, message, member, row, target, proof, reader))
          }
          index++
        } while (index < fixed.length && performance.now() - since < 8)
        reader.runGuard(current)
        data()
      })
      // Every canonical A/B scope is complete before servicing another event-loop turn.
      await fairness()
    }
    withOwnerRead(owner, reader => {
      reader.runGuard(current)
      if (reader.runGuard(() => readFunctionConversationCheckpointMembership(proof, store, target)) !== membership)
        fail()
      const candidates: Array<{ value: object; entry: Entry }> = []
      for (let item = 0; item < prepared.length; item++)
        candidates.push({ value: prepared[item].entry.message, entry: prepared[item].entry })
      const batch = selectHistoricalBatch(candidates, owner)
      if (batch) validateHistoricalBatch(batch, owner, reader, [], new Set<Entry>(), active)
      else {
        // The one-member case still authenticates its original row and complete canonical view.
        for (let item = 0; item < prepared.length; item++) {
          const entry = prepared[item].entry
          const row = reader.runGuard(entry.readRow!)
          if (decodedDigest(row) !== entry.rowDigest) fail()
          const observed = reader.requireSnapshotAndPresentation(entry.uuid)
          if (snapshotDigest(observed.snapshot) !== entry.snapshotDigest ||
            observed.presentation.kind !== entry.presentation.kind ||
            observed.presentation.fingerprint !== entry.presentation.fingerprint) fail()
        }
      }
      const snapshots: ThreadMessageWrite[] = [], native: string[] = []
      for (let item = 0; item < prepared.length; item++)
        snapshots.push(reader.requireSnapshotAndPresentation(prepared[item].entry.uuid).snapshot)
      const partition = reader.partition(snapshots)
      if (partition.canonicalCount !== prepared.length || partition.ordinary.length !== 0) fail()
      for (let item = 0; item < inputs.length; item++) native.push(inputs[item].serialized)
      if (functionConversationMembershipDigest(native) !== membership.nativeSnapshotDigest) fail()
      reader.runGuard(current)
      // No construction/toDict or source callback follows this final source guard.
      assertHistoricalInputData(messages, inputs, signal)
      data()
    })
    // A scope's final read cannot publish a subset. Recheck all raw inputs, including
    // unmarked history, then retain the existing all-entry CAS before the first publication.
    assertHistoricalInputData(messages, inputs, signal)
    data()
    for (let item = 0; item < active.length; item++) if (active[item].failed) fail()
    adoptEntries(owner, prepared)
    owner.hasRegisteredHistory = true
  } catch (error) {
    operation.failed = true
    for (let item = 0; item < active.length; item++) active[item].failed = true
    throw error
  } finally {
    for (let item = 0; item < active.length; item++) active[item].reading = false
    if (owner.pendingHistory === operation) owner.pendingHistory = undefined
    drained()
  }
}

/** Host-only registration is called with the actual Keeper ACK result, never an SDK envelope. */
export function createNativeConversationStreamProjection(input: {
  readonly runtime: NativeConversationStreamProjectionRuntime
  readonly store: FunctionConversationStore
  readonly sharedSource?: NativeConversationStreamProjectionSharedSource
}) {
  const runtime = input.runtime
  if (types.isProxy(runtime)) fail()
  const runtimePrototype = Object.getPrototypeOf(runtime), signalField =
    Object.getOwnPropertyDescriptor(runtime, "signal")
  if (!signalField || !("value" in signalField) || !object(signalField.value) ||
    types.isProxy(signalField.value)) fail()
  const signal = signalField.value as AbortSignal
  const assertSignalData = () => {
    const current = Object.getOwnPropertyDescriptor(runtime, "signal")
    if (Object.getPrototypeOf(runtime) !== runtimePrototype || !current || !("value" in current) ||
      current.value !== signal || current.writable !== signalField.writable ||
      current.enumerable !== signalField.enumerable ||
      current.configurable !== signalField.configurable) fail()
  }
  // Capture the genuine child while it is live. Later shadow classification never renews it.
  const shared = input.sharedSource ? readFunctionConversationSharedProducer(
    input.sharedSource.proof, input.sharedSource.authority) : undefined
  if (shared && (runtime.target !== shared.target || runtime.binding !== shared.binding ||
    runtime.owner !== shared.owner || runtime.run !== shared.invocation ||
    runtime.database !== shared.database || signal !== shared.signal ||
    runtime.destination.threadId !== shared.destination.destinationThreadId)) fail()
  const owner: Owner = { runtime, store: input.store, signal, assertSignalData, shared,
    hasRegisteredHistory: false, closed: false }
  const omitSharedChild = (message: object, entry: Entry, wire: Wire | undefined): true => {
    const child = entry.owner.shared
    const relation = () => {
      if (!child || runtime.target.ref.kind !== "main" || runtime.database !== child.database ||
        entry.owner.runtime.target !== child.target || entry.owner.runtime.binding !== child.binding ||
        entry.owner.runtime.owner !== child.owner || entry.owner.runtime.run !== child.invocation ||
        entry.owner.runtime.database !== child.database || entry.owner.signal !== child.signal ||
        entry.owner.runtime.destination.threadId !== child.destination.destinationThreadId ||
        !matchesFunctionConversationNativeDestinationData(child.destination, runtime.database,
          child.target.ref, runtime.target.ref)) fail()
      owner.assertSignalData()
      Reflect.apply(throwIfAborted, owner.signal, [])
      Reflect.apply(throwIfAborted, runtime.target.signal, [])
      if (owner.closed || getDb() !== runtime.database) fail()
    }
    relation()
    const capturePolicy = ownData(runtime, "capturePolicy")
    if (typeof capturePolicy !== "function" || !child) fail()
    const admission = Reflect.apply(capturePolicy, runtime, []) as
      ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
    const source = readFunctionConversationNativeMainPolicySource(admission, runtime)
    if (!source) fail()
    source.assertCurrent()
    source.assertTail()
    relation()
    assertFunctionConversationNativeDestinationDataCurrent(child.destination, runtime.database)
    // Only the parent's live source is checked. A closed child's committed shadow can be dropped.
    const captured = captureNativeMessage(entry.message,
      () => Reflect.apply(throwIfAborted, owner.signal, []))
    if (captured.executionSuppressed || captured.digest !== entry.nativeDigest ||
      privateValue(natives, entry.message) !== entry ||
      (wire ? privateValue(wires, message) !== wire || wire.entry !== entry ||
        digest(message) !== wire.digest : message !== entry.message)) fail()
    source.assertTail()
    relation()
    return true
  }
  const ownedMessages = new WeakMap<BaseMessage, {
    readonly entry: Entry
    readonly proof: { assertCurrent(): void; assertDataCurrent(): void }
    reading: boolean
    failed: boolean
  }>()
  const historicalOperations = new WeakMap<FunctionConversationSharedHistoricalTarget,
    { reading: boolean; failed: boolean }>()
  const projection = Object.freeze({
    /** Return classification only. The caller must still validate the whole native batch. */
    captureReturnMessageSource(message: BaseMessage) {
      assertHistoryIdle(owner)
      if (!object(message) || types.isProxy(message)) fail()
      const entry = privateValue(natives, message)
      if (!entry) {
        if (privateValue(wires, message) || marked(message)) fail()
        return undefined
      }
      if (entry.owner !== owner || entry.message !== message) fail()
      const signal = owner.runtime.signal, targetSignal = owner.runtime.target.signal
      let failed = false
      const assertDataCurrent = (): void => {
        try {
          if (failed || owner.closed || privateValue(natives, message) !== entry ||
            entry.owner !== owner || entry.message !== message ||
            getDb() !== owner.runtime.database) fail()
          Reflect.apply(throwIfAborted, signal, [])
          Reflect.apply(throwIfAborted, targetSignal, [])
          assertEntryData(entry)
        } catch (error) { failed = true; throw error }
      }
      assertDataCurrent()
      return Object.freeze({ assertDataCurrent })
    },
    /** An exact native address owned by this factory, never generic validate's ordinary branch. */
    captureOwnedMessage(message: BaseMessage) {
      assertHistoryIdle(owner)
      if (!object(message) || types.isProxy(message)) fail()
      const entry = privateValue(natives, message)
      if (!entry || entry.owner !== owner || entry.message !== message) fail()
      const previous = privateValue(ownedMessages, message)
      if (previous) {
        if (previous.entry !== entry) { previous.failed = true; fail() }
        previous.proof.assertCurrent()
        return previous.proof
      }
      const signal = owner.runtime.signal, targetSignal = owner.runtime.target.signal
      const check = (): void => {
        if (record.failed || record.entry !== entry || privateValue(ownedMessages, message) !== record ||
          owner.closed || privateValue(natives, message) !== entry || entry.owner !== owner ||
          entry.message !== message || getDb() !== owner.runtime.database) fail()
        Reflect.apply(throwIfAborted, signal, [])
        Reflect.apply(throwIfAborted, targetSignal, [])
      }
      const data = (): void => {
        check()
        const captured = captureNativeMessage(message, () => {
          Reflect.apply(throwIfAborted, signal, [])
          Reflect.apply(throwIfAborted, targetSignal, [])
        })
        if (captured.executionSuppressed || captured.digest !== entry.nativeDigest) fail()
        check()
      }
      const proof: { assertCurrent(): void; assertDataCurrent(): void } = Object.freeze({
        assertCurrent() {
          if (record.reading || record.failed) { record.failed = true; fail() }
          record.reading = true
          try { data(); current(entry); data() }
          catch (error) { record.failed = true; throw error }
          finally { record.reading = false }
        },
        assertDataCurrent() {
          try { if (record.reading) fail(); data() }
          catch (error) { record.failed = true; throw error }
        }
      })
      const record = { entry, proof, reading: false, failed: false }
      // The same-address latch exists before current(entry)'s first original source callback.
      publishPrivate(ownedMessages, message, record)
      proof.assertCurrent()
      return proof
    },
    assertFinalizedData(message: BaseMessage): void {
      assertHistoryIdle(owner)
      const entry = privateValue(natives, message)
      if (!entry || entry.owner !== owner || entry.readRow) fail()
      assertEntryData(entry)
      // New actual Keeper ACKs only. Every check here uses original SQL/data; there is no
      // runtime, policy, historical reader or producer callback after the Node's last guard.
      withOwnerRead(owner, reader => {
        const row = owner.store.readReceipt(owner.runtime.target.ref, entry.uuid)
        if (!row || decodedDigest(row) !== entry.rowDigest) fail()
        const observed = reader.requireSnapshotAndPresentation(entry.uuid)
        if (!observed) fail()
        const { snapshot, presentation } = observed
        if (snapshotDigest(snapshot) !== entry.snapshotDigest ||
          presentation.kind !== entry.presentation.kind ||
          presentation.fingerprint !== entry.presentation.fingerprint) fail()
        const partition = reader.partition([snapshot])
        if (partition.canonicalCount !== 1 || partition.ordinary.length !== 0) fail()
        assertEntryData(entry)
      })
      if (privateValue(natives, message) !== entry) fail()
      assertEntryData(entry)
    },
    register(message: BaseMessage, row: FunctionConversationRow): void {
      assertHistoryIdle(owner)
      if (row.branchId !== input.runtime.target.ref.branchId) fail()
      const prepared = withOwnerRead(owner, reader => {
        const value = prepareEntry(owner, message, row, reader)
        finishEntryGuards(owner, [value], reader)
        return value
      })
      adoptEntries(owner, [prepared])
    },
    registerHistorical(messages: readonly BaseMessage[],
      proof: FunctionConversationCheckpointMembershipProof,
      historicalTarget?: FunctionConversationSharedHistoricalTarget): void {
      assertHistoryIdle(owner)
      // Only an in-flight native initial batch installs this latch. A nested fallback
      // must not evade it; ordinary custom/shared registrations retain their old path.
      if (owner.initialHistoricalRead) { owner.initialHistoricalRead.failed = true; fail() }
      const bridge = historicalTarget === undefined ? undefined :
        readFunctionConversationSharedHistoricalTarget(historicalTarget, messages, proof,
          owner.store, owner.runtime.target.ref)
      const target = bridge?.target ?? owner.runtime.target.ref
      const activeBatch: HistoricalFirstRead[] = []
      let operation = historicalTarget === undefined ? undefined :
        privateValue(historicalOperations, historicalTarget)
      if (historicalTarget !== undefined && !operation) {
        operation = { reading: false, failed: false }
        publishPrivate(historicalOperations, historicalTarget, operation)
      }
      if (operation) {
        if (operation.reading || operation.failed) { operation.failed = true; fail() }
        // A scope can itself run a source guard, so latch before entering it.
        operation.reading = true
      }
      try {
        const prepared = withOwnerRead(owner, reader => {
          const { runtime, store } = owner
          if (bridge) reader.runGuard(bridge.assertCurrent)
          reader.runGuard(() => runtime.assertCurrent())
          const membership = reader.runGuard(() => readFunctionConversationCheckpointMembership(proof, store, target))
          const checkpointPoint = bridge?.checkpointPoint ?? {
            checkpointThreadId: runtime.target.checkpointThreadId,
            checkpointIncarnation: runtime.destination.incarnation,
            checkpointId: membership.checkpointId }
          if (bridge && (membership.checkpointThreadId !== checkpointPoint.checkpointThreadId ||
            membership.checkpointId !== checkpointPoint.checkpointId ||
            membership.checkpointIncarnation !== bridge.checkpointPoint.checkpointIncarnationKey ||
            membership.namespace !== bridge.checkpointPoint.namespace)) fail()
          const kept = reader.runGuard(() => store.readCheckpointRecoverySnapshot(target,
            checkpointPoint, runtime.assertCurrent.bind(runtime)))
          if (types.isProxy(messages) || Object.getPrototypeOf(messages) !== Array.prototype ||
            kept.snapshot.snapshotDigest !== membership.snapshotDigest ||
            messages.length !== membership.nativeMessageCount) fail()
          const members = new Map(membership.members.map(member => [member.ordinal, member]))
          const initialRows = bridge ? undefined :
            readInitialHistoricalRows(owner, target, proof, membership.members, reader)
          let initialIndex = 0
          const native: string[] = [], prepared: PreparedEntry[] = []
          for (let index = 0; index < messages.length; index += 1) {
            const value = ownData(messages, String(index)), member = members.get(index)
            if (!object(value)) fail()
            const message = value as BaseMessage
            if (member) {
              const row = initialRows ? initialRows[initialIndex]! :
                reader.runGuard(() => store.readCheckpointMember(target, proof, member.uuid,
                  runtime.assertCurrent.bind(runtime)))
              // A prefetched row is only the initial comparison value. prepareEntry still
              // performs its own original fresh read, and the final full seal is unchanged.
              if (initialRows) {
                if (!row || row.uuid !== member.uuid) fail()
                initialRows[initialIndex++] = undefined
              }
              native.push(captureHistoricalInput(message, member, runtime.signal,
                () => runtime.signal.throwIfAborted()).serialized)
              prepared.push(prepareHistoricalMember(owner, message, member, row, target, proof, reader, bridge))
            } else {
              native.push(captureHistoricalInput(message, undefined, runtime.signal,
                () => runtime.signal.throwIfAborted()).serialized)
            }
          }
          if (functionConversationMembershipDigest(native) !== membership.nativeSnapshotDigest) fail()
          reader.runGuard(() => runtime.assertCurrent())
          if (owner.closed || reader.runGuard(() =>
            readFunctionConversationCheckpointMembership(proof, store, target)) !== membership)
            fail()
          finishEntryGuards(owner, prepared, reader, activeBatch)
          bridge?.assertDataCurrent()
          if (operation?.failed) fail()
          return prepared
        })
        bridge?.assertDataCurrent()
        if (operation?.failed) fail()
        for (let index = 0; index < activeBatch.length; index++) if (activeBatch[index].failed) fail()
        adoptEntries(owner, prepared)
        bridge?.assertDataCurrent()
        if (operation?.failed) fail()
        owner.hasRegisteredHistory = true
      } catch (error) {
        if (operation) operation.failed = true
        for (let index = 0; index < activeBatch.length; index++) activeBatch[index].failed = true
        throw error
      } finally {
        if (operation) operation.reading = false
        for (let index = 0; index < activeBatch.length; index++) activeBatch[index].reading = false
      }
    },
    registerHistoricalAsync(messages: readonly BaseMessage[],
      proof: FunctionConversationCheckpointMembershipProof, invocationSignal: AbortSignal): void | Promise<void> {
      assertHistoryIdle(owner)
      if (owner.initialHistoricalRead) { owner.initialHistoricalRead.failed = true; fail() }
      // Classification is data-only. Install pending before the first source guard/scope;
      // repeated, shared and custom registrations keep their original synchronous contract.
      if (owner.hasRegisteredHistory || owner.shared || runtime.target.ref.kind !== "main" ||
        !isFunctionConversationNativeMainRuntime(runtime) || !originalHistoricalStore(owner.store) ||
        !isFunctionConversationNativeCheckpointStore(owner.store, runtime.target.ref))
        return projection.registerHistorical(messages, proof)
      // retainInput has already published this turn's input before history preparation.
      // It is independent of the checkpoint history. Only reusing an entry in this actual
      // history would require current(previous) and must keep the synchronous source path.
      const values = arrayItems(messages)
      for (let index = 0; index < values.length; index++) {
        const value = values[index]
        if (object(value) && privateValue(natives, value)?.owner === owner)
          return projection.registerHistorical(messages, proof)
      }
      let drained!: () => void
      const operation = { failed: false, drained: new Promise<void>(resolve => { drained = resolve }) }
      owner.pendingHistory = operation
      try {
        const signal = AbortSignal.any([invocationSignal, owner.signal, runtime.target.signal])
        return prepareNativeHistoricalAsync(owner, messages, proof, signal, operation, drained)
      } catch (error) {
        operation.failed = true
        owner.pendingHistory = undefined
        drained()
        throw error
      }
    },
    registerIntake(publication: FunctionConversationIntakePublication): void {
      assertHistoryIdle(owner)
      const prepared = withOwnerRead(owner, reader => {
        const { runtime, store } = owner, target = runtime.target.ref
        const intake = reader.runGuard(() => readFunctionConversationIntakePublication(publication, store, target))
        if (intake.notes.length !== intake.rows.length) fail()
        const prepared = intake.notes.map((message, index) => prepareEntry(owner, message,
          intake.rows[index], reader, () => {
            const currentIntake = readFunctionConversationIntakePublication(publication, store, target)
            if (currentIntake.notes[index] !== message ||
              currentIntake.rows[index].uuid !== intake.rows[index].uuid) fail()
            return currentIntake.rows[index]
          }, true))
        reader.runGuard(() => intake.assertCurrent())
        reader.runGuard(() => runtime.assertCurrent())
        if (owner.closed) fail()
        finishEntryGuards(owner, prepared, reader)
        return prepared
      })
      adoptEntries(owner, prepared)
    },
    omitMessage(message: unknown): boolean {
      assertHistoryIdle(owner)
      if (!object(message)) return false
      const entry = privateValue(natives, message) ?? privateValue(wires, message)?.entry
      if (!entry) return false
      const wire = privateValue(wires, message)
      if (entry.owner !== owner) return omitSharedChild(message, entry, wire)
      if (wire && digest(message) !== wire.digest) fail()
      current(entry)
      assertEntryData(entry)
      if (wire && (privateValue(wires, message) !== wire || digest(message) !== wire.digest)) fail()
      return entry.presentation.kind !== "visible"
    },
    validate(mode: string, payload: unknown): void {
      assertHistoryIdle(owner)
      const checkedWires: Array<{ value: object; wire: Wire }> = []
      const checkedEntries = new Set<Entry>()
      const activeBatch: HistoricalFirstRead[] = []
      try { withOwnerRead(owner, reader => {
        if (owner.closed) fail()
        reader.runGuard(() => input.runtime.assertCurrent())
        const values: unknown[] = []
        if (mode === "messages" && Array.isArray(payload)) values.push(ownData(payload, "0"))
        else if (mode === "values" || mode === "invoke") {
          const messages = object(payload) ? ownData(payload, "messages") : undefined
          if (Array.isArray(messages)) for (const message of arrayItems(messages)) values.push(message)
        } else if (mode === "updates" && object(payload)) {
          if (types.isProxy(payload)) fail()
          for (const key of Object.keys(payload)) {
            const state = ownData(payload, key)
            const messages = object(state) ? ownData(state, "messages") : undefined
            if (Array.isArray(messages)) for (const message of arrayItems(messages)) values.push(message)
          }
        }
        // Establish discovery fingerprints before any per-entry source callback can re-enter.
        // The same synchronous reader retains fresh-B checks for every observed row. Preserve
        // repeated occurrences; no UUID deduplication may conceal differing entry snapshots.
        const snapshots: ThreadMessageWrite[] = []
        for (const value of values) {
          if (!object(value)) continue
          const entry = privateValue(natives, value) ?? privateValue(wires, value)?.entry
          if (!entry) {
            if (marked(value)) fail()
            continue
          }
          if (entry.owner !== owner) fail()
          const snapshot = reader.requireSnapshotAndPresentation(entry.uuid).snapshot
          if (!snapshot) fail()
          snapshots.push(snapshot)
        }
        if (snapshots.length) {
          const partition = reader.partition(snapshots)
          if (partition.canonicalCount !== snapshots.length || partition.ordinary.length !== 0) fail()
        }
        const batch = historicalBatch(values, owner)
        if (batch) {
          for (const value of values) if (!batch.some(item => item.value === value))
            validateMessage(value, owner, reader, checkedWires, checkedEntries)
          // Any preceding original callback can change methods, source state or membership.
          const currentBatch = historicalBatch(values, owner)
          if (currentBatch) validateHistoricalBatch(currentBatch, owner, reader,
            checkedWires, checkedEntries, activeBatch)
          else for (const { value } of batch)
            validateMessage(value, owner, reader, checkedWires, checkedEntries)
        } else for (const value of values)
          validateMessage(value, owner, reader, checkedWires, checkedEntries)
        reader.runGuard(() => input.runtime.assertCurrent())
        if (owner.closed || activeBatch.some(first => first.failed)) fail()
        eachPrivateSet(checkedEntries, assertEntryData)
        for (const { value, wire } of checkedWires) if (digest(value) !== wire.digest) fail()
      })
      eachPrivateSet(checkedEntries, assertEntryData)
      for (let index = 0; index < checkedWires.length; index++) {
        const { value, wire } = checkedWires[index]
        if (digest(value) !== wire.digest) fail()
        assertEntryData(wire.entry)
      }
      } catch (error) {
        for (let index = 0; index < activeBatch.length; index++) activeBatch[index].failed = true
        throw error
      } finally {
        // The fresh-B seal has completed: cleanup must not invoke a replaced array iterator.
        for (let index = 0; index < activeBatch.length; index++) activeBatch[index].reading = false
      }
    },
    close(): void {
      owner.closed = true
      if (owner.pendingHistory) owner.pendingHistory.failed = true
    },
    whenDrained(): Promise<void> { return owner.pendingHistory?.drained ?? Promise.resolve() }
  })
  return projection
}

/** Runs before the first toJSON. Unknown ordinary messages keep their original serializer. */
/** Classification only. The complete serializer must still validate before publishing anything. */
export function isPrivateNativeConversationStreamMessage(message: unknown): boolean {
  return object(message) &&
    (privateValue(natives, message) !== undefined || privateValue(wires, message) !== undefined)
}

/** Layout classification only. The retained original message must undergo the final full seal. */
export function privateNativeConversationStreamMessageRole(message: unknown):
  ThreadMessageWrite["role"] | undefined {
  if (!object(message)) return undefined
  return (privateValue(natives, message) ?? privateValue(wires, message)?.entry)?.role
}

export function projectNativeConversationMessageForStream(message: unknown):
  Record<string, unknown> | null {
  if (!object(message)) return null
  const existing = privateValue(wires, message)
  if (existing) { readNativeConversationStreamProjection(message); return message as Record<string, unknown> }
  const entry = privateValue(natives, message)
  // Ordinary serializers also see historical SDK notes. A public stamp never selects this
  // branch; the native route validates unknown marked echoes separately before forwarding.
  if (!entry) return null
  const { snapshot, row } = current(entry)
  const wire = createWire(snapshot, row)
  publishPrivate(wires, wire, Object.freeze({ entry, digest: digest(wire) }))
  return wire
}

/** Layout only: never registered as a native wire or accepted as publication evidence. */
export function privateNativeConversationStreamLayout(message: unknown):
  Readonly<Record<string, unknown>> | undefined {
  if (!object(message)) return undefined
  return (privateValue(natives, message) ?? privateValue(wires, message)?.entry)?.layout
}

function createLayoutView(snapshot: ThreadMessageWrite, row: FunctionConversationRow):
  Readonly<Record<string, unknown>> {
  const wire = createWire(snapshot, row)
  const kwargs = wire.kwargs as Record<string, unknown>
  const additional = kwargs.additional_kwargs as Record<string, unknown>
  // Match the layout reader's aliases, including nullish fallback and non-string rejection.
  // All inputs are freshly parsed canonical data, so no user getter executes here.
  const reasoning = additional.reasoning ?? additional.reasoning_content ?? additional.reasoning_text
  const invalidText = Object.freeze({})
  return Object.freeze({ id: Object.freeze([...(wire.id as string[])]),
    kwargs: Object.freeze({ id: kwargs.id, type: typeof kwargs.type === "string" ? kwargs.type : undefined,
      content: typeof kwargs.content === "string" ? kwargs.content : invalidText,
      additional_kwargs: Object.freeze({ reasoning: reasoning === undefined ? undefined :
        typeof reasoning === "string" ? reasoning : invalidText }),
      tool_calls: Object.freeze(Array.isArray(kwargs.tool_calls) && kwargs.tool_calls.length ? [true] : [])
    }) })
}

function createWire(snapshot: ThreadMessageWrite, row: FunctionConversationRow): Record<string, unknown> {
  const envelope = JSON.parse(row.nativePayload) as { message: { type: string; data: Record<string, unknown> } }
  const classes: Record<string, string> = { human: "HumanMessage", ai: "AIMessage",
    system: "SystemMessage", tool: "ToolMessage" }
  const kwargs: Record<string, unknown> = { ...envelope.message.data, id: snapshot.id,
    content: snapshot.content, tool_calls: snapshot.tool_calls ?? [],
    additional_kwargs: { ...(envelope.message.data.additional_kwargs as Record<string, unknown>),
      function_row: snapshot.function_row,
      ...(snapshot.provider_source_id !== undefined ?
        { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: snapshot.provider_source_id } : {}),
      ...(snapshot.provider_occurrence !== undefined ?
        { [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: snapshot.provider_occurrence } : {}) },
    ...(snapshot.reasoning !== undefined ? { reasoning: snapshot.reasoning } : {}),
    ...(snapshot.status !== undefined ? { status: snapshot.status } : {}),
    ...(snapshot.is_error !== undefined ? { is_error: snapshot.is_error } : {}),
    created_at: snapshot.created_at.toISOString() }
  // Full canonical calls are authoritative. Chunk arguments must never re-enter delta hydration.
  delete kwargs.tool_call_chunks
  const wire = { lc: 1, type: "constructor", id: ["langchain_core", "messages",
    classes[envelope.message.type]], kwargs }
  return wire
}

/** Only an exact private wire object can expose its already committed projection snapshot. */
export function readNativeConversationStreamProjection(message: unknown, expectedThreadId?: string):
  ThreadMessageWrite | null {
  if (!object(message)) return null
  const wire = privateValue(wires, message)
  if (!wire) return null
  if (expectedThreadId !== undefined && expectedThreadId !== wire.entry.owner.runtime.destination.threadId)
    fail()
  if (digest(message) !== wire.digest) fail()
  const snapshot = current(wire.entry).snapshot
  // current runs actual source callbacks before its final fresh B. They can mutate a wire.
  if (privateValue(wires, message) !== wire || digest(message) !== wire.digest) fail()
  assertEntryData(wire.entry)
  return snapshot
}

/** Known host serialization may duplicate a wire, but cannot change any field or mint by ID. */
export function transferNativeConversationStreamProjection(source: unknown, target: unknown): void {
  if (!object(source) || !object(target)) fail()
  const wire = privateValue(wires, source)
  if (!wire || digest(source) !== wire.digest || digest(target) !== wire.digest) fail()
  current(wire.entry)
  if (privateValue(wires, source) !== wire || digest(source) !== wire.digest || digest(target) !== wire.digest)
    fail()
  assertEntryData(wire.entry)
  publishPrivate(wires, target, wire)
}

/** Serialize only the documented stream message addresses; unrelated payload shapes stay native. */
export function serializeNativeConversationStreamData(mode: string, data: unknown): unknown {
  const entries: Entry[] = []
  const inspect = (value: unknown) => {
    if (!object(value)) return
    const entry = privateValue(natives, value) ?? privateValue(wires, value)?.entry
    if (entry) entries.push(entry)
  }
  if (mode === "messages" && Array.isArray(data)) inspect(ownData(data, "0"))
  else if (mode === "values" && object(data)) {
    const messages = ownData(data, "messages")
    if (Array.isArray(messages)) for (const message of arrayItems(messages)) inspect(message)
  } else if (mode === "updates" && object(data)) {
    if (types.isProxy(data)) fail()
    for (const key of Object.keys(data)) {
      const state = ownData(data, key), messages = object(state) ? ownData(state, "messages") : undefined
      if (Array.isArray(messages)) for (const message of arrayItems(messages)) inspect(message)
    }
  }
  if (!entries.length) return serializeInScope(mode, data).serialized
  const owner = entries[0].owner
  if (entries.some(entry => entry.owner !== owner)) fail()
  const planned = withOwnerRead(owner, reader => {
    // Match validation's batch discovery: preserve every occurrence, then retain one
    // alias/provider fingerprint through all per-entry source callbacks and fresh B.
    const snapshots = entries.map(entry => {
      const snapshot = reader.requireSnapshotAndPresentation(entry.uuid).snapshot
      if (!snapshot) fail()
      return snapshot
    })
    const partition = reader.partition(snapshots)
    if (partition.canonicalCount !== snapshots.length || partition.ordinary.length !== 0) fail()
    return serializeInScope(mode, data, reader, new Set(entries))
  })
  const checkedEntries = new Set<Entry>()
  for (let index = 0; index < entries.length; index += 1)
    Reflect.apply(projectionSetAdd, checkedEntries, [entries[index]])
  eachPrivateSet(checkedEntries, assertEntryData)
  // All observations B succeeded. Only pure comparisons and WeakMap publication remain.
  for (const { source, target, wire } of planned.transfers)
    if (digest(source) !== wire.digest || digest(target) !== wire.digest) fail()
  for (const { source, target, wire } of planned.transfers) {
    publishPrivate(wires, source, wire)
    publishPrivate(wires, target, wire)
  }
  return planned.serialized
}

function serializeInScope(mode: string, data: unknown, reader?: CanonicalThreadMessageReadScope,
  partitionedEntries?: ReadonlySet<Entry>) {
  const partitioned = (entry: Entry) => !!partitionedEntries &&
    Reflect.apply(projectionSetHas, partitionedEntries, [entry]) === true
  const omitted = Symbol("private-native-message-omitted")
  const replacements: Array<{ path: readonly (string | number)[];
    source: Record<string, unknown>; wire: Wire }> = []
  const replace = (value: unknown, path: readonly (string | number)[]) => {
    const entry = object(value) ? privateValue(natives, value) ?? privateValue(wires, value)?.entry : undefined
    if (!entry) return value
    if (!reader) fail()
    const existing = privateValue(wires, value as object)
    if (existing && digest(value) !== existing.digest) fail()
    const { snapshot, row } = current(entry, reader, partitioned(entry))
    if (entry.presentation.kind !== "visible") return omitted
    const source = existing ? value as Record<string, unknown> : createWire(snapshot, row)
    const wire = existing ?? Object.freeze({ entry, digest: digest(source) })
    replacements.push({ path, source, wire })
    return source
  }
  let prepared: unknown = data
  const messagesForDisplay = (messages: readonly unknown[], path: readonly (string | number)[]) => {
    const visible: unknown[] = []
    // Validate every original occurrence. Only the serialized UI copy uses filtered indices.
    for (const message of arrayItems(messages)) {
      const next = replace(message, [...path, visible.length])
      if (next !== omitted) visible.push(next)
    }
    return visible
  }
  if (mode === "messages" && Array.isArray(data)) {
    const message = replace(ownData(data, "0"), [0])
    if (message === omitted) return { serialized: undefined, transfers: [] }
    prepared = replacements.length ? [message, {
      ...(object(data[1]) ? data[1] : {}),
      [STREAM_MESSAGE_CONTENT_MODE_KEY]: "snapshot",
      [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot",
      [STREAM_MESSAGE_TOOL_CALLS_MODE_KEY]: "snapshot"
    }, ...data.slice(2)] : [message, ...data.slice(1)]
  }
  else if (mode === "values" && object(data)) {
    const messages = ownData(data, "messages")
    if (Array.isArray(messages)) prepared = { ...data, messages:
      messagesForDisplay(messages, ["messages"]) }
  } else if (mode === "updates" && object(data)) {
    const states: Record<string, unknown> = { ...data }
    for (const key of Object.keys(states)) {
      const state = states[key]
      const messages = object(state) ? ownData(state, "messages") : undefined
      if (object(state) && Array.isArray(messages)) states[key] = { ...state, messages:
        messagesForDisplay(messages, [key, "messages"]) }
    }
    prepared = states
  }
  const serialized: unknown = JSON.parse(reader ? reader.runGuard(() => JSON.stringify(prepared)) :
    JSON.stringify(prepared))
  const transfers: Array<{ source: Record<string, unknown>; target: object; wire: Wire }> = []
  for (const { path, source, wire } of replacements) {
    let target: unknown = serialized
    for (const key of path) target = object(target) ? ownData(target, String(key)) : undefined
    if (!object(target) || digest(source) !== wire.digest || digest(target) !== wire.digest || !reader) fail()
    current(wire.entry, reader, partitioned(wire.entry))
    transfers.push({ source, target, wire })
  }
  for (const { source, target, wire } of transfers) {
    assertEntryData(wire.entry)
    if (digest(source) !== wire.digest || digest(target) !== wire.digest) fail()
  }
  return { serialized, transfers }
}
