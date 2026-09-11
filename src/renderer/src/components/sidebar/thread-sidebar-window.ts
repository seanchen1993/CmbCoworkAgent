export interface BoundedSidebarWindow<T> {
  items: T[]
  hiddenCount: number
  selectedOutsideWindow: boolean
}

/**
 * Keep the selected item reachable without mounting every item before it.
 * This is intentionally different from expanding a prefix to selectedIndex.
 */
export function selectBoundedSidebarWindow<T>(
  items: readonly T[],
  requestedCount: number,
  selectedIndex = -1
): BoundedSidebarWindow<T> {
  const boundedCount = Math.max(0, Math.min(items.length, Math.floor(requestedCount)))
  const visible = items.slice(0, boundedCount)
  const selectedOutsideWindow = selectedIndex >= boundedCount && selectedIndex < items.length
  if (selectedOutsideWindow) visible.push(items[selectedIndex])
  return {
    items: visible,
    hiddenCount: Math.max(0, items.length - visible.length),
    selectedOutsideWindow
  }
}
