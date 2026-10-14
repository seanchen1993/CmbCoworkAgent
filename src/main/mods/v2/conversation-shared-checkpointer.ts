import { AsyncLocalStorage } from "node:async_hooks"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata, CheckpointTuple, PendingWrite } from
  "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionConversationGraphBinding, FunctionConversationGraphRuntime } from
  "../../agent/mods-conversation"
import type { ModRuntimeAuthority } from "../runtime-instance"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { types } from "node:util"
import { isModRuntimeAuthorityDataCurrent } from "../runtime-instance"

const brand = Symbol("function-conversation-shared-native-read")
export interface FunctionConversationSharedNativeRead { readonly [brand]: true }
interface NativeRead {
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly config: RunnableConfig
  readonly tuple?: CheckpointTuple
  readonly namespace: string
  readonly scope: FunctionConversationSharedCheckpointScope
  assertCurrent(): void
}
const reads = new WeakMap<FunctionConversationSharedNativeRead, NativeRead>()
const scopeWeakGet = WeakMap.prototype.get
const scopeWeakSet = WeakMap.prototype.set
const scopeBind = Function.prototype.bind
const scopeSignalThrow = AbortSignal.prototype.throwIfAborted
const scopeControllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!
const scopeContextGet = AsyncLocalStorage.prototype.getStore
const scopeContextRun = AsyncLocalStorage.prototype.run
const scopePendingAdd = Set.prototype.add, scopePendingDelete = Set.prototype.delete
const scopePendingSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!
interface ScopeSourceBase {
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly host: FunctionConversationSharedCheckpointHost
  readonly hostPrototype: object | null
  readonly hostFields: readonly (readonly [string, PropertyDescriptor])[]
  readonly signal: AbortSignal
  readonly fields: readonly (readonly [string, PropertyDescriptor])[]
  readonly source?: () => void
  readonly receiver: FunctionConversationSharedCheckpointHost
  readonly controllerSignal: AbortSignal
}
interface ScopeReadCurrent {
  readonly base: ScopeSourceBase
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly namespace: string
  readonly namespaceField: PropertyDescriptor
  readonly current: () => void
  reading: boolean
  failed: boolean
}
const scopeSourceBases = new WeakMap<FunctionConversationSharedCheckpointScope, ScopeSourceBase>()
const scopeReadCurrents = new WeakMap<() => void, ScopeReadCurrent>()
let originalScopeGuard: (scope: FunctionConversationSharedCheckpointScope) => void

type ScopeOpeningFields = readonly (readonly [PropertyKey, PropertyDescriptor])[]
interface ScopeOpeningRecord {
  readonly base: ScopeSourceBase
  readonly fields: ScopeOpeningFields
  readonly hostFields: ScopeOpeningFields
  readonly parent: object
  readonly parentPrototype: object | null
  readonly parentFields: ScopeOpeningFields
  readonly ancestors: object
  readonly ancestorsPrototype: object | null
  readonly ancestorFields: ScopeOpeningFields
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly view: FunctionConversationSharedCheckpointOpeningCurrent
  reading: boolean
  failed: boolean
}
const scopeOpeningCurrents = new WeakMap<FunctionConversationSharedCheckpointScope, ScopeOpeningRecord>()
const preflightReceiptBrand = Symbol("shared-checkpoint-preflight-receipt")
/** Successful Scope execution only; an App consumer must also join its original read address. */
export interface FunctionConversationSharedCheckpointPreflightReceipt {
  readonly [preflightReceiptBrand]: true
}
interface ScopePreflightExecution {
  readonly opening: ScopeOpeningRecord
  readonly fields: ScopeOpeningFields
  readonly stateFields: ScopeOpeningFields
  readonly context: AsyncLocalStorage<object>
  readonly preflights: AsyncLocalStorage<object>
  readonly invocation: object
  readonly pending: Set<object>
  readonly resolveDrained: () => void
  operation: object | undefined
  config: RunnableConfig | undefined
  read: (() => Promise<unknown>) | undefined
  configChecks: readonly (() => void)[] | undefined
  reading: boolean
  checking: boolean
  used: boolean
  runReading: boolean
  runUsed: boolean
  runOperation: object | undefined
  failed: boolean
}
interface ScopePreflightReceiptRecord {
  readonly execution: ScopePreflightExecution
  readonly operation: object
  readonly config: RunnableConfig
  readonly read: () => Promise<unknown>
  readonly value: unknown
  readonly view: Readonly<{ originalRead: () => Promise<unknown>; assertDataCurrent(): void }>
}
const scopePreflightExecutions = new WeakMap<FunctionConversationSharedCheckpointScope,
  ScopePreflightExecution>()
const scopePreflightReceipts = new WeakMap<FunctionConversationSharedCheckpointPreflightReceipt,
  ScopePreflightReceiptRecord>()
let originalScopePreflight: <T>(execution: ScopePreflightExecution, config: RunnableConfig,
  read: () => Promise<T>) => Promise<T>
let originalScopePreflightTuple: (execution: ScopePreflightExecution,
  config: RunnableConfig) => Promise<undefined>
let originalScopeRun: <T>(execution: ScopePreflightExecution,
  execute: () => Promise<T>) => Promise<T>

/** Original opening facts only; this does not certify a factory, Producer or message. */
export interface FunctionConversationSharedCheckpointOpeningCurrent {
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly signal: AbortSignal
  readonly controllerSignal: AbortSignal
  assertCurrent(): void
  assertDataCurrent(): void
}

function openingFields(value: object, selected?: readonly PropertyKey[]): ScopeOpeningFields {
  if (types.isProxy(value)) fail()
  const keys = selected ?? Reflect.ownKeys(value)
  const fields: Array<readonly [PropertyKey, PropertyDescriptor]> = []
  for (let index = 0; index < keys.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, keys[index])
    if (!field || !("value" in field)) fail()
    fields[index] = Object.freeze([keys[index], Object.freeze(field)] as const)
  }
  return Object.freeze(fields)
}
function assertOpeningFields(value: object, prototype: object | null,
  fields: ScopeOpeningFields, exact = true): void {
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) fail()
  const keys = exact ? Reflect.ownKeys(value) : undefined
  if (keys && keys.length !== fields.length) fail()
  for (let index = 0; index < fields.length; index++) {
    const key = fields[index][0], original = fields[index][1]
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (keys && keys[index] !== key || !field || !("value" in field) ||
      field.value !== original.value || field.enumerable !== original.enumerable ||
      field.writable !== original.writable || field.configurable !== original.configurable) fail()
  }
}
function assertScopeOpeningData(record: ScopeOpeningRecord): void {
  const { base } = record
  if (record.failed || Reflect.apply(scopeWeakGet, scopeSourceBases, [base.scope]) !== base ||
    Reflect.apply(scopeWeakGet, scopeOpeningCurrents, [base.scope]) !== record ||
    isFunctionConversationSharedCheckpointScopeDataClosed(base.scope) ||
    !isModRuntimeAuthorityDataCurrent(record.authority)) fail()
  const original = Reflect.apply(scopeWeakGet, scopeData, [base.scope]) as
    ReturnType<typeof scopeData.get>
  if (!original) fail()
  assertOpeningFields(base.scope, original.prototype, record.fields, false)
  assertOpeningFields(base.host, base.hostPrototype, record.hostFields)
  assertOpeningFields(record.parent, record.parentPrototype, record.parentFields)
  assertOpeningFields(record.ancestors, record.ancestorsPrototype, record.ancestorFields)
  Reflect.apply(scopeSignalThrow, base.signal, [])
  Reflect.apply(scopeSignalThrow, base.controllerSignal, [])
}
function installScopeOpeningCurrent(base: ScopeSourceBase, parent: object, ancestors: object): void {
  const saverField = Object.getOwnPropertyDescriptor(base.host, "saver")
  const authorityField = Object.getOwnPropertyDescriptor(base.host, "authority")
  if (!saverField || !("value" in saverField) || !authorityField ||
    !("value" in authorityField)) fail()
  const saver = saverField.value as SqlJsSaver, authority = authorityField.value as ModRuntimeAuthority
  const fields = openingFields(base.scope,
    ["host", "controller", "parent", "ancestors", "checkpointer", "quarantined"])
  const hostFields = openingFields(base.host), parentFields = openingFields(parent)
  const ancestorFields = openingFields(ancestors)
  const view: FunctionConversationSharedCheckpointOpeningCurrent = Object.freeze({
    saver, authority, signal: base.signal, controllerSignal: base.controllerSignal,
    assertCurrent() {
      if (record.reading || record.failed) { record.failed = true; fail() }
      record.reading = true
      try {
        assertScopeOpeningData(record)
        originalScopeGuard(base.scope)
        assertScopeOpeningData(record)
      } catch (error) { record.failed = true; throw error }
      finally { record.reading = false }
    },
    assertDataCurrent() {
      try {
        if (record.reading) fail()
        assertScopeOpeningData(record)
      } catch (error) { record.failed = true; throw error }
    }
  })
  const record: ScopeOpeningRecord = { base, fields, hostFields, parent, parentFields,
    parentPrototype: Object.getPrototypeOf(parent), ancestors, ancestorFields,
    ancestorsPrototype: Object.getPrototypeOf(ancestors), saver, authority, view,
    reading: false, failed: false }
  Reflect.apply(scopeWeakSet, scopeOpeningCurrents, [base.scope, record])
}

/** No namespace/read lifetime is extended and no caller-provided guard is registered. */
export function readFunctionConversationSharedCheckpointOpeningCurrent(
  scope: FunctionConversationSharedCheckpointScope):
  FunctionConversationSharedCheckpointOpeningCurrent | undefined {
  const record = Reflect.apply(scopeWeakGet, scopeOpeningCurrents, [scope]) as
    ScopeOpeningRecord | undefined
  if (!record?.base.source) return undefined
  record.view.assertDataCurrent()
  return record.view
}

function installScopePreflightExecution(scope: FunctionConversationSharedCheckpointScope): void {
  const opening = Reflect.apply(scopeWeakGet, scopeOpeningCurrents, [scope]) as ScopeOpeningRecord
  const fields = openingFields(scope,
    ["context", "preflights", "invocation", "pending", "resolveDrained"])
  const execution: ScopePreflightExecution = {
    opening, fields, stateFields: openingFields(scope, ["started", "initializing", "binding",
      "closed", "quarantined"]), context: fields[0][1].value, preflights: fields[1][1].value,
    invocation: fields[2][1].value, pending: fields[3][1].value,
    resolveDrained: fields[4][1].value, operation: undefined, config: undefined,
    read: undefined, configChecks: undefined, reading: false, checking: false,
    used: false, runReading: false, runUsed: false, runOperation: undefined, failed: false
  }
  Reflect.apply(scopeWeakSet, scopePreflightExecutions, [scope, execution])
}

function assertScopePreflightData(execution: ScopePreflightExecution, started = true): void {
  const { opening } = execution, scope = opening.base.scope
  if (execution.failed || Reflect.apply(scopeWeakGet, scopePreflightExecutions, [scope]) !==
    execution) fail()
  assertScopeOpeningData(opening)
  assertOpeningFields(scope, Object.getPrototypeOf(scope), execution.fields, false)
  for (let index = 0; index < execution.stateFields.length; index++) {
    const key = execution.stateFields[index][0], original = execution.stateFields[index][1]
    const field = Object.getOwnPropertyDescriptor(scope, key)
    const expected = key === "started" ? started : original.value
    if (!field || !("value" in field) || field.value !== expected ||
      field.enumerable !== original.enumerable || field.configurable !== original.configurable ||
      field.writable !== original.writable) fail()
  }
  if (execution.configChecks) for (let index = 0; index < execution.configChecks.length; index++)
    execution.configChecks[index]()
}

/** Fixed run graph only. It does not certify the delegate, Factory, Source or ready state. */
export async function runFunctionConversationSharedCheckpointPreflightOperation<T>(
  scope: FunctionConversationSharedCheckpointScope, operation: object,
  execute: () => Promise<T>
): Promise<T> {
  const execution = Reflect.apply(scopeWeakGet, scopePreflightExecutions, [scope]) as
    ScopePreflightExecution | undefined
  if (!execution?.opening.base.source) fail()
  if (execution.runReading || execution.runUsed || execution.failed) {
    execution.failed = true
    fail()
  }
  execution.runReading = true
  execution.runUsed = true
  try {
    try {
      if (!operation || typeof operation !== "object" || types.isProxy(operation) ||
        typeof execute !== "function" || types.isProxy(execute)) fail()
      execution.runOperation = operation
      assertScopePreflightData(execution, false)
      originalScopeGuard(scope)
      assertScopePreflightData(execution, false)
      Object.defineProperty(scope, "started", { ...execution.stateFields[0][1], value: true })
      assertScopePreflightData(execution)
    } catch (error) { execution.failed = true; throw error }
    let rejected = false, reason: unknown, value!: T
    try { value = await originalScopeRun(execution, execute) }
    catch (error) { rejected = true; reason = error }
    // A caught reentry cannot be erased by a successful or rejected delegate.
    try { assertScopePreflightData(execution) }
    catch (error) { execution.failed = true; throw error }
    if (rejected) throw reason
    return value
  } finally { execution.runReading = false }
}

function preflightConfigCheck(value: object): () => void {
  const prototype = Object.getPrototypeOf(value), fields = openingFields(value)
  return () => { assertOpeningFields(value, prototype, fields) }
}

/** The original Scope must be entered. This receipt is not a graph, Producer or ready proof. */
export async function runFunctionConversationSharedCheckpointPreflight<T>(
  scope: FunctionConversationSharedCheckpointScope, operation: object, config: RunnableConfig,
  originalRead: () => Promise<T>
): Promise<Readonly<{ value: T; receipt: FunctionConversationSharedCheckpointPreflightReceipt }>> {
  const execution = Reflect.apply(scopeWeakGet, scopePreflightExecutions, [scope]) as
    ScopePreflightExecution | undefined
  if (!execution?.opening.base.source) fail()
  if (execution.reading || execution.used || execution.failed ||
    execution.runUsed && execution.runOperation !== operation) {
    execution.failed = true
    fail()
  }
  execution.reading = true
  execution.used = true
  try {
    if (!operation || typeof operation !== "object" || types.isProxy(operation) ||
      !config || typeof config !== "object" || types.isProxy(config) ||
      typeof originalRead !== "function" || types.isProxy(originalRead)) fail()
    execution.operation = operation
    execution.config = config
    execution.read = originalRead
    const configurable = Object.getOwnPropertyDescriptor(config, "configurable")
    if (!configurable || !("value" in configurable) || !configurable.value ||
      typeof configurable.value !== "object" || types.isProxy(configurable.value)) fail()
    const map = Object.getOwnPropertyDescriptor(configurable.value, "checkpoint_map")
    if (!map || !("value" in map) || !map.value || typeof map.value !== "object" ||
      types.isProxy(map.value)) fail()
    execution.configChecks = Object.freeze([preflightConfigCheck(config),
      preflightConfigCheck(configurable.value), preflightConfigCheck(map.value)])
    assertScopePreflightData(execution)
    const value = await originalScopePreflight(execution, config, originalRead)
    assertScopePreflightData(execution)
    const receipt = Object.freeze({ [preflightReceiptBrand]: true as const })
    const view = Object.freeze({ originalRead: originalRead as () => Promise<unknown>,
      assertDataCurrent() {
        try {
          if (execution.reading) fail()
          assertScopePreflightData(execution)
        } catch (error) { execution.failed = true; throw error }
      } })
    Reflect.apply(scopeWeakSet, scopePreflightReceipts, [receipt,
      Object.freeze({ execution, operation, config, read: originalRead, value, view })])
    return Object.freeze({ value, receipt })
  } catch (error) { execution.failed = true; throw error }
  finally { execution.reading = false }
}

/** Exact receipt selection is data only. Unknown/foreign inputs do not poison a real operation. */
export function readFunctionConversationSharedCheckpointPreflightReceipt(
  receipt: FunctionConversationSharedCheckpointPreflightReceipt,
  scope: FunctionConversationSharedCheckpointScope, operation: object, config: RunnableConfig
): ScopePreflightReceiptRecord["view"] | undefined {
  const record = Reflect.apply(scopeWeakGet, scopePreflightReceipts, [receipt]) as
    ScopePreflightReceiptRecord | undefined
  if (!record || record.execution.opening.base.scope !== scope || record.operation !== operation ||
    record.config !== config) return undefined
  record.view.assertDataCurrent()
  return record.view
}

export interface FunctionConversationSharedNativeReadCurrent {
  readonly source?: () => void
  readonly receiver: FunctionConversationSharedCheckpointHost
  assertDataCurrent(): void
}

function assertScopeReadData(record: ScopeReadCurrent): void {
  const { base } = record
  if (record.failed || Reflect.apply(scopeWeakGet, scopeSourceBases, [base.scope]) !== base ||
    Reflect.apply(scopeWeakGet, scopeReadCurrents, [record.current]) !== record ||
    isFunctionConversationSharedCheckpointScopeDataClosed(base.scope) ||
    !isModRuntimeAuthorityDataCurrent(record.authority)) fail()
  for (let index = 0; index < base.fields.length; index++) {
    const key = base.fields[index][0], original = base.fields[index][1]
    const field = Object.getOwnPropertyDescriptor(base.scope, key)
    if (!field || !("value" in field) || field.value !== original.value ||
      field.enumerable !== original.enumerable || field.writable !== original.writable ||
      field.configurable !== original.configurable) fail()
  }
  if (types.isProxy(base.host) || Object.getPrototypeOf(base.host) !== base.hostPrototype) fail()
  for (let index = 0; index < base.hostFields.length; index++) {
    const key = base.hostFields[index][0], original = base.hostFields[index][1]
    const field = Object.getOwnPropertyDescriptor(base.host, key)
    if (!field || !("value" in field) || field.value !== original.value ||
      field.enumerable !== original.enumerable || field.writable !== original.writable ||
      field.configurable !== original.configurable) fail()
  }
  const namespace = Object.getOwnPropertyDescriptor(base.scope, "namespace")
  if (!namespace || !("value" in namespace) || namespace.value !== record.namespace ||
    namespace.enumerable !== record.namespaceField.enumerable ||
    namespace.writable !== record.namespaceField.writable ||
    namespace.configurable !== record.namespaceField.configurable) fail()
  Reflect.apply(scopeSignalThrow, base.signal, [])
  Reflect.apply(scopeSignalThrow, base.controllerSignal, [])
}

/** Execution facts from the original Scope only; this does not certify a source factory. */
export function readFunctionConversationSharedNativeReadCurrent(current: unknown,
  scope: FunctionConversationSharedCheckpointScope, saver: SqlJsSaver,
  authority: ModRuntimeAuthority): FunctionConversationSharedNativeReadCurrent | undefined {
  if (typeof current !== "function" || types.isProxy(current)) return undefined
  const record = Reflect.apply(scopeWeakGet, scopeReadCurrents, [current]) as
    ScopeReadCurrent | undefined
  if (!record || record.base.scope !== scope || record.saver !== saver ||
    record.authority !== authority) return undefined
  try { assertScopeReadData(record) }
  catch (error) { record.failed = true; throw error }
  return Object.freeze({ source: record.base.source, receiver: record.base.receiver,
    assertDataCurrent: () => {
      try { assertScopeReadData(record) }
      catch (error) { record.failed = true; throw error }
    } })
}

function createScopeReadCurrent(scope: FunctionConversationSharedCheckpointScope,
  saver: SqlJsSaver, authority: ModRuntimeAuthority, namespace: string): () => void {
  const base = Reflect.apply(scopeWeakGet, scopeSourceBases, [scope]) as ScopeSourceBase | undefined
  // A generic Scope retains its original full chain. Execution evidence is not an authority mint.
  if (!base?.source || !isModRuntimeAuthorityDataCurrent(authority))
    return () => { originalScopeGuard(scope) }
  const namespaceField = Object.getOwnPropertyDescriptor(scope, "namespace")
  if (!base || !namespaceField || !("value" in namespaceField) ||
    namespaceField.value !== namespace) fail()
  const current = () => {
    if (record.reading || record.failed) { record.failed = true; fail() }
    record.reading = true
    try {
      assertScopeReadData(record)
      originalScopeGuard(scope)
      assertScopeReadData(record)
    } catch (error) { record.failed = true; throw error }
    finally { record.reading = false }
  }
  const record: ScopeReadCurrent = { base, saver, authority, namespace, namespaceField, current,
    reading: false, failed: false }
  Reflect.apply(scopeWeakSet, scopeReadCurrents, [current, record])
  return current
}
const scopeData = new WeakMap<FunctionConversationSharedCheckpointScope, {
  readonly prototype: object | null
  readonly closedField: PropertyDescriptor
  closed: boolean
}>()

/** Original scope data only, after its full guards; unknown scopes never acquire this evidence. */
export function isFunctionConversationSharedCheckpointScopeDataClosed(
  scope: FunctionConversationSharedCheckpointScope): boolean {
  const original = Reflect.apply(scopeWeakGet, scopeData, [scope]) as
    ReturnType<typeof scopeData.get>
  if (!original || Object.getPrototypeOf(scope) !== original.prototype) fail()
  const field = Object.getOwnPropertyDescriptor(scope, "closed")
  if (!field || !("value" in field) || typeof field.value !== "boolean" ||
    field.value !== original.closed || field.writable !== original.closedField.writable ||
    field.enumerable !== original.closedField.enumerable ||
    field.configurable !== original.closedField.configurable) fail()
  return original.closed
}

/** Only the original native router can mint this read receipt. It is never an SDK value. */
export function readFunctionConversationSharedNativeRead(proof: FunctionConversationSharedNativeRead,
  saver: SqlJsSaver, authority: ModRuntimeAuthority): Omit<NativeRead, "saver" | "authority"> {
  const value = reads.get(proof)
  if (!value || value.saver !== saver || value.authority !== authority) fail()
  value.assertCurrent()
  return { config: value.config, tuple: value.tuple, namespace: value.namespace,
    scope: value.scope, assertCurrent: value.assertCurrent }
}

export interface FunctionConversationSharedCheckpointHost {
  readonly saver: SqlJsSaver
  readonly authority: ModRuntimeAuthority
  readonly parentConfig: RunnableConfig
  readonly parentGraphNamespace: string
  readonly signal: AbortSignal
  assertCurrent(): void
  /** Called only after the real child initialization query, before its input checkpoint. */
  admit(proof: FunctionConversationSharedNativeRead): Promise<FunctionConversationGraphBinding>
  /** A fresh child observer on the original physical Saver, never the parent's observer. */
  delivery(saver: SqlJsSaver, binding: FunctionConversationGraphBinding): SqlJsSaver
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE") }
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) fail()
  return descriptor.value
}
function checkpointMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  const result: Record<string, string> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail()
    const item = field(value, key)
    if (typeof item !== "string" || !item) fail()
    result[key] = item
  }
  return Object.freeze(result)
}
function fixedConfig(config: RunnableConfig): RunnableConfig {
  const original = field(config, "configurable")
  if (!original || typeof original !== "object" || Array.isArray(original)) fail()
  const configurable: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(original)) {
    if (typeof key !== "string") fail()
    configurable[key] = field(original, key)
  }
  configurable.checkpoint_map = checkpointMap(configurable.checkpoint_map)
  return Object.freeze({ ...config, configurable: Object.freeze(configurable) })
}

/** Per actual known runnable invocation. No namespace guessing, copied receipt or parent takeover. */
export class FunctionConversationSharedCheckpointScope {
  readonly checkpointer: SqlJsSaver
  private readonly context = new AsyncLocalStorage<object>()
  private readonly preflights = new AsyncLocalStorage<object>()
  private readonly invocation = Object.freeze({})
  private readonly host: FunctionConversationSharedCheckpointHost
  private readonly parent: RunnableConfig
  private readonly ancestors: Readonly<Record<string, string>>
  private readonly pending = new Set<object>()
  private readonly planned = new Set<string>()
  private readonly nodeCaptures = new WeakMap<object, FunctionConversationGraphBinding>()
  private namespace?: string
  private initializing?: Promise<CheckpointTuple | undefined>
  private binding?: FunctionConversationGraphBinding
  private delegated?: SqlJsSaver
  private controller = new AbortController()
  private started = false
  private closed = false
  private quarantined = false
  private resolveDrained!: () => void
  private rejectDrained!: (error: unknown) => void
  private readonly drained = new Promise<void>((resolve, reject) => {
    this.resolveDrained = resolve
    this.rejectDrained = reject
  })

  constructor(host: FunctionConversationSharedCheckpointHost) {
    void this.drained.catch(() => { /* Unknown drain remains rejected for its real owner. */ })
    this.parent = fixedConfig(host.parentConfig)
    this.ancestors = checkpointMap(this.parent.configurable?.checkpoint_map)
    const source = Object.getOwnPropertyDescriptor(host, "assertCurrent")
    const originalSource = source && "value" in source && typeof source.value === "function" &&
      !types.isProxy(host) && !types.isProxy(source.value) ? source.value as () => void : undefined
    this.host = Object.freeze({ ...host, parentConfig: this.parent,
      assertCurrent: originalSource ? Reflect.apply(scopeBind, originalSource, [host])
        : host.assertCurrent.bind(host), admit: host.admit.bind(host),
      delivery: host.delivery.bind(host) })
    if (!(host.saver instanceof SqlJsSaver) || host.authority.agentId === "main" ||
      typeof this.parent.configurable?.thread_id !== "string" ||
      this.parent.configurable.thread_id !== host.authority.threadId ||
      typeof this.parent.configurable.__pregel_read !== "function" ||
      !this.parent.configurable.__pregel_scratchpad ||
      typeof this.ancestors[host.parentGraphNamespace] !== "string") fail()
    this.guard()
    const readTuple = (config: RunnableConfig): Promise<CheckpointTuple | undefined> => {
      const execution = Reflect.apply(scopeWeakGet, scopePreflightExecutions, [this]) as
        ScopePreflightExecution | undefined
      return execution?.reading ? originalScopePreflightTuple(execution, config) : this.getTuple(config)
    }
    const methods = new Map<PropertyKey, unknown>()
    this.checkpointer = new Proxy(host.saver, { get: (target, key) => {
      if (key === "getTuple") return readTuple
      if (key === "get") return async (config: RunnableConfig) =>
        (await readTuple(config))?.checkpoint
      if (key === "put") return (config: RunnableConfig, checkpoint: Checkpoint,
        metadata: CheckpointMetadata) => this.put(config, checkpoint, metadata)
      if (key === "putWrites") return (config: RunnableConfig, writes: PendingWrite[], taskId: string) =>
        this.putWrites(config, writes, taskId)
      // A graph invocation cannot operate on other namespaces or retire its parent's Saver.
      // Native delivery observers use the separately captured real Saver, never this router.
      if (key === "list" || key === "deleteThread" || key === "close" ||
        key === "getLatestRuntimeTuple" || key === "getLatestTupleForDurableTailRecovery" ||
        key === "putWithCommitObserver" || key === "readCommittedCheckpoint") return () => fail()
      const value = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      if (!methods.has(key)) methods.set(key, value.bind(target))
      return methods.get(key)
    } })
    const closedField = Object.getOwnPropertyDescriptor(this, "closed")
    if (!closedField || !("value" in closedField) || closedField.value !== false) fail()
    scopeData.set(this, { prototype: Object.getPrototypeOf(this), closedField, closed: false })
    const fields: Array<readonly [string, PropertyDescriptor]> = []
    const names = ["host", "controller"]
    for (let index = 0; index < names.length; index++) {
      const field = Object.getOwnPropertyDescriptor(this, names[index])
      if (!field || !("value" in field)) fail()
      fields[index] = [names[index], Object.freeze(field)]
    }
    const hostFields: Array<readonly [string, PropertyDescriptor]> = []
    const hostNames = ["signal", "authority", "assertCurrent", "saver"]
    for (let index = 0; index < hostNames.length; index++) {
      const field = Object.getOwnPropertyDescriptor(this.host, hostNames[index])
      if (!field || !("value" in field)) fail()
      hostFields[index] = [hostNames[index], Object.freeze(field)]
    }
    const base: ScopeSourceBase = {
      scope: this, host: this.host, fields: Object.freeze(fields), source: originalSource,
      hostPrototype: Object.getPrototypeOf(this.host), hostFields: Object.freeze(hostFields),
      signal: hostFields[0][1].value,
      receiver: host, controllerSignal: Reflect.apply(scopeControllerSignal, this.controller, [])
    }
    Reflect.apply(scopeWeakSet, scopeSourceBases, [this, base])
    installScopeOpeningCurrent(base, this.parent, this.ancestors)
    installScopePreflightExecution(this)
  }

  private guard(): void {
    if (this.closed) throw new ModFunctionError("MODS_CONVERSATION_TARGET_CLOSED")
    this.host.signal.throwIfAborted()
    this.controller.signal.throwIfAborted()
    this.host.authority.assertLive()
    this.host.assertCurrent()
  }
  private entered(): void {
    this.guard()
    if (this.context.getStore() !== this.invocation) fail()
  }
  private validate(config: RunnableConfig, initializing = false): RunnableConfig {
    const captured = fixedConfig(config)
    this.entered()
    const values = captured.configurable, parent = this.parent.configurable
    if (!values || !parent || values.thread_id !== parent.thread_id ||
      typeof values.checkpoint_ns !== "string" || !values.checkpoint_ns ||
      values.checkpoint_ns === this.host.parentGraphNamespace) fail()
    const map = checkpointMap(values.checkpoint_map)
    for (const [key, value] of Object.entries(this.ancestors)) if (map[key] !== value) fail()
    if (initializing) {
      if (values.__pregel_read !== parent.__pregel_read ||
        values.__pregel_scratchpad !== parent.__pregel_scratchpad ||
        (map[values.checkpoint_ns] !== undefined &&
          values.checkpoint_id !== map[values.checkpoint_ns])) fail()
    } else if (values.checkpoint_ns !== this.namespace) fail()
    return captured
  }
  private async tracked<T>(run: () => Promise<T>): Promise<T> {
    const ticket = {}
    this.pending.add(ticket)
    try { return await run() }
    finally { this.pending.delete(ticket); this.finishDrain() }
  }
  private finishDrain(): void {
    if (this.closed && !this.quarantined && this.pending.size === 0) this.resolveDrained()
  }

  run<T>(invoke: () => Promise<T>): Promise<T> {
    this.guard()
    if (this.started) fail()
    this.started = true
    return this.context.run(this.invocation, () => this.tracked(invoke))
  }

  /** Only the factory's original ReactAgent.graph.getState address uses this native stage. */
  preflight<T>(config: RunnableConfig, read: () => Promise<T>): Promise<T> {
    this.entered()
    if (this.preflights.getStore() || this.initializing || this.binding) fail()
    // Reject changed native facts before graph.getState can choose another checkpointer.
    this.validatePreflight(config)
    return this.preflights.run(this.invocation, () => this.tracked(read))
  }

  private validatePreflight(config: RunnableConfig): void {
    const captured = fixedConfig(config), values = captured.configurable, parent = this.parent.configurable
    this.entered()
    if (!values || !parent ||
      values.thread_id !== parent.thread_id || values.checkpoint_ns !== parent.checkpoint_ns ||
      values.checkpoint_id !== parent.checkpoint_id ||
      values.__pregel_read !== parent.__pregel_read ||
      values.__pregel_scratchpad !== parent.__pregel_scratchpad ||
      values.__pregel_checkpointer !== this.checkpointer) fail()
    const map = checkpointMap(values.checkpoint_map)
    if (Object.keys(map).length !== Object.keys(this.ancestors).length) fail()
    for (const [key, value] of Object.entries(this.ancestors)) if (map[key] !== value) fail()
  }

  private preflightTuple(config: RunnableConfig): Promise<undefined> {
    if (this.preflights.getStore() !== this.invocation) fail()
    this.validatePreflight(config)
    // ReactAgent queries before the loop adjusts its scratchpad namespace. Reading that location
    // could borrow a sibling's state; only the later actual initialization can mint a target.
    return Promise.resolve(undefined)
  }

  private getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (this.preflights.getStore() === this.invocation) return this.preflightTuple(config)
    if (!this.initializing) {
      const captured = this.validate(config, true)
      this.namespace = String(captured.configurable?.checkpoint_ns)
      this.initializing = this.tracked(async () => {
        const tuple = await SqlJsSaver.prototype.getTuple.call(this.host.saver, captured)
        this.entered()
        if (tuple && (tuple.config.configurable?.thread_id !== this.host.authority.threadId ||
          tuple.config.configurable?.checkpoint_ns !== this.namespace ||
          tuple.config.configurable?.checkpoint_id !== tuple.checkpoint.id ||
          (captured.configurable?.checkpoint_id !== undefined &&
            captured.configurable.checkpoint_id !== tuple.checkpoint.id))) fail()
        const proof = Object.freeze({ [brand]: true as const })
        reads.set(proof, { saver: this.host.saver, authority: this.host.authority,
          config: captured, tuple, namespace: this.namespace!, scope: this,
          assertCurrent: createScopeReadCurrent(this, this.host.saver,
            this.host.authority, this.namespace!) })
        try {
          const binding = await this.host.admit(proof)
          this.entered()
          binding.assertCurrent()
          if (binding.checkpointThreadId !== this.host.authority.threadId ||
            binding.target.checkpointNamespace !== this.namespace) fail()
          this.binding = binding
          this.delegated = this.host.delivery(this.host.saver, binding)
          if (tuple) this.planned.add(tuple.checkpoint.id)
          return tuple
        } finally { reads.delete(proof) }
      }).catch(error => { this.close(); throw error })
      return this.initializing
    }
    const captured = this.validate(config)
    return this.tracked(async () => {
      await this.initializing
      this.entered()
      const tuple = await SqlJsSaver.prototype.getTuple.call(this.host.saver, captured)
      this.entered()
      return tuple
    })
  }

  private put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata):
    Promise<RunnableConfig> {
    const captured = this.validate(config)
    if (!this.binding || !this.delegated || typeof checkpoint.id !== "string" || !checkpoint.id) fail()
    this.planned.add(checkpoint.id)
    const saver = this.delegated
    return this.tracked(async () => {
      this.entered()
      const result = await saver.put(captured, checkpoint, metadata)
      this.entered()
      return result
    })
  }

  private putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const captured = this.validate(config)
    return this.tracked(async () => {
      this.entered()
      await this.host.saver.putWrites(captured, writes, taskId)
      this.entered()
    })
  }

  /** Only handed to the factory-installed native middleware, never the Guest or a public config API. */
  captureNode(runtime: FunctionConversationGraphRuntime): FunctionConversationGraphBinding {
    this.entered()
    if (!this.binding || !runtime.configurable || typeof runtime.configurable !== "object") fail()
    const captured = fixedConfig({ configurable: runtime.configurable })
    const map = checkpointMap(captured.configurable?.checkpoint_map)
    if (captured.configurable?.thread_id !== this.host.authority.threadId ||
      typeof captured.configurable.checkpoint_ns !== "string" ||
      typeof captured.configurable.__pregel_read !== "function") fail()
    for (const [key, value] of Object.entries(this.ancestors)) if (map[key] !== value) fail()
    const id = this.namespace ? map[this.namespace] : undefined
    if (!id) fail()
    const previous = this.nodeCaptures.get(runtime.configurable)
    if (previous) {
      if (previous.runtimeCheckpointNamespace !== captured.configurable.checkpoint_ns) fail()
      previous.assertCurrent()
      return previous
    }
    // This callback's actual native address supplies planned provenance when async put is queued.
    this.planned.add(id)
    const base = this.binding
    const binding = Object.freeze({ ...base,
      runtimeCheckpointNamespace: captured.configurable.checkpoint_ns,
      assertCurrent: () => { this.guard(); base.assertCurrent() } })
    this.nodeCaptures.set(runtime.configurable, binding)
    return binding
  }

  /** Native live API reader has a fixed target; no SDK-selected namespace or historical fallback. */
  readCurrent(signal: AbortSignal, assertSource: () => void): Promise<CheckpointTuple | undefined> {
    const source = assertSource.bind(undefined)
    this.guard()
    source()
    signal.throwIfAborted()
    if (!this.binding || !this.namespace) fail()
    const config = { ...this.parent, configurable: { ...this.parent.configurable,
      checkpoint_ns: this.namespace, checkpoint_id: undefined } }
    return this.tracked(async () => {
      const tuple = await SqlJsSaver.prototype.getTuple.call(this.host.saver, config)
      this.guard()
      source()
      signal.throwIfAborted()
      if (tuple && (tuple.config.configurable?.thread_id !== this.host.authority.threadId ||
        tuple.config.configurable.checkpoint_ns !== this.namespace ||
        tuple.config.configurable.checkpoint_id !== tuple.checkpoint.id)) fail()
      return tuple
    })
  }

  static {
    const guard = this.prototype.guard
    originalScopeGuard = scope => { Reflect.apply(guard, scope, []) }
    originalScopeRun = <T>(execution: ScopePreflightExecution,
      execute: () => Promise<T>): Promise<T> => {
      const tracked = async (): Promise<T> => {
        const ticket = {}
        Reflect.apply(scopePendingAdd, execution.pending, [ticket])
        try { return await execute() }
        finally {
          Reflect.apply(scopePendingDelete, execution.pending, [ticket])
          const scope = execution.opening.base.scope
          const closed = Object.getOwnPropertyDescriptor(scope, "closed")
          const quarantined = Object.getOwnPropertyDescriptor(scope, "quarantined")
          const sameBoolean = (field: PropertyDescriptor | undefined,
            original: PropertyDescriptor): field is PropertyDescriptor => !!field &&
            "value" in field && typeof field.value === "boolean" &&
            field.enumerable === original.enumerable && field.writable === original.writable &&
            field.configurable === original.configurable
          if (!sameBoolean(closed, execution.stateFields[3][1]) ||
            !sameBoolean(quarantined, execution.stateFields[4][1])) execution.failed = true
          else if (closed.value && !quarantined.value &&
            Reflect.apply(scopePendingSize, execution.pending, []) === 0)
            execution.resolveDrained()
        }
      }
      return Reflect.apply(scopeContextRun, execution.context,
        [execution.invocation, tracked]) as Promise<T>
    }
    // Keep the original preflight execution graph without later private-method dispatch.
    // Public run/preflight and normal namespace admission retain their original paths.
    const entered = (execution: ScopePreflightExecution): void => {
      if (execution.checking) { execution.failed = true; fail() }
      execution.checking = true
      try {
        assertScopePreflightData(execution)
        originalScopeGuard(execution.opening.base.scope)
        assertScopePreflightData(execution)
        if (Reflect.apply(scopeContextGet, execution.context, []) !== execution.invocation) fail()
      } catch (error) { execution.failed = true; throw error }
      finally { execution.checking = false }
    }
    const validate = (execution: ScopePreflightExecution, config: RunnableConfig): void => {
      const captured = fixedConfig(config), values = captured.configurable
      const parent = execution.opening.parent as RunnableConfig
      entered(execution)
      if (!values || !parent.configurable ||
        values.thread_id !== parent.configurable.thread_id ||
        values.checkpoint_ns !== parent.configurable.checkpoint_ns ||
        values.checkpoint_id !== parent.configurable.checkpoint_id ||
        values.__pregel_read !== parent.configurable.__pregel_read ||
        values.__pregel_scratchpad !== parent.configurable.__pregel_scratchpad ||
        values.__pregel_checkpointer !== execution.opening.base.scope.checkpointer) fail()
      const map = checkpointMap(values.checkpoint_map), ancestors = execution.opening.ancestors
      const keys = Reflect.ownKeys(ancestors)
      if (Reflect.ownKeys(map).length !== keys.length) fail()
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        if (typeof key !== "string" || map[key] !==
          Object.getOwnPropertyDescriptor(ancestors, key)?.value) fail()
      }
    }
    originalScopePreflightTuple = (execution, config) => {
      if (execution.failed || Reflect.apply(scopeContextGet, execution.preflights, []) !==
        execution.invocation) fail()
      validate(execution, config)
      // As on the original path, preflight never selects a sibling or a native target.
      return Promise.resolve(undefined)
    }
    originalScopePreflight = <T>(execution: ScopePreflightExecution, config: RunnableConfig,
      read: () => Promise<T>): Promise<T> => {
      entered(execution)
      if (Reflect.apply(scopeContextGet, execution.preflights, [])) fail()
      validate(execution, config)
      const tracked = async (): Promise<T> => {
        const ticket = {}
        Reflect.apply(scopePendingAdd, execution.pending, [ticket])
        try { return await read() }
        finally {
          Reflect.apply(scopePendingDelete, execution.pending, [ticket])
          const scope = execution.opening.base.scope
          const closed = Object.getOwnPropertyDescriptor(scope, "closed")
          const quarantined = Object.getOwnPropertyDescriptor(scope, "quarantined")
          const originalClosed = execution.stateFields[3][1]
          const originalQuarantined = execution.stateFields[4][1]
          const isState = (field: PropertyDescriptor | undefined,
            original: PropertyDescriptor): field is PropertyDescriptor => !!field &&
            "value" in field && typeof field.value === "boolean" &&
            field.enumerable === original.enumerable && field.writable === original.writable &&
            field.configurable === original.configurable
          if (!isState(closed, originalClosed) || !isState(quarantined, originalQuarantined))
            execution.failed = true
          else if (closed.value && !quarantined.value &&
            Reflect.apply(scopePendingSize, execution.pending, []) === 0)
            execution.resolveDrained()
        }
      }
      return Reflect.apply(scopeContextRun, execution.preflights,
        [execution.invocation, tracked]) as Promise<T>
    }
  }

  close(): void {
    const original = scopeData.get(this)
    if (original) original.closed = true
    if (this.closed) return
    this.closed = true
    this.controller.abort(new ModFunctionError("MODS_CONVERSATION_TARGET_CLOSED"))
    this.planned.clear()
    this.finishDrain()
  }
  isClosed(): boolean { return this.closed }
  /** Unknown native terminal work cannot release its actual namespace reservation. */
  quarantineNativeWork(): void {
    const original = scopeData.get(this)
    if (original) original.closed = true
    if (this.quarantined) return
    this.quarantined = true
    this.close()
    this.rejectDrained(new ModFunctionError("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN"))
  }
  whenDrained(): Promise<void> { return this.drained }
}
