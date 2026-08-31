/**
 * ChangeKindClassifier
 *
 * Splits a code generation into "new" (绿地/新增) vs "legacy" (棕地/存量迭代)
 * so adoption rates can be reported per bucket. AI performs measurably worse
 * when it has to understand surrounding existing code, so the two buckets get
 * separate targets and must not be averaged together.
 *
 * The signal is the line-level multiset diff carried by the generation:
 *
 *     replacementLines = min(generatedLines, deletedLines)
 *     newRatio = (generatedLines - replacementLines) / generatedLines
 *              = max(generatedLines - deletedLines, 0) / generatedLines
 *
 * `generatedLines` contains normalised, non-blank lines found only in the new
 * fragment; `deletedLines` contains lines found only in the old fragment. The
 * latter therefore includes replaced lines, not just a reduction in total line
 * count. Pairing generated and deleted lines estimates how many generated lines
 * replaced existing code: a pure insertion scores 1, while an equal-size rewrite
 * scores 0.
 *
 * Both the raw ratio and the derived label are persisted. Keeping the raw value
 * means the threshold can be re-tuned later and historical data re-bucketed
 * without re-collecting anything.
 */

export type ChangeKind = "new" | "legacy"

/**
 * Generations at or above this new-line share count as "new".
 *
 * Fixed on purpose: changing it silently would make historical buckets
 * incomparable. Re-tune by re-deriving labels from the stored `newRatio`, not
 * by editing this constant in place.
 */
export const CHANGE_KIND_NEW_RATIO_THRESHOLD = 0.7

function toFiniteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Share of generated lines that are net additions rather than replacements.
 *
 * Returns null when there are no generated lines — deletion-only work has no
 * generated code to classify, and a null keeps that distinct from a genuine
 * rewrite ratio of 0.
 */
export function computeNewRatio(
  generatedLineCount: unknown,
  deletedLineCount: unknown
): number | null {
  const generated = toFiniteNonNegative(generatedLineCount)
  const deleted = toFiniteNonNegative(deletedLineCount)
  if (generated <= 0) return null
  return Math.max(generated - deleted, 0) / generated
}

/**
 * Bucket a generation by its new-line share. A null ratio (nothing generated)
 * falls back to "new": it contributes no generated lines to either bucket, so
 * the label only matters for keeping the field non-null.
 */
export function classifyChangeKind(newRatio: number | null): ChangeKind {
  if (newRatio === null) return "new"
  return newRatio >= CHANGE_KIND_NEW_RATIO_THRESHOLD ? "new" : "legacy"
}

export interface ChangeKindAttribution {
  newRatio: number | null
  changeKind: ChangeKind
}

/** Convenience wrapper: both fields in one call, as persisted on gen rows. */
export function attributeChangeKind(
  generatedLineCount: unknown,
  deletedLineCount: unknown
): ChangeKindAttribution {
  const newRatio = computeNewRatio(generatedLineCount, deletedLineCount)
  return { newRatio, changeKind: classifyChangeKind(newRatio) }
}

/**
 * Normalise a value read back from sqlite / an event payload into a ChangeKind.
 * Rows written before this field existed resolve to null so callers can decide
 * whether to treat them as unclassified rather than silently as "new".
 */
export function normalizeChangeKind(value: unknown): ChangeKind | null {
  return value === "new" || value === "legacy" ? value : null
}

/** Normalise a stored ratio; anything out of [0, 1] is treated as absent. */
export function normalizeNewRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  if (value < 0 || value > 1) return null
  return value
}
