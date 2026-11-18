import { botWorkFollowsGlobalModel, botWorkModelRoutingMode } from "./bots/model-policy"

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
  routingMode: ModelRoutingMode,
  defaultModelId?: string
): HydratedThreadModelSelection {
  routingMode = botWorkModelRoutingMode(metadata) ?? routingMode
  const followsDefault = botWorkFollowsGlobalModel(metadata)
  const pinnedModelId = nonEmptyString(followsDefault ? defaultModelId : metadata?.model)
  const rawRoutingState = metadata?.routingState
  const routingState =
    rawRoutingState && typeof rawRoutingState === "object"
      ? (rawRoutingState as Record<string, unknown>)
      : null
  const routedModelId = nonEmptyString(routingState?.lastResolvedModelId)
  const rawTier = routingState?.lastResolvedTier
  const routedTier = rawTier === "economy" || rawTier === "premium" ? rawTier : "premium"

  return {
    // Auto mode restores the model actually used, including when the caller has
    // no catalog yet. The Bot runtime resolves the next request's default separately.
    modelId: routingMode === "auto" ? routedModelId || pinnedModelId
      : followsDefault ? pinnedModelId : pinnedModelId || routedModelId,
    routingResult: routedModelId
      ? { resolvedModelId: routedModelId, resolvedTier: routedTier }
      : null
  }
}

/** Bot work views must retain live routing events without pinning their result. */
export function resolveBotWorkViewModel(
  routingMode: ModelRoutingMode,
  routedModelId: string,
  metadata: Record<string, unknown> | null | undefined,
  models: ReadonlyArray<{ id: string; available: boolean }>,
  defaultModelId: string
): string {
  // A historical routing result is not an explicit pin. Legacy work with no
  // saved model follows the runtime's default, while a nonempty pin is preserved.
  if (routingMode !== "auto") {
    return botWorkFollowsGlobalModel(metadata)
      ? defaultModelId : nonEmptyString(metadata?.model) || defaultModelId
  }
  // A removed historical model must not block an automatic task from submitting.
  // Explicit pinned selections deliberately do not use this fallback.
  const hydratedModelId = resolveHydratedThreadModel(metadata, routingMode, defaultModelId).modelId
  return [routedModelId, hydratedModelId, defaultModelId]
    .find((id) => models.some((model) => model.id === id && model.available)) ?? ""
}
