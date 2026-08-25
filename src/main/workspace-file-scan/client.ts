import type { Worker } from "node:worker_threads"
import type { WorkspaceFileScanEntry } from "../../shared/workspace-file-scan"
import type { WorkspaceFileScanWorkerResponse } from "./protocol"
import { WORKSPACE_FILE_SCAN_CANCELLED } from "./protocol"

type WorkerFactory = () => Promise<Worker>

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
  return module.default({ name: "workspace-file-scan" })
}

export class WorkspaceFileScanSession {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly cancellation = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  )
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
        if (!this.closed && code !== 0) {
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
    const worker = await this.getWorker()
    if (this.closed) throw this.cancelledError()
    const requestId = this.nextRequestId++
    return new Promise<
      | void
      | {
          files: WorkspaceFileScanEntry[]
          done: boolean
          truncated: boolean
          continuation?: string
        }
    >(
      (resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
        try {
          worker.postMessage({ ...payload, requestId })
        } catch (error) {
          this.pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    )
  }

  async open(): Promise<void> {
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
