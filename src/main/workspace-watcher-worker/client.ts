import type { Worker } from "node:worker_threads"
import type { WorkspaceWatcherWorkerResponse } from "./protocol"
import { WORKSPACE_WATCHER_CANCELLED } from "./protocol"

export interface WorkspaceWatcherWorkerEvent {
  eventType: "change" | "rename"
  filename: string | null
}

export type WorkspaceWatcherWorkerFactory = () => Promise<Worker>

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./workspace-watcher-worker?nodeWorker")
  return module.default({ name: "workspace-watcher" })
}

export class WorkspaceWatcherWorkerClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private startPromise: Promise<void> | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private started = false
  private closed = false

  constructor(
    readonly workspacePath: string,
    private readonly onEvent: (event: WorkspaceWatcherWorkerEvent) => void,
    private readonly onWatchError: (error: Error) => void,
    private readonly workerFactory: WorkspaceWatcherWorkerFactory = createBundledWorker
  ) {}

  private cancelledError(): Error {
    const error = new Error("Workspace watcher was cancelled")
    error.name = WORKSPACE_WATCHER_CANCELLED
    return error
  }

  private rejectStart(error: Error): void {
    const reject = this.startReject
    this.startResolve = null
    this.startReject = null
    reject?.(error)
  }

  private handleMessage = (response: WorkspaceWatcherWorkerResponse): void => {
    if (this.closed) return
    if (response.type === "event-batch") {
      if (this.started) {
        for (const event of response.events) this.onEvent(event)
      }
      return
    }
    if (response.type === "watch-error") {
      const error = new Error(response.error.message)
      error.name = response.error.code
      if (!this.started) {
        this.rejectStart(error)
        this.close()
      } else {
        this.onWatchError(error)
      }
      return
    }
    if (response.type !== "start-result") return
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      this.rejectStart(error)
      this.close()
      return
    }
    this.started = true
    const resolve = this.startResolve
    this.startResolve = null
    this.startReject = null
    resolve?.()
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker || this.closed) return
    this.worker = null
    this.workerPromise = null
    if (this.started) this.onWatchError(error)
    else this.rejectStart(error)
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
          this.failWorker(
            worker,
            new Error(`Workspace watcher worker exited with code ${code}`)
          )
        }
      })
      worker.unref()
      return worker
    })
    return this.workerPromise
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      const worker = await this.getWorker()
      if (this.closed) throw this.cancelledError()
      await new Promise<void>((resolve, reject) => {
        this.startResolve = resolve
        this.startReject = reject
        try {
          worker.postMessage({ type: "start", requestId: 1, workspacePath: this.workspacePath })
        } catch (error) {
          this.startResolve = null
          this.startReject = null
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })()
    return this.startPromise
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectStart(this.cancelledError())
    const terminate = (worker: Worker): void => {
      try {
        worker.postMessage({ type: "shutdown" })
      } catch {
        // A failed worker may already have stopped accepting messages.
      }
      void worker.terminate()
    }
    if (this.worker) terminate(this.worker)
    else if (this.workerPromise) void this.workerPromise.then(terminate).catch(() => undefined)
    this.worker = null
    this.workerPromise = null
  }
}

export function isWorkspaceWatcherCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === WORKSPACE_WATCHER_CANCELLED
}
