import { randomUUID } from "node:crypto"
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSDeferredPromise
} from "quickjs-emscripten"
import { parseModJson, encodeModJson } from "../../shared/mods/validation"
import type { ModJson, ModObject, ModRegistration } from "../../shared/mods/types"
import { GUEST_BOOTSTRAP } from "./guest-bootstrap"
import { ModError } from "./errors"

export type ModHostCall = (method: string, input: ModJson) => Promise<ModJson>

export class ModGuestRuntime {
  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext
  ) {}

  private deadline = 0
  private active: { token: string; call: ModHostCall; waiting: number } | null = null
  private readonly deferred = new Set<QuickJSDeferredPromise>()
  private disposed = false
  private timer?: ReturnType<typeof setInterval>
  private cancelled = false
  private wake?: () => void
  private scheduled?: NodeJS.Immediate
  readonly registrations: ModRegistration[] = []

  static async create(code: string): Promise<ModGuestRuntime> {
    const engine = await getQuickJS()
    const runtime = engine.newRuntime()
    runtime.setMemoryLimit(16 * 1024 * 1024)
    runtime.setMaxStackSize(512 * 1024)
    const context = runtime.newContext()
    const guest = new ModGuestRuntime(runtime, context)
    runtime.setInterruptHandler(() => guest.cancelled || Date.now() > guest.deadline)
    const hostCall = context.newFunction("__cmbHostCall", (token, method, json) => {
      const active = guest.active
      if (!active || context.getString(token) !== active.token) {
        throw new Error("MODS_STALE_INVOCATION")
      }
      const deferred = context.newPromise()
      guest.deferred.add(deferred)
      active.waiting++
      const methodName = context.getString(method)
      const inputText = context.getString(json)
      Promise.resolve()
        .then(async () => {
          const input = parseModJson(inputText) as ModJson
          return active.call(methodName, input)
        })
        .then(
          (value) => guest.resolve(deferred, { value }),
          () => guest.resolve(deferred, { error: "MODS_CAPABILITY_REJECTED" })
        )
        .finally(() => {
          active.waiting--
        })
      return deferred.handle
    })
    context.setProp(context.global, "__cmbHostCall", hostCall)
    hostCall.dispose()
    try {
      guest.evaluate(GUEST_BOOTSTRAP)
      guest.evaluate(code)
      const registrationJson = guest.evaluate("__cmbRegister()")
      const registrations = parseModJson(registrationJson)
      if (!Array.isArray(registrations)) throw new ModError("MODS_REGISTRATION_INVALID")
      guest.registrations.push(...(registrations as ModRegistration[]))
      return guest
    } catch (error) {
      guest.dispose()
      throw error
    }
  }

  private evaluate(code: string): string {
    this.deadline = Date.now() + 50
    const result = this.context.evalCode(code)
    if (result.error) {
      result.error.dispose()
      throw new ModError("MODS_GUEST_ERROR")
    }
    const value =
      this.context.typeof(result.value) === "string" ? this.context.getString(result.value) : ""
    result.value.dispose()
    return value
  }

  private resolve(deferred: QuickJSDeferredPromise, value: unknown): void {
    if (this.disposed || !this.deferred.has(deferred)) return
    let encoded: string
    try {
      encoded = encodeModJson(value)
    } catch {
      encoded = '{"error":"MODS_INVALID_HOST_RESULT"}'
    }
    const handle = this.context.newString(encoded)
    deferred.resolve(handle)
    handle.dispose()
    this.deferred.delete(deferred)
    deferred.dispose()
    this.wake?.()
  }

  async invoke(registration: string, event: ModObject, call: ModHostCall): Promise<ModJson> {
    if (this.disposed || this.active) throw new ModError("MODS_RUNTIME_BUSY")
    const token = randomUUID()
    this.active = { token, call, waiting: 0 }
    this.cancelled = false
    let ownTime = 0
    let cpuTime = 0
    let lastTick = Date.now()
    this.deadline = lastTick + 50
    const promiseResult = this.context.evalCode(
      `__cmbInvoke(${JSON.stringify(token)},${JSON.stringify(registration)},${JSON.stringify(encodeModJson(event))})`
    )
    if (promiseResult.error) {
      promiseResult.error.dispose()
      this.active = null
      throw new ModError("MODS_GUEST_ERROR")
    }
    const handle = promiseResult.value
    let rejectPump: (error: Error) => void = () => {}
    const pumpFailure = new Promise<never>((_resolve, reject) => {
      rejectPump = reject
    })
    const pump = (): void => {
      this.scheduled = undefined
      const now = Date.now()
      if (!this.active?.waiting) ownTime += now - lastTick
      lastTick = now
      if (ownTime > 5000 || cpuTime > 500 || this.cancelled) {
        rejectPump(new ModError(this.cancelled ? "MODS_CANCELLED" : "MODS_BUDGET_EXCEEDED"))
        return
      }
      this.deadline = now + 50
      const started = performance.now()
      const pumped = this.runtime.executePendingJobs(32)
      cpuTime += performance.now() - started
      if (pumped.error) {
        pumped.error.dispose()
        rejectPump(new ModError("MODS_GUEST_ERROR"))
        return
      }
      if (this.runtime.hasPendingJob()) this.wake?.()
    }
    this.wake = () => {
      if (!this.scheduled) this.scheduled = setImmediate(pump)
    }
    // Budget watchdog only; promise work wakes immediately on host replies.
    // A 2ms interval is ~15ms on some Windows utility processes.
    this.timer = setInterval(() => this.wake?.(), 50)
    this.wake()
    try {
      const result = await Promise.race([this.context.resolvePromise(handle), pumpFailure])
      if (result.error) {
        result.error.dispose()
        throw new ModError("MODS_GUEST_ERROR")
      }
      try {
        return parseModJson(this.context.getString(result.value)) as ModJson
      } finally {
        result.value.dispose()
      }
    } finally {
      clearInterval(this.timer)
      this.timer = undefined
      clearImmediate(this.scheduled)
      this.scheduled = undefined
      this.wake = undefined
      handle.dispose()
      this.active = null
      // A guest returning while next is pending must not leave usable capability handles.
      for (const pending of [...this.deferred]) {
        this.resolve(pending, { error: "MODS_INVOCATION_ENDED" })
      }
    }
  }

  cancel(): void {
    if (!this.active || this.disposed) return
    try {
      this.evaluate(`__cmbCancel(${JSON.stringify(this.active.token)})`)
    } finally {
      this.cancelled = true
      this.wake?.()
    }
  }

  dispose(): void {
    if (this.disposed) return
    clearInterval(this.timer)
    clearImmediate(this.scheduled)
    this.wake = undefined
    for (const deferred of this.deferred) deferred.dispose()
    this.deferred.clear()
    this.active = null
    this.disposed = true
    this.context.dispose()
    this.runtime.dispose()
  }
}
