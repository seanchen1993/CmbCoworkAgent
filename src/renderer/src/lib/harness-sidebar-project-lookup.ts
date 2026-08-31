export const HARNESS_SIDEBAR_PROJECT_LOOKUP_BATCH_SIZE = 64

/** Add newly observed directory project ids without duplicating queued/in-flight work. */
export function enqueueHarnessSidebarProjectLookups(
  projectIds: Iterable<string>,
  knownIds: ReadonlySet<string>,
  resolvedIds: ReadonlySet<string>,
  pendingIds: Set<string>,
  queue: Set<string>
): void {
  for (const projectId of projectIds) {
    if (!projectId || knownIds.has(projectId) || resolvedIds.has(projectId)) continue
    if (pendingIds.has(projectId)) continue
    pendingIds.add(projectId)
    queue.add(projectId)
  }
}

/** Take one bounded batch while leaving the ids pending until its request settles. */
export function takeHarnessSidebarProjectLookupBatch(
  queue: Set<string>,
  limit = HARNESS_SIDEBAR_PROJECT_LOOKUP_BATCH_SIZE
): string[] {
  const batch: string[] = []
  if (!Number.isSafeInteger(limit) || limit <= 0) return batch
  for (const projectId of queue) {
    queue.delete(projectId)
    batch.push(projectId)
    if (batch.length >= limit) break
  }
  return batch
}
