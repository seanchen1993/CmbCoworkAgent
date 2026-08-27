import type { ResourceLimits, Worker } from "node:worker_threads"
import { getDbPath } from "../storage"
import type { Thread, ThreadSummaryPage, ThreadSummaryPageOptions } from "../types"
import type {
  ThreadGitMetadataProjection,
  ThreadGoalHydrationEvent,
  ThreadMetadataHydrationWorkerResponse
} from "./protocol"
import { THREAD_METADATA_HYDRATION_CANCELLED } from "./protocol"

type WorkerFactory = () => Promise<Worker>
type RequestKind = "thread" | "list-page" | "goal-events" | "workspace-path" | "git-context"

export const THREAD_METADATA_HYDRATION_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
}
// A selected thread may legitimately project up to 16 MiB. Keep aggregate
// response cloning bounded as well as the request count itself.
export const THREAD_METADATA_HYDRATION_MAX_ACTIVE_REQUESTS = 8

export interface ThreadGoalHydrationResult {
  events: ThreadGoalHydrationEvent[]
  truncated: boolean
}

interface PendingRequest {
  kind: RequestKind
  resolve: (
    value:
      | Thread
      | Thread[]
      | ThreadSummaryPage
      | ThreadGoalHydrationResult
      | ThreadGitMetadataProjection
      | string
      | null
  ) => void
  reject: (error: Error) => void
  cancellation: Int32Array
  latestKey: string | null
}

export class ThreadMetadataHydrationWorkerUnavailableError extends Error {
  readonly code = "THREAD_METADATA_HYDRATION_WORKER_UNAVAILABLE"
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ThreadMetadataHydrationWorkerUnavailableError"
  }
}

export function isThreadMetadataHydrationWorkerUnavailable(
  error: unknown
): error is ThreadMetadataHydrationWorkerUnavailableError {
  return error instanceof ThreadMetadataHydrationWorkerUnavailableError
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./thread-metadata-hydration-worker?nodeWorker")
    return module.default({
      name: "thread-metadata-hydration",
      resourceLimits: THREAD_METADATA_HYDRATION_WORKER_RESOURCE_LIMITS
    })
  } catch (error) {
    throw new ThreadMetadataHydrationWorkerUnavailableError(
      "Unable to start the bundled thread metadata hydration worker",
      { cause: error }
    )
  }
}

export class ThreadMetadataHydrationClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private activeRequestCount = 0
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestRequests = new Map<string, number>()
  private readonly threadRequests = new Map<string, Promise<Thread | null>>()
  private readonly workspacePathRequests = new Map<string, Promise<string | null>>()
  private readonly gitContextRequests = new Map<string, Promise<ThreadGitMetadataProjection>>()

  constructor(
    private readonly workerFactory: WorkerFactory = createBundledWorker,
    private readonly databasePath: () => string = getDbPath
  ) {}

  private handleResponse = (response: ThreadMetadataHydrationWorkerResponse): void => {
    if (response.type === "shutdown-complete") {
      this.shutdownResolve?.()
      this.shutdownResolve = null
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if (pending.latestKey && this.latestRequests.get(pending.latestKey) === response.requestId) {
      this.latestRequests.delete(pending.latestKey)
    }
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      pending.reject(error)
      return
    }
    if (response.type === "read-thread-result" && pending.kind === "thread") {
      pending.resolve(response.thread)
      return
    }
    if (response.type === "read-list-page-result" && pending.kind === "list-page") {
      pending.resolve({
        threads: response.threads,
        beforeUpdatedAt: response.beforeUpdatedAt,
        beforeThreadId: response.beforeThreadId,
        hasMore: response.hasMore
      })
      return
    }
    if (response.type === "read-goal-events-result" && pending.kind === "goal-events") {
      pending.resolve({ events: response.events, truncated: response.truncated })
      return
    }
    if (response.type === "read-workspace-path-result" && pending.kind === "workspace-path") {
      pending.resolve(response.workspacePath)
      return
    }
    if (response.type === "read-git-context-result" && pending.kind === "git-context") {
      pending.resolve(response.projection)
      return
    }
    pending.reject(new Error("Thread metadata hydration response kind mismatch"))
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    const unavailable = new ThreadMetadataHydrationWorkerUnavailableError(
      "Thread metadata hydration worker stopped unexpectedly",
      { cause: error }
    )
    for (const request of this.pending.values()) request.reject(unavailable)
    this.pending.clear()
    this.latestRequests.clear()
  }

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    this.workerPromise = this.workerFactory()
      .then((worker) => {
        if (this.closing) {
          void worker.terminate()
          throw new ThreadMetadataHydrationWorkerUnavailableError(
            "Thread metadata hydration client is closing"
          )
        }
        this.worker = worker
        worker.on("message", this.handleResponse)
        worker.on("error", (error) => this.handleWorkerFailure(worker, error))
        worker.on("exit", (code) => {
          if (!this.closing) {
            this.handleWorkerFailure(worker, new Error(`Metadata worker exited with code ${code}`))
          }
        })
        worker.unref()
        return worker
      })
      .catch((error) => {
        this.workerPromise = null
        if (error instanceof ThreadMetadataHydrationWorkerUnavailableError) throw error
        throw new ThreadMetadataHydrationWorkerUnavailableError(
          "Unable to start the thread metadata hydration worker",
          { cause: error }
        )
      })
    return this.workerPromise
  }

  private async request(
    kind: RequestKind,
    payload:
      | { type: "read-thread"; threadId: string }
      | {
          type: "read-list-page"
          beforeUpdatedAt?: number
          beforeThreadId?: string
          limit: number
          byteBudget: number
        }
      | {
          type: "read-goal-events"
          threadId: string
          restore: boolean
          recentLimit: number
          scanLimit: number
          byteBudget: number
        }
      | { type: "read-workspace-path"; threadId: string }
      | { type: "read-git-context"; threadId: string },
    latestKey: string | null
  ): Promise<
    | Thread
    | Thread[]
    | ThreadSummaryPage
    | ThreadGoalHydrationResult
    | ThreadGitMetadataProjection
    | string
    | null
  > {
    if (this.closing) {
      throw new ThreadMetadataHydrationWorkerUnavailableError(
        "Thread metadata hydration client is closing"
      )
    }
    for (const value of Object.values(payload)) {
      if (typeof value === "string" && value.length > 32_768) {
        throw new ThreadMetadataHydrationWorkerUnavailableError(
          "Thread metadata hydration request exceeds its string limit"
        )
      }
    }
    if (this.activeRequestCount >= THREAD_METADATA_HYDRATION_MAX_ACTIVE_REQUESTS) {
      throw new ThreadMetadataHydrationWorkerUnavailableError(
        "Thread metadata hydration request capacity exceeded"
      )
    }
    this.activeRequestCount += 1
    const requestId = this.nextRequestId++
    try {
      if (latestKey) {
        const previousId = this.latestRequests.get(latestKey)
        const previous = previousId === undefined ? undefined : this.pending.get(previousId)
        if (previous) {
          Atomics.store(previous.cancellation, 0, 1)
          this.pending.delete(previousId as number)
          const error = new Error("Thread metadata hydration request was superseded")
          error.name = THREAD_METADATA_HYDRATION_CANCELLED
          previous.reject(error)
        }
        this.latestRequests.set(latestKey, requestId)
      }
      const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const cancellation = new Int32Array(cancellationBuffer)
      const worker = await this.getWorker()
      if (this.closing) {
        throw new ThreadMetadataHydrationWorkerUnavailableError(
          "Thread metadata hydration client is closing"
        )
      }
      if (latestKey && this.latestRequests.get(latestKey) !== requestId) {
        const error = new Error("Thread metadata hydration request was superseded")
        error.name = THREAD_METADATA_HYDRATION_CANCELLED
        throw error
      }
      return await new Promise((resolve, reject) => {
        this.pending.set(requestId, { kind, resolve, reject, cancellation, latestKey })
        try {
          worker.postMessage({
            ...payload,
            requestId,
            databasePath: this.databasePath(),
            cancellationBuffer
          })
        } catch (error) {
          this.pending.delete(requestId)
          reject(
            new ThreadMetadataHydrationWorkerUnavailableError(
              "Unable to dispatch the thread metadata hydration request",
              { cause: error }
            )
          )
        }
      })
    } finally {
      this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
      if (latestKey && this.latestRequests.get(latestKey) === requestId) {
        this.latestRequests.delete(latestKey)
      }
    }
  }

  readThread(threadId: string, webContentsId?: number): Promise<Thread | null> {
    const normalizedThreadId = threadId.trim()
    const latestKey = Number.isSafeInteger(webContentsId) ? `thread:${webContentsId}` : null
    const requestKey = latestKey ? `${normalizedThreadId}:${latestKey}` : normalizedThreadId
    const existing = this.threadRequests.get(requestKey)
    if (existing) return existing
    const request = this.request(
      "thread",
      { type: "read-thread", threadId: normalizedThreadId },
      latestKey
    ).then((value) => value as Thread | null)
    this.threadRequests.set(requestKey, request)
    void request.then(
      () => {
        if (this.threadRequests.get(requestKey) === request) {
          this.threadRequests.delete(requestKey)
        }
      },
      () => {
        if (this.threadRequests.get(requestKey) === request) {
          this.threadRequests.delete(requestKey)
        }
      }
    )
    return request
  }

  async readListPage(
    options: ThreadSummaryPageOptions = {},
    webContentsId?: number
  ): Promise<ThreadSummaryPage> {
    const latestKey = Number.isSafeInteger(webContentsId) ? `list:${webContentsId}` : null
    return (await this.request(
      "list-page",
      {
        type: "read-list-page",
        ...(Number.isFinite(options.beforeUpdatedAt)
          ? { beforeUpdatedAt: options.beforeUpdatedAt }
          : {}),
        ...(typeof options.beforeThreadId === "string" && options.beforeThreadId.length > 0
          ? { beforeThreadId: options.beforeThreadId }
          : {}),
        limit: options.limit ?? 128,
        byteBudget: options.byteBudget ?? 512 * 1024
      },
      latestKey
    )) as ThreadSummaryPage
  }

  async readGoalEvents(
    threadId: string,
    options: {
      restore?: boolean
      recentLimit?: number
      scanLimit?: number
      byteBudget?: number
      webContentsId?: number
    } = {}
  ): Promise<ThreadGoalHydrationResult> {
    const latestKey = Number.isSafeInteger(options.webContentsId)
      ? `goal-events:${options.webContentsId}`
      : null
    return (await this.request(
      "goal-events",
      {
        type: "read-goal-events",
        threadId,
        restore: options.restore === true,
        recentLimit: options.recentLimit ?? 200,
        scanLimit: options.scanLimit ?? (options.restore ? 500 : (options.recentLimit ?? 200)),
        byteBudget: options.byteBudget ?? 1024 * 1024
      },
      latestKey
    )) as ThreadGoalHydrationResult
  }

  readWorkspacePath(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim()
    const existing = this.workspacePathRequests.get(normalizedThreadId)
    if (existing) return existing
    const request = this.request(
      "workspace-path",
      { type: "read-workspace-path", threadId: normalizedThreadId },
      null
    ).then((value) => (typeof value === "string" ? value : null))
    this.workspacePathRequests.set(normalizedThreadId, request)
    void request.then(
      () => {
        if (this.workspacePathRequests.get(normalizedThreadId) === request) {
          this.workspacePathRequests.delete(normalizedThreadId)
        }
      },
      () => {
        if (this.workspacePathRequests.get(normalizedThreadId) === request) {
          this.workspacePathRequests.delete(normalizedThreadId)
        }
      }
    )
    return request
  }

  readGitContext(
    threadId: string,
    webContentsId?: number,
    requestScope = "default"
  ): Promise<ThreadGitMetadataProjection> {
    const normalizedThreadId = threadId.trim()
    const latestKey = Number.isSafeInteger(webContentsId)
      ? `git-context:${webContentsId}:${requestScope}`
      : null
    const requestKey = latestKey ? `${normalizedThreadId}:${latestKey}` : normalizedThreadId
    const existing = this.gitContextRequests.get(requestKey)
    if (existing) return existing
    const request = this.request(
      "git-context",
      { type: "read-git-context", threadId: normalizedThreadId },
      latestKey
    ).then((value) => value as ThreadGitMetadataProjection)
    this.gitContextRequests.set(requestKey, request)
    void request.then(
      () => {
        if (this.gitContextRequests.get(requestKey) === request) {
          this.gitContextRequests.delete(requestKey)
        }
      },
      () => {
        if (this.gitContextRequests.get(requestKey) === request) {
          this.gitContextRequests.delete(requestKey)
        }
      }
    )
    return request
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const request of this.pending.values()) {
      Atomics.store(request.cancellation, 0, 1)
      request.reject(
        new ThreadMetadataHydrationWorkerUnavailableError(
          "Thread metadata hydration worker is shutting down"
        )
      )
    }
    this.pending.clear()
    this.latestRequests.clear()
    this.threadRequests.clear()
    this.workspacePathRequests.clear()
    this.gitContextRequests.clear()
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

let defaultClient: ThreadMetadataHydrationClient | null = null

function getDefaultClient(): ThreadMetadataHydrationClient {
  defaultClient ??= new ThreadMetadataHydrationClient()
  return defaultClient
}

export function readThreadHydrationInWorker(
  threadId: string,
  webContentsId?: number
): Promise<Thread | null> {
  return getDefaultClient().readThread(threadId, webContentsId)
}

export function readThreadSummaryPageInWorker(
  options: ThreadSummaryPageOptions = {},
  webContentsId?: number
): Promise<ThreadSummaryPage> {
  return getDefaultClient().readListPage(options, webContentsId)
}

export function readThreadGoalEventsInWorker(
  threadId: string,
  options: {
    restore?: boolean
    recentLimit?: number
    scanLimit?: number
    byteBudget?: number
    webContentsId?: number
  } = {}
): Promise<ThreadGoalHydrationResult> {
  return getDefaultClient().readGoalEvents(threadId, options)
}

export function readThreadWorkspacePathInWorker(threadId: string): Promise<string | null> {
  return getDefaultClient().readWorkspacePath(threadId)
}

export function readThreadGitContextInWorker(
  threadId: string,
  webContentsId?: number,
  requestScope?: string
): Promise<ThreadGitMetadataProjection> {
  return getDefaultClient().readGitContext(threadId, webContentsId, requestScope)
}

export async function closeThreadMetadataHydrationWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
