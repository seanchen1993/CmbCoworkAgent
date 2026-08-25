import type { Worker } from "node:worker_threads"
import {
  WORKSPACE_FILE_PREVIEW_CANCELLED,
  type WorkspaceFilePreviewTextResult
} from "../../shared/workspace-file-preview"
import type {
  WorkspaceFilePreviewWorkerResponse,
  WorkspaceFilePreviewWorkerSource
} from "./protocol"

type WorkerFactory = () => Promise<Worker>
type RequestKind = "read-text" | "inspect"

export interface WorkspaceFilePreviewInspection {
  resolvedPath: string
  size: number
  modified_at: string
}

interface PendingRequest {
  kind: RequestKind
  resolve: (
    value:
      | { result: WorkspaceFilePreviewTextResult; resolvedPath: string }
      | WorkspaceFilePreviewInspection
  ) => void
  reject: (error: Error) => void
  cancellation: Int32Array
  latestKey: string
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./workspace-file-preview-worker?nodeWorker")
  return module.default({ name: "workspace-file-preview" })
}

function cancelledError(message = "Workspace file preview was cancelled"): Error {
  const error = new Error(message)
  error.name = WORKSPACE_FILE_PREVIEW_CANCELLED
  return error
}

export class WorkspaceFilePreviewClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestRequests = new Map<string, number>()

  constructor(private readonly workerFactory: WorkerFactory = createBundledWorker) {}

  private handleMessage = (response: WorkspaceFilePreviewWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (this.latestRequests.get(pending.latestKey) === response.requestId) {
      this.latestRequests.delete(pending.latestKey)
    }

    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      pending.reject(error)
      return
    }
    if (response.type === "read-text-result" && pending.kind === "read-text") {
      pending.resolve({ result: response.result, resolvedPath: response.resolvedPath })
      return
    }
    if (response.type === "inspect-result" && pending.kind === "inspect") {
      pending.resolve({
        resolvedPath: response.resolvedPath,
        size: response.size,
        modified_at: response.modified_at
      })
      return
    }
    pending.reject(new Error("Workspace file preview response kind mismatch"))
  }

  private failWorker(worker: Worker, cause: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    for (const pending of this.pending.values()) pending.reject(cause)
    this.pending.clear()
    this.latestRequests.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) throw cancelledError("Workspace file preview client is closing")
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw cancelledError("Workspace file preview client is closing")
        }
        this.worker = worker
        worker.on("message", this.handleMessage)
        worker.on("error", (error) => this.failWorker(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing && code !== 0) {
            this.failWorker(worker, new Error(`Workspace preview worker exited with code ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        this.workerPromise = null
        throw error
      })
    return this.workerPromise
  }

  private async request(
    kind: RequestKind,
    source: WorkspaceFilePreviewWorkerSource,
    workspacePath: string | undefined,
    latestKey: string,
    offset = 0
  ): Promise<
    | { result: WorkspaceFilePreviewTextResult; resolvedPath: string }
    | WorkspaceFilePreviewInspection
  > {
    if (this.closing) throw cancelledError("Workspace file preview client is closing")
    const requestId = this.nextRequestId++
    const previousId = this.latestRequests.get(latestKey)
    const previous = previousId === undefined ? undefined : this.pending.get(previousId)
    if (previous) {
      Atomics.store(previous.cancellation, 0, 1)
      previous.reject(cancelledError("Workspace file preview was superseded"))
      this.pending.delete(previousId as number)
    }
    this.latestRequests.set(latestKey, requestId)

    const worker = await this.getWorker()
    if (this.latestRequests.get(latestKey) !== requestId) {
      throw cancelledError("Workspace file preview was superseded")
    }

    const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const cancellation = new Int32Array(cancellationBuffer)
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        kind,
        resolve,
        reject,
        cancellation,
        latestKey
      })
      if (kind === "read-text") {
        worker.postMessage({
          type: "read-text",
          requestId,
          source,
          workspacePath,
          offset,
          cancellationBuffer
        })
      } else {
        worker.postMessage({
          type: "inspect",
          requestId,
          source,
          workspacePath,
          cancellationBuffer
        })
      }
    })
  }

  async readText(
    source: WorkspaceFilePreviewWorkerSource,
    workspacePath: string | undefined,
    offset: number,
    latestKey: string
  ): Promise<{ result: WorkspaceFilePreviewTextResult; resolvedPath: string }> {
    return (await this.request(
      "read-text",
      source,
      workspacePath,
      latestKey,
      offset
    )) as { result: WorkspaceFilePreviewTextResult; resolvedPath: string }
  }

  async inspect(
    source: WorkspaceFilePreviewWorkerSource,
    workspacePath: string | undefined,
    latestKey: string
  ): Promise<WorkspaceFilePreviewInspection> {
    return (await this.request("inspect", source, workspacePath, latestKey)) as WorkspaceFilePreviewInspection
  }

  cancelLatest(latestKey: string): void {
    const requestId = this.latestRequests.get(latestKey)
    if (requestId === undefined) return
    this.latestRequests.delete(latestKey)
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    Atomics.store(pending.cancellation, 0, 1)
    pending.reject(cancelledError())
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const latestKey of [...this.latestRequests.keys()]) this.cancelLatest(latestKey)
    const worker = this.worker ?? (await this.workerPromise?.catch(() => null))
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    worker.postMessage({ type: "shutdown" })
    await worker.terminate()
  }
}

let defaultClient: WorkspaceFilePreviewClient | null = null

export function getWorkspaceFilePreviewClient(): WorkspaceFilePreviewClient {
  if (!defaultClient) defaultClient = new WorkspaceFilePreviewClient()
  return defaultClient
}

export async function closeWorkspaceFilePreviewWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
