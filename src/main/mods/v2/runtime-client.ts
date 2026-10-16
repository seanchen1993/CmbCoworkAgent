import { randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { utilityProcess, type UtilityProcess } from "electron"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  ModFunctionError,
  isModObject,
  functionInvocationTimeoutMs,
  type FunctionGuest,
  type FunctionHostCall,
  type FunctionInvocation,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import type { FunctionRequest, FunctionResponse } from "../../../shared/mods/v2/protocol"
import { fromWireError, wireError } from "./wire"
import { markFunctionGuestLoadFailure } from "./client-load-failure"
import { markFunctionGuestInvokeFailure } from "./guest-invoke-failure"
import { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"
import { bindFunctionUiResolveRuntime } from "./ui-resolve-runtime-binding"
import { currentFunctionUiResolveDrawing } from "./ui-resolve-drawing"
import type { FunctionUiResolveTransportAdapter } from "./ui-resolve-transport-adapter"
import { isFunctionUiResolveWireResponse, type FunctionUiResolveWireRequest } from "../../../shared/mods/v2/ui-resolve-wire"

interface Pending {
  kind: FunctionRequest["type"]
  runtimeId: string
  host?: FunctionHostCall
  expiresAt: number
  controller: AbortController
  resolve(value: ModJson): void
  reject(error: Error): void
  detach(): void
  uiResolve?: FunctionUiResolveTransportAdapter
}
interface ModuleBinding {
  host: FunctionHostCall
  controller: AbortController
  onDispose?: () => void
}
type RequestBody = FunctionRequest extends infer R
  ? R extends FunctionRequest
    ? Omit<R, "id">
    : never
  : never

/** Trusted main-process proxy. Plugin source is evaluated exclusively in the utility process. */
export class FunctionRuntimeClient {
  private child?: UtilityProcess
  private physicalLifetime?: FunctionUiResolveHostLifetime
  private readonly retirements = new Set<Promise<void>>()
  private ready?: Promise<void>
  private rejectReady?: (error: Error) => void
  private timer?: ReturnType<typeof setInterval>
  private heartbeatAt = 0
  private watchdogTickAt = 0
  private watchdogGapMs = 0
  private heartbeatRecheck?: ReturnType<typeof setImmediate>
  private heartbeatGraceUntil?: number
  private generation = 0
  private readonly pending = new Map<string, Pending>()
  private readonly calls = new Map<
    string,
    { runtimeId: string; requestId?: string; controller: AbortController }
  >()
  private readonly modules = new Map<string, ModuleBinding>()
  private readonly deadRuntimes = new Set<string>()
  private readonly uiAssemblies = new Map<string, FunctionUiResolveTransportAdapter>()
  private remote = { rss: 0, runtimes: 0, frames: 0, replies: 0 }

  constructor(private readonly entry: string) {}

  get stats() {
    return {
      pid: this.child?.pid ?? null,
      ...this.remote,
      pending: this.pending.size,
      calls: this.calls.size,
      generation: this.generation
    }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const env: Record<string, string> = {}
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"])
      if (process.env[key]) env[key] = process.env[key]!
    this.heartbeatAt = performance.now() + 8000
    this.watchdogTickAt = performance.now()
    this.watchdogGapMs = 0
    this.heartbeatGraceUntil = undefined
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      const child = utilityProcess.fork(this.entry, [], {
        env,
        stdio: "pipe",
        serviceName: "CMB Function Mods"
      })
      this.child = child
      const lifetime = new FunctionUiResolveHostLifetime(child)
      this.physicalLifetime = lifetime
      child.stdout?.resume()
      child.stderr?.resume()
      child.on("message", (message: FunctionResponse) => {
        if (this.child !== child) return
        if (message.type === "ready") {
          this.heartbeatAt = performance.now()
          this.heartbeatGraceUntil = undefined
          this.rejectReady = undefined
          resolve()
        } else this.onMessage(message)
      })
      child.on("exit", () => {
        lifetime.confirmExit()
        if (this.child === child) this.stop("MODS_HOST_EXITED")
      })
      child.on("error", () => {
        if (this.child === child) this.stop("MODS_HOST_ERROR")
      })
    })
    this.timer = setInterval(() => {
      const now = performance.now()
      this.watchdogGapMs = now - this.watchdogTickAt
      this.watchdogTickAt = now
      if ([...this.pending.values()].some((p) => p.expiresAt < performance.now()))
        this.stop("MODS_HOST_TIMEOUT")
      else if (performance.now() - this.heartbeatAt > 2000) this.recheckHeartbeat()
    }, 250)
    this.timer.unref()
    return this.ready
  }

  private recheckHeartbeat(): void {
    const child = this.child
    if (!child || this.heartbeatRecheck) return
    const generation = this.generation
    const scheduledAt = performance.now()
    const hostGapAtSchedule = this.watchdogGapMs
    const recheck = setImmediate(() => {
      if (
        this.child !== child ||
        this.generation !== generation ||
        this.heartbeatRecheck !== recheck
      )
        return
      this.heartbeatRecheck = undefined
      if ([...this.pending.values()].some((pending) => pending.expiresAt < performance.now()))
        this.stop("MODS_HOST_TIMEOUT")
      else {
        const now = performance.now()
        if (now - this.heartbeatAt > 2000) {
          // A paused Main cannot consume heartbeats. Give this silence one fixed grace period.
          if (
            this.heartbeatGraceUntil === undefined &&
            (hostGapAtSchedule > 2000 || now - scheduledAt > 2000)
          )
            this.heartbeatGraceUntil = now + 2000
          if (this.heartbeatGraceUntil === undefined || now >= this.heartbeatGraceUntil)
            this.stop("MODS_HOST_UNRESPONSIVE")
        }
      }
    })
    this.heartbeatRecheck = recheck
    recheck.unref()
  }

  /** Native owner proof for main quota. A restarted physical utility has a different receipt. */
  captureUiResolvePhysicalLifetime(): FunctionUiResolveHostLifetime {
    const lifetime = this.physicalLifetime
    if (!lifetime || lifetime.owner !== this.child)
      throw new ModFunctionError("MODS_UI_RESOLVE_RETIRED")
    lifetime.assertCurrent()
    return lifetime
  }

  bindUiResolveTransport(adapter: FunctionUiResolveTransportAdapter): void {
    if (this.uiAssemblies.size || adapter.physical !== this.captureUiResolvePhysicalLifetime())
      throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
    this.uiAssemblies.set(adapter.assembly, adapter)
  }

  requestUiResolve(
    runtimeId: string, data: FunctionUiResolveWireRequest, signal?: AbortSignal, timeout = 10000
  ): Promise<ModJson> {
    const adapter = this.uiAssemblies.get(data.assembly)
    if (!adapter || adapter.physical !== this.captureUiResolvePhysicalLifetime() ||
      !adapter.ownsRuntime(runtimeId)) return Promise.reject(new ModFunctionError("MODS_UI_RESOLVE_IDENTITY"))
    return this.request({ ...data, runtimeId }, undefined, signal, timeout, adapter)
  }

  postUiResolve(runtimeId: string, data: FunctionUiResolveWireRequest, id = randomUUID()): void {
    const adapter = this.uiAssemblies.get(data.assembly)
    if (!adapter || adapter.physical !== this.captureUiResolvePhysicalLifetime() ||
      !adapter.ownsRuntime(runtimeId)) throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
    this.child?.postMessage({ ...data, id, runtimeId })
  }

  replyUiResolve(assembly: string, runtimeId: string, id: string,
    reply: Pick<Extract<FunctionRequest, { type: "reply" }>, "value" | "error">): void {
    const adapter = this.uiAssemblies.get(assembly)
    if (!adapter || adapter.physical !== this.physicalLifetime || !adapter.ownsRuntime(runtimeId)) return
    this.child?.postMessage({ type: "reply", id, runtimeId, ...reply })
  }

  private onMessage(message: FunctionResponse): void {
    if (message.type === "ready") return
    if (isFunctionUiResolveWireResponse(message)) {
      const adapter = this.uiAssemblies.get(message.assembly)
      if (adapter && adapter.physical === this.physicalLifetime) {
        if (message.type === "ui-resolver-call") {
          const owner = this.pending.get(message.requestId)
          if (!owner || owner.kind !== "prepare-ui-resolve" || owner.uiResolve !== adapter ||
            owner.controller.signal.aborted) {
            this.replyUiResolve(message.assembly, message.runtimeId, message.id, {
              error: wireError(new ModFunctionError("MODS_STALE_INVOCATION"))
            })
            return
          }
        }
        try { adapter.receive(message) }
        catch { this.stop("MODS_UI_RESOLVE_TRANSPORT_ERROR") }
      }
      return
    }
    if (message.type === "disposed") {
      try {
        const now = performance.now()
        console.warn("[FunctionRuntimeClient] Lifecycle diagnostic", {
          kind: "guest-disposed",
          code: null,
          generation: this.generation,
          pending: this.pending.size,
          heartbeatAgeMs: now - this.heartbeatAt,
          watchdogGapMs: this.watchdogGapMs,
          deadlineAgeMs: this.pending.size
            ? now - Math.min(...[...this.pending.values()].map((pending) => pending.expiresAt))
            : null
        })
      } catch {
        // Diagnostic failure must not interrupt the original retirement.
      }
      this.deadRuntimes.add(message.runtimeId)
      this.closeModule(message.runtimeId, new ModFunctionError("MODS_UNLOADED"))
      return
    }
    if (message.type === "heartbeat") {
      this.heartbeatAt = performance.now()
      this.heartbeatGraceUntil = undefined
      const { rss, runtimes, frames, replies } = message
      this.remote = { rss, runtimes, frames, replies }
      if (rss > 384 * 1024 * 1024) this.stop("MODS_HOST_MEMORY")
      return
    }
    if (message.type === "revoke") {
      const call = this.calls.get(message.id)
      if (call?.runtimeId === message.runtimeId && call.requestId === message.requestId) {
        call.controller.abort(new ModFunctionError("MODS_INVOCATION_ENDED"))
        this.calls.delete(message.id)
      }
      return
    }
    if (message.type === "module-revoke") {
      const call = this.calls.get(message.id)
      if (call?.runtimeId === message.runtimeId && call.requestId === undefined) {
        call.controller.abort(new ModFunctionError("MODS_UNLOADED"))
        this.calls.delete(message.id)
      }
      return
    }
    if (message.type === "module-call") {
      const binding = this.modules.get(message.runtimeId)
      const child = this.child
      const lifetime = this.physicalLifetime
      if (
        !binding ||
        binding.controller.signal.aborted ||
        this.calls.has(message.id) ||
        this.calls.size >= 512 ||
        [...this.calls.values()].filter((call) => call.runtimeId === message.runtimeId).length >=
          128
      ) {
        child?.postMessage({
          type: "reply",
          id: message.id,
          runtimeId: message.runtimeId,
          error: wireError(new ModFunctionError("MODS_MODULE_HOST_UNAVAILABLE"))
        })
        return
      }
      const controller = new AbortController()
      const call = { runtimeId: message.runtimeId, controller }
      this.calls.set(message.id, call)
      const signal = AbortSignal.any([controller.signal, binding.controller.signal])
      void Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          if (!lifetime || lifetime.owner !== child) throw new ModFunctionError("MODS_UNLOADED")
          return lifetime.run(() => binding.host(
            message.method,
            parseModJson(encodeModJson(message.args)) as ModJson,
            signal,
            message.dispatchCutNs === undefined ? undefined : { dispatchCutNs: message.dispatchCutNs }
          ))
        })
        .then(
          (value) => ({ value: parseModJson(encodeModJson(value)) }),
          (error) => ({ error: wireError(error) })
        )
        .then((reply) => {
          if (this.child === child && this.calls.get(message.id) === call)
            child?.postMessage({
              type: "reply",
              id: message.id,
              runtimeId: message.runtimeId,
              ...reply
            })
        })
        .catch(() => {
          if (this.child === child && this.calls.get(message.id) === call)
            child?.postMessage({
              type: "reply",
              id: message.id,
              runtimeId: message.runtimeId,
              error: wireError(new ModFunctionError("MODS_INVALID_HOST_RESULT"))
            })
        })
        .finally(() => {
          if (this.calls.get(message.id) === call) this.calls.delete(message.id)
        })
      return
    }
    if (message.type === "call") {
      const pending = this.pending.get(message.requestId)
      const child = this.child
      const lifetime = this.physicalLifetime
      if (!pending?.host || pending.runtimeId !== message.runtimeId || this.calls.size >= 512) {
        child?.postMessage({
          type: "reply",
          id: message.id,
          runtimeId: message.runtimeId,
          error: wireError(new ModFunctionError("MODS_STALE_INVOCATION"))
        })
        return
      }
      const controller = new AbortController()
      this.calls.set(message.id, {
        runtimeId: message.runtimeId,
        requestId: message.requestId,
        controller
      })
      const signal = AbortSignal.any([controller.signal, pending.controller.signal])
      void Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          const args = parseModJson(encodeModJson(message.args)) as ModJson
          if (!lifetime || lifetime.owner !== child) throw new ModFunctionError("MODS_UNLOADED")
          return lifetime.run(() => pending.host!(message.method, args, signal))
        })
        .then(
          (value) => ({ value: parseModJson(encodeModJson(value)) }),
          (error) => ({ error: wireError(error) })
        )
        .then((reply) => {
          if (this.child === child && this.calls.has(message.id))
            child?.postMessage({
              type: "reply",
              id: message.id,
              runtimeId: message.runtimeId,
              ...reply
            })
        })
        .catch(() => {
          if (this.child === child && this.calls.has(message.id))
            child?.postMessage({
              type: "reply",
              id: message.id,
              runtimeId: message.runtimeId,
              error: wireError(new ModFunctionError("MODS_INVALID_HOST_RESULT"))
            })
        })
        .finally(() => this.calls.delete(message.id))
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending || pending.runtimeId !== message.runtimeId) return
    this.pending.delete(message.id)
    pending.detach()
    pending.controller.abort(new ModFunctionError("MODS_INVOCATION_ENDED"))
    for (const [id, call] of this.calls) if (call.requestId === message.id) this.calls.delete(id)
    if (message.type === "error") {
      const error = fromWireError(message.error)
      if (pending.kind === "load" && message.guestLoadFailure === true)
        markFunctionGuestLoadFailure(error)
      if (pending.kind === "invoke" && message.guestInvokeFailure === true)
        markFunctionGuestInvokeFailure(error)
      pending.reject(error)
    }
    else {
      try {
        pending.resolve(parseModJson(encodeModJson(message.value)) as ModJson)
      } catch {
        pending.reject(new ModFunctionError("MODS_INVALID_GUEST_RESULT"))
      }
    }
  }

  private async request(
    data: RequestBody,
    host?: FunctionHostCall,
    signal?: AbortSignal,
    timeout = 10000,
    uiResolve?: FunctionUiResolveTransportAdapter
  ): Promise<ModJson> {
    if (signal?.aborted) throw new ModFunctionError("MODS_CANCELLED")
    await this.start()
    if (signal?.aborted) throw new ModFunctionError("MODS_CANCELLED")
    if (this.pending.size >= 128) throw new ModFunctionError("MODS_HOST_CAPACITY")
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const cancel = (): void => {
        controller.abort(new ModFunctionError("MODS_CANCELLED"))
        this.child?.postMessage({ type: "cancel", id, runtimeId: data.runtimeId })
      }
      this.pending.set(id, {
        kind: data.type,
        runtimeId: data.runtimeId,
        host: host ? AsyncResource.bind(host) : undefined,
        resolve,
        reject,
        controller,
        ...(uiResolve ? { uiResolve } : {}),
        expiresAt: performance.now() + timeout,
        detach: () => signal?.removeEventListener("abort", cancel)
      })
      signal?.addEventListener("abort", cancel, { once: true })
      this.child!.postMessage({ ...data, id })
    })
  }

  async load(code: string, options: ModObject = {}): Promise<FunctionGuest> {
    const runtimeId = randomUUID()
    const loaded = await this.request({
      type: "load",
      runtimeId,
      code,
      options
    })
    const registrations = (Array.isArray(loaded) ? loaded :
      isModObject(loaded) ? loaded.registrations : undefined) as unknown as FunctionRegistration[]
    if (!Array.isArray(registrations)) throw new ModFunctionError("MODS_REGISTRATION_INVALID")
    const registrationQuiescent = isModObject(loaded) && loaded.registrationQuiescent === true
    // Capture immutable bootstrap facts, never a cache of mutable guest matcher values.
    const unconditional = new Set(
      registrations.filter((row) => row.hasMatcher === false).map((row) => row.id)
    )
    const generation = this.generation
    let disposed = false
    const isDisposed = (): boolean =>
      disposed || generation !== this.generation || this.deadRuntimes.has(runtimeId)
    const request = this.request.bind(this)
    const assertLive = (): void => {
      if (isDisposed()) throw new ModFunctionError("MODS_UNLOADED")
    }
    const bind = (host: FunctionHostCall, onDispose?: () => void): void => {
      assertLive()
      if (this.modules.has(runtimeId)) throw new ModFunctionError("MODS_MODULE_HOST_ALREADY_BOUND")
      this.modules.set(runtimeId, {
        host: AsyncResource.bind(host),
        controller: new AbortController(),
        onDispose
      })
    }
    const close = (): void => this.closeModule(runtimeId, new ModFunctionError("MODS_UNLOADED"))
    const draw = () => {
      const drawing = currentFunctionUiResolveDrawing()
      if (!drawing) return undefined
      for (const adapter of this.uiAssemblies.values())
        if (adapter.physical === this.physicalLifetime && adapter.ownsRuntime(runtimeId))
          return adapter.bindDrawing(runtimeId, drawing)
      return undefined
    }
    const guest: FunctionGuest = {
      registrations,
      registrationQuiescent,
      bindModuleHost: bind,
      get stats() {
        return { disposed: isDisposed() }
      },
      async matches(registration, event) {
        assertLive()
        if (unconditional.has(registration)) {
          encodeModJson(event)
          return true
        }
        return (await request({ type: "match", runtimeId, registration, event })) === true
      },
      async releaseUi(generation) {
        assertLive()
        await request({ type: "release-ui", runtimeId, generation })
      },
      async releaseResource(handle) {
        assertLive()
        if (!Number.isSafeInteger(handle) || handle < 0)
          throw new ModFunctionError("MODS_RESOURCE_INVALID")
        await request({ type: "release-resource", runtimeId, handle })
      },
      async releaseStreamCursor(handle) {
        assertLive()
        if (!Number.isSafeInteger(handle) || handle < 0) throw new ModFunctionError("MODS_RESOURCE_INVALID")
        await request({ type: "release-stream-cursor", runtimeId, handle })
      },
      async invoke(registration, event, host, invocation: FunctionInvocation) {
        assertLive()
        const { signal, ...metadata } = invocation
        const uiDrawing = metadata.event === "ui.render" ? draw() : undefined
        return (await request(
          { type: "invoke", runtimeId, registration, event, metadata,
            ...(uiDrawing ? { uiDrawing } : {}) },
          host,
          signal,
          functionInvocationTimeoutMs(metadata) + 3000
        )) as { value?: ModJson; absent?: boolean }
      },
      async dispose() {
        if (isDisposed()) return
        disposed = true
        close()
        await request({ type: "dispose", runtimeId })
      }
    }
    bindFunctionUiResolveRuntime(guest, this, runtimeId, this.captureUiResolvePhysicalLifetime(), assertLive)
    return guest
  }

  private closeModule(runtimeId: string, error: Error): void {
    const binding = this.modules.get(runtimeId)
    this.modules.delete(runtimeId)
    binding?.controller.abort(error)
    for (const [id, call] of this.calls)
      if (call.runtimeId === runtimeId) {
        call.controller.abort(error)
        this.calls.delete(id)
      }
    try {
      binding?.onDispose?.()
    } catch {
      /* A cleanup callback cannot retain authority. */
    }
  }

  stop(code = "MODS_HOST_STOPPED"): void {
    const child = this.child
    if (child && code !== "MODS_HOST_STOPPED") {
      try {
        const now = performance.now()
        const diagnosticCode = [
          "MODS_HOST_EXITED",
          "MODS_HOST_ERROR",
          "MODS_HOST_UNRESPONSIVE",
          "MODS_HOST_TIMEOUT",
          "MODS_HOST_MEMORY",
          "MODS_UI_RESOLVE_TRANSPORT_ERROR"
        ].includes(code)
          ? code
          : "OTHER"
        console.warn("[FunctionRuntimeClient] Lifecycle diagnostic", {
          kind: "host-stop",
          code: diagnosticCode,
          generation: this.generation,
          pending: this.pending.size,
          heartbeatAgeMs: now - this.heartbeatAt,
          watchdogGapMs: this.watchdogGapMs,
          deadlineAgeMs: this.pending.size
            ? now - Math.min(...[...this.pending.values()].map((pending) => pending.expiresAt))
            : null
        })
      } catch {
        // Diagnostic failure must not interrupt the original retirement.
      }
    }
    if (this.heartbeatRecheck) clearImmediate(this.heartbeatRecheck)
    this.heartbeatRecheck = undefined
    this.heartbeatGraceUntil = undefined
    for (const assembly of this.uiAssemblies.values()) {
      try { assembly.close() }
      catch { /* A failing retirement guard must not retain the physical child. */ }
    }
    this.uiAssemblies.clear()
    const lifetime = this.physicalLifetime
    lifetime?.seal()
    if (lifetime) {
      const drained = Promise.all([lifetime.disposed, lifetime.hostDrained]).then(() => {})
      this.retirements.add(drained)
      void drained.finally(() => this.retirements.delete(drained))
    }
    this.physicalLifetime = undefined
    this.child = undefined
    this.ready = undefined
    this.generation++
    clearInterval(this.timer)
    const error = new ModFunctionError(code)
    this.rejectReady?.(error)
    this.rejectReady = undefined
    for (const pending of this.pending.values()) {
      pending.detach()
      pending.controller.abort(error)
      pending.reject(error)
    }
    for (const call of this.calls.values()) call.controller.abort(error)
    for (const runtimeId of [...this.modules.keys()]) this.closeModule(runtimeId, error)
    this.calls.clear()
    this.deadRuntimes.clear()
    this.pending.clear()
    child?.kill()
  }

  /** Development replacement requires actual child exit and every entered host call's finally. */
  async stopAndDrain(): Promise<void> {
    this.stop()
    await Promise.all([...this.retirements])
  }
}
