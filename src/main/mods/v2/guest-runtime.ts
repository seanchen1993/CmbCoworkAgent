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
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  ModFunctionError,
  isModObject,
  validEventPattern,
  type FunctionHostCall,
  type FunctionInvocation,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import { FUNCTION_GUEST_BOOTSTRAP } from "./guest-bootstrap"
import { modCompiler } from "../loader"

let compiledBootstrap: string | undefined

interface InvocationFrame {
  id: string
  promise?: QuickJSHandle
  host: FunctionHostCall
  controller: AbortController
  expiresAt: number
  resolve(value: { value?: ModJson; absent?: boolean }): void
  reject(error: Error): void
  detach(): void
}

/** A persistent guest. SDK calls carry their continuation's frame; next stays dispatch-bound. */
export class FunctionGuestRuntime {
  readonly registrations: FunctionRegistration[] = []
  private readonly frames = new Map<string, InvocationFrame>()
  private readonly replies = new Map<QuickJSDeferredPromise, string>()
  private deadline = 0
  private disposed = false
  private scheduled?: NodeJS.Immediate
  private watchdog?: ReturnType<typeof setInterval>
  private cpuMs = 0
  private cpuWindow = performance.now()

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
    vm.setInterruptHandler(() => guest.disposed || performance.now() > guest.deadline)
    const host = context.newFunction("__functionHost", (token, method, json) => {
      const frame = guest.frames.get(context.getString(token))
      if (!frame || frame.controller.signal.aborted) throw Error("MODS_STALE_INVOCATION")
      if (guest.replies.size >= 128) throw Error("MODS_RPC_LIMIT")
      const op = context.getString(method)
      const input = parseModJson(context.getString(json)) as ModJson
      const pending = context.newPromise()
      guest.replies.set(pending, frame.id)
      void Promise.resolve()
        .then(() => {
          if (!guest.frames.has(frame.id) || frame.controller.signal.aborted)
            throw new ModFunctionError("MODS_STALE_INVOCATION")
          return frame.host(op, input, frame.controller.signal)
        })
        .then(
          (reply) => guest.reply(pending, reply),
          (error) =>
            guest.reply(pending, {
              error: {
                code: error instanceof ModFunctionError ? error.code : "MODS_HOST_ERROR",
                message: error instanceof Error ? error.message.slice(0, 2048) : "MODS_HOST_ERROR",
                downstream: error instanceof ModFunctionError && error.downstream
              }
            })
        )
      return pending.handle
    })
    context.setProp(context.global, "__functionHost", host)
    host.dispose()
    try {
      // Native await bypasses Promise.then; lowering both sources makes continuation identity
      // explicit. Compilation happens only on load, outside the guest's execution slices.
      const compiler = modCompiler()
      compiledBootstrap ??= compiler.transformSync(FUNCTION_GUEST_BOOTSTRAP, {
        target: "es2016"
      }).code
      const program = compiler.transformSync(code, { target: "es2016" }).code
      guest.evaluate(compiledBootstrap).dispose()
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
            hasMatcher: row.hasMatcher
          })
        }
      } finally {
        registration.dispose()
      }
      return guest
    } catch (error) {
      guest.dispose()
      throw error
    }
  }

  get stats(): { frames: number; replies: number; disposed: boolean } {
    return { frames: this.frames.size, replies: this.replies.size, disposed: this.disposed }
  }

  private evaluate(code: string): QuickJSHandle {
    if (this.disposed) throw new ModFunctionError("MODS_UNLOADED")
    this.deadline = performance.now() + 50
    const result = this.context.evalCode(code)
    if (result.error) {
      // Dumping an arbitrary guest object could execute accessors. Read a fixed diagnostic only.
      result.error.dispose()
      throw new ModFunctionError("MODS_GUEST_ERROR")
    }
    return result.value
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

  invoke(
    id: string,
    event: ModObject,
    host: FunctionHostCall,
    options: FunctionInvocation
  ): Promise<{ value?: ModJson; absent?: boolean }> {
    if (this.disposed) return Promise.reject(new ModFunctionError("MODS_UNLOADED"))
    if (options.signal?.aborted) return Promise.reject(new ModFunctionError("MODS_CANCELLED"))
    if (this.frames.size >= 32) return Promise.reject(new ModFunctionError("MODS_FRAME_LIMIT"))
    const { signal, timeoutMs = 5000, ...metadata } = options
    const token = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = (): void => this.cancel(token)
      const frame: InvocationFrame = {
        id: token,
        host: AsyncResource.bind(host),
        controller: new AbortController(),
        expiresAt: performance.now() + Math.min(Math.max(timeoutMs, 1), 120_000),
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", cancel)
      }
      this.frames.set(token, frame)
      signal?.addEventListener("abort", cancel, { once: true })
      try {
        frame.promise = this.evaluate(
          `__functionInvoke(${JSON.stringify(token)},${JSON.stringify(id)},${JSON.stringify(encodeModJson(event))},${JSON.stringify(encodeModJson(metadata))})`
        )
        if (!this.watchdog) this.watchdog = setInterval(() => this.wake(), 25)
        this.wake()
      } catch (error) {
        this.finish(
          frame,
          error instanceof Error ? error : new ModFunctionError("MODS_GUEST_ERROR")
        )
      }
    })
  }

  private reply(pending: QuickJSDeferredPromise, packet: unknown): void {
    if (this.disposed || !this.replies.has(pending)) return
    let text: string
    try {
      text = encodeModJson(packet)
    } catch {
      text = '{"error":{"message":"MODS_INVALID_HOST_RESULT","downstream":true}}'
    }
    const value = this.context.newString(text)
    pending.resolve(value)
    value.dispose()
    this.replies.delete(pending)
    pending.dispose()
    this.wake()
  }

  private wake(): void {
    if (!this.disposed && !this.scheduled) this.scheduled = setImmediate(() => this.pump())
  }

  private pump(): void {
    this.scheduled = undefined
    if (this.disposed) return
    const now = performance.now()
    if (now - this.cpuWindow > 5000) {
      this.cpuWindow = now
      this.cpuMs = 0
    }
    for (const frame of [...this.frames.values()]) {
      if (now >= frame.expiresAt) this.cancel(frame.id, "MODS_BUDGET_EXCEEDED")
    }
    this.deadline = performance.now() + 50
    const start = performance.now()
    const jobs = this.vm.executePendingJobs(32)
    this.cpuMs += performance.now() - start
    if (jobs.error) {
      jobs.error.dispose()
      this.dispose("MODS_GUEST_ERROR")
      return
    }
    if (this.cpuMs > 500) {
      this.dispose("MODS_BUDGET_EXCEEDED")
      return
    }
    for (const frame of [...this.frames.values()]) {
      if (!frame.promise) continue
      const state = this.context.getPromiseState(frame.promise)
      if (state.type === "pending") continue
      if (state.type === "rejected") {
        state.error.dispose()
        this.finish(frame, new ModFunctionError("MODS_GUEST_ERROR"))
        continue
      }
      try {
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
          error instanceof Error ? error : new ModFunctionError("MODS_GUEST_ERROR")
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
    value?: { value?: ModJson; absent?: boolean }
  ): void {
    if (!this.frames.delete(frame.id)) return
    frame.detach()
    frame.controller.abort(error ?? new ModFunctionError("MODS_INVOCATION_ENDED"))
    for (const [pending, id] of this.replies) {
      if (id === frame.id)
        this.reply(pending, { error: { message: "MODS_STALE_INVOCATION", downstream: false } })
    }
    frame.promise?.dispose()
    if (error) frame.reject(error)
    else frame.resolve(value ?? {})
    if (this.frames.size === 0) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
  }

  private cancel(id: string, code = "MODS_CANCELLED"): void {
    const frame = this.frames.get(id)
    if (!frame || this.disposed) return
    try {
      this.evaluate(`__functionCancel(${JSON.stringify(id)})`).dispose()
    } catch {
      // The host frame is revoked even when a guest abort listener fails.
    }
    this.finish(frame, new ModFunctionError(code))
  }

  dispose(code = "MODS_UNLOADED"): void {
    if (this.disposed) return
    for (const frame of [...this.frames.values()]) this.finish(frame, new ModFunctionError(code))
    this.disposed = true
    clearInterval(this.watchdog)
    clearImmediate(this.scheduled)
    for (const pending of this.replies.keys()) pending.dispose()
    this.replies.clear()
    this.context.dispose()
    this.vm.dispose()
  }
}
