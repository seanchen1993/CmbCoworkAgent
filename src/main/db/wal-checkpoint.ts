const pending = new Map<string, Promise<void>>()

/** Coalesce best-effort maintenance; deletion is already committed to the WAL. */
export function checkpointWalInBackground(databasePath: string): Promise<void> {
  const existing = pending.get(databasePath)
  if (existing) return existing
  const checkpoint = (async () => {
    const module = await import("./wal-checkpoint-worker?nodeWorker")
    const worker = module.default({ workerData: databasePath, name: "deletion-wal-checkpoint" })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void worker.terminate()
        reject(new Error("Background WAL checkpoint timed out"))
      }, 10_000)
      worker.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      worker.once("exit", (code) => {
        clearTimeout(timeout)
        if (code === 0) resolve()
        else reject(new Error(`Background WAL checkpoint exited with code ${code}`))
      })
    })
  })()
    .catch((error) => {
      // Never turn committed deletion into a retryable failure.
      console.warn("[DB] Background deletion checkpoint failed:", error)
    })
    .finally(() => {
      pending.delete(databasePath)
    })
  pending.set(databasePath, checkpoint)
  return checkpoint
}
