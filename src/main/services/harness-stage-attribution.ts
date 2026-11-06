import {
  HarnessStageAttributionCache,
  type HarnessResolvedStage,
  type HarnessStageAttribution
} from "./harness-stage-attribution-cache"
import { HarnessStageWatchRegistry } from "./harness-stage-watch"

async function resolveCurrentStage(projectId: string, featureSlug: string) {
  // Keep the generic hook/runtime import path lightweight. The board service is
  // loaded only when a bound invocation or dirty attribution needs inspection.
  const { resolveHarnessFeatureCurrentStage } = await import("../harness-board/service")
  return resolveHarnessFeatureCurrentStage(projectId, featureSlug, { watch: true })
}

const cache = new HarnessStageAttributionCache({ resolver: resolveCurrentStage })
export const harnessStageWatches = new HarnessStageWatchRegistry(markHarnessStageAttributionDirty)

/**
 * Commands and hooks read after queue admission. Reuse the shared snapshot and
 * in-flight lookup; state notifications invalidate it and a five-minute TTL
 * covers adapters without notifications. Ordinary tools/hooks do not invalidate.
 * Undefined means unbound (keep explicit caller context); null fields mean a
 * bound feature could not be resolved (clear the previous turn's stage).
 * Reading does not increment the version: overlapping calls retain their own
 * call-start attribution and must not be invalidated just by another reader.
 */
export async function resolveHarnessExecutionStage(
  projectId?: string,
  featureSlug?: string
): Promise<HarnessStageAttribution | undefined> {
  const project = projectId?.trim()
  const feature = featureSlug?.trim()
  if (!project || !feature) return undefined
  await harnessStageWatches.activate(project, feature)
  return cache.getForExecution(project, feature)
}

type StageObserver = (at: number, nodeName: string | null) => void
const observers = new Map<string, Set<StageObserver>>()
const pendingObservations = new Map<string, Set<Promise<unknown>>>()
const scheduledObservations = new Set<string>()
const observerKey = (projectId: string, featureSlug: string): string =>
  `${projectId}\0${featureSlug}`

function trackObservation(projectId: string, featureSlug: string, pending: Promise<unknown>): void {
  const key = observerKey(projectId, featureSlug)
  if (!observers.has(key)) return
  const tasks = pendingObservations.get(key) ?? new Set<Promise<unknown>>()
  tasks.add(pending)
  pendingObservations.set(key, tasks)
  const remove = (): void => {
    tasks.delete(pending)
    if (tasks.size === 0) pendingObservations.delete(key)
  }
  void pending.then(remove, remove)
}

export async function settleHarnessStageObservations(
  projectId: string,
  featureSlug: string,
  timeoutMs: number
): Promise<boolean> {
  const tasks = pendingObservations.get(observerKey(projectId, featureSlug))
  if (!tasks?.size) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled([...tasks]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function observeHarnessStage(
  projectId: string,
  featureSlug: string,
  observer: StageObserver
): () => void {
  const key = observerKey(projectId, featureSlug)
  const listeners = observers.get(key) ?? new Set<StageObserver>()
  listeners.add(observer)
  observers.set(key, listeners)
  return () => {
    listeners.delete(observer)
    if (listeners.size === 0) observers.delete(key)
  }
}

function publish(
  projectId: string,
  featureSlug: string,
  at: number,
  nodeName: string | null
): void {
  for (const observer of observers.get(observerKey(projectId, featureSlug)) ?? []) {
    try {
      observer(at, nodeName)
    } catch {
      // Telemetry observers must never affect model/tool execution.
    }
  }
}

export type { HarnessStageAttribution }

export function getHarnessStageAttributionForCall(
  projectId: string,
  featureSlug: string
): Promise<HarnessStageAttribution> {
  const at = Date.now()
  const pending = cache.getForCall(projectId, featureSlug).then((stage) => {
    publish(projectId, featureSlug, at, stage.nodeName)
    return stage
  })
  trackObservation(projectId, featureSlug, pending)
  return pending
}

export function primeHarnessStageAttribution(
  projectId: string,
  featureSlug: string,
  stage: HarnessResolvedStage | null
): void {
  if (stage) {
    cache.prime(projectId, featureSlug, stage)
    publish(projectId, featureSlug, Date.now(), stage.name)
  } else {
    cache.markDirty(projectId, featureSlug)
    publish(projectId, featureSlug, Date.now(), null)
  }
}

export function markHarnessStageAttributionDirty(
  projectId: string | undefined,
  featureSlug: string | undefined
): void {
  if (!projectId || !featureSlug) return
  cache.markDirty(projectId, featureSlug)
  const key = observerKey(projectId, featureSlug)
  if (observers.has(key) && !scheduledObservations.has(key)) {
    const at = Date.now()
    scheduledObservations.add(key)
    // Collapse filesystem bursts. An execution before this timer can refresh
    // immediately; this observer then reuses its result without another inspect.
    const pending = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        scheduledObservations.delete(key)
        if (!observers.has(key)) return resolve()
        void cache.getForCodeGeneration(projectId, featureSlug).then((stage) => {
          publish(projectId, featureSlug, at, stage.nodeName)
          resolve()
        })
      }, 250)
      timer.unref?.()
    })
    trackObservation(projectId, featureSlug, pending)
  }
}

export function getHarnessStageAttributionForCodeGeneration(
  projectId: string,
  featureSlug: string
): Promise<HarnessStageAttribution> {
  return cache.getForCodeGeneration(projectId, featureSlug)
}
