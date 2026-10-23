/** Cancellation affects waiters, never an execution lease that has already been issued. */
export class HarnessInvocationSemaphore {
  private active = 0
  private readonly waiting: Array<{
    signal?: AbortSignal
    grant(): void
    abort(): void
  }> = []

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.active < this.limit) this.active++
    else {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          signal,
          grant: () => {
            signal?.removeEventListener("abort", waiter.abort)
            resolve()
          },
          abort: () => {
            const index = this.waiting.indexOf(waiter)
            if (index < 0) return
            this.waiting.splice(index, 1)
            signal?.removeEventListener("abort", waiter.abort)
            reject(signal?.reason)
          }
        }
        this.waiting.push(waiter)
        signal?.addEventListener("abort", waiter.abort, { once: true })
        if (signal?.aborted) waiter.abort()
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next.grant()
      else this.active--
    }
  }
}

export class HarnessInvocationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Harness adapter timed out after ${Math.round(timeoutMs / 1000)}s`)
    this.name = "HarnessInvocationTimeoutError"
  }
}

/** Starts before admission/preparation; disposing a deadline never un-aborts its signal. */
export function createHarnessInvocationDeadline(timeoutMs: number, source?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(source?.reason)
  source?.addEventListener("abort", abort, { once: true })
  if (source?.aborted) abort()
  const timer = setTimeout(
    () => controller.abort(new HarnessInvocationTimeoutError(timeoutMs)),
    timeoutMs
  )
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      source?.removeEventListener("abort", abort)
    }
  }
}

/** The caller still owns draining/cleanup of work that cannot physically be cancelled. */
export function waitForHarnessInvocation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    )
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
