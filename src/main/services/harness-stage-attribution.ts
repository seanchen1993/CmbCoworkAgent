import {
  HarnessStageAttributionCache,
  type HarnessResolvedStage,
  type HarnessStageAttribution
} from "./harness-stage-attribution-cache"
import { HarnessStageWatchRegistry } from "./harness-stage-watch"
import { invalidateHarnessRunInspection } from "../harness-board/run-inspect-cache"

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
  const installing = harnessStageWatches.activate(project, feature)
  if (installing) await installing
  return cache.getForExecution(project, feature)
}

type StageObserver = (at: number, nodeName: string | null) => void
const observers = new Map<string, Set<StageObserver>>()
const pendingObservations = new Map<string, Set<Promise<unknown>>>()
interface ScheduledObservation {
  at: number
  timer?: ReturnType<typeof setTimeout>
  complete: () => void
}
const scheduledObservations = new Map<string, ScheduledObservation>()
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
    if (listeners.size === 0) {
      observers.delete(key)
      const scheduled = scheduledObservations.get(key)
      if (scheduled) {
        clearTimeout(scheduled.timer)
        scheduledObservations.delete(key)
        scheduled.complete()
      }
    }
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
  stage: HarnessResolvedStage | null,
  expectedVersion?: number
): boolean {
  const accepted = stage
    ? cache.prime(projectId, featureSlug, stage, expectedVersion)
    : cache.markDirty(projectId, featureSlug, expectedVersion)
  if (accepted) {
    publish(projectId, featureSlug, Date.now(), stage?.name.trim() || null)
  }
  return accepted
}

export function getHarnessStageAttributionVersion(
  projectId: string,
  featureSlug: string
): number | undefined {
  return cache.getVersion(projectId, featureSlug)
}

export function markHarnessStageAttributionDirty(
  projectId: string | undefined,
  featureSlug: string | undefined
): void {
  const project = projectId?.trim()
  const feature = featureSlug?.trim()
  if (!project || !feature || project.includes("\0") || feature.includes("\0")) return
  invalidateHarnessRunInspection(project, feature)
  cache.markDirty(project, feature)
  const key = observerKey(project, feature)
  if (!observers.has(key)) return
  let scheduled = scheduledObservations.get(key)
  if (!scheduled) {
    let complete!: () => void
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    scheduled = { at: Date.now(), complete }
    scheduledObservations.set(key, scheduled)
    trackObservation(project, feature, pending)
  } else {
    clearTimeout(scheduled.timer)
  }
  // Wait for the final filesystem event in a burst. Keep one tracked promise
  // across timer resets so telemetry settlement also waits for the trailing read.
  const observation = scheduled
  observation.timer = setTimeout(() => {
    scheduledObservations.delete(key)
    if (!observers.has(key)) return observation.complete()
    void cache.getForCodeGeneration(project, feature).then((stage) => {
      publish(project, feature, observation.at, stage.nodeName)
      observation.complete()
    }, observation.complete)
  }, 250)
  observation.timer.unref?.()
}

export function getHarnessStageAttributionForCodeGeneration(
  projectId: string,
  featureSlug: string
): Promise<HarnessStageAttribution> {
  return cache.getForCodeGeneration(projectId, featureSlug)
}
