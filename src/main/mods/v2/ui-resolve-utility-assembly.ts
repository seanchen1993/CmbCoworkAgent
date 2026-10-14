import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import type { ModJson } from "../../../shared/mods/types"
import {
  matchesEventPattern,
  ModFunctionError,
  type FunctionHostReply,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import type {
  FunctionUiResolveWireCredit,
  FunctionUiResolveWireParticipant,
  FunctionUiResolveWireResponse
} from "../../../shared/mods/v2/ui-resolve-wire"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { FunctionUiConstructorActivity } from "./ui-constructor-activity"
import { FunctionUiConstructorBridge } from "./ui-constructor-bridge"
import type {
  FunctionUiResolveComponent,
  FunctionUiResolveAssembly,
  FunctionUiResolveDefinition,
  FunctionUiResolvePeer,
  FunctionUiResolveReceipt,
  FunctionUiResolveTarget
} from "./ui-resolve-private-types"
import { FunctionUiResolveLedger, FunctionUiResolveRegistry } from "./ui-resolve-registry"
import {
  FunctionUiResolveTableFold,
  type FunctionUiResolverRegistration
} from "./ui-resolve-table-fold"

export interface FunctionUiResolveUtilityRuntime {
  readonly runtimeId: string
  readonly guest: FunctionGuestRuntime
  readonly declaration: Readonly<FunctionUiResolveWireParticipant>
  assertCurrent(): void
}

export type FunctionUiResolveUtilityCall =
  | Readonly<{ kind: "resolver"; requestId: string }>
  | Readonly<{ kind: "constructor"; scopeId: string }>

export interface FunctionUiResolveUtilityHost {
  assertCurrent(): void
  publish(message: FunctionUiResolveWireResponse): void
  /** Native forwarder owns reply/revoke routing and actual host finally, not a guest JSON actor. */
  call(
    runtime: FunctionUiResolveUtilityRuntime,
    registration: Readonly<FunctionRegistration>,
    context: FunctionUiResolveUtilityCall,
    method: string,
    args: ModJson,
    signal: AbortSignal
  ): Promise<FunctionHostReply>
  requestCredit(
    limits: FunctionUiResolveWireCredit["limits"],
    signal: AbortSignal
  ): Promise<FunctionUiResolveWireCredit>
}

export interface FunctionUiResolveUtilityOptions {
  readonly identity: object
  readonly assembly: string
  readonly requestId: string
  readonly participants: readonly FunctionUiResolveUtilityRuntime[]
  readonly credit: Readonly<FunctionUiResolveWireCredit>
  readonly startupCutNs: string
  readonly signal: AbortSignal
  readonly host: FunctionUiResolveUtilityHost
}

interface Participant {
  actual: FunctionUiResolveUtilityRuntime
  declaration: Readonly<FunctionUiResolveWireParticipant>
  registrations: readonly Readonly<FunctionRegistration>[]
  peer?: FunctionUiResolvePeer
}
interface Source {
  participant: Participant
  registration: Readonly<FunctionRegistration>
}
interface Drawing {
  participant: Participant
  component: FunctionUiResolveComponent
  generation: string
  requestId: string
  token: string
  controller: AbortController
}
interface Scope {
  id: string
  definition: FunctionUiResolveDefinition
  receipt: FunctionUiResolveReceipt
  admitted: boolean
  quiescent: boolean
  completion?: Promise<void>
}
export type FunctionUiResolveUtilitySources = Record<
  string,
  Record<string, Array<{ runtimeId: string; registration: string }>>
>

const components: readonly FunctionUiResolveComponent[] = ["Pane", ...FUNCTION_UI_SITES]
const dimensions = ["handles", "roots", "branches", "reactions"] as const
const maximum = { handles: 4096, roots: 32, branches: 1024, reactions: 1024 }
function fail(code = "MODS_UI_RESOLVE_IDENTITY"): never {
  throw new ModFunctionError(code)
}

/** Actual utility graph and native receipts. It never accepts function IDs from the public SDK. */
export class FunctionUiResolveUtilityAssembly {
  readonly assembly: string
  readonly ledger: FunctionUiResolveLedger
  readonly activity: FunctionUiConstructorActivity
  private readonly controller = new AbortController()
  private readonly creditIdentity = Object.freeze({})
  private readonly registry: FunctionUiResolveRegistry
  private readonly bridge: FunctionUiConstructorBridge
  private readonly fold: FunctionUiResolveTableFold
  private readonly group: FunctionUiResolveAssembly
  private readonly participants = new Map<string, Participant>()
  private readonly actors = new WeakMap<object, Participant>()
  private readonly definitions = new WeakMap<object, Source>()
  private readonly scopes = new WeakMap<object, Scope>()
  private readonly scopeIds = new Map<string, Scope>()
  private readonly drawings = new Map<string, Drawing>()
  private readonly receiptDrawings = new WeakMap<object, Drawing>()
  private readonly sources: FunctionUiResolveUtilitySources = Object.create(null)
  private readonly nativeRegistration = Object.freeze({ actualNative: true })
  private readonly cut: FunctionSharedWallCut
  private readonly signal: AbortSignal
  private credit: FunctionUiResolveWireCredit
  private creditQueue: Promise<void> = Promise.resolve()
  private state: "created" | "preparing" | "prepared" | "active" | "retired" = "created"
  private preparedToken?: string
  private failure?: unknown
  private retirementFailure?: unknown
  private detach: () => void = () => {}

  constructor(private readonly options: FunctionUiResolveUtilityOptions) {
    if (
      !options.identity ||
      typeof options.identity !== "object" ||
      !options.assembly ||
      !options.requestId ||
      !options.participants.length ||
      options.participants.length > 16
    )
      fail()
    this.assembly = options.assembly
    this.cut = new FunctionSharedWallCut(options.startupCutNs)
    this.credit = this.validateCredit(options.credit)
    this.signal = AbortSignal.any([options.signal, this.controller.signal])
    const guests = new Set<FunctionGuestRuntime>()
    for (const actual of options.participants) {
      actual.assertCurrent()
      const declaration = actual.declaration
      if (
        !(actual.guest instanceof FunctionGuestRuntime) ||
        guests.has(actual.guest) ||
        actual.runtimeId !== declaration.runtimeId ||
        this.participants.has(actual.runtimeId)
      )
        fail()
      const real = actual.guest.registrations
      const declared = declaration.registrations
      if (
        real.length !== declared.length ||
        real.some((row, index) => {
          const wire = declared[index]
          return (
            !wire ||
            wire.id !== row.id ||
            wire.pattern !== row.pattern ||
            wire.hasCatch !== row.hasCatch ||
            wire.hasMatcher !== row.hasMatcher
          )
        })
      )
        fail("MODS_UI_RESOLVE_REGISTRATION_CHANGED")
      const registrations = Object.freeze(real.map((row) => Object.freeze({ ...row })))
      const snapshot = Object.freeze({
        ...declaration,
        registrations,
        capabilities: [...declaration.capabilities]
      })
      Object.freeze(snapshot.capabilities)
      const participant = { actual, declaration: snapshot, registrations }
      this.participants.set(actual.runtimeId, participant)
      this.actors.set(actual, participant)
      guests.add(actual.guest)
      for (const registration of registrations) {
        if (matchesEventPattern(registration.pattern, "ui.resolve"))
          this.definitions.set(registration, { participant, registration })
      }
    }
    this.ledger = new FunctionUiResolveLedger(
      { handles: this.credit.limits.handles, roots: this.credit.limits.roots },
      { identity: this.creditIdentity, revision: this.credit.revision }
    )
    this.activity = new FunctionUiConstructorActivity(this.credit.limits, {
      identity: this.creditIdentity,
      revision: this.credit.revision
    })
    this.bridge = new FunctionUiConstructorBridge(
      {
        captureCurrent: (target, resident) => this.captureDrawing(target, resident),
        assertCurrent: (definition, receipt) => this.assertDefinition(definition, receipt),
        retain: (definition, receipt, identity) => {
          this.assertDefinition(definition, receipt)
          if (this.scopes.has(identity)) fail()
          const scope: Scope = {
            id: randomUUID(),
            definition,
            receipt,
            admitted: false,
            quiescent: false
          }
          this.scopes.set(identity, scope)
          this.scopeIds.set(scope.id, scope)
          return () => {
            /* Native activity owns the real release; completion publishes drain below. */
          }
        },
        admit: (definition, receipt, identity) => {
          this.assertDefinition(definition, receipt)
          const scope = this.scopes.get(identity)
          const drawing = this.receiptDrawings.get(receipt.identity)
          if (!scope || scope.definition !== definition || scope.receipt !== receipt || !drawing)
            fail()
          if (scope.admitted) return
          const source = this.source(definition, true)
          this.options.host.publish({
            type: "ui-constructor-open",
            assembly: this.assembly,
            scopeId: scope.id,
            consumerRuntimeId: drawing.participant.actual.runtimeId,
            drawToken: drawing.token,
            runtimeId: source.participant.actual.runtimeId,
            registration: source.registration.id
          })
          scope.admitted = true
        },
        call: (definition, receipt, identity, method, args, signal) => {
          this.assertDefinition(definition, receipt)
          const scope = this.scopes.get(identity)
          if (!scope?.admitted || scope.receipt !== receipt) fail()
          const source = this.source(definition)
          return this.call(source, { kind: "constructor", scopeId: scope.id }, method, args, signal)
        },
        drained: (_definition, _receipt, identity, completion) => {
          const scope = this.scopes.get(identity)
          if (!scope || scope.completion) fail()
          scope.completion = completion
          void completion
            .then(() => {
              if (scope.admitted)
                this.options.host.publish({
                  type: "ui-constructor-drained",
                  assembly: this.assembly,
                  scopeId: scope.id
                })
              this.scopeIds.delete(scope.id)
            })
            .catch((error) => {
              this.failure ??= error
            })
        },
        quiescent: (definition, receipt, identity) => {
          // This is an irreversible native ledger receipt for an already closed drawing.
          // Its expired public guard must not run, nor can it mint or capture a newer scope.
          const scope = this.scopes.get(identity)
          if (!scope || scope.definition !== definition || scope.receipt !== receipt) fail()
          if (!scope.admitted || scope.quiescent || this.scopeIds.get(scope.id) !== scope) return
          this.options.host.publish({
            type: "ui-constructor-quiescent",
            assembly: this.assembly,
            scopeId: scope.id
          })
          scope.quiescent = true
        }
      },
      this.activity
    )
    this.registry = new FunctionUiResolveRegistry(this.bridge, this.ledger)
    this.group = this.registry.registerAssembly(options.identity, this.signal)
    this.fold = new FunctionUiResolveTableFold(this.registry, {
      nativeRegistration: this.nativeRegistration,
      assertNativeDefinitionCurrent: () => this.assertLive(),
      nativeTable: (consumer) =>
        this.participant(consumer).actual.guest.createUiResolveNativeTable(this.currentComponent),
      inspect: (peer, invocation, run) =>
        this.participant(peer).actual.guest.runUiResolverInspection(invocation.dispatchCutNs, run),
      ensureHandles: (additional) => this.ensureHandles(additional)
    })
    const abort = () => {
      try {
        this.retire()
      } catch {
        /* The exact disposal failure remains latched for VM retirement. */
      }
    }
    options.signal.addEventListener("abort", abort, { once: true })
    this.detach = () => options.signal.removeEventListener("abort", abort)
    this.assertLive()
  }

  // Fold is serial across target/component. Native functions themselves retain their component.
  private currentComponent: FunctionUiResolveComponent = "Pane"

  private validateCredit(
    value: Readonly<FunctionUiResolveWireCredit>
  ): FunctionUiResolveWireCredit {
    if (
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      Object.keys(value.limits).length !== dimensions.length ||
      dimensions.some(
        (key) =>
          !Number.isSafeInteger(value.limits[key]) ||
          value.limits[key] < 0 ||
          value.limits[key] > maximum[key]
      )
    )
      fail("MODS_UI_RESOLVE_CREDIT")
    return { revision: value.revision, limits: { ...value.limits } }
  }

  private assertLive(): void {
    if (this.failure !== undefined) throw this.failure
    if (this.state === "retired") fail("MODS_UI_RESOLVE_RETIRED")
    this.signal.throwIfAborted()
    this.options.host.assertCurrent()
  }

  private assertPreparation(): void {
    this.assertLive()
    if (this.state !== "preparing") fail("MODS_UI_RESOLVE_PREPARATION_ENDED")
    this.cut.assertLive()
  }

  private participant(peer: FunctionUiResolvePeer): Participant {
    const actual = this.actors.get(peer.actor)
    if (!actual || actual.peer !== peer) fail()
    actual.actual.assertCurrent()
    return actual
  }

  private source(definition: FunctionUiResolveDefinition, allowNative = false): Source {
    const participant = this.participant(definition.peer)
    if (allowNative && definition.registration === this.nativeRegistration) {
      return {
        participant,
        registration: Object.freeze({ id: "$native-ui", pattern: "ui.resolve", hasCatch: false })
      }
    }
    const source = this.definitions.get(definition.registration)
    if (!source || source.participant !== participant) fail()
    return source
  }

  private assertDefinition(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt
  ): void {
    this.assertLive()
    definition.assertCurrent()
    this.participant(receipt.consumer)
    receipt.assertCurrent()
    receipt.signal.throwIfAborted()
    const drawing = this.receiptDrawings.get(receipt.identity)
    if (!drawing || this.drawings.get(drawing.token) !== drawing) fail()
    drawing.controller.signal.throwIfAborted()
    this.source(definition, true)
  }

  private captureDrawing(target: FunctionUiResolveTarget, resident: FunctionUiResolvePeer) {
    this.assertLive()
    if (this.state !== "active" || target.consumer !== resident) fail()
    const participant = this.participant(target.consumer)
    const actual = participant.actual.guest.currentUiResolveDrawing()
    if (
      !actual ||
      actual.drawing.assembly !== this.assembly ||
      actual.component !== target.component
    )
      fail("MODS_UI_RESOLVE_DRAWING_REQUIRED")
    let drawing = this.drawings.get(actual.drawing.token)
    if (!drawing) {
      if (this.drawings.size >= 4096) fail("MODS_UI_RESOLVE_DRAWING_CAPACITY")
      drawing = {
        participant,
        component: target.component,
        generation: actual.generation,
        requestId: actual.requestId,
        token: actual.drawing.token,
        controller: new AbortController()
      }
      this.drawings.set(drawing.token, drawing)
    } else if (
      drawing.participant !== participant ||
      drawing.component !== target.component ||
      drawing.generation !== actual.generation ||
      drawing.requestId !== actual.requestId
    )
      fail()
    const captured = drawing
    const identity = Object.freeze({})
    this.receiptDrawings.set(identity, captured)
    return {
      consumer: target.consumer,
      component: target.component,
      identity,
      signal: AbortSignal.any([this.signal, captured.controller.signal]),
      assertCurrent: () => {
        this.assertLive()
        participant.actual.assertCurrent()
        if (this.drawings.get(captured.token) !== captured) fail("MODS_UI_DRAWING_STALE")
        captured.controller.signal.throwIfAborted()
      }
    }
  }

  private peer(participant: Participant): FunctionUiResolvePeer {
    if (participant.peer) return participant.peer
    const peer = this.registry.registerPeer(
      this.group,
      participant.actual,
      participant.actual.guest.uiResolveContext,
      () => {
        this.assertLive()
        participant.actual.assertCurrent()
      }
    )
    participant.peer = peer
    participant.actual.guest.bindUiResolvePeer(
      this.bridge,
      peer,
      (component) => {
        this.assertLive()
        if (this.state !== "active") fail("MODS_UI_RESOLVE_TABLE_NOT_READY")
        const target = this.registry.target(peer, component)
        if (!this.sources[participant.actual.runtimeId]?.[component]?.length)
          return participant.actual.guest.createUiResolveNativeTable(component)
        return this.registry.readTable(target)
      },
      (handle) => this.ledger.hold(handle),
      () => this.retire()
    )
    return peer
  }

  private async call(
    source: Source,
    context: FunctionUiResolveUtilityCall,
    method: string,
    args: ModJson,
    signal: AbortSignal
  ): Promise<FunctionHostReply> {
    this.assertLive()
    source.participant.actual.assertCurrent()
    signal.throwIfAborted()
    if (!source.participant.declaration.capabilities.includes(method))
      fail("MODS_CAPABILITY_DENIED")
    if (context.kind === "resolver") this.assertPreparation()
    const value = await this.options.host.call(
      source.participant.actual,
      source.registration,
      context,
      method,
      args,
      signal
    )
    this.assertLive()
    source.participant.actual.assertCurrent()
    signal.throwIfAborted()
    if (context.kind === "resolver") this.assertPreparation()
    return value
  }

  increaseCredit(value: Readonly<FunctionUiResolveWireCredit>): void {
    this.assertLive()
    const next = this.validateCredit(value)
    if (next.revision === this.credit.revision) {
      if (dimensions.some((key) => next.limits[key] !== this.credit.limits[key])) fail()
    } else {
      if (
        next.revision !== this.credit.revision + 1 ||
        dimensions.some((key) => next.limits[key] < this.credit.limits[key])
      )
        fail("MODS_UI_RESOLVE_CREDIT")
      this.ledger.increaseCredit(this.creditIdentity, next.revision, {
        handles: next.limits.handles,
        roots: next.limits.roots
      })
      this.activity.increaseCredit(this.creditIdentity, next.revision, next.limits)
      this.credit = next
    }
    this.options.host.publish({
      type: "ui-resolve-credit-ack",
      assembly: this.assembly,
      revision: next.revision
    })
  }

  private ensureHandles(additional: number): Promise<void> {
    const actual = this.creditQueue.then(async () => {
      this.assertPreparation()
      const needed = this.ledger.stats.handles + additional + 192
      if (needed <= this.credit.limits.handles) return
      if (needed > maximum.handles) fail("MODS_UI_RESOLVE_LIMIT")
      const handles = Math.min(maximum.handles, Math.ceil(needed / 64) * 64)
      const credit = await this.options.host.requestCredit(
        { ...this.credit.limits, handles },
        this.signal
      )
      this.assertPreparation()
      this.increaseCredit(credit)
    })
    this.creditQueue = actual.catch(() => {})
    return actual
  }

  private async ensureExecutionCredit(): Promise<void> {
    this.assertPreparation()
    const limits = {
      ...this.credit.limits,
      roots: Math.max(16, this.credit.limits.roots),
      branches: Math.max(512, this.credit.limits.branches),
      reactions: Math.max(512, this.credit.limits.reactions)
    }
    if (dimensions.every((key) => limits[key] === this.credit.limits[key])) return
    const credit = await this.options.host.requestCredit(limits, this.signal)
    this.assertPreparation()
    this.increaseCredit(credit)
  }

  async prepare(): Promise<{
    assembly: string
    preparedToken: string
    sources: FunctionUiResolveUtilitySources
  }> {
    this.assertLive()
    if (this.state !== "created") fail()
    this.state = "preparing"
    try {
      this.increaseCredit(this.credit) // ACK precedes any growth request; no prepare/credit deadlock.
      const ordered: Source[] = []
      for (const participant of this.participants.values()) {
        for (const registration of participant.registrations) {
          if (!matchesEventPattern(registration.pattern, "ui.resolve")) continue
          const source = this.definitions.get(registration)
          if (!source) fail()
          ordered.push(source)
        }
      }
      for (const participant of this.participants.values()) {
        this.assertPreparation()
        const view: FunctionUiResolveUtilitySources[string] = Object.create(null)
        this.sources[participant.actual.runtimeId] = view
        for (const component of components) {
          // The same per-target cut bounds matching and the fold; it is never reset after matching.
          const deadline = new FunctionDispatchDeadline(
            5000,
            this.signal,
            this.options.startupCutNs
          )
          try {
            const matched: Source[] = []
            for (const source of ordered) {
              if (source.participant === participant) continue // Whole Q, before any matcher.
              this.assertPreparation()
              deadline.assertLive()
              source.participant.actual.assertCurrent()
              let result = false
              try {
                result = source.participant.actual.guest.runUiResolverInspection(
                  deadline.sharedCutNs,
                  () =>
                    source.participant.actual.guest.matches(source.registration.id, {
                      surface: "desktop",
                      component
                    })
                )
              } catch {
                // Only an optional matcher failure may recover; native lifecycle failures do not.
                this.assertPreparation()
                deadline.assertLive()
                source.participant.actual.assertCurrent()
              }
              if (result) matched.push(source)
            }
            if (!matched.length) {
              view[component] = []
              continue
            }
            await deadline.wait(this.ensureHandles(matched.length + 1))
            // Raw resolver frames themselves retain this exact assembly's activity. Once a real
            // source will execute, its credit cannot be reclaimed merely because its table fails.
            await deadline.wait(this.ensureExecutionCredit())
            deadline.assertLive()
            const peer = this.peer(participant)
            const registrations: FunctionUiResolverRegistration[] = []
            for (const source of matched) {
              const actor = source.participant
              const registration = source.registration
              const sourcePeer = this.peer(actor)
              registrations.push(
                this.fold.register({
                  peer: sourcePeer,
                  registration,
                  tier: actor.declaration.tier,
                  assertDefinitionCurrent: () => {
                    this.assertLive()
                    actor.actual.assertCurrent()
                  },
                  // Actual matcher result is reused once; no second guest matcher or guessed metadata.
                  invoke: (invocation, next) =>
                    actor.actual.guest.invokeUiResolver(
                      registration.id,
                      invocation.input,
                      (method, args, signal) =>
                        this.call(
                          source,
                          { kind: "resolver", requestId: this.options.requestId },
                          method,
                          args,
                          signal
                        ),
                      {
                        event: "ui.resolve",
                        origin: { plugin: "host", tier: "core" },
                        plugin: { name: actor.declaration.name, root: actor.declaration.root },
                        capabilities: actor.declaration.capabilities,
                        modelProtocol: actor.declaration.modelProtocol,
                        signal: invocation.signal,
                        timeoutMs: 5000,
                        ownBudgetMs: 10000,
                        dispatchCutNs: invocation.dispatchCutNs
                      },
                      next,
                      performance.now() +
                        new FunctionSharedWallCut(invocation.dispatchCutNs).remainingMs()
                    )
                })
              )
            }
            this.currentComponent = component
            const target = this.registry.target(peer, component)
            const table = await this.fold.prepare(target, registrations, {
              signal: deadline.signal,
              startupCutNs: deadline.sharedCutNs,
              assertCurrent: () => this.assertPreparation()
            })
            this.assertPreparation()
            deadline.assertLive()
            const sources = new Map<string, { runtimeId: string; registration: string }>()
            for (const definition of this.registry.sources(table)) {
              if (definition.registration === this.nativeRegistration) continue
              const source = this.source(definition)
              if (source.participant === participant) fail("MODS_UI_RESOLVE_SELF_SOURCE")
              const value = {
                runtimeId: source.participant.actual.runtimeId,
                registration: source.registration.id
              }
              sources.set(JSON.stringify(value), Object.freeze(value))
            }
            view[component] = [...sources.values()]
          } finally {
            deadline.close()
          }
        }
        for (const rows of Object.values(view)) Object.freeze(rows)
        Object.freeze(view)
      }
      this.assertPreparation()
      Object.freeze(this.sources)
      this.preparedToken = randomUUID()
      this.state = "prepared"
      return { assembly: this.assembly, preparedToken: this.preparedToken, sources: this.sources }
    } catch (error) {
      this.failure ??= error
      try {
        this.retire()
      } catch {
        /* Preserve the preparation error; disposal remains failed closed. */
      }
      throw error
    }
  }

  adopt(token: string): void {
    this.assertLive()
    this.cut.assertLive()
    if (this.state !== "prepared" || token !== this.preparedToken) fail()
    for (const participant of this.participants.values()) {
      participant.actual.assertCurrent()
      if (!participant.peer) participant.actual.guest.bindUiResolveNativeTables()
    }
    this.state = "active"
  }

  closeDrawing(token: string): void {
    for (const participant of this.participants.values())
      participant.actual.guest.retireUiResolveDrawing({ assembly: this.assembly, token })
    const drawing = this.drawings.get(token)
    if (!drawing) return
    drawing.controller.abort(new ModFunctionError("MODS_UI_DRAWING_STALE"))
    this.drawings.delete(token)
  }

  closeScope(id: string): void {
    const scope = this.scopeIds.get(id)
    if (scope) {
      const drawing = this.receiptDrawings.get(scope.receipt.identity)
      if (drawing) this.closeDrawing(drawing.token)
    }
  }

  retire(): void {
    if (this.state === "retired") {
      if (this.retirementFailure !== undefined) throw this.retirementFailure
      return
    }
    this.state = "retired"
    this.detach()
    this.controller.abort(new ModFunctionError("MODS_UI_RESOLVE_RETIRED"))
    for (const drawing of this.drawings.values())
      drawing.controller.abort(this.controller.signal.reason)
    this.drawings.clear()
    let failure: unknown
    try {
      this.bridge.close()
    } catch (error) {
      failure = error
    }
    try {
      this.registry.close()
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) {
      this.retirementFailure = failure
      this.failure ??= failure
      throw failure
    }
    // Neither abort nor table retirement fabricates actual VM/reply/reaction completion.
  }

  /** Only actual Guest.dispose completion permits the bridge to settle that peer's queued jobs. */
  disposed(runtime: FunctionUiResolveUtilityRuntime): void {
    const participant = this.participants.get(runtime.runtimeId)
    if (!participant || participant.actual !== runtime || !runtime.guest.stats.disposed) fail()
    if (participant.peer) this.bridge.disposePeer(participant.peer)
  }
}
