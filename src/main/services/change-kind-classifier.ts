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
 *     newRatio = generatedLines / (generatedLines + deletedLines)
 *
 * `generatedLines` contains normalised, non-blank lines found only in the new
 * fragment; `deletedLines` contains lines found only in the old fragment. The
 * latter therefore includes replaced lines, not just a reduction in total line
 * count. A pure insertion still has 0 deleted lines, while an equal-size rewrite
 * has matching generated/deleted counts and is correctly treated as legacy work.
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
 * Share of the change that is added (rather than replaced) lines.
 *
 * Returns null when the generation touched no lines at all — there is nothing
 * to classify, and a null keeps that distinguishable from a genuine 0.
 */
export function computeNewRatio(
  generatedLineCount: unknown,
  deletedLineCount: unknown
): number | null {
  const generated = toFiniteNonNegative(generatedLineCount)
  const deleted = toFiniteNonNegative(deletedLineCount)
  const total = generated + deleted
  if (total <= 0) return null
  return generated / total
}

/**
 * Bucket a generation by its new-line share. A null ratio (nothing touched)
 * falls back to "new": it contributes no lines to either bucket, so the label
 * only matters for keeping the field non-null.
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
