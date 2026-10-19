import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { types } from "node:util"
import type { FunctionConversationRef } from "../../db/function-conversation-store"
import { getDb, getThreadCore } from "../../db"
import { readFunctionConversationThreadIdentityCurrent } from
  "../../db/function-conversation-thread-identity-read"
import { assertFunctionConversationNativeDestinationScopeThread,
  coversFunctionConversationNativeDestinationThread,
  type FunctionConversationNativeDestination,
  type FunctionConversationNativeDestinationDataScope } from
  "../../db/function-conversation-native-destination"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { captureThreadIncarnation, matchesThreadIncarnation,
  type ThreadIncarnation, type ThreadIncarnationRow } from "../../services/thread-incarnation"
import { isModRuntimeAuthorityDataCurrent, type ModRuntimeAuthorities,
  type ModRuntimeAuthority } from "../runtime-instance"
import { readFunctionConversationSharedRestore, type FunctionConversationSharedRestore } from
  "./conversation-shared-restore"
import type { FunctionConversationSharedActive } from "./conversation-shared-restore"
import { readFunctionConversationSharedFamilySourcePair,
  captureFunctionConversationSharedFamilySourcePlan,
  type FunctionConversationSharedFamilySourcePair } from "./conversation-shared-source-current"
import { readFunctionConversationNativeParentCurrent } from "./conversation-coordinator"

const parentBrand = Symbol("function-conversation-child-parent")
const childBrand = Symbol("function-conversation-child-factory")
const sharedBrand = Symbol("function-conversation-shared-child-factory")
export interface FunctionConversationChildParent { readonly [parentBrand]: true }
export interface FunctionConversationChildFactory { readonly [childBrand]: true }
export interface FunctionConversationSharedChildFactory { readonly [sharedBrand]: true }
export interface FunctionConversationSharedFamilyDataChecker {
  assertInDestinationScope(scope: FunctionConversationNativeDestinationDataScope): void
}

export interface FunctionConversationChildParentCapture<T extends object> {
  readonly owner: T
  readonly target: FunctionConversationRef
  readonly physicalParentThreadId: string
  readonly signal: AbortSignal
  /** Captured family owner/branch. It does not confer the parent's runtime/tool authority. */
  assertCurrent(): void
  /** Original runtime/graph scope, checked before factory ownership is handed off. */
  assertFactory(): void
}

export interface FunctionConversationIndependentChildInput {
  readonly invocation: object
  readonly physicalThreadId: string
  readonly agentId: string
  readonly runId: string
  readonly checkpointIncarnation: ThreadIncarnation
  readonly signal: AbortSignal
  assertCurrent(): void
}

export interface FunctionConversationSharedChildInput {
  readonly invocation: object
  readonly authority: ModRuntimeAuthority
  readonly checkpointThreadId: string
  readonly checkpointIncarnation: ThreadIncarnation
  readonly checkpointNamespace: string
  readonly restore?: FunctionConversationSharedRestore
  readonly destination: {
    readonly threadId: string
    readonly incarnation: ThreadIncarnation
    assertCurrent(): void
  }
  readonly signal: AbortSignal
  assertCurrent(): void
}

interface SharedChild<T extends object> {
  readonly kind: "shared"
  readonly parent: Parent<T>
  readonly input: FunctionConversationSharedChildInput
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly leaseCurrent: () => boolean
  readonly proof: FunctionConversationSharedChildFactory
  live: boolean
  retire?: () => void
}

type Parent<T extends object> = FunctionConversationChildParentCapture<T> & {
  readonly captureIndependentCurrent?: () => () => void
}
interface Child<T extends object> {
  readonly parent: Parent<T>
  readonly input: FunctionConversationIndependentChildInput
  readonly controller: AbortController
  readonly leaseCurrent: () => boolean
  readonly proof: FunctionConversationChildFactory
  readonly signal: AbortSignal
  live: boolean
  authority?: ModRuntimeAuthority
  retire?: () => void
}

interface PureFields {
  readonly prototype: object | null
  readonly fields: ReadonlyArray<readonly [string, PropertyDescriptor]>
}
function capturePureFields(value: object, keys: readonly string[]): PureFields {
  return { prototype: Object.getPrototypeOf(value), fields: keys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) fail()
    return [key, field] as const
  }) }
}
function assertPureFields(value: object, original: PureFields): void {
  if (Object.getPrototypeOf(value) !== original.prototype) fail()
  for (let index = 0; index < original.fields.length; index++) {
    const key = original.fields[index][0], expected = original.fields[index][1]
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field) || field.value !== expected.value ||
      field.writable !== expected.writable || field.enumerable !== expected.enumerable ||
      field.configurable !== expected.configurable) fail()
  }
}
const weakGet = WeakMap.prototype.get, weakHas = WeakMap.prototype.has, weakSet = WeakMap.prototype.set
const setHas = Set.prototype.has, familyBind = Function.prototype.bind
function readData<K extends object, V>(records: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(weakGet, records, [key]) as V | undefined
}
const actualFamilyInstances = new WeakMap<object, {
  assertFields(): void
  readChild(proof: FunctionConversationSharedChildFactory): object | undefined
  readAuthority(authority: ModRuntimeAuthority): object | undefined
  hasLive(child: object): boolean
}>()
const sharedChildFacts = new WeakMap<object, {
  readonly fields: PureFields
  readonly live: PropertyDescriptor
  readonly input: FunctionConversationSharedChildInput
  readonly parent: FunctionConversationChildParentCapture<object>
  readonly signal: AbortSignal
  readonly controllerSignal: AbortSignal
  readonly proof: FunctionConversationSharedChildFactory
  readonly leaseCurrent: () => boolean
}>()
interface SharedFamilyExecution {
  readonly proof: FunctionConversationSharedChildFactory
  readonly pair: FunctionConversationSharedFamilySourcePair
  readonly originalInput: FunctionConversationSharedChildInput
  readonly inputFields: PureFields
  readonly destinationFields: PureFields
  readonly current: () => void
  readonly destinationCurrent: () => void
  plan?: Readonly<{ assertCurrent(): void; assertDataCurrent(): void
    assertDestinationData(row: ThreadIncarnationRow | null): void }>
  reading: boolean
  failed: boolean
}
const sharedFamilyExecutions = new WeakMap<object, SharedFamilyExecution>()
const signalThrowIfAborted = AbortSignal.prototype.throwIfAborted
const controllerSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!
let originalSharedDataFacts: <T extends object>(families: FunctionConversationChildFamilies<T>,
  child: SharedChild<T>, proof: FunctionConversationSharedChildFactory) => void
let originalSharedDataCapture: <T extends object>(families: FunctionConversationChildFamilies<T>,
  proof: FunctionConversationSharedChildFactory, authority: ModRuntimeAuthority,
  destination: FunctionConversationNativeDestination, database: NativeSqliteAdapter) =>
  FunctionConversationSharedFamilyDataChecker | undefined
let originalSharedSourceBind: <T extends object>(families: FunctionConversationChildFamilies<T>,
  proof: FunctionConversationSharedChildFactory, authority: ModRuntimeAuthority,
  destination: FunctionConversationNativeDestination, active: FunctionConversationSharedActive,
  database: NativeSqliteAdapter) => void

/** Fixed original class functions; no later instance/prototype method can certify this data read. */
export function captureFunctionConversationSharedFamilyDataChecker<T extends object>(
  families: FunctionConversationChildFamilies<T>, proof: FunctionConversationSharedChildFactory,
  authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination,
  database: NativeSqliteAdapter): FunctionConversationSharedFamilyDataChecker | undefined {
  if (!Reflect.apply(weakHas, actualFamilyInstances, [families])) fail()
  return originalSharedDataCapture(families, proof, authority, destination, database)
}

/** Only the actual completion path can join the original Family to its completed Active. */
export function bindFunctionConversationSharedFamilySourcePlan<T extends object>(
  families: FunctionConversationChildFamilies<T>, proof: FunctionConversationSharedChildFactory,
  authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination,
  active: FunctionConversationSharedActive, database: NativeSqliteAdapter): void {
  if (!Reflect.apply(weakHas, actualFamilyInstances, [families])) fail()
  originalSharedSourceBind(families, proof, authority, destination, active, database)
}

function fail(code = "MODS_CONVERSATION_UNAVAILABLE"): never {
  throw new ModFunctionError(code)
}

/** Native object receipts only; SDK labels and copied JSON never index this table. */
export class FunctionConversationChildFamilies<T extends object> {
  private readonly parents = new WeakMap<FunctionConversationChildParent, Parent<T>>()
  private readonly children = new WeakMap<FunctionConversationChildFactory, Child<T>>()
  private readonly current = new Map<string, Child<T>>()
  private readonly invocations = new WeakSet<object>()
  private readonly sharedChildren = new WeakMap<FunctionConversationSharedChildFactory, SharedChild<T>>()
  private readonly sharedAuthorities = new WeakMap<ModRuntimeAuthority, SharedChild<T>>()
  private readonly sharedInvocations = new WeakSet<object>()
  private readonly liveShared = new Set<SharedChild<T>>()

  constructor(private readonly authorities: Pick<ModRuntimeAuthorities, "get">) {
    const fields = capturePureFields(this, ["sharedChildren", "sharedAuthorities", "liveShared"])
    const children = this.sharedChildren, sharedAuthorities = this.sharedAuthorities, live = this.liveShared
    actualFamilyInstances.set(this, {
      assertFields: () => { assertPureFields(this, fields) },
      readChild: proof => Reflect.apply(weakGet, children, [proof]) as object | undefined,
      readAuthority: authority => Reflect.apply(weakGet, sharedAuthorities, [authority]) as object | undefined,
      hasLive: child => Reflect.apply(setHas, live, [child]) as boolean
    })
  }

  private key(workspace: string, threadId: string): string {
    return JSON.stringify([workspace, threadId])
  }

  captureParent(input: FunctionConversationChildParentCapture<T>): FunctionConversationChildParent {
    const native = readFunctionConversationNativeParentCurrent(input)
    const parent: Parent<T> = Object.freeze({ ...input,
      target: Object.freeze({ ...input.target,
        incarnation: Object.freeze({ ...input.target.incarnation }) }),
      assertCurrent: native ? Reflect.apply(familyBind, native.current, [input]) as () => void :
        input.assertCurrent.bind(input), assertFactory: input.assertFactory.bind(input),
      captureIndependentCurrent: native?.captureIndependentCurrent })
    parent.assertFactory()
    parent.assertCurrent()
    parent.signal.throwIfAborted()
    const proof = Object.freeze({ [parentBrand]: true as const })
    this.parents.set(proof, parent)
    return proof
  }

  /** Native coordinator lookup only. A copied parent token never indexes this table. */
  readParent(proof: FunctionConversationChildParent): Parent<T> {
    const parent = this.parents.get(proof)
    if (!parent) fail()
    parent.signal.throwIfAborted()
    parent.assertCurrent()
    return parent
  }

  register(parentProof: FunctionConversationChildParent,
    input: FunctionConversationIndependentChildInput): FunctionConversationChildFactory {
    input = Object.freeze({ ...input,
      checkpointIncarnation: Object.freeze({ ...input.checkpointIncarnation }),
      assertCurrent: input.assertCurrent.bind(input) })
    const parent = this.parents.get(parentProof)
    if (!parent || !input.invocation || typeof input.invocation !== "object" ||
      this.invocations.has(input.invocation) || this.sharedInvocations.has(input.invocation)) fail()
    parent.assertFactory()
    parent.assertCurrent()
    input.signal.throwIfAborted()
    input.assertCurrent()
    const row = getThreadCore(input.physicalThreadId)
    const lease = getLocalThreadRunLease(input.physicalThreadId)
    const leaseCurrent = captureLocalThreadRunLease(input.physicalThreadId)
    if (!row || !leaseCurrent || lease?.owner !== "mods" || lease.runId !== input.runId ||
      input.agentId === "main" || !input.agentId || !input.runId ||
      !matchesThreadIncarnation(row, input.checkpointIncarnation)) fail()
    const metadata: unknown = JSON.parse(row.metadata ?? "{}")
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Reflect.get(metadata, "isInternalFlowRuntime") !== true ||
      Reflect.get(metadata, "parentThreadId") !== parent.physicalParentThreadId ||
      Reflect.get(metadata, "modsAgentRunId") !== input.runId ||
      Reflect.get(metadata, "workspacePath") !== parent.target.workspace) fail()
    const key = this.key(parent.target.workspace, input.physicalThreadId)
    if (this.current.has(key) || this.current.size + this.liveShared.size >= 32)
      fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    // The original factory is live above, and this physical child owns its exact lease below.
    // Only the native parent receipt can supply this source/branch guard; never a Guest callback.
    const independentCurrent = parent.captureIndependentCurrent?.()
    const ownedParent = independentCurrent
      ? Object.freeze({ ...parent, assertCurrent: independentCurrent }) : parent
    const proof = Object.freeze({ [childBrand]: true as const })
    const captured = Object.freeze({ ...input,
      checkpointIncarnation: Object.freeze(captureThreadIncarnation(row)),
      assertCurrent: input.assertCurrent.bind(input) })
    const controller = new AbortController()
    const child: Child<T> = { parent: ownedParent, input: captured, controller,
      signal: AbortSignal.any([parent.signal, captured.signal, controller.signal]),
      leaseCurrent, proof, live: true }
    this.children.set(proof, child)
    this.current.set(key, child)
    try { this.assertChild(child) }
    catch (error) { this.retire(proof); throw error }
    this.invocations.add(input.invocation)
    return proof
  }

  private assertChild(child: Child<T>): void {
    const { parent, input } = child
    if (!child.live || this.current.get(this.key(parent.target.workspace, input.physicalThreadId)) !== child)
      fail("MODS_CONVERSATION_TARGET_CLOSED")
    child.controller.signal.throwIfAborted()
    parent.signal.throwIfAborted()
    input.signal.throwIfAborted()
    parent.assertCurrent()
    input.assertCurrent()
    const row = getThreadCore(input.physicalThreadId)
    if (!child.leaseCurrent() || !matchesThreadIncarnation(row,
      input.checkpointIncarnation)) fail("MODS_CONVERSATION_THREAD_CHANGED")
    const metadata: unknown = JSON.parse(row?.metadata ?? "{}")
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Reflect.get(metadata, "isInternalFlowRuntime") !== true ||
      Reflect.get(metadata, "parentThreadId") !== parent.physicalParentThreadId ||
      Reflect.get(metadata, "modsAgentRunId") !== input.runId ||
      Reflect.get(metadata, "workspacePath") !== parent.target.workspace)
      fail("MODS_CONVERSATION_TARGET_CHANGED")
    if (child.authority) {
      child.authority.assertLive()
      if (this.authorities.get(child.authority) !== child.authority)
        fail("MODS_CONVERSATION_AUTHORITY_CHANGED")
    }
  }

  forThread(workspace: string, threadId: string): FunctionConversationChildFactory | undefined {
    const child = this.current.get(this.key(workspace, threadId))
    if (!child) return undefined
    this.assertChild(child)
    return child.proof
  }

  read(proof: FunctionConversationChildFactory) {
    const child = this.children.get(proof)
    if (!child) fail()
    this.assertChild(child)
    return { parent: child.parent, input: child.input, authority: child.authority,
      signal: child.signal,
      assertCurrent: () => this.assertChild(child) }
  }

  bind(proof: FunctionConversationChildFactory, authority: ModRuntimeAuthority): void {
    const child = this.children.get(proof)
    if (!child) fail()
    this.assertChild(child)
    authority.assertLive()
    if (this.authorities.get(authority) !== authority ||
      authority.workspace !== child.parent.target.workspace ||
      authority.threadId !== child.input.physicalThreadId ||
      authority.agentId !== child.input.agentId || authority.turnId !== child.input.runId ||
      (child.authority && child.authority !== authority)) fail("MODS_CONVERSATION_AUTHORITY_CHANGED")
    child.authority = authority
    this.assertChild(child)
  }

  onRetire(proof: FunctionConversationChildFactory, retire: () => void): void {
    const child = this.children.get(proof)
    if (!child || child.retire) fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    this.assertChild(child)
    child.retire = retire
  }

  retire(proof: FunctionConversationChildFactory): void {
    const child = this.children.get(proof)
    if (!child || !child.live) return
    child.live = false
    child.controller.abort(new ModFunctionError("MODS_CONVERSATION_TARGET_CLOSED"))
    if (this.current.get(this.key(child.parent.target.workspace, child.input.physicalThreadId)) === child)
      this.current.delete(this.key(child.parent.target.workspace, child.input.physicalThreadId))
    child.retire?.()
  }

  /** Shared children have distinct authority objects while keeping the parent's physical lease. */
  registerShared(parentProof: FunctionConversationChildParent,
    input: FunctionConversationSharedChildInput): FunctionConversationSharedChildFactory {
    const parent = this.parents.get(parentProof)
    const currentField = types.isProxy(input) ? undefined :
      Object.getOwnPropertyDescriptor(input, "assertCurrent")
    const destinationField = types.isProxy(input) ? undefined :
      Object.getOwnPropertyDescriptor(input, "destination")
    const actualDestination = destinationField && "value" in destinationField &&
      destinationField.value && !types.isProxy(destinationField.value)
      ? destinationField.value as FunctionConversationSharedChildInput["destination"] : undefined
    const destinationCurrentField = actualDestination &&
      Object.getOwnPropertyDescriptor(actualDestination, "assertCurrent")
    const pair = currentField && "value" in currentField && destinationCurrentField &&
      "value" in destinationCurrentField ? readFunctionConversationSharedFamilySourcePair(
        currentField.value, destinationCurrentField.value) : undefined
    const current = pair ? Reflect.apply(familyBind, currentField!.value, [input]) as () => void
      : input.assertCurrent.bind(input)
    const destinationCurrent = pair
      ? Reflect.apply(familyBind, destinationCurrentField!.value, [actualDestination]) as () => void
      : input.destination.assertCurrent.bind(input.destination)
    const recipe: Omit<SharedFamilyExecution, "proof"> | undefined = pair ? {
      pair, originalInput: input,
      inputFields: capturePureFields(input, ["invocation", "authority", "checkpointThreadId",
        "checkpointIncarnation", "checkpointNamespace", "destination", "signal", "assertCurrent"]),
      destinationFields: capturePureFields(input.destination, ["threadId", "incarnation", "assertCurrent"]),
      current, destinationCurrent, reading: false, failed: false
    } : undefined
    const captured = Object.freeze({ ...input,
      checkpointIncarnation: Object.freeze({ ...input.checkpointIncarnation }),
      destination: Object.freeze({ ...input.destination,
        incarnation: Object.freeze({ ...input.destination.incarnation }),
        assertCurrent: destinationCurrent }),
      assertCurrent: current })
    if (!parent || !captured.invocation || typeof captured.invocation !== "object" ||
      this.sharedInvocations.has(captured.invocation) || this.invocations.has(captured.invocation)) fail()
    parent.assertFactory()
    parent.assertCurrent()
    captured.assertCurrent()
    const leaseCurrent = captureLocalThreadRunLease(captured.checkpointThreadId)
    if (!leaseCurrent || captured.checkpointThreadId !== parent.physicalParentThreadId ||
      captured.destination.threadId === captured.checkpointThreadId ||
      !captured.checkpointNamespace || this.sharedAuthorities.has(captured.authority) ||
      this.liveShared.size + this.current.size >= 32) fail()
    const controller = new AbortController(), proof = Object.freeze({ [sharedBrand]: true as const })
    const child: SharedChild<T> = { kind: "shared", parent, input: captured, leaseCurrent,
      controller, proof, live: true,
      signal: AbortSignal.any([parent.signal, captured.signal, controller.signal]) }
    const execution: SharedFamilyExecution | undefined = recipe ? { ...recipe, proof } : undefined
    sharedChildFacts.set(child, { fields: capturePureFields(child,
      ["kind", "parent", "input", "leaseCurrent", "controller", "proof", "signal"]),
      live: Object.getOwnPropertyDescriptor(child, "live")!, input: captured, parent,
      signal: child.signal, controllerSignal: Reflect.apply(controllerSignal, controller, []) as AbortSignal,
      proof, leaseCurrent })
    if (execution) Reflect.apply(weakSet, sharedFamilyExecutions, [child, execution])
    this.sharedChildren.set(proof, child)
    this.sharedAuthorities.set(captured.authority, child)
    this.liveShared.add(child)
    try { this.assertShared(child) }
    catch (error) { this.retireShared(proof); throw error }
    this.sharedInvocations.add(captured.invocation)
    return proof
  }

  private assertShared(child: SharedChild<T>): void {
    const execution = readData(sharedFamilyExecutions, child), plan = execution?.plan
    if (plan && execution) {
      if (execution.reading || execution.failed) { execution.failed = true; fail() }
      execution.reading = true
    }
    try {
      if (plan && execution) {
        originalSharedDataFacts(this, child, execution.proof)
        assertPureFields(execution.originalInput, execution.inputFields)
        assertPureFields(execution.originalInput.destination, execution.destinationFields)
        plan.assertDataCurrent()
      }
      const { input, parent } = child, authority = input.authority
      if (!child.live || this.sharedAuthorities.get(authority) !== child)
        fail("MODS_CONVERSATION_TARGET_CLOSED")
      child.signal.throwIfAborted()
      parent.assertCurrent()
      if (plan) plan.assertCurrent()
      else { input.assertCurrent(); input.destination.assertCurrent() }
      authority.assertLive()
      if (authority.agentId === "main" || authority.workspace !== parent.target.workspace ||
        authority.threadId !== input.checkpointThreadId || this.authorities.get(authority) !== authority ||
        !child.leaseCurrent() || !matchesThreadIncarnation(
          readFunctionConversationThreadIdentityCurrent(getDb(), input.checkpointThreadId),
          input.checkpointIncarnation) || !matchesThreadIncarnation(
          readFunctionConversationThreadIdentityCurrent(getDb(), input.destination.threadId),
          input.destination.incarnation)) fail("MODS_CONVERSATION_AUTHORITY_CHANGED")
      const row = readFunctionConversationThreadIdentityCurrent(getDb(), input.destination.threadId)
      const restored = input.restore ? readFunctionConversationSharedRestore(input.restore, {
        authority, invocation: input.invocation, parent: parent.target,
        destinationThreadId: input.destination.threadId,
        destinationIncarnation: input.destination.incarnation }) : undefined
      let metadata: unknown
      try { metadata = JSON.parse(row?.metadata ?? "{}") } catch { fail("MODS_CONVERSATION_TARGET_CHANGED") }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        Reflect.get(metadata, "isInternalFlowRuntime") !== true ||
        Reflect.get(metadata, "isFunctionConversationProjection") !== true ||
        Reflect.get(metadata, "parentThreadId") !== parent.physicalParentThreadId ||
        Reflect.get(metadata, "modsAgentRunId") !== (restored?.destination.invocationId ?? authority.turnId) ||
        (restored && row?.metadata !== restored.destination.originalMetadata) ||
        Reflect.get(metadata, "workspacePath") !== parent.target.workspace)
        fail("MODS_CONVERSATION_TARGET_CHANGED")
      if (plan && execution) {
        plan.assertDestinationData(row)
        originalSharedDataFacts(this, child, execution.proof)
        assertPureFields(execution.originalInput, execution.inputFields)
        assertPureFields(execution.originalInput.destination, execution.destinationFields)
        if (input.assertCurrent !== execution.current ||
          input.destination.assertCurrent !== execution.destinationCurrent ||
          readData(sharedFamilyExecutions, child) !== execution || execution.failed) fail()
        plan.assertDataCurrent()
        originalSharedDataFacts(this, child, execution.proof)
        if (execution.failed) fail()
      }
    } catch (error) { if (plan && execution) execution.failed = true; throw error }
    finally { if (plan && execution) execution.reading = false }
  }

  private bindSharedSourcePlan(proof: FunctionConversationSharedChildFactory,
    authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination,
    active: FunctionConversationSharedActive, database: NativeSqliteAdapter): void {
    const original = readData(actualFamilyInstances, this)
    if (!original) fail()
    original.assertFields()
    const child = original.readChild(proof) as SharedChild<T> | undefined
    const execution = child && readData(sharedFamilyExecutions, child)
    if (!child || child.input.authority !== authority) fail()
    if (!execution) return
    if (execution.plan || execution.reading || execution.failed) { execution.failed = true; fail() }
    execution.reading = true
    try {
      originalSharedDataFacts(this, child, proof)
      assertPureFields(execution.originalInput, execution.inputFields)
      assertPureFields(execution.originalInput.destination, execution.destinationFields)
      const input = child.input
      if (input.assertCurrent !== execution.current ||
        input.destination.assertCurrent !== execution.destinationCurrent) fail()
      const plan = captureFunctionConversationSharedFamilySourcePlan(execution.pair, active, authority,
        destination, child.parent.target, input.checkpointThreadId, input.checkpointIncarnation,
        input.destination.threadId, input.destination.incarnation, input.checkpointNamespace)
      originalSharedDataFacts(this, child, proof)
      assertPureFields(execution.originalInput, execution.inputFields)
      assertPureFields(execution.originalInput.destination, execution.destinationFields)
      if (execution.failed || readData(sharedFamilyExecutions, child) !== execution ||
        database !== getDb()) fail()
      if (plan) execution.plan = plan
    } catch (error) { execution.failed = true; throw error }
    finally { execution.reading = false }
  }

  forSharedAuthority(authority: ModRuntimeAuthority): FunctionConversationSharedChildFactory | undefined {
    const child = this.sharedAuthorities.get(authority)
    if (!child) return undefined
    this.assertShared(child)
    return child.proof
  }

  readShared(proof: FunctionConversationSharedChildFactory) {
    const child = this.sharedChildren.get(proof)
    if (!child) fail()
    this.assertShared(child)
    return { parent: child.parent, input: child.input, signal: child.signal,
      assertCurrent: () => this.assertShared(child) }
  }

  /** Actual family/lease data only, after every original family and destination callback. */
  private assertSharedDataFacts(child: SharedChild<T>,
    proof: FunctionConversationSharedChildFactory): void {
    const original = readData(actualFamilyInstances, this), facts = readData(sharedChildFacts, child)
    if (!original || !facts) fail()
    original.assertFields()
    assertPureFields(child, facts.fields)
    const live = Object.getOwnPropertyDescriptor(child, "live")
    if (!live || !("value" in live) || live.value !== true ||
      live.writable !== facts.live.writable || live.enumerable !== facts.live.enumerable ||
      live.configurable !== facts.live.configurable || original.readChild(proof) !== child ||
      !isModRuntimeAuthorityDataCurrent(facts.input.authority) || facts.proof !== proof ||
      !original.hasLive(child) || original.readAuthority(facts.input.authority) !== child ||
      !facts.leaseCurrent())
      fail("MODS_CONVERSATION_TARGET_CLOSED")
    const signals = [facts.signal, facts.controllerSignal, facts.parent.signal, facts.input.signal]
    for (let index = 0; index < signals.length; index++)
      Reflect.apply(signalThrowIfAborted, signals[index], [])
  }

  assertSharedDataCurrent(proof: FunctionConversationSharedChildFactory): void {
    const original = readData(actualFamilyInstances, this)
    if (!original) fail()
    original.assertFields()
    const child = original.readChild(proof) as SharedChild<T> | undefined
    if (!child) fail()
    originalSharedDataFacts(this, child, proof)
    if (!matchesThreadIncarnation(
      readFunctionConversationThreadIdentityCurrent(getDb(), child.input.checkpointThreadId),
      child.input.checkpointIncarnation) || !matchesThreadIncarnation(
      readFunctionConversationThreadIdentityCurrent(getDb(), child.input.destination.threadId),
      child.input.destination.incarnation))
      fail("MODS_CONVERSATION_THREAD_CHANGED")
    originalSharedDataFacts(this, child, proof)
  }

  /** Only an actual family whose original thread facts are covered can use a joined data read. */
  captureSharedDataChecker(proof: FunctionConversationSharedChildFactory,
    authority: ModRuntimeAuthority, destination: FunctionConversationNativeDestination,
    database: NativeSqliteAdapter): FunctionConversationSharedFamilyDataChecker | undefined {
    const original = readData(actualFamilyInstances, this)
    if (!original) fail()
    original.assertFields()
    const child = original.readChild(proof) as SharedChild<T> | undefined
    const facts = child && readData(sharedChildFacts, child)
    if (!child || !facts || facts.input.authority !== authority) fail()
    originalSharedDataFacts(this, child, proof)
    const input = facts.input
    if (!coversFunctionConversationNativeDestinationThread(destination, database,
      input.checkpointThreadId, input.checkpointIncarnation) ||
      !coversFunctionConversationNativeDestinationThread(destination, database,
        input.destination.threadId, input.destination.incarnation)) return undefined
    const assertFacts = () => { originalSharedDataFacts(this, child, proof) }
    return Object.freeze({ assertInDestinationScope:
      (scope: FunctionConversationNativeDestinationDataScope) => {
        assertFacts()
        assertFunctionConversationNativeDestinationScopeThread(scope, destination, database,
          input.checkpointThreadId, input.checkpointIncarnation)
        assertFunctionConversationNativeDestinationScopeThread(scope, destination, database,
          input.destination.threadId, input.destination.incarnation)
        assertFacts()
      } })
  }

  onSharedRetire(proof: FunctionConversationSharedChildFactory, retire: () => void): void {
    const child = this.sharedChildren.get(proof)
    if (!child || child.retire) fail("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    this.assertShared(child)
    child.retire = retire
  }

  retireShared(proof: FunctionConversationSharedChildFactory): void {
    const child = this.sharedChildren.get(proof)
    if (!child || !child.live) return
    child.live = false
    child.controller.abort(new ModFunctionError("MODS_CONVERSATION_TARGET_CLOSED"))
    if (this.sharedAuthorities.get(child.input.authority) === child)
      this.sharedAuthorities.delete(child.input.authority)
    this.liveShared.delete(child)
    child.retire?.()
  }

  static {
    const facts = this.prototype.assertSharedDataFacts
    const capture = this.prototype.captureSharedDataChecker
    const bind = this.prototype.bindSharedSourcePlan
    originalSharedDataFacts = (families, child, proof) => {
      Reflect.apply(facts, families, [child, proof])
    }
    originalSharedDataCapture = (families, proof, authority, destination, database) =>
      Reflect.apply(capture, families, [proof, authority, destination, database])
    originalSharedSourceBind = (families, proof, authority, destination, active, database) => {
      Reflect.apply(bind, families, [proof, authority, destination, active, database])
    }
  }
}
