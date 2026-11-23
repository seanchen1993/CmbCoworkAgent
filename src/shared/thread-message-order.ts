const utf8 = new TextEncoder()

/** The same ordering as SQLite's BINARY collation for persisted message IDs. */
export function compareThreadMessageKeys(
  leftOrdinal: number, leftId: string, rightOrdinal: number, rightId: string
): number {
  if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal
  if (leftId === rightId) return 0
  const left = utf8.encode(leftId)
  const right = utf8.encode(rightId)
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return left.length - right.length
}

export function compareTranscriptPositions(
  left: { id: string; ordinal?: number; transcript_anchor_message_id?: string },
  right: { id: string; ordinal?: number; transcript_anchor_message_id?: string }
): number {
  const leftAnchor = left.transcript_anchor_message_id
  const rightAnchor = right.transcript_anchor_message_id
  const leftOrdinal = left.ordinal ?? Infinity
  const rightOrdinal = right.ordinal ?? Infinity
  const row = compareThreadMessageKeys(leftOrdinal, leftAnchor ?? left.id, rightOrdinal, rightAnchor ?? right.id)
  if (row !== 0) return row
  if (Boolean(leftAnchor) !== Boolean(rightAnchor)) return leftAnchor ? -1 : 1
  return compareThreadMessageKeys(leftOrdinal, left.id, rightOrdinal, right.id)
}
