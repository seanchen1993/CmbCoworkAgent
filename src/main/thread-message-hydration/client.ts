import type { ResourceLimits, Worker } from "node:worker_threads"
import { getDbPath } from "../storage"
import type { ThreadMessagesPage, ThreadMessagesPageOptions } from "../types"
import type {
  ThreadMessageHydrationWorkerResponse,
  ThreadMessageHydrationWorkerStats
} from "./protocol"
import { THREAD_MESSAGE_HYDRATION_CANCELLED } from "./protocol"

type HydrationWorkerFactory = () => Promise<Worker>

export const THREAD_MESSAGE_HYDRATION_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
}
export const THREAD_MESSAGE_HYDRATION_MAX_ACTIVE_REQUESTS = 32

interface PendingRequest {
  resolve: (page: ThreadMessagesPage) => void
  reject: (error: Error) => void
  cancellation: Int32Array
  foregroundKey: string | null
  startedAt: number
}

export interface ThreadMessageHydrationDiagnostics {
  completedRequests: number
  cancelledRequests: number
  failedRequests: number
  workerRestarts: number
  lastStats: ThreadMessageHydrationWorkerStats | null
}

export class ThreadMessageHydrationWorkerUnavailableError extends Error {
  readonly code = "THREAD_MESSAGE_HYDRATION_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ThreadMessageHydrationWorkerUnavailableError"
  }
}

export class ThreadMessageHydrationRequestCancelledError extends Error {
  readonly code = THREAD_MESSAGE_HYDRATION_CANCELLED

  constructor() {
    super("Thread message hydration request was superseded")
    this.name = "ThreadMessageHydrationRequestCancelledError"
  }
}

export function isThreadMessageHydrationWorkerUnavailable(
  error: unknown
): error is ThreadMessageHydrationWorkerUnavailableError {
  return error instanceof ThreadMessageHydrationWorkerUnavailableError
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./thread-message-hydration-worker?nodeWorker")
    return module.default({
      name: "thread-message-hydration",
      // A corrupt or legacy row can be far larger than the bounded page sent to
      // the renderer. Keep its JSON parse in a disposable, heap-limited isolate
      // so an outlier can restart hydration without exhausting Electron main.
      resourceLimits: THREAD_MESSAGE_HYDRATION_WORKER_RESOURCE_LIMITS
    })
  } catch (error) {
    throw new ThreadMessageHydrationWorkerUnavailableError(
      "Unable to start the bundled thread message hydration worker",
      { cause: error }
    )
  }
}

export class ThreadMessageHydrationClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private activeRequestCount = 0
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly foregroundRequests = new Map<string, number>()
  private readonly diagnostics: ThreadMessageHydrationDiagnostics = {
    completedRequests: 0,
    cancelledRequests: 0,
    failedRequests: 0,
    workerRestarts: 0,
    lastStats: null
  }

  constructor(
    private readonly workerFactory: HydrationWorkerFactory = createBundledWorker,
    private readonly databasePath: () => string = getDbPath
  ) {}

  private handleResponse = (response: ThreadMessageHydrationWorkerResponse): void => {
    if (response.type === "shutdown-complete") {
      this.shutdownResolve?.()
      this.shutdownResolve = null
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (
      pending.foregroundKey &&
      this.foregroundRequests.get(pending.foregroundKey) === response.requestId
    ) {
      this.foregroundRequests.delete(pending.foregroundKey)
    }

    if (response.ok) {
      this.diagnostics.completedRequests += 1
      this.diagnostics.lastStats = response.stats
      const elapsedMs = performance.now() - pending.startedAt
      if (elapsedMs >= 100) {
        console.debug("[ThreadHydrationWorker] slow page", {
          elapsedMs: Math.round(elapsedMs),
          ...response.stats
        })
      }
      pending.resolve(response.page)
      return
    }

    if (response.error.code === THREAD_MESSAGE_HYDRATION_CANCELLED) {
      this.diagnostics.cancelledRequests += 1
      pending.reject(new ThreadMessageHydrationRequestCancelledError())
      return
    }
    this.diagnostics.failedRequests += 1
    const error = new Error(response.error.message)
    error.name = response.error.code
    if (response.error.stack) error.stack = response.error.stack
    pending.reject(error)
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    // An error event can be followed by a late exit event. Do not let that
    // stale event tear down a replacement worker that is already serving the
    // next request.
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    this.diagnostics.workerRestarts += 1
    const unavailable = new ThreadMessageHydrationWorkerUnavailableError(
      "Thread message hydration worker stopped unexpectedly",
      { cause: error }
    )
    for (const request of this.pending.values()) request.reject(unavailable)
    this.pending.clear()
    this.foregroundRequests.clear()
  }

  private attachWorker(worker: Worker): Worker {
    if (this.closing) {
      void worker.terminate()
      throw new ThreadMessageHydrationWorkerUnavailableError(
        "Thread message hydration client is closing"
      )
    }
    this.worker = worker
    worker.on("message", this.handleResponse)
    worker.on("error", (error) => this.handleWorkerFailure(worker, error))
    worker.on("exit", (code) => {
      if (!this.closing) {
        this.handleWorkerFailure(worker, new Error(`Hydration worker exited with code ${code}`))
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
        if (error instanceof ThreadMessageHydrationWorkerUnavailableError) throw error
        throw new ThreadMessageHydrationWorkerUnavailableError(
          "Unable to start the thread message hydration worker",
          { cause: error }
        )
      })
    return this.workerPromise
  }

  async readPage(
    threadId: string,
    options: ThreadMessagesPageOptions = {},
    webContentsId?: number
  ): Promise<ThreadMessagesPage> {
    if (this.closing) {
      throw new ThreadMessageHydrationWorkerUnavailableError(
        "Thread message hydration client is closing"
      )
    }
    if (
      threadId.length > 32_768 ||
      [options.beforeMessageId, options.targetMessageId, options.anchorMessageId].some(
        (value) => typeof value === "string" && value.length > 32_768
      )
    ) {
      throw new ThreadMessageHydrationWorkerUnavailableError(
        "Thread message hydration request exceeds its string limit"
      )
    }
    if (this.activeRequestCount >= THREAD_MESSAGE_HYDRATION_MAX_ACTIVE_REQUESTS) {
      throw new ThreadMessageHydrationWorkerUnavailableError(
        "Thread message hydration request capacity exceeded"
      )
    }
    this.activeRequestCount += 1
    const requestId = this.nextRequestId++
    const foregroundKey =
      options.requestScope === "foreground-hydration" && Number.isSafeInteger(webContentsId)
        ? String(webContentsId)
        : null
    try {
      if (foregroundKey) {
        const previousId = this.foregroundRequests.get(foregroundKey)
        const previous = previousId === undefined ? undefined : this.pending.get(previousId)
        if (previous) {
          Atomics.store(previous.cancellation, 0, 1)
          this.pending.delete(previousId as number)
          this.diagnostics.cancelledRequests += 1
          previous.reject(new ThreadMessageHydrationRequestCancelledError())
        }
        this.foregroundRequests.set(foregroundKey, requestId)
      }
      const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const cancellation = new Int32Array(cancellationBuffer)
      const worker = await this.getWorker()
      if (this.closing) {
        throw new ThreadMessageHydrationWorkerUnavailableError(
          "Thread message hydration client is closing"
        )
      }
      if (foregroundKey && this.foregroundRequests.get(foregroundKey) !== requestId) {
        throw new ThreadMessageHydrationRequestCancelledError()
      }

      return await new Promise<ThreadMessagesPage>((resolve, reject) => {
        this.pending.set(requestId, {
          resolve,
          reject,
          cancellation,
          foregroundKey,
          startedAt: performance.now()
        })
        try {
          worker.postMessage({
            type: "read-page",
            requestId,
            databasePath: this.databasePath(),
            threadId,
            options: {
              beforeOrdinal: options.beforeOrdinal,
              beforeMessageId: options.beforeMessageId,
              targetMessageId: options.targetMessageId,
              anchorMessageId: options.anchorMessageId,
              limit: options.limit,
              byteBudget: options.byteBudget,
              includeVisibleMessagePresence: options.includeVisibleMessagePresence,
              notAfterCreatedAt: options.notAfterCreatedAt,
              recoveryCheckpointId: options.recoveryCheckpointId
            },
            cancellationBuffer
          })
        } catch (error) {
          this.pending.delete(requestId)
          reject(
            new ThreadMessageHydrationWorkerUnavailableError(
              "Unable to dispatch the thread message hydration request",
              { cause: error }
            )
          )
        }
      })
    } finally {
      this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
      if (foregroundKey && this.foregroundRequests.get(foregroundKey) === requestId) {
        this.foregroundRequests.delete(foregroundKey)
      }
    }
  }

  getDiagnostics(): ThreadMessageHydrationDiagnostics {
    return {
      ...this.diagnostics,
      lastStats: this.diagnostics.lastStats ? { ...this.diagnostics.lastStats } : null
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const request of this.pending.values()) {
      Atomics.store(request.cancellation, 0, 1)
      request.reject(
        new ThreadMessageHydrationWorkerUnavailableError(
          "Thread message hydration worker is shutting down"
        )
      )
    }
    this.pending.clear()
    this.foregroundRequests.clear()
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

let defaultClient: ThreadMessageHydrationClient | null = null
let defaultShutdownHookRegistered = false

function closeDefaultClientAtProcessExit(): void {
  const client = defaultClient
  defaultClient = null
  void client?.close()
}

function getDefaultClient(): ThreadMessageHydrationClient {
  defaultClient ??= new ThreadMessageHydrationClient()
  if (!defaultShutdownHookRegistered) {
    defaultShutdownHookRegistered = true
    process.once("beforeExit", closeDefaultClientAtProcessExit)
  }
  return defaultClient
}

export function readThreadMessagesPageInWorker(
  threadId: string,
  options: ThreadMessagesPageOptions = {},
  webContentsId?: number
): Promise<ThreadMessagesPage> {
  return getDefaultClient().readPage(threadId, options, webContentsId)
}

export function getThreadMessageHydrationDiagnostics(): ThreadMessageHydrationDiagnostics {
  return getDefaultClient().getDiagnostics()
}

export async function closeThreadMessageHydrationWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
