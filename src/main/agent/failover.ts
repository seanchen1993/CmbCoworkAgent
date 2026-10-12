import { getModelConfigByRef, getModelConfigs, toModelRef } from "../models/registry"
export * from "./api-errors"

// ─── Failover attempt tracking ───────────────────────────────────────────────

export interface FailoverAttempt {
  modelId: string
  error: string
  timestamp: number
}

// ─── Ordered failover chain builder ──────────────────────────────────────────

/**
 * Build an ordered failover chain that respects the "only upgrade" constraint:
 * - premium fails → try other premium models only
 * - economy fails → skip other economy, go straight to premium models
 *
 * The primary model is always first. Duplicates are removed.
 */
export function buildOrderedChain(
  primaryModelId: string | undefined,
  fallbackChain: string[] | undefined,
  primaryTier: "premium" | "economy",
  allowFailover = true
): string[] {
  const configs = getModelConfigs()
  const chain: string[] = []
  const seen = new Set<string>()

  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id)
      chain.push(id)
    }
  }

  // Primary model always first
  if (primaryModelId) add(primaryModelId)

  if (!allowFailover) {
    return chain
  }

  if (primaryTier === "premium") {
    // Premium fails → only other premium models
    for (const c of configs) {
      if ((c.tier ?? "premium") === "premium" && c.apiKey) {
        add(toModelRef(c))
      }
    }
  } else {
    // Economy fails → skip other economy, go straight to premium
    for (const c of configs) {
      if ((c.tier ?? "premium") === "premium" && c.apiKey) {
        add(toModelRef(c))
      }
    }
  }

  // If fallbackChain provided, append any remaining eligible models
  if (fallbackChain) {
    for (const id of fallbackChain) {
      const cfg = getModelConfigByRef(id)
      if (!cfg) continue
      const tier = cfg.tier ?? "premium"
      // Only add if not downgrading
      if (primaryTier === "premium" && tier === "economy") continue
      if (cfg.apiKey) add(id)
    }
  }

  return chain
}
