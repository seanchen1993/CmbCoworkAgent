import type { ModelConfig, Provider } from "@/types"
import type { ModelRoutingMode } from "../../../shared/thread-model-selection"

export interface ModelCatalogSnapshot {
  models: ModelConfig[]
  providers: Provider[]
  defaultModelId: string
  routingMode: ModelRoutingMode
}

let snapshot: ModelCatalogSnapshot | null = null
let request: { generation: number; promise: Promise<ModelCatalogSnapshot> } | null = null
let generation = 0
const listeners = new Set<() => void>()

export function readModelCatalogCache(): ModelCatalogSnapshot | null {
  return snapshot
}

export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(next: ModelCatalogSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

export function invalidateModelCatalogCache(): void {
  generation += 1
  request = null
}

export function revalidateModelCatalog(force = false): Promise<ModelCatalogSnapshot> {
  if (snapshot && !force) return Promise.resolve(snapshot)
  if (request) return request.promise

  const requestGeneration = ++generation
  const promise = window.api.models
    .getCatalog()
    .then((next) => {
      if (requestGeneration === generation) publish(next)
      return requestGeneration === generation ? next : (snapshot ?? next)
    })
    .finally(() => {
      if (request?.generation === requestGeneration) request = null
    })
  request = { generation: requestGeneration, promise }
  return promise
}

export function updateCachedRoutingMode(routingMode: ModelRoutingMode): void {
  if (!snapshot || snapshot.routingMode === routingMode) return
  publish({ ...snapshot, routingMode })
}

export function resetModelCatalogCacheForTests(): void {
  snapshot = null
  request = null
  generation = 0
  listeners.clear()
}
