import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { utilityProcess, type UtilityProcess } from "electron"
import type {
  ModJson,
  ModObject,
  ModRegistration,
  ModRuntimeRequest,
  ModRuntimeResponse
} from "../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import type { ModHostCall } from "./guest-runtime"
import { ModError } from "./errors"

interface PendingRequest {
  runtimeId: string
  resolve(value: ModJson): void
  reject(error: Error): void
  hostCall?: ModHostCall
  disposeSignal?: () => void
}

export class ModRuntimeClient {
  private child: UtilityProcess | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private ready: Promise<void> | null = null
  private rejectReady?: (error: Error) => void
  private heartbeatAt = 0
  private timer?: ReturnType<typeof setInterval>
  private generation = 0
  private rssBytes = 0

  constructor(private readonly entry = join(__dirname, "mod-host.js")) {}

  get version(): number {
    return this.generation
  }

  get stats(): { rssBytes: number; pending: number; generation: number } {
    return { rssBytes: this.rssBytes, pending: this.pending.size, generation: this.generation }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const env: Record<string, string> = {}
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]) {
      if (process.env[key]) env[key] = process.env[key]!
    }
    this.heartbeatAt = Date.now() + 8000
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      const child = utilityProcess.fork(this.entry, [], {
        env,
        stdio: "pipe",
        serviceName: "CMB Mods"
      })
      this.child = child
      child.stdout?.resume()
      child.stderr?.resume()
      child.on("message", (message: ModRuntimeResponse) => {
        if (this.child !== child) return
        if (message.type === "ready") {
          this.heartbeatAt = Date.now()
          this.rejectReady = undefined
          resolve()
        } else {
          this.onMessage(message)
        }
      })
      child.on("exit", () => {
        if (this.child === child) this.stop("MODS_HOST_EXITED")
      })
      child.on("error", () => this.stop("MODS_HOST_ERROR"))
    })
    this.timer = setInterval(() => {
      if (Date.now() - this.heartbeatAt > 2000) this.stop("MODS_HOST_UNRESPONSIVE")
    }, 250)
    this.timer.unref()
    return this.ready
  }

  private onMessage(message: ModRuntimeResponse): void {
    if (message.type === "heartbeat") {
      this.heartbeatAt = Date.now()
      const rss = (message.value as { rss?: unknown } | undefined)?.rss
      if (typeof rss === "number") this.rssBytes = rss
      if (typeof rss === "number" && rss > 384 * 1024 * 1024) this.stop("MODS_HOST_MEMORY")
      return
    }
    if (message.type === "call") {
      const pending = this.pending.get(message.requestId ?? "")
      if (!pending?.hostCall || pending.runtimeId !== message.runtimeId || !message.id) {
        this.child?.postMessage({
          type: "reply",
          id: message.id,
          runtimeId: message.runtimeId,
          error: "MODS_STALE_CALL"
        })
        return
      }
      const child = this.child
      Promise.resolve()
        .then(async () => {
          const value = parseModJson(encodeModJson(message.value ?? null)) as ModJson
          return pending.hostCall!(message.method ?? "", value)
        })
        .then(
          (value) => {
            if (child && this.child === child)
              child.postMessage({
                type: "reply",
                id: message.id,
                runtimeId: message.runtimeId,
                value
              })
          },
          () => {
            if (child && this.child === child)
              child.postMessage({
                type: "reply",
                id: message.id,
                runtimeId: message.runtimeId,
                error: "MODS_CAPABILITY_REJECTED"
              })
          }
        )
      return
    }
    const pending = this.pending.get(message.id ?? "")
    if (!pending || pending.runtimeId !== message.runtimeId) return
    this.pending.delete(message.id!)
    pending.disposeSignal?.()
    if (message.type === "error") pending.reject(new ModError(message.error ?? "MODS_GUEST_ERROR"))
    else {
      try {
        pending.resolve(parseModJson(encodeModJson(message.value ?? null)) as ModJson)
      } catch {
        pending.reject(new ModError("MODS_INVALID_GUEST_RESULT"))
      }
    }
  }

  private async request(
    data: Omit<ModRuntimeRequest, "id">,
    hostCall?: ModHostCall,
    signal?: AbortSignal
  ): Promise<ModJson> {
    if (signal?.aborted) throw new ModError("MODS_CANCELLED")
    await this.start()
    if (signal?.aborted) throw new ModError("MODS_CANCELLED")
    if (this.pending.size >= 64) throw new ModError("MODS_HOST_CAPACITY")
    const id = randomUUID()
    return new Promise<ModJson>((resolve, reject) => {
      const cancel = (): void => {
        this.child?.postMessage({ type: "cancel", id, runtimeId: data.runtimeId })
      }
      signal?.addEventListener("abort", cancel, { once: true })
      this.pending.set(id, {
        runtimeId: data.runtimeId,
        resolve,
        reject,
        hostCall,
        disposeSignal: () => signal?.removeEventListener("abort", cancel)
      })
      this.child!.postMessage({ ...data, id })
    })
  }

  async load(runtimeId: string, code: string): Promise<ModRegistration[]> {
    return (await this.request({ type: "load", runtimeId, code })) as unknown as ModRegistration[]
  }

  invoke(
    runtimeId: string,
    registration: string,
    event: ModObject,
    call: ModHostCall,
    signal?: AbortSignal
  ): Promise<ModJson> {
    return this.request({ type: "invoke", runtimeId, registration, event }, call, signal)
  }

  async unload(runtimeId: string): Promise<void> {
    if (!this.child) return
    await this.request({ type: "dispose", runtimeId })
  }

  stop(code = "MODS_HOST_STOPPED"): void {
    const child = this.child
    this.child = null
    this.ready = null
    this.generation++
    clearInterval(this.timer)
    const error = new ModError(code)
    this.rejectReady?.(error)
    this.rejectReady = undefined
    for (const pending of this.pending.values()) {
      pending.disposeSignal?.()
      pending.reject(error)
    }
    this.pending.clear()
    child?.kill()
  }
}
