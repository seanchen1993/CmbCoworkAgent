/** Stop waiting on work owned by a shared service when this caller is cancelled. */
export function waitForAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work

  const { promise, reject } = Promise.withResolvers<never>()
  const onAbort = () => reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()

  return Promise.race([promise, work])
    .then((result) => {
      signal.throwIfAborted()
      return result
    })
    .finally(() => signal.removeEventListener("abort", onAbort))
}
