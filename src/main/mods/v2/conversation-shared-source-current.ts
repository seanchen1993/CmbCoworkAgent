import { types } from "node:util"
import type { RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"
import type { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { getDb } from "../../db"
import { readFunctionConversationThreadIdentityCurrent } from
  "../../db/function-conversation-thread-identity-read"
import { matchesThreadIncarnation } from "../../services/thread-incarnation"
import type { ModRuntimeAuthority } from "../runtime-instance"
import { coversFunctionConversationNativeDestinationThread,
  matchesFunctionConversationNativeDestinationData,
  type FunctionConversationNativeDestination } from
  "../../db/function-conversation-native-destination"
import type { FunctionConversationRef } from "../../db/function-conversation-store"
import type { ThreadIncarnation, ThreadIncarnationRow } from "../../services/thread-incarnation"
import { readFunctionConversationSharedCompletedActiveData,
  type FunctionConversationSharedActive } from "./conversation-shared-restore"
import { readFunctionConversationSharedNativeReadCurrent,
  type FunctionConversationSharedCheckpointScope,
  type FunctionConversationSharedNativeReadCurrent } from "./conversation-shared-checkpointer"

interface SourceInput {
  readonly task: { readonly invocation: object; readonly config: RunnableConfig;
    readonly saver: SqlJsSaver }
  readonly coordinator: object
  readonly parent: object
  readonly parentBinding: FunctionConversationGraphBinding
  readonly authority: ModRuntimeAuthority
  readonly signal: AbortSignal
  readonly admitted: unknown
  assertCurrent(): void
}
interface Source {
  readonly input: SourceInput
  readonly database: ReturnType<typeof getDb>
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly config: RunnableConfig
  readonly signal: AbortSignal
  readonly parentNamespace: string
  readonly eligible: boolean
  readonly guard: () => void
  readonly assertFields: () => void
  reading: boolean
  failed: boolean
}
const sources = new WeakMap<() => void, Source>()
const constructing = new WeakMap<object, Source>()
const sourceWeakGet = WeakMap.prototype.get, sourceWeakSet = WeakMap.prototype.set
const sourceSignalThrow = AbortSignal.prototype.throwIfAborted

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID") }
function sourceFields(value: object, keys: readonly string[]): () => void {
  if (!value || types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value), fields: PropertyDescriptor[] = []
  for (let index = 0; index < keys.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, keys[index])
    if (!field || !("value" in field)) fail()
    fields[index] = Object.freeze(field)
  }
  return () => {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) fail()
    for (let index = 0; index < keys.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, keys[index]), original = fields[index]
      if (!field || !("value" in field) || field.value !== original.value ||
        field.writable !== original.writable || field.enumerable !== original.enumerable ||
        field.configurable !== original.configurable) fail()
    }
  }
}

/** This module constructs the complete H itself; callers cannot register a coverage callback. */
export function createFunctionConversationSharedSourceCurrent(input: SourceInput): () => void {
  const previous = Reflect.apply(sourceWeakGet, constructing, [input]) as Source | undefined
  if (previous) { previous.failed = true; fail() }
  const assertInput = sourceFields(input, ["task", "coordinator", "parent", "parentBinding",
    "authority", "signal", "assertCurrent", "admitted"])
  const assertTask = sourceFields(input.task, ["invocation", "saver", "config"])
  const assertBinding = sourceFields(input.parentBinding, ["target", "checkpointIncarnation",
    "assertCurrent"])
  const target = input.parentBinding.target
  const assertTarget = sourceFields(target, ["checkpointNamespace"])
  const parentNamespace = target.checkpointNamespace
  const originalCurrent = input.assertCurrent, originalParent = input.parentBinding.assertCurrent
  const database = getDb(), incarnation = input.parentBinding.checkpointIncarnation
  if (typeof originalCurrent !== "function" || typeof originalParent !== "function" ||
    typeof parentNamespace !== "string" || !incarnation) fail()
  const assertIncarnation = sourceFields(incarnation, ["token", "legacyCreatedAt"])
  const assertFields = () => {
    assertInput(); assertTask(); assertBinding(); assertTarget(); assertIncarnation()
  }
  const guard = () => {
    if (source.reading || source.failed) { source.failed = true; fail() }
    source.reading = true
    try {
      assertFields()
      Reflect.apply(sourceSignalThrow, input.signal, [])
      input.authority.assertLive()
      Reflect.apply(originalCurrent, input, [])
      Reflect.apply(originalParent, input.parentBinding, [])
      assertFields()
      if (source.failed || getDb() !== database ||
        !matchesThreadIncarnation(readFunctionConversationThreadIdentityCurrent(getDb(),
          input.authority.threadId), incarnation))
        throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
    } catch (error) { source.failed = true; throw error }
    finally { source.reading = false }
  }
  const source: Source = { input, database, saver: input.task.saver, authority: input.authority,
    invocation: input.task.invocation, config: input.task.config, signal: input.signal,
    parentNamespace, eligible: !types.isProxy(originalCurrent) && !types.isProxy(originalParent),
    guard, assertFields, reading: false, failed: false }
  Reflect.apply(sourceWeakSet, constructing, [input, source])
  Reflect.apply(sourceWeakSet, sources, [guard, source])
  return guard
}

/** Code-execution facts, joined to the original S/read; this grants no new runtime or message. */
export function readFunctionConversationSharedSourceCurrent(current: unknown,
  scope: FunctionConversationSharedCheckpointScope, saver: SqlJsSaver,
  authority: ModRuntimeAuthority, invocation: object, database: ReturnType<typeof getDb>):
  FunctionConversationSharedNativeReadCurrent | undefined {
  const read = readFunctionConversationSharedNativeReadCurrent(current, scope, saver, authority)
  if (!read?.source) return undefined
  const source = Reflect.apply(sourceWeakGet, sources, [read.source]) as Source | undefined
  if (!source || !source.eligible || source.guard !== read.source || source.saver !== saver ||
    source.authority !== authority || source.invocation !== invocation || source.database !== database)
    return undefined
  const receiver = read.receiver
  if (types.isProxy(receiver)) return undefined
  const expected = [saver, authority, source.config, source.parentNamespace, source.signal, source.guard]
  const keys = ["saver", "authority", "parentConfig", "parentGraphNamespace", "signal", "assertCurrent"]
  for (let index = 0; index < keys.length; index++) {
    const field = Object.getOwnPropertyDescriptor(receiver, keys[index])
    if (!field || !("value" in field) || field.value !== expected[index]) return undefined
  }
  const assertReceiver = sourceFields(receiver, keys)
  const assertDataCurrent = () => {
    try {
      source.assertFields(); assertReceiver(); read.assertDataCurrent()
      if (source.failed || getDb() !== database ||
        Reflect.apply(sourceWeakGet, sources, [read.source]) !== source ||
        Reflect.apply(sourceWeakGet, constructing, [source.input]) !== source) fail()
    } catch (error) { source.failed = true; throw error }
  }
  assertDataCurrent()
  return Object.freeze({ source: read.source, receiver, assertDataCurrent })
}

const familyPairBrand = Symbol("function-conversation-shared-family-source-pair")
export interface FunctionConversationSharedFamilySourcePair { readonly [familyPairBrand]: true }
interface FamilyPair {
  readonly proof: FunctionConversationSharedFamilySourcePair
  readonly source: FunctionConversationSharedNativeReadCurrent
  readonly current: () => void
  readonly guard: () => void
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly database: ReturnType<typeof getDb>
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  readonly metadata: string | null
  readonly inputCurrent: () => void
  readonly destinationCurrent: () => void
  readonly assertDestination: () => void
  readonly assertDataCurrent: () => void
  reading: boolean
  failed: boolean
}
const familyPairs = new WeakMap<FunctionConversationSharedFamilySourcePair, FamilyPair>()
const familyInputCurrents = new WeakMap<() => void, FamilyPair>()
const familyDestinationCurrents = new WeakMap<() => void, FamilyPair>()

/** Self-built old-behavior functions; no pair is optimized until actual Active completion. */
export function createFunctionConversationSharedFamilySourceCurrents(input: {
  readonly current: () => void
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly database: ReturnType<typeof getDb>
  readonly destinationThreadId: string
  readonly destinationIncarnation: ThreadIncarnation
  readonly originalMetadata: string | null
}): Readonly<{ assertCurrent(): void; assertDestinationCurrent(): void }> | undefined {
  const assertInput = sourceFields(input, ["current", "scope", "saver", "authority", "invocation",
    "database", "destinationThreadId", "destinationIncarnation", "originalMetadata"])
  const { current, scope, saver, authority, invocation, database,
    destinationThreadId: threadId, destinationIncarnation: incarnation,
    originalMetadata: metadata } = input
  const source = readFunctionConversationSharedSourceCurrent(current, scope, saver,
    authority, invocation, database)
  if (!source?.source) return undefined
  const guard = source.source
  const assertIncarnation = sourceFields(incarnation, ["token", "legacyCreatedAt"])
  if (typeof threadId !== "string" || !threadId ||
    (metadata !== null && typeof metadata !== "string")) fail()
  const proof = Object.freeze({ [familyPairBrand]: true as const })
  const assertDataCurrent = () => {
    assertInput(); assertIncarnation(); source.assertDataCurrent()
    if (pair.failed || getDb() !== database ||
      Reflect.apply(sourceWeakGet, familyPairs, [proof]) !== pair ||
      Reflect.apply(sourceWeakGet, familyInputCurrents, [inputCurrent]) !== pair ||
      Reflect.apply(sourceWeakGet, familyDestinationCurrents, [destinationCurrent]) !== pair) fail()
  }
  const assertDestination = () => {
    const row = readFunctionConversationThreadIdentityCurrent(getDb(), threadId)
    if (!matchesThreadIncarnation(row, incarnation) || row?.metadata !== metadata)
      throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
  }
  const full = (destination: boolean) => {
    if (pair.reading || pair.failed) { pair.failed = true; fail() }
    pair.reading = true
    try {
      assertDataCurrent()
      guard()
      if (destination) assertDestination()
      else current()
      assertDataCurrent()
    } catch (error) { pair.failed = true; throw error }
    finally { pair.reading = false }
  }
  const inputCurrent = () => { full(false) }
  const destinationCurrent = () => { full(true) }
  const pair: FamilyPair = { proof, source, current, guard, scope, saver, authority, invocation,
    database, threadId, incarnation, metadata, inputCurrent, destinationCurrent,
    assertDestination, assertDataCurrent, reading: false, failed: false }
  Reflect.apply(sourceWeakSet, familyPairs, [proof, pair])
  Reflect.apply(sourceWeakSet, familyInputCurrents, [inputCurrent, pair])
  Reflect.apply(sourceWeakSet, familyDestinationCurrents, [destinationCurrent, pair])
  assertDataCurrent()
  return Object.freeze({ assertCurrent: inputCurrent, assertDestinationCurrent: destinationCurrent })
}

/** Execution addresses only; the result alone never activates a Family optimization. */
export function readFunctionConversationSharedFamilySourcePair(current: unknown,
  destinationCurrent: unknown): FunctionConversationSharedFamilySourcePair | undefined {
  if (typeof current !== "function" || types.isProxy(current) ||
    typeof destinationCurrent !== "function" || types.isProxy(destinationCurrent)) return undefined
  const pair = Reflect.apply(sourceWeakGet, familyInputCurrents, [current]) as FamilyPair | undefined
  if (!pair || pair.destinationCurrent !== destinationCurrent ||
    Reflect.apply(sourceWeakGet, familyDestinationCurrents, [destinationCurrent]) !== pair)
    return undefined
  pair.assertDataCurrent()
  return pair.proof
}

/** Exact original pair + completed Active + authentic destination mapping, never a callback claim. */
export function captureFunctionConversationSharedFamilySourcePlan(
  proof: FunctionConversationSharedFamilySourcePair, active: FunctionConversationSharedActive,
  authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination,
  parent: FunctionConversationRef, checkpointThreadId: string,
  checkpointIncarnation: ThreadIncarnation, destinationThreadId: string,
  destinationIncarnation: ThreadIncarnation, namespace: string) {
  const pair = Reflect.apply(sourceWeakGet, familyPairs, [proof]) as FamilyPair | undefined
  if (!pair || pair.authority !== authority) return undefined
  pair.assertDataCurrent()
  const completed = readFunctionConversationSharedCompletedActiveData(active, authority, destination)
  if (!completed || completed.database !== pair.database || completed.scope !== pair.scope ||
    completed.saver !== pair.saver || completed.invocation !== pair.invocation ||
    completed.current !== pair.current || completed.namespace !== namespace ||
    pair.threadId !== destinationThreadId ||
    pair.incarnation.token !== destinationIncarnation.token ||
    pair.incarnation.legacyCreatedAt !== destinationIncarnation.legacyCreatedAt ||
    !matchesFunctionConversationNativeDestinationData(destination, pair.database,
      completed.target, parent) ||
    !coversFunctionConversationNativeDestinationThread(destination, pair.database,
      checkpointThreadId, checkpointIncarnation) ||
    !coversFunctionConversationNativeDestinationThread(destination, pair.database,
      destinationThreadId, destinationIncarnation)) return undefined
  const assertDataCurrent = () => {
    pair.assertDataCurrent(); completed.assertDataCurrent()
    if (completed.destination !== destination || completed.current !== pair.current ||
      Reflect.apply(sourceWeakGet, familyPairs, [proof]) !== pair) fail()
  }
  const assertDestinationData = (row: ThreadIncarnationRow | null) => {
    if (!row || types.isProxy(row)) fail()
    const metadata = Object.getOwnPropertyDescriptor(row, "metadata")
    const createdAt = Object.getOwnPropertyDescriptor(row, "created_at")
    if (!metadata || !("value" in metadata) || metadata.value !== pair.metadata ||
      !createdAt || !("value" in createdAt) || typeof createdAt.value !== "number" ||
      !matchesThreadIncarnation({ metadata: metadata.value, created_at: createdAt.value },
        pair.incarnation)) fail()
    assertDataCurrent()
  }
  const assertCurrent = () => {
    if (pair.reading || pair.failed) { pair.failed = true; fail() }
    pair.reading = true
    try {
      assertDataCurrent()
      pair.current()
      pair.assertDestination()
      assertDataCurrent()
    } catch (error) { pair.failed = true; throw error }
    finally { pair.reading = false }
  }
  assertDataCurrent()
  return Object.freeze({ assertCurrent, assertDataCurrent, assertDestinationData })
}
