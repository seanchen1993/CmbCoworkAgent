import type { ResourceLimits, Worker } from "node:worker_threads"
import {
  DASHBOARD_ES_INPUT_BYTE_LIMIT,
  DASHBOARD_ES_OUTPUT_BYTE_LIMIT,
  DASHBOARD_ES_REQUEST_CANCELLED,
  type DashboardEsProjection,
  type DashboardEsWorkerResponse
} from "./dashboard-es-protocol"

type WorkerFactory = () => Promise<Worker>

export const DASHBOARD_ES_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
}
export const DASHBOARD_ES_MAX_ACTIVE_REQUESTS = 8
export const DASHBOARD_ES_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024

interface PendingRequest {
  resolve: (value: DashboardEsWorkerResult) => void
  reject: (error: Error) => void
  cancellation: Int32Array
  signal?: AbortSignal
  abortListener?: () => void
}

export class DashboardEsWorkerUnavailableError extends Error {
  readonly code = "DASHBOARD_ES_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DashboardEsWorkerUnavailableError"
  }
}

export class DashboardEsRequestCancelledError extends Error {
  readonly code = DASHBOARD_ES_REQUEST_CANCELLED

  constructor(message = "Dashboard request was cancelled") {
    super(message)
    this.name = "DashboardEsRequestCancelledError"
  }
}

export function isDashboardEsWorkerUnavailable(
  error: unknown
): error is DashboardEsWorkerUnavailableError {
  return error instanceof DashboardEsWorkerUnavailableError
}

export function isDashboardEsRequestCancelled(error: unknown): boolean {
  return (
    error instanceof DashboardEsRequestCancelledError ||
    (error instanceof Error &&
      (error.name === DASHBOARD_ES_REQUEST_CANCELLED ||
        ("code" in error && error.code === DASHBOARD_ES_REQUEST_CANCELLED)))
  )
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./dashboard-es-worker?nodeWorker")
    return module.default({
      name: "dashboard-es",
      resourceLimits: DASHBOARD_ES_WORKER_RESOURCE_LIMITS
    })
  } catch (error) {
    throw new DashboardEsWorkerUnavailableError("Unable to start the bundled Dashboard ES worker", {
      cause: error
    })
  }
}

export interface DashboardEsQueryRequest {
  nodes: string[]
  method: "GET" | "POST"
  path: string
  headers: Record<string, string>
  bodyText?: string
  projection?: DashboardEsProjection
  timeoutMs: number
  signal?: AbortSignal
  inputByteLimit?: number
  outputByteLimit?: number
}

export interface DashboardEsWorkerResult {
  value: unknown
  stats: {
    sourceBytes: number
    outputBytes: number
    durationMs: number
    node: string
  }
}

export interface DashboardEsWorkerDiagnostics {
  completedRequests: number
  lastStats: {
    sourceBytes: number
    outputBytes: number
    durationMs: number
    node: string
  } | null
}

export class DashboardEsWorkerClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private activeRequestCount = 0
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private completedRequests = 0
  private lastStats: DashboardEsWorkerDiagnostics["lastStats"] = null

  constructor(private readonly workerFactory: WorkerFactory = createBundledWorker) {}

  private cleanupPending(pending: PendingRequest): void {
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener)
    }
  }

  private handleResponse = (response: DashboardEsWorkerResponse): void => {
    if (response.type === "shutdown-complete") {
      this.shutdownResolve?.()
      this.shutdownResolve = null
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    this.cleanupPending(pending)
    if (response.ok) {
      this.completedRequests += 1
      this.lastStats = response.stats
      pending.resolve({ value: response.value, stats: response.stats })
      return
    }
    if (response.error.code === DASHBOARD_ES_REQUEST_CANCELLED) {
      pending.reject(new DashboardEsRequestCancelledError())
      return
    }
    const error = new Error(response.error.message) as Error & { code?: string }
    error.name = response.error.code
    error.code = response.error.code
    pending.reject(error)
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    const unavailable = new DashboardEsWorkerUnavailableError(
      "Dashboard ES worker stopped unexpectedly",
      { cause: error }
    )
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending)
      pending.reject(unavailable)
    }
    this.pending.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new DashboardEsWorkerUnavailableError("Dashboard ES client is closing")
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.handleWorkerFailure(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.handleWorkerFailure(worker, new Error(`Dashboard ES worker exited with ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        this.workerPromise = null
        if (error instanceof DashboardEsWorkerUnavailableError) throw error
        throw new DashboardEsWorkerUnavailableError("Unable to start the Dashboard ES worker", {
          cause: error
        })
      })
    return this.workerPromise
  }

  async query(request: DashboardEsQueryRequest): Promise<unknown> {
    return (await this.queryWithStats(request)).value
  }

  async queryWithStats(request: DashboardEsQueryRequest): Promise<DashboardEsWorkerResult> {
    if (this.closing) {
      throw new DashboardEsWorkerUnavailableError("Dashboard ES client is closing")
    }
    if (request.signal?.aborted) throw new DashboardEsRequestCancelledError()
    if (this.activeRequestCount >= DASHBOARD_ES_MAX_ACTIVE_REQUESTS) {
      throw Object.assign(new Error("Dashboard ES request capacity exceeded"), {
        name: "DASHBOARD_ES_CAPACITY_EXCEEDED"
      })
    }
    if (
      request.bodyText !== undefined &&
      Buffer.byteLength(request.bodyText, "utf8") > DASHBOARD_ES_MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error("Dashboard ES request body exceeds its hard byte ceiling")
    }
    if (
      request.nodes.length > 16 ||
      request.nodes.some((node) => Buffer.byteLength(node, "utf8") > 8 * 1024) ||
      Buffer.byteLength(request.path, "utf8") > 8 * 1024 ||
      Object.keys(request.headers).length > 64 ||
      Object.entries(request.headers).reduce(
        (bytes, [key, value]) =>
          bytes + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"),
        0
      ) > 64 * 1024
    ) {
      throw new Error("Dashboard ES request metadata exceeds its hard limit")
    }
    this.activeRequestCount += 1
    try {
      const worker = await this.getWorker()
      if (this.closing) {
        throw new DashboardEsWorkerUnavailableError("Dashboard ES client is closing")
      }
      if (request.signal?.aborted) throw new DashboardEsRequestCancelledError()
      const requestId = this.nextRequestId++
      const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const cancellation = new Int32Array(cancellationBuffer)

      return await new Promise((resolve, reject) => {
        const pending: PendingRequest = {
          resolve,
          reject,
          cancellation,
          signal: request.signal
        }
        if (request.signal) {
          pending.abortListener = () => {
            if (!this.pending.delete(requestId)) return
            Atomics.store(cancellation, 0, 1)
            this.cleanupPending(pending)
            reject(new DashboardEsRequestCancelledError())
          }
          request.signal.addEventListener("abort", pending.abortListener, { once: true })
        }
        this.pending.set(requestId, pending)
        try {
          worker.postMessage({
            type: "query",
            requestId,
            nodes: request.nodes,
            method: request.method,
            path: request.path,
            headers: request.headers,
            bodyText: request.bodyText,
            projection: request.projection,
            timeoutMs: request.timeoutMs,
            inputByteLimit: Math.min(
              request.inputByteLimit ?? DASHBOARD_ES_INPUT_BYTE_LIMIT,
              DASHBOARD_ES_INPUT_BYTE_LIMIT
            ),
            outputByteLimit: Math.min(
              request.outputByteLimit ?? DASHBOARD_ES_OUTPUT_BYTE_LIMIT,
              DASHBOARD_ES_OUTPUT_BYTE_LIMIT
            ),
            cancellationBuffer
          })
        } catch (error) {
          this.pending.delete(requestId)
          this.cleanupPending(pending)
          reject(
            new DashboardEsWorkerUnavailableError("Unable to dispatch the Dashboard ES request", {
              cause: error
            })
          )
        }
      })
    } finally {
      this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
    }
  }

  getDiagnostics(): DashboardEsWorkerDiagnostics {
    return {
      completedRequests: this.completedRequests,
      lastStats: this.lastStats ? { ...this.lastStats } : null
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const pending of this.pending.values()) {
      Atomics.store(pending.cancellation, 0, 1)
      this.cleanupPending(pending)
      pending.reject(new DashboardEsRequestCancelledError("Dashboard ES worker is shutting down"))
    }
    this.pending.clear()
    const worker = this.worker
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      this.shutdownResolve = finish
      const timeout = setTimeout(finish, 500)
      timeout.unref()
      try {
        worker.postMessage({ type: "shutdown" })
      } catch {
        finish()
      }
    })
    this.shutdownResolve = null
    await worker.terminate()
  }
}

let defaultClient: DashboardEsWorkerClient | null = null

function getDefaultClient(): DashboardEsWorkerClient {
  defaultClient ??= new DashboardEsWorkerClient()
  return defaultClient
}

export function queryDashboardEsInWorker(request: DashboardEsQueryRequest): Promise<unknown> {
  return getDefaultClient().query(request)
}

export function queryDashboardEsInWorkerWithStats(
  request: DashboardEsQueryRequest
): Promise<DashboardEsWorkerResult> {
  return getDefaultClient().queryWithStats(request)
}

export async function closeDashboardEsWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
