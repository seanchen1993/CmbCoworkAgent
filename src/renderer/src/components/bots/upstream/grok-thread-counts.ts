// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5080561 (thread summary copy and callback)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5080586 (sand-thread-affordance selector)

export interface TranscriptThreadSummary {
  readonly rootId: string
  readonly count: number
}

/** Structural page shape supplied by the forthcoming transcript-window owner. */
export interface TranscriptThreadCountsPage {
  readonly threadCounts: Readonly<Record<string, number>>
}

/**
 * Projects the exact root/count map onto entries present in the current
 * transcript window. Unknown roots and malformed counts stay fail-closed;
 * pagination callers can feed the result into the existing merge methods.
 */
export function projectThreadCounts(
  page: TranscriptThreadCountsPage,
  entryIds: readonly string[]
): readonly TranscriptThreadSummary[] {
  const summaries: TranscriptThreadSummary[] = []
  for (const rootId of entryIds) {
    const count = page.threadCounts[rootId]
    if (!rootId || !Number.isInteger(count) || count <= 0) continue
    summaries.push({ rootId, count })
  }
  return summaries
}
