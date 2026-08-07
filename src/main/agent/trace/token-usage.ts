/**
 * Token usage normalization + per-trace cache aggregation.
 *
 * Two payload shapes reach us and they nest cache counts differently:
 *
 *   LangChain `usage_metadata` (the normal path)
 *     { input_tokens, output_tokens, total_tokens,
 *       input_token_details: { cache_read, cache_creation } }
 *
 *   Raw provider `response_metadata.usage` (fallback when the adapter did not
 *   normalize, e.g. a non-standard provider)
 *     { input_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 *
 * Reading only the raw shape — which both call sites used to do — silently
 * yields `undefined` cache counts on the LangChain path, i.e. almost always.
 *
 * Cache inclusion: per the LangChain spec `input_tokens` is "the sum of all
 * input token types", and the Anthropic adapter builds it as
 * `input_tokens + cache_creation + cache_read`. So cache counts are a *subset*
 * of `inputTokens`, never an addition to it.
 */

import type { TraceModelCall, TraceTokenUsage } from "./types"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && value > 0 ? value : 0
}

/**
 * Normalize either payload shape into `TraceTokenUsage`.
 * Returns undefined when the payload carries no usable counter at all.
 */
export function normalizeTraceTokenUsage(value: unknown): TraceTokenUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined

  const details = asRecord(usage.input_token_details) ?? asRecord(usage.inputTokenDetails)

  const inputTokens = finiteNumber(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = finiteNumber(usage.output_tokens ?? usage.outputTokens)
  const totalTokens = finiteNumber(usage.total_tokens ?? usage.totalTokens)
  // LangChain nests these; raw provider payloads put them at the top level.
  const cacheReadTokens = finiteNumber(
    details?.cache_read ??
      usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cacheReadTokens
  )
  const cacheCreationTokens = finiteNumber(
    details?.cache_creation ??
      usage.cache_creation_input_tokens ??
      usage.cacheCreationInputTokens ??
      usage.cacheCreationTokens
  )

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined
  }
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheCreationTokens }
}

/** Trace-level cache token aggregate, flattened onto the uploaded document. */
export interface TraceCacheTokenSummary {
  /** Σ cache-hit input tokens. Subset of the trace's input tokens. */
  cacheReadTokens: number
  /** Σ tokens written into the cache (cache miss). Also a subset of input. */
  cacheCreationTokens: number
  /**
   * Σ input tokens that were neither read from nor written to cache.
   *
   * Emitted directly rather than left to be derived downstream: it makes the
   * document self-checking. If `nonCachedInputTokens + cacheReadTokens +
   * cacheCreationTokens` does not match the index's `totalInputTokens`, the
   * two derivations disagree and the per-line token figure cannot be trusted.
   */
  nonCachedInputTokens: number
}

/**
 * Sum per-call usage into the trace-level cache aggregate.
 *
 * Per call the non-cached remainder is clamped at zero: a provider that reports
 * `input_tokens` *excluding* cache would otherwise drive the sum negative. The
 * clamp makes the field a lower bound instead of nonsense, and the self-check
 * described above still surfaces the disagreement.
 */
export function summarizeTraceCacheTokens(
  modelCalls: readonly TraceModelCall[] | undefined
): TraceCacheTokenSummary {
  const summary: TraceCacheTokenSummary = {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    nonCachedInputTokens: 0
  }
  if (!Array.isArray(modelCalls)) return summary

  for (const call of modelCalls) {
    const usage = call?.tokenUsage
    if (!usage) continue
    const cacheRead = nonNegative(usage.cacheReadTokens)
    const cacheCreation = nonNegative(usage.cacheCreationTokens)
    const input = nonNegative(usage.inputTokens)
    summary.cacheReadTokens += cacheRead
    summary.cacheCreationTokens += cacheCreation
    summary.nonCachedInputTokens += Math.max(0, input - cacheRead - cacheCreation)
  }
  return summary
}
