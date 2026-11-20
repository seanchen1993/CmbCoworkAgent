export interface BoundedTaskContext {
  /** False after the queue advances to a newer generation or is disposed. */
  isCurrent: () => boolean
}

export interface BoundedLatestTaskQueue<TKey, TValue> {
  enqueue: (key: TKey, value: TValue) => void
  cancelPending: () => void
  dispose: () => void
  onIdle: () => Promise<void>
}

interface PendingTask<TKey, TValue> {
  key: TKey
  value: TValue
  generation: number
}

/**
 * Runs keyed async work with a hard concurrency ceiling. A queued value for the
 * same key replaces the older queued value, while active work remains serialized
 * per key. Advancing the generation makes active task results stale and drops all
 * work that has not started yet.
 */
export function createBoundedLatestTaskQueue<TKey, TValue>(
  requestedConcurrency: number,
  worker: (value: TValue, context: BoundedTaskContext) => Promise<void>
): BoundedLatestTaskQueue<TKey, TValue> {
  const concurrency = Math.max(1, Math.trunc(requestedConcurrency))
  const pending = new Map<TKey, PendingTask<TKey, TValue>>()
  const pendingOrder: TKey[] = []
  const activeKeys = new Set<TKey>()
  const idleWaiters = new Set<() => void>()
  let activeCount = 0
  let generation = 0
  let disposed = false

  const isIdle = (): boolean => activeCount === 0 && pending.size === 0

  const resolveIdle = (): void => {
    if (!isIdle()) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const takeNext = (): PendingTask<TKey, TValue> | null => {
    const blockedKeys: TKey[] = []
    let task: PendingTask<TKey, TValue> | undefined

    while (pendingOrder.length > 0) {
      const key = pendingOrder.shift()!
      const candidate = pending.get(key)
      if (!candidate) continue
      if (activeKeys.has(key)) {
        blockedKeys.push(key)
        continue
      }
      pending.delete(key)
      task = candidate
      break
    }

    pendingOrder.unshift(...blockedKeys)
    return task ?? null
  }

  const drain = (): void => {
    if (disposed) {
      resolveIdle()
      return
    }

    while (activeCount < concurrency) {
      const task = takeNext()
      if (!task) break
      activeCount += 1
      activeKeys.add(task.key)

      const taskGeneration = task.generation
      void Promise.resolve()
        .then(() =>
          worker(task.value, {
            isCurrent: () => !disposed && taskGeneration === generation
          })
        )
        .catch(() => undefined)
        .finally(() => {
          activeCount -= 1
          activeKeys.delete(task.key)
          drain()
          resolveIdle()
        })
    }

    resolveIdle()
  }

  return {
    enqueue(key, value) {
      if (disposed) return
      if (!pending.has(key)) pendingOrder.push(key)
      pending.set(key, { key, value, generation })
      drain()
    },
    cancelPending() {
      if (disposed) return
      generation += 1
      pending.clear()
      pendingOrder.length = 0
      resolveIdle()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      pending.clear()
      pendingOrder.length = 0
      resolveIdle()
    },
    onIdle() {
      if (isIdle()) return Promise.resolve()
      return new Promise<void>((resolve) => idleWaiters.add(resolve))
    }
  }
}
