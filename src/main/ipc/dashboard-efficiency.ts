/**
 * 研发效能面板 — query shaping and response normalization.
 *
 * Scope is fixed: project mode (`properties.harnessProjectId` present) AND bound
 * to an enterprise (Lean) project. Everything aggregates to `projectCode`, never
 * `projectId` — `projectId` is a machine-local `uuid()` and its uniqueness check
 * only runs against the local store, so one Lean project routinely maps to
 * several `projectId`s (different developers, or an archived + a live project on
 * the same machine).
 *
 * Three metrics:
 *   1. 系统可扩展性  — 交付周期变化量 ÷ 系统规模变化量. Needs the Lean 需求特性 import
 *      and repo-scale collection, so it is a declared gap here rather than a
 *      silent zero.
 *   2. AI 编码有效性 — 入库采纳率, split 新增 / 存量 by the generation's added-line
 *      share (see `change-kind-classifier`).
 *   3. 算力产出效能 — tokens per pushed adopted line.
 *
 * This module holds only pure functions (ES body fragments in, plain objects
 * out) so it can be unit-tested without Electron or a live cluster. The IPC
 * layer owns access control and the actual queries.
 */

import {
  type DashboardCodeStats,
  makeDashboardCodeStats,
  normalizeCodeStatsFromContainer
} from "./dashboard-code-stats"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Buckets reported for 指标 2. `unclassified` covers pre-migration events. */
export const EFFICIENCY_CHANGE_KINDS = ["new", "legacy"] as const
export type EfficiencyChangeKind = (typeof EFFICIENCY_CHANGE_KINDS)[number]

/** Bucket key used for events emitted before `changeKind` existed. */
export const UNCLASSIFIED_CHANGE_KIND = "unclassified"

/**
 * Width of the newRatio histogram used to sanity-check the 0.7 threshold.
 * 0.05 gives 20 bars — enough to see where the mass sits without flooding the
 * response.
 */
export const NEW_RATIO_HISTOGRAM_INTERVAL = 0.05

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface EfficiencyChangeKindStats extends DashboardCodeStats {
  changeKind: EfficiencyChangeKind | typeof UNCLASSIFIED_CHANGE_KIND
}

export interface NewRatioHistogramBin {
  /** Lower edge of the bin, e.g. 0.7 for the [0.70, 0.75) bar. */
  from: number
  docCount: number
}

export interface EfficiencyAdoptionData {
  overall: DashboardCodeStats
  byChangeKind: EfficiencyChangeKindStats[]
  newRatioHistogram: NewRatioHistogramBin[]
  /**
   * Share of generated lines that never got a `code_adopt` verdict. These land
   * fully in the adoption-rate denominator and never in the numerator, so a high
   * value means the reported rate understates reality. The dominant cause is the
   * 14-day attribution window: code committed later than that is never measured.
   */
  unmeasuredRatio: number | null
}

export interface EfficiencyComputeData {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  /**
   * Subset of `totalInputTokens`. The LangChain Anthropic adapter folds cache
   * reads and cache writes into `input_tokens`, so this is surfaced separately
   * to explain why the per-line figure is larger than intuition suggests.
   */
  cacheReadTokens: number
  pushedAdoptedLines: number
  /** Σ tokens ÷ Σ pushed adopted lines. Null when no code landed. */
  tokensPerAdoptedLine: number | null
  traceCount: number
  /** Traces that produced at least one `code_gen`. */
  codeProducingTraceCount: number
  /** codeProducingTraceCount ÷ traceCount. Null when there were no traces. */
  codeProducingTraceRatio: number | null
}

export interface EfficiencyScalabilityData {
  /** Always null until the Lean 需求特性 import and repo-scale collection land. */
  slope: number | null
  /** Why the metric is unavailable, surfaced verbatim so the panel can say so. */
  pendingReason: string
}

export interface DashboardEfficiencyData {
  scalability: EfficiencyScalabilityData
  adoption: EfficiencyAdoptionData
  compute: EfficiencyComputeData
  meta: {
    /** Distinct `projectCode` values behind these numbers. */
    projectCount: number
    /**
     * True when the Lean project set hit the id cap, so the figures cover only
     * the first page of projects.
     */
    truncated: boolean
  }
}

// ─────────────────────────────────────────────────────────
// Query shaping
// ─────────────────────────────────────────────────────────

/**
 * Nest the shared per-bucket code aggs under a `changeKind` terms bucket.
 *
 * `missing` folds pre-migration events into an explicit bucket instead of
 * dropping them — otherwise the 新增 + 存量 line counts would silently fail to
 * add up to the overall total, which is the kind of discrepancy nobody notices
 * until the numbers are already in a report.
 */
export function buildChangeKindAggs(
  perBucketAggs: Record<string, unknown>
): Record<string, unknown> {
  return {
    by_change_kind: {
      terms: {
        field: "properties.changeKind",
        size: EFFICIENCY_CHANGE_KINDS.length + 1,
        missing: UNCLASSIFIED_CHANGE_KIND
      },
      aggs: perBucketAggs
    }
  }
}

/** Histogram over `properties.newRatio`, used to re-tune the bucket threshold. */
export function buildNewRatioHistogramAgg(
  interval: number = NEW_RATIO_HISTOGRAM_INTERVAL
): Record<string, unknown> {
  return {
    new_ratio_histogram: {
      histogram: {
        field: "properties.newRatio",
        interval,
        min_doc_count: 0,
        extended_bounds: { min: 0, max: 1 }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// Response normalization
// ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeBucketChangeKind(
  value: unknown
): EfficiencyChangeKind | typeof UNCLASSIFIED_CHANGE_KIND | null {
  if (value === "new" || value === "legacy") return value
  if (value === UNCLASSIFIED_CHANGE_KIND) return UNCLASSIFIED_CHANGE_KIND
  return null
}

/**
 * Map the `by_change_kind` terms buckets into per-kind code stats.
 *
 * Kinds absent from the response are emitted as zero rows so the panel always
 * renders both targets (新增 > 90% / 存量 > 85%) rather than hiding one when a
 * period happens to contain no matching work. `unclassified` is only emitted
 * when it actually carries lines, since for forward-only data it is always
 * empty and an always-visible empty row would just be noise.
 */
export function normalizeChangeKindBuckets(raw: unknown): EfficiencyChangeKindStats[] {
  const buckets = asRecord(asRecord(asRecord(raw).aggregations).by_change_kind).buckets
  const byKind = new Map<string, EfficiencyChangeKindStats>()

  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      const record = asRecord(bucket)
      const changeKind = normalizeBucketChangeKind(record.key)
      if (!changeKind) continue
      byKind.set(changeKind, { ...normalizeCodeStatsFromContainer(record), changeKind })
    }
  }

  const rows: EfficiencyChangeKindStats[] = EFFICIENCY_CHANGE_KINDS.map(
    (changeKind) => byKind.get(changeKind) ?? { ...emptyCodeStats(), changeKind }
  )
  const unclassified = byKind.get(UNCLASSIFIED_CHANGE_KIND)
  if (unclassified && hasAnyLines(unclassified)) rows.push(unclassified)
  return rows
}

function emptyCodeStats(): DashboardCodeStats {
  return makeDashboardCodeStats({
    generatedLines: 0,
    deletedLines: 0,
    measuredGeneratedLines: 0,
    effectiveGeneratedLines: 0,
    adoptedLines: 0
  })
}

function hasAnyLines(stats: DashboardCodeStats): boolean {
  return stats.generatedLines > 0 || stats.inclusiveEffectiveGeneratedLines > 0
}

/** Read the newRatio histogram bins, dropping the empty tail bars. */
export function normalizeNewRatioHistogram(raw: unknown): NewRatioHistogramBin[] {
  const buckets = asRecord(asRecord(asRecord(raw).aggregations).new_ratio_histogram).buckets
  if (!Array.isArray(buckets)) return []
  return buckets.map((bucket) => {
    const record = asRecord(bucket)
    return { from: asNumber(record.key), docCount: asNumber(record.doc_count) }
  })
}

/**
 * Fraction of generated lines that never reached a measured verdict.
 *
 * Uses the same `inclusive` denominator as the headline adoption rate so the two
 * numbers are directly comparable: a 40% unmeasured share means roughly 40% of
 * the denominator can only ever drag the rate down.
 */
export function computeUnmeasuredRatio(stats: DashboardCodeStats): number | null {
  const denominator = stats.inclusiveEffectiveGeneratedLines
  if (denominator <= 0) return null
  return stats.unmeasuredGeneratedLines / denominator
}

// ─────────────────────────────────────────────────────────
// Metric assembly
// ─────────────────────────────────────────────────────────

export interface ComputeEfficiencyInput {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  cacheReadTokens: number
  pushedAdoptedLines: number
  traceCount: number
  codeProducingTraceCount: number
}

/**
 * 指标 3. Numerator is the trace index's `totalTokens`, which already equals
 * input + output (the adapter defines `total_tokens` that way), so the two are
 * not summed again here.
 */
export function buildComputeEfficiency(input: ComputeEfficiencyInput): EfficiencyComputeData {
  const pushedAdoptedLines = Math.max(0, input.pushedAdoptedLines)
  const totalTokens = Math.max(0, input.totalTokens)
  const traceCount = Math.max(0, input.traceCount)
  const codeProducingTraceCount = Math.max(0, input.codeProducingTraceCount)
  return {
    totalInputTokens: Math.max(0, input.totalInputTokens),
    totalOutputTokens: Math.max(0, input.totalOutputTokens),
    totalTokens,
    cacheReadTokens: Math.max(0, input.cacheReadTokens),
    pushedAdoptedLines,
    tokensPerAdoptedLine: pushedAdoptedLines > 0 ? totalTokens / pushedAdoptedLines : null,
    traceCount,
    codeProducingTraceCount,
    codeProducingTraceRatio: traceCount > 0 ? codeProducingTraceCount / traceCount : null
  }
}

export const SCALABILITY_PENDING_REASON =
  "需求特性交付周期尚未接入（待手工导入），仓库规模尚未采集，暂无法计算斜率。"

export function buildPendingScalability(): EfficiencyScalabilityData {
  return { slope: null, pendingReason: SCALABILITY_PENDING_REASON }
}

// ─────────────────────────────────────────────────────────
// DEV mock
// ─────────────────────────────────────────────────────────

/**
 * Local-preview payload. `esQuery` throws without ES_NODES, so without this the
 * panel would only ever render an error on a dev machine — every other dashboard
 * channel carries a DEV mock for the same reason.
 *
 * The numbers deliberately land on the awkward side of each target (存量 below
 * 85%, a high unmeasured share, a large per-line token figure) so the warning
 * states get exercised during development rather than only in production.
 */
export function makeMockEfficiency(): DashboardEfficiencyData {
  const newBucket = makeDashboardCodeStats({
    generatedLines: 128_400,
    deletedLines: 9_200,
    measuredGeneratedLines: 96_300,
    effectiveGeneratedLines: 94_100,
    adoptedLines: 88_700,
    pushedEffectiveGeneratedLines: 90_500,
    pushedAdoptedLines: 86_200,
    pushedCommitCount: 1_240
  })
  const legacyBucket = makeDashboardCodeStats({
    generatedLines: 61_800,
    deletedLines: 34_500,
    measuredGeneratedLines: 44_900,
    effectiveGeneratedLines: 43_100,
    adoptedLines: 35_600,
    pushedEffectiveGeneratedLines: 41_200,
    pushedAdoptedLines: 33_900,
    pushedCommitCount: 780
  })
  const overall = makeDashboardCodeStats({
    generatedLines: 190_200,
    deletedLines: 43_700,
    measuredGeneratedLines: 141_200,
    effectiveGeneratedLines: 137_200,
    adoptedLines: 124_300,
    pushedEffectiveGeneratedLines: 131_700,
    pushedAdoptedLines: 120_100,
    pushedCommitCount: 2_020
  })

  // Mass concentrated at the extremes (pure insert / pure rewrite) with a dip
  // around the 0.7 threshold — the shape that makes the threshold defensible.
  const histogramShape = [
    620, 210, 140, 110, 95, 88, 80, 76, 70, 68, 66, 71, 84, 120, 210, 380, 640, 980, 1_460, 2_310
  ]

  return {
    scalability: buildPendingScalability(),
    adoption: {
      overall,
      byChangeKind: [
        { ...newBucket, changeKind: "new" },
        { ...legacyBucket, changeKind: "legacy" }
      ],
      newRatioHistogram: histogramShape.map((docCount, index) => ({
        from: Number((index * NEW_RATIO_HISTOGRAM_INTERVAL).toFixed(2)),
        docCount
      })),
      unmeasuredRatio: computeUnmeasuredRatio(overall)
    },
    compute: buildComputeEfficiency({
      totalInputTokens: 2_140_000_000,
      totalOutputTokens: 96_000_000,
      totalTokens: 2_236_000_000,
      cacheReadTokens: 1_780_000_000,
      pushedAdoptedLines: overall.pushedAdoptedLines,
      traceCount: 18_400,
      codeProducingTraceCount: 7_120
    }),
    meta: { projectCount: 23, truncated: false }
  }
}
