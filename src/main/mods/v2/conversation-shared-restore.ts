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
import type { BaseMessage } from "@langchain/core/messages"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { getDb, getThreadCore } from "../../db"
import { readFunctionConversationNativeDestination,
  assertFunctionConversationNativeDestinationDataCurrent,
  withFunctionConversationNativeDestinationDataScope,
  type FunctionConversationNativeDestination } from "../../db/function-conversation-native-destination"
import type { FunctionConversationRef, FunctionConversationStore } from "../../db/function-conversation-store"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
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
import type { FunctionConversationSharedNativeReadCurrent } from "./conversation-shared-checkpointer"

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
  readonly sourceCurrent?: FunctionConversationSharedNativeReadCurrent
  retiring: boolean
  released: boolean
  completed?: { readonly target: FunctionConversationRef;
    readonly destination: FunctionConversationNativeDestination
    readonly restored: boolean }
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
  readonly history: FunctionConversationSharedReturnHistory
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
const signalThrowIfAborted = AbortSignal.prototype.throwIfAborted
const dataWeakGet = WeakMap.prototype.get, dataWeakSet = WeakMap.prototype.set
const dataMapGet = Map.prototype.get
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
  const sourceCurrent = assertInputFields && input.assertCurrent === read.assertCurrent
    ? readFunctionConversationSharedSourceCurrent(input.assertCurrent, input.scope,
      input.saver, input.authority, input.invocation, database) : undefined
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
    completed.restored || completed.destination !== destination) return undefined
  const completedField = Object.getOwnPropertyDescriptor(active, "completed")
  if (!completedField || !("value" in completedField) || completedField.value !== completed) fail()
  const assertDataCurrent = () => {
    data.assertCurrent()
    const field = Object.getOwnPropertyDescriptor(active, "completed")
    if (!field || !("value" in field) || field.value !== completed ||
      field.writable !== completedField.writable || field.enumerable !== completedField.enumerable ||
      field.configurable !== completedField.configurable ||
      readData(activeRecords, proof) !== active || readData(activeDataReaders, proof) !== data ||
      readData(completedActiveRecords, proof) !== completed)
      fail("MODS_CONVERSATION_TARGET_CLOSED")
  }
  assertDataCurrent()
  return Object.freeze({ database: active.database, scope: active.scope, saver: active.saver,
    authority: active.authority, invocation: active.invocation, target: completed.target,
    destination, current: active.nativeView.assertCurrent, namespace: active.nativeView.namespace,
    assertDataCurrent })
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
    restored: expected.restore !== undefined })
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
    if (failed || !isModRuntimeAuthorityDataCurrent(active.authority) ||
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
  const view: FunctionConversationSharedProducerView = Object.freeze({
    coordinator: registration.coordinator,
    database: active.database, saver: active.saver, authority: active.authority,
    invocation: active.invocation, scope: active.scope, nativeRead: active.nativeRead,
    config: active.nativeView.config, namespace: active.nativeView.namespace,
    owner: registration.owner, target: registration.target, binding: registration.binding,
    destination, signal: active.signal, ...(history ? { history } : {}),
    assertCurrent, assertDataCurrent
  })
  producerRecords.set(token, Object.freeze({ authority: active.authority, view }))
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
    assertCurrent: value.assertCurrent }
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
