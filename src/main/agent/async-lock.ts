type Waiter = { grant: () => void }

/** Queue a permit request without retaining cancelled callers or abort listeners. */
function enqueueWaiter(
  queue: Waiter[],
  acquire: () => void,
  drain: () => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      const index = queue.indexOf(waiter)
      if (index === -1) return
      queue.splice(index, 1)
      signal?.removeEventListener("abort", onAbort)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      // Removing the last waiting writer can unblock readers even while other
      // readers still hold the lock.
      drain()
    }
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort)
        acquire()
        resolve()
      }
    }
    queue.push(waiter)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Writer-preferring async read-write lock with abortable acquisition. */
export class AsyncRWLock {
  private readers = 0
  private writerHeld = false
  private writerQueue: Waiter[] = []
  private readerQueue: Waiter[] = []

  async read<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquireRead(signal)
    try {
      // Acquisition resolves before this continuation runs. Cancel may arrive
      // in that gap, so check inside the finally-protected lock ownership.
      signal?.throwIfAborted()
      return await task()
    } finally {
      this.readers--
      this.drain()
    }
  }

  async write<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquireWrite(signal)
    try {
      signal?.throwIfAborted()
      return await task()
    } finally {
      this.writerHeld = false
      this.drain()
    }
  }

  private acquireRead(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!this.writerHeld && this.writerQueue.length === 0) {
      this.readers++
      return Promise.resolve()
    }
    return enqueueWaiter(
      this.readerQueue,
      () => this.readers++,
      () => this.drain(),
      signal
    )
  }

  private acquireWrite(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!this.writerHeld && this.readers === 0) {
      this.writerHeld = true
      return Promise.resolve()
    }
    return enqueueWaiter(
      this.writerQueue,
      () => {
        this.writerHeld = true
      },
      () => this.drain(),
      signal
    )
  }

  private drain(): void {
    if (this.writerHeld) return
    if (this.writerQueue.length > 0) {
      if (this.readers === 0) this.writerQueue.shift()!.grant()
      return
    }
    for (const waiter of this.readerQueue.splice(0)) waiter.grant()
  }
}

/** Bounded task concurrency with the same cancellation contract as the lock. */
export class AsyncSemaphore {
  private active = 0
  private queue: Waiter[] = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      signal?.throwIfAborted()
      return await task()
    } finally {
      this.active--
      this.drain()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return enqueueWaiter(
      this.queue,
      () => this.active++,
      () => this.drain(),
      signal
    )
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) this.queue.shift()!.grant()
  }
}
