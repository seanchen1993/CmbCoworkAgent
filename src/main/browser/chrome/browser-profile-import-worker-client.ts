import type { Worker } from "node:worker_threads"
import type {
  BrowserProfileImportOptions,
  BrowserProfileImportSkippedWebsite
} from "../../../shared/browser-types"
import type { BrowserSessionData } from "../core/browser-session-data"
import {
  BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT,
  BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT_MS,
  type BrowserProfileImportWorkerResponse
} from "./browser-profile-import-worker-protocol"

type WorkerFactory = () => Promise<Worker>

interface BrowserProfileImportWorkerResult {
  data: BrowserSessionData
  profileDirectory: string
  skippedCookies: number
  skippedWebsites: BrowserProfileImportSkippedWebsite[]
}

interface PendingRequest {
  reject: (error: Error) => void
  resolve: (result: BrowserProfileImportWorkerResult) => void
  timeout: NodeJS.Timeout
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./browser-profile-import-worker?nodeWorker")
  return module.default({
    name: "browser-profile-import",
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 64,
      stackSizeMb: 4
    }
  })
}

export class BrowserProfileImportWorkerClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private readonly pending = new Map<number, PendingRequest>()

  constructor(
    private readonly workerFactory: WorkerFactory = createBundledWorker,
    private readonly requestTimeoutMs = BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT_MS
  ) {}

  private handleMessage = (response: BrowserProfileImportWorkerResponse): void => {
    if (response.type === "shutdown-complete") return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timeout)
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      pending.reject(error)
      return
    }
    pending.resolve(response.result)
  }

  private failWorker(worker: Worker, cause: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(cause)
    }
    this.pending.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.closing) throw new Error("Browser profile import worker is closing")
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new Error("Browser profile import worker is closing")
        }
        this.worker = worker
        worker.on("message", this.handleMessage)
        worker.on("error", (error) => this.failWorker(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.failWorker(
              worker,
              new Error(`Browser profile import worker exited with code ${code}`)
            )
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

  async readProfile(input: BrowserProfileImportOptions): Promise<BrowserProfileImportWorkerResult> {
    if (this.closing) throw new Error("Browser profile import worker is closing")
    const requestId = this.nextRequestId++
    const worker = await this.getWorker()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        const error = new Error(`Browser profile import exceeded ${this.requestTimeoutMs}ms`)
        error.name = BROWSER_PROFILE_IMPORT_WORKER_TIMEOUT
        this.failWorker(worker, error)
        void worker.terminate()
      }, this.requestTimeoutMs)
      timeout.unref()
      this.pending.set(requestId, { reject, resolve, timeout })
      try {
        worker.postMessage({ input, requestId, type: "read-profile" })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const worker = this.worker ?? (await this.workerPromise?.catch(() => null))
    this.worker = null
    this.workerPromise = null
    if (!worker) return
    worker.postMessage({ type: "shutdown" })
    await worker.terminate()
  }
}

let defaultClient: BrowserProfileImportWorkerClient | null = null

export function getBrowserProfileImportWorkerClient(): BrowserProfileImportWorkerClient {
  if (!defaultClient) defaultClient = new BrowserProfileImportWorkerClient()
  return defaultClient
}
