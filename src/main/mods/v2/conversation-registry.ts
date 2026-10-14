import {
  readFunctionConversationStoreCurrentExecution,
  type FunctionConversationStoreCurrentExecution,
  type FunctionConversationRef,
  type FunctionConversationStore
} from "../../db/function-conversation-store"
import { readFunctionConversationNativeOwnerCurrentExecution } from "./conversation-coordinator"
import { isModRuntimeAuthorityDataCurrent, type ModRuntimeAuthority,
  type ModRuntimeAuthorities } from "../runtime-instance"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { types } from "node:util"

const targetBrand = Symbol("function-conversation-target")
interface PureFields {
  readonly prototype: object | null
  readonly fields: ReadonlyArray<readonly [string, PropertyDescriptor]>
}
function capturePureFields(value: object, keys: readonly string[]): PureFields {
  return { prototype: Object.getPrototypeOf(value), fields: keys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) fail("MODS_CONVERSATION_TARGET_CHANGED")
    return [key, field] as const
  }) }
}
function assertPureFields(value: object, original: PureFields): void {
  if (Object.getPrototypeOf(value) !== original.prototype) fail("MODS_CONVERSATION_TARGET_CHANGED")
  for (let index = 0; index < original.fields.length; index++) {
    const key = original.fields[index][0], expected = original.fields[index][1]
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field) || field.value !== expected.value ||
      field.writable !== expected.writable || field.enumerable !== expected.enumerable ||
      field.configurable !== expected.configurable) fail("MODS_CONVERSATION_TARGET_CHANGED")
  }
}
function pureBoolean(value: object, key: string, expected: PropertyDescriptor): boolean {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !("value" in field) || typeof field.value !== "boolean" ||
    field.writable !== expected.writable || field.enumerable !== expected.enumerable ||
    field.configurable !== expected.configurable) fail("MODS_CONVERSATION_TARGET_CHANGED")
  return field.value
}
const weakGet = WeakMap.prototype.get, mapGet = Map.prototype.get
const actualRegistryInstances = new WeakMap<object, {
  readonly fields: PureFields
  readonly closedField: PropertyDescriptor
  readonly residents: WeakMap<object, Resident>
  readonly targets: WeakMap<FunctionConversationTarget, RecordEntry>
  readonly records: WeakMap<object, RecordEntry>
  readonly authorities: WeakMap<ModRuntimeAuthority, RecordEntry>
  closed: boolean
}>()
const residentFacts = new WeakMap<Resident, { readonly fields: PureFields;
  readonly active: PropertyDescriptor; readonly owner: object;
  readonly children: Map<string, RecordEntry> }>()
const entryFacts = new WeakMap<RecordEntry, { readonly fields: PureFields;
  readonly active: PropertyDescriptor; readonly resident: Resident;
  readonly backend: FunctionConversationBackend; readonly target: FunctionConversationTarget;
  readonly controllerSignal: AbortSignal }>()
const signalThrowIfAborted = AbortSignal.prototype.throwIfAborted
const controllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!
const mutationBind = Function.prototype.bind, setHas = Set.prototype.has
const mutationWeakSet = WeakMap.prototype.set
const nativeMutationRegistries = new WeakMap<FunctionConversationRegistry, {
  readonly fields: PureFields
  readonly mutations: Set<Mutation>
}>()
interface NativeMutationSource {
  readonly original: FunctionConversationMutationSource
  readonly fields: PureFields
  readonly captured: FunctionConversationMutationSource
  readonly current: () => void
}
interface NativeMutationGuardRecord {
  readonly registry: FunctionConversationRegistry
  readonly resident: Resident
  readonly entry: RecordEntry
  readonly mutation: Mutation
  readonly mutationFields: PureFields
  readonly residentFields: PureFields
  readonly source: NativeMutationSource
  readonly signal: AbortSignal
  active: boolean
  failed: boolean
}
const nativeMutationGuards = new WeakMap<() => void, NativeMutationGuardRecord>()
interface ParentBackendExecution {
  readonly original: FunctionConversationBackend
  readonly fields: PureFields
  readonly refFields: PureFields
  readonly incarnationFields: PureFields
  readonly authorityField: PropertyDescriptor | undefined
  readonly owner: NonNullable<ReturnType<typeof readFunctionConversationNativeOwnerCurrentExecution>>
  readonly current: () => void
  readonly captured: FunctionConversationBackend
}
interface ParentTargetExecution {
  readonly registry: FunctionConversationRegistry
  readonly store: FunctionConversationStore
  readonly registryFields: PureFields
  readonly backend: ParentBackendExecution
  readonly entry: RecordEntry
  readonly target: FunctionConversationTarget
  readonly resident: Resident
  readonly storeExecution: FunctionConversationStoreCurrentExecution
  readonly view: FunctionConversationNativeParentTargetExecution
  reading: boolean
  failed: boolean
}
const parentBackendExecutions = new WeakMap<FunctionConversationBackend, ParentBackendExecution>()
const parentTargetExecutions = new WeakMap<FunctionConversationTarget, ParentTargetExecution>()
export interface FunctionConversationNativeParentTargetExecution {
  assertCurrent(): void
  assertDataCurrent(): void
}

function captureParentBackendExecution(backend: FunctionConversationBackend,
  store: FunctionConversationStore): ParentBackendExecution | undefined {
  if (!backend || typeof backend !== "object" || types.isProxy(backend)) return undefined
  const field = Object.getOwnPropertyDescriptor(backend, "assertCurrent")
  if (!field || !("value" in field)) return undefined
  const owner = readFunctionConversationNativeOwnerCurrentExecution(field.value)
  if (!owner || owner.store !== store) return undefined
  const names = ["identity", "ref", "checkpointThreadId", "signal", "assertCurrent"]
  const fields = capturePureFields(backend, names)
  const authority = Object.getOwnPropertyDescriptor(backend, "authority")
  if (authority && (!("value" in authority) || authority.value !== undefined)) return undefined
  if (types.isProxy(backend.ref) || types.isProxy(backend.ref.incarnation) ||
    backend.identity !== owner.owner || backend.ref.kind !== "main") return undefined
  const refFields = capturePureFields(backend.ref, ["logicalSessionId", "conversationId", "branchId",
    "threadId", "workspace", "incarnation", "checkpointNamespace", "kind"])
  const incarnationFields = capturePureFields(backend.ref.incarnation, ["token", "legacyCreatedAt"])
  const current = Reflect.apply(mutationBind, field.value, [backend]) as () => void
  const captured: FunctionConversationBackend = Object.freeze({ identity: backend.identity,
    ref: Object.freeze({ logicalSessionId: backend.ref.logicalSessionId,
      conversationId: backend.ref.conversationId, branchId: backend.ref.branchId,
      threadId: backend.ref.threadId, workspace: backend.ref.workspace,
      incarnation: Object.freeze({ token: backend.ref.incarnation.token,
        legacyCreatedAt: backend.ref.incarnation.legacyCreatedAt }),
      checkpointNamespace: backend.ref.checkpointNamespace, kind: backend.ref.kind }),
    checkpointThreadId: backend.checkpointThreadId, signal: backend.signal,
    authority: undefined, assertCurrent: current })
  return { original: backend, fields, refFields, incarnationFields,
    authorityField: authority, owner, current, captured }
}

interface BackendFullDispatch {
  signal(): void
  source(): void
  store(): void
  authority(authority: ModRuntimeAuthority): ModRuntimeAuthority | undefined
}
function assertBackendFull(backend: FunctionConversationBackend, dispatch: BackendFullDispatch): void {
  dispatch.signal()
  dispatch.source()
  dispatch.store()
  if (typeof backend.checkpointThreadId !== "string" || !backend.checkpointThreadId.length ||
    (backend.ref.kind === "main" && backend.checkpointThreadId !== backend.ref.threadId))
    fail("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  const authority = backend.authority
  if (authority) {
    authority.assertLive()
    if (authority.workspace !== backend.ref.workspace ||
      authority.threadId !== backend.checkpointThreadId || dispatch.authority(authority) !== authority)
      fail("MODS_CONVERSATION_AUTHORITY_CHANGED")
    if ((backend.ref.kind === "main") !== (authority.agentId === "main"))
      fail("MODS_CONVERSATION_AUTHORITY_CHANGED")
  } else if (backend.ref.kind !== "main") fail("MODS_CONVERSATION_AUTHORITY_REQUIRED")
}
function assertResidentFull(closed: () => boolean, active: () => boolean,
  current: () => Resident | undefined, resident: Resident): void {
  if (closed() || !active() || current() !== resident) fail("MODS_CONVERSATION_SESSION_CLOSED")
}
interface EntryFullDispatch {
  resident(): void
  active(): boolean
  archive(): { assertCurrent(): void } | undefined
  archivedStore(): void
  current(): RecordEntry | undefined
  backend(): void
  authority(): ModRuntimeAuthority | undefined
  currentAuthority(authority: ModRuntimeAuthority): RecordEntry | undefined
}
function assertEntryFull(entry: RecordEntry, archived: boolean, dispatch: EntryFullDispatch): void {
  dispatch.resident()
  if (!dispatch.active()) {
    const archive = archived ? dispatch.archive() : undefined
    if (!archive) fail("MODS_CONVERSATION_TARGET_CLOSED")
    dispatch.archive()!.assertCurrent()
    dispatch.archivedStore()
    return
  }
  if (dispatch.current() !== entry) fail("MODS_CONVERSATION_TARGET_CHANGED")
  dispatch.backend()
  const authority = dispatch.authority()
  if (authority && dispatch.currentAuthority(authority) !== entry)
    fail("MODS_CONVERSATION_AUTHORITY_CHANGED")
}

function assertParentTargetData(record: ParentTargetExecution): void {
  if (record.failed || Reflect.apply(weakGet, parentTargetExecutions, [record.target]) !== record)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  const original = Reflect.apply(weakGet, actualRegistryInstances, [record.registry]) as
    ReturnType<typeof actualRegistryInstances.get>
  const entry = Reflect.apply(weakGet, entryFacts, [record.entry]) as ReturnType<typeof entryFacts.get>
  const resident = Reflect.apply(weakGet, residentFacts, [record.resident]) as
    ReturnType<typeof residentFacts.get>
  if (!original || !entry || !resident) fail("MODS_CONVERSATION_TARGET_CHANGED")
  assertPureFields(record.registry, original.fields)
  assertPureFields(record.registry, record.registryFields)
  assertPureFields(record.entry, entry.fields)
  assertPureFields(record.resident, resident.fields)
  assertPureFields(record.backend.original, record.backend.fields)
  assertPureFields(record.backend.original.ref, record.backend.refFields)
  assertPureFields(record.backend.original.ref.incarnation, record.backend.incarnationFields)
  const authority = Object.getOwnPropertyDescriptor(record.backend.original, "authority")
  const expectedAuthority = record.backend.authorityField
  if (expectedAuthority ? !authority || !("value" in authority) ||
    authority.value !== expectedAuthority.value || authority.writable !== expectedAuthority.writable ||
    authority.enumerable !== expectedAuthority.enumerable ||
    authority.configurable !== expectedAuthority.configurable : authority !== undefined)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  const main = Object.getOwnPropertyDescriptor(record.resident, "main")
  if (original.closed || pureBoolean(record.registry, "closed", original.closedField) ||
    !pureBoolean(record.entry, "active", entry.active) ||
    !pureBoolean(record.resident, "active", resident.active) || !main || !("value" in main) ||
    main.value !== record.entry || entry.target !== record.target ||
    entry.resident !== record.resident || entry.backend.authority ||
    entry.backend.identity !== record.backend.owner.owner ||
    resident.owner !== record.backend.owner.owner.context.owner ||
    Reflect.apply(weakGet, original.residents, [resident.owner]) !== record.resident ||
    Reflect.apply(weakGet, original.targets, [entry.target]) !== record.entry ||
    Reflect.apply(weakGet, original.records, [entry.backend.identity]) !== record.entry ||
    Reflect.apply(weakGet, parentBackendExecutions, [entry.backend]) !== record.backend)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  record.backend.owner.assertDataCurrent()
  record.storeExecution.assertDataCurrent()
  Reflect.apply(signalThrowIfAborted, entry.backend.signal, [])
  Reflect.apply(signalThrowIfAborted, entry.controllerSignal, [])
}

/** Exact actual insert/binding and Store execution; this alone does not select a parent authority. */
export function readFunctionConversationNativeParentTargetExecution(registry: FunctionConversationRegistry,
  target: FunctionConversationTarget, originalCurrent: unknown):
  FunctionConversationNativeParentTargetExecution | undefined {
  if (!registry || types.isProxy(registry) || !target || types.isProxy(target)) return undefined
  const original = Reflect.apply(weakGet, actualRegistryInstances, [registry]) as
    ReturnType<typeof actualRegistryInstances.get>
  const entry = original && Reflect.apply(weakGet, original.targets, [target]) as RecordEntry | undefined
  const actual = entry && Reflect.apply(weakGet, entryFacts, [entry]) as ReturnType<typeof entryFacts.get>
  const backend = actual && Reflect.apply(weakGet, parentBackendExecutions, [actual.backend]) as
    ParentBackendExecution | undefined
  if (!entry || !backend || backend.owner.current !== originalCurrent ||
    !actual || actual.backend.ref.kind !== "main" || actual.backend.authority) return undefined
  if (!original) return undefined
  assertPureFields(registry, original.fields)
  assertPureFields(entry, actual.fields)
  const store = Object.getOwnPropertyDescriptor(registry, "store")
  if (!store || !("value" in store) || store.value !== backend.owner.store)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  const prior = Reflect.apply(weakGet, parentTargetExecutions, [target]) as ParentTargetExecution | undefined
  if (prior) { prior.view.assertDataCurrent(); return prior.view }
  const storeExecution = readFunctionConversationStoreCurrentExecution(backend.owner.store,
    backend.owner.database)
  if (!storeExecution) return undefined
  const resident = Reflect.apply(weakGet, residentFacts, [actual.resident]) as
    ReturnType<typeof residentFacts.get>
  if (!resident) return undefined
  const actualBackend = actual.backend, actualResident = actual.resident
  const assertDataCurrent = () => {
    try { assertParentTargetData(record) }
    catch (error) { record.failed = true; throw error }
  }
  const view: FunctionConversationNativeParentTargetExecution = Object.freeze({ assertDataCurrent,
    assertCurrent() {
      if (record.reading || record.failed) { record.failed = true; fail("MODS_CONVERSATION_TARGET_CHANGED") }
      record.reading = true
      try {
        assertDataCurrent()
        assertEntryFull(entry, false, {
          resident: () => assertResidentFull(
            () => pureBoolean(registry, "closed", original.closedField) || original.closed,
            () => pureBoolean(actualResident, "active", resident.active),
            () => Reflect.apply(weakGet, original.residents, [resident.owner]) as Resident | undefined,
            actualResident),
          active: () => pureBoolean(entry, "active", actual.active), archive: () => undefined,
          archivedStore: () => storeExecution.assertCurrent(actualBackend.ref),
          current: () => Reflect.apply(weakGet, original.records, [actualBackend.identity]) as
            RecordEntry | undefined,
          backend: () => assertBackendFull(actualBackend, {
            signal: () => { Reflect.apply(signalThrowIfAborted, actualBackend.signal, []) },
            source: () => { Reflect.apply(backend.current, backend.original, []); assertDataCurrent() },
            store: () => storeExecution.assertCurrent(actualBackend.ref),
            authority: () => { fail("MODS_CONVERSATION_AUTHORITY_CHANGED") } }),
          authority: () => actualBackend.authority,
          currentAuthority: authority => Reflect.apply(weakGet, original.authorities, [authority]) as
            RecordEntry | undefined })
        assertDataCurrent()
      } catch (error) { record.failed = true; throw error }
      finally { record.reading = false }
    } })
  const record: ParentTargetExecution = { registry, store: backend.owner.store,
    registryFields: capturePureFields(registry, ["store"]), backend, entry,
    target, resident: actualResident, storeExecution, view, reading: false, failed: false }
  Reflect.apply(mutationWeakSet, parentTargetExecutions, [target, record])
  assertDataCurrent()
  return view
}

function nativeMutationSource(source: FunctionConversationMutationSource):
  NativeMutationSource | undefined {
  if (!source || typeof source !== "object" || types.isProxy(source)) return undefined
  const keys = ["owner", "plugin", "registration", "signal", "assertCurrent"] as const
  const ownKeys = Reflect.ownKeys(source)
  if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.some(name => name === key)))
    return undefined
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(source, key))
  if (descriptors.some(field => !field || !("value" in field))) return undefined
  const owner: unknown = descriptors[0]!.value, plugin: unknown = descriptors[1]!.value
  const registration: unknown = descriptors[2]!.value, signal: unknown = descriptors[3]!.value
  const current: unknown = descriptors[4]!.value
  if ([owner, plugin, registration, signal].some(value => !value || typeof value !== "object" ||
    types.isProxy(value)) || typeof current !== "function" || types.isProxy(current)) return undefined
  // A late own bind cannot change the function that the actual mutation guard executes.
  const bound = Reflect.apply(mutationBind, current, [source]) as () => void
  return { original: source, fields: capturePureFields(source, keys), current: current as () => void,
    captured: Object.freeze({ owner: owner as object, plugin: plugin as object,
      registration: registration as object, signal: signal as AbortSignal, assertCurrent: bound }) }
}

function assertNativeMutationData(record: NativeMutationGuardRecord): void {
  if (record.failed || !record.active) fail("MODS_CONVERSATION_TARGET_CHANGED")
  const original = Reflect.apply(weakGet, actualRegistryInstances, [record.registry]) as
    ReturnType<typeof actualRegistryInstances.get>
  const registry = Reflect.apply(weakGet, nativeMutationRegistries, [record.registry]) as
    ReturnType<typeof nativeMutationRegistries.get>
  const resident = Reflect.apply(weakGet, residentFacts, [record.resident]) as
    ReturnType<typeof residentFacts.get>
  const entry = Reflect.apply(weakGet, entryFacts, [record.entry]) as
    ReturnType<typeof entryFacts.get>
  if (!original || !registry || !resident || !entry) fail("MODS_CONVERSATION_TARGET_CHANGED")
  assertPureFields(record.registry, original.fields)
  assertPureFields(record.registry, registry.fields)
  assertPureFields(record.resident, resident.fields)
  assertPureFields(record.resident, record.residentFields)
  assertPureFields(record.entry, entry.fields)
  assertPureFields(record.mutation, record.mutationFields)
  assertPureFields(record.source.original, record.source.fields)
  const source = record.source.captured
  if (original.closed || pureBoolean(record.registry, "closed", original.closedField) ||
    !pureBoolean(record.resident, "active", resident.active) ||
    !pureBoolean(record.entry, "active", entry.active) ||
    Reflect.apply(setHas, registry.mutations, [record.mutation]) !== true ||
    Reflect.apply(weakGet, original.residents, [source.owner]) !== record.resident ||
    Reflect.apply(weakGet, original.targets, [entry.target]) !== record.entry ||
    Reflect.apply(weakGet, original.records, [entry.backend.identity]) !== record.entry ||
    entry.resident !== record.resident || resident.owner !== source.owner)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  const authority = entry.backend.authority
  if (authority && (!isModRuntimeAuthorityDataCurrent(authority) ||
    Reflect.apply(weakGet, original.authorities, [authority]) !== record.entry))
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  if (entry.backend.ref.kind === "main") {
    const main = Object.getOwnPropertyDescriptor(record.resident, "main")
    if (!main || !("value" in main) || main.value !== record.entry)
      fail("MODS_CONVERSATION_TARGET_CHANGED")
  } else if (!authority ||
    Reflect.apply(mapGet, resident.children, [authority.agentId]) !== record.entry)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  Reflect.apply(signalThrowIfAborted, source.signal, [])
  Reflect.apply(signalThrowIfAborted, entry.backend.signal, [])
  Reflect.apply(signalThrowIfAborted, entry.controllerSignal, [])
  Reflect.apply(signalThrowIfAborted, record.signal, [])
}

/** Mutation/source relationship only. Keeper must separately certify the exact original runtime. */
export function readFunctionConversationNativeMutationGuard(guard: unknown, runtime: object,
  producer: object, occurrence: object): Readonly<{ assertTail(): void }> | undefined {
  if (typeof guard !== "function" || types.isProxy(guard)) return undefined
  const record = Reflect.apply(weakGet, nativeMutationGuards, [guard]) as
    NativeMutationGuardRecord | undefined
  if (!record || !runtime || types.isProxy(runtime)) return undefined
  if (record.failed) fail("MODS_CONVERSATION_TARGET_CHANGED")
  const keys = ["owner", "target", "signal", "assertCurrent", "destination", "run"] as const
  const fields = keys.map(key => Object.getOwnPropertyDescriptor(runtime, key))
  if (fields.some(field => !field || !("value" in field))) return undefined
  const source = record.source.captured
  if (fields[0]!.value !== source.owner || fields[1]!.value !== record.entry.target ||
    fields[2]!.value !== source.signal || fields[3]!.value !== record.source.current ||
    source.plugin !== producer || source.registration !== occurrence) return undefined
  const runtimeFields = capturePureFields(runtime, keys)
  const check = () => {
    try {
      if (Reflect.apply(weakGet, nativeMutationGuards, [guard]) !== record)
        fail("MODS_CONVERSATION_TARGET_CHANGED")
      assertNativeMutationData(record)
      assertPureFields(runtime, runtimeFields)
    } catch (error) { record.failed = true; throw error }
  }
  check()
  return Object.freeze({ assertTail: check })
}
let originalTargetDataCurrent: (registry: FunctionConversationRegistry, owner: object,
  target: FunctionConversationTarget, authority: ModRuntimeAuthority) => void

/** Module-captured original data reader, independent of later instance/prototype overrides. */
export function assertFunctionConversationRegistryTargetDataCurrent(
  registry: FunctionConversationRegistry, owner: object, target: FunctionConversationTarget,
  authority: ModRuntimeAuthority): void {
  if (!actualRegistryInstances.has(registry)) fail("MODS_CONVERSATION_TARGET_CHANGED")
  originalTargetDataCurrent(registry, owner, target, authority)
}

export interface FunctionConversationTarget {
  readonly [targetBrand]: true
  readonly ref: FunctionConversationRef
  readonly checkpointThreadId: string
  readonly signal: AbortSignal
  assertCurrent(mode?: "append" | "read"): void
}

/** All fields come from the actual host registration, never an SDK agent string. */
export interface FunctionConversationBackend {
  readonly identity: object
  readonly ref: FunctionConversationRef
  readonly checkpointThreadId: string
  readonly signal: AbortSignal
  readonly authority?: ModRuntimeAuthority
  assertCurrent(): void
}

export interface FunctionConversationMutationSource {
  readonly owner: object
  readonly plugin: object
  readonly registration: object
  readonly signal: AbortSignal
  assertCurrent(): void
}

interface Resident {
  owner: object
  logicalSessionId: string
  main: RecordEntry
  children: Map<string, RecordEntry>
  active: boolean
}

interface RecordEntry {
  resident: Resident
  backend: FunctionConversationBackend
  target: FunctionConversationTarget
  active: boolean
  controller: AbortController
  archive?: { assertCurrent(): void }
}

interface Mutation {
  resident: Resident
  entry: RecordEntry
  source: FunctionConversationMutationSource
  kind: "sdk" | "native"
}

function fail(code: string): never {
  throw new ModFunctionError(code)
}

/** Live target selection is native identity; durable rows live exclusively in SQLite. */
export class FunctionConversationRegistry {
  private readonly residents = new WeakMap<object, Resident>()
  private readonly records = new WeakMap<object, RecordEntry>()
  private readonly authorities = new WeakMap<ModRuntimeAuthority, RecordEntry>()
  private readonly targets = new WeakMap<FunctionConversationTarget, RecordEntry>()
  private readonly activeResidents = new Set<Resident>()
  private readonly mutations = new Set<Mutation>()
  private closed = false

  constructor(
    private readonly store: FunctionConversationStore,
    private readonly runtimeAuthorities: Pick<ModRuntimeAuthorities, "get">
  ) {
    actualRegistryInstances.set(this, {
      fields: capturePureFields(this, ["residents", "targets", "records", "authorities", "store"]),
      closedField: Object.getOwnPropertyDescriptor(this, "closed")!, closed: false,
      residents: this.residents, targets: this.targets, records: this.records,
      authorities: this.authorities
    })
    Reflect.apply(mutationWeakSet, nativeMutationRegistries, [this, {
      fields: capturePureFields(this, ["mutations"]), mutations: this.mutations }])
  }

  private assertBackend(backend: FunctionConversationBackend): void {
    assertBackendFull(backend, { signal: () => backend.signal.throwIfAborted(),
      source: () => backend.assertCurrent(), store: () => this.store.assertCurrent(backend.ref),
      authority: authority => this.runtimeAuthorities.get(authority) })
  }

  private assertResident(resident: Resident): void {
    assertResidentFull(() => this.closed, () => resident.active,
      () => this.residents.get(resident.owner), resident)
  }

  private assertEntry(entry: RecordEntry, archived = false): void {
    assertEntryFull(entry, archived, { resident: () => this.assertResident(entry.resident),
      active: () => entry.active, archive: () => entry.archive,
      archivedStore: () => this.store.assertCurrent(entry.backend.ref),
      current: () => this.records.get(entry.backend.identity), backend: () => this.assertBackend(entry.backend),
      authority: () => entry.backend.authority, currentAuthority: authority => this.authorities.get(authority) })
  }

  registerMain(owner: object, backend: FunctionConversationBackend): FunctionConversationTarget {
    if (this.closed) fail("MODS_CONVERSATION_SESSION_CLOSED")
    if (backend.ref.kind !== "main") fail("MODS_CONVERSATION_MAIN_REQUIRED")
    this.assertBackend(backend)
    if (this.residents.has(owner) || this.records.has(backend.identity) ||
      (backend.authority && this.authorities.has(backend.authority)))
      fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    const resident: Resident = { owner, logicalSessionId: backend.ref.logicalSessionId,
      main: undefined as unknown as RecordEntry, children: new Map(), active: true }
    residentFacts.set(resident, { fields: capturePureFields(resident, ["owner", "children"]),
      active: Object.getOwnPropertyDescriptor(resident, "active")!, owner,
      children: resident.children })
    resident.main = this.insert(resident, backend)
    this.residents.set(owner, resident)
    this.activeResidents.add(resident)
    return resident.main.target
  }

  registerChild(owner: object, backend: FunctionConversationBackend): FunctionConversationTarget {
    const resident = this.residents.get(owner)
    if (!resident) fail("MODS_CONVERSATION_UNAVAILABLE")
    this.assertResident(resident)
    this.assertBackend(backend)
    const authority = backend.authority
    if (!authority || backend.ref.kind !== "child" ||
      backend.ref.logicalSessionId !== resident.logicalSessionId ||
      backend.ref.threadId !== resident.main.backend.ref.threadId ||
      backend.ref.workspace !== resident.main.backend.ref.workspace)
      fail("MODS_CONVERSATION_TARGET_CHANGED")
    if (resident.children.has(authority.agentId) || this.records.has(backend.identity) ||
      this.authorities.has(authority)) fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    const entry = this.insert(resident, backend)
    resident.children.set(authority.agentId, entry)
    return entry.target
  }

  rebindMain(owner: object, backend: FunctionConversationBackend): FunctionConversationTarget {
    const resident = this.residents.get(owner)
    if (!resident) return this.registerMain(owner, backend)
    this.assertResident(resident)
    this.assertBackend(backend)
    const previous = resident.main.backend.ref, next = backend.ref
    if (next.kind !== "main" || next.logicalSessionId !== previous.logicalSessionId ||
      next.conversationId !== previous.conversationId || next.threadId !== previous.threadId ||
      next.workspace !== previous.workspace || next.checkpointNamespace !== previous.checkpointNamespace ||
      this.records.has(backend.identity) || (backend.authority && this.authorities.has(backend.authority)))
      fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    this.retire(resident.main.target)
    resident.main = this.insert(resident, backend)
    return resident.main.target
  }

  private insert(resident: Resident, backend: FunctionConversationBackend): RecordEntry {
    // Pin host fields once. Later mutation of a supplied adapter cannot redirect a live target.
    const controller = new AbortController()
    const checkpointThreadId = backend.checkpointThreadId
    if (typeof checkpointThreadId !== "string" || !checkpointThreadId.length)
      fail("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    const execution = captureParentBackendExecution(backend, this.store)
    const original = execution?.captured ?? backend
    const captured = Object.freeze({ identity: original.identity,
      ref: Object.freeze({ ...original.ref, incarnation: Object.freeze({ ...original.ref.incarnation }) }),
      checkpointThreadId,
      signal: AbortSignal.any([original.signal, controller.signal]), authority: original.authority,
      assertCurrent: execution?.current ?? backend.assertCurrent.bind(backend) })
    if (execution) Reflect.apply(mutationWeakSet, parentBackendExecutions, [captured, execution])
    const entry: RecordEntry = { resident, backend: captured,
      target: undefined as unknown as FunctionConversationTarget, active: true, controller }
    const target: FunctionConversationTarget = Object.freeze({ [targetBrand]: true as const,
      ref: captured.ref, checkpointThreadId: captured.checkpointThreadId, signal: captured.signal,
      assertCurrent: (mode: "append" | "read" = "append") => this.assertEntry(entry, mode === "read") })
    entry.target = target
    entryFacts.set(entry, { fields: capturePureFields(entry,
      ["resident", "backend", "target", "controller"]),
      active: Object.getOwnPropertyDescriptor(entry, "active")!, resident, backend: captured,
      target, controllerSignal: Reflect.apply(controllerSignal, controller, []) as AbortSignal })
    this.records.set(captured.identity, entry)
    this.targets.set(target, entry)
    if (captured.authority) this.authorities.set(captured.authority, entry)
    return entry
  }

  /** Omitted agentId always selects the resident main, even when caller ALS belongs to a child. */
  resolve(owner: object, agentId?: string, mode: "append" | "read" = "append"): FunctionConversationTarget {
    const resident = this.residents.get(owner)
    if (!resident) fail("MODS_CONVERSATION_UNAVAILABLE")
    this.assertResident(resident)
    const entry = agentId === undefined
      ? resident.main : resident.children.get(agentId)
    if (!entry) fail("MODS_CONVERSATION_UNAVAILABLE")
    this.assertEntry(entry, mode === "read")
    return entry.target
  }

  forAuthority(authority: ModRuntimeAuthority): FunctionConversationTarget | undefined {
    authority.assertLive()
    const entry = this.authorities.get(authority)
    if (!entry) return undefined
    this.assertEntry(entry)
    return entry.target
  }

  /** Private registration facts only. Call the original full guard before this final data check. */
  assertTargetDataCurrent(owner: object, target: FunctionConversationTarget,
    authority: ModRuntimeAuthority): void {
    const original = Reflect.apply(weakGet, actualRegistryInstances, [this]) as
      ReturnType<typeof actualRegistryInstances.get>
    if (!original) fail("MODS_CONVERSATION_TARGET_CHANGED")
    assertPureFields(this, original.fields)
    const closed = pureBoolean(this, "closed", original.closedField)
    const resident = Reflect.apply(weakGet, original.residents, [owner]) as Resident | undefined
    const entry = Reflect.apply(weakGet, original.targets, [target]) as RecordEntry | undefined
    const residentData = resident && Reflect.apply(weakGet, residentFacts, [resident]) as
      ReturnType<typeof residentFacts.get>
    const data = entry && Reflect.apply(weakGet, entryFacts, [entry]) as
      ReturnType<typeof entryFacts.get>
    if (!resident || !entry || !residentData || !data) fail("MODS_CONVERSATION_TARGET_CHANGED")
    assertPureFields(resident, residentData.fields)
    assertPureFields(entry, data.fields)
    if (!isModRuntimeAuthorityDataCurrent(authority) ||
      closed || original.closed || !pureBoolean(resident, "active", residentData.active) ||
      !pureBoolean(entry, "active", data.active) || data.resident !== resident ||
      data.target !== target || residentData.owner !== owner ||
      Reflect.apply(weakGet, original.records, [data.backend.identity]) !== entry ||
      data.backend.authority !== authority ||
      Reflect.apply(weakGet, original.authorities, [authority]) !== entry ||
      Reflect.apply(mapGet, residentData.children, [authority.agentId]) !== entry)
      fail("MODS_CONVERSATION_TARGET_CHANGED")
    Reflect.apply(signalThrowIfAborted, data.backend.signal, [])
    Reflect.apply(signalThrowIfAborted, data.controllerSignal, [])
  }

  retire(target: FunctionConversationTarget, archive?: { assertCurrent(): void }, reason?: unknown): void {
    const entry = this.targets.get(target)
    if (!entry) fail("MODS_CONVERSATION_TARGET_CHANGED")
    entry.active = false
    entry.archive = archive ? Object.freeze({ assertCurrent: archive.assertCurrent.bind(archive) }) : undefined
    entry.controller.abort(reason ?? new ModFunctionError("MODS_CONVERSATION_TARGET_CLOSED"))
    if (this.records.get(entry.backend.identity) === entry) this.records.delete(entry.backend.identity)
    if (entry.backend.authority && this.authorities.get(entry.backend.authority) === entry)
      this.authorities.delete(entry.backend.authority)
    const agentId = entry.backend.authority?.agentId
    if (!archive && agentId && entry.resident.children.get(agentId) === entry)
      entry.resident.children.delete(agentId)
    // No mutation capacity is released here: ignored cancellation still owns its actual finally.
  }

  async runMutation<T>(source: FunctionConversationMutationSource, target: FunctionConversationTarget,
    kind: "sdk" | "native", run: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    const resident = this.residents.get(source.owner), entry = this.targets.get(target)
    if (!resident || !entry || entry.resident !== resident) fail("MODS_CONVERSATION_TARGET_CHANGED")
    const native = kind === "native" ? nativeMutationSource(source) : undefined
    const captured = native?.captured ??
      Object.freeze({ ...source, assertCurrent: source.assertCurrent.bind(source) })
    const signal = AbortSignal.any([captured.signal, entry.backend.signal])
    let nativeGuard: NativeMutationGuardRecord | undefined
    const assertCurrent = () => {
      if (nativeGuard?.failed) fail("MODS_CONVERSATION_TARGET_CHANGED")
      signal.throwIfAborted()
      captured.assertCurrent()
      this.assertEntry(entry)
      if (nativeGuard?.failed) fail("MODS_CONVERSATION_TARGET_CHANGED")
    }
    assertCurrent()
    const sameSession = [...this.mutations].filter((item) =>
      item.resident.logicalSessionId === resident.logicalSessionId && item.kind === kind)
    if (sameSession.length >= (kind === "sdk" ? 16 : 32) ||
      sameSession.filter((item) => item.entry.backend.ref.conversationId === entry.backend.ref.conversationId).length >= 8 ||
      (kind === "sdk" && sameSession.filter((item) => item.source.plugin === captured.plugin &&
        item.source.registration === captured.registration).length >= 4))
      fail("MODS_CONVERSATION_MUTATION_LIMIT")
    const mutation: Mutation = { resident, entry, source: captured, kind }
    this.mutations.add(mutation)
    try {
      if (native) {
        nativeGuard = { registry: this, resident, entry, mutation, source: native, signal,
          mutationFields: capturePureFields(mutation, ["resident", "entry", "source", "kind"]),
          residentFields: capturePureFields(resident, ["main", "logicalSessionId"]),
          active: true, failed: false }
        Reflect.apply(mutationWeakSet, nativeMutationGuards, [assertCurrent, nativeGuard])
      }
      const result = await run(signal, assertCurrent)
      assertCurrent()
      return result
    } finally {
      if (nativeGuard) nativeGuard.active = false
      this.mutations.delete(mutation)
    }
  }

  get activeMutations(): number {
    return this.mutations.size
  }

  closeOwner(owner: object): void {
    const resident = this.residents.get(owner)
    if (!resident) return
    resident.active = false
    this.residents.delete(owner)
    this.activeResidents.delete(resident)
    const reason = new ModFunctionError("MODS_CONVERSATION_SESSION_CLOSED")
    this.retire(resident.main.target, undefined, reason)
    for (const child of resident.children.values()) this.retire(child.target, undefined, reason)
    resident.children.clear()
  }

  close(): void {
    const original = actualRegistryInstances.get(this)
    if (original) original.closed = true
    if (this.closed) return
    this.closed = true
    for (const resident of [...this.activeResidents]) this.closeOwner(resident.owner)
  }

  static {
    const assertData = this.prototype.assertTargetDataCurrent
    originalTargetDataCurrent = (registry, owner, target, authority) => {
      Reflect.apply(assertData, registry, [owner, target, authority])
    }
  }
}
