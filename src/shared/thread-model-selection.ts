export type ModelRoutingMode = "auto" | "pinned"

export interface PersistedThreadRoutingModel {
  resolvedModelId: string
  resolvedTier: "premium" | "economy"
}

export interface HydratedThreadModelSelection {
  modelId: string
  routingResult: PersistedThreadRoutingModel | null
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Resolve the model shown/used after hydrating a thread.
 *
 * `metadata.model` is the user's explicit pinned selection. The routing snapshot
 * records the model that auto routing actually used on the previous turn. They
 * intentionally have different precedence depending on the current global mode.
 */
export function resolveHydratedThreadModel(
  metadata: Record<string, unknown> | null | undefined,
  routingMode: ModelRoutingMode
): HydratedThreadModelSelection {
  const pinnedModelId = nonEmptyString(metadata?.model)
  const rawRoutingState = metadata?.routingState
  const routingState =
    rawRoutingState && typeof rawRoutingState === "object"
      ? (rawRoutingState as Record<string, unknown>)
      : null
  const routedModelId = nonEmptyString(routingState?.lastResolvedModelId)
  const rawTier = routingState?.lastResolvedTier
  const routedTier = rawTier === "economy" || rawTier === "premium" ? rawTier : "premium"

  return {
    modelId:
      routingMode === "auto" ? routedModelId || pinnedModelId : pinnedModelId || routedModelId,
    routingResult: routedModelId
      ? { resolvedModelId: routedModelId, resolvedTier: routedTier }
      : null
  }
}
