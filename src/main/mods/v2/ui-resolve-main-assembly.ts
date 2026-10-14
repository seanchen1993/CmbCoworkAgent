import { randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import type { ModJson } from "../../../shared/mods/types"
import {
  isModObject,
  matchesEventPattern,
  ModFunctionError,
  type FunctionHostReply
} from "../../../shared/mods/v2/contracts"
import type {
  FunctionUiResolveWireResponse,
  FunctionUiResolveWireCredit
} from "../../../shared/mods/v2/ui-resolve-wire"
import type { FunctionPlugin } from "./dispatcher"
import type { FunctionUiResolveDrawing } from "./ui-resolve-drawing"
import type { FunctionUiResolveExecution } from "./ui-resolve-execution"
import type { FunctionUiResolveTransportAdapter } from "./ui-resolve-transport-adapter"
import {
  functionUiResolveRuntimeBinding,
  type FunctionUiResolveRuntimeBinding
} from "./ui-resolve-runtime-binding"
import {
  FunctionUiResolveMainQuota,
  type FunctionUiResolveQuotaLease,
  type FunctionUiResolveQuotaCredit
} from "./ui-resolve-main-quota"
import type { FunctionSessionActivity } from "./session-activity"
import type { FunctionSessionInitializer } from "./session-initializer"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { wireError } from "./wire"

type Admission = ReturnType<FunctionSessionInitializer["captureAdmission"]>
interface Participant {
  plugin: FunctionPlugin
  binding: FunctionUiResolveRuntimeBinding
}
interface Drawing {
  consumer: Participant
  drawing: FunctionUiResolveDrawing
  execution: FunctionUiResolveExecution
  admission: Admission | undefined
  detach(): void
}
interface Scope {
  source: Participant
  drawing: Drawing
  registration: string
  controller: AbortController
  release(): void
  detach(): void
  pending: number
  drained: boolean
  releaseAttempted: boolean
  quiescent: boolean
  resource?: ReturnType<FunctionSessionActivity["retainFreshResource"]>
}

export interface FunctionUiResolveAssemblyHost {
  readonly activity?: FunctionSessionActivity
  readonly initializer?: FunctionSessionInitializer
  readonly signal: AbortSignal
  assertCurrent(plugin?: FunctionPlugin): void
  capabilities(plugin: FunctionPlugin): string[]
  captureExecution(): FunctionUiResolveExecution
  execute(
    plugin: FunctionPlugin,
    registration: string,
    method: string,
    args: ModJson,
    signal: AbortSignal,
    execution: FunctionUiResolveExecution,
    assertCurrent: () => void,
    admission: Admission | undefined,
    drawing?: FunctionUiResolveDrawing
  ): Promise<FunctionHostReply>
}

/** Main owns P/Q, lifecycle, granted credit and actual host finally; utility owns only VM handles. */
export class FunctionUiResolveMainAssembly implements FunctionUiResolveTransportAdapter {
  readonly assembly = randomUUID()
  readonly physical
  private readonly client
  private readonly participants = new Map<string, Participant>()
  private readonly drawings = new Map<string, Drawing>()
  private readonly drawingTokens = new WeakMap<FunctionUiResolveDrawing, Map<string, string>>()
  private readonly scopes = new Map<string, Scope>()
  private readonly calls = new Map<
    string,
    {
      source: Participant
      registration: string
      controller: AbortController
    }
  >()
  private readonly sources = new Map<string, Set<string>>()
  private readonly initializationDrains = new Set<() => void>()
  private readonly lease: FunctionUiResolveQuotaLease
  private credit?: FunctionUiResolveQuotaCredit
  private creditRevision = 0
  private creditLimits: FunctionUiResolveWireCredit["limits"] = {
    handles: 0,
    roots: 0,
    branches: 0,
    reactions: 0
  }
  private readonly controller = new AbortController()
  private readonly coordinator: string
  private closed = false
  private adopted = false
  private preparing = false
  private initialization?: {
    signal: AbortSignal
    execution: FunctionUiResolveExecution
    admission?: Admission
    cut: FunctionSharedWallCut
    enter<T>(run: () => Promise<T>): Promise<T>
  }

  constructor(
    plugins: readonly FunctionPlugin[],
    private readonly quota: FunctionUiResolveMainQuota,
    private readonly host: FunctionUiResolveAssemblyHost
  ) {
    const first = plugins[0]
    if (!first) throw this.error()
    const binding = functionUiResolveRuntimeBinding(first.guest)
    this.client = binding.client
    this.physical = binding.physical
    this.coordinator = binding.runtimeId
    for (const plugin of plugins) {
      const peer = functionUiResolveRuntimeBinding(plugin.guest)
      if (
        peer.client !== this.client ||
        peer.physical !== this.physical ||
        this.participants.has(peer.runtimeId)
      )
        throw this.error()
      this.participants.set(peer.runtimeId, { plugin, binding: peer })
    }
    this.lease = quota.register(this.physical)
    this.client.bindUiResolveTransport(this)
    const abort = () => this.close()
    host.signal.addEventListener("abort", abort, { once: true })
    void this.physical.disposed
      .then(() => {
        host.signal.removeEventListener("abort", abort)
        this.close()
        for (const [id, scope] of this.scopes) {
          scope.drained = true
          try {
            this.finishScope(id, scope)
          } catch {
            /* Uncertain release stays occupied; continue closing other native scopes. */
          }
        }
      })
      .catch(() => {
        /* A failed cleanup cannot count as a successful release. */
      })
    if (host.signal.aborted) this.close()
  }

  private error(code = "MODS_UI_RESOLVE_IDENTITY") {
    return new ModFunctionError(code)
  }
  ownsRuntime(runtimeId: string): boolean {
    return this.participants.has(runtimeId)
  }
  private guard(participant?: Participant): void {
    if (this.closed) throw this.error("MODS_UI_RESOLVE_RETIRED")
    this.host.signal.throwIfAborted()
    this.physical.assertCurrent()
    participant?.binding.assertCurrent()
    this.host.assertCurrent(participant?.plugin)
  }

  async prepare(startupCutNs: string, signal: AbortSignal): Promise<void> {
    this.guard()
    if (this.preparing || this.adopted) throw this.error()
    const cut = new FunctionSharedWallCut(startupCutNs)
    cut.assertLive()
    const init = (this.initialization = {
      signal: AbortSignal.any([signal, this.controller.signal]),
      execution: this.host.captureExecution(),
      admission: this.host.initializer?.captureAdmission(),
      cut,
      enter: AsyncResource.bind(<T>(run: () => Promise<T>) => run())
    })
    this.preparing = true
    try {
      this.credit = this.quota.reserve(this.lease, {
        handles: 0,
        roots: 0,
        branches: 0,
        reactions: 0
      })
      const credit = this.quota.wireCredit(this.lease, this.credit)
      this.creditRevision = credit.revision
      this.creditLimits = credit.limits
      const value = await this.client.requestUiResolve(
        this.coordinator,
        {
          type: "prepare-ui-resolve",
          assembly: this.assembly,
          startupCutNs,
          credit,
          participants: [...this.participants.values()].map(({ plugin, binding }) => ({
            runtimeId: binding.runtimeId,
            name: plugin.name,
            root: plugin.root,
            tier: plugin.tier,
            registrations: binding.registrations,
            capabilities: this.host.capabilities(plugin),
            modelProtocol: plugin.modelProtocol ?? "result-v1"
          }))
        },
        init.signal,
        cut.remainingMs() + 3000
      )
      this.guard()
      init.signal.throwIfAborted()
      cut.assertLive()
      if (
        !isModObject(value) ||
        Object.keys(value).length !== 3 ||
        value.assembly !== this.assembly ||
        typeof value.preparedToken !== "string" ||
        !value.preparedToken ||
        this.credit
      )
        throw this.error("MODS_UI_RESOLVE_PREPARE_INVALID")
      this.readSources(value.sources)
      await this.waitInitializationDrained(init.signal, cut)
      await this.client.requestUiResolve(
        this.coordinator,
        {
          type: "adopt-ui-resolve",
          assembly: this.assembly,
          preparedToken: value.preparedToken
        },
        init.signal,
        Math.min(10000, cut.remainingMs() + 1000)
      )
      this.guard()
      cut.assertLive()
      init.signal.throwIfAborted()
      init.admission && this.host.initializer?.assertReady()
      this.adopted = true
    } catch (error) {
      init.admission?.record(error)
      this.close()
      throw error
    } finally {
      this.preparing = false
      this.initialization = undefined
    }
  }

  bindDrawing(runtimeId: string, drawing: FunctionUiResolveDrawing) {
    const consumer = this.participants.get(runtimeId)
    if (!consumer || !this.adopted) throw this.error()
    this.guard(consumer)
    drawing.assertCurrent()
    let tokens = this.drawingTokens.get(drawing)
    if (!tokens) this.drawingTokens.set(drawing, (tokens = new Map()))
    const prior = tokens.get(runtimeId)
    if (prior) return { assembly: this.assembly, token: prior }
    if (this.drawings.size >= 4096) throw this.error("MODS_UI_RESOLVE_DRAWING_CAPACITY")
    const token = randomUUID()
    const close = () => {
      const record = this.drawings.get(token)
      if (!record) return
      this.drawings.delete(token)
      record.detach()
      for (const scope of this.scopes.values())
        if (scope.drawing === record) scope.controller.abort(drawing.signal.reason)
      if (!this.closed) {
        try {
          this.client.postUiResolve(this.coordinator, {
            type: "ui-resolve-drawing-close",
            assembly: this.assembly,
            token
          })
        } catch {
          this.close()
        }
      }
    }
    this.drawings.set(token, {
      consumer,
      drawing,
      execution: this.host.captureExecution(),
      admission: this.host.initializer?.captureAdmission(),
      detach: () => drawing.signal.removeEventListener("abort", close)
    })
    tokens.set(runtimeId, token)
    drawing.signal.addEventListener("abort", close, { once: true })
    try {
      drawing.assertCurrent()
    } catch (error) {
      close()
      throw error
    }
    return { assembly: this.assembly, token }
  }

  private readSources(value: ModJson | undefined): void {
    if (!isModObject(value) || Object.keys(value).some((id) => !this.participants.has(id)))
      throw this.error("MODS_UI_RESOLVE_PREPARE_INVALID")
    for (const [consumerId, components] of Object.entries(value)) {
      if (!isModObject(components)) throw this.error()
      for (const [component, rows] of Object.entries(components)) {
        if (
          (component !== "Pane" && !FUNCTION_UI_SITES.some((site) => site === component)) ||
          !Array.isArray(rows)
        )
          throw this.error()
        const allowed = new Set<string>()
        for (const row of rows) {
          if (
            !isModObject(row) ||
            Object.keys(row).length !== 2 ||
            typeof row.runtimeId !== "string" ||
            typeof row.registration !== "string" ||
            row.runtimeId === consumerId
          )
            throw this.error()
          this.source(row.runtimeId, row.registration)
          allowed.add(JSON.stringify([row.runtimeId, row.registration]))
        }
        this.sources.set(JSON.stringify([consumerId, component]), allowed)
      }
    }
  }

  private allowedSource(drawing: Drawing, runtimeId: string, registration: string): Participant {
    if (
      !this.sources
        .get(JSON.stringify([drawing.consumer.binding.runtimeId, drawing.drawing.component]))
        ?.has(JSON.stringify([runtimeId, registration]))
    )
      throw this.error()
    return this.source(runtimeId, registration)
  }

  private source(runtimeId: string, registration: string): Participant {
    const actual = this.participants.get(runtimeId)
    if (
      !actual ||
      !actual.binding.registrations.some(
        (row) => row.id === registration && matchesEventPattern(row.pattern, "ui.resolve")
      )
    )
      throw this.error()
    this.guard(actual)
    return actual
  }

  receive(message: FunctionUiResolveWireResponse): void {
    if (message.assembly !== this.assembly) throw this.error()
    if (message.type === "ui-constructor-quiescent") {
      const scope = this.scopes.get(message.scopeId)
      if (
        !scope ||
        scope.releaseAttempted ||
        scope.quiescent ||
        !scope.drawing.drawing.signal.aborted ||
        !scope.controller.signal.aborted
      )
        throw this.error()
      scope.quiescent = true
      this.demoteQuiescent(scope)
      return
    }
    if (message.type === "ui-constructor-drained") {
      const scope = this.scopes.get(message.scopeId)
      if (scope) {
        scope.drained = true
        this.finishScope(message.scopeId, scope)
      }
      return
    }
    if (message.type === "ui-resolve-call-revoke") {
      const call = this.calls.get(message.id)
      if (
        call &&
        call.source.binding.runtimeId === message.runtimeId &&
        call.registration === message.registration
      )
        call.controller.abort(this.error("MODS_CANCELLED"))
      return
    }
    this.guard()
    if (message.type === "ui-resolve-credit-ack") {
      if (message.revision !== this.creditRevision) throw this.error()
      if (!this.credit) return
      this.quota.acknowledge(this.lease, this.credit, this.physical.owner)
      this.credit = undefined
      return
    }
    if (message.type === "ui-resolve-credit-request") {
      try {
        if (!this.preparing || !this.initialization) throw this.error()
        this.initialization.cut.assertLive()
        this.credit = this.quota.reserve(this.lease, message.limits)
        const credit = this.quota.wireCredit(this.lease, this.credit)
        this.creditRevision = credit.revision
        this.creditLimits = credit.limits
        this.client.postUiResolve(
          this.coordinator,
          {
            type: "ui-resolve-credit-reply",
            assembly: this.assembly,
            credit
          },
          message.id
        )
      } catch (error) {
        this.client.postUiResolve(
          this.coordinator,
          {
            type: "ui-resolve-credit-reply",
            assembly: this.assembly,
            error: wireError(error)
          },
          message.id
        )
      }
      return
    }
    if (message.type === "ui-constructor-open") {
      const drawing = this.drawings.get(message.drawToken)
      if (
        !drawing ||
        drawing.consumer.binding.runtimeId !== message.consumerRuntimeId ||
        this.scopes.has(message.scopeId) ||
        this.scopes.size >=
          this.creditLimits.roots + this.creditLimits.branches + this.creditLimits.reactions
      )
        throw this.error()
      drawing.drawing.assertCurrent()
      drawing.execution.assertCurrent()
      const source =
        message.registration === "$native-ui" && message.runtimeId === message.consumerRuntimeId
          ? drawing.consumer
          : this.allowedSource(drawing, message.runtimeId, message.registration)
      const controller = new AbortController()
      const abort = () => controller.abort(drawing.drawing.signal.reason)
      const resource = this.host.activity?.retainRetirableUiResource()
      const release = resource?.release ?? (() => {})
      drawing.drawing.signal.addEventListener("abort", abort, { once: true })
      this.scopes.set(message.scopeId, {
        source,
        drawing,
        registration: message.registration,
        controller,
        pending: 0,
        drained: false,
        releaseAttempted: false,
        quiescent: false,
        resource,
        release,
        detach: () => drawing.drawing.signal.removeEventListener("abort", abort)
      })
      return
    }
    const scope =
      message.type === "ui-constructor-call" ? this.scopes.get(message.scopeId) : undefined
    const init = message.type === "ui-resolver-call" ? this.initialization : undefined
    if ((!scope && !init) || scope?.drained || this.calls.has(message.id) || this.calls.size >= 512)
      throw this.error()
    const source = scope
      ? this.allowedSource(scope.drawing, message.runtimeId, message.registration)
      : this.source(message.runtimeId, message.registration)
    const execution = scope?.drawing.execution ?? init!.execution
    const admission = scope?.drawing.admission ?? init?.admission
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      scope ? scope.controller.signal : init!.signal,
      this.controller.signal
    ])
    const check = () => {
      this.guard(source)
      execution.assertCurrent()
      signal.throwIfAborted()
      if (scope) {
        this.guard(scope.source)
        scope.drawing.drawing.assertCurrent()
      } else {
        if (!this.preparing || this.initialization !== init) throw this.error()
        init!.cut.assertLive()
      }
      admission?.assertMethod(message.method)
    }
    this.calls.set(message.id, { source, registration: message.registration, controller })
    if (scope) scope.pending++
    void this.physical
      .run(async () => {
        check()
        const execute = () =>
          this.host.execute(
            source.plugin,
            message.registration,
            message.method,
            parseModJson(encodeModJson(message.args)) as ModJson,
            signal,
            execution,
            check,
            admission,
            scope?.drawing.drawing
          )
        const result = await (init ? init.enter(execute) : execute())
        check()
        return result
      })
      .then(
        (value) => ({ value: parseModJson(encodeModJson(value)) as FunctionHostReply }),
        (error) => {
          admission?.record(error)
          return { error: wireError(error) }
        }
      )
      .then((reply) =>
        this.client.replyUiResolve(this.assembly, message.runtimeId, message.id, reply)
      )
      .finally(() => {
        this.calls.delete(message.id)
        if (!this.calls.size) for (const settled of [...this.initializationDrains]) settled()
        if (scope) {
          scope.pending--
          this.demoteQuiescent(scope)
          this.finishScope(message.type === "ui-constructor-call" ? message.scopeId : "", scope)
        }
      })
      .catch(() => {
        /* Lost reply cannot repeat already entered host work. */
      })
  }

  private async waitInitializationDrained(
    signal: AbortSignal,
    cut: FunctionSharedWallCut
  ): Promise<void> {
    if (!this.calls.size) return
    let complete!: () => void
    const actual = new Promise<void>((resolve) => {
      complete = resolve
    })
    this.initializationDrains.add(complete)
    const deadline = new FunctionDispatchDeadline(cut.remainingMs(), signal, cut.expiresAtNs)
    try {
      await deadline.wait(actual)
    } finally {
      this.initializationDrains.delete(complete)
      deadline.close()
    }
  }

  private finishScope(id: string, scope: Scope): void {
    if (!scope.drained || scope.pending || scope.releaseAttempted || this.scopes.get(id) !== scope)
      return
    scope.releaseAttempted = true
    scope.detach()
    scope.release()
    this.scopes.delete(id)
  }

  private demoteQuiescent(scope: Scope): void {
    if (
      !scope.quiescent ||
      scope.pending ||
      scope.releaseAttempted ||
      !scope.drawing.drawing.signal.aborted ||
      !scope.controller.signal.aborted
    )
      return
    scope.resource?.ready()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.controller.abort(this.error("MODS_UI_RESOLVE_RETIRED"))
    try {
      this.client.postUiResolve(this.coordinator, {
        type: "retire-ui-resolve",
        assembly: this.assembly
      })
    } catch {
      /* A lost retirement message cannot substitute for actual VM exit. */
    }
    this.quota.retire(this.lease)
    for (const drawing of this.drawings.values()) drawing.detach()
    this.drawings.clear()
    for (const scope of this.scopes.values()) scope.controller.abort(this.controller.signal.reason)
    // Retained scopes release only after actual utility drain/exit AND actual main host finally.
  }
}
