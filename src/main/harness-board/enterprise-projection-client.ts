import type { Worker } from "node:worker_threads"
import type {
  HarnessEnterpriseProjectDetailResult,
  HarnessProjectReviewResult
} from "../../shared/harness-board-types"
import {
  HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
  HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES,
  HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS,
  HARNESS_ENTERPRISE_REVIEW_MAX_TYPE_NODES,
  type HarnessEnterpriseProjectionStats,
  type HarnessEnterpriseProjectionWorkerResponse
} from "./enterprise-projection-protocol"
import { harnessWorkerOptions } from "./worker-limits"

type EnterpriseProjectionWorkerFactory = () => Promise<Worker>

interface PendingRequest {
  scope: string
  cancelFlag: Int32Array
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export interface HarnessEnterpriseProjectionDiagnostics {
  completedRequests: number
  failedRequests: number
  workerRestarts: number
  lastStats: HarnessEnterpriseProjectionStats | null
}

export class HarnessEnterpriseProjectionWorkerUnavailableError extends Error {
  readonly code = "HARNESS_ENTERPRISE_PROJECTION_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HarnessEnterpriseProjectionWorkerUnavailableError"
  }
}

export class HarnessEnterpriseProjectionResultError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly preview?: string
  ) {
    super(message)
    this.name = "HarnessEnterpriseProjectionResultError"
  }
}

export class HarnessEnterpriseProjectionCancelledError extends Error {
  readonly code = "HARNESS_ENTERPRISE_PROJECTION_CANCELLED"

  constructor() {
    super("Harness enterprise projection request was superseded")
    this.name = "HarnessEnterpriseProjectionCancelledError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./enterprise-projection-worker?nodeWorker")
    return module.default(harnessWorkerOptions("harness-enterprise-projection"))
  } catch (error) {
    throw new HarnessEnterpriseProjectionWorkerUnavailableError(
      "Unable to start the bundled Harness enterprise projection worker",
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

export class HarnessEnterpriseProjectionClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestByScope = new Map<string, number>()
  private readonly diagnostics: HarnessEnterpriseProjectionDiagnostics = {
    completedRequests: 0,
    failedRequests: 0,
    workerRestarts: 0,
    lastStats: null
  }

  constructor(
    private readonly workerFactory: EnterpriseProjectionWorkerFactory = createBundledWorker
  ) {}

  private handleResponse = (response: HarnessEnterpriseProjectionWorkerResponse): void => {
    if (response.type === "shutdown-complete") {
      this.shutdownResolve?.()
      this.shutdownResolve = null
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (this.latestByScope.get(pending.scope) === response.requestId) {
      this.latestByScope.delete(pending.scope)
    }
    if (response.ok) {
      this.diagnostics.completedRequests += 1
      this.diagnostics.lastStats = response.stats
      pending.resolve(response.result)
      return
    }
    this.diagnostics.failedRequests += 1
    const error = new HarnessEnterpriseProjectionResultError(
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
    const unavailable = new HarnessEnterpriseProjectionWorkerUnavailableError(
      "Harness enterprise projection worker stopped unexpectedly",
      { cause: error }
    )
    for (const request of this.pending.values()) {
      Atomics.store(request.cancelFlag, 0, 1)
      request.reject(unavailable)
    }
    this.pending.clear()
    this.latestByScope.clear()
  }

  private attachWorker(worker: Worker): Worker {
    if (this.closing) {
      void worker.terminate()
      throw new HarnessEnterpriseProjectionWorkerUnavailableError(
        "Harness enterprise projection client is closing"
      )
    }
    this.worker = worker
    worker.on("message", this.handleResponse)
    worker.on("error", (error) => this.handleWorkerFailure(worker, error))
    worker.on("exit", (code) => {
      if (!this.closing) {
        this.handleWorkerFailure(
          worker,
          new Error(`Enterprise projection worker exited with code ${code}`)
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
        if (error instanceof HarnessEnterpriseProjectionWorkerUnavailableError) throw error
        throw new HarnessEnterpriseProjectionWorkerUnavailableError(
          "Unable to start the Harness enterprise projection worker",
          { cause: error }
        )
      })
    return this.workerPromise
  }

  cancelScope(scope: string): void {
    const requestId = this.latestByScope.get(scope)
    if (requestId === undefined) return
    const pending = this.pending.get(requestId)
    if (pending) {
      Atomics.store(pending.cancelFlag, 0, 1)
      this.pending.delete(requestId)
      pending.reject(new HarnessEnterpriseProjectionCancelledError())
    }
    this.latestByScope.delete(scope)
  }

  private async beginRequest(scope: string): Promise<{
    worker: Worker
    requestId: number
    cancelBuffer: SharedArrayBuffer
    cancelFlag: Int32Array
  }> {
    if (this.closing) {
      throw new HarnessEnterpriseProjectionWorkerUnavailableError(
        "Harness enterprise projection client is closing"
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
      throw new HarnessEnterpriseProjectionCancelledError()
    }
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    return {
      worker,
      requestId,
      cancelBuffer,
      cancelFlag: new Int32Array(cancelBuffer)
    }
  }

  async projectDetails(
    buffer: Buffer,
    scope: string
  ): Promise<HarnessEnterpriseProjectDetailResult> {
    const { worker, requestId, cancelBuffer, cancelFlag } = await this.beginRequest(scope)
    const transferable = makeTransferableBuffer(buffer)
    const bytes = transferable.buffer as ArrayBuffer
    return new Promise<HarnessEnterpriseProjectDetailResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (result) => resolve(result as HarnessEnterpriseProjectDetailResult),
        reject
      })
      try {
        worker.postMessage(
          {
            type: "project-details",
            requestId,
            bytes,
            byteOffset: transferable.byteOffset,
            byteLength: transferable.byteLength,
            maxProjects: HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
            maxOutputBytes: HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES,
            cancelBuffer
          },
          [bytes]
        )
      } catch (error) {
        this.pending.delete(requestId)
        if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
        reject(
          new HarnessEnterpriseProjectionWorkerUnavailableError(
            "Unable to send project details to the Harness enterprise projection worker",
            { cause: error }
          )
        )
      }
    })
  }

  async projectReviews(
    summaryBuffer: Buffer,
    typeBuffer: Buffer,
    scope: string
  ): Promise<HarnessProjectReviewResult> {
    const { worker, requestId, cancelBuffer, cancelFlag } = await this.beginRequest(scope)
    const summaryTransferable = makeTransferableBuffer(summaryBuffer)
    const typeTransferable = makeTransferableBuffer(typeBuffer)
    const summaryBytes = summaryTransferable.buffer as ArrayBuffer
    const typeBytes = typeTransferable.buffer as ArrayBuffer
    return new Promise<HarnessProjectReviewResult>((resolve, reject) => {
      this.pending.set(requestId, {
        scope,
        cancelFlag,
        resolve: (result) => resolve(result as HarnessProjectReviewResult),
        reject
      })
      try {
        worker.postMessage(
          {
            type: "project-reviews",
            requestId,
            summaryBytes,
            summaryByteOffset: summaryTransferable.byteOffset,
            summaryByteLength: summaryTransferable.byteLength,
            typeBytes,
            typeByteOffset: typeTransferable.byteOffset,
            typeByteLength: typeTransferable.byteLength,
            maxReviews: HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS,
            maxTypeNodes: HARNESS_ENTERPRISE_REVIEW_MAX_TYPE_NODES,
            maxOutputBytes: HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES,
            cancelBuffer
          },
          [summaryBytes, typeBytes]
        )
      } catch (error) {
        this.pending.delete(requestId)
        if (this.latestByScope.get(scope) === requestId) this.latestByScope.delete(scope)
        reject(
          new HarnessEnterpriseProjectionWorkerUnavailableError(
            "Unable to send project reviews to the Harness enterprise projection worker",
            { cause: error }
          )
        )
      }
    })
  }

  getDiagnostics(): HarnessEnterpriseProjectionDiagnostics {
    return {
      ...this.diagnostics,
      lastStats: this.diagnostics.lastStats ? { ...this.diagnostics.lastStats } : null
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const unavailable = new HarnessEnterpriseProjectionWorkerUnavailableError(
      "Harness enterprise projection worker is shutting down"
    )
    for (const request of this.pending.values()) {
      Atomics.store(request.cancelFlag, 0, 1)
      request.reject(unavailable)
    }
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

let defaultClient: HarnessEnterpriseProjectionClient | null = null
let defaultShutdownHookRegistered = false

function closeDefaultClientAtProcessExit(): void {
  const client = defaultClient
  defaultClient = null
  void client?.close()
}

function getDefaultClient(): HarnessEnterpriseProjectionClient {
  defaultClient ??= new HarnessEnterpriseProjectionClient()
  if (!defaultShutdownHookRegistered) {
    defaultShutdownHookRegistered = true
    process.once("beforeExit", closeDefaultClientAtProcessExit)
  }
  return defaultClient
}

export function projectHarnessEnterpriseDetailsInWorker(
  buffer: Buffer,
  scope: string,
  client = getDefaultClient()
): Promise<HarnessEnterpriseProjectDetailResult> {
  return client.projectDetails(buffer, scope)
}

export function projectHarnessEnterpriseReviewsInWorker(
  summaryBuffer: Buffer,
  typeBuffer: Buffer,
  scope: string,
  client = getDefaultClient()
): Promise<HarnessProjectReviewResult> {
  return client.projectReviews(summaryBuffer, typeBuffer, scope)
}

export function cancelHarnessEnterpriseProjectionScope(scope: string): void {
  defaultClient?.cancelScope(scope)
}

export function getHarnessEnterpriseProjectionDiagnostics():
  HarnessEnterpriseProjectionDiagnostics {
  return getDefaultClient().getDiagnostics()
}

export async function closeHarnessEnterpriseProjectionWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
