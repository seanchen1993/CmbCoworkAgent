import { randomUUID } from "node:crypto"
import { types } from "node:util"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { ModJson } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  validateFunctionSessionAppendArgs,
  validateFunctionSessionMessagesArgs,
  type FunctionSessionAppendArgs,
  type FunctionSessionAppendInput,
  type FunctionSessionMessagesArgs
} from "../../../shared/mods/v2/session-append"
import { readFunctionConversationTranscriptStamp, sameFunctionConversationTranscriptStamp } from
  "../../../shared/mods/v2/conversation-transcript"
import { getDb, getThreadCore } from "../../db"
import { readFunctionConversationThreadIdentityCurrent } from
  "../../db/function-conversation-thread-identity-read"
import { captureLocalThreadRunLease } from "../../agent/thread-run-lease"
import { FunctionConversationStore } from
  "../../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from
  "../../db/function-conversation-transcript"
import type { FunctionConversationTranscriptProjection } from
  "../../db/function-conversation-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../../services/thread-incarnation"
import { FunctionConversationRegistry, assertFunctionConversationRegistryTargetDataCurrent,
  readFunctionConversationNativeParentTargetExecution,
  type FunctionConversationNativeParentTargetExecution,
  type FunctionConversationTarget } from
  "./conversation-registry"
import { FunctionSessionAppendTicket } from "./session-append-ticket"
import { projectFunctionSessionMessages } from "./session-transcript"
import type {
  FunctionConversationAppendRun,
  FunctionConversationCallContext,
  FunctionConversationManagerHost,
  FunctionConversationMessages,
  FunctionConversationOwnerContext,
  FunctionSessionAppendSource
} from "./session-conversation-host"
import type { ModRuntimeAuthorities } from "../runtime-instance"
import type { ModRuntimeAuthority } from "../runtime-instance"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"
import { FunctionConversationChildFamilies, captureFunctionConversationSharedFamilyDataChecker,
  bindFunctionConversationSharedFamilySourcePlan,
  type FunctionConversationChildFactory, type FunctionConversationChildParentCapture,
  type FunctionConversationChildParent, type FunctionConversationIndependentChildInput,
  type FunctionConversationSharedChildFactory, type FunctionConversationSharedChildInput
} from "./conversation-child-family"
import { readFunctionConversationSharedNativeRead, type FunctionConversationSharedNativeRead } from
  "./conversation-shared-checkpointer"
import type { FunctionConversationSharedActive } from "./conversation-shared-restore"
import type { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { functionConversationNoteMessage, functionConversationState } from
  "../../agent/mods-conversation"
import { assertFunctionConversationState, readFunctionConversationState,
  type FunctionConversationState } from "../../checkpointer/function-conversation-delivery"
import { serializeFunctionConversationNativeMessage } from
  "../../agent/function-conversation-native-message"
import { recordFunctionConversationNativeDestinationInTransaction,
  matchesFunctionConversationNativeDestinationData,
  coversFunctionConversationNativeDestinationThread,
  assertFunctionConversationNativeDestinationScopeThread,
  withFunctionConversationNativeDestinationDataScope,
  type FunctionConversationNativeDestination,
  type FunctionConversationNativeDestinationDataScope } from
  "../../db/function-conversation-native-destination"
import { readFunctionConversationSharedRestore } from "./conversation-shared-restore"

/** Produced by a guarded actual checkpoint reader. Never accepted through IPC or Guest JSON. */
export interface FunctionConversationCurrentCheckpoint {
  readonly checkpointId: string
  readonly state?: FunctionConversationState
  readonly messages: readonly unknown[]
}

function isInternalFunctionChild(metadata: string | null | undefined): boolean {
  let value: unknown
  try { value = JSON.parse(metadata ?? "{}") } catch { return false }
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Reflect.get(value, "isInternalFlowRuntime") === true &&
    typeof Reflect.get(value, "parentThreadId") === "string"
}

interface Owner {
  readonly context: FunctionConversationOwnerContext
  readonly incarnation: ReturnType<typeof captureThreadIncarnation>
  readonly controller: AbortController
  live: boolean
  preparing?: Promise<FunctionConversationTarget>
  target?: FunctionConversationTarget
  child?: FunctionConversationChildFactory
  unboundInternalChild?: boolean
}

export interface FunctionConversationSharedRegistration extends FunctionConversationSharedChildInput {
  readonly saver: SqlJsSaver
  readonly nativeRead: FunctionConversationSharedNativeRead
  readCheckpoint(signal: AbortSignal, assertCurrent: () => void):
    Promise<FunctionConversationCurrentCheckpoint | null>
}

const sharedNativeRegistrationBrand = Symbol("function-conversation-shared-native-registration")
export interface FunctionConversationSharedNativeRegistration {
  readonly [sharedNativeRegistrationBrand]: true
}
export interface FunctionConversationSharedNativeRegistrationView {
  readonly coordinator: FunctionConversationCoordinator
  readonly owner: object
  readonly target: FunctionConversationTarget
  readonly binding: FunctionConversationGraphBinding
  readonly authority: ModRuntimeAuthority
  readonly invocation: object
  readonly destination: FunctionConversationTranscriptProjection
  assertCurrent(): void
  assertDataCurrent(): void
}
const actualSharedNativeRegistrations = new WeakMap<
  FunctionConversationSharedNativeRegistration, FunctionConversationSharedNativeRegistrationView>()
const signalThrowIfAborted = AbortSignal.prototype.throwIfAborted
const controllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set, mapGet = Map.prototype.get
interface PureFields {
  readonly prototype: object | null
  readonly fields: ReadonlyArray<readonly [string, PropertyDescriptor]>
}
function capturePureFields(value: object, keys: readonly string[]): PureFields {
  return { prototype: Object.getPrototypeOf(value), fields: keys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
    return [key, field] as const
  }) }
}
function assertPureFields(value: object, original: PureFields): void {
  if (Object.getPrototypeOf(value) !== original.prototype)
    throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  for (let index = 0; index < original.fields.length; index++) {
    const key = original.fields[index][0], expected = original.fields[index][1]
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field) || field.value !== expected.value ||
      field.writable !== expected.writable || field.enumerable !== expected.enumerable ||
      field.configurable !== expected.configurable)
      throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  }
}
export interface FunctionConversationSharedRegistrationDataChecker {
  assertInDestinationScope(scope: FunctionConversationNativeDestinationDataScope): void
}
const registrationDataCheckers = new WeakMap<FunctionConversationSharedNativeRegistration,
  (authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination) =>
    FunctionConversationSharedRegistrationDataChecker | undefined>()
interface SharedRegistrationPostflight {
  readonly view: FunctionConversationSharedNativeRegistrationView
  readonly destination: FunctionConversationNativeDestination
  readonly database: ReturnType<typeof getDb>
  readonly checker: FunctionConversationSharedRegistrationDataChecker
  reading: boolean
  failed: boolean
}
const registrationPostflights = new WeakMap<FunctionConversationSharedNativeRegistration,
  SharedRegistrationPostflight>()
const registrationSourceBinders = new WeakMap<FunctionConversationSharedNativeRegistration,
  (active: FunctionConversationSharedActive, destination: FunctionConversationNativeDestination) => void>()
const originalCoordinatorData = new WeakMap<FunctionConversationCoordinator, {
  readonly fields: PureFields
  readonly registry: FunctionConversationRegistry
  readonly families: FunctionConversationChildFamilies<Owner>
  readonly registrations: WeakMap<FunctionConversationSharedNativeRegistration,
    FunctionConversationSharedNativeRegistrationView>
  readonly targets: WeakMap<FunctionConversationSharedChildFactory, FunctionConversationTarget>
  readonly destinations: WeakMap<FunctionConversationTarget, FunctionConversationTranscriptProjection>
  readonly owners: WeakMap<object, Owner>
  readonly current: Map<string, Owner>
}>()
const originalOwnerData = new WeakMap<Owner, {
  readonly fields: PureFields
  readonly incarnationFields: PureFields
  readonly actualIncarnation: Owner["incarnation"]
  readonly incarnation: Readonly<Owner["incarnation"]>
  readonly live: PropertyDescriptor
  readonly context: FunctionConversationOwnerContext
  readonly controllerSignal: AbortSignal
}>()
interface OwnerCurrentExecution {
  readonly coordinator: FunctionConversationCoordinator
  readonly owner: Owner
  readonly store: FunctionConversationStore
  readonly database: ReturnType<typeof getDb>
  readonly current: () => void
  assertDataCurrent(): void
}
interface OwnerFullDispatch {
  key(context: FunctionConversationOwnerContext): string
  current(key: string): Owner | undefined
  signal(signal: AbortSignal): void
  controller(controller: AbortController): AbortSignal
  source(context: FunctionConversationOwnerContext): void
  scope(context: FunctionConversationOwnerContext): void
  child(child: FunctionConversationChildFactory): void
}
function assertOwnerFull(owner: Owner, dispatch: OwnerFullDispatch): void {
  const context = owner.context
  if (owner.unboundInternalChild) throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
  if (!owner.live || dispatch.current(dispatch.key(context)) !== owner)
    throw new ModFunctionError("MODS_CONVERSATION_SESSION_CLOSED")
  dispatch.signal(context.signal)
  dispatch.signal(dispatch.controller(owner.controller))
  dispatch.source(context)
  dispatch.scope(context)
  if (!matchesThreadIncarnation(getThreadCore(context.threadId), owner.incarnation))
    throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
  if (owner.child) dispatch.child(owner.child)
}
const ownerCurrentExecutions = new WeakMap<() => void, OwnerCurrentExecution>()
const ownerGuardCoordinators = new WeakMap<FunctionConversationCoordinator, {
  readonly fields: PureFields
  readonly host: FunctionConversationCoordinatorHost
  readonly scope?: (context: FunctionConversationOwnerContext) => void
  readonly scopeFields?: PureFields
}>()
const ownerExecutions = new WeakMap<Owner, OwnerCurrentExecution>()
interface ParentCurrentExecution {
  readonly input: FunctionConversationChildParentCapture<Owner>
  readonly inputFields: PureFields
  readonly owner: OwnerCurrentExecution
  readonly target: FunctionConversationTarget
  readonly ownerFields: PureFields
  readonly targetFields: PureFields
  readonly refFields: PureFields
  readonly incarnationFields: PureFields
  readonly targetExecution: FunctionConversationNativeParentTargetExecution
  readonly view: FunctionConversationNativeParentCurrent
  reading: boolean
  failed: boolean
}
export interface FunctionConversationNativeParentCurrent {
  readonly current: () => void
  assertDataCurrent(): void
}
const parentCurrentExecutions = new WeakMap<() => void, ParentCurrentExecution>()

function assertParentCurrentData(record: ParentCurrentExecution): void {
  if (record.failed || Reflect.apply(weakGet, parentCurrentExecutions, [record.view.current]) !== record)
    throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  assertPureFields(record.input, record.inputFields)
  assertPureFields(record.owner.owner, record.ownerFields)
  assertPureFields(record.target, record.targetFields)
  assertPureFields(record.target.ref, record.refFields)
  assertPureFields(record.target.ref.incarnation, record.incarnationFields)
  record.owner.assertDataCurrent()
  record.targetExecution.assertDataCurrent()
}

/** Exact Coordinator-created tuple and function; this only preserves its real binding execution. */
export function readFunctionConversationNativeParentCurrent(input: unknown):
  FunctionConversationNativeParentCurrent | undefined {
  if (!input || typeof input !== "object" || types.isProxy(input)) return undefined
  const field = Object.getOwnPropertyDescriptor(input, "assertCurrent")
  if (!field || !("value" in field) || typeof field.value !== "function" || types.isProxy(field.value))
    return undefined
  const record = Reflect.apply(weakGet, parentCurrentExecutions, [field.value]) as
    ParentCurrentExecution | undefined
  if (!record || record.input !== input) return undefined
  if (record.reading) { record.failed = true; throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED") }
  record.view.assertDataCurrent()
  return record.view
}

/** Self-built original Owner execution only. This does not certify an external callback. */
export function readFunctionConversationNativeOwnerCurrentExecution(current: unknown):
  OwnerCurrentExecution | undefined {
  if (typeof current !== "function" || types.isProxy(current)) return undefined
  const record = Reflect.apply(weakGet, ownerCurrentExecutions, [current]) as
    OwnerCurrentExecution | undefined
  if (!record) return undefined
  record.assertDataCurrent()
  return record
}

/** Only the original registration factory can supply this callback-free data composition. */
export function captureFunctionConversationSharedRegistrationDataChecker(
  registration: FunctionConversationSharedNativeRegistration, authority: ModRuntimeAuthority,
  destination: FunctionConversationNativeDestination):
  FunctionConversationSharedRegistrationDataChecker | undefined {
  const view = Reflect.apply(weakGet, actualSharedNativeRegistrations, [registration]) as
    FunctionConversationSharedNativeRegistrationView | undefined
  const capture = Reflect.apply(weakGet, registrationDataCheckers, [registration]) as
    ((authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination) =>
      FunctionConversationSharedRegistrationDataChecker | undefined) | undefined
  if (!view || view.authority !== authority || !capture)
    throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  return capture(authority, destination)
}

/** Original completion may bind one authentic mapping; no caller supplies an inspector. */
export function bindFunctionConversationSharedRegistrationPostflight(
  registration: FunctionConversationSharedNativeRegistration, authority: ModRuntimeAuthority,
  destination: FunctionConversationNativeDestination, active?: FunctionConversationSharedActive):
  FunctionConversationSharedRegistrationDataChecker | undefined {
  const view = Reflect.apply(weakGet, actualSharedNativeRegistrations, [registration]) as
    FunctionConversationSharedNativeRegistrationView | undefined
  const previous = Reflect.apply(weakGet, registrationPostflights, [registration]) as
    SharedRegistrationPostflight | undefined
  if (!view || view.authority !== authority || previous) {
    if (previous) previous.failed = true
    throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  }
  const database = getDb()
  const checker = captureFunctionConversationSharedRegistrationDataChecker(
    registration, authority, destination)
  if (!checker) return undefined
  if (active) {
    const bind = Reflect.apply(weakGet, registrationSourceBinders, [registration]) as
      ((active: FunctionConversationSharedActive, destination: FunctionConversationNativeDestination) => void)
      | undefined
    if (!bind) throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
    bind(active, destination)
  }
  if (getDb() !== database ||
    Reflect.apply(weakGet, actualSharedNativeRegistrations, [registration]) !== view ||
    Reflect.apply(weakGet, registrationPostflights, [registration]))
    throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  Reflect.apply(weakSet, registrationPostflights, [registration, { view, destination, database, checker,
    reading: false, failed: false }])
  return checker
}

/** Original module-owned reader; an overridden Coordinator method cannot certify a binding. */
export function readFunctionConversationSharedNativeRegistration(
  registration: FunctionConversationSharedNativeRegistration,
  coordinator: FunctionConversationCoordinator,
  authority: ModRuntimeAuthority): FunctionConversationSharedNativeRegistrationView {
  const view = actualSharedNativeRegistrations.get(registration)
  if (!view || view.coordinator !== coordinator || view.authority !== authority)
    throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
  view.assertCurrent()
  return view
}

export interface FunctionConversationCoordinatorHost {
  readonly authorities: Pick<ModRuntimeAuthorities, "get">
  assertScope(context: FunctionConversationOwnerContext): void
  readCurrentCheckpoint(threadId: string, signal: AbortSignal,
    assertCurrent: () => void): Promise<FunctionConversationCurrentCheckpoint | null>
  protect(context: FunctionConversationCallContext, value: ModJson,
    signal: AbortSignal, assertCurrent: () => void): Promise<unknown>
  apiMessages(messages: readonly unknown[]): import("../../../shared/mods/v2/session-append")
    .FunctionApiMessage[]
  changed(threadId: string, uuid?: string): void
}

/** Actual SessionEntry lifecycle owns admission; app SQLite owns saved rows. */
export class FunctionConversationCoordinator implements FunctionConversationManagerHost {
  readonly registry: FunctionConversationRegistry
  private readonly owners = new WeakMap<object, Owner>()
  private readonly current = new Map<string, Owner>()
  private readonly families: FunctionConversationChildFamilies<Owner>
  private readonly childTargets = new WeakMap<FunctionConversationChildFactory, FunctionConversationTarget>()
  private readonly destinations = new WeakMap<FunctionConversationTarget, FunctionConversationTranscriptProjection>()
  private readonly sharedTargets = new WeakMap<FunctionConversationSharedChildFactory, FunctionConversationTarget>()
  private readonly sharedNativeRegistrations = new WeakMap<
    FunctionConversationSharedNativeRegistration, FunctionConversationSharedNativeRegistrationView>()
  private readonly checkpointReaders = new WeakMap<FunctionConversationTarget,
    FunctionConversationSharedRegistration["readCheckpoint"]>()

  constructor(readonly store: FunctionConversationStore,
    private readonly host: FunctionConversationCoordinatorHost) {
    const scope = !types.isProxy(host) && Object.getOwnPropertyDescriptor(host, "assertScope")
    Reflect.apply(weakSet, ownerGuardCoordinators, [this, {
      fields: capturePureFields(this, ["store", "host"]), host,
      scope: undefined, scopeFields: undefined,
      ...(scope && "value" in scope && typeof scope.value === "function" &&
        !types.isProxy(scope.value) ? { scope: scope.value,
          scopeFields: capturePureFields(host, ["assertScope"]) } : {}) }])
    this.registry = new FunctionConversationRegistry(store, host.authorities)
    this.families = new FunctionConversationChildFamilies(host.authorities)
    originalCoordinatorData.set(this, {
      fields: capturePureFields(this, ["registry", "families", "sharedNativeRegistrations",
        "sharedTargets", "destinations", "owners", "current"]),
      registry: this.registry, families: this.families, registrations: this.sharedNativeRegistrations,
      targets: this.sharedTargets, destinations: this.destinations, owners: this.owners,
      current: this.current
    })
  }

  private key(context: FunctionConversationOwnerContext): string {
    return JSON.stringify([context.workspace, context.threadId])
  }

  openConversationOwner = (context: FunctionConversationOwnerContext): (() => void) => {
    // A candidate is indexed privately, but gains no active family or durable metadata.
    const thread = getThreadCore(context.threadId)
    if (!thread) throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
    const captured = Object.freeze({ ...context,
      assertCurrent: context.assertCurrent.bind(context) })
    const owner: Owner = { context: captured, incarnation: captureThreadIncarnation(thread),
      controller: new AbortController(), live: true }
    originalOwnerData.set(owner, { fields: capturePureFields(owner,
      ["context", "incarnation", "controller"]),
      incarnationFields: capturePureFields(owner.incarnation, ["token", "legacyCreatedAt"]),
      actualIncarnation: owner.incarnation, incarnation: Object.freeze({ ...owner.incarnation }),
      live: Object.getOwnPropertyDescriptor(owner, "live")!, context: captured,
      controllerSignal: Reflect.apply(controllerSignal, owner.controller, []) as AbortSignal })
    owner.child = this.families.forThread(context.workspace, context.threadId)
    owner.unboundInternalChild = !owner.child && isInternalFunctionChild(thread.metadata)
    // Pin original G/P before activation can invoke either callback. Membership remains unadmitted.
    this.captureOwnerCurrentExecution(owner, true)
    if (this.owners.has(context.owner))
      throw new ModFunctionError("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    const key = this.key(captured)
    this.owners.set(context.owner, owner)
    try {
      if (!context.readOnly) this.activateConversationOwner(context)
    } catch (error) {
      owner.live = false
      owner.controller.abort(error)
      if (this.current.get(key) === owner) this.current.delete(key)
      if (this.owners.get(context.owner) === owner) this.owners.delete(context.owner)
      throw error
    }
    let closed = false
    return () => {
      if (closed) return
      closed = true
      owner.live = false
      owner.controller.abort(new ModFunctionError("MODS_CONVERSATION_SESSION_CLOSED"))
      if (this.current.get(key) === owner) this.current.delete(key)
      if (owner.target && !owner.child) this.registry.closeOwner(captured.owner)
    }
  }

  activateConversationOwner = (context: FunctionConversationOwnerContext): void => {
    const owner = this.owners.get(context.owner)
    if (!owner || !owner.live || context.readOnly ||
      owner.context.workspace !== context.workspace || owner.context.threadId !== context.threadId)
      throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
    context.signal.throwIfAborted()
    context.assertCurrent()
    this.host.assertScope(context)
    if (!matchesThreadIncarnation(getThreadCore(context.threadId), owner.incarnation))
      throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
    // Loading old plugins is allowed; an internal runtime without the real factory cannot mint main.
    if (owner.unboundInternalChild) return
    const key = this.key(context), previous = this.current.get(key)
    if (previous?.live && previous !== owner)
      throw new ModFunctionError("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    if (previous === owner) {
      this.assertOwner(owner)
      return
    }
    this.current.set(key, owner)
    try {
      if (owner.child) {
        const family = this.families.read(owner.child)
        const authority = this.host.authorities.get({ workspace: context.workspace,
          threadId: context.threadId, agentId: family.input.agentId })
        if (!authority) throw new ModFunctionError("MODS_CONVERSATION_AUTHORITY_REQUIRED")
        owner.target = this.bindChild(owner.child, authority)
      }
      this.assertOwner(owner)
    }
    catch (error) {
      if (this.current.get(key) === owner) {
        if (previous) this.current.set(key, previous)
        else this.current.delete(key)
      }
      throw error
    }
  }

  private assertOwner(owner: Owner): void {
    assertOwnerFull(owner, {
      key: context => this.key(context), current: key => this.current.get(key),
      signal: signal => signal.throwIfAborted(), controller: controller => controller.signal,
      source: context => context.assertCurrent(), scope: context => this.host.assertScope(context),
      child: child => this.families.read(child).assertCurrent() })
  }

  private captureOwnerCurrentExecution(owner: Owner, beforeActivation = false): OwnerCurrentExecution | undefined {
    const previous = Reflect.apply(weakGet, ownerExecutions, [owner]) as OwnerCurrentExecution | undefined
    if (previous) { previous.assertDataCurrent(); return previous }
    const base = Reflect.apply(weakGet, ownerGuardCoordinators, [this]) as
      ReturnType<typeof ownerGuardCoordinators.get>
    const coordinator = Reflect.apply(weakGet, originalCoordinatorData, [this]) as
      ReturnType<typeof originalCoordinatorData.get>
    const original = Reflect.apply(weakGet, originalOwnerData, [owner]) as
      ReturnType<typeof originalOwnerData.get>
    if (!base?.scope || !base.scopeFields || !coordinator || !original || types.isProxy(owner))
      return undefined
    const child = Object.getOwnPropertyDescriptor(owner, "child")
    const unbound = Object.getOwnPropertyDescriptor(owner, "unboundInternalChild")
    const source = Object.getOwnPropertyDescriptor(original.context, "assertCurrent")
    if (!child || !("value" in child) || child.value !== undefined || !unbound ||
      !("value" in unbound) || unbound.value !== false || !source || !("value" in source) ||
      typeof source.value !== "function" || types.isProxy(source.value)) return undefined
    const leaseCurrent = captureLocalThreadRunLease(original.context.threadId)
    if (!leaseCurrent) return undefined
    const fields = capturePureFields(owner, ["child", "unboundInternalChild"])
    const contextFields = capturePureFields(original.context,
      ["owner", "workspace", "threadId", "signal", "readOnly", "assertCurrent"])
    const originalSource = source.value as () => void, originalScope = base.scope
    const database = getDb(), store = this.store
    const key = JSON.stringify([original.context.workspace, original.context.threadId])
    let reading = false, failed = false
    const assertDataCurrent = () => {
      try {
        if (failed || !leaseCurrent() || getDb() !== database ||
          Reflect.apply(weakGet, ownerCurrentExecutions, [current]) !== execution ||
          Reflect.apply(weakGet, ownerExecutions, [owner]) !== execution ||
          Reflect.apply(weakGet, originalCoordinatorData, [this]) !== coordinator ||
          Reflect.apply(weakGet, originalOwnerData, [owner]) !== original ||
          Reflect.apply(weakGet, ownerGuardCoordinators, [this]) !== base)
          throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
        assertPureFields(this, base.fields)
        assertPureFields(this, coordinator.fields)
        assertPureFields(base.host, base.scopeFields!)
        assertPureFields(owner, original.fields)
        assertPureFields(owner, fields)
        assertPureFields(original.actualIncarnation, original.incarnationFields)
        assertPureFields(original.context, contextFields)
        const live = Object.getOwnPropertyDescriptor(owner, "live")
        if (!live || !("value" in live) || live.value !== true ||
          live.writable !== original.live.writable || live.enumerable !== original.live.enumerable ||
          live.configurable !== original.live.configurable ||
          Reflect.apply(weakGet, coordinator.owners, [original.context.owner]) !== owner ||
          Reflect.apply(mapGet, coordinator.current, [key]) !== owner)
          throw new ModFunctionError("MODS_CONVERSATION_SESSION_CLOSED")
        Reflect.apply(signalThrowIfAborted, original.context.signal, [])
        Reflect.apply(signalThrowIfAborted, original.controllerSignal, [])
      } catch (error) { failed = true; throw error }
    }
    const current = () => {
      if (reading || failed) { failed = true; throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED") }
      reading = true
      try {
        assertDataCurrent()
        assertOwnerFull(owner, { key: () => key,
          current: value => Reflect.apply(mapGet, coordinator.current, [value]) as Owner | undefined,
          signal: signal => { Reflect.apply(signalThrowIfAborted, signal, []) },
          controller: () => original.controllerSignal,
          source: () => { Reflect.apply(originalSource, original.context, []); assertDataCurrent() },
          scope: () => { Reflect.apply(originalScope, base.host, [original.context]); assertDataCurrent() },
          child: () => { throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED") } })
        assertDataCurrent()
      } catch (error) { failed = true; throw error }
      finally { reading = false }
    }
    const execution: OwnerCurrentExecution = Object.freeze({ coordinator: this, owner,
      database, store, current, assertDataCurrent })
    Reflect.apply(weakSet, ownerCurrentExecutions, [current, execution])
    Reflect.apply(weakSet, ownerExecutions, [owner, execution])
    if (!beforeActivation) assertDataCurrent()
    return execution
  }

  private owner(context: FunctionConversationOwnerContext): Owner {
    const owner = this.owners.get(context.owner)
    if (!owner || context.readOnly || owner.context.workspace !== context.workspace ||
      owner.context.threadId !== context.threadId)
      throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
    this.activateConversationOwner(context)
    this.assertOwner(owner)
    return owner
  }

  private prepare(owner: Owner): Promise<FunctionConversationTarget> {
    this.assertOwner(owner)
    if (owner.child) {
      const target = this.childTargets.get(owner.child)
      if (!target) throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
      target.assertCurrent()
      return Promise.resolve(target)
    }
    if (!owner.preparing) {
      const context = owner.context
      owner.preparing = (async () => {
        const guard = this.captureOwnerCurrentExecution(owner)?.current ?? (() => this.assertOwner(owner))
        const signal = AbortSignal.any([context.signal, owner.controller.signal])
        const checkpoint = await this.host.readCurrentCheckpoint(context.threadId, signal, guard)
        guard()
        let ref = this.store.ensureMain({ threadId: context.threadId,
          workspace: context.workspace, incarnation: owner.incarnation,
          checkpointNamespace: "" }, guard)
        if (checkpoint?.state) {
          const state = readFunctionConversationState(checkpoint.state)
          ref = this.store.selectBranch(ref, state.branchId, guard)
          assertFunctionConversationState(ref, state)
          if (state.frontier > this.store.highWater(ref))
            throw new ModFunctionError("MODS_CONVERSATION_FRONTIER_INVALID")
        }
        guard()
        const target = this.registry.registerMain(context.owner, { identity: owner,
          ref, checkpointThreadId: context.threadId, signal, assertCurrent: guard })
        owner.target = target
        return target
      })()
    }
    return owner.preparing
  }

  private async resolve(context: FunctionConversationOwnerContext,
    agentId?: string, mode: "append" | "read" = "append"): Promise<FunctionConversationTarget> {
    const owner = this.owner(context)
    await this.prepare(owner)
    this.assertOwner(owner)
    return this.registry.resolve(this.resident(owner).context.owner, agentId, mode)
  }

  private resident(owner: Owner): Owner {
    return owner.child ? this.families.read(owner.child).parent.owner : owner
  }

  captureChildParent(workspace: string, threadId: string, binding: FunctionConversationGraphBinding,
    assertFactory: () => void, authority?: ModRuntimeAuthority): FunctionConversationChildParent | undefined {
    assertFactory()
    binding.assertCurrent()
    const source = this.current.get(JSON.stringify([workspace, threadId]))
    if (!source) return undefined
    this.assertOwner(source)
    const shared = authority ? this.families.forSharedAuthority(authority) : undefined
    const sharedFamily = shared ? this.families.readShared(shared) : undefined
    const owner = sharedFamily?.parent.owner ?? this.resident(source)
    this.assertOwner(owner)
    const ref = sharedFamily?.parent.target ??
      (source.child ? this.families.read(source.child).parent.target : binding.target)
    const sourceTarget = shared ? this.sharedTargets.get(shared) :
      source.child ? this.childTargets.get(source.child) : undefined
    if (ref.kind !== "main" || ref.workspace !== workspace ||
      ((source.child || shared) && (!sourceTarget || !this.sameRef(sourceTarget.ref, binding.target))))
      throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
    this.store.assertCurrent(ref)
    if (!owner.target) {
      owner.target = this.registry.registerMain(owner.context.owner, { identity: owner,
        ref, checkpointThreadId: ref.threadId,
        signal: AbortSignal.any([owner.context.signal, owner.controller.signal]),
        assertCurrent: this.captureOwnerCurrentExecution(owner)?.current ?? (() => this.assertOwner(owner)) })
      owner.preparing = Promise.resolve(owner.target)
    }
    const target = owner.target
    if (!this.sameRef(target.ref, ref)) throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
    const parent = this.captureParentCurrent(owner, target, threadId, assertFactory) ??
      { owner, target: target.ref,
      physicalParentThreadId: threadId, signal: target.signal,
      assertCurrent: () => { this.assertOwner(owner); target.assertCurrent() }, assertFactory }
    return this.families.captureParent(parent)
  }

  private sameRef(first: import("../../db/function-conversation-store").FunctionConversationRef,
    second: import("../../db/function-conversation-store").FunctionConversationRef): boolean {
    return first.logicalSessionId === second.logicalSessionId &&
      first.conversationId === second.conversationId && first.branchId === second.branchId &&
      first.threadId === second.threadId && first.workspace === second.workspace &&
      first.checkpointNamespace === second.checkpointNamespace && first.kind === second.kind &&
      first.incarnation.token === second.incarnation.token &&
      first.incarnation.legacyCreatedAt === second.incarnation.legacyCreatedAt
  }

  private captureParentCurrent(owner: Owner, target: FunctionConversationTarget,
    physicalParentThreadId: string, assertFactory: () => void):
    FunctionConversationChildParentCapture<Owner> | undefined {
    const ownerExecution = this.captureOwnerCurrentExecution(owner)
    if (!ownerExecution) return undefined
    const targetExecution = readFunctionConversationNativeParentTargetExecution(
      this.registry, target, ownerExecution.current)
    if (!targetExecution) return undefined
    const original = Reflect.apply(weakGet, originalOwnerData, [owner]) as
      ReturnType<typeof originalOwnerData.get>
    if (!original || target.ref.threadId !== original.context.threadId ||
      target.ref.workspace !== original.context.workspace || target.ref.kind !== "main" ||
      target.ref.incarnation.token !== original.incarnation.token ||
      target.ref.incarnation.legacyCreatedAt !== original.incarnation.legacyCreatedAt)
      throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
    const assertDataCurrent = () => {
      try { assertParentCurrentData(record) }
      catch (error) { record.failed = true; throw error }
    }
    const current = () => {
      if (record.reading || record.failed) {
        record.failed = true
        throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
      }
      record.reading = true
      try {
        assertDataCurrent()
        targetExecution.assertCurrent()
        assertDataCurrent()
        if (!matchesThreadIncarnation(getThreadCore(original.context.threadId), original.incarnation))
          throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
        assertDataCurrent()
      } catch (error) { record.failed = true; throw error }
      finally { record.reading = false }
    }
    const input: FunctionConversationChildParentCapture<Owner> = { owner, target: target.ref,
      physicalParentThreadId, signal: target.signal, assertCurrent: current, assertFactory }
    const view: FunctionConversationNativeParentCurrent = Object.freeze({ current, assertDataCurrent })
    const record: ParentCurrentExecution = { input,
      inputFields: capturePureFields(input,
        ["owner", "target", "physicalParentThreadId", "signal", "assertCurrent", "assertFactory"]),
      owner: ownerExecution, target, ownerFields: capturePureFields(owner, ["target"]),
      targetFields: capturePureFields(target, ["ref", "checkpointThreadId", "signal", "assertCurrent"]),
      refFields: capturePureFields(target.ref, ["logicalSessionId", "conversationId", "branchId",
        "threadId", "workspace", "incarnation", "checkpointNamespace", "kind"]),
      incarnationFields: capturePureFields(target.ref.incarnation, ["token", "legacyCreatedAt"]),
      targetExecution, view, reading: false, failed: false }
    Reflect.apply(weakSet, parentCurrentExecutions, [current, record])
    assertDataCurrent()
    return input
  }

  registerIndependentChild(parent: FunctionConversationChildParent,
    input: FunctionConversationIndependentChildInput): () => void {
    const proof = this.families.register(parent, input)
    return () => this.families.retire(proof)
  }

  /** Admission is the real router's first native query, never a saved stamp or public task name. */
  registerSharedChild(parent: FunctionConversationChildParent,
    input: FunctionConversationSharedRegistration): {
      readonly binding: FunctionConversationGraphBinding
      readonly registration: FunctionConversationSharedNativeRegistration
      close(): void
    } {
    const read = readFunctionConversationSharedNativeRead(input.nativeRead, input.saver, input.authority)
    read.assertCurrent()
    if (read.namespace !== input.checkpointNamespace ||
      read.config.configurable?.thread_id !== input.checkpointThreadId)
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    const restored = input.restore ? readFunctionConversationSharedRestore(input.restore, {
      nativeRead: input.nativeRead, saver: input.saver, authority: input.authority,
      invocation: input.invocation, parent: this.families.readParent(parent).target,
      destinationThreadId: input.destination.threadId,
      destinationIncarnation: input.destination.incarnation }) : undefined
    if (Boolean(read.tuple) !== Boolean(restored))
      throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
    const proof = this.families.registerShared(parent, input)
    const family = this.families.readShared(proof), owner = family.parent.owner
    const guard = () => { family.assertCurrent(); this.assertOwner(owner)
      this.store.assertCurrent(family.parent.target) }
    try {
      guard()
      const ref = restored?.target ?? this.store.createChild(family.parent.target,
        { invocationId: input.authority.turnId, checkpointNamespace: read.namespace }, guard,
        ref => {
          const originalMetadata = getThreadCore(family.input.destination.threadId)?.metadata
          if (!originalMetadata) throw new ModFunctionError("MODS_CONVERSATION_DESTINATION_CHANGED")
          recordFunctionConversationNativeDestinationInTransaction(getDb(), ref, {
            parent: family.parent.target, invocationId: input.authority.turnId,
            checkpointThreadId: family.input.checkpointThreadId,
            checkpointIncarnation: family.input.checkpointIncarnation,
            destinationThreadId: family.input.destination.threadId,
            destinationIncarnation: family.input.destination.incarnation,
            originalMetadata, assertCurrent: guard })
        })
      if (restored) restored.assertCurrent()
      const target = this.registry.registerChild(owner.context.owner, { identity: proof, ref,
        checkpointThreadId: family.input.checkpointThreadId, authority: family.input.authority,
        signal: family.signal, assertCurrent: guard })
      this.sharedTargets.set(proof, target)
      this.destinations.set(target, Object.freeze({ conversation: target.ref,
        threadId: family.input.destination.threadId, incarnation: family.input.destination.incarnation,
        assertCurrent: () => { target.assertCurrent(); family.input.destination.assertCurrent() } }))
      this.checkpointReaders.set(target, input.readCheckpoint.bind(input))
      this.families.onSharedRetire(proof, () => this.registry.retire(target))
      const binding = Object.freeze({ target: target.ref,
        checkpointThreadId: family.input.checkpointThreadId,
        checkpointIncarnation: family.input.checkpointIncarnation,
        runtimeCheckpointNamespace: read.namespace, initialState: restored?.state ?? functionConversationState(target.ref),
        signal: family.signal, assertCurrent: () => target.assertCurrent() })
      binding.assertCurrent()
      const destination = this.destinations.get(target)
      if (!destination) throw new ModFunctionError("MODS_CONVERSATION_DESTINATION_CHANGED")
      const registration = Object.freeze({ [sharedNativeRegistrationBrand]: true as const })
      const database = getDb(), ownerKey = this.key(owner.context)
      const originalData = originalCoordinatorData.get(this)
      const ownerData = originalOwnerData.get(owner)
      if (!originalData || !ownerData) throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
      const assertDataFacts = () => {
        assertPureFields(this, originalData.fields)
        assertPureFields(owner, ownerData.fields)
        assertPureFields(ownerData.actualIncarnation, ownerData.incarnationFields)
        const live = Object.getOwnPropertyDescriptor(owner, "live")
        if (Reflect.apply(weakGet, originalData.registrations, [registration]) !== view ||
          Reflect.apply(weakGet, originalCoordinatorData, [this]) !== originalData ||
          Reflect.apply(weakGet, originalOwnerData, [owner]) !== ownerData ||
          Reflect.apply(weakGet, actualSharedNativeRegistrations, [registration]) !== view ||
          getDb() !== database ||
          Reflect.apply(weakGet, originalData.targets, [proof]) !== target ||
          Reflect.apply(weakGet, originalData.destinations, [target]) !== destination ||
          !live || !("value" in live) || live.value !== true ||
          live.writable !== ownerData.live.writable || live.enumerable !== ownerData.live.enumerable ||
          live.configurable !== ownerData.live.configurable ||
          Reflect.apply(weakGet, originalData.owners, [ownerData.context.owner]) !== owner ||
          Reflect.apply(mapGet, originalData.current, [ownerKey]) !== owner)
          throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
        Reflect.apply(signalThrowIfAborted, ownerData.context.signal, [])
        Reflect.apply(signalThrowIfAborted, ownerData.controllerSignal, [])
      }
      const assertDataCurrent = () => {
        assertDataFacts()
        const postflight = Reflect.apply(weakGet, registrationPostflights, [registration]) as
          SharedRegistrationPostflight | undefined
        if (postflight) {
          if (postflight.view !== view || postflight.database !== database ||
            postflight.reading || postflight.failed) {
            postflight.failed = true
            throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
          }
          postflight.reading = true
          try {
            withFunctionConversationNativeDestinationDataScope(postflight.destination, database,
              scope => { postflight.checker.assertInDestinationScope(scope) })
            assertDataFacts()
            if (postflight.failed ||
              Reflect.apply(weakGet, registrationPostflights, [registration]) !== postflight)
              throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
            return
          } catch (error) { postflight.failed = true; throw error }
          finally { postflight.reading = false }
        }
        this.families.assertSharedDataCurrent(proof)
        this.registry.assertTargetDataCurrent(owner.context.owner, target, input.authority)
        if (!matchesThreadIncarnation(getThreadCore(ownerData.context.threadId), ownerData.incarnation))
          throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
        assertDataFacts()
      }
      const view: FunctionConversationSharedNativeRegistrationView = Object.freeze({
        coordinator: this, owner: owner.context.owner, target, binding, authority: input.authority,
        invocation: input.invocation, destination,
        assertCurrent: () => {
          family.assertCurrent()
          this.assertOwner(owner)
          destination.assertCurrent?.()
          assertDataCurrent()
        }, assertDataCurrent
      })
      this.sharedNativeRegistrations.set(registration, view)
      actualSharedNativeRegistrations.set(registration, view)
      const captureDataChecker = (authority: ModRuntimeAuthority,
        nativeDestination: FunctionConversationNativeDestination):
        FunctionConversationSharedRegistrationDataChecker | undefined => {
        assertDataFacts()
        if (authority !== input.authority || view.authority !== authority)
          throw new ModFunctionError("MODS_CONVERSATION_AUTHORITY_CHANGED")
        if (!matchesFunctionConversationNativeDestinationData(nativeDestination, database,
          target.ref, family.parent.target) ||
          !coversFunctionConversationNativeDestinationThread(nativeDestination, database,
            ownerData.context.threadId, ownerData.incarnation)) return undefined
        const familyChecker = captureFunctionConversationSharedFamilyDataChecker(
          originalData.families, proof, authority, nativeDestination, database)
        if (!familyChecker) return undefined
        const registry = originalData.registry
        const targetData = () => { assertFunctionConversationRegistryTargetDataCurrent(
          registry, ownerData.context.owner, target, authority) }
        const checker = Object.freeze({ assertInDestinationScope:
          (scope: FunctionConversationNativeDestinationDataScope) => {
            assertDataFacts()
            if (Reflect.apply(weakGet, registrationDataCheckers, [registration]) !== captureDataChecker)
              throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
            familyChecker.assertInDestinationScope(scope)
            targetData()
            assertFunctionConversationNativeDestinationScopeThread(scope, nativeDestination,
              database, ownerData.context.threadId, ownerData.incarnation)
            assertDataFacts()
          } })
        assertDataFacts()
        return checker
      }
      registrationDataCheckers.set(registration, captureDataChecker)
      Reflect.apply(weakSet, registrationSourceBinders, [registration,
        (active: FunctionConversationSharedActive, nativeDestination: FunctionConversationNativeDestination) => {
          assertDataFacts()
          bindFunctionConversationSharedFamilySourcePlan(originalData.families, proof,
            input.authority, nativeDestination, active, database)
          assertDataFacts()
        }])
      view.assertCurrent()
      return { binding, registration, close: () => this.families.retireShared(proof) }
    } catch (error) { this.families.retireShared(proof); throw error }
  }

  /** Exact original registration only; a copied binding or serialized reference cannot mint it. */
  readSharedNativeRegistration(registration: FunctionConversationSharedNativeRegistration,
    authority: ModRuntimeAuthority): FunctionConversationSharedNativeRegistrationView {
    return readFunctionConversationSharedNativeRegistration(registration, this, authority)
  }

  captureSharedRuntime(authority: ModRuntimeAuthority): FunctionConversationGraphBinding | undefined {
    const proof = this.families.forSharedAuthority(authority)
    if (!proof) return undefined
    const family = this.families.readShared(proof), target = this.sharedTargets.get(proof)
    if (!target) throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
    target.assertCurrent()
    return { target: target.ref, checkpointThreadId: family.input.checkpointThreadId,
      checkpointIncarnation: family.input.checkpointIncarnation,
      runtimeCheckpointNamespace: target.ref.checkpointNamespace, signal: family.signal,
      initialState: functionConversationState(target.ref), assertCurrent: () => target.assertCurrent() }
  }

  private bindChild(proof: FunctionConversationChildFactory,
    authority: ModRuntimeAuthority): FunctionConversationTarget {
    this.families.bind(proof, authority)
    const existing = this.childTargets.get(proof)
    if (existing) { existing.assertCurrent(); return existing }
    const family = this.families.read(proof), parent = family.parent.owner
    this.assertOwner(parent)
    if (!parent.target || !this.sameRef(parent.target.ref, family.parent.target))
      throw new ModFunctionError("MODS_CONVERSATION_TARGET_CHANGED")
    const guard = () => { this.families.read(proof).assertCurrent(); this.store.assertCurrent(family.parent.target) }
    const ref = this.store.createChild(family.parent.target,
      { invocationId: family.input.runId, checkpointNamespace: "" }, guard)
    const target = this.registry.registerChild(parent.context.owner, { identity: proof, ref,
      checkpointThreadId: family.input.physicalThreadId, authority,
      signal: family.signal, assertCurrent: guard })
    this.childTargets.set(proof, target)
    this.destinations.set(target, Object.freeze({ conversation: target.ref,
      threadId: family.input.physicalThreadId, incarnation: family.input.checkpointIncarnation,
      assertCurrent: () => target.assertCurrent() }))
    this.families.onRetire(proof, () => this.registry.retire(target))
    target.assertCurrent()
    return target
  }

  prepareIndependentRuntime(authority: ModRuntimeAuthority, signal: AbortSignal,
    assertRuntime: () => void) {
    assertRuntime()
    const proof = this.families.forThread(authority.workspace, authority.threadId)
    if (!proof) return undefined
    const target = this.bindChild(proof, authority), family = this.families.read(proof)
    const guard = () => { signal.throwIfAborted(); assertRuntime(); family.assertCurrent()
      this.store.assertCurrent(target.ref) }
    guard()
    return { ref: target.ref, state: functionConversationState(target.ref), signal,
      checkpointIncarnation: family.input.checkpointIncarnation, assertCurrent: guard }
  }

  appendSession = async (context: FunctionConversationCallContext,
    args: FunctionSessionAppendArgs, source: FunctionSessionAppendSource,
    run: FunctionConversationAppendRun) => {
    validateFunctionSessionAppendArgs(args)
    const target = await this.resolve(context, args.agentId)
    const owner = this.owner(context)
    const sourceGuard = source.assertCurrent.bind(source)
    const assertCurrent = () => {
      context.signal.throwIfAborted()
      context.assertCurrent()
      this.assertOwner(owner)
      sourceGuard()
      this.host.assertScope(context)
    }
    const mutation = { owner: this.resident(owner).context.owner, plugin: context.plugin,
      registration: source.identity, signal: source.signal, assertCurrent }
    return this.registry.runMutation(mutation, target, "sdk", async (signal, guard) => {
      const input: FunctionSessionAppendInput = {
        uuid: randomUUID(), door: "note", origin: { kind: "plugin", name: context.plugin.name },
        ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
        message: { type: args.message.type, content: args.message.content,
          ...(args.message.type === "user" ? { role: "user", isMeta: true } : {}) }
      }
      const access = createFunctionConversationTranscriptAccess((_ref, row) => ({
        id: row.uuid, role: row.message.type as "user" | "system",
        content: row.message.content as import("../../types").ThreadMessageWrite["content"],
        created_at: new Date(row.createdAt)
      }), this.destinations.get(target))
      const ticket = new FunctionSessionAppendTicket({ kind: "sdk", input, target,
        source: mutation, signal, assertCurrent: guard,
        protect: (value, protectionSignal, protectionGuard) =>
          this.host.protect(context, value, protectionSignal, protectionGuard),
        prepare: async value => {
          guard()
          const commit = { uuid: value.uuid, inputDigest: ticket.inputDigest,
            door: value.door, origin: value.origin, message: value.message,
            nativePayload: serializeFunctionConversationNativeMessage(
              value.message.type === "user" ? new HumanMessage({ id: value.uuid,
                content: value.message.content as HumanMessage["content"],
                additional_kwargs: { isMeta: true } }) : new SystemMessage({ id: value.uuid,
                content: value.message.content as SystemMessage["content"] })),
            orderAnchor: { kind: "sdk-note" }, inbox: value.message.type === "user", sdk: true }
          return {
            commit: check => this.store.commit(target.ref, commit, check, access.write, access.verify),
            read: () => {
              guard()
              const stored = this.store.readReceipt(target.ref, value.uuid)
              if (stored) access.verify(getDb(), target.ref, stored)
              return stored
            }
          }
        }
      })
      const result = await run(ticket)
      const accepted = ticket.acceptResult(result)
      if (ticket.committedRow) {
        try {
          this.host.changed(this.destinations.get(target)?.threadId ?? target.ref.threadId,
            ticket.committedRow.uuid)
        } catch {
          // The canonical ACK is durable; a lost UI notification cannot replay this save.
          console.warn("[Mods conversation] Saved-row notification unavailable")
        }
      }
      return accepted
    })
  }

  readConversation = async (context: FunctionConversationCallContext,
    args: FunctionSessionMessagesArgs): Promise<FunctionConversationMessages> => {
    validateFunctionSessionMessagesArgs(args)
    let target: FunctionConversationTarget
    try { target = await this.resolve(context, args.agentId, "read") }
    catch (error) {
      if (args.agentId !== undefined && error instanceof ModFunctionError &&
        error.code === "MODS_CONVERSATION_UNAVAILABLE") return { deny: error.code }
      throw error
    }
    const owner = this.owner(context)
    const guard = () => {
      context.signal.throwIfAborted()
      context.assertCurrent()
      this.assertOwner(owner)
      target.assertCurrent("read")
      this.host.assertScope(context)
    }
    guard()
    const highWater = this.store.highWater(target.ref)
    const reader = this.checkpointReaders.get(target)
    const checkpoint = reader ? await reader(context.signal, guard) :
      await this.host.readCurrentCheckpoint(target.checkpointThreadId, context.signal, guard)
    guard()
    if (checkpoint?.state) assertFunctionConversationState(target.ref, checkpoint.state)
    const rows = this.store.readRows(target.ref, { highWater })
    const messages: unknown[] = [...(checkpoint?.messages ?? [])]
    for (const row of rows) {
      if (!row.inbox || row.message.type !== "user" || row.message.isMeta !== true) continue
      const candidates = messages.filter(value => {
        const stamp = readFunctionConversationTranscriptStamp(value)
        const id = value && typeof value === "object"
          ? Object.getOwnPropertyDescriptor(value, "id") : undefined
        return (id && "value" in id && id.value === row.uuid) || stamp?.uuid === row.uuid
      })
      const canonical = functionConversationNoteMessage(row, target.ref)
      if (candidates.length) {
        const saved = candidates[0], savedStamp = readFunctionConversationTranscriptStamp(saved)
        const canonicalStamp = readFunctionConversationTranscriptStamp(canonical)
        if (candidates.length !== 1 || !HumanMessage.isInstance(saved) || saved.id !== row.uuid ||
          !savedStamp || !canonicalStamp ||
          !sameFunctionConversationTranscriptStamp(canonicalStamp, savedStamp) ||
          JSON.stringify(saved.content) !== JSON.stringify(canonical.content) ||
          serializeFunctionConversationNativeMessage(saved) !== row.nativePayload)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      } else messages.push(canonical)
    }
    guard()
    return args.as === "api" ? this.host.apiMessages(messages) : projectFunctionSessionMessages(messages)
  }

  async prepareRuntime(workspace: string, threadId: string): Promise<{
    target: FunctionConversationTarget
    state: FunctionConversationState
  }> {
    const owner = this.current.get(JSON.stringify([workspace, threadId]))
    if (!owner) throw new ModFunctionError("MODS_CONVERSATION_UNAVAILABLE")
    const target = await this.prepare(owner)
    const checkpoint = await this.host.readCurrentCheckpoint(threadId,
      target.signal, () => target.assertCurrent())
    target.assertCurrent()
    const state = checkpoint?.state ?? functionConversationState(target.ref)
    assertFunctionConversationState(target.ref, state)
    return { target, state }
  }

  /** A real graph owns its lifetime independently of a loaded/retired Guest Session. */
  async prepareNativeRuntime(workspace: string, threadId: string, signal: AbortSignal,
    assertCurrent: () => void) {
    const thread = getThreadCore(threadId)
    if (!thread) throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
    if (this.families.forThread(workspace, threadId) || isInternalFunctionChild(thread.metadata))
      return undefined
    const incarnation = captureThreadIncarnation(thread)
    const guard = () => {
      signal.throwIfAborted()
      assertCurrent()
      if (!matchesThreadIncarnation(
        readFunctionConversationThreadIdentityCurrent(getDb(), threadId), incarnation))
        throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
    }
    guard()
    const input = { workspace, threadId, incarnation, checkpointNamespace: "" }
    let ref = this.store.findMain(input, guard)
    // Ordinary chat does not open a cold Saver or scan history for an unused adapter.
    // Capture this owner before awaiting; a replacement cannot become the old call's backend.
    const owner = !ref ? this.current.get(JSON.stringify([workspace, threadId])) : undefined
    if (!ref && !owner) return undefined
    if (owner) this.assertOwner(owner)
    const checkpoint = await this.host.readCurrentCheckpoint(threadId, signal, guard)
    guard()
    if (!ref) {
      if (checkpoint?.state) throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
      if (!owner) return undefined
      this.assertOwner(owner)
      ref = this.store.ensureMain(input, () => { guard(); this.assertOwner(owner) })
    }
    const state = checkpoint?.state ?? functionConversationState(ref)
    if (checkpoint?.state) ref = this.store.selectBranch(ref, state.branchId, guard)
    assertFunctionConversationState(ref, state)
    if (state.frontier > this.store.highWater(ref))
      throw new ModFunctionError("MODS_CONVERSATION_FRONTIER_INVALID")
    guard()
    return { ref, state, signal, checkpointIncarnation: incarnation, assertCurrent: guard }
  }
}
