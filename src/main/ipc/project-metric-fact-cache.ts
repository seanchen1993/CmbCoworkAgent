import {
  DashboardRequestCancelledError,
  dashboardRequestContext,
  getDashboardRequestSignal
} from "../services/dashboard-request-coordinator"
import { ProjectModePageCache } from "./project-mode-page-cache"

type Fact = Record<string, unknown>

interface SharedLoad<T> {
  promise: Promise<T>
  controller: AbortController
  consumers: number
}

export interface SharedDashboardCacheOptions<T> {
  maxEntries?: number
  maxEntryBytes?: number
  maxTotalBytes?: number
  ttlMs?: number
  measureBytes?: (value: T) => number
}

/**
 * Deduplicates concurrent in-flight loads and caches completed results while
 * preserving per-caller AbortSignal cancellation: cancelling one caller rejects
 * only that caller, and cancelling the last caller aborts the shared query.
 */
export class SharedDashboardCache<T> {
  private readonly completed: ProjectModePageCache<T>
  private readonly loading = new Map<string, SharedLoad<T>>()

  constructor(options: SharedDashboardCacheOptions<T> = {}) {
    this.completed = new ProjectModePageCache<T>(
      options.maxEntries ?? 6,
      options.maxEntryBytes ?? 4 * 1024 * 1024,
      options.maxTotalBytes ?? Math.max(4 * 1024 * 1024, options.maxEntryBytes ?? 4 * 1024 * 1024),
      options.ttlMs ?? 30_000,
      options.measureBytes
    )
  }

  peek(key: string): T | undefined {
    return this.completed.get(key)
  }

  async read(key: string, load: () => Promise<T>): Promise<T> {
    const signal = getDashboardRequestSignal()
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    const cached = this.completed.get(key)
    if (cached !== undefined) return cached

    let active = this.loading.get(key)
    if (!active) {
      const controller = new AbortController()
      const promise = dashboardRequestContext
        .run({ signal: controller.signal }, load)
        .then((value) => {
          if (!controller.signal.aborted) this.completed.set(key, value)
          return value
        })
        .finally(() => {
          if (this.loading.get(key)?.controller === controller) this.loading.delete(key)
        })
      // Avoid unhandled rejection if the shared load settles after all callers aborted.
      promise.catch(() => {})
      active = { promise, controller, consumers: 0 }
      this.loading.set(key, active)
    }

    active.consumers++
    let onAbort: (() => void) | undefined
    try {
      if (!signal) return await active.promise
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DashboardRequestCancelledError())
        signal.addEventListener("abort", onAbort, { once: true })
      })
      return await Promise.race([active.promise, cancelled])
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort)
      active.consumers--
      if (!active.consumers && this.loading.get(key) === active) {
        this.loading.delete(key)
        active.controller.abort()
      }
    }
  }
}

/** Fast byte estimate for plain fact rows, avoiding v8.serialize stalls on large arrays. */
export function estimateFactArrayBytes(rows: readonly Fact[]): number {
  let bytes = 64
  for (const row of rows) {
    bytes += 128
    for (const value of Object.values(row)) {
      if (typeof value === "string") bytes += value.length * 2 + 16
      else if (Array.isArray(value)) bytes += value.length * 24 + 32
      else bytes += 16
    }
  }
  return bytes
}

const caches = new WeakMap<object, SharedDashboardCache<Fact[]>>()

function factCacheFor(query: object): SharedDashboardCache<Fact[]> {
  let cache = caches.get(query)
  if (!cache) {
    cache = new SharedDashboardCache<Fact[]>({
      maxEntries: 10,
      maxEntryBytes: 16 * 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      ttlMs: 30_000,
      measureBytes: estimateFactArrayBytes
    })
    caches.set(query, cache)
  }
  return cache
}

export function peekCachedProjectMetricFacts(query: object, key: string): Fact[] | undefined {
  return caches.get(query)?.peek(key)
}

export function readCachedProjectMetricFacts(
  query: object,
  key: string,
  load: () => Promise<Fact[]>
): Promise<Fact[]> {
  return factCacheFor(query).read(key, load)
}
