import { retainHostStream } from "../mods/v2/host-stream-lifetime"

/** Main-process admission only. Tokens follow actual cleanup, never an abort notification. */
export class PluginCatalogGate {
  private readonly active = new Set<object>()
  private committing = false
  private readonly idleWaiters = new Set<() => void>()

  get activityCount(): number {
    return this.active.size
  }

  assertAdmission(): void {
    if (this.committing) throw new Error("PLUGIN_CATALOG_APPLYING")
  }

  retain(): () => void {
    this.assertAdmission()
    return this.retainRetirement()
  }

  /** Only already-owned host cleanup may enter during catalog invalidation. */
  retainRetirement(): () => void {
    const token = {}
    this.active.add(token)
    return () => {
      if (!this.active.delete(token) || this.active.size) return
      for (const wake of [...this.idleWaiters]) wake()
    }
  }

  async run<T>(operation: () => Promise<T>, retainDispose = false): Promise<T> {
    const release = this.retain()
    let transferred = false
    try {
      const value = await operation()
      if (
        retainDispose &&
        value &&
        typeof value === "object" &&
        "dispose" in value &&
        typeof value.dispose === "function"
      ) {
        const dispose = value.dispose.bind(value)
        const wrapped = {
          ...value,
          dispose: () => {
            try {
              const result: unknown = dispose()
              if (result && typeof result === "object" && "then" in result)
                return Promise.resolve(result).finally(release)
              release()
              return result
            } catch (error) {
              release()
              throw error
            }
          }
        }
        transferred = true
        return wrapped as T
      }
      if (
        value &&
        typeof value === "object" &&
        typeof (value as unknown as AsyncGenerator)[Symbol.asyncIterator] === "function" &&
        typeof (value as unknown as AsyncGenerator).next === "function"
      ) {
        const stream = retainHostStream(value as unknown as AsyncGenerator, (run) => run(), release)
        transferred = true
        return stream as T
      }
      return value
    } finally {
      if (!transferred) release()
    }
  }

  /** Wait only for admission; the synchronous operation is entered at most once. */
  commitWhenIdle<T>(
    assertIdle: () => void,
    operation: () => T,
    options: { signal: AbortSignal; assertCurrent: () => void; timeoutMs?: number }
  ): Promise<T> {
    const deadline = performance.now() + (options.timeoutMs ?? 2000)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let checking = false
      let operationStarted = false
      const cleanupAdmission = () => {
        this.idleWaiters.delete(attempt)
        options.signal.removeEventListener("abort", cancel)
        clearInterval(timer)
        clearTimeout(timeout)
      }
      const finish = (error?: unknown, value?: T, failed = false) => {
        if (settled) return
        settled = true
        cleanupAdmission()
        if (failed) reject(error)
        else resolve(value as T)
      }
      const cancel = () => {
        try { options.signal.throwIfAborted() }
        catch (error) { finish(error, undefined, true) }
      }
      const attempt = () => {
        if (settled || checking) return
        checking = true
        try {
          options.signal.throwIfAborted()
          if (performance.now() >= deadline) throw Error("PLUGIN_CATALOG_BUSY")
          options.assertCurrent()
        } catch (error) {
          checking = false
          finish(error, undefined, true)
          return
        }
        try {
          // New admissions stay open while existing work drains, including nested calls.
          if (this.active.size || this.committing) return
          const value = this.commit(assertIdle, () => {
            options.signal.throwIfAborted()
            options.assertCurrent()
            options.signal.throwIfAborted()
            if (performance.now() >= deadline) throw Error("PLUGIN_CATALOG_BUSY")
            operationStarted = true
            // Admission is complete. Later abort cannot hide a real operation result/write.
            cleanupAdmission()
            return operation()
          })
          finish(undefined, value)
        } catch (error) {
          // Only admission can be retried. A BUSY thrown by a write is terminal too.
          if (operationStarted || performance.now() >= deadline || !(error instanceof Error) ||
            error.message !== "PLUGIN_CATALOG_BUSY") finish(error, undefined, true)
        } finally { checking = false }
      }
      this.idleWaiters.add(attempt)
      options.signal.addEventListener("abort", cancel, { once: true })
      const timer = setInterval(attempt, 25)
      const timeout = setTimeout(() => finish(Error("PLUGIN_CATALOG_BUSY"), undefined, true),
        Math.max(0, deadline - performance.now()))
      attempt()
    })
  }

  /** All asynchronous preparation must finish before this synchronous critical section. */
  commit<T>(assertIdle: () => void, operation: () => T): T {
    this.assertAdmission()
    if (this.active.size) throw new Error("PLUGIN_CATALOG_BUSY")
    this.committing = true
    try {
      assertIdle()
      if (this.active.size) throw new Error("PLUGIN_CATALOG_BUSY")
      const value = operation()
      if (value && (typeof value === "object" || typeof value === "function") && "then" in value)
        throw new Error("PLUGIN_CATALOG_ASYNC_COMMIT")
      return value
    } finally {
      this.committing = false
    }
  }
}

export const pluginCatalogGate = new PluginCatalogGate()

/** Explicit native Promise entry points; synchronous APIs keep their original calling contract. */
export function guardPluginCatalogOperations<T extends object>(
  target: T,
  names: ReadonlyArray<keyof T>,
  disposeNames: ReadonlyArray<keyof T> = []
): void {
  for (const name of names) {
    const method = target[name]
    if (typeof method !== "function") throw Error("PLUGIN_CATALOG_ENTRY_INVALID")
    Object.defineProperty(target, name, {
      configurable: true,
      value: (...args: unknown[]) =>
        pluginCatalogGate.run(
          () => Reflect.apply(method, target, args),
          disposeNames.includes(name)
        )
    })
  }
}
