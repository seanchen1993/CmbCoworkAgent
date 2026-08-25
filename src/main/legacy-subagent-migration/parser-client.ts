import type { Worker } from "node:worker_threads"
import { getDbPath, getSubagentTranscriptContentDir } from "../storage"
import {
  LEGACY_SUBAGENT_MIGRATION_CANCELLED,
  type LegacySubagentMigrationBatchResponse,
  type LegacySubagentMigrationRow,
  type LegacySubagentMigrationStats,
  type LegacySubagentMigrationWorkerResponse
} from "./protocol"

type LegacySubagentMigrationWorkerFactory = () => Promise<Worker>
const LEGACY_SUBAGENT_MIGRATION_ABORT_GRACE_MS = 2_000

export class LegacySubagentMigrationCancelledError extends Error {
  readonly code = LEGACY_SUBAGENT_MIGRATION_CANCELLED

  constructor() {
    super("Legacy subagent transcript migration was cancelled")
    this.name = "LegacySubagentMigrationCancelledError"
  }
}

async function createBundledWorker(): Promise<Worker> {
  const module = await import("./legacy-subagent-migration-worker?nodeWorker")
  return module.default({ name: "legacy-subagent-migration" })
}

export class LegacySubagentMigrationParserClient {
  private nextRequestId = 1

  constructor(
    private readonly workerFactory: LegacySubagentMigrationWorkerFactory = createBundledWorker,
    private readonly databasePath: () => string = getDbPath,
    private readonly contentDirectory: () => string = getSubagentTranscriptContentDir
  ) {}

  async parse(
    threadId: string,
    onBatch: (rows: readonly LegacySubagentMigrationRow[]) => Promise<void>,
    signal?: AbortSignal
  ): Promise<LegacySubagentMigrationStats> {
    if (signal?.aborted) throw new LegacySubagentMigrationCancelledError()
    const worker = await this.workerFactory()
    if (signal?.aborted) {
      await worker.terminate().catch(() => undefined)
      throw new LegacySubagentMigrationCancelledError()
    }
    worker.unref()
    const requestId = this.nextRequestId++
    const cancellation = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    )
    let settled = false
    let processingBatch = false

    const result = new Promise<LegacySubagentMigrationStats>((resolve, reject) => {
      let abortDeadline: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        if (abortDeadline) clearTimeout(abortDeadline)
        abortDeadline = undefined
        signal?.removeEventListener("abort", abort)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const abort = (): void => {
        Atomics.store(cancellation, 0, 1)
        if (abortDeadline) return
        // Give the worker a short cooperative window to close SQLite/blob file
        // handles and remove its atomic temporary file before force termination.
        abortDeadline = setTimeout(
          () => fail(new LegacySubagentMigrationCancelledError()),
          LEGACY_SUBAGENT_MIGRATION_ABORT_GRACE_MS
        )
        abortDeadline.unref()
      }
      signal?.addEventListener("abort", abort, { once: true })

      const handleBatch = async (
        response: LegacySubagentMigrationBatchResponse
      ): Promise<void> => {
        if (processingBatch) {
          fail(new Error("Legacy migration worker sent overlapping batches"))
          return
        }
        processingBatch = true
        try {
          if (signal?.aborted) throw new LegacySubagentMigrationCancelledError()
          await onBatch(response.rows)
          if (signal?.aborted) throw new LegacySubagentMigrationCancelledError()
          worker.postMessage({
            type: "batch-ack",
            requestId,
            batchId: response.batchId
          })
        } catch (error) {
          Atomics.store(cancellation, 0, 1)
          fail(error)
        } finally {
          processingBatch = false
        }
      }

      worker.on("message", (response: LegacySubagentMigrationWorkerResponse) => {
        if (settled || response.requestId !== requestId) return
        if (response.type === "batch") {
          void handleBatch(response)
          return
        }
        if (response.type === "complete") {
          settled = true
          cleanup()
          resolve(response.stats)
          return
        }
        const error =
          response.error.code === LEGACY_SUBAGENT_MIGRATION_CANCELLED
            ? new LegacySubagentMigrationCancelledError()
            : new Error(response.error.message)
        error.name = response.error.code
        if (response.error.stack) error.stack = response.error.stack
        fail(error)
      })
      worker.once("error", fail)
      worker.once("exit", (code) => {
        if (!settled) fail(new Error(`Legacy migration worker exited with code ${code}`))
      })
      worker.postMessage({
        type: "start",
        requestId,
        databasePath: this.databasePath(),
        contentDirectory: this.contentDirectory(),
        threadId,
        cancellationBuffer: cancellation.buffer
      })
    })

    try {
      return await result
    } finally {
      Atomics.store(cancellation, 0, 1)
      await worker.terminate().catch(() => undefined)
    }
  }
}
