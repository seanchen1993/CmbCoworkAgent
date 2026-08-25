import type { Worker } from "node:worker_threads"
import { normalizeHarnessAdapterDetailBatch } from "./adapter-detail-normalizer"
import type {
  HarnessAdapterDetailBatchResult,
  HarnessAdapterDetailProjectInput,
  HarnessAdapterRunProjection,
  HarnessAdapterDetailWorkerResponse,
  HarnessAdapterDetailWorkerStats
} from "./adapter-detail-protocol"
import {
  HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  HARNESS_ADAPTER_DETAIL_SYNC_FALLBACK_BYTES,
  HARNESS_ADAPTER_RUN_MAX_HOOK_ENTRIES,
  HARNESS_ADAPTER_RUN_MAX_HOOK_LOG_BYTES
} from "./adapter-detail-protocol"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"

type AdapterDetailWorkerFactory = () => Promise<Worker>
let adapterParseScopeSequence = 1

interface PendingRequest {
  scope?: string
  cancelFlag?: Int32Array
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export interface HarnessAdapterDetailDiagnostics {
  completedRequests: number
  failedRequests: number
  workerRestarts: number
  fallbackRequests: number
  lastStats: HarnessAdapterDetailWorkerStats | null
}

export class HarnessAdapterDetailWorkerUnavailableError extends Error {
  readonly code = "HARNESS_ADAPTER_DETAIL_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HarnessAdapterDetailWorkerUnavailableError"
  }
}

export class HarnessAdapterDetailWorkerResultError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly preview?: string
  ) {
    super(message)
    this.name = "HarnessAdapterDetailWorkerResultError"
  }
}

export class HarnessAdapterDetailCancelledError extends Error {
  constructor() {
    super("Harness adapter detail request was superseded")
    this.name = "HarnessAdapterDetailCancelledError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./adapter-detail-worker?nodeWorker")
    return module.default({ name: "harness-adapter-detail" })
  } catch (error) {
    throw new HarnessAdapterDetailWorkerUnavailableError(
      "Unable to start the bundled Harness adapter detail worker",
      { cause: error }
    )
  }
}

function makeTransferableBuffer(buffer: Buffer): Buffer {
  if (
    buffer.buffer instanceof ArrayBuffer &&
    buffer.byteOffset === 0 &&
    buffer.byteLength === buffer.buffer.byteLength
  ) {
    return buffer
  }
  const copy = Buffer.allocUnsafeSlow(buffer.byteLength)
  buffer.copy(copy)
  return copy
}

export class HarnessAdapterDetailClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestByScope = new Map<string, number>()
  private readonly diagnostics: HarnessAdapterDetailDiagnostics = {
    completedRequests: 0,
    failedRequests: 0,
    workerRestarts: 0,
    fallbackRequests: 0,
    lastStats: null
  }

  constructor(private readonly workerFactory: AdapterDetailWorkerFactory = createBundledWorker) {}

  private handleResponse = (response: HarnessAdapterDetailWorkerResponse): void => {
    if (response.type === "shutdown-complete") {
      this.shutdownResolve?.()
      this.shutdownResolve = null
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (pending.scope && this.latestByScope.get(pending.scope) === response.requestId) {
      this.latestByScope.delete(pending.scope)
    }
    if (response.ok) {
      this.diagnostics.completedRequests += 1
      this.diagnostics.lastStats = response.stats
      pending.resolve(response.result)
      return
    }

    this.diagnostics.failedRequests += 1
    const error = new HarnessAdapterDetailWorkerResultError(
      response.error.code,
      response.error.message,
      response.error.preview
    )
    if (response.error.stack) error.stack = response.error.stack
    pending.reject(error)
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    this.diagnostics.workerRestarts += 1
    const unavailable = new HarnessAdapterDetailWorkerUnavailableError(
      "Harness adapter detail worker stopped unexpectedly",
      { cause: error }
    )
    for (const request of this.pending.values()) request.reject(unavailable)
    this.pending.clear()
    this.latestByScope.clear()
  }

  private attachWorker(worker: Worker): Worker {
    if (this.closing) {
      void worker.terminate()
      throw new HarnessAdapterDetailWorkerUnavailableError(
        "Harness adapter detail client is closing"
      )
    }
    this.worker = worker
    worker.on("message", this.handleResponse)
    worker.on("error", (error) => this.handleWorkerFailure(worker, error))
    worker.on("exit", (code) => {
      if (!this.closing) {
        this.handleWorkerFailure(
          worker,
          new Error(`Adapter detail worker exited with code ${code}`)
        )
      }
    })
    worker.unref()
    return worker
  }

  private getWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker)
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => this.attachWorker(worker))
      .catch((error) => {
        this.workerPromise = null
        if (error instanceof HarnessAdapterDetailWorkerUnavailableError) throw error
        throw new HarnessAdapterDetailWorkerUnavailableError(
          "Unable to start the Harness adapter detail worker",
          { cause: error }
        )
      })
    return this.workerPromise
  }

  async parse(
    buffer: Buffer,
    projects: HarnessAdapterDetailProjectInput[],
    scope = `harness-adapter-detail-unscoped:${adapterParseScopeSequence++}`
  ): Promise<HarnessAdapterDetailBatchResult> {
    if (this.closing) {
      throw new HarnessAdapterDetailWorkerUnavailableError(
        "Harness adapter detail client is closing"
      )
    }
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) {
      throw new HarnessAdapterDetailCancelledError()
    }
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    const transferable = makeTransferableBuffer(buffer)
    const transferableArrayBuffer = transferable.buffer as ArrayBuffer
    return new Promise<HarnessAdapterDetailBatchResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (result) => resolve(result as HarnessAdapterDetailBatchResult),
        reject
      })
      try {
        worker.postMessage(
          {
            type: "parse",
            requestId,
            bytes: transferableArrayBuffer,
            byteOffset: transferable.byteOffset,
            byteLength: transferable.byteLength,
            projects,
            maxOutputBytes: HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
            cancelBuffer
          },
          [transferableArrayBuffer]
        )
      } catch (error) {
        this.pending.delete(requestId)
        if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
        reject(
          new HarnessAdapterDetailWorkerUnavailableError(
            "Unable to send output to the Harness adapter detail worker",
            { cause: error }
          )
        )
      }
    })
  }

  cancelScope(scope: string): void {
    const requestId = this.latestByScope.get(scope)
    if (requestId === undefined) return
    const pending = this.pending.get(requestId)
    if (pending) {
      if (pending.cancelFlag) Atomics.store(pending.cancelFlag, 0, 1)
      this.pending.delete(requestId)
      pending.reject(new HarnessAdapterDetailCancelledError())
    }
    this.latestByScope.delete(scope)
  }

  async parseRun(
    buffer: Buffer,
    project: HarnessProjectMetadata,
    fallbackSlug: string,
    scope: string
  ): Promise<HarnessAdapterRunProjection> {
    if (this.closing) {
      throw new HarnessAdapterDetailWorkerUnavailableError(
        "Harness adapter detail client is closing"
      )
    }
    this.cancelScope(scope)
    const requestId = this.nextRequestId++
    this.latestByScope.set(scope, requestId)
    let worker: Worker
    try {
      worker = await this.getWorker()
    } catch (error) {
      if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
      throw error
    }
    if (this.latestByScope.get(scope) !== requestId) {
      throw new HarnessAdapterDetailCancelledError()
    }
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancelFlag = new Int32Array(cancelBuffer)
    const transferable = makeTransferableBuffer(buffer)
    const transferableArrayBuffer = transferable.buffer as ArrayBuffer
    return new Promise<HarnessAdapterRunProjection>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (result) => resolve(result as HarnessAdapterRunProjection),
        reject
      })
      try {
        worker.postMessage(
          {
            type: "parse-run",
            requestId,
            bytes: transferableArrayBuffer,
            byteOffset: transferable.byteOffset,
            byteLength: transferable.byteLength,
            project,
            fallbackSlug,
            maxOutputBytes: HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
            maxHookLogBytes: HARNESS_ADAPTER_RUN_MAX_HOOK_LOG_BYTES,
            maxHookEntries: HARNESS_ADAPTER_RUN_MAX_HOOK_ENTRIES,
            cancelBuffer
          },
          [transferableArrayBuffer]
        )
      } catch (error) {
        this.pending.delete(requestId)
        this.latestByScope.delete(scope)
        reject(
          new HarnessAdapterDetailWorkerUnavailableError(
            "Unable to send run output to the Harness adapter detail worker",
            { cause: error }
          )
        )
      }
    })
  }

  recordFallback(): void {
    this.diagnostics.fallbackRequests += 1
  }

  getDiagnostics(): HarnessAdapterDetailDiagnostics {
    return {
      ...this.diagnostics,
      lastStats: this.diagnostics.lastStats ? { ...this.diagnostics.lastStats } : null
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const unavailable = new HarnessAdapterDetailWorkerUnavailableError(
      "Harness adapter detail worker is shutting down"
    )
    for (const request of this.pending.values()) request.reject(unavailable)
    this.pending.clear()
    this.latestByScope.clear()
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

let defaultBatchClient: HarnessAdapterDetailClient | null = null
let defaultRunClient: HarnessAdapterDetailClient | null = null
let defaultShutdownHookRegistered = false
let defaultBatchScopeSequence = 1

function closeDefaultClientsAtProcessExit(): void {
  const batchClient = defaultBatchClient
  const runClient = defaultRunClient
  defaultBatchClient = null
  defaultRunClient = null
  void Promise.all([batchClient?.close(), runClient?.close()])
}

function registerDefaultShutdownHook(): void {
  if (!defaultShutdownHookRegistered) {
    defaultShutdownHookRegistered = true
    process.once("beforeExit", closeDefaultClientsAtProcessExit)
  }
}

function getDefaultBatchClient(): HarnessAdapterDetailClient {
  defaultBatchClient ??= new HarnessAdapterDetailClient()
  registerDefaultShutdownHook()
  return defaultBatchClient
}

function getDefaultRunClient(): HarnessAdapterDetailClient {
  defaultRunClient ??= new HarnessAdapterDetailClient()
  registerDefaultShutdownHook()
  return defaultRunClient
}

export async function parseHarnessAdapterDetailBatchInWorker(
  buffer: Buffer,
  projects: HarnessAdapterDetailProjectInput[],
  scopeOrClient?: string | HarnessAdapterDetailClient,
  requestedClient?: HarnessAdapterDetailClient
): Promise<HarnessAdapterDetailBatchResult> {
  const scope =
    typeof scopeOrClient === "string"
      ? scopeOrClient
      : `harness-adapter-detail-batch:${defaultBatchScopeSequence++}`
  const client =
    scopeOrClient instanceof HarnessAdapterDetailClient
      ? scopeOrClient
      : requestedClient ?? getDefaultBatchClient()
  const fallbackBuffer =
    buffer.byteLength <= HARNESS_ADAPTER_DETAIL_SYNC_FALLBACK_BYTES ? Buffer.from(buffer) : null
  try {
    return await client.parse(buffer, projects, scope)
  } catch (error) {
    if (!(error instanceof HarnessAdapterDetailWorkerUnavailableError) || !fallbackBuffer) {
      throw error
    }
    client.recordFallback()
    console.warn("[HarnessAdapterDetailWorker] unavailable; using bounded fallback", error)
    return normalizeHarnessAdapterDetailBatch(fallbackBuffer, projects).result
  }
}

export function parseHarnessAdapterRunInWorker(
  buffer: Buffer,
  project: HarnessProjectMetadata,
  fallbackSlug: string,
  scope: string,
  client = getDefaultRunClient()
): Promise<HarnessAdapterRunProjection> {
  return client.parseRun(buffer, project, fallbackSlug, scope)
}

export function cancelHarnessAdapterDetailScope(scope: string): void {
  defaultBatchClient?.cancelScope(scope)
  defaultRunClient?.cancelScope(scope)
}

export function getHarnessAdapterDetailDiagnostics(): HarnessAdapterDetailDiagnostics {
  return (defaultRunClient ?? defaultBatchClient ?? getDefaultRunClient()).getDiagnostics()
}

export async function closeHarnessAdapterDetailWorker(): Promise<void> {
  const batchClient = defaultBatchClient
  const runClient = defaultRunClient
  defaultBatchClient = null
  defaultRunClient = null
  await Promise.all([batchClient?.close(), runClient?.close()])
}
