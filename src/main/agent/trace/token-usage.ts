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
  /**
   * Σ cache-hit input tokens across the trace's model calls.
   *
   * A *subset* of the trace's input tokens, not an addition to them — the
   * adapters fold cache counts into `input_tokens`. Flattened here because a
   * `sum` aggregation cannot reach into the nested per-call array.
   */
  cacheReadTokens: number
}

/**
 * Sum per-call cache-read usage into the trace-level aggregate.
 *
 * Cache *writes* are deliberately not flattened: they are a small fraction of
 * volume next to reads, and every extra top-level field costs a mapping change
 * on a non-dynamic index. Add one later if cost modelling needs to price cache
 * writes separately — the per-call values are already collected.
 */
export function summarizeTraceCacheTokens(
  modelCalls: readonly TraceModelCall[] | undefined
): TraceCacheTokenSummary {
  if (!Array.isArray(modelCalls)) return { cacheReadTokens: 0 }
  let cacheReadTokens = 0
  for (const call of modelCalls) {
    cacheReadTokens += nonNegative(call?.tokenUsage?.cacheReadTokens)
  }
  return { cacheReadTokens }
}
