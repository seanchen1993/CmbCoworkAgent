import { randomUUID } from "node:crypto"
import { TextDecoder } from "node:util"
import type { Readable, Writable } from "node:stream"
import {
  BOT_NATIVE_DESKTOP_PROTOCOL,
  BOT_NATIVE_DESKTOP_INPUT_BYTES,
  BOT_NATIVE_DESKTOP_OUTPUT_BYTES,
  nativeDesktopReady,
  nativeDesktopRequest,
  nativeDesktopResult,
  type NativeDesktopReady,
  type NativeDesktopScope,
  type NativeDesktopWindow,
  type NativeDesktopOperation,
  type NativeDesktopResult
} from "../../shared/bot-native-desktop"
import { canonicalJson } from "./validation"

/** Only a trusted native Job launcher constructs this port. No renderer/tool may
 * supply an executable, Job identity, stream, or closure callback. */
export interface NativeDesktopProcessLease {
  /** Exact roots of this surface's verified restricted launch policy. */
  policy: { readRoots: readonly string[]; writeRoots: readonly string[] }
  identity: {
    nonce: string
    jobName: string
    bootId: string
    sessionId: number
    workerPid: number
    desktop: string
    hostId: string
    dataEpoch: string
  }
  stdin: Writable
  stdout: Readable
  exited: Promise<{ code: number | null; signal: string | null }>
  assertCurrent(): void
  verifyMember(pid: number): Promise<void>
  stop(): void
  /** Must await/verify the actual owned Job kernel-empty proof. A PID exit,
   * worker reply, IPC EOF, or timeout must never resolve this promise. */
  awaitKernelClosure(): Promise<void>
}

/** Trusted launch port creates this only before calling the native resource
 * start. A remote error message or worker rejection cannot recreate this class. */
export class NativeDesktopNoAllocationError extends Error {
  constructor(cause: unknown) {
    super("原生电脑准备失败，尚未分配系统资源", { cause })
    this.name = "NativeDesktopNoAllocationError"
  }
}

export class NativeDesktopDispatchError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "not-dispatched" | "unknown",
    message: string
  ) {
    super(message)
    this.name = "NativeDesktopDispatchError"
  }
}

/** Fixed bounded allocation per partial frame; fragmentation never repeatedly
 * concatenates the growing PNG/JSON payload. Exactly one message reaches JSON. */
export class NativeDesktopFrameDecoder {
  private header = Buffer.allocUnsafe(4)
  private headerBytes = 0
  private body?: Buffer
  private bodyBytes = 0
  private failed = false
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true })
  constructor(
    private readonly receive: (value: unknown) => void,
    private readonly limit = BOT_NATIVE_DESKTOP_OUTPUT_BYTES
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BOT_NATIVE_DESKTOP_OUTPUT_BYTES)
      throw new Error("Invalid native desktop frame limit")
  }
  feed(chunk: Buffer): void {
    if (this.failed) throw new Error("Native desktop decoder is closed")
    let position = 0
    try {
      while (position < chunk.length) {
        if (!this.body) {
          const length = Math.min(4 - this.headerBytes, chunk.length - position)
          chunk.copy(this.header, this.headerBytes, position, position + length)
          this.headerBytes += length
          position += length
          if (this.headerBytes !== 4) continue
          const size = this.header.readUInt32BE(0)
          if (!size || size > this.limit) throw new Error("Native desktop frame exceeds bound")
          this.headerBytes = 0
          this.body = Buffer.allocUnsafe(size)
          this.bodyBytes = 0
        }
        const length = Math.min(this.body.length - this.bodyBytes, chunk.length - position)
        chunk.copy(this.body, this.bodyBytes, position, position + length)
        this.bodyBytes += length
        position += length
        if (this.bodyBytes !== this.body.length) continue
        const body = this.body
        this.body = undefined
        this.bodyBytes = 0
        this.receive(JSON.parse(this.utf8.decode(body)))
      }
    } catch (error) {
      this.failed = true
      this.body = undefined
      throw error
    }
  }
  end(): void {
    if (this.headerBytes || this.body) throw new Error("Native desktop frame was truncated")
  }
}

/** One live command per worker. Unknown mutation outcomes permanently fence the
 * transport and stop its owned Job; no request is replayed or silently retried. */
export class NativeDesktopTransport {
  readonly ready: Promise<NativeDesktopReady>
  private resolveReady!: (value: NativeDesktopReady) => void
  private rejectReady!: (error: unknown) => void
  private readyValue?: NativeDesktopReady
  private readyTimer?: ReturnType<typeof setTimeout>
  private sequence = 0
  private failure?: unknown
  private closing?: Promise<void>
  private pending?: {
    id: string
    sequence: number
    scope: NativeDesktopScope
    requestScope: NativeDesktopScope
    dispatched: boolean
    resolve(value: NativeDesktopResult): void
    reject(error: unknown): void
    timer: ReturnType<typeof setTimeout>
    dispose(): void
  }
  private readonly decoder = new NativeDesktopFrameDecoder((raw) => this.receive(raw))
  constructor(readonly lease: NativeDesktopProcessLease) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => {})
    this.readyTimer = setTimeout(
      () => this.fail(new Error("Native desktop startup timed out")),
      10_000
    )
    this.readyTimer.unref()
    lease.stdout.on("data", this.data)
    lease.stdout.once("end", this.end)
    lease.stdout.on("error", this.streamError)
    lease.stdin.on("error", this.streamError)
    void lease.exited.then(
      () => this.fail(new Error("Native desktop worker exited")),
      (error) => this.fail(error)
    )
  }
  private readonly data = (bytes: Buffer) => {
    try {
      this.decoder.feed(bytes)
    } catch (error) {
      this.fail(error)
    }
  }
  private readonly end = () => {
    try {
      this.decoder.end()
    } catch (error) {
      this.fail(error)
      return
    }
    this.fail(new Error("Native desktop transport ended"))
  }
  private readonly streamError = (error: unknown) => this.fail(error)
  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = error
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.rejectReady(error)
    if (this.pending) {
      const current = this.pending
      this.pending = undefined
      clearTimeout(current.timer)
      current.dispose()
      current.reject(
        new NativeDesktopDispatchError(
          "native_desktop_unconfirmed",
          current.dispatched ? "unknown" : "not-dispatched",
          "原生电脑连接中断，操作结果需核对"
        )
      )
    }
    try {
      this.lease.stop()
    } catch (stopError) {
      this.failure = new AggregateError(
        [error, stopError],
        "Native desktop shutdown request failed"
      )
    }
  }
  private receive(raw: unknown): void {
    if (this.failure) throw new Error("Native desktop transport is fenced")
    if (!this.readyValue) {
      const value = nativeDesktopReady.parse(raw)
      const identity = this.lease.identity
      if (
        value.nonce !== identity.nonce ||
        value.worker.pid !== identity.workerPid ||
        value.worker.sessionId !== identity.sessionId ||
        value.worker.desktop !== identity.desktop
      )
        throw new Error("Native desktop worker identity differs")
      this.readyValue = value
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.resolveReady(value)
      return
    }
    const value = nativeDesktopResult.parse(raw)
    const current = this.pending
    const scopeMatches =
      current &&
      (value.status === "ok"
        ? vScope(value.scope, current.scope)
        : value.status === "rejected"
          ? vScope(value.scope, current.requestScope)
          : vScope(value.scope, current.scope) || vScope(value.scope, current.requestScope))
    if (
      !current ||
      !scopeMatches ||
      value.id !== current.id ||
      value.sequence !== current.sequence ||
      value.nonce !== this.lease.identity.nonce
    )
      throw new Error("Native desktop response differs from its exact outstanding request")
    this.pending = undefined
    clearTimeout(current.timer)
    current.dispose()
    if (value.status === "unknown") {
      current.reject(
        new NativeDesktopDispatchError(
          value.code ?? "native_desktop_unconfirmed",
          "unknown",
          "原生电脑操作结果需核对，不能自动重试"
        )
      )
      this.fail(new Error("Native desktop mutation outcome is unknown"))
    } else if (value.status === "rejected") {
      current.reject(
        new NativeDesktopDispatchError(
          value.code ?? "native_desktop_rejected",
          "not-dispatched",
          "原生电脑拒绝了本次操作"
        )
      )
    } else current.resolve(value)
  }
  async request(input: {
    scope: NativeDesktopScope
    responseScope?: NativeDesktopScope
    operation: NativeDesktopOperation
    window?: NativeDesktopWindow
    params?: Record<string, unknown>
    signal?: AbortSignal
    authorize(): void
    timeoutMs?: number
  }): Promise<unknown> {
    await this.ready
    if (this.failure || this.closing)
      throw new NativeDesktopDispatchError(
        "native_desktop_closed",
        "not-dispatched",
        "原生电脑连接已关闭"
      )
    if (this.pending)
      throw new NativeDesktopDispatchError(
        "native_desktop_busy",
        "not-dispatched",
        "原生电脑已有操作正在执行"
      )
    input.signal?.throwIfAborted()
    this.lease.assertCurrent()
    input.authorize()
    if (
      input.scope.hostId !== this.lease.identity.hostId ||
      input.scope.dataEpoch !== this.lease.identity.dataEpoch
    )
      throw new Error("Native desktop Host ownership differs")
    const request = nativeDesktopRequest.parse({
      type: "request",
      protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
      version: 1,
      id: randomUUID(),
      sequence: this.sequence + 1,
      nonce: this.lease.identity.nonce,
      scope: input.scope,
      operation: input.operation,
      params: input.params ?? {},
      ...(input.window ? { window: input.window } : {})
    })
    const data = Buffer.from(JSON.stringify(request), "utf8")
    if (data.length > BOT_NATIVE_DESKTOP_INPUT_BYTES)
      throw new Error("Native desktop request exceeds bound")
    const frame = Buffer.allocUnsafe(data.length + 4)
    frame.writeUInt32BE(data.length)
    data.copy(frame, 4)
    const timeout = input.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000)
      throw new Error("Invalid native desktop request deadline")
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.fail(input.signal?.reason ?? new Error("Native desktop request cancelled"))
      const current = {
        id: request.id,
        sequence: request.sequence,
        scope: input.responseScope ?? request.scope,
        requestScope: request.scope,
        dispatched: false,
        resolve: (value: NativeDesktopResult) => {
          try {
            this.lease.assertCurrent()
            input.signal?.throwIfAborted()
            resolve(value.result)
          } catch (error) {
            reject(error)
          }
        },
        reject,
        timer: setTimeout(
          () => this.fail(new Error("Native desktop operation timed out")),
          timeout
        ),
        dispose: () => input.signal?.removeEventListener("abort", abort)
      }
      current.timer.unref()
      this.pending = current
      input.signal?.addEventListener("abort", abort, { once: true })
      try {
        input.signal?.throwIfAborted()
        this.lease.assertCurrent()
        input.authorize()
        // No asynchronous work between the last durable authorization/fence
        // check and the actual pipe write. After this point outcome may be unknown.
        this.sequence = request.sequence
        current.dispatched = true
        this.lease.stdin.write(frame, (error) => {
          if (error) this.fail(error)
        })
      } catch (error) {
        this.pending = undefined
        clearTimeout(current.timer)
        current.dispose()
        if (current.dispatched) {
          this.fail(error)
          reject(
            new NativeDesktopDispatchError(
              "native_desktop_unconfirmed",
              "unknown",
              "原生电脑操作结果需核对"
            )
          )
        } else reject(error)
      }
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.fail(new Error("Native desktop is closing"))
    this.closing = this.lease.awaitKernelClosure().then(() => {
      this.lease.stdout.removeListener("data", this.data)
      this.lease.stdout.removeListener("end", this.end)
      this.lease.stdout.removeListener("error", this.streamError)
      this.lease.stdin.removeListener("error", this.streamError)
    })
    void this.closing.catch(() => {})
    return this.closing
  }
}

function vScope(left: NativeDesktopScope, right: NativeDesktopScope): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
