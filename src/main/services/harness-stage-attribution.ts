import {
  HarnessStageAttributionCache,
  type HarnessResolvedStage,
  type HarnessStageAttribution
} from "./harness-stage-attribution-cache"

const cache = new HarnessStageAttributionCache({
  // Keep the generic hook/runtime import path lightweight. The board service is
  // loaded only when a dirty code-generation entry actually needs inspection.
  resolver: async (projectId, featureSlug) => {
    const { resolveHarnessFeatureCurrentStage } = await import("../harness-board/service")
    return resolveHarnessFeatureCurrentStage(projectId, featureSlug)
  }
})

type StageObserver = (at: number, nodeName: string | null) => void
const observers = new Map<string, Set<StageObserver>>()
const pendingObservations = new Map<string, Set<Promise<unknown>>>()
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
  if (observers.has(observerKey(projectId, featureSlug))) {
    const at = Date.now()
    const pending = cache.getForCodeGeneration(projectId, featureSlug).then((stage) => {
      publish(projectId, featureSlug, at, stage.nodeName)
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
