export const LEGACY_WRITER_BATCH_BYTES = 1024 * 1024
export const LEGACY_WRITER_BATCH_MS = 25

/** Allow an already waiting SQLite connection to acquire the next write lock. */
export function createLegacyWriterTurn(cancellation?: Int32Array) {
  const signal = cancellation ?? new Int32Array(new SharedArrayBuffer(4))
  let releasedAt = -Infinity
  return {
    released() {
      releasedAt = performance.now()
    },
    wait() {
      const remaining = releasedAt + LEGACY_WRITER_BATCH_MS - performance.now()
      if (remaining > 0) Atomics.wait(signal, 0, 0, remaining)
    }
  }
}
