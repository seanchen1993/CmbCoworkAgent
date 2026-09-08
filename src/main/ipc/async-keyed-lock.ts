export interface AsyncKeyedLockOptions {
  /** Queued callers per key, excluding the operation currently holding the key. */
  maxWaitersPerKey?: number
  /** Queued callers across all keys, excluding currently executing operations. */
  maxWaitersTotal?: number
  label?: string
}

export const ASYNC_KEYED_LOCK_CAPACITY_ERROR_CODE =
  "ASYNC_KEYED_LOCK_CAPACITY_EXCEEDED"

export class AsyncKeyedLockCapacityError extends Error {
  readonly code = ASYNC_KEYED_LOCK_CAPACITY_ERROR_CODE

  constructor(
    readonly key: string,
    readonly scope: "key" | "global",
    label: string
  ) {
    super(
      `${label} capacity exceeded (${scope === "key" ? `key: ${key}` : "global waiters"})`
    )
    this.name = "AsyncKeyedLockCapacityError"
  }
}

function normalizeWaiterLimit(value: number | undefined): number {
  if (value === undefined || value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY
  }
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

export class AsyncKeyedLock {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly waiterCountByKey = new Map<string, number>()
  private readonly maxWaitersPerKey: number
  private readonly maxWaitersTotal: number
  private readonly label: string
  private waiterCount = 0

  constructor(options: AsyncKeyedLockOptions = {}) {
    this.maxWaitersPerKey = normalizeWaiterLimit(options.maxWaitersPerKey)
    this.maxWaitersTotal = normalizeWaiterLimit(options.maxWaitersTotal)
    this.label = options.label?.trim() || "Async keyed lock"
  }

  async withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key)
    const waiting = prior !== undefined
    if (waiting) {
      const keyWaiters = this.waiterCountByKey.get(key) ?? 0
      if (keyWaiters >= this.maxWaitersPerKey) {
        throw new AsyncKeyedLockCapacityError(key, "key", this.label)
      }
      if (this.waiterCount >= this.maxWaitersTotal) {
        throw new AsyncKeyedLockCapacityError(key, "global", this.label)
      }
      this.waiterCountByKey.set(key, keyWaiters + 1)
      this.waiterCount += 1
    }
    const previous = prior ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous
      .catch(() => undefined)
      .then(() => current)

    this.pending.set(key, queued)
    try {
      await previous.catch(() => undefined)
    } finally {
      if (waiting) {
        const remainingForKey = (this.waiterCountByKey.get(key) ?? 1) - 1
        if (remainingForKey <= 0) this.waiterCountByKey.delete(key)
        else this.waiterCountByKey.set(key, remainingForKey)
        this.waiterCount = Math.max(0, this.waiterCount - 1)
      }
    }

    try {
      return await fn()
    } finally {
      release()
      if (this.pending.get(key) === queued) {
        this.pending.delete(key)
      }
    }
  }

  has(key: string): boolean {
    return this.pending.has(key)
  }

  get waitingCount(): number {
    return this.waiterCount
  }

  waitingCountForKey(key: string): number {
    return this.waiterCountByKey.get(key) ?? 0
  }
}
