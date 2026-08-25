import {
  insertLegacyThreadSubagentManifestBatch
} from "../db"
import {
  advanceSubagentTranscriptReferenceEpoch,
  beginSubagentTranscriptExternalMutation,
  withSubagentTranscriptContentMutationLock
} from "../services/subagent-transcript-content-store"
import {
  LegacySubagentMigrationCancelledError,
  LegacySubagentMigrationParserClient
} from "./parser-client"
import type {
  LegacySubagentMigrationRow,
  LegacySubagentMigrationStats
} from "./protocol"

const CHECKED_THREAD_LIMIT = 256
const MAX_SNAPSHOT_RETRIES = 3

export interface LegacySubagentMigrationDatabase {
  insertBatch: typeof insertLegacyThreadSubagentManifestBatch
}

export interface LegacySubagentMigrationParser {
  parse(
    threadId: string,
    onBatch: (rows: readonly LegacySubagentMigrationRow[]) => Promise<void>,
    signal?: AbortSignal
  ): Promise<LegacySubagentMigrationStats>
}

const defaultDatabase: LegacySubagentMigrationDatabase = {
  insertBatch: insertLegacyThreadSubagentManifestBatch
}

function yieldMainProcess(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export class LegacySubagentMigrationCoordinator {
  private readonly checkedThreads = new Set<string>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly cancellation = new Map<string, AbortController>()

  constructor(
    private readonly parser: LegacySubagentMigrationParser =
      new LegacySubagentMigrationParserClient(),
    private readonly database: LegacySubagentMigrationDatabase = defaultDatabase,
    private readonly onReferenceMutation = advanceSubagentTranscriptReferenceEpoch,
    private readonly beginExternalMutation = beginSubagentTranscriptExternalMutation
  ) {}

  ensure(threadId: string): Promise<void> {
    if (this.checkedThreads.has(threadId)) return Promise.resolve()
    const existing = this.inFlight.get(threadId)
    if (existing) return existing
    const controller = new AbortController()
    this.cancellation.set(threadId, controller)
    const migration = this.migrateWithExternalMutationBarrier(
      threadId,
      controller.signal
    ).finally(() => {
      if (this.inFlight.get(threadId) === migration) this.inFlight.delete(threadId)
      if (this.cancellation.get(threadId) === controller) this.cancellation.delete(threadId)
    })
    this.inFlight.set(threadId, migration)
    return migration
  }

  private async migrateWithExternalMutationBarrier(
    threadId: string,
    signal: AbortSignal
  ): Promise<void> {
    const release = await this.beginExternalMutation()
    try {
      await this.migrate(threadId, signal)
    } finally {
      await release()
    }
  }

  cancel(threadId: string): void {
    this.cancellation.get(threadId)?.abort()
  }

  forget(threadId: string): void {
    this.cancel(threadId)
    this.checkedThreads.delete(threadId)
  }

  cancelAll(): void {
    for (const controller of this.cancellation.values()) controller.abort()
  }

  async cancelAllAndWait(): Promise<void> {
    this.cancelAll()
    await Promise.allSettled(this.inFlight.values())
  }

  private rememberChecked(threadId: string): void {
    this.checkedThreads.delete(threadId)
    this.checkedThreads.add(threadId)
    while (this.checkedThreads.size > CHECKED_THREAD_LIMIT) {
      const oldest = this.checkedThreads.values().next().value as string | undefined
      if (oldest === undefined) break
      this.checkedThreads.delete(oldest)
    }
  }

  private async migrate(threadId: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt += 1) {
      if (signal.aborted) throw new LegacySubagentMigrationCancelledError()
      const stats = await this.parser.parse(
        threadId,
        async (rows: readonly LegacySubagentMigrationRow[]) => {
          if (signal.aborted) throw new LegacySubagentMigrationCancelledError()
          const result = await withSubagentTranscriptContentMutationLock(async () => {
            const inserted = this.database.insertBatch(threadId, rows)
            if (inserted.insertedRows > 0) this.onReferenceMutation()
            return inserted
          })
          if (!result.threadExists) throw new Error("Thread not found")
          // A partial migration is already a durable reference mutation. Its
          // epoch bump happens in the same short global-lock section as the DB
          // insert, while parsing and sidecar I/O remain outside that lock.
          // Every DB transaction is complete before yielding. Other threads may
          // write now; the caller's per-thread lock keeps this thread coherent.
          await yieldMainProcess()
        },
        signal
      )
      if (signal.aborted) throw new LegacySubagentMigrationCancelledError()
      if (stats.finalization === "missing") throw new Error("Thread not found")
      if (stats.finalization === "changed") {
        await yieldMainProcess()
        continue
      }
      if (stats.finalization === "removed") {
        await withSubagentTranscriptContentMutationLock(async () => {
          this.onReferenceMutation()
        })
      }
      this.rememberChecked(threadId)
      return
    }
    throw new Error("Legacy subagent transcript changed repeatedly during migration; retry")
  }
}

const defaultCoordinator = new LegacySubagentMigrationCoordinator()

export function ensureLegacySubagentTranscriptRows(threadId: string): Promise<void> {
  return defaultCoordinator.ensure(threadId)
}

export function cancelLegacySubagentTranscriptMigration(threadId: string): void {
  defaultCoordinator.cancel(threadId)
}

export function forgetLegacySubagentTranscriptMigration(threadId: string): void {
  defaultCoordinator.forget(threadId)
}

export function cancelAllLegacySubagentTranscriptMigrations(): void {
  defaultCoordinator.cancelAll()
}

export function closeLegacySubagentTranscriptMigrations(): Promise<void> {
  return defaultCoordinator.cancelAllAndWait()
}
