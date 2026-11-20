import type { ResourceLimits, Worker } from "node:worker_threads"
import {
  WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
  WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
  type WorkspaceFileScanEntry
} from "../../shared/workspace-file-scan"
import type { WorkspaceFileScanWorkerResponse } from "./protocol"
import { WORKSPACE_FILE_SCAN_CANCELLED } from "./protocol"

type WorkerFactory = () => Promise<Worker>

export const WORKSPACE_FILE_SCAN_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
}
export const WORKSPACE_FILE_SCAN_MAX_PATH_LENGTH = 32_768
export const WORKSPACE_FILE_SCAN_MAX_CONTINUATION_LENGTH = 4_096

interface PendingRequest {
  resolve: (
    value:
      | void
      | {
          files: WorkspaceFileScanEntry[]
          done: boolean
          truncated: boolean
          continuation?: string
        }
  ) => void
  reject: (error: Error) => void
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./workspace-file-scan-worker?nodeWorker")
  return module.default({
    name: "workspace-file-scan",
    resourceLimits: WORKSPACE_FILE_SCAN_WORKER_RESOURCE_LIMITS
  })
}

export class WorkspaceFileScanSession {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly cancellation = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  )
  private requestInFlight = false
  private closed = false

  constructor(
    readonly scanId: string,
    private readonly workspacePath: string,
    private readonly workerFactory: WorkerFactory = createBundledWorker
  ) {}

  private handleMessage = (response: WorkspaceFileScanWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      pending.reject(error)
      return
    }
    if (response.type === "open-result") {
      pending.resolve()
      return
    }
    pending.resolve({
      files: response.files,
      done: response.done,
      truncated: response.truncated,
      continuation: response.continuation
    })
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closed) throw this.cancelledError()
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory().then((worker) => {
      if (this.closed) {
        void worker.terminate()
        throw this.cancelledError()
      }
      this.worker = worker
      worker.on("message", this.handleMessage)
      worker.on("error", (error) => this.failWorker(worker, error))
      worker.on("exit", (code) => {
        if (!this.closed) {
          this.failWorker(worker, new Error(`Workspace scan worker exited with code ${code}`))
        }
      })
      worker.unref()
      return worker
    })
    return this.workerPromise
  }

  private cancelledError(): Error {
    const error = new Error("Workspace file scan was cancelled")
    error.name = WORKSPACE_FILE_SCAN_CANCELLED
    return error
  }

  private async request(
    payload:
      | {
          type: "open"
          scanId: string
          workspacePath: string
          cancellationBuffer: SharedArrayBuffer
        }
      | {
          type: "next"
          scanId: string
          maxEntries: number
          maxBytes: number
          continuation?: string
        }
  ): Promise<
    | void
    | {
        files: WorkspaceFileScanEntry[]
        done: boolean
        truncated: boolean
        continuation?: string
      }
  > {
    if (this.requestInFlight) throw new Error("Workspace file scan request already in progress")
    this.requestInFlight = true
    try {
      const worker = await this.getWorker()
      if (this.closed) throw this.cancelledError()
      const requestId = this.nextRequestId++
      return await new Promise<
        | void
        | {
            files: WorkspaceFileScanEntry[]
            done: boolean
            truncated: boolean
            continuation?: string
          }
      >((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
        try {
          worker.postMessage({ ...payload, requestId })
        } catch (error) {
          this.pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    } finally {
      this.requestInFlight = false
    }
  }

  async open(): Promise<void> {
    if (
      this.scanId.length === 0 ||
      this.scanId.length > 256 ||
      this.workspacePath.length === 0 ||
      this.workspacePath.length > WORKSPACE_FILE_SCAN_MAX_PATH_LENGTH
    ) {
      throw new Error("Workspace file scan request exceeds its string limit")
    }
    await this.request({
      type: "open",
      scanId: this.scanId,
      workspacePath: this.workspacePath,
      cancellationBuffer: this.cancellation.buffer as SharedArrayBuffer
    })
  }

  async next(
    maxEntries: number,
    maxBytes: number,
    continuation?: string
  ): Promise<{
    files: WorkspaceFileScanEntry[]
    done: boolean
    truncated: boolean
    continuation?: string
  }> {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2 ||
      maxBytes > WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES ||
      (continuation?.length ?? 0) > WORKSPACE_FILE_SCAN_MAX_CONTINUATION_LENGTH
    ) {
      throw new Error("Workspace file scan page exceeds its hard request budget")
    }
    return (await this.request({
      type: "next",
      scanId: this.scanId,
      maxEntries,
      maxBytes,
      continuation
    })) as {
      files: WorkspaceFileScanEntry[]
      done: boolean
      truncated: boolean
      continuation?: string
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    Atomics.store(this.cancellation, 0, 1)
    const cancelled = this.cancelledError()
    for (const request of this.pending.values()) request.reject(cancelled)
    this.pending.clear()
    const worker = this.worker
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    try {
      worker.postMessage({ type: "cancel", scanId: this.scanId })
    } catch {
      // The worker may already have exited after completing its final page.
    }
    await worker.terminate()
  }
}

export function isWorkspaceFileScanCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === WORKSPACE_FILE_SCAN_CANCELLED
}
