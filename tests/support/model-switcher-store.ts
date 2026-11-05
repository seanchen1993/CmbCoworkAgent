import { useSyncExternalStore } from "react"
import { create } from "zustand"
import type { ModelConfig } from "../../src/renderer/src/types"

export const localModels: ModelConfig[] = [
  {
    id: "custom:local-a",
    name: "Local A",
    model: "model-a",
    provider: "custom",
    source: "custom",
    available: true,
    tier: "premium"
  },
  {
    id: "custom:local-b",
    name: "Local B",
    model: "model-b",
    provider: "custom",
    source: "custom",
    available: true,
    tier: "economy"
  }
]

type Metadata = Record<string, unknown>
export const useAppStore = create(() => ({
  models: localModels,
  threads: [{ thread_id: "imported", metadata: {} as Metadata }],
  loadModels: async () => {}
}))
const listeners = new Set<() => void>()
let currentModel = ""
let catalog: { routingMode: "auto" | "pinned"; defaultModelId: string } | null = null
export const writes: string[] = []
const routingWrites: Array<"auto" | "pinned"> = []
export const persistRoutingMode = async (mode: "auto" | "pinned"): Promise<void> => {
  routingWrites.push(mode)
}
export const readRoutingWrites = () => [...routingWrites]

function publish(): void {
  for (const listener of listeners) listener()
}

const actions = {
  restoreCurrentModel(modelId: string) {
    if (currentModel === modelId) return
    currentModel = modelId
    publish()
  },
  setCurrentModel(modelId: string) {
    // Deliberately leave metadata stale, as while an IPC write is pending or fails.
    writes.push(modelId)
    actions.restoreCurrentModel(modelId)
  }
}

export const subscribeModelCatalog = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const readModelCatalogCache = () => catalog
export const invalidateModelCatalogCache = () => {}
export const updateCachedRoutingMode = (routingMode: "auto" | "pinned") => {
  if (catalog) catalog = { ...catalog, routingMode }
  publish()
}
export const useThreadActions = () => actions
export function useThreadStateSelector<T>(
  _threadId: string,
  selector: (state: { currentModel: string; routingResult: null }) => T
): T {
  return useSyncExternalStore(subscribeModelCatalog, () =>
    selector({ currentModel, routingResult: null })
  )
}
export const CustomModelDialog = () => null

export function setMetadata(metadata: Metadata): void {
  useAppStore.setState({ threads: [{ thread_id: "imported", metadata }] })
}
export function setModels(
  models: ModelConfig[],
  ready = true,
  routingMode: "auto" | "pinned" = catalog?.routingMode ?? "pinned"
): void {
  catalog = ready ? { routingMode, defaultModelId: "custom:local-a" } : null
  useAppStore.setState({ models })
  publish()
}
export function reset(
  metadata: Metadata,
  ready = true,
  initialModel = "",
  routingMode: "auto" | "pinned" = "pinned"
): void {
  writes.length = 0
  routingWrites.length = 0
  currentModel = initialModel
  setMetadata(metadata)
  setModels(ready ? localModels : [], ready, routingMode)
}
export const readSelection = () => ({ currentModel, writes: [...writes] })
