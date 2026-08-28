import type { Worker } from "node:worker_threads"
import { existsSync } from "node:fs"
import type {
  CheckpointRuntimeProjectionStats,
  LegacyCheckpointTranscriptMigrationStats,
  CheckpointRuntimeProjectionWorkerResponse
} from "./runtime-projection-protocol"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"

type RuntimeProjectionWorkerFactory = () => Promise<Worker>

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cancellation?: Int32Array
  bootstrapThreadId?: string
  foregroundKey?: string
}

export interface LegacyCheckpointTranscriptBootstrapResult {
  runtimeTuple: unknown | null
  stats: LegacyCheckpointTranscriptMigrationStats
}

function emptyLegacyCheckpointBootstrapResult(): LegacyCheckpointTranscriptBootstrapResult {
  return {
    runtimeTuple: null,
    stats: {
      checkpointId: null,
      totalMessages: 0,
      migratedMessages: 0,
      batches: 0,
      payloadBytes: 0
    }
  }
}

export class CheckpointRuntimeProjectionWorkerUnavailableError extends Error {
  readonly code = "CHECKPOINT_RUNTIME_PROJECTION_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CheckpointRuntimeProjectionWorkerUnavailableError"
  }
}

export function isCheckpointRuntimeProjectionCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./runtime-projection-worker?nodeWorker")
    return module.default({
      name: "checkpoint-runtime-projection",
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    })
  } catch (error) {
    throw new CheckpointRuntimeProjectionWorkerUnavailableError(
      "Unable to start the bundled checkpoint runtime projection worker",
      { cause: error }
    )
  }
}

export class CheckpointRuntimeProjectionClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private nextRequestId = 1
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly projectionRequests = new Map<string, Promise<CheckpointRuntimeProjectionStats>>()
  private readonly tupleRequests = new Map<string, Promise<unknown | null>>()
  private readonly foregroundRequests = new Map<string, number>()

  constructor(private readonly workerFactory: RuntimeProjectionWorkerFactory = createBundledWorker) {}

  private handleResponse = (response: CheckpointRuntimeProjectionWorkerResponse): void => {
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
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.code
      if (response.error.stack) error.stack = response.error.stack
      pending.reject(error)
      return
    }
    if (response.type === "read-latest-tuple-result") {
      pending.resolve(response.tuple)
    } else if (response.type === "inspect-transcript-presence-result") {
      pending.resolve(response.hasTranscript)
    } else if (response.type === "bootstrap-legacy-transcript-result") {
      pending.resolve({ runtimeTuple: response.runtimeTuple, stats: response.stats })
    } else {
      pending.resolve(response.stats)
    }
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerPromise = null
    const unavailable = new CheckpointRuntimeProjectionWorkerUnavailableError(
      "Checkpoint runtime projection worker stopped unexpectedly",
      { cause: error }
    )
    for (const pending of this.pending.values()) pending.reject(unavailable)
    this.pending.clear()
    this.projectionRequests.clear()
    this.tupleRequests.clear()
    this.foregroundRequests.clear()
  }

  private attachWorker(worker: Worker): Worker {
    if (this.closing) {
      void worker.terminate()
      throw new CheckpointRuntimeProjectionWorkerUnavailableError(
        "Checkpoint runtime projection client is closing"
      )
    }
    this.worker = worker
    worker.on("message", this.handleResponse)
    worker.on("error", (error) => this.handleWorkerFailure(worker, error))
    worker.on("exit", (code) => {
      if (!this.closing) {
        this.handleWorkerFailure(worker, new Error(`Runtime projection worker exited: ${code}`))
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
        if (error instanceof CheckpointRuntimeProjectionWorkerUnavailableError) throw error
        throw new CheckpointRuntimeProjectionWorkerUnavailableError(
          "Unable to start the checkpoint runtime projection worker",
          { cause: error }
        )
      })
    return this.workerPromise
  }

  private async request(
    request:
      | {
          type: "ensure-runtime-projection"
          databasePath: string
          threadId: string
          checkpointNs: string
        }
      | {
          type: "read-latest-tuple"
          databasePath: string
          threadId: string
          checkpointNs: string
          messageLimit?: number
          messageByteBudget?: number
        }
      | {
          type: "bootstrap-legacy-transcript"
          databasePath: string
          messageDatabasePath: string
          threadId: string
          checkpointNs: string
        }
      | {
          type: "inspect-transcript-presence"
          databasePath: string
          threadId: string
          checkpointNs: string
        },
    options: {
      cancellable?: boolean
      bootstrapThreadId?: string
      foregroundKey?: string
    } = {}
  ): Promise<unknown> {
    if (this.closing) {
      throw new CheckpointRuntimeProjectionWorkerUnavailableError(
        "Checkpoint runtime projection client is closing"
      )
    }
    const worker = await this.getWorker()
    // close() can start while getWorker() yields, even when the Worker was
    // already available through Promise.resolve(). Re-check before retaining a
    // pending request: close() has already drained the table by then and the
    // closing Worker deliberately ignores exit events, so registering here
    // would otherwise leave the caller unresolved forever.
    if (this.closing) {
      throw new CheckpointRuntimeProjectionWorkerUnavailableError(
        "Checkpoint runtime projection client is closing"
      )
    }
    const requestId = this.nextRequestId++
    const cancellation = options.cancellable
      ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
      : undefined
    if (options.foregroundKey) {
      const previousId = this.foregroundRequests.get(options.foregroundKey)
      const previous = previousId === undefined ? undefined : this.pending.get(previousId)
      if (previous) {
        if (previous.cancellation) Atomics.store(previous.cancellation, 0, 1)
        // Latest-intent callers no longer need the superseded result. Reject and
        // release its retained main-process bookkeeping immediately; the worker
        // still observes the shared cancellation flag and its eventual response
        // is safely ignored. This keeps rapid thread/workspace switching at one
        // retained request per foreground scope instead of waiting behind legacy
        // multi-megabyte scans.
        this.pending.delete(previousId!)
        const cancelled = new Error("Checkpoint runtime projection request cancelled")
        cancelled.name = CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
        previous.reject(cancelled)
      }
      this.foregroundRequests.set(options.foregroundKey, requestId)
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        ...(cancellation ? { cancellation } : {}),
        ...(options.bootstrapThreadId
          ? { bootstrapThreadId: options.bootstrapThreadId }
          : {}),
        ...(options.foregroundKey ? { foregroundKey: options.foregroundKey } : {})
      })
      try {
        worker.postMessage({
          ...request,
          requestId,
          ...(cancellation ? { cancellationBuffer: cancellation.buffer } : {})
        })
      } catch (error) {
        this.pending.delete(requestId)
        if (
          options.foregroundKey &&
          this.foregroundRequests.get(options.foregroundKey) === requestId
        ) {
          this.foregroundRequests.delete(options.foregroundKey)
        }
        reject(
          new CheckpointRuntimeProjectionWorkerUnavailableError(
            "Unable to send a checkpoint runtime projection request",
            { cause: error }
          )
        )
      }
    })
  }

  ensureRuntimeProjection(
    databasePath: string,
    threadId: string,
    checkpointNs = ""
  ): Promise<CheckpointRuntimeProjectionStats> {
    const key = `${databasePath}\u0000${threadId}\u0000${checkpointNs}`
    const existing = this.projectionRequests.get(key)
    if (existing) return existing
    const request = this.request({
      type: "ensure-runtime-projection",
      databasePath,
      threadId,
      checkpointNs
    })
      .then((value) => value as CheckpointRuntimeProjectionStats)
      .finally(() => {
        if (this.projectionRequests.get(key) === request) this.projectionRequests.delete(key)
      })
    this.projectionRequests.set(key, request)
    return request
  }

  readLatestTuple(
    databasePath: string,
    threadId: string,
    checkpointNs = "",
    options: {
      messageLimit?: number
      messageByteBudget?: number
      foregroundKey?: string | number
    } = {}
  ): Promise<unknown | null> {
    const key = `${databasePath}\u0000${threadId}\u0000${checkpointNs}\u0000${options.messageLimit ?? ""}\u0000${options.messageByteBudget ?? ""}`
    const existing = options.foregroundKey === undefined ? this.tupleRequests.get(key) : undefined
    if (existing) return existing
    const request = this.request(
      {
        type: "read-latest-tuple",
        databasePath,
        threadId,
        checkpointNs,
        messageLimit: options.messageLimit,
        messageByteBudget: options.messageByteBudget
      },
      options.foregroundKey === undefined
        ? {}
        : { cancellable: true, foregroundKey: String(options.foregroundKey) }
    )
      .then((value) => value ?? null)
      .finally(() => {
        if (this.tupleRequests.get(key) === request) this.tupleRequests.delete(key)
      })
    if (options.foregroundKey === undefined) this.tupleRequests.set(key, request)
    return request
  }

  bootstrapLegacyTranscript(
    databasePath: string,
    messageDatabasePath: string,
    threadId: string,
    checkpointNs = "",
    foregroundKey?: string | number
  ): Promise<LegacyCheckpointTranscriptBootstrapResult> {
    return this.request(
      {
        type: "bootstrap-legacy-transcript",
        databasePath,
        messageDatabasePath,
        threadId,
        checkpointNs
      },
      {
        cancellable: true,
        bootstrapThreadId: threadId,
        ...(foregroundKey === undefined ? {} : { foregroundKey: String(foregroundKey) })
      }
    ).then((value) => value as LegacyCheckpointTranscriptBootstrapResult)
  }

  hasTranscript(
    databasePath: string,
    threadId: string,
    checkpointNs = "",
    foregroundKey?: string | number
  ): Promise<boolean> {
    return this.request(
      {
        type: "inspect-transcript-presence",
        databasePath,
        threadId,
        checkpointNs
      },
      foregroundKey === undefined
        ? {}
        : { cancellable: true, foregroundKey: `transcript-presence:${foregroundKey}` }
    ).then(Boolean)
  }

  cancelLegacyTranscriptBootstrap(threadId: string): void {
    for (const request of this.pending.values()) {
      if (request.bootstrapThreadId === threadId && request.cancellation) {
        Atomics.store(request.cancellation, 0, 1)
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const unavailable = new CheckpointRuntimeProjectionWorkerUnavailableError(
      "Checkpoint runtime projection worker is shutting down"
    )
    for (const pending of this.pending.values()) pending.reject(unavailable)
    this.pending.clear()
    this.projectionRequests.clear()
    this.tupleRequests.clear()
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

let defaultClient: CheckpointRuntimeProjectionClient | null = null
let shutdownHookRegistered = false

function getDefaultClient(): CheckpointRuntimeProjectionClient {
  defaultClient ??= new CheckpointRuntimeProjectionClient()
  if (!shutdownHookRegistered) {
    shutdownHookRegistered = true
    process.once("beforeExit", () => {
      const client = defaultClient
      defaultClient = null
      void client?.close()
    })
  }
  return defaultClient
}

export function ensureCheckpointRuntimeProjectionInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = ""
): Promise<CheckpointRuntimeProjectionStats> {
  return getDefaultClient().ensureRuntimeProjection(databasePath, threadId, checkpointNs)
}

export function readLatestCheckpointTupleInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = "",
  options: {
    messageLimit?: number
    messageByteBudget?: number
    foregroundKey?: string | number
  } = {}
): Promise<unknown | null> {
  // A task does not get a checkpoint database until its first persisted run.
  // Preserve `null` exclusively for that authoritative empty state; once the
  // file exists, worker/SQLite/decoding failures must still reject so callers
  // can distinguish a failed read from an absent checkpoint.
  if (!existsSync(databasePath)) return Promise.resolve(null)
  return getDefaultClient().readLatestTuple(databasePath, threadId, checkpointNs, options)
}

export function bootstrapLegacyCheckpointTranscriptInWorker(
  databasePath: string,
  messageDatabasePath: string,
  threadId: string,
  checkpointNs = "",
  foregroundKey?: string | number
): Promise<LegacyCheckpointTranscriptBootstrapResult> {
  if (!existsSync(databasePath)) {
    return Promise.resolve(emptyLegacyCheckpointBootstrapResult())
  }
  return getDefaultClient().bootstrapLegacyTranscript(
    databasePath,
    messageDatabasePath,
    threadId,
    checkpointNs,
    foregroundKey
  )
}

export function hasVisibleCheckpointTranscriptInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = "",
  foregroundKey?: string | number
): Promise<boolean> {
  if (!existsSync(databasePath)) return Promise.resolve(false)
  return getDefaultClient().hasTranscript(databasePath, threadId, checkpointNs, foregroundKey)
}

export function cancelLegacyCheckpointTranscriptBootstrap(threadId: string): void {
  defaultClient?.cancelLegacyTranscriptBootstrap(threadId)
}

export async function closeCheckpointRuntimeProjectionWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
