import {
  resolveCheckpointDatabaseIdentity,
  assertCheckpointDatabasePathCurrent,
  assertCheckpointDatabaseFileIdentity,
  type CheckpointDatabaseIdentity,
  type CheckpointDatabaseFileIdentity
} from "../checkpointer/checkpoint-database-identity"

const pending = new Map<string, Promise<void>>()

export interface WalCheckpointOptions {
  readonly freshAfterCurrent: true
  readonly identity: CheckpointDatabaseIdentity
  readonly file: CheckpointDatabaseFileIdentity
}
export interface WalCheckpointWorkerData {
  readonly databasePath: string
  readonly file: CheckpointDatabaseFileIdentity
}

function warning(error: unknown): void {
  // A logging observer must not turn committed data into a retryable operation.
  try {
    console.warn("[DB] Background deletion checkpoint failed:", error)
  } catch {
    /* Observer only. */
  }
}

/** Best-effort maintenance. Every returned promise still waits for physical Worker exit. */
export async function checkpointWalInBackground(
  databasePath: string,
  options?: WalCheckpointOptions
): Promise<void> {
  try {
    // Own the fixed Main inputs before resolution, queueing or module loading can yield.
    const original = options
      ? Object.freeze({
          freshAfterCurrent: options.freshAfterCurrent,
          identity: Object.freeze({
            key: options.identity.key,
            path: options.identity.path,
            logicalPath: options.identity.logicalPath,
            group: options.identity.group,
            capturedFile: undefined
          }),
          file: Object.freeze({
            dev: options.file.dev,
            ino: options.file.ino,
            birthtime: options.file.birthtime
          })
        })
      : undefined
    const identity =
      original?.identity ??
      (await resolveCheckpointDatabaseIdentity(databasePath, { createParent: false }))
    const file = original?.file ?? identity.capturedFile
    if (!file) throw Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
    const fixedFile = Object.freeze({ dev: file.dev, ino: file.ino, birthtime: file.birthtime })
    const key = identity.key
    const previous = pending.get(key)
    if (previous && !original?.freshAfterCurrent) {
      await previous
      return
    }
    const checkpoint: Promise<void> = (async () => {
      // A reserve committed after the previous Worker began needs a genuinely fresh round.
      if (previous) await previous
      const module = await import("./wal-checkpoint-worker?nodeWorker")
      await assertCheckpointDatabasePathCurrent(identity)
      await assertCheckpointDatabaseFileIdentity(identity.path, fixedFile)
      const worker = module.default({
        workerData: {
          databasePath: identity.path,
          file: fixedFile
        } satisfies WalCheckpointWorkerData,
        name: "deletion-wal-checkpoint"
      })
      await new Promise<void>((resolve, reject) => {
        let failure: Error | undefined
        let terminating = false
        const terminate = () => {
          if (terminating) return
          terminating = true
          try {
            void worker.terminate().catch(() => undefined)
          } catch {
            /* Exit remains required. */
          }
        }
        const timeout = setTimeout(() => {
          failure ??= Error("Background WAL checkpoint timed out")
          terminate()
        }, 10_000)
        worker.once("error", (error) => {
          failure ??= error
          terminate()
        })
        worker.once("exit", (code) => {
          clearTimeout(timeout)
          if (failure) reject(failure)
          else if (code === 0) resolve()
          else reject(Error(`Background WAL checkpoint exited with code ${code}`))
        })
      })
      await assertCheckpointDatabasePathCurrent(identity)
      await assertCheckpointDatabaseFileIdentity(identity.path, fixedFile)
    })()
      .catch(warning)
      .finally(() => {
        // A late completion must not remove the fresh request waiting behind this one.
        if (pending.get(key) === checkpoint) pending.delete(key)
      })
    pending.set(key, checkpoint)
    await checkpoint
  } catch (error) {
    // Startup/resolution may fail before a Worker exists. Nothing committed is replayed.
    warning(error)
  }
}
