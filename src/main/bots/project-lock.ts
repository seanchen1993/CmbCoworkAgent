const mutations = new Map<string, Promise<unknown>>()

/** Shared by file edits and commands across all Bots in this Host. Callers pass
 * canonical roots and revalidate their lease after acquiring the lock. */
export async function withBotProjectMutation<T>(
  root: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root
  let started = false
  const execution = (mutations.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      signal?.throwIfAborted()
      started = true
      return operation()
    })
    .finally(() => {
      if (mutations.get(key) === execution) mutations.delete(key)
    })
  mutations.set(key, execution)
  if (!signal) return execution
  return new Promise<T>((resolve, reject) => {
    // Only queued work can leave early. Started operations retain the lock until
    // the executor confirms process-tree cleanup, even after cancellation.
    const abort = () => {
      if (!started) reject(signal.reason ?? new Error("操作已取消"))
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    void execution.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
