interface UnreadRow {
  key: string
  top: number
  bottom: number
  count: number
}
export interface UnreadJump {
  key: string
  count: number
}

/** Only offscreen unread rows contribute; scrolling itself never acknowledges them. */
export function botSidebarUnreadJumps(
  rows: readonly UnreadRow[],
  viewport: { top: number; bottom: number }
): { above: UnreadJump | null; below: UnreadJump | null } {
  const jumps: { above: UnreadJump | null; below: UnreadJump | null } = { above: null, below: null }
  for (const row of rows) {
    if (row.count <= 0 || row.bottom <= row.top) continue
    if (row.bottom <= viewport.top) {
      jumps.above = { key: row.key, count: (jumps.above?.count ?? 0) + row.count }
    } else if (row.top >= viewport.bottom) {
      jumps.below = {
        key: jumps.below?.key ?? row.key,
        count: (jumps.below?.count ?? 0) + row.count
      }
    }
  }
  return jumps
}
