import type { HarnessDeployUnitMapping } from "../../shared/harness-board-types"

type MappingListener = (projectId: string, slug: string, mappings: HarnessDeployUnitMapping[]) => void
const mappingListeners = new Set<MappingListener>()

export function onFeatureRepositoryMappingChange(listener: MappingListener): void {
  mappingListeners.add(listener)
}

export function publishFeatureRepositoryMappings(
  projectId: string, slug: string, mappings: HarnessDeployUnitMapping[]
): void {
  for (const listener of mappingListeners) listener(projectId, slug, mappings)
}

type CatalogListener = (projectId: string, featureSlugs: ReadonlySet<string>) => void
type CatalogReadObserver = () => (
  projectId: string, featureSlugs: ReadonlySet<string>, isCurrent: () => boolean
) => void | Promise<void>
const listeners = new Set<CatalogListener>()
const readObservers = new Set<CatalogReadObserver>()
const currentReads = new Map<string, symbol>()

export function onHarnessFeatureCatalogChange(listener: CatalogListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function observeHarnessFeatureCatalogReads(observer: CatalogReadObserver): () => void {
  readObservers.add(observer)
  return () => readObservers.delete(observer)
}

function publish(projectId: string, slugs: ReadonlySet<string>): void {
  for (const listener of listeners) {
    try {
      listener(projectId, slugs)
    } catch (error) {
      // The project mutation has already committed. A later catalog read can retry cleanup.
      console.error("[HarnessBoard] Feature catalog listener failed", error)
    }
  }
}

export function harnessProjectDeleted(projectId: string): void {
  currentReads.delete(projectId)
  publish(projectId, new Set())
}

/** Reads from the board, Bot and background reporter can finish out of order. */
export function beginHarnessFeatureCatalogRead(projectIds: readonly string[]) {
  const token = Symbol()
  const observations = [...readObservers].map((observe) => observe())
  for (const id of projectIds) currentReads.set(id, token)
  return {
    async observed(projectId: string, runs: { slug: string }[]): Promise<void> {
      const isCurrent = () => currentReads.get(projectId) === token
      if (!isCurrent() || (!listeners.size && !observations.length)) return
      const slugs = new Set(runs.map((run) => run.slug))
      publish(projectId, slugs)
      await Promise.all(observations.map((observe) => observe(projectId, slugs, isCurrent)))
    },
    finish() {
      for (const id of projectIds) if (currentReads.get(id) === token) currentReads.delete(id)
    }
  }
}

/** A successful but stale asynchronous access check must not recreate a removed follow. */
export async function withCurrentHarnessFeature<T, R>(
  projectId: string,
  slug: string,
  read: () => Promise<T>,
  commit: (result: T) => R
): Promise<R> {
  let removed = false
  const stop = onHarnessFeatureCatalogChange((id, slugs) => {
    if (id === projectId && !slugs.has(slug)) removed = true
  })
  try {
    const result = await read()
    if (removed) throw new Error("项目或 Feature 已删除，请刷新后重试")
    return commit(result)
  } finally {
    stop()
  }
}
