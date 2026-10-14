import { app, BrowserWindow, session } from "electron"
import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FUNCTION_AUDIO_RENDERER } from "./audio-renderer"

export interface FunctionAudioContext {
  readonly signal: AbortSignal
  assertLive(): void
}

export interface FunctionAudioOperation<T> {
  readonly started: Promise<void>
  readonly done: Promise<T>
  stop(): Promise<void>
}

export interface FunctionAudioClip {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly gain?: number
  readonly shouldLoop?: boolean
}

export type FunctionAudioPlayEnd = "ended" | "stopped"
export interface FunctionAudioSpeakEnd { readonly via: "system" }

function failure(code: string): ModFunctionError { return new ModFunctionError(code) }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

type Deferred<T> = ReturnType<typeof deferred<T>>
type Entry = {
  id: number
  kind: "clip" | "speech"
  context: FunctionAudioContext
  clip?: { bytes: Buffer; mime: string; gain: number; shouldLoop: boolean }
  speech?: { text: string; voice?: string }
  started: Deferred<void>
  done: Deferred<FunctionAudioPlayEnd | FunctionAudioSpeakEnd>
  cleaned: Deferred<void>
  stopRequested: boolean
  hasError: boolean
  error?: unknown
  detach(): void
  record?: WindowRecord
  usedRenderer: boolean
  work?: Promise<void>
  stopRpc?: Promise<void>
  finishing?: Promise<void>
}
type WindowRecord = {
  generation: number
  window?: BrowserWindow
  ready: Promise<void>
  lost: Deferred<never>
  retired: boolean
}
type Reply = { ok: boolean; value?: Record<string, unknown>; code?: string }

/** Main-only media service. Callers retain the original runtime checks and resource owner. */
export class FunctionAudioBackend {
  private readonly entries = new Map<number, Entry>()
  private readonly speechQueue: Entry[] = []
  private activeSpeech?: Entry
  private record?: WindowRecord
  private generation = 0
  private sequence = 0
  private encodedBytes = 0
  private networkAttempts = 0
  private closed = false
  private closing?: Promise<void>
  private idleClosing?: Promise<void>
  private cleanupFailed = false
  private cleanupError?: unknown
  private readonly onQuit = () => { void this.close().catch(() => {}) }

  constructor() { app.on("before-quit", this.onQuit) }

  play(input: FunctionAudioClip, context: FunctionAudioContext): FunctionAudioOperation<FunctionAudioPlayEnd> {
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > 4 * 1024 * 1024)
      throw failure("MODS_AUDIO_BYTES_LIMIT")
    if (typeof input.mime !== "string" || !/^audio\/[a-z0-9.+-]{1,80}$/i.test(input.mime))
      throw failure("MODS_AUDIO_MIME")
    const gain = input.gain ?? 1
    if (typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 4 ||
      (input.shouldLoop !== undefined && typeof input.shouldLoop !== "boolean"))
      throw failure("MODS_AUDIO_ARGUMENTS")
    if ([...this.entries.values()].filter(entry => entry.kind === "clip").length >= 8 ||
      this.encodedBytes + input.bytes.byteLength > 16 * 1024 * 1024)
      throw failure("MODS_AUDIO_RESOURCE_LIMIT")
    const entry = this.create("clip", context)
    entry.clip = { bytes: Buffer.from(input.bytes), mime: input.mime, gain, shouldLoop: input.shouldLoop ?? false }
    this.encodedBytes += entry.clip.bytes.length
    entry.work = this.runClip(entry)
    void entry.work.catch(() => {})
    const done = entry.done.promise.then(value => {
      if (value !== "ended" && value !== "stopped") throw failure("MODS_AUDIO_RESULT")
      return value
    })
    void done.catch(() => {})
    return {
      started: entry.started.promise,
      done,
      stop: () => this.stop(entry)
    }
  }

  speak(input: { text: string; voice?: string }, context: FunctionAudioContext): FunctionAudioOperation<FunctionAudioSpeakEnd> {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4096 ||
      (input.voice !== undefined && (typeof input.voice !== "string" || !input.voice || input.voice.length > 256)))
      throw failure("MODS_AUDIO_SPEECH_ARGUMENTS")
    if ([...this.entries.values()].filter(entry => entry.kind === "speech").length >= 32)
      throw failure("MODS_AUDIO_RESOURCE_LIMIT")
    const entry = this.create("speech", context)
    entry.speech = { text: input.text, ...(input.voice === undefined ? {} : { voice: input.voice }) }
    this.speechQueue.push(entry)
    this.pumpSpeech()
    const done = entry.done.promise.then(value => {
      if (typeof value !== "object" || value.via !== "system") throw failure("MODS_AUDIO_RESULT")
      return value
    })
    void done.catch(() => {})
    return {
      started: entry.started.promise,
      done,
      stop: () => this.stop(entry)
    }
  }

  get stats() {
    return { operations: this.entries.size, encodedBytes: this.encodedBytes,
      networkAttempts: this.networkAttempts,
      queuedSpeech: this.speechQueue.length, activeSpeech: !!this.activeSpeech,
      window: !!this.record?.window && !this.record.window.isDestroyed(),
      opening: !!this.record && !this.record.window, cleaning: !!this.idleClosing, closed: this.closed }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(entry => {
        this.setError(entry, failure("MODS_AUDIO_CLOSED"))
        return this.stop(entry)
      }))
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      try { await this.maybeIdle() } catch (error) { errors.push(error) }
      if (this.cleanupFailed) errors.push(this.cleanupError)
      app.removeListener("before-quit", this.onQuit)
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "MODS_AUDIO_CLEANUP_FAILED", { cause: errors[0] })
    })()
    void this.closing.catch(() => {})
    return this.closing
  }

  private create(kind: Entry["kind"], context: FunctionAudioContext): Entry {
    if (this.closed) throw failure("MODS_AUDIO_CLOSED")
    context.signal.throwIfAborted()
    context.assertLive()
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw failure("MODS_AUDIO_RESOURCE_LIMIT")
    const entry: Entry = { id: ++this.sequence, kind, context, started: deferred(), done: deferred(),
      cleaned: deferred(), stopRequested: false, hasError: false, usedRenderer: false, detach: () => {} }
    const abort = () => {
      this.setError(entry, context.signal.reason)
      void this.stop(entry).catch(() => {})
    }
    entry.detach = () => context.signal.removeEventListener("abort", abort)
    this.entries.set(entry.id, entry)
    context.signal.addEventListener("abort", abort, { once: true })
    return entry
  }

  private setError(entry: Entry, error: unknown): void {
    if (entry.hasError) return
    entry.hasError = true
    entry.error = error
  }

  private check(entry: Entry): boolean {
    entry.context.signal.throwIfAborted()
    entry.context.assertLive()
    if (this.closed) throw failure("MODS_AUDIO_CLOSED")
    return !entry.stopRequested
  }

  private async runClip(entry: Entry): Promise<void> {
    let terminal: FunctionAudioPlayEnd = "stopped"
    try {
      if (this.check(entry)) {
        const record = await this.ensureWindow()
        entry.record = record
        if (this.check(entry)) {
          entry.usedRenderer = true
          const clip = entry.clip!
          const prepared = await this.rpc(record, "prepareClip", { id: entry.id,
            base64: clip.bytes.toString("base64"), mime: clip.mime, gain: clip.gain,
            shouldLoop: clip.shouldLoop }, 10000)
          if (this.check(entry) && prepared.stopped !== true) {
            const ack = await this.rpc(record, "startClip", { id: entry.id }, 10000)
            if (this.check(entry) && ack.started === true) {
              entry.started.resolve()
              const result = await this.rpc(record, "wait", { id: entry.id })
              entry.context.signal.throwIfAborted()
              entry.context.assertLive()
              if (result.kind !== "ended" && result.kind !== "stopped") throw failure("MODS_AUDIO_RESULT")
              terminal = result.kind
            } else if (!entry.stopRequested) throw failure("MODS_AUDIO_START_UNCONFIRMED")
          }
        }
      }
    } catch (error) { this.setError(entry, error) }
    await this.finish(entry, terminal)
  }

  private pumpSpeech(): void {
    if (this.activeSpeech) return
    const entry = this.speechQueue.shift()
    if (!entry) return
    this.activeSpeech = entry
    entry.work = this.runSpeech(entry)
    void entry.work.finally(() => {
      if (this.activeSpeech === entry) this.activeSpeech = undefined
      this.pumpSpeech()
    }).catch(() => {})
  }

  private async runSpeech(entry: Entry): Promise<void> {
    try {
      if (this.check(entry)) {
        const record = await this.ensureWindow()
        entry.record = record
        if (this.check(entry)) {
          entry.usedRenderer = true
          const prepared = await this.rpc(record, "prepareSpeech", { id: entry.id, ...entry.speech }, 10000)
          if (this.check(entry) && prepared.stopped !== true) {
            const ack = await this.rpc(record, "startSpeech", { id: entry.id }, 10000)
            if (this.check(entry) && ack.started === true) {
              entry.started.resolve()
              const result = await this.rpc(record, "wait", { id: entry.id })
              entry.context.signal.throwIfAborted()
              entry.context.assertLive()
              if (result.kind !== "ended") throw failure(result.kind === "stopped" ? "MODS_AUDIO_STOPPED" : "MODS_AUDIO_SPEECH_FAILED")
            } else if (!entry.stopRequested) throw failure("MODS_AUDIO_START_UNCONFIRMED")
          }
        }
      }
      if (entry.stopRequested) this.setError(entry, failure("MODS_AUDIO_STOPPED"))
    } catch (error) { this.setError(entry, error) }
    await this.finish(entry, { via: "system" })
  }

  private stop(entry: Entry): Promise<void> {
    if (entry.finishing) return entry.cleaned.promise
    entry.stopRequested = true
    if (entry.usedRenderer) {
      void this.stopRenderer(entry).catch(error => {
        this.setError(entry, error)
        if (entry.record) this.failWindow(entry.record, error)
      })
    }
    if (!entry.work) {
      const index = this.speechQueue.indexOf(entry)
      if (index >= 0) this.speechQueue.splice(index, 1)
      this.setError(entry, failure("MODS_AUDIO_STOPPED"))
      void this.finish(entry, { via: "system" }).catch(() => {})
    }
    return entry.cleaned.promise
  }

  private stopRenderer(entry: Entry): Promise<void> {
    entry.stopRpc ??= (async () => {
      const result = await this.rpc(entry.record!, "stop", { id: entry.id }, 5000)
      if (result.stopped !== true) throw failure("MODS_AUDIO_STOP_UNCONFIRMED")
    })()
    void entry.stopRpc.catch(() => {})
    return entry.stopRpc
  }

  private finish(entry: Entry, result: FunctionAudioPlayEnd | FunctionAudioSpeakEnd): Promise<void> {
    if (entry.finishing) return entry.finishing
    entry.finishing = (async () => {
      let cleanupError: unknown
      let cleanupFailed = false
      try {
        if (entry.usedRenderer) {
          await this.stopRenderer(entry)
          const ack = await this.rpc(entry.record!, "forget", { id: entry.id }, 5000)
          if (ack.forgotten !== true) throw failure("MODS_AUDIO_STOP_UNCONFIRMED")
        }
      } catch (error) {
        cleanupFailed = true
        cleanupError = error
        this.setError(entry, error)
        if (entry.record) this.failWindow(entry.record, error)
      }
      entry.detach()
      this.entries.delete(entry.id)
      if (entry.clip) this.encodedBytes -= entry.clip.bytes.length
      entry.clip = undefined
      entry.speech = undefined
      try { await this.maybeIdle() } catch (error) {
        if (!cleanupFailed) cleanupError = error
        cleanupFailed = true
        this.setError(entry, error)
      }
      if (!entry.hasError) {
        try {
          entry.context.signal.throwIfAborted()
          entry.context.assertLive()
          if (this.closed) throw failure("MODS_AUDIO_CLOSED")
        } catch (error) { this.setError(entry, error) }
      }
      entry.started.reject(entry.hasError ? entry.error : failure("MODS_AUDIO_STOPPED"))
      if (entry.hasError) entry.done.reject(entry.error)
      else entry.done.resolve(result)
      if (cleanupFailed) entry.cleaned.reject(cleanupError)
      else entry.cleaned.resolve()
    })()
    void entry.finishing.catch(() => {})
    return entry.finishing
  }

  private async ensureWindow(): Promise<WindowRecord> {
    if (this.idleClosing) await this.idleClosing
    if (this.closed) throw failure("MODS_AUDIO_CLOSED")
    if (!this.record) {
      const record: WindowRecord = { generation: ++this.generation, ready: Promise.resolve(), lost: deferred(), retired: false }
      this.record = record
      record.ready = (async () => {
        await this.bounded(app.whenReady(), 10000)
        if (this.closed || record.retired || this.record !== record) throw failure("MODS_AUDIO_CLOSED")
        const partition = session.fromPartition("mods-audio-" + randomUUID())
        partition.setPermissionRequestHandler((_sender, _permission, callback) => callback(false))
        partition.setPermissionCheckHandler(() => false)
        partition.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*", "file://*/*"] },
          (_details, callback) => { this.networkAttempts++; callback({ cancel: true }) })
        partition.on("will-download", event => event.preventDefault())
        const window = new BrowserWindow({ show: false, width: 200, height: 100,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
            backgroundThrottling: false, spellcheck: false, session: partition } })
        record.window = window
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
        window.webContents.on("will-navigate", event => event.preventDefault())
        window.webContents.on("render-process-gone", () => this.failWindow(record, failure("MODS_AUDIO_BACKEND_LOST")))
        window.webContents.on("destroyed", () => this.failWindow(record, failure("MODS_AUDIO_BACKEND_LOST")))
        window.once("closed", () => this.failWindow(record, failure("MODS_AUDIO_BACKEND_LOST")))
        await this.bounded(window.loadURL("about:blank"), 10000)
        const reply: unknown = await this.bounded(window.webContents.executeJavaScript(FUNCTION_AUDIO_RENDERER), 10000)
        if (!reply || typeof reply !== "object" || !("ready" in reply) || reply.ready !== true ||
          !("nodeExposed" in reply) || reply.nodeExposed !== false)
          throw failure("MODS_AUDIO_BACKEND_INVALID")
        if (record.retired || this.record !== record) throw failure("MODS_AUDIO_BACKEND_LOST")
      })()
      void record.ready.catch(error => this.failWindow(record, error))
    }
    const record = this.record
    await record.ready
    if (record.retired || this.record !== record) throw failure("MODS_AUDIO_BACKEND_LOST")
    return record
  }

  private async bounded<T>(actual: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([actual, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure("MODS_AUDIO_BACKEND_TIMEOUT")), ms)
        timer.unref()
      })])
    } finally { if (timer) clearTimeout(timer) }
  }

  private async rpc(record: WindowRecord, method: string, input: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (record.retired || this.record !== record || !record.window || record.window.isDestroyed())
      throw failure("MODS_AUDIO_BACKEND_LOST")
    const actual: Promise<unknown> = record.window.webContents.executeJavaScript(
      "globalThis.__modsAudioRenderer.call(" + JSON.stringify(method) + "," + JSON.stringify(input) + ")")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const pending = Promise.race([actual, record.lost.promise])
      const value: unknown = await (timeoutMs === undefined ? pending : Promise.race([pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(failure("MODS_AUDIO_BACKEND_TIMEOUT")), timeoutMs)
          timer.unref()
        })]))
      if (record.retired || this.record !== record) throw failure("MODS_AUDIO_BACKEND_LOST")
      if (!value || typeof value !== "object") throw failure("MODS_AUDIO_BACKEND_INVALID")
      const reply = value as Reply
      if (reply.ok !== true) throw failure(typeof reply.code === "string" && /^MODS_AUDIO_[A-Z_]+$/.test(reply.code)
        ? reply.code : "MODS_AUDIO_BACKEND_INVALID")
      if (!reply.value || typeof reply.value !== "object" || Array.isArray(reply.value))
        throw failure("MODS_AUDIO_BACKEND_INVALID")
      return reply.value
    } finally { if (timer) clearTimeout(timer) }
  }

  private failWindow(record: WindowRecord, error: unknown): void {
    if (record.retired) return
    record.retired = true
    record.lost.reject(error)
    if (this.record === record) this.record = undefined
    for (const entry of [...this.entries.values()]) {
      if (entry.record && entry.record !== record) continue
      this.setError(entry, error)
      void this.stop(entry).catch(() => {})
    }
    try { this.destroy(record) } catch { /* Latched for close(); new work is disabled. */ }
  }

  private destroy(record: WindowRecord): void {
    try {
      if (record.window && !record.window.isDestroyed()) record.window.destroy()
    } catch (error) {
      if (!this.cleanupFailed) this.cleanupError = error
      this.cleanupFailed = true
      this.closed = true
      this.record = record
      throw error
    }
  }

  private maybeIdle(): Promise<void> {
    if (this.idleClosing) return this.idleClosing
    if (this.entries.size || !this.record) return Promise.resolve()
    const record = this.record
    this.idleClosing = (async () => {
      const errors: unknown[] = []
      try {
        await record.ready
        const ack = await this.rpc(record, "close", {}, 5000)
        if (ack.closed !== true) throw failure("MODS_AUDIO_STOP_UNCONFIRMED")
      } catch (error) { errors.push(error) }
      record.retired = true
      record.lost.reject(failure("MODS_AUDIO_BACKEND_IDLE"))
      if (this.record === record) this.record = undefined
      try { this.destroy(record) } catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "MODS_AUDIO_CLEANUP_FAILED", { cause: errors[0] })
    })().finally(() => { this.idleClosing = undefined })
    void this.idleClosing.catch(() => {})
    return this.idleClosing
  }
}
