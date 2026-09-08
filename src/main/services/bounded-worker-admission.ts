interface WorkerAdmissionWaiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abortListener?: () => void
}

/**
 * Bounds both live background workers and the promises retaining their input while waiting.
 * A queued abort is removed synchronously, so latest-intent cancellation also releases capacity.
 */
export class BoundedWorkerAdmission {
  private active = 0
  private readonly waiters: WorkerAdmissionWaiter[] = []

  constructor(
    readonly maxActive: number,
    readonly maxWaiters: number,
    private readonly label: string
  ) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new Error("Worker admission maxActive must be a positive integer")
    }
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0) {
      throw new Error("Worker admission maxWaiters must be a non-negative integer")
    }
  }

  get activeCount(): number {
    return this.active
  }

  get waiterCount(): number {
    return this.waiters.length
  }

  get admittedCount(): number {
    return this.active + this.waiters.length
  }

  acquire(signal?: AbortSignal, cancelledError?: () => Error): Promise<() => void> {
    const cancellation = (): Error =>
      cancelledError?.() ??
      (signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error(`${this.label} was cancelled`), { name: "AbortError" }))
    if (signal?.aborted) return Promise.reject(cancellation())
    if (this.active < this.maxActive) {
      this.active += 1
      return Promise.resolve(this.createRelease())
    }
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(
        Object.assign(new Error(`${this.label} capacity exceeded`), {
          name: "WORKER_ADMISSION_CAPACITY_EXCEEDED"
        })
      )
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: WorkerAdmissionWaiter = { resolve, reject, signal }
      if (signal) {
        waiter.abortListener = () => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          reject(cancellation())
        }
        signal.addEventListener("abort", waiter.abortListener, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!
        if (waiter.signal && waiter.abortListener) {
          waiter.signal.removeEventListener("abort", waiter.abortListener)
        }
        if (waiter.signal?.aborted) {
          waiter.reject(
            waiter.signal.reason instanceof Error
              ? waiter.signal.reason
              : Object.assign(new Error(`${this.label} was cancelled`), { name: "AbortError" })
          )
          continue
        }
        // The released active slot transfers directly to this waiter.
        waiter.resolve(this.createRelease())
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }
}
