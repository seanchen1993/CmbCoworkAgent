import { randomUUID } from "node:crypto"
import { utilityProcess, type UtilityProcess } from "electron"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  ModFunctionError,
  type FunctionGuest,
  type FunctionHostCall,
  type FunctionInvocation,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import type { FunctionRequest, FunctionResponse } from "../../../shared/mods/v2/protocol"
import { fromWireError, wireError } from "./wire"

interface Pending {
  runtimeId: string
  host?: FunctionHostCall
  expiresAt: number
  controller: AbortController
  resolve(value: ModJson): void
  reject(error: Error): void
  detach(): void
}
type RequestBody = FunctionRequest extends infer R
  ? R extends FunctionRequest
    ? Omit<R, "id">
    : never
  : never

/** Trusted main-process proxy. Plugin source is evaluated exclusively in the utility process. */
export class FunctionRuntimeClient {
  private child?: UtilityProcess
  private ready?: Promise<void>
  private rejectReady?: (error: Error) => void
  private timer?: ReturnType<typeof setInterval>
  private heartbeatAt = 0
  private generation = 0
  private readonly pending = new Map<string, Pending>()
  private readonly calls = new Map<string, { requestId: string; controller: AbortController }>()
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
    this.heartbeatAt = Date.now() + 8000
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      const child = utilityProcess.fork(this.entry, [], {
        env,
        stdio: "pipe",
        serviceName: "CMB Function Mods"
      })
      this.child = child
      child.stdout?.resume()
      child.stderr?.resume()
      child.on("message", (message: FunctionResponse) => {
        if (this.child !== child) return
        if (message.type === "ready") {
          this.heartbeatAt = Date.now()
          this.rejectReady = undefined
          resolve()
        } else this.onMessage(message)
      })
      child.on("exit", () => {
        if (this.child === child) this.stop("MODS_HOST_EXITED")
      })
      child.on("error", () => {
        if (this.child === child) this.stop("MODS_HOST_ERROR")
      })
    })
    this.timer = setInterval(() => {
      if (Date.now() - this.heartbeatAt > 2000) this.stop("MODS_HOST_UNRESPONSIVE")
      else if ([...this.pending.values()].some((p) => p.expiresAt < Date.now()))
        this.stop("MODS_HOST_TIMEOUT")
    }, 250)
    this.timer.unref()
    return this.ready
  }

  private onMessage(message: FunctionResponse): void {
    if (message.type === "ready") return
    if (message.type === "heartbeat") {
      this.heartbeatAt = Date.now()
      const { rss, runtimes, frames, replies } = message
      this.remote = { rss, runtimes, frames, replies }
      if (rss > 384 * 1024 * 1024) this.stop("MODS_HOST_MEMORY")
      return
    }
    if (message.type === "revoke") {
      const call = this.calls.get(message.id)
      if (call?.requestId === message.requestId) {
        call.controller.abort(new ModFunctionError("MODS_INVOCATION_ENDED"))
        this.calls.delete(message.id)
      }
      return
    }
    if (message.type === "call") {
      const pending = this.pending.get(message.requestId)
      const child = this.child
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
      this.calls.set(message.id, { requestId: message.requestId, controller })
      const signal = AbortSignal.any([controller.signal, pending.controller.signal])
      void Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          const args = parseModJson(encodeModJson(message.args)) as ModJson
          return pending.host!(message.method, args, signal)
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
    if (message.type === "error") pending.reject(fromWireError(message.error))
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
    timeout = 10000
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
        runtimeId: data.runtimeId,
        host,
        resolve,
        reject,
        controller,
        expiresAt: Date.now() + timeout,
        detach: () => signal?.removeEventListener("abort", cancel)
      })
      signal?.addEventListener("abort", cancel, { once: true })
      this.child!.postMessage({ ...data, id })
    })
  }

  async load(code: string, options: ModObject = {}): Promise<FunctionGuest> {
    const runtimeId = randomUUID()
    const registrations = (await this.request({
      type: "load",
      runtimeId,
      code,
      options
    })) as unknown as FunctionRegistration[]
    const generation = this.generation
    let disposed = false
    const isDisposed = (): boolean => disposed || generation !== this.generation
    const request = this.request.bind(this)
    const assertLive = (): void => {
      if (disposed || generation !== this.generation) throw new ModFunctionError("MODS_UNLOADED")
    }
    return {
      registrations,
      get stats() {
        return { disposed: isDisposed() }
      },
      async matches(registration, event) {
        assertLive()
        return (await request({ type: "match", runtimeId, registration, event })) === true
      },
      async invoke(registration, event, host, invocation: FunctionInvocation) {
        assertLive()
        const { signal, ...metadata } = invocation
        return (await request(
          { type: "invoke", runtimeId, registration, event, metadata },
          host,
          signal,
          Math.min(metadata.timeoutMs ?? 5000, 120000) + 3000
        )) as { value?: ModJson; absent?: boolean }
      },
      async dispose() {
        if (isDisposed()) return
        disposed = true
        await request({ type: "dispose", runtimeId })
      }
    }
  }

  stop(code = "MODS_HOST_STOPPED"): void {
    const child = this.child
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
    this.calls.clear()
    this.pending.clear()
    child?.kill()
  }
}
