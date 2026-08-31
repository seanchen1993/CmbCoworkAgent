export const RIGHT_PANEL_INITIAL_RENDER_ITEMS = 96
export const RIGHT_PANEL_RENDER_PAGE_ITEMS = 96

export interface RightPanelPrioritizedWindow<T> {
  enabled: T[]
  disabled: T[]
  enabledCount: number
  disabledCount: number
  remainingCount: number
}

export function selectRightPanelWindow<T>(items: T[], requestedCount: number): T[] {
  return items.slice(0, Math.max(0, requestedCount))
}

/**
 * Selects a bounded enabled-first render window without allocating copies of
 * the complete catalog. Header counts still describe the complete source.
 */
export function selectRightPanelPrioritizedWindow<T>(
  items: T[],
  requestedCount: number,
  isEnabled: (item: T) => boolean
): RightPanelPrioritizedWindow<T> {
  const limit = Math.max(0, requestedCount)
  const enabled: T[] = []
  const disabledCandidates: T[] = []
  let enabledCount = 0
  let disabledCount = 0

  for (const item of items) {
    if (isEnabled(item)) {
      enabledCount += 1
      if (enabled.length < limit) enabled.push(item)
    } else {
      disabledCount += 1
      if (disabledCandidates.length < limit) disabledCandidates.push(item)
    }
  }

  const disabled = disabledCandidates.slice(0, Math.max(0, limit - enabled.length))
  return {
    enabled,
    disabled,
    enabledCount,
    disabledCount,
    remainingCount: Math.max(0, items.length - enabled.length - disabled.length)
  }
}
