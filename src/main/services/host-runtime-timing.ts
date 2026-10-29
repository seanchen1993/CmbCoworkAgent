import { AsyncLocalStorage } from "node:async_hooks"
import { performance } from "node:perf_hooks"

const buckets = [
  "authority", "threadRead", "hostFacts", "snapshot", "inputs",
  "describeTools", "composePrompt", "policyQueue", "streamGuard", "streamFrame", "streamPull"
] as const
type Bucket = typeof buckets[number]
type Metric = { calls: number; ms: number }
type State = { round: number; metrics: Record<Bucket, Metric> }
const observations = new AsyncLocalStorage<State>()
const slowMs = 250
const noop = () => {}
const empty = (): Record<Bucket, Metric> => Object.fromEntries(
  buckets.map(bucket => [bucket, { calls: 0, ms: 0 }])
) as Record<Bucket, Metric>

/** Observation only: inherits the existing physical Host run, never grants or owns execution. */
export function withHostRuntimeTiming<T>(work: () => T): T {
  return observations.run({ round: 0, metrics: empty() }, () => {
    const finish = () => reportHostRuntimeTiming(0, false, "settlement")
    try {
      const result = work()
      if (result instanceof Promise) return result.finally(finish) as T
      finish()
      return result
    } catch (error) {
      finish()
      throw error
    }
  })
}

export function startHostRuntimeTiming(bucket: Bucket): () => void {
  const state = observations.getStore()
  if (!state) return noop
  const started = performance.now()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const metric = state.metrics[bucket]
    metric.calls++
    metric.ms += Math.max(0, performance.now() - started)
  }
}

export function measureHostRuntimeSync<T>(bucket: Bucket, work: () => T): T {
  if (!observations.getStore()) return work()
  const finish = startHostRuntimeTiming(bucket)
  try { return work() } finally { finish() }
}

export async function measureHostRuntimeAsync<T>(bucket: Bucket, work: () => Promise<T>): Promise<T> {
  if (!observations.getStore()) return work()
  const finish = startHostRuntimeTiming(bucket)
  try { return await work() } finally { finish() }
}

/** Samples completed since the previous request; durations may overlap/nest, never sum them.
 * Flush before provider IO, so model thinking is excluded from preparationMs. No task content,
 * paths, configuration, errors or externally supplied labels are accepted by this logger.
 */
export function reportHostRuntimeTiming(
  preparationMs: number, failed = false, phase: "preparation" | "settlement" = "preparation"
): void {
  const state = observations.getStore()
  if (!state) return
  const metrics = state.metrics
  state.metrics = empty()
  state.round++
  if (preparationMs < slowMs && buckets.every(bucket => metrics[bucket].ms < slowMs)) return
  const bounded = (value: number) => Number.isFinite(value)
    ? Math.round(Math.min(86_400_000, Math.max(0, value)) * 10) / 10 : 86_400_000
  try {
    console.info("[HostRuntimeTiming]", JSON.stringify({
      round: Math.min(state.round, 1_000_000), preparationMs: bounded(preparationMs),
      failed: Number(failed), inclusive: 1, phase,
      ...Object.fromEntries(buckets.map(bucket => [bucket, {
        calls: Math.min(metrics[bucket].calls, 1_000_000), ms: bounded(metrics[bucket].ms)
      }]))
    }))
  } catch { /* Diagnostics must never change the original run outcome. */ }
}
