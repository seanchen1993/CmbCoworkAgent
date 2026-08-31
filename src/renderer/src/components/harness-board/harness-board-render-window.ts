export interface HarnessProjectGroupLike<T> {
  projects: readonly T[]
}

export interface HarnessProjectGroupWindow<TGroup, TProject> {
  group: TGroup
  projects: readonly TProject[]
}

export interface HarnessViewportWindow {
  start: number
  end: number
  beforePx: number
  afterPx: number
}

/** Returns a bounded overscanned slice for fixed-width project cards. */
export function getHarnessViewportWindow(
  totalItems: number,
  scrollOffset: number,
  viewportSize: number,
  itemExtent: number,
  overscan = 2
): HarnessViewportWindow {
  const total = Math.max(0, Math.trunc(totalItems))
  const extent = Math.max(1, itemExtent)
  const safeOverscan = Math.max(0, Math.trunc(overscan))
  const start = Math.max(0, Math.floor(Math.max(0, scrollOffset) / extent) - safeOverscan)
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportSize) / extent))
  const end = Math.min(total, start + visibleCount + safeOverscan * 2)
  return {
    start,
    end,
    beforePx: start * extent,
    afterPx: Math.max(0, (total - end) * extent)
  }
}

/**
 * Applies one global card budget across system groups. A per-group cap still
 * allows thousands of groups to mount at once; this keeps the complete initial
 * project-mode DOM proportional to the explicit render budget.
 */
export function windowHarnessProjectGroups<TGroup extends HarnessProjectGroupLike<unknown>>(
  groups: readonly TGroup[],
  requestedLimit: number
): HarnessProjectGroupWindow<TGroup, TGroup["projects"][number]>[] {
  let remaining = Math.max(0, Math.trunc(requestedLimit))
  const result: HarnessProjectGroupWindow<TGroup, TGroup["projects"][number]>[] = []
  for (const group of groups) {
    if (remaining <= 0) break
    const projects = group.projects.slice(0, remaining)
    if (projects.length === 0) continue
    result.push({ group, projects })
    remaining -= projects.length
  }
  return result
}
