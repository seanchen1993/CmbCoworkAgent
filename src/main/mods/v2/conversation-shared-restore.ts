import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { types } from "node:util"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"
import { assertFunctionConversationState, readFunctionConversationState,
  type FunctionConversationState } from "../../checkpointer/function-conversation-delivery"
import { captureConversationCheckpointRead, readFunctionConversationCheckpointMembership } from
  "../../checkpointer/function-conversation-checkpoint-membership"
import type { FunctionConversationCheckpointMembershipProof,
  FunctionConversationCheckpointMembershipSnapshot } from
  "../../checkpointer/function-conversation-checkpoint-membership"
import { BaseMessage, HumanMessage } from "@langchain/core/messages"
import { functionConversationState, readFunctionConversationIntakePublication,
  type FunctionConversationIntakePublication } from "../../agent/mods-conversation"
import { inspectFunctionConversationAdmission } from "../../agent/function-conversation-admission"
import { captureNativeSharedOrdinaryMessageData, type NativeSharedOrdinaryMessageData } from
  "../../agent/native-shared-ordinary-message-data"
import { serializeFunctionConversationNativeMessage } from "../../agent/function-conversation-native-message"
import { readFunctionConversationTranscriptStamp, sameFunctionConversationTranscriptStamp } from
  "../../../shared/mods/v2/conversation-transcript"
import { functionConversationCanonicalStamp, functionConversationRowDigest } from
  "../../checkpointer/function-conversation-checkpoint-membership"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { getDb, getThreadCore } from "../../db"
import { readFunctionConversationNativeDestination,
  assertFunctionConversationNativeDestinationDataCurrent,
  withFunctionConversationNativeDestinationDataScope,
  type FunctionConversationNativeDestination } from "../../db/function-conversation-native-destination"
import { readFunctionConversationStoreReceipt,
  captureFunctionConversationPendingReceiptDataCheck,
  type FunctionConversationStore, type FunctionConversationRef } from "../../db/function-conversation-store"
import { captureFunctionConversationNativeSqlitePreparedExecution,
  type NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../../services/thread-incarnation"
import { isModRuntimeAuthorityDataCurrent, type ModRuntimeAuthority } from "../runtime-instance"
import { FunctionConversationSharedCheckpointScope, readFunctionConversationSharedNativeRead,
  isFunctionConversationSharedCheckpointScopeDataClosed,
  type FunctionConversationSharedNativeRead } from "./conversation-shared-checkpointer"
import type { FunctionConversationCoordinator,
  FunctionConversationSharedNativeRegistration,
  FunctionConversationSharedNativeRegistrationView } from "./conversation-coordinator"
import { readFunctionConversationSharedNativeRegistration,
  bindFunctionConversationSharedRegistrationPostflight } from "./conversation-coordinator"
import { readFunctionConversationSharedSourceCurrent } from "./conversation-shared-source-current"


const brand = Symbol("function-conversation-shared-restore")
const activeBrand = Symbol("function-conversation-shared-active")
const producerBrand = Symbol("function-conversation-shared-producer")
const historicalTargetBrand = Symbol("function-conversation-shared-historical-target")
export interface FunctionConversationSharedRestore { readonly [brand]: true }
export interface FunctionConversationSharedActive { readonly [activeBrand]: true }
export interface FunctionConversationSharedProducer { readonly [producerBrand]: true }
export interface FunctionConversationSharedHistoricalTarget { readonly [historicalTargetBrand]: true }
interface HistoricalCheckpointPoint {
  readonly checkpointThreadId: string
  readonly checkpointIncarnation: Readonly<ThreadIncarnation>
  readonly checkpointIncarnationKey: string
  readonly checkpointId: string
  readonly namespace: string
}
export interface FunctionConversationSharedReturnHistory {
  readonly messages: readonly BaseMessage[]
  readonly membership: FunctionConversationCheckpointMembershipProof
  readonly historicalTarget?: FunctionConversationSharedHistoricalTarget
  assertCurrent(): void
  assertDataCurrent(): void
}
/** Already-qualified ordinary tuple input addresses, never membership or publication authority. */
export interface FunctionConversationSharedOrdinaryReturnInputs {
  prepare(): Readonly<{
    capture(message: BaseMessage): Readonly<{ assertDataCurrent(): void }> | undefined
    assertDataCurrent(): void
  }>
  assertDataCurrent(): void
}
export interface FunctionConversationSharedProducerView {
  readonly coordinator: FunctionConversationCoordinator
  readonly database: NativeSqliteAdapter
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly nativeRead: FunctionConversationSharedNativeRead
  readonly config: ReturnType<typeof readFunctionConversationSharedNativeRead>["config"]
  readonly namespace: string
  readonly owner: object
  readonly target: FunctionConversationSharedNativeRegistrationView["target"]
  readonly binding: FunctionConversationGraphBinding
  readonly destination: FunctionConversationNativeDestination
  readonly signal: AbortSignal
  readonly history?: FunctionConversationSharedReturnHistory
  readonly ordinaryReturnInputs?: FunctionConversationSharedOrdinaryReturnInputs
  readonly intake?: FunctionConversationIntakePublication
  assertCurrent(): void
  assertDataCurrent(): void
}
interface Active {
  readonly database: NativeSqliteAdapter
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly nativeRead: FunctionConversationSharedNativeRead
  readonly nativeView: ReturnType<typeof readFunctionConversationSharedNativeRead>
  readonly signal: AbortSignal
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly reservation: object
  readonly key: string
  readonly assertCurrent: () => void
  readonly assertDataCurrent: () => void
  readonly sourceCurrent?: NonNullable<ReturnType<typeof readFunctionConversationSharedSourceCurrent>>
  retiring: boolean
  released: boolean
  completed?: { readonly target: FunctionConversationRef;
    readonly destination: FunctionConversationNativeDestination
    readonly restored: boolean
    readonly restore?: FunctionConversationSharedRestore }
}
interface Restore {
  readonly database: NativeSqliteAdapter
  readonly store: FunctionConversationStore
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly nativeRead: FunctionConversationSharedNativeRead
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly parent: FunctionConversationRef
  readonly target: FunctionConversationRef
  readonly state: FunctionConversationState
  readonly destination: FunctionConversationNativeDestination
  readonly active: FunctionConversationSharedActive
  readonly assertCurrent: () => void
  readonly history?: FunctionConversationSharedReturnHistory
  readonly admission?: Readonly<{ highWater: number }>
  readonly pending?: Readonly<{ notes: readonly HumanMessage[];
    ordinaryReturnInputs: FunctionConversationSharedOrdinaryReturnInputs }>
  readonly checkpointPoint: HistoricalCheckpointPoint
  retiring: boolean
  released: boolean
}
const records = new WeakMap<FunctionConversationSharedRestore, Restore>()
const activeRecords = new WeakMap<FunctionConversationSharedActive, Active>()
const activeDataReaders = new WeakMap<FunctionConversationSharedActive, {
  readonly record: Active
  assertCurrent(): void
}>()
const completedActiveRecords = new WeakMap<FunctionConversationSharedActive,
  NonNullable<Active["completed"]>>()
const producerRecords = new WeakMap<FunctionConversationSharedProducer, {
  readonly authority: ModRuntimeAuthority
  readonly view: FunctionConversationSharedProducerView
}>()
const historicalTargets = new WeakMap<FunctionConversationSharedHistoricalTarget, {
  readonly messages: readonly BaseMessage[]
  readonly membership: FunctionConversationCheckpointMembershipProof
  readonly store: FunctionConversationStore
  readonly target: FunctionConversationRef
  readonly ownerTarget: FunctionConversationRef
  readonly checkpointPoint: HistoricalCheckpointPoint
  assertCurrent(): void
  assertDataCurrent(): void
}>()
const reservations = new WeakMap<NativeSqliteAdapter, Map<string, object>>()
const originalRestoreSourceCurrent = readFunctionConversationSharedSourceCurrent
const signalThrowIfAborted = AbortSignal.prototype.throwIfAborted
const dataWeakGet = WeakMap.prototype.get, dataWeakSet = WeakMap.prototype.set
const dataMapGet = Map.prototype.get
const returnInputMap = Map, returnInputMapGet = Map.prototype.get, returnInputMapSet = Map.prototype.set
const returnInputApply = Reflect.apply, returnInputFreeze = Object.freeze
const returnInputDefine = Object.defineProperty, returnInputField = Object.getOwnPropertyDescriptor
const returnInputString = String
const originalRestoreOrdinaryData = captureNativeSharedOrdinaryMessageData
function readData<K extends object, V>(records: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(dataWeakGet, records, [key]) as V | undefined
}
function fail(code = "MODS_CONVERSATION_RESTORE_CHANGED"): never { throw new ModFunctionError(code) }
function fixedIncarnation(value: ThreadIncarnation): Readonly<ThreadIncarnation> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes("token") || !keys.includes("legacyCreatedAt")) fail()
  const token = Object.getOwnPropertyDescriptor(value, "token")
  const createdAt = Object.getOwnPropertyDescriptor(value, "legacyCreatedAt")
  if (!token?.enumerable || !("value" in token) || !createdAt?.enumerable ||
    !("value" in createdAt) || (token.value !== null &&
      (typeof token.value !== "string" || !token.value)) ||
    !Number.isSafeInteger(createdAt.value) || createdAt.value < 0) fail()
  return Object.freeze({ token: token.value, legacyCreatedAt: createdAt.value })
}
function sameRef(first: FunctionConversationRef, second: FunctionConversationRef): boolean {
  return first.logicalSessionId === second.logicalSessionId && first.conversationId === second.conversationId &&
    first.branchId === second.branchId && first.threadId === second.threadId && first.workspace === second.workspace &&
    first.kind === second.kind && first.checkpointNamespace === second.checkpointNamespace &&
    first.incarnation.token === second.incarnation.token &&
    first.incarnation.legacyCreatedAt === second.incarnation.legacyCreatedAt
}

function captureActiveInputFields(value: object): (() => void) | undefined {
  if (types.isProxy(value)) return undefined
  const keys = ["nativeRead", "saver", "authority", "invocation", "scope",
    "checkpointIncarnation", "signal", "assertCurrent"]
  const prototype = Object.getPrototypeOf(value), fields: PropertyDescriptor[] = []
  for (let index = 0; index < keys.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, keys[index])
    if (!field || !("value" in field)) return undefined
    fields[index] = Object.freeze(field)
  }
  return () => {
    if (Object.getPrototypeOf(value) !== prototype) fail()
    for (let index = 0; index < keys.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, keys[index]), original = fields[index]
      if (!field || !("value" in field) || field.value !== original.value ||
        field.writable !== original.writable || field.enumerable !== original.enumerable ||
        field.configurable !== original.configurable) fail()
    }
  }
}

/** Fresh and resumed native factories reserve the same physical namespace before any new bucket. */
export function captureFunctionConversationSharedActive(input: {
  readonly nativeRead: FunctionConversationSharedNativeRead
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly checkpointIncarnation: ThreadIncarnation
  readonly signal: AbortSignal
  assertCurrent(): void
}): FunctionConversationSharedActive {
  const assertInputFields = captureActiveInputFields(input)
  const database = getDb()
  const authority = input.authority, originalScope = input.scope, signal = input.signal
  const read = readFunctionConversationSharedNativeRead(input.nativeRead, input.saver, input.authority)
  assertInputFields?.()
  if (read.scope !== input.scope) fail()
  const incarnation = fixedIncarnation(input.checkpointIncarnation)
  const candidateSource = assertInputFields && input.assertCurrent === read.assertCurrent
    ? originalRestoreSourceCurrent(input.assertCurrent, input.scope,
      input.saver, input.authority, input.invocation, database) : undefined
  const sourceCurrent = candidateSource &&
    candidateSource.checkpointIncarnation.token === incarnation.token &&
    candidateSource.checkpointIncarnation.legacyCreatedAt === incarnation.legacyCreatedAt
    ? candidateSource : undefined
  const incarnationKey = incarnation.token === null
    ? ["legacy", incarnation.legacyCreatedAt] : ["token", incarnation.token]
  const key = JSON.stringify([input.authority.threadId, incarnationKey, read.namespace])
  let active = reservations.get(database)
  if (!active) { active = new Map(); reservations.set(database, active) }
  const guard = () => {
    if (sourceCurrent) assertInputFields?.()
    input.signal.throwIfAborted(); input.authority.assertLive()
    if (sourceCurrent) {
      assertInputFields?.()
      sourceCurrent.assertDataCurrent()
      read.assertCurrent()
      sourceCurrent.assertDataCurrent()
      assertInputFields?.()
    } else { input.assertCurrent(); read.assertCurrent() }
    if (getDb() !== database || !matchesThreadIncarnation(getThreadCore(input.authority.threadId), incarnation))
      fail("MODS_CONVERSATION_THREAD_CHANGED")
    if (sourceCurrent) assertInputFields?.()
  }
  guard()
  if (active.has(key)) fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
  const reservation = Object.freeze({}), proof = Object.freeze({ [activeBrand]: true as const })
  active.set(key, reservation)
  let readingCurrent = false, failedCurrent = false
  const assertDataCurrent = () => {
    try {
      assertInputFields?.()
      if (failedCurrent || getDb() !== database || !isModRuntimeAuthorityDataCurrent(authority) ||
        isFunctionConversationSharedCheckpointScopeDataClosed(originalScope) ||
        !active || readData(reservations, database) !== active ||
        Reflect.apply(dataMapGet, active, [key]) !== reservation)
        fail("MODS_CONVERSATION_TARGET_CLOSED")
      Reflect.apply(signalThrowIfAborted, signal, [])
      sourceCurrent?.assertDataCurrent()
      assertInputFields?.()
      if (failedCurrent) fail()
    } catch (error) { failedCurrent = true; throw error }
  }
  const current = () => {
    if (!sourceCurrent) {
      guard()
      if (active?.get(key) !== reservation) fail("MODS_CONVERSATION_TARGET_CLOSED")
      return
    }
    if (readingCurrent || failedCurrent) { failedCurrent = true; fail() }
    readingCurrent = true
    try {
      guard()
      assertDataCurrent()
    } catch (error) { failedCurrent = true; throw error }
    finally { readingCurrent = false }
  }
  const record: Active = { database, saver: input.saver, authority: input.authority,
    invocation: input.invocation, nativeRead: input.nativeRead, scope: input.scope,
    nativeView: read, signal: input.signal,
    reservation, key, assertCurrent: current, assertDataCurrent, sourceCurrent,
    retiring: false, released: false }
  activeRecords.set(proof, record)
  const dataKeys = ["database", "saver", "authority", "invocation", "nativeRead", "nativeView",
    "signal", "scope", "reservation", "key", "assertCurrent", "assertDataCurrent", "sourceCurrent"]
  const prototype = Object.getPrototypeOf(record), fields: PropertyDescriptor[] = []
  for (let index = 0; index < dataKeys.length; index++)
    fields[index] = Object.getOwnPropertyDescriptor(record, dataKeys[index])!
  const retiring = Object.getOwnPropertyDescriptor(record, "retiring")!
  const released = Object.getOwnPropertyDescriptor(record, "released")!
  Reflect.apply(dataWeakSet, activeDataReaders, [proof, { record, assertCurrent: () => {
    if (Object.getPrototypeOf(record) !== prototype) fail()
    for (let index = 0; index < dataKeys.length; index++) {
      const field = Object.getOwnPropertyDescriptor(record, dataKeys[index]), original = fields[index]
      if (!field || !("value" in field) || field.value !== original.value ||
        field.writable !== original.writable || field.enumerable !== original.enumerable ||
        field.configurable !== original.configurable) fail()
    }
    const flags = ["retiring", "released"], expected = [retiring, released]
    for (let index = 0; index < flags.length; index++) {
      const field = Object.getOwnPropertyDescriptor(record, flags[index]), original = expected[index]
      if (!field || !("value" in field) || field.value !== false ||
        field.writable !== original.writable || field.enumerable !== original.enumerable ||
        field.configurable !== original.configurable) fail()
    }
    assertDataCurrent()
  } }])
  try { current() }
  catch (error) {
    input.scope.close()
    retireFunctionConversationSharedActive(proof, input.scope)
    throw error
  }
  return proof
}

/** Actual completion data only. It never reopens the one-use native read receipt. */
export function readFunctionConversationSharedCompletedActiveData(
  proof: FunctionConversationSharedActive, authority: ModRuntimeAuthority,
  destination: FunctionConversationNativeDestination) {
  const active = readData(activeRecords, proof)
  const data = readData(activeDataReaders, proof)
  if (!data || data.record !== active) return undefined
  data.assertCurrent()
  const completed = readData(completedActiveRecords, proof)
  if (!active || !completed || active.authority !== authority || !active.sourceCurrent ||
    completed.destination !== destination) return undefined
  const restore = completed.restore
  const restored = restore ? readData(records, restore) : undefined
  const pending = restored?.pending, restoredTarget = restored?.target
  const restoredStore = restored?.store, restoredCurrent = restored?.assertCurrent
  const restoredPoint = restored?.checkpointPoint
  const assertPendingRestoreData = () => {
    if (!completed.restored) {
      if (restore) fail()
      return
    }
    if (!restore || !restored || !pending || !restoredTarget || restored.history ||
      readData(records, restore) !== restored || restored.pending !== pending ||
      restored.target !== restoredTarget || restored.store !== restoredStore ||
      restored.assertCurrent !== restoredCurrent || restored.checkpointPoint !== restoredPoint ||
      restored.retiring || restored.released || restored.active !== proof ||
      restored.nativeRead !== active.nativeRead || restored.saver !== active.saver ||
      restored.authority !== active.authority || restored.invocation !== active.invocation ||
      restored.database !== active.database || restored.scope !== active.scope ||
      !sameRef(restoredTarget, completed.target)) fail()
  }
  // A committed historical restore remains on the original full fallback path.
  if (completed.restored && (!restore || !restored || !pending || restored.history)) return undefined
  assertPendingRestoreData()
  const completedField = Object.getOwnPropertyDescriptor(active, "completed")
  if (!completedField || !("value" in completedField) || completedField.value !== completed) fail()
  const assertDataCurrent = () => {
    data.assertCurrent()
    assertPendingRestoreData()
    const field = Object.getOwnPropertyDescriptor(active, "completed")
    if (!field || !("value" in field) || field.value !== completed ||
      field.writable !== completedField.writable || field.enumerable !== completedField.enumerable ||
      field.configurable !== completedField.configurable ||
      readData(activeRecords, proof) !== active || readData(activeDataReaders, proof) !== data ||
      readData(completedActiveRecords, proof) !== completed)
      fail("MODS_CONVERSATION_TARGET_CLOSED")
  }
  assertDataCurrent()
  return returnInputFreeze({ database: active.database, scope: active.scope, saver: active.saver,
    authority: active.authority, invocation: active.invocation, target: completed.target,
    destination, current: active.nativeView.assertCurrent, namespace: active.nativeView.namespace,
    pendingRestore: completed.restored ? restore : undefined, assertDataCurrent })
}

function readActive(proof: FunctionConversationSharedActive, expected: {
  readonly nativeRead: FunctionConversationSharedNativeRead; readonly saver: SqlJsSaver;
  readonly authority: ModRuntimeAuthority; readonly invocation: object;
  readonly scope: FunctionConversationSharedCheckpointScope
}): Active {
  const value = activeRecords.get(proof)
  if (!value || value.retiring || value.released || value.nativeRead !== expected.nativeRead ||
    value.saver !== expected.saver || value.authority !== expected.authority ||
    value.invocation !== expected.invocation || value.scope !== expected.scope) fail()
  value.assertCurrent()
  return value
}

/** Bind only the original fresh/restore result; reservation never creates a conversation itself. */
export function completeFunctionConversationSharedActive(proof: FunctionConversationSharedActive,
  expected: { readonly nativeRead: FunctionConversationSharedNativeRead; readonly saver: SqlJsSaver;
    readonly authority: ModRuntimeAuthority; readonly invocation: object;
    readonly scope: FunctionConversationSharedCheckpointScope; readonly parent: FunctionConversationRef;
    readonly target: FunctionConversationRef;
    readonly restore?: FunctionConversationSharedRestore;
    readonly intake?: FunctionConversationIntakePublication;
    readonly producer?: { readonly coordinator: FunctionConversationCoordinator;
      readonly registration: FunctionConversationSharedNativeRegistration }
  }): FunctionConversationSharedProducer | undefined {
  const active = readActive(proof, expected)
  if (active.completed) fail()
  const read = readFunctionConversationSharedNativeRead(expected.nativeRead, expected.saver, expected.authority)
  if (expected.target.checkpointNamespace !== read.namespace) fail()
  const destination = readFunctionConversationNativeDestination(active.database, expected.target,
    expected.parent, active.assertCurrent)
  if (destination.checkpointThreadId !== expected.authority.threadId) fail()
  const completed = Object.freeze({ target: expected.target, destination,
    restored: expected.restore !== undefined,
    ...(expected.restore ? { restore: expected.restore } : {}) })
  active.completed = completed
  Reflect.apply(dataWeakSet, completedActiveRecords, [proof, completed])
  active.assertCurrent(); destination.assertCurrent()
  if (!expected.producer) return undefined
  const registration = readFunctionConversationSharedNativeRegistration(
    expected.producer.registration, expected.producer.coordinator, expected.authority)
  if (registration.invocation !== expected.invocation ||
    registration.target.ref !== expected.target || registration.binding.target !== expected.target ||
    registration.destination.threadId !== destination.destinationThreadId ||
    registration.binding.checkpointThreadId !== destination.checkpointThreadId ||
    registration.binding.runtimeCheckpointNamespace !== read.namespace) fail()
  const dataChecker = bindFunctionConversationSharedRegistrationPostflight(
    expected.producer.registration, expected.authority, destination, proof)
  const restored = expected.restore ? readData(records, expected.restore) : undefined
  if (expected.restore && (!restored || restored.retiring || restored.released ||
    restored.active !== proof || restored.nativeRead !== expected.nativeRead ||
    restored.scope !== expected.scope || restored.saver !== expected.saver ||
    restored.authority !== expected.authority || restored.invocation !== expected.invocation ||
    restored.database !== active.database || !sameRef(restored.target, expected.target))) fail()
  const intake = expected.intake
  if (restored?.pending?.notes.length) {
    if (!intake) fail()
    const actual = readFunctionConversationIntakePublication(intake, restored.store, expected.target)
    if (actual.notes.length !== restored.pending.notes.length ||
      actual.notes.some((note, index) => note !== restored.pending!.notes[index])) fail()
  } else if (intake) fail()
  const pendingField = restored ? returnInputField(restored, "pending") : undefined
  const restoredPending = pendingField && "value" in pendingField ? pendingField.value as
    Restore["pending"] : undefined
  const ordinaryReturnInputs = restoredPending?.ordinaryReturnInputs
  ordinaryReturnInputs?.assertDataCurrent()
  const originalHistory = restored?.history
  const historicalTarget = originalHistory
    ? Object.freeze({ [historicalTargetBrand]: true as const }) : undefined
  const history: FunctionConversationSharedReturnHistory | undefined = originalHistory &&
    historicalTarget ? Object.freeze({ ...originalHistory, historicalTarget }) : undefined
  const token = Object.freeze({ [producerBrand]: true as const })
  let reading = false, failed = false
  const activeData = readData(activeDataReaders, proof)
  const completedField = Object.getOwnPropertyDescriptor(active, "completed")
  if (!activeData || activeData.record !== active || !completedField ||
    !("value" in completedField) || completedField.value !== completed) fail()
  const assertActiveData = () => {
    activeData.assertCurrent()
    const field = Object.getOwnPropertyDescriptor(active, "completed")
    if (!field || !("value" in field) || field.value !== completed ||
      field.writable !== completedField.writable || field.enumerable !== completedField.enumerable ||
      field.configurable !== completedField.configurable ||
      readData(completedActiveRecords, proof) !== completed) fail()
  }
  const reservationCurrent = () => {
    const current = readData(reservations, active.database)
    return !!current && Reflect.apply(dataMapGet, current, [active.key]) === active.reservation
  }
  const assertDataCurrent = () => {
    assertActiveData()
    if (failed || view.ordinaryReturnInputs !== ordinaryReturnInputs ||
      !isModRuntimeAuthorityDataCurrent(active.authority) ||
      getDb() !== active.database || readData(activeRecords, proof) !== active ||
      active.retiring || active.released || active.completed !== completed ||
      !reservationCurrent() ||
      isFunctionConversationSharedCheckpointScopeDataClosed(active.scope) ||
      readData(producerRecords, token)?.view !== view)
      fail("MODS_CONVERSATION_TARGET_CLOSED")
    Reflect.apply(signalThrowIfAborted, active.signal, [])
    if (dataChecker) {
      withFunctionConversationNativeDestinationDataScope(destination, active.database,
        scope => { dataChecker.assertInDestinationScope(scope) })
    } else {
      registration.assertDataCurrent()
      assertFunctionConversationNativeDestinationDataCurrent(destination, active.database)
    }
    assertActiveData()
    if (getDb() !== active.database || active.completed !== completed ||
      !reservationCurrent() || readData(producerRecords, token)?.view !== view) fail()
  }
  const assertCurrent = () => {
    if (reading || failed) { failed = true; fail() }
    reading = true
    try {
      if (active.sourceCurrent) assertDataCurrent()
      else active.assertCurrent()
      if (active.sourceCurrent) active.sourceCurrent.assertDataCurrent()
      else active.nativeView.assertCurrent()
      registration.assertCurrent()
      destination.assertCurrent()
      assertDataCurrent()
    } catch (error) { failed = true; throw error }
    finally { reading = false }
  }
  const view: FunctionConversationSharedProducerView = returnInputFreeze({
    coordinator: registration.coordinator,
    database: active.database, saver: active.saver, authority: active.authority,
    invocation: active.invocation, scope: active.scope, nativeRead: active.nativeRead,
    config: active.nativeView.config, namespace: active.nativeView.namespace,
    owner: registration.owner, target: registration.target, binding: registration.binding,
    destination, signal: active.signal, ...(history ? { history } : {}), ordinaryReturnInputs,
    ...(intake ? { intake } : {}), assertCurrent, assertDataCurrent
  })
  producerRecords.set(token, returnInputFreeze({ authority: active.authority, view }))
  view.assertCurrent()
  if (restored && expected.restore && originalHistory && historicalTarget) {
    const restoreProof = expected.restore, originalTarget = restored.target
    const originalStore = restored.store, ownerTarget = expected.target
    const checkpointPoint = restored.checkpointPoint
    let historyReading = false, historyFailed = false
    const assertHistoryTargetData = () => {
      if (historyFailed || readData(records, restoreProof) !== restored ||
        restored.history !== originalHistory || restored.store !== originalStore ||
        restored.target !== originalTarget || restored.checkpointPoint !== checkpointPoint ||
        restored.retiring || restored.released ||
        readData(activeRecords, proof) !== active ||
        readData(completedActiveRecords, proof) !== completed ||
        completed.target !== ownerTarget || readData(producerRecords, token)?.view !== view ||
        view.history !== history || view.target.ref !== ownerTarget) fail()
      originalHistory.assertDataCurrent()
      view.assertDataCurrent()
      originalHistory.assertDataCurrent()
      if (historyFailed || readData(records, restoreProof) !== restored ||
        readData(producerRecords, token)?.view !== view ||
        readData(completedActiveRecords, proof) !== completed) fail()
    }
    const assertHistoryTargetCurrent = () => {
      if (historyReading || historyFailed) { historyFailed = true; fail() }
      historyReading = true
      try {
        assertHistoryTargetData()
        originalHistory.assertCurrent()
        assertHistoryTargetData()
      } catch (error) { historyFailed = true; throw error }
      finally { historyReading = false }
    }
    // Only a successful original complete/Producer publication creates this target relation.
    Reflect.apply(dataWeakSet, historicalTargets, [historicalTarget, Object.freeze({
      messages: originalHistory.messages, membership: originalHistory.membership,
      store: originalStore, target: originalTarget, ownerTarget, checkpointPoint,
      assertCurrent: assertHistoryTargetCurrent,
      assertDataCurrent() {
        try { if (historyReading) fail(); assertHistoryTargetData() }
        catch (error) { historyFailed = true; throw error }
      }
    })])
  }
  return token
}

/** Exact target relation only; the projection retains its original full membership/row checks. */
export function readFunctionConversationSharedHistoricalTarget(
  token: FunctionConversationSharedHistoricalTarget, messages: readonly BaseMessage[],
  proof: FunctionConversationCheckpointMembershipProof, store: FunctionConversationStore,
  target: FunctionConversationRef) {
  const original = readData(historicalTargets, token)
  // This gate must precede the projection's read scope and every runtime/source callback.
  if (!original || original.messages !== messages || original.membership !== proof ||
    original.store !== store || original.ownerTarget !== target) fail()
  original.assertDataCurrent()
  return Object.freeze({ target: original.target, checkpointPoint: original.checkpointPoint,
    assertCurrent: original.assertCurrent,
    assertDataCurrent: original.assertDataCurrent })
}

/** The actual admission upgrades fixed data identity, without extending the one-use native read. */
export function readFunctionConversationSharedProducer(proof: FunctionConversationSharedProducer,
  authority: ModRuntimeAuthority): FunctionConversationSharedProducerView {
  const original = producerRecords.get(proof)
  if (!original || original.authority !== authority) fail()
  original.view.assertCurrent()
  return original.view
}

export function retireFunctionConversationSharedActive(proof: FunctionConversationSharedActive,
  scope: FunctionConversationSharedCheckpointScope): void {
  const value = activeRecords.get(proof)
  if (!value || value.scope !== scope || !scope.isClosed()) fail()
  if (value.retiring) return
  value.retiring = true
  void scope.whenDrained().then(() => {
    const active = reservations.get(value.database)
    if (active?.get(value.key) !== value.reservation) return
    active.delete(value.key)
    value.released = true
  }, () => undefined)
}

const originalRestoreDestinationReader = readFunctionConversationNativeDestination
const originalRestorePreparedExecution = captureFunctionConversationNativeSqlitePreparedExecution
const originalRestoreReceipt = readFunctionConversationStoreReceipt
const originalPendingReceiptDataCheck = captureFunctionConversationPendingReceiptDataCheck
const restoreDescriptor = Object.getOwnPropertyDescriptor, restorePrototype = Object.getPrototypeOf
const restoreCreate = Object.create, restoreIsProxy = types.isProxy

/** Fixed addresses of this Restore call, independent of Host-input field capture. */
function capturePendingRestoreInput(value: object): (() => void) | undefined {
  if (restoreIsProxy(value)) return undefined
  const prototype = restorePrototype(value)
  const keys = ["nativeRead", "saver", "authority", "invocation", "scope", "parentBinding",
    "store", "active", "checkpointIncarnation", "signal", "assertCurrent"]
  const fields = restoreCreate(null) as Record<string, PropertyDescriptor>
  for (let index = 0; index < keys.length; index++) {
    const field = restoreDescriptor(value, keys[index])
    if (!field || !("value" in field)) return undefined
    fields[keys[index]] = field
  }
  return () => {
    if (restoreIsProxy(value) || restorePrototype(value) !== prototype) fail()
    for (let index = 0; index < keys.length; index++) {
      const field = restoreDescriptor(value, keys[index]), original = fields[keys[index]]
      if (!field || !("value" in field) || field.value !== original.value ||
        field.writable !== original.writable || field.enumerable !== original.enumerable ||
        field.configurable !== original.configurable) fail()
    }
  }
}

/** Initial task updates prove an intake cut, never a committed checkpoint or delivery. */
function preparePendingSharedRestore(
  input: Parameters<typeof prepareFunctionConversationSharedRestore>[0], database: NativeSqliteAdapter,
  read: ReturnType<typeof readFunctionConversationSharedNativeRead>, active: Active
): FunctionConversationSharedRestore {
  const assertRestoreInput = capturePendingRestoreInput(input)
  const tuple = read.tuple, source = read.pendingNamespace, parent = input.parentBinding.target
  if (!tuple || !source || tuple.metadata?.step !== 1) fail()
  const initialCurrent = () => {
    assertRestoreInput?.()
    input.signal.throwIfAborted(); input.authority.assertLive()
    const original = assertRestoreInput && originalRestoreSourceCurrent(read.assertCurrent, input.scope,
      input.saver, input.authority, input.invocation, database)
    assertRestoreInput?.()
    const contained = assertRestoreInput && original && active.sourceCurrent &&
      original.source === input.assertCurrent &&
      original.parentBinding === input.parentBinding && original.signal === input.signal &&
      original.checkpointIncarnation === input.checkpointIncarnation &&
      active.sourceCurrent.source === original.source &&
      active.sourceCurrent.receiver === original.receiver && active.database === database &&
      active.saver === input.saver && active.authority === input.authority &&
      active.invocation === input.invocation && active.nativeRead === input.nativeRead &&
      active.scope === input.scope && active.signal === input.signal &&
      active.nativeView.assertCurrent === read.assertCurrent
    if (contained) active.assertCurrent()
    else {
      input.assertCurrent(); input.parentBinding.assertCurrent()
      read.assertCurrent(); active.assertCurrent()
    }
    if (getDb() !== database || !matchesThreadIncarnation(getThreadCore(input.authority.threadId),
      input.checkpointIncarnation)) fail("MODS_CONVERSATION_THREAD_CHANGED")
    source.assertInputDataCurrent()
    assertRestoreInput?.()
  }
  initialCurrent()
  const selected = source.writes.filter(write => write.checkpointId === tuple.checkpoint.id)
  const stateWrites = selected.filter(write => write.channel === "cmbFunctionConversation")
  if (stateWrites.length !== 1) fail()
  const readPendingState = () => {
    const value = stateWrites[0].value
    if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field || !("value" in field)) fail()
    }
    return readFunctionConversationState(value)
  }
  const pendingState = readPendingState()
  const highWater = pendingState.frontier
  // The qualified zero-note form still carries its original ordinary input, not intake notes.
  if (highWater < 0) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (selected.length !== 3 || !selected[0].taskId ||
    selected.some(write => write.taskId !== selected[0].taskId || write.type !== "json") ||
    selected.map(write => write.channel).sort().join("\0") !==
      ["branch:to:model_request", "cmbFunctionConversation", "messages"].join("\0") ||
    selected.find(write => write.channel === "branch:to:model_request")!.value !== null) fail()
  const incoming = selected.find(write => write.channel === "messages")!.value
  if (!Array.isArray(incoming) || types.isProxy(incoming) ||
    Object.getPrototypeOf(incoming) !== Array.prototype || !incoming.every(HumanMessage.isInstance)) fail()
  const rawMessages = tuple.checkpoint.channel_values.messages
  if (rawMessages !== undefined && (!Array.isArray(rawMessages) || types.isProxy(rawMessages) ||
    !rawMessages.every(BaseMessage.isInstance))) fail()
  if (inspectFunctionConversationAdmission({ state: undefined,
    messages: rawMessages as BaseMessage[] | undefined }, initialCurrent).kind !== "ordinary") fail()

  for (const write of source.writes) {
    if (write.checkpointId === tuple.checkpoint.id) continue
    if (write.type !== "json") fail()
    if (write.channel === "messages") {
      if (!Array.isArray(write.value) || !write.value.every(BaseMessage.isInstance) ||
        inspectFunctionConversationAdmission({ state: undefined, messages: write.value }, initialCurrent)
          .kind !== "ordinary") fail()
    } else if (!write.channel.startsWith("branch:to:") || write.value !== null) fail()
  }
  const candidates = database.exec(`SELECT c.conversation_id,c.root_branch_id
    FROM function_conversations c JOIN function_logical_sessions s ON s.logical_session_id=c.logical_session_id
    JOIN function_conversation_native_destinations d ON d.conversation_id=c.conversation_id
      AND d.branch_id=c.root_branch_id
    WHERE s.logical_session_id=? AND s.thread_id=? AND s.workspace=? AND c.kind='child'
      AND c.checkpoint_namespace=? AND d.checkpoint_thread_id=? LIMIT 2`,
    [parent.logicalSessionId, parent.threadId, parent.workspace, read.namespace, input.authority.threadId])[0]?.values ?? []
  if (candidates.length !== 1 || candidates[0][0] !== pendingState.conversationId ||
    candidates[0][1] !== pendingState.branchId || pendingState.logicalSessionId !== parent.logicalSessionId) fail()
  const target: FunctionConversationRef = Object.freeze({ ...parent,
    incarnation: Object.freeze({ ...parent.incarnation }), conversationId: pendingState.conversationId,
    branchId: pendingState.branchId, kind: "child", checkpointNamespace: read.namespace })
  const inbox = input.store.captureInbox(target, 0, highWater)
  const noteCount = inbox.rows.length
  const ordinaryInput = noteCount === 0
  if (!ordinaryInput && incoming.length !== noteCount) fail()
  if (ordinaryInput) {
    if (!Array.isArray(rawMessages) || rawMessages.length === 0 ||
      !rawMessages.every(HumanMessage.isInstance) || incoming.length !== rawMessages.length ||
      inspectFunctionConversationAdmission({ state: undefined, messages: incoming }, initialCurrent)
        .kind !== "ordinary") fail()
    for (let index = 0; index < incoming.length; index++) {
      const original = rawMessages[index], update = incoming[index]
      if (update.id !== original.id || serializeFunctionConversationNativeMessage(update) !==
        serializeFunctionConversationNativeMessage(original)) fail()
    }
  }
  const base = () => { initialCurrent(); input.store.assertCurrent(parent); input.store.assertCurrent(target) }
  const destinationReader = readFunctionConversationNativeDestination
  const destination = destinationReader(database, target, parent, base)
  if (destination.checkpointThreadId !== input.authority.threadId ||
    destination.checkpointIncarnation.token !== input.checkpointIncarnation.token ||
    (destination.checkpointIncarnation.token === null &&
      destination.checkpointIncarnation.legacyCreatedAt !== input.checkpointIncarnation.legacyCreatedAt)) fail()
  const pendingMessages = Object.freeze([...incoming] as HumanMessage[])
  const notes = ordinaryInput ? Object.freeze([] as HumanMessage[]) : pendingMessages
  const messageSources: NativeSharedOrdinaryMessageData[] = []
  const rawMessageCount = (rawMessages as BaseMessage[] | undefined)?.length ?? 0
  const incomingMessageCount = incoming.length
  for (let group = 0; group < 2; group++) {
    const values = group === 0 ? rawMessages as BaseMessage[] | undefined : incoming
    if (!values) continue
    const count = group === 0 ? rawMessageCount : incomingMessageCount
    for (let index = 0; index < count; index++) {
      const field = returnInputField(values, returnInputString(index))
      if (!field || !("value" in field)) fail()
      const message = field.value as BaseMessage
      const baseline = originalRestoreOrdinaryData(message)
      if (baseline.message !== message) fail()
      const descriptor = { __proto__: null, value: baseline, enumerable: true,
        writable: true, configurable: true }
      returnInputDefine(messageSources, messageSources.length, descriptor)
    }
  }
  const stateFields = Object.freeze({ ...pendingState })
  const rowDigests = inbox.rows.map(functionConversationRowDigest)
  for (let index = 0; index < inbox.rows.length; index++) {
    const row = inbox.rows[index], note = notes[index]
    const stamp = readFunctionConversationTranscriptStamp(note)
    if (row.sequence <= (index === 0 ? 0 : inbox.rows[index - 1].sequence) ||
      row.sequence > highWater || row.branchId !== target.branchId || !row.inbox ||
      !stamp || note.id !== row.uuid ||
      !sameFunctionConversationTranscriptStamp(stamp, functionConversationCanonicalStamp(target, row)) ||
      serializeFunctionConversationNativeMessage(note) !== row.nativePayload) fail()
  }
  const assertInputs = () => {
    source.assertInputDataCurrent()
    const current = readPendingState()
    if (JSON.stringify(current) !== JSON.stringify(stateFields) ||
      incoming.length !== pendingMessages.length ||
      pendingMessages.some((message, index) => incoming[index] !== message)) fail()
    for (let index = 0; index < messageSources.length; index++)
      messageSources[index].assertOriginalDataCurrent()
  }
  const ordinaryReturnInputs = returnInputFreeze({ assertDataCurrent: assertInputs,
    prepare() {
      assertInputs()
      // Only a native domain needs this index, replacing its empty history-return index.
      const ordinarySources = new returnInputMap<BaseMessage, NativeSharedOrdinaryMessageData>()
      for (let group = 0; group < (ordinaryInput ? 2 : 1); group++) {
        const values = group === 0 ? rawMessages as BaseMessage[] | undefined : incoming
        const count = group === 0 ? rawMessageCount : incomingMessageCount
        if (!values) continue
        for (let index = 0; index < count; index++) {
          const field = returnInputField(values, returnInputString(index))
          const baseline = messageSources[(group === 0 ? 0 : rawMessageCount) + index]
          if (!field || !("value" in field) || !baseline || baseline.message !== field.value) fail()
          // Pending notes still require their real Intake publication, never this input index.
          returnInputApply(returnInputMapSet, ordinarySources, [field.value, baseline])
        }
      }
      assertInputs()
      return returnInputFreeze({ assertDataCurrent: assertInputs, capture(message: BaseMessage) {
        const baseline = returnInputApply(returnInputMapGet, ordinarySources, [message]) as
          NativeSharedOrdinaryMessageData | undefined
        return baseline?.captureCurrentData()
      } })
    } })
  const current = () => {
    if (destinationReader !== originalRestoreDestinationReader) base()
    destination.assertCurrent(); assertInputs()
    for (let index = 0; index < inbox.rows.length; index++) {
      const row = originalRestoreReceipt(input.store, target, inbox.rows[index].uuid)
      if (!row || functionConversationRowDigest(row) !== rowDigests[index]) fail()
    }
    base(); assertInputs()
  }
  const appExecution = originalRestorePreparedExecution(database)
  if (!appExecution) fail()
  const mappingKeys = ["conversation_id", "branch_id", "target_json", "parent_json", "invocation_id",
    "checkpoint_thread_id", "checkpoint_incarnation", "destination_thread_id", "destination_incarnation",
    "metadata_json", "metadata_digest"] as const
  const mappingRead = appExecution.prepareReadOne(`SELECT ${mappingKeys.join(",")}
    FROM main.function_conversation_native_destinations WHERE conversation_id=? AND branch_id=?`)
  const originalMapping = mappingRead([target.conversationId, target.branchId])
  if (!originalMapping) fail()
  const threadRead = appExecution.prepareReadOne("SELECT created_at,metadata FROM main.threads WHERE thread_id=?")
  const threadIds = [...new Set([parent.threadId, target.threadId,
    destination.checkpointThreadId, destination.destinationThreadId])]
  const originalThreads = threadIds.map(id => threadRead([id]))
  if (originalThreads.some(row => !row)) fail()
  const admittedNotes: Array<Readonly<{ uuid: string; rowDigest: string }>> = []
  for (let index = 0; index < inbox.rows.length; index++) {
    const value = { uuid: inbox.rows[index].uuid, rowDigest: rowDigests[index] }
    const descriptor = { __proto__: null, value, writable: true, enumerable: true, configurable: true }
    returnInputDefine(admittedNotes, index, descriptor)
  }
  const assertPendingReceiptData = originalPendingReceiptDataCheck(input.store, target, {
    checkpointThreadId: destination.checkpointThreadId,
    checkpointIncarnation: fixedIncarnation(input.checkpointIncarnation),
    namespace: read.namespace, selectedCheckpointId: source.checkpointId,
    admittedNotes })
  const admissionFacts = appExecution.prepareReadOne(`SELECT
      (SELECT COUNT(*) FROM main.function_conversation_deliveries WHERE conversation_id=?) AS deliveries,
      (SELECT COUNT(*) FROM main.function_conversation_inbox WHERE conversation_id=?) AS inbox,
      (SELECT COUNT(*) FROM main.function_conversation_rows WHERE conversation_id=?
        AND CASE WHEN door='note' THEN json_type(payload_json,'$.inbox')='true' ELSE 0 END) AS notes,
      (SELECT COUNT(*) FROM main.function_conversation_inbox WHERE conversation_id=? AND branch_id=?
        AND sequence BETWEEN 1 AND ?) AS prefix,
      (SELECT COUNT(*) FROM main.function_conversation_rows r LEFT JOIN main.function_conversation_inbox i
        ON i.conversation_id=r.conversation_id AND i.uuid=r.uuid AND i.branch_id=r.branch_id
          AND i.sequence=r.sequence WHERE r.conversation_id=?
          AND i.uuid IS NULL AND CASE WHEN r.door='note'
            THEN json_type(r.payload_json,'$.inbox')='true' ELSE 0 END) AS missingInbox,
      (SELECT COUNT(*) FROM main.function_conversation_inbox i LEFT JOIN main.function_conversation_rows r
        ON r.conversation_id=i.conversation_id AND r.uuid=i.uuid AND r.branch_id=i.branch_id
          AND r.sequence=i.sequence WHERE i.conversation_id=? AND
          (i.branch_id<>? OR CASE WHEN r.uuid IS NULL OR r.door<>'note' THEN 1
            ELSE json_type(r.payload_json,'$.inbox') IS NOT 'true' END)) AS extraInbox,
      (SELECT COUNT(*) FROM main.function_conversation_rows WHERE conversation_id=? AND
        CASE WHEN door='note' THEN
          (json_extract(payload_json,'$.message.type') NOT IN ('user','system')
          OR json_type(payload_json,'$.message.type') IS NOT 'text'
          OR (json_extract(payload_json,'$.message.type')='user' AND
            (json_type(payload_json,'$.inbox') IS NOT 'true'
              OR json_type(payload_json,'$.message.isMeta') IS NOT 'true'
              OR (json_type(payload_json,'$.message.role') IS NOT NULL
                AND json_extract(payload_json,'$.message.role') IS NOT 'user')))
          OR (json_extract(payload_json,'$.message.type')='system'
            AND json_type(payload_json,'$.inbox') IS NOT 'false')) ELSE 0 END) AS invalidNotes`)

  const assertAdmissionCurrent = () => {
    current()
    appExecution.assertDataCurrent(true)
    const all = input.store.captureInbox(target, 0)
    if (all.rows.length > 64 || all.rows.some((row, index) =>
      row.sequence <= (index === 0 ? 0 : all.rows[index - 1].sequence) ||
      row.sequence > all.highWater || row.branchId !== target.branchId || !row.inbox || row.door !== "note" ||
      row.message.type !== "user" || row.message.isMeta !== true ||
      (row.message.role !== undefined && row.message.role !== "user"))) fail()
    destination.assertCurrent()
    current()
    // All potentially customized guards precede the original native data-only fences.
    source.assertAdmissionCurrent()
    assertPendingReceiptData()
    appExecution.assertDataCurrent(true)
    const facts = admissionFacts([
      target.conversationId, target.conversationId, target.conversationId,
      target.conversationId, target.branchId, highWater, target.conversationId,
      target.conversationId, target.branchId, target.conversationId])
    if (!facts || facts.deliveries !== 0 || facts.inbox !== facts.notes ||
      typeof facts.notes !== "number" || facts.notes > 64 || facts.missingInbox !== 0 ||
      facts.extraInbox !== 0 || facts.invalidNotes !== 0 || facts.prefix !== noteCount) fail()
    const mapping = mappingRead([target.conversationId, target.branchId])
    if (!mapping) fail()
    for (let index = 0; index < mappingKeys.length; index++) {
      const key = mappingKeys[index]
      if (mapping[key] !== originalMapping[key]) fail()
    }
    for (let index = 0; index < threadIds.length; index++) {
      const row = threadRead([threadIds[index]]), original = originalThreads[index]!
      if (!row || row.created_at !== original.created_at || row.metadata !== original.metadata) fail()
    }
  }
  assertAdmissionCurrent()
  const checkpointIncarnation = fixedIncarnation(input.checkpointIncarnation)
  const point: HistoricalCheckpointPoint = Object.freeze({ checkpointThreadId: input.authority.threadId,
    checkpointIncarnation, checkpointIncarnationKey: JSON.stringify(checkpointIncarnation.token === null
      ? ["legacy", checkpointIncarnation.legacyCreatedAt] : ["token", checkpointIncarnation.token]),
    checkpointId: tuple.checkpoint.id, namespace: read.namespace })
  const proof = Object.freeze({ [brand]: true as const })
  records.set(proof, { database, store: input.store, saver: input.saver, authority: input.authority,
    invocation: input.invocation, nativeRead: input.nativeRead, scope: input.scope, parent, target,
    state: Object.freeze(functionConversationState(target)), destination, active: input.active,
    assertCurrent: current, checkpointPoint: point, admission: Object.freeze({ highWater }),
    pending: returnInputFreeze({ notes, ordinaryReturnInputs }), retiring: false, released: false })
  read.bindAdmissionCurrent(assertAdmissionCurrent)
  return proof
}

/** Only the original router's native read, never public CM JSON, can admit this historical target. */
export async function prepareFunctionConversationSharedRestore(input: {
  readonly nativeRead: FunctionConversationSharedNativeRead
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly active: FunctionConversationSharedActive
  readonly parentBinding: FunctionConversationGraphBinding
  readonly store: FunctionConversationStore
  readonly checkpointIncarnation: ThreadIncarnation
  readonly signal: AbortSignal
  assertCurrent(): void
}): Promise<FunctionConversationSharedRestore> {
  const database = getDb(), parent = input.parentBinding.target
  const read = readFunctionConversationSharedNativeRead(input.nativeRead, input.saver, input.authority)
  if (read.scope !== input.scope) fail()
  const active = readActive(input.active, input)
  const tuple = read.tuple
  if (!tuple) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (tuple.checkpoint.channel_values.cmbFunctionConversation === undefined && read.pendingNamespace)
    return preparePendingSharedRestore(input, database, read, active)
  const state = readFunctionConversationState(tuple.checkpoint.channel_values.cmbFunctionConversation)
  const target: FunctionConversationRef = Object.freeze({ ...parent,
    incarnation: Object.freeze({ ...parent.incarnation }), conversationId: state.conversationId,
    branchId: state.branchId, kind: "child", checkpointNamespace: read.namespace })
  const guard = () => {
    input.signal.throwIfAborted(); input.authority.assertLive(); input.assertCurrent()
    input.parentBinding.assertCurrent(); read.assertCurrent()
    if (getDb() !== database || input.authority.threadId !== input.parentBinding.checkpointThreadId ||
      !matchesThreadIncarnation(getThreadCore(input.authority.threadId), input.checkpointIncarnation))
      fail("MODS_CONVERSATION_THREAD_CHANGED")
    input.store.assertCurrent(parent); input.store.assertCurrent(target)
    assertFunctionConversationState(target, state)
  }
  guard()
  const destination = readFunctionConversationNativeDestination(database, target, parent, guard)
  if (destination.checkpointThreadId !== input.authority.threadId ||
    destination.checkpointIncarnation.token !== input.checkpointIncarnation.token ||
    (destination.checkpointIncarnation.token === null &&
      destination.checkpointIncarnation.legacyCreatedAt !== input.checkpointIncarnation.legacyCreatedAt)) fail()
  const current = () => {
    active.assertCurrent(); guard(); destination.assertCurrent()
  }
  try {
    const checkpointIncarnation = fixedIncarnation(input.checkpointIncarnation)
    const incarnationKey = JSON.stringify(checkpointIncarnation.token === null
      ? ["legacy", checkpointIncarnation.legacyCreatedAt] : ["token", checkpointIncarnation.token])
    const point: HistoricalCheckpointPoint = Object.freeze({
      checkpointThreadId: input.authority.threadId,
      checkpointIncarnation, checkpointIncarnationKey: incarnationKey,
      checkpointId: tuple.checkpoint.id, namespace: read.namespace })
    const assertCheckpointPoint = (snapshot: FunctionConversationCheckpointMembershipSnapshot) => {
      if (snapshot.checkpointThreadId !== point.checkpointThreadId ||
        snapshot.checkpointIncarnation !== incarnationKey ||
        snapshot.checkpointId !== point.checkpointId || snapshot.namespace !== point.namespace)
        fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    }
    const original = input.store.readCheckpointRecoverySnapshot(target, point, current).snapshot
    assertCheckpointPoint(original)
    const exactConfig = { ...read.config, configurable: { ...read.config.configurable,
      checkpoint_id: tuple.checkpoint.id } }
    const captured = await captureConversationCheckpointRead(input.store, input.saver, exactConfig,
      () => ({ target, checkpointThreadId: point.checkpointThreadId,
        checkpointIncarnation: point.checkpointIncarnation, cut: original.cut,
        frontier: state.frontier, stateDigest: original.stateDigest, assertCurrent: current }), current)
    current()
    if (!captured.proof) fail()
    const actual = readFunctionConversationCheckpointMembership(captured.proof, input.store, target)
    assertCheckpointPoint(actual)
    if (actual.snapshotDigest !== original.snapshotDigest || actual.checkpointId !== tuple.checkpoint.id)
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    const checkpoint = tuple.checkpoint, channels = checkpoint.channel_values
    const checkpointId = Object.getOwnPropertyDescriptor(checkpoint, "id")
    if (!checkpointId || !("value" in checkpointId) || checkpointId.value !== point.checkpointId)
      fail()
    const messages = channels.messages
    if (!Array.isArray(messages) || types.isProxy(messages) ||
      Object.getPrototypeOf(messages) !== Array.prototype ||
      messages.length !== actual.nativeMessageCount) fail()
    const membership = captured.proof
    const containers = [tuple, checkpoint, channels]
    const keys = ["checkpoint", "channel_values", "messages"]
    const fields: PropertyDescriptor[] = [], prototypes: Array<object | null> = []
    for (let index = 0; index < containers.length; index++) {
      const container = containers[index]
      if (types.isProxy(container)) fail()
      const field = Object.getOwnPropertyDescriptor(container, keys[index])
      if (!field || !("value" in field) || field.value !==
        (index === 0 ? checkpoint : index === 1 ? channels : messages)) fail()
      fields[index] = field
      prototypes[index] = Object.getPrototypeOf(container)
    }
    const historyAuthority = input.authority, historyScope = input.scope, historySignal = input.signal
    let historyReading = false, historyFailed = false
    const assertHistoryData = () => {
      const registered = readData(records, proof)
      if (historyFailed || getDb() !== database ||
        !isModRuntimeAuthorityDataCurrent(historyAuthority) ||
        isFunctionConversationSharedCheckpointScopeDataClosed(historyScope) ||
        !registered || registered.retiring || registered.released || registered.history !== history ||
        registered.checkpointPoint !== point || target.checkpointNamespace !== point.namespace) fail()
      Reflect.apply(signalThrowIfAborted, historySignal, [])
      const currentId = Object.getOwnPropertyDescriptor(checkpoint, "id")
      if (!currentId || !("value" in currentId) || currentId.value !== point.checkpointId ||
        currentId.writable !== checkpointId.writable ||
        currentId.enumerable !== checkpointId.enumerable ||
        currentId.configurable !== checkpointId.configurable) fail()
      for (let index = 0; index < containers.length; index++) {
        const container = containers[index], originalField = fields[index]
        if (types.isProxy(container) || Object.getPrototypeOf(container) !== prototypes[index]) fail()
        const field = Object.getOwnPropertyDescriptor(container, keys[index])
        if (!field || !("value" in field) || field.value !== originalField.value ||
          field.enumerable !== originalField.enumerable || field.writable !== originalField.writable ||
          field.configurable !== originalField.configurable) fail()
      }
    }
    const history: FunctionConversationSharedReturnHistory = Object.freeze({
      messages: messages as BaseMessage[], membership, assertCurrent() {
        if (historyReading || historyFailed) { historyFailed = true; fail() }
        historyReading = true
        try {
          assertHistoryData()
          current()
          const fresh = readFunctionConversationCheckpointMembership(membership, input.store, target)
          const kept = input.store.readCheckpointRecoverySnapshot(target, point, current).snapshot
          assertCheckpointPoint(fresh)
          assertCheckpointPoint(kept)
          if (fresh.snapshotDigest !== actual.snapshotDigest ||
            kept.snapshotDigest !== actual.snapshotDigest) fail()
          assertHistoryData()
        } catch (error) { historyFailed = true; throw error }
        finally { historyReading = false }
      },
      assertDataCurrent() {
        try { if (historyReading) fail(); assertHistoryData() }
        catch (error) { historyFailed = true; throw error }
      }
    })
    const proof = Object.freeze({ [brand]: true as const })
    records.set(proof, { database, store: input.store, saver: input.saver, authority: input.authority,
      invocation: input.invocation, nativeRead: input.nativeRead, scope: input.scope, parent, target,
      state: Object.freeze({ ...state }), destination, active: input.active, assertCurrent: current,
      history, checkpointPoint: point,
      retiring: false, released: false })
    return proof
  } catch (error) {
    // Closing seals admission; only the actual scope's terminal drain releases this reservation.
    input.scope.close()
    retireFunctionConversationSharedActive(input.active, input.scope)
    throw error
  }
}

export function readFunctionConversationSharedRestore(proof: FunctionConversationSharedRestore,
  expected: { readonly nativeRead?: FunctionConversationSharedNativeRead; readonly saver?: SqlJsSaver;
    readonly authority: ModRuntimeAuthority; readonly invocation: object;
    readonly parent: FunctionConversationRef; readonly destinationThreadId?: string;
    readonly destinationIncarnation?: ThreadIncarnation }) {
  const value = records.get(proof)
  if (!value || value.released || value.retiring || value.authority !== expected.authority ||
    value.invocation !== expected.invocation || !sameRef(value.parent, expected.parent) ||
    (expected.nativeRead && value.nativeRead !== expected.nativeRead) ||
    (expected.saver && value.saver !== expected.saver) ||
    (expected.destinationThreadId && value.destination.destinationThreadId !== expected.destinationThreadId) ||
    (expected.destinationIncarnation &&
      (value.destination.destinationIncarnation.token !== expected.destinationIncarnation.token ||
        value.destination.destinationIncarnation.legacyCreatedAt !== expected.destinationIncarnation.legacyCreatedAt))) fail()
  value.assertCurrent()
  return { target: value.target, state: value.state, destination: value.destination,
    ...(value.admission ? { admission: value.admission } : {}),
    ...(value.pending ? { pending: value.pending } : {}), assertCurrent: value.assertCurrent }
}

/** No authority/source check is needed to retire. It cannot make an unfinished native scope idle. */
export function retireFunctionConversationSharedRestore(proof: FunctionConversationSharedRestore,
  scope: FunctionConversationSharedCheckpointScope): void {
  const value = records.get(proof)
  if (!value || value.scope !== scope || !scope.isClosed()) fail()
  if (value.retiring) return
  value.retiring = true
  retireFunctionConversationSharedActive(value.active, scope)
  void scope.whenDrained().then(() => { value.released = true }, () => undefined)
}
