import {
  HarnessStageAttributionCache,
  type HarnessResolvedStage,
  type HarnessStageAttribution
} from "./harness-stage-attribution-cache"

const cache = new HarnessStageAttributionCache({
  // Keep the generic hook/runtime import path lightweight. The board service is
  // loaded only when a dirty code-generation entry actually needs inspection.
  resolver: async (projectId, featureSlug) => {
    const { resolveHarnessFeatureCurrentStageAsync } = await import("../harness-board/service")
    return resolveHarnessFeatureCurrentStageAsync(projectId, featureSlug)
  }
})

export type { HarnessStageAttribution }

export function primeHarnessStageAttribution(
  projectId: string,
  featureSlug: string,
  stage: HarnessResolvedStage | null
): void {
  if (stage) {
    cache.prime(projectId, featureSlug, stage)
  } else {
    cache.markDirty(projectId, featureSlug)
  }
}

export function markHarnessStageAttributionDirty(
  projectId: string | undefined,
  featureSlug: string | undefined
): void {
  if (!projectId || !featureSlug) return
  cache.markDirty(projectId, featureSlug)
}

export function getHarnessStageAttributionForCodeGeneration(
  projectId: string,
  featureSlug: string
): Promise<HarnessStageAttribution> {
  return cache.getForCodeGeneration(projectId, featureSlug)
}
