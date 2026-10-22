import { registerFunctionDirectDisplaySource } from "./display-preparation"
import { installFunctionBase64Host } from "./guest-base64"
import { wireError } from "./wire"
import { platformDescriptor } from "./platform-capabilities-validation"
import { PLATFORM_VIEW_OPEN_METHODS, PLATFORM_VIEW_CLEANUP_METHODS } from "../../../shared/mods/v2/platform-capabilities"
import { encodeFunctionNextReply } from "./next-reply-wire"
import { randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime
} from "quickjs-emscripten"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionUiResolveWireDrawing } from "../../../shared/mods/v2/ui-resolve-wire"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  ModFunctionError,
  MOD_TIERS,
  functionInvocationTimeoutMs,
  isModObject,
  validEventPattern,
  type FunctionHostCall,
  type FunctionInvocation,
  type FunctionRegistration,
  type ModTier
} from "../../../shared/mods/v2/contracts"
import { FUNCTION_GUEST_BOOTSTRAP } from "./guest-bootstrap"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { FUNCTION_CODEGEN_GUARD } from "./guest-codegen"
import { FUNCTION_URL_GLOBALS } from "./guest-url-source"
import { FUNCTION_URL_LAZY_GLOBALS } from "./guest-url"
import { installFunctionStandardHost } from "./guest-standard-host"
import { modCompiler } from "../loader"
import { FunctionHookBudget, isFreeFunctionWait } from "./hook-budget"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { markFunctionGuestInvokeFailure } from "./guest-invoke-failure"
import { installFunctionUiResolveDataCopy } from "./ui-resolve-registry"
import { FunctionUiConstructorBridge, type FunctionUiConstructorGuest } from "./ui-constructor-bridge"
import { FunctionUiConstructorActivity } from "./ui-constructor-activity"
import { FunctionUiResolverActivity } from "./guest-ui-resolver-activity"
import type {
  FunctionUiResolveCall,
  FunctionUiResolveComponent,
  FunctionUiResolvePeer,
  FunctionUiResolvePropsProof,
  FunctionUiResolveSyncBudget
} from "./ui-resolve-private-types"

let compiledBootstrap: string | undefined

interface InvocationFrame {
  id: string
  promise?: QuickJSHandle
  host: FunctionHostCall
  controller: AbortController
  expiresAt: number
  budget?: FunctionHookBudget
  sharedCut?: FunctionSharedWallCut
  msAllowance?: number
  cleanupOnly?: boolean
  platformCleanup?: boolean
  platformUiOpen?: boolean
  enteredVm?: boolean
  uiDrawing?: Readonly<{
    drawing: Readonly<FunctionUiResolveWireDrawing>
    component: string
    generation: string
    requestId: string
  }>
  resolver?: {
    next(tier?: ModTier): Promise<QuickJSHandle>
    component: string
    resolve(value: QuickJSHandle): void
    nextCalls: number
  }
  resolve(value: { value?: ModJson; absent?: boolean }): void
  reject(error: Error): void
  detach(): void
}

interface ConstructorReply {
  pending: QuickJSDeferredPromise
  reply(run: () => void): void
  discard(): void
  cancel?: { key: string; controller: AbortController }
}

// Synchronous only: exclude nested peer execution from the caller's CPU charge.
const uiCpuSlices: Array<{ guest: FunctionGuestRuntime; start: number; children: number }> = []
const uiInspectionFences: Array<{ failure?: unknown }> = []

/** A persistent guest. SDK calls carry their continuation's frame; next stays dispatch-bound. */
export class FunctionGuestRuntime implements FunctionUiConstructorGuest {
  readonly registrations: FunctionRegistration[] = []
  private readonly frames = new Map<string, InvocationFrame>()
  private readonly closedCuts = new Map<string, string>()
  private readonly replies = new Map<QuickJSDeferredPromise, string>()
  private readonly waitReceipts = new Map<QuickJSDeferredPromise, () => void>()
  private readonly moduleReplies = new Map<QuickJSDeferredPromise, number>()
  private readonly cancelCalls = new Map<
    string,
    { pending: QuickJSDeferredPromise; controller: AbortController }
  >()
  private readonly moduleController = new AbortController()
  private moduleHost?: FunctionHostCall
  private moduleDispose?: () => void
  private moduleBytes = 0
  private deadline = 0
  private disposed = false
  private scheduled?: NodeJS.Immediate
  private watchdog?: ReturnType<typeof setInterval>
  private cpuMs = 0
  private cpuWindow = performance.now()
  private cpuInterruptions = 0
  private uiConstructorHelper?: QuickJSHandle
  private uiResolverInvoke?: QuickJSHandle
  private uiCopyDispose?: () => void
  private nativeUiTablesBound = false
  private uiBeforeDispose?: () => void
  private uiBinding?: {
    bridge: FunctionUiConstructorBridge
    peer: FunctionUiResolvePeer
    readTable(component: FunctionUiResolveComponent): QuickJSHandle
    holdHandle(handle: QuickJSHandle): () => void
  }
  private readonly constructorReplies = new Set<ConstructorReply>()
  private readonly constructorCancels = new Map<string, ConstructorReply>()
  private readonly resolverReplies = new Map<QuickJSDeferredPromise, string>()
  private readonly constructorSettlements: Array<() => void> = []
  private readonly resolverActivity = new FunctionUiResolverActivity(settle =>
    this.queueUiConstructorSettlement(settle))
  private readonly isolatedResolverLedger = new FunctionUiConstructorActivity({ branches: 128 })
  private readonly initialReplies = new Map<QuickJSDeferredPromise,
    ReturnType<FunctionUiResolverActivity["call"]>>()
  private readonly resolverDrains = new Map<QuickJSDeferredPromise, string>()
  private readonly actionProofs = new WeakMap<object, { handle: QuickJSHandle; release(): void }>()
  private readonly actionHandles = new Map<QuickJSHandle, () => void>()
  private constructorSettlementFailure?: unknown
  private promiseSettlementFailure?: ModFunctionError

  private constructor(
    private readonly vm: QuickJSRuntime,
    private readonly context: QuickJSContext
  ) {}

  static async create(code: string, options: ModObject = {}): Promise<FunctionGuestRuntime> {
    const engine = await getQuickJS()
    const vm = engine.newRuntime()
    vm.setMemoryLimit(16 * 1024 * 1024)
    vm.setMaxStackSize(512 * 1024)
    const context = vm.newContext()
    const guest = new FunctionGuestRuntime(vm, context)
    vm.setInterruptHandler(() => {
      if (guest.disposed) return true
      if (performance.now() <= guest.deadline) return false
      guest.cpuInterruptions++
      return true
    })
    installFunctionStandardHost(context)
    installFunctionBase64Host(context)
    const host = context.newFunction("__functionHost", (token, method, json, cancelId) => {
      guest.assertUiEffectsAllowed()
      const frame = guest.frames.get(context.getString(token))
      if (!frame || frame.controller.signal.aborted) throw Error("MODS_STALE_INVOCATION")
      if (guest.rpcSize >= 128) throw Error("MODS_RPC_LIMIT")
      const op = context.getString(method)
      if ((frame.platformCleanup && !PLATFORM_VIEW_CLEANUP_METHODS.includes(op)) ||
        (frame.platformUiOpen && !PLATFORM_VIEW_OPEN_METHODS.includes(op)))
        throw Error("MODS_PLATFORM_CLEANUP_ONLY")
      guest.assertFrame(frame, op === "stream.close")
      const input = parseModJson(context.getString(json)) as ModJson
      if (performance.now() >= frame.expiresAt) throw Error("MODS_BUDGET_EXCEEDED")
      frame.budget?.assertRemaining()
      let callController: AbortController | undefined
      let callKey: string | undefined
      if (cancelId && context.typeof(cancelId) !== "undefined") {
        if (!["clock.sleep", "model.complete", "platform.act"].includes(op) || context.typeof(cancelId) !== "string")
          throw Error("MODS_INVALID_CALL_CANCEL")
        const id = context.getString(cancelId)
        if (!/^[0-9]{1,20}$/.test(id)) throw Error("MODS_INVALID_CALL_CANCEL")
        callKey = frame.id + ":" + id
        if (guest.cancelCalls.has(callKey)) throw Error("MODS_INVALID_CALL_CANCEL")
        callController = new AbortController()
      }
      const receipt = frame.budget && isFreeFunctionWait(op)
        ? frame.budget.beginFreeWait() : undefined
      const initial = frame.resolver ? guest.resolverActivity.call(frame.id) : undefined
      let pending: QuickJSDeferredPromise
      try {
        pending = context.newPromise()
      } catch (error) {
        receipt?.()
        initial?.discard(); initial?.hostFinally()
        throw error
      }
      if (receipt) guest.waitReceipts.set(pending, receipt)
      guest.replies.set(pending, frame.id)
      if (initial) guest.initialReplies.set(pending, initial)
      if (callKey && callController)
        guest.cancelCalls.set(callKey, { pending, controller: callController })
      const callSignal = callController
        ? AbortSignal.any([frame.controller.signal, callController.signal])
        : frame.controller.signal
      void Promise.resolve()
        .then(() => {
          if (!guest.frames.has(frame.id) || frame.controller.signal.aborted)
            throw new ModFunctionError("MODS_STALE_INVOCATION")
          callSignal.throwIfAborted()
          guest.assertFrame(frame, op === "stream.close")
          return frame.host(op, input, callSignal)
        })
        .then(
          (reply) => guest.reply(pending, reply, op === "next"),
          (error) =>
            guest.reply(pending, {
              error: wireError(error)
            })
        ).finally(() => initial?.hostFinally()).catch(() => undefined)
      return pending.handle
    })
    context.setProp(context.global, "__functionHost", host)
    host.dispose()
    const readBudget = context.newFunction("readBudget", (token) => {
      const frame = guest.frames.get(context.getString(token))
      if (!frame || frame.controller.signal.aborted) throw Error("MODS_STALE_INVOCATION")
      if (performance.now() >= frame.expiresAt) throw Error("MODS_BUDGET_EXCEEDED")
      const snapshot = frame.budget?.snapshot() ?? { ms: 0, remainingMs: Infinity }
      frame.sharedCut?.assertLive()
      if (frame.sharedCut) {
        snapshot.ms = frame.msAllowance ?? frame.sharedCut.remainingMs()
        snapshot.remainingMs = Math.min(snapshot.remainingMs, frame.sharedCut.remainingMs())
      }
      const value = context.newObject()
      for (const [key, number] of Object.entries(snapshot)) {
        const field = context.newNumber(number)
        context.setProp(value, key, field)
        field.dispose()
      }
      return value
    })
    context.setProp(context.global, "__functionReadBudget", readBudget)
    readBudget.dispose()
    const cancelCall = context.newFunction("cancelCall", (token, id) => {
      if (context.typeof(token) !== "string" || context.typeof(id) !== "string") return
      const frameId = context.getString(token)
      const constructorCall = guest.constructorCancels.get(frameId + ":" + context.getString(id))
      if (constructorCall?.cancel) {
        constructorCall.cancel.controller.abort(new ModFunctionError("MODS_CANCELLED"))
        guest.replyConstructor(constructorCall, {
          error: { code: "MODS_CANCELLED", message: "MODS_CANCELLED" }
        })
        return
      }
      if (!guest.frames.has(frameId)) return
      const call = guest.cancelCalls.get(frameId + ":" + context.getString(id))
      if (!call) return
      call.controller.abort(new ModFunctionError("MODS_CANCELLED"))
      guest.reply(call.pending, { error: { code: "MODS_CANCELLED", message: "MODS_CANCELLED" } })
    })
    context.setProp(context.global, "__functionCancelCall", cancelCall)
    cancelCall.dispose()
    const moduleHost = context.newFunction("moduleHost", (method, json, budgetToken) => {
      guest.assertUiEffectsAllowed()
      if (guest.disposed || guest.moduleController.signal.aborted || !guest.moduleHost)
        throw Error("MODS_MODULE_HOST_UNAVAILABLE")
      if (context.typeof(method) !== "string" || context.typeof(json) !== "string")
        throw Error("MODS_INVALID_MODULE_CALL")
      const op = context.getString(method)
      const text = context.getString(json)
      const size = Buffer.byteLength(text)
      if (
        guest.rpcSize >= 128 ||
        guest.moduleBytes + size > 4194304
      )
        throw Error("MODS_RPC_LIMIT")
      const input = parseModJson(text) as ModJson
      const token = budgetToken && context.typeof(budgetToken) === "string"
        ? context.getString(budgetToken) : undefined
      const cleanup = ["resource.close", "resource.cancel-open", "resource.release-open"].includes(op)
      if (token && guest.closedCuts.has(token) && !cleanup)
        throw Error("MODS_STALE_INVOCATION")
      const frame = token ? guest.frames.get(token) : undefined
      if ((frame?.platformCleanup || frame?.platformUiOpen) && !cleanup) throw Error("MODS_PLATFORM_CLEANUP_ONLY")
      let receipt: (() => void) | undefined
      if (frame && !frame.controller.signal.aborted) {
        if (!cleanup) guest.assertFrame(frame)
        if (!cleanup && isFreeFunctionWait(op)) receipt = frame.budget?.beginFreeWait()
      }
      const callSignal = frame?.sharedCut && !cleanup
        ? AbortSignal.any([guest.moduleController.signal, frame.controller.signal])
        : guest.moduleController.signal
      const initial = frame?.resolver ? guest.resolverActivity.call(frame.id) : undefined
      let pending: QuickJSDeferredPromise
      try { pending = context.newPromise() }
      catch (error) { receipt?.(); initial?.discard(); initial?.hostFinally(); throw error }
      if (receipt) guest.waitReceipts.set(pending, receipt)
      guest.moduleReplies.set(pending, size)
      if (initial) guest.initialReplies.set(pending, initial)
      guest.moduleBytes += size
      void Promise.resolve()
        .then(() => {
          callSignal.throwIfAborted()
          if (frame?.sharedCut && !cleanup) frame.sharedCut.assertLive()
          const cut = frame?.sharedCut?.expiresAtNs ?? (token ? guest.closedCuts.get(token) : undefined)
          return guest.moduleHost!(op, input, callSignal, cut ? { dispatchCutNs: cut } : undefined)
        })
        .then(
          (reply) => guest.reply(pending, reply),
          (error) =>
            guest.reply(pending, {
              error: wireError(error)
            })
        ).finally(() => initial?.hostFinally()).catch(() => undefined)
      return pending.handle
    })
    context.setProp(context.global, "__functionModuleHost", moduleHost)
    moduleHost.dispose()
    guest.installUiConstructorHost()
    let urlInitialized = false
    let urlInitializing = false
    const initializeUrl = context.newFunction("initializeUrl", () => {
      if (urlInitialized) return
      if (urlInitializing) throw Error("MODS_URL_INITIALIZATION_REENTRY")
      urlInitializing = true
      try {
        // Fixed trusted source only, in this same VM and its current CPU slice. No new budget,
        // guest-supplied source, host URL objects, or dynamic module resolution is involved.
        const result = context.evalCode(FUNCTION_URL_GLOBALS)
        if (!result.error) urlInitialized = true
        return result
      } finally {
        urlInitializing = false
      }
    })
    context.setProp(context.global, "__functionInitializeUrl", initializeUrl)
    initializeUrl.dispose()
    try {
      // Native await bypasses Promise.then; lowering both sources makes continuation identity
      // explicit. Compilation happens only on load, outside the guest's execution slices.
      const compiler = modCompiler()
      compiledBootstrap ??= compiler.transformSync(FUNCTION_GUEST_BOOTSTRAP, {
        target: "es2016"
      }).code
      const program = compiler.transformSync(code, { target: "es2016" }).code
      guest.evaluate(FUNCTION_CODEGEN_GUARD).dispose()
      guest.deadline = performance.now() + 50
      guest.uiCopyDispose = installFunctionUiResolveDataCopy(context)
      guest.evaluate(compiledBootstrap).dispose()
      guest.uiConstructorHelper = context.getProp(context.global, "__functionUiConstructorBootstrap")
      guest.uiResolverInvoke = context.getProp(context.global, "__functionUiResolverInvoke")
      guest.evaluate("delete globalThis.__functionUiConstructorBootstrap; delete globalThis.__functionUiResolverInvoke").dispose()
      // Keep unused URL support off the cold path. Its native generator inspection must not
      // be ES2016-lowered, and initialization consumes the caller's existing execution budget.
      guest.evaluate(FUNCTION_URL_LAZY_GLOBALS).dispose()
      guest.evaluate(program).dispose()
      const registration = guest.evaluate(
        `__functionRegister(${JSON.stringify(encodeModJson(options))})`
      )
      try {
        const rows = parseModJson(context.getString(registration))
        if (!Array.isArray(rows) || rows.length > 128) throw Error("MODS_REGISTRATION_INVALID")
        for (const row of rows) {
          if (
            !isModObject(row) ||
            typeof row.id !== "string" ||
            typeof row.pattern !== "string" ||
            !validEventPattern(row.pattern) ||
            typeof row.hasCatch !== "boolean" ||
            typeof row.hasMatcher !== "boolean"
          )
            throw Error("MODS_REGISTRATION_INVALID")
          guest.registrations.push({
            id: row.id,
            pattern: row.pattern,
            hasCatch: row.hasCatch,
            hasMatcher: row.hasMatcher,
            ...(row.platformCapability !== undefined
              ? { platformCapability: platformDescriptor(row.platformCapability) } : {})
          })
        }
      } finally {
        registration.dispose()
      }
      registerFunctionDirectDisplaySource(guest, code)
      return guest
    } catch (error) {
      guest.dispose()
      throw error
    }
  }

  get registrationQuiescent(): boolean {
    return !this.disposed && !this.frames.size && !this.rpcSize && !this.vm.hasPendingJob()
  }

  get stats(): { frames: number; replies: number; disposed: boolean } {
    return {
      frames: this.frames.size,
      replies: this.rpcSize,
      disposed: this.disposed
    }
  }

  get uiResolverActivityStats() { return this.resolverActivity.stats }

  private get rpcSize(): number {
    return this.replies.size + this.moduleReplies.size + this.constructorReplies.size +
      this.resolverReplies.size
  }

  private assertUiEffectsAllowed(): void {
    if (this.promiseSettlementFailure) throw this.promiseSettlementFailure
    const fence = uiInspectionFences.at(-1)
    if (fence) {
      fence.failure ??= new ModFunctionError("MODS_UI_RESOLVE_DATA_EFFECT")
      throw fence.failure
    }
    if (this.constructorSettlementFailure !== undefined) throw this.constructorSettlementFailure
    this.uiBinding?.bridge.assertEffectsAllowed()
  }

  runUiResolverInspection<T>(cut: number | string, run: () => T): T {
    const fence: { failure?: unknown } = {}
    uiInspectionFences.push(fence)
    try {
      const shared = typeof cut === "string" ? new FunctionSharedWallCut(cut) : undefined
      shared?.assertLive()
      const absoluteExpiresAt = typeof cut === "number" ? cut : performance.now() + shared!.remainingMs()
      if (this.disposed || !Number.isFinite(absoluteExpiresAt))
        throw new ModFunctionError("MODS_UI_RESOLVE_FRAME")
      const result = this.cpuSlice(Math.min(absoluteExpiresAt, performance.now() + 50), run)
      if (fence.failure !== undefined) throw fence.failure
      if (performance.now() >= absoluteExpiresAt)
        throw new ModFunctionError("MODS_BUDGET_EXCEEDED")
      shared?.assertLive()
      return result
    } finally { uiInspectionFences.pop() }
  }

  /** Actual host context only, used to register a peer after the pretrusted helper is installed. */
  get uiResolveContext(): QuickJSContext {
    if (this.disposed) throw new ModFunctionError("MODS_UNLOADED")
    return this.context
  }

  bindUiResolvePeer(bridge: FunctionUiConstructorBridge, peer: FunctionUiResolvePeer,
    readTable: (component: FunctionUiResolveComponent) => QuickJSHandle,
    holdHandle: (handle: QuickJSHandle) => () => void,
    beforeDispose: () => void): void {
    if (this.disposed || this.uiBinding || this.nativeUiTablesBound ||
      peer.context !== this.context || peer.runtime !== this.vm)
      throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
    peer.assertCurrent()
    bridge.bindGuest(peer, this)
    this.uiBinding = { bridge, peer, readTable, holdHandle }
    this.uiBeforeDispose = beforeDispose
  }

  /** No resolver registrations: retain the same true native table without foreign ledgers. */
  bindUiResolveNativeTables(): void {
    if (this.disposed || this.uiBinding) throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
    this.nativeUiTablesBound = true
  }

  /** Actual private lifecycle close, never a public SDK token or an ambient latest drawing. */
  retireUiResolveDrawing(drawing: FunctionUiResolveWireDrawing): void {
    for (const frame of [...this.frames.values()]) {
      if (frame.uiDrawing?.drawing.assembly === drawing.assembly &&
        frame.uiDrawing.drawing.token === drawing.token)
        this.cancel(frame.id, "MODS_UI_DRAWING_STALE")
    }
  }

  /** Actual private frame proof, including after native jobs resume the original Q invocation. */
  currentUiResolveDrawing(): InvocationFrame["uiDrawing"] {
    const token = this.helper("currentFrame")
    try {
      if (this.context.typeof(token) !== "string") return undefined
      const frame = this.frames.get(this.context.getString(token))
      if (!frame?.uiDrawing || frame.controller.signal.aborted) return undefined
      this.assertFrame(frame)
      return frame.uiDrawing
    } finally { token.dispose() }
  }

  /** True cached native functions. No hook path exports no foreign handle or constructor scope. */
  createUiResolveNativeTable(component: FunctionUiResolveComponent): QuickJSHandle {
    const name = this.context.newString(component)
    try {
      return this.cpuSlice(performance.now() + 50, () => this.helper("nativeTable", name))
    } finally { name.dispose() }
  }

  private installUiConstructorHost(): void {
    const context = this.context
    const control = context.newFunction("constructorControl", (opHandle, tokenHandle, fn, value) => {
      if (this.disposed) throw new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE")
      const op = context.getString(opHandle)
      const token = context.getString(tokenHandle)
      if (op === "reaction.add" && this.resolverActivity.hasRoot(token)) {
        const id = this.resolverActivity.reserveReaction(token)
        this.wake()
        return context.newString(id)
      }
      if (this.resolverActivity.hasReaction(token)) {
        if (op === "reaction.settle") {
          this.resolverActivity.settleReaction(token)
          return context.undefined
        }
        if (op !== "reaction.run" || context.typeof(fn) !== "function")
          throw new ModFunctionError("MODS_UI_RESOLVE_REACTION")
        return this.resolverActivity.runReaction(token, frameToken => {
          const handle = context.newString(frameToken)
          const previous = this.helper("enterResolver", handle)
          handle.dispose()
          try {
            const result = context.callFunction(fn, context.undefined, value)
            return result.error ? result : result.value
          } finally { this.helper("restore", previous).dispose(); previous.dispose() }
        })
      }
      const binding = this.uiBinding
      if (!binding) throw new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE")
      if (op === "reaction.add") {
        const id = binding.bridge.reserveReaction(binding.peer, token)
        // A pure Promise reaction has no RPC reply or invocation frame to wake this P VM.
        this.wake()
        return context.newString(id)
      }
      if (op === "reaction.settle") {
        binding.bridge.settleReaction(binding.peer, token)
        return context.undefined
      }
      if (op !== "reaction.run" || context.typeof(fn) !== "function")
        throw new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE")
      return binding.bridge.runReaction(binding.peer, token, () => {
        const result = context.callFunction(fn, context.undefined, value)
        if (result.error) return result
        return result.value
      })
    })
    context.setProp(context.global, "__functionUiConstructorControl", control)
    control.dispose()
    const read = context.newFunction("constructorReadTable", component => {
      if (!this.uiBinding) {
        if (!this.nativeUiTablesBound) return context.undefined
        const name = context.getString(component)
        if (!["Pane", ...FUNCTION_UI_SITES].includes(name))
          throw new ModFunctionError("MODS_UI_SURFACE_UNAVAILABLE")
        return this.helper("nativeTable", component)
      }
      this.assertUiEffectsAllowed()
      return this.uiBinding.readTable(context.getString(component) as FunctionUiResolveComponent)
    })
    context.setProp(context.global, "__functionUiConstructorReadTable", read)
    read.dispose()
    const host = context.newFunction("constructorHost", (token, method, args, cancelId) => {
      this.assertUiEffectsAllowed()
      const binding = this.uiBinding
      if (!binding || this.disposed) throw new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE")
      if (this.rpcSize >= 128) throw new ModFunctionError("MODS_RPC_LIMIT")
      const tokenId = context.getString(token)
      const op = context.getString(method)
      let cancel: ConstructorReply["cancel"]
      if (cancelId && context.typeof(cancelId) !== "undefined") {
        if (!["clock.sleep", "model.complete"].includes(op) || context.typeof(cancelId) !== "string" ||
          !/^[0-9]{1,20}$/.test(context.getString(cancelId)))
          throw new ModFunctionError("MODS_INVALID_CALL_CANCEL")
        const key = tokenId + ":" + context.getString(cancelId)
        if (this.constructorCancels.has(key)) throw new ModFunctionError("MODS_INVALID_CALL_CANCEL")
        cancel = { key, controller: new AbortController() }
      }
      const request = binding.bridge.call(binding.peer, tokenId, op,
        parseModJson(context.getString(args)) as ModJson, cancel?.controller.signal)
      let pending: QuickJSDeferredPromise
      try { pending = context.newPromise() }
      catch (error) { request.discard(); throw error }
      const receipt: ConstructorReply = { pending, reply: request.reply, discard: request.discard,
        ...(cancel ? { cancel } : {}) }
      this.constructorReplies.add(receipt)
      if (cancel) this.constructorCancels.set(cancel.key, receipt)
      void request.result.then(value => this.replyConstructor(receipt, value),
        error => this.replyConstructor(receipt, { error: {
          code: error instanceof ModFunctionError ? error.code : "MODS_HOST_ERROR",
          message: error instanceof Error ? error.message.slice(0, 2048) : "MODS_HOST_ERROR"
        } })).catch(() => this.discardConstructorReply(receipt))
      return pending.handle
    })
    context.setProp(context.global, "__functionUiConstructorHost", host)
    host.dispose()
    const lower = context.newFunction("resolverNext", (token, input) => {
      const frame = this.frames.get(context.getString(token))
      if (!frame?.resolver || this.rpcSize >= 128) throw new ModFunctionError("MODS_UI_RESOLVE_FRAME")
      this.assertFrame(frame)
      if (frame.resolver.nextCalls >= 32) throw new ModFunctionError("MODS_NEXT_LIMIT")
      const args = parseModJson(context.getString(input))
      if (!isModObject(args) || (args.input !== undefined && (!isModObject(args.input) ||
        args.input.surface !== "desktop" || typeof args.input.component !== "string")) ||
        (isModObject(args.input) && args.input.component !== frame.resolver.component) ||
        (args.tier !== undefined && !MOD_TIERS.some(tier => tier === args.tier)) ||
        Object.keys(args).some(key => key !== "input" && key !== "tier"))
        throw new ModFunctionError("MODS_UI_RESOLVE_INPUT")
      frame.resolver.nextCalls++
      const initial = this.resolverActivity.call(frame.id)
      let pending: QuickJSDeferredPromise
      let receipt: (() => void) | undefined
      try { receipt = frame.budget?.beginFreeWait(); pending = context.newPromise() }
      catch (error) { receipt?.(); initial.discard(); initial.hostFinally(); throw error }
      if (receipt) this.waitReceipts.set(pending, receipt)
      this.resolverReplies.set(pending, frame.id)
      this.initialReplies.set(pending, initial)
      void Promise.resolve().then(() => {
        if (this.frames.get(frame.id) !== frame) throw new ModFunctionError("MODS_STALE_INVOCATION")
        this.assertFrame(frame)
        return frame.resolver!.next(args.tier as ModTier | undefined)
      }).then(handle => {
        try {
          this.vm.assertOwned(handle)
          if (this.frames.get(frame.id) !== frame) throw new ModFunctionError("MODS_STALE_INVOCATION")
          this.assertFrame(frame)
          this.settleResolverReply(pending, handle)
        } finally { handle.dispose() }
      }, error => this.settleResolverReply(pending, undefined, error)).catch(error =>
        this.settleResolverReply(pending, undefined, error)).finally(() => initial.hostFinally())
        .catch(() => undefined)
      return pending.handle
    })
    context.setProp(context.global, "__functionUiResolverNext", lower)
    lower.dispose()
    const drain = context.newFunction("resolverDrain", token => {
      const frame = this.frames.get(context.getString(token))
      if (!frame?.resolver) throw new ModFunctionError("MODS_UI_RESOLVE_FRAME")
      const actual = this.resolverActivity.drain(frame.id)
      const pending = context.newPromise()
      this.resolverDrains.set(pending, frame.id)
      void actual.then(
        () => this.settleResolverDrain(pending),
        () => this.settleResolverDrain(pending, "MODS_UI_RESOLVE_DRAIN")
      ).catch(() => undefined)
      return pending.handle
    })
    context.setProp(context.global, "__functionUiResolverDrain", drain)
    drain.dispose()
  }

  private helper(method: string, ...args: QuickJSHandle[]): QuickJSHandle {
    if (!this.uiConstructorHelper || this.disposed) throw new ModFunctionError("MODS_UNLOADED")
    const fn = this.context.getProp(this.uiConstructorHelper, method)
    try {
      const result = this.context.callFunction(fn, this.context.undefined, ...args)
      if (result.error) { result.error.dispose(); throw new ModFunctionError("MODS_UI_CONSTRUCTOR_SCOPE") }
      return result.value
    } finally { fn.dispose() }
  }

  private cpuSlice<T>(deadline: number, run: () => T): T {
    if (this.promiseSettlementFailure) throw this.promiseSettlementFailure
    const now = performance.now()
    if (now - this.cpuWindow > 5000) { this.cpuWindow = now; this.cpuMs = 0 }
    if (this.cpuMs > 500) throw new ModFunctionError("MODS_BUDGET_EXCEEDED")
    const previous = this.deadline
    this.deadline = Math.min(deadline, now + Math.max(0, 500 - this.cpuMs),
      uiCpuSlices.some(slice => slice.guest === this) ? previous : deadline)
    const slice = { guest: this, start: now, children: 0 }
    uiCpuSlices.push(slice)
    try { return run() }
    finally {
      const elapsed = performance.now() - slice.start
      this.cpuMs += Math.max(0, elapsed - slice.children)
      uiCpuSlices.pop()
      const parent = uiCpuSlices.at(-1)
      if (parent) parent.children += elapsed
      this.deadline = previous
      // Dispose only after unwinding the real QuickJS stack; never free an executing context.
      if (this.cpuMs > 500) this.wake()
    }
  }

  private failPromiseSettlement(error: unknown, interrupted = false): ModFunctionError {
    if (!this.promiseSettlementFailure) {
      this.promiseSettlementFailure = new ModFunctionError(
        interrupted || this.cpuMs > 500 ||
          (error instanceof ModFunctionError && error.code === "MODS_BUDGET_EXCEEDED")
          ? "MODS_BUDGET_EXCEEDED" : "MODS_GUEST_ERROR"
      )
      markFunctionGuestInvokeFailure(this.promiseSettlementFailure)
    }
    // Never free a VM from a reentrant native callback. The next pump runs after unwinding.
    this.wake()
    return this.promiseSettlementFailure
  }

  /** Deferred resolvers call guest JS too, including a plugin's Promise subclass. */
  private settleGuestPromise(
    pending: QuickJSDeferredPromise,
    value: QuickJSHandle,
    rejected = false
  ): void {
    if (this.promiseSettlementFailure) throw this.promiseSettlementFailure
    if (this.disposed) throw new ModFunctionError("MODS_UNLOADED")
    const interruptions = this.cpuInterruptions
    try {
      this.cpuSlice(performance.now() + 50, () => {
        if (rejected) pending.reject(value)
        else pending.resolve(value)
      })
      if (this.cpuInterruptions !== interruptions || this.cpuMs > 500)
        throw new ModFunctionError("MODS_BUDGET_EXCEEDED")
    } catch (error) {
      throw this.failPromiseSettlement(error, this.cpuInterruptions !== interruptions)
    }
  }

  private rejectGuestPromise(pending: QuickJSDeferredPromise, reason: string): void {
    // A failed VM settlement has no second allowance. Native cleanup still retires its handles.
    if (this.promiseSettlementFailure || this.disposed) return
    let failure: QuickJSHandle | undefined
    try {
      failure = this.context.newString(reason)
      this.settleGuestPromise(pending, failure, true)
    } catch (error) {
      this.failPromiseSettlement(error)
    } finally {
      failure?.dispose()
    }
  }

  private settleResolverDrain(pending: QuickJSDeferredPromise, error?: string): void {
    if (this.disposed || !this.resolverDrains.has(pending)) return
    try {
      if (error) this.rejectGuestPromise(pending, error)
      else this.settleGuestPromise(pending, this.context.undefined)
    } catch (failure) {
      this.failPromiseSettlement(failure)
    } finally {
      this.resolverDrains.delete(pending)
      pending.dispose()
      this.wake()
    }
  }

  runUiConstructorSync<T>(token: string, budget: FunctionUiResolveSyncBudget,
    phase: "constructor" | "data" | "reconnect", run: () => T): T {
    if (phase === "constructor" && uiInspectionFences.length) this.assertUiEffectsAllowed()
    budget.assertRemaining()
    return this.cpuSlice(budget.expiresAt, () => {
      let previous: QuickJSHandle | undefined
      const handle = this.context.newString(token)
      try {
        if (phase === "constructor") previous = this.helper("enter", handle)
        const result = run()
        budget.assertRemaining()
        if (this.cpuMs > 500) throw new ModFunctionError("MODS_BUDGET_EXCEEDED")
        return result
      } finally {
        handle.dispose()
        if (previous) { this.helper("restore", previous).dispose(); previous.dispose() }
      }
    })
  }

  runUiConstructorReaction<T>(token: string, run: () => T): T {
    return this.cpuSlice(Math.min(this.deadline, performance.now() + 50), () => {
      const handle = this.context.newString(token)
      const previous = this.helper("enter", handle)
      handle.dispose()
      try { return run() }
      finally { this.helper("restore", previous).dispose(); previous.dispose() }
    })
  }

  captureUiConstructorActions(props: QuickJSHandle): object {
    const handle = this.helper("capture", props)
    let release: () => void
    try {
      if (!this.uiBinding) throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
      release = this.uiBinding.holdHandle(handle)
    } catch (error) { handle.dispose(); throw error }
    const proof = Object.freeze({})
    this.actionProofs.set(proof, { handle, release })
    this.actionHandles.set(handle, release)
    return proof
  }

  releaseUiConstructorActions(proof: object): void {
    const actions = this.actionProofs.get(proof)
    if (!actions) return
    actions.release()
    this.actionHandles.delete(actions.handle)
    this.actionProofs.delete(proof)
  }

  reconnectUiConstructorActions(call: FunctionUiResolveCall, proof: FunctionUiResolvePropsProof,
    output: QuickJSHandle): QuickJSHandle {
    const actions = this.actionProofs.get(proof.actions)
    if (!actions) throw new ModFunctionError("MODS_UI_RESOLVE_ACTIONS")
    const input = this.context.newObject()
    const callbacks = this.context.newObject()
    const name = this.context.newString(call.constructorName)
    const key = proof.rootKey === undefined ? this.context.undefined : this.context.newString(proof.rootKey)
    try {
      for (const callback of ["onPress", "onInput", "onSubmit", "onSelect", "onLinkPress"]) {
        const fn = proof.callback(callback)
        if (fn) this.context.setProp(callbacks, callback, fn)
      }
      this.context.setProp(input, "actions", actions.handle)
      this.context.setProp(input, "callbacks", callbacks)
      this.context.setProp(input, "key", key)
      this.context.setProp(input, "name", name)
      this.context.setProp(input, "output", output)
      return this.helper("reconnect", input)
    } finally {
      input.dispose(); callbacks.dispose(); name.dispose(); key.dispose()
      actions.release()
      this.actionHandles.delete(actions.handle)
      this.actionProofs.delete(proof.actions)
    }
  }

  queueUiConstructorSettlement(settle: () => void): void {
    this.constructorSettlements.push(settle)
    if (this.disposed) this.flushConstructorSettlements()
    else this.wake()
  }

  private flushConstructorSettlements(): void {
    for (const settle of this.constructorSettlements.splice(0)) {
      try { settle() }
      catch (error) {
        this.constructorSettlementFailure ??= error
        this.uiBinding?.bridge.close()
      }
    }
  }

  private discardConstructorReply(receipt: ConstructorReply): void {
    if (!this.constructorReplies.delete(receipt)) return
    if (receipt.cancel) {
      this.constructorCancels.delete(receipt.cancel.key)
      receipt.cancel.controller.abort(new ModFunctionError("MODS_UNLOADED"))
    }
    receipt.pending.dispose()
    receipt.discard()
  }

  private replyConstructor(receipt: ConstructorReply, packet: unknown): void {
    if (this.disposed || !this.constructorReplies.has(receipt)) return
    let value: QuickJSHandle | undefined
    let entered = false
    try {
      let text: string
      try { text = encodeModJson(packet) }
      catch { text = '{"error":{"code":"MODS_INVALID_HOST_RESULT","message":"MODS_INVALID_HOST_RESULT"}}' }
      const actual = this.context.newString(text)
      value = actual
      entered = true
      receipt.reply(() => this.settleGuestPromise(receipt.pending, actual))
    }
    catch {
      this.rejectGuestPromise(receipt.pending, "MODS_UI_CONSTRUCTOR_SCOPE")
    } finally {
      value?.dispose()
      this.constructorReplies.delete(receipt)
      if (receipt.cancel) this.constructorCancels.delete(receipt.cancel.key)
      receipt.pending.dispose()
      // reply owns its actual post-pump settlement. Only an unentered receipt is discarded here.
      if (!entered) receipt.discard()
      this.wake()
    }
  }

  private settleResolverReply(pending: QuickJSDeferredPromise, value?: QuickJSHandle,
    error?: unknown): void {
    if (this.disposed || !this.resolverReplies.has(pending)) return
    const initial = this.initialReplies.get(pending)
    let entered = false
    try {
      this.waitReceipts.get(pending)?.()
      this.waitReceipts.delete(pending)
      const receive = () => {
        if (error !== undefined || !value)
          this.rejectGuestPromise(pending, error instanceof ModFunctionError ? error.code :
            "MODS_UI_RESOLVE_NEXT_FAILED")
        else this.settleGuestPromise(pending, value)
      }
      if (initial) { entered = true; initial.reply(receive) }
      else receive()
    }
    catch {
      this.rejectGuestPromise(pending, "MODS_STALE_INVOCATION")
    } finally {
      this.waitReceipts.delete(pending)
      this.initialReplies.delete(pending)
      this.resolverReplies.delete(pending)
      pending.dispose()
      if (initial && !entered) initial.discard()
      this.wake()
    }
  }

  bindModuleHost(host: FunctionHostCall, onDispose?: () => void): void {
    if (this.disposed) throw new ModFunctionError("MODS_UNLOADED")
    if (this.moduleHost) throw new ModFunctionError("MODS_MODULE_HOST_ALREADY_BOUND")
    this.moduleHost = AsyncResource.bind(host)
    this.moduleDispose = onDispose
  }

  private evaluate(code: string): QuickJSHandle {
    if (this.promiseSettlementFailure) throw this.promiseSettlementFailure
    if (this.disposed) throw new ModFunctionError("MODS_UNLOADED")
    return this.cpuSlice(performance.now() + 50, () => {
      const result = this.context.evalCode(code)
      if (result.error) {
        // Dumping an arbitrary guest object could execute accessors. Read a fixed diagnostic only.
        result.error.dispose()
        throw new ModFunctionError("MODS_GUEST_ERROR")
      }
      return result.value
    })
  }

  matches(id: string, event: ModObject): boolean {
    const result = this.evaluate(
      `__functionMatches(${JSON.stringify(id)},${JSON.stringify(encodeModJson(event))})`
    )
    try {
      return this.context.getString(result) === "true"
    } finally {
      result.dispose()
    }
  }

  releaseUi(generation: string): void {
    this.evaluate(`__functionReleaseUi(${JSON.stringify(generation)})`).dispose()
  }

  releaseResource(handle: number): void {
    if (!Number.isSafeInteger(handle) || handle < 0)
      throw new ModFunctionError("MODS_RESOURCE_INVALID")
    this.evaluate(`__functionReleaseResource(${handle})`).dispose()
  }

  releaseStreamCursor(handle: number): void {
    if (!Number.isSafeInteger(handle) || handle < 0)
      throw new ModFunctionError("MODS_RESOURCE_INVALID")
    this.evaluate(`__functionReleaseStreamCursor(${handle})`).dispose()
  }

  invoke(
    id: string,
    event: ModObject,
    host: FunctionHostCall,
    options: FunctionInvocation,
    uiDrawing?: FunctionUiResolveWireDrawing
  ): Promise<{ value?: ModJson; absent?: boolean }> {
    if (this.promiseSettlementFailure) return Promise.reject(this.promiseSettlementFailure)
    if (this.disposed) return Promise.reject(new ModFunctionError("MODS_UNLOADED"))
    if (options.signal?.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
    if (this.frames.size >= 32) return Promise.reject(new ModFunctionError("MODS_FRAME_LIMIT"))
    const { signal, admission, ownBudgetMs, dispatchCutNs, ...metadata } = options
    const token = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = (): void => this.cancel(token,
        signal?.reason instanceof ModFunctionError ? signal.reason.code : "MODS_CANCELLED")
      const frame: InvocationFrame = {
        id: token,
        host: AsyncResource.bind(host),
        controller: new AbortController(),
        expiresAt: performance.now() + functionInvocationTimeoutMs(options),
        ...(uiDrawing && options.event === "ui.render" && typeof options.uiGeneration === "string" &&
          typeof event.requestId === "string" && typeof event.component === "string" ? {
            uiDrawing: Object.freeze({ drawing: Object.freeze({ ...uiDrawing }),
              component: event.component, generation: options.uiGeneration, requestId: event.requestId })
          } : {}),
        ...(ownBudgetMs === undefined ? {} : { budget: new FunctionHookBudget(ownBudgetMs) }),
        ...(dispatchCutNs === undefined ? {} : { sharedCut: new FunctionSharedWallCut(dispatchCutNs) }),
        ...(dispatchCutNs && options.streamCursor?.action === "return" ? { cleanupOnly: true } : {}),
        ...(options.platformCleanup ? { platformCleanup: true } : {}),
        ...(options.platformUiOpen ? { platformUiOpen: true } : {}),
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", cancel)
      }
      this.frames.set(token, frame)
      signal?.addEventListener("abort", cancel, { once: true })
      const execute = () => {
        if (this.disposed || this.frames.get(token) !== frame) return
        if (performance.now() >= frame.expiresAt) {
          this.cancel(token, "MODS_BUDGET_EXCEEDED")
          return
        }
        try {
          signal?.throwIfAborted()
          if (!frame.cleanupOnly) frame.sharedCut?.assertLive()
          if (frame.sharedCut) frame.msAllowance = Math.min(
            ownBudgetMs === undefined || ownBudgetMs === 0 ? Infinity : ownBudgetMs,
            frame.sharedCut.remainingMs()
          )
          frame.budget?.start()
          const source = `__functionInvoke(${JSON.stringify(token)},${JSON.stringify(id)},${JSON.stringify(encodeModJson(event))},${JSON.stringify(encodeModJson(metadata))})`
          frame.enteredVm = true
          try { frame.promise = this.evaluate(source) }
          catch (error) {
            if (error instanceof Error) markFunctionGuestInvokeFailure(error)
            throw error
          }
          if (!this.watchdog) this.watchdog = setInterval(() => this.wake(), 25)
          this.wake()
        } catch (error) {
          this.finish(
            frame,
            error instanceof Error ? error : new ModFunctionError("MODS_GUEST_ERROR")
          )
        }
      }
      if (admission) {
        if (!this.watchdog) this.watchdog = setInterval(() => this.wake(), 25)
        void Promise.resolve().then(() => {
          frame.controller.signal.throwIfAborted()
          frame.sharedCut?.assertLive()
          if (performance.now() >= frame.expiresAt)
            throw new ModFunctionError("MODS_BUDGET_EXCEEDED")
          if (this.disposed || this.frames.get(token) !== frame)
            throw new ModFunctionError("MODS_CANCELLED")
          return frame.host("invoke.admitted", {}, frame.controller.signal)
        }).then(execute, error => {
          if (this.frames.get(token) === frame)
            this.finish(frame, error instanceof Error ? error :
              new ModFunctionError("MODS_INVOCATION_ADMISSION"))
        })
      } else execute()
    })
  }

  /** Private load-time raw-function result path. Ordinary invoke remains strict ModJSON. */
  invokeUiResolver(
    id: string,
    event: ModObject,
    host: FunctionHostCall,
    options: FunctionInvocation,
    next: (tier?: ModTier) => Promise<QuickJSHandle>,
    absoluteExpiresAt: number
  ): Promise<QuickJSHandle> {
    if (this.promiseSettlementFailure) return Promise.reject(this.promiseSettlementFailure)
    if (this.disposed || !this.uiResolverInvoke)
      return Promise.reject(new ModFunctionError("MODS_UNLOADED"))
    if (options.event !== "ui.resolve" || !this.registrations.some(row => row.id === id) ||
      !Number.isFinite(absoluteExpiresAt))
      return Promise.reject(new ModFunctionError("MODS_UI_RESOLVE_FRAME"))
    if (options.signal?.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
    if (this.frames.size >= 32) return Promise.reject(new ModFunctionError("MODS_FRAME_LIMIT"))
    const { signal, admission: _admission, ownBudgetMs, dispatchCutNs, ...metadata } = options
    void _admission
    const token = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = () => this.cancel(token,
        signal?.reason instanceof ModFunctionError ? signal.reason.code : "MODS_CANCELLED")
      const frame: InvocationFrame = {
        id: token, host: AsyncResource.bind(host), controller: new AbortController(),
        expiresAt: Math.min(absoluteExpiresAt,
          performance.now() + functionInvocationTimeoutMs(options)),
        ...(ownBudgetMs === undefined ? {} : { budget: new FunctionHookBudget(ownBudgetMs) }),
        ...(dispatchCutNs === undefined ? {} : { sharedCut: new FunctionSharedWallCut(dispatchCutNs) }),
        resolver: { next: AsyncResource.bind(next), resolve, component: String(event.component), nextCalls: 0 },
        resolve: () => reject(new ModFunctionError("MODS_UI_RESOLVE_RESULT")), reject,
        detach: () => signal?.removeEventListener("abort", cancel)
      }
      this.frames.set(token, frame)
      signal?.addEventListener("abort", cancel, { once: true })
      const args = [token, id, encodeModJson(event), encodeModJson(metadata)].map(value =>
        this.context.newString(value))
      try {
        signal?.throwIfAborted()
        frame.sharedCut?.assertLive()
        this.assertFrame(frame)
        this.resolverActivity.begin(token, this.uiBinding?.bridge.activity ?? this.isolatedResolverLedger,
          { actor: frame, receipt: frame, signal: frame.controller.signal, assertCurrent: () => {
            if (this.frames.get(token) !== frame) throw new ModFunctionError("MODS_STALE_INVOCATION")
            this.assertFrame(frame)
          }, retain: () => () => undefined })
        frame.budget?.start()
        frame.enteredVm = true
        frame.promise = this.cpuSlice(performance.now() + 50, () => {
          const result = this.context.callFunction(this.uiResolverInvoke!, this.context.undefined, ...args)
          if (result.error) {
            result.error.dispose()
            throw new ModFunctionError("MODS_UI_RESOLVE_HANDLER")
          }
          return result.value
        })
        if (!this.watchdog) this.watchdog = setInterval(() => this.wake(), 25)
        this.wake()
      } catch (error) {
        this.finish(frame, error instanceof Error ? error : new ModFunctionError("MODS_UI_RESOLVE_HANDLER"))
      } finally { for (const arg of args) arg.dispose() }
    })
  }

  private reply(pending: QuickJSDeferredPromise, packet: unknown, next = false): void {
    if (this.disposed || (!this.replies.has(pending) && !this.moduleReplies.has(pending))) return
    const initial = this.initialReplies.get(pending)
    let value: QuickJSHandle | undefined
    let entered = false
    try {
      this.waitReceipts.get(pending)?.()
      this.waitReceipts.delete(pending)
      let text: string
      try { text = next ? encodeFunctionNextReply(packet) : encodeModJson(packet) }
      catch { text = '{"error":{"message":"MODS_INVALID_HOST_RESULT","downstream":true}}' }
      const actual = this.context.newString(text)
      value = actual
      if (initial) {
        entered = true
        initial.reply(() => this.settleGuestPromise(pending, actual))
      } else this.settleGuestPromise(pending, actual)
    } catch {
      this.rejectGuestPromise(pending, "MODS_STALE_INVOCATION")
    } finally {
      this.waitReceipts.delete(pending)
      this.initialReplies.delete(pending)
      value?.dispose()
      this.replies.delete(pending)
      for (const [key, call] of this.cancelCalls)
        if (call.pending === pending) this.cancelCalls.delete(key)
      const bytes = this.moduleReplies.get(pending)
      if (bytes !== undefined) {
        this.moduleBytes -= bytes
        this.moduleReplies.delete(pending)
      }
      pending.dispose()
      if (initial && !entered) initial.discard()
      this.wake()
    }
  }

  private wake(): void {
    if (!this.disposed && !this.scheduled) this.scheduled = setImmediate(() => this.pump())
  }

  private assertFrame(frame: InvocationFrame, cleanup = false): void {
    if (!frame.cleanupOnly || !cleanup) frame.sharedCut?.assertLive()
    if (performance.now() >= frame.expiresAt) throw new ModFunctionError("MODS_BUDGET_EXCEEDED")
    frame.budget?.assertRemaining()
  }

  private pump(): void {
    this.scheduled = undefined
    if (this.disposed) return
    if (this.promiseSettlementFailure) {
      this.dispose(this.promiseSettlementFailure.code, true)
      return
    }
    const now = performance.now()
    if (now - this.cpuWindow > 5000) {
      this.cpuWindow = now
      this.cpuMs = 0
    }
    for (const frame of [...this.frames.values()]) {
      try { this.assertFrame(frame, true) }
      catch (error) { this.cancel(frame.id, error instanceof ModFunctionError ? error.code : "MODS_BUDGET_EXCEEDED", frame.enteredVm === true) }
    }
    this.deadline = performance.now() + 50
    const interruptions = this.cpuInterruptions
    let execution: { jobs: ReturnType<QuickJSRuntime["executePendingJobs"]> } | { error: unknown }
    try { execution = { jobs: this.cpuSlice(this.deadline, () => this.vm.executePendingJobs(32)) } }
    catch (error) { execution = { error } }
    // Classify only this real VM segment, before native post-pump settlement work runs.
    const interrupted = this.cpuInterruptions !== interruptions
    const cpuExceeded = this.cpuMs > 500
    this.flushConstructorSettlements()
    if ("error" in execution) {
      const exhausted = interrupted || cpuExceeded ||
        (execution.error instanceof ModFunctionError && execution.error.code === "MODS_BUDGET_EXCEEDED")
      const failure = this.failPromiseSettlement(execution.error, exhausted)
      this.dispose(failure.code, true)
      return
    }
    const jobs = execution.jobs
    if (jobs.error) {
      jobs.error.dispose()
      const failure = this.failPromiseSettlement(new ModFunctionError("MODS_GUEST_ERROR"),
        interrupted || cpuExceeded)
      this.dispose(failure.code, true)
      return
    }
    if (interrupted || cpuExceeded) {
      const failure = this.failPromiseSettlement(new ModFunctionError("MODS_BUDGET_EXCEEDED"))
      this.dispose(failure.code, true)
      return
    }
    for (const frame of [...this.frames.values()]) {
      if (!frame.promise) continue
      // Continuations may exhaust their own time inside this jobs slice. Never accept their
      // return before the next watchdog has had a chance to observe that exhaustion.
      try { this.assertFrame(frame, true) }
      catch (error) {
        this.cancel(frame.id, error instanceof ModFunctionError ? error.code : "MODS_BUDGET_EXCEEDED", frame.enteredVm === true)
        continue
      }
      const state = this.context.getPromiseState(frame.promise)
      if (state.type === "pending") continue
      if (state.type === "rejected") {
        state.error.dispose()
        this.finish(frame, markFunctionGuestInvokeFailure(new ModFunctionError("MODS_GUEST_ERROR")))
        continue
      }
      try {
        if (frame.resolver) {
          if (this.context.typeof(state.value) !== "object")
            throw new ModFunctionError("MODS_UI_RESOLVE_RESULT")
          this.finish(frame, undefined, undefined, state.value.dup())
          continue
        }
        const packet = parseModJson(this.context.getString(state.value))
        if (!isModObject(packet)) throw new ModFunctionError("MODS_INVALID_GUEST_RESULT")
        if (isModObject(packet.error)) {
          throw new ModFunctionError(
            packet.error.downstream === true &&
              typeof packet.error.code === "string" &&
              /^MODS_[A-Z0-9_]{1,80}$/.test(packet.error.code)
              ? packet.error.code
              : "MODS_HOOK_FAILED",
            String(packet.error.message),
            packet.error.downstream === true
          )
        }
        this.finish(frame, undefined, packet)
      } catch (error) {
        this.finish(
          frame,
          markFunctionGuestInvokeFailure(error instanceof Error ? error : new ModFunctionError("MODS_GUEST_ERROR"))
        )
      } finally {
        state.value.dispose()
      }
    }
    if (this.vm.hasPendingJob()) this.wake()
  }

  private finish(
    frame: InvocationFrame,
    error?: Error,
    value?: { value?: ModJson; absent?: boolean },
    rawValue?: QuickJSHandle
  ): void {
    if (!this.frames.delete(frame.id)) return
    if (frame.sharedCut) this.closedCuts.set(frame.id, frame.sharedCut.expiresAtNs)
    frame.detach()
    frame.budget?.close()
    frame.controller.abort(error ?? new ModFunctionError("MODS_INVOCATION_ENDED"))
    if (frame.resolver) this.resolverActivity.cancel(frame.id,
      error ?? new ModFunctionError("MODS_INVOCATION_ENDED"))
    for (const [pending, id] of this.replies) {
      if (id === frame.id)
        this.reply(pending, { error: { message: "MODS_STALE_INVOCATION", downstream: false } })
    }
    for (const [pending, id] of this.resolverReplies)
      if (id === frame.id) this.settleResolverReply(pending, undefined,
        new ModFunctionError("MODS_STALE_INVOCATION"))
    for (const [pending, id] of this.resolverDrains)
      if (id === frame.id) this.settleResolverDrain(pending, "MODS_STALE_INVOCATION")
    frame.promise?.dispose()
    const failure = error ?? this.promiseSettlementFailure
    if (failure) {
      rawValue?.dispose()
      frame.reject(failure)
    } else if (rawValue && frame.resolver) frame.resolver.resolve(rawValue)
    else frame.resolve(value ?? {})
    if (this.frames.size === 0) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
  }

  private cancel(id: string, code = "MODS_CANCELLED", guestFailure = false): void {
    const frame = this.frames.get(id)
    if (!frame || this.disposed) return
    try {
      this.evaluate(`__functionCancel(${JSON.stringify(id)})`).dispose()
    } catch {
      // The host frame is revoked even when a guest abort listener fails.
    }
    const error = new ModFunctionError(code, code, code === "MODS_DISPATCH_TIMEOUT")
    this.finish(frame, guestFailure ? markFunctionGuestInvokeFailure(error) : error)
  }

  dispose(code = "MODS_UNLOADED", guestFailure = false): void {
    if (this.disposed) return
    for (const frame of [...this.frames.values()]) {
      const error = new ModFunctionError(code)
      this.finish(frame, guestFailure && frame.enteredVm ? markFunctionGuestInvokeFailure(error) : error)
    }
    this.disposed = true
    const beforeDispose = this.uiBeforeDispose
    this.uiBeforeDispose = undefined
    // Native foreign handles must be retired while their owning QuickJS context is still alive.
    // A failed disposal remains fail-closed; it must never be hidden behind a WASM free assertion.
    beforeDispose?.()
    this.moduleController.abort(new ModFunctionError(code))
    const onDispose = this.moduleDispose
    this.moduleDispose = undefined
    this.moduleHost = undefined
    clearInterval(this.watchdog)
    clearImmediate(this.scheduled)
    for (const pending of this.replies.keys()) pending.dispose()
    this.replies.clear()
    this.waitReceipts.clear()
    this.cancelCalls.clear()
    for (const pending of this.moduleReplies.keys()) pending.dispose()
    this.moduleReplies.clear()
    for (const receipt of [...this.constructorReplies]) this.discardConstructorReply(receipt)
    for (const pending of this.resolverReplies.keys()) pending.dispose()
    this.resolverReplies.clear()
    this.uiBinding?.bridge.disposePeer(this.uiBinding.peer)
    this.resolverActivity.dispose()
    for (const [pending, initial] of this.initialReplies) {
      initial.discard()
      this.initialReplies.delete(pending)
    }
    for (const pending of this.resolverDrains.keys()) pending.dispose()
    this.resolverDrains.clear()
    this.flushConstructorSettlements()
    for (const release of this.actionHandles.values()) release()
    this.actionHandles.clear()
    this.uiConstructorHelper?.dispose()
    this.uiResolverInvoke?.dispose()
    this.uiCopyDispose?.()
    this.closedCuts.clear()
    this.moduleBytes = 0
    this.context.dispose()
    this.vm.dispose()
    try {
      onDispose?.()
    } catch {
      /* Cleanup cannot resurrect or prevent disposal. */
    }
  }
}
