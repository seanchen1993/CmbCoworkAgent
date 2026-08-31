export interface ThreadStateRegistryChange<T> {
  threadId: string
  state: T | undefined
}

export interface AppliedThreadStateRegistryChange<T> {
  threadId: string
  previous: T | undefined
  state: T | undefined
}

/**
 * Mutate only explicitly supplied registry buckets. ThreadState values remain
 * immutable snapshots; the containing registry is an implementation detail and
 * never escapes through useSyncExternalStore.
 */
export function applyThreadStateRegistryChanges<T>(
  registry: Record<string, T>,
  changes: Iterable<ThreadStateRegistryChange<T>>
): AppliedThreadStateRegistryChange<T>[] {
  const applied: AppliedThreadStateRegistryChange<T>[] = []
  const seen = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.threadId)) {
      throw new Error(`duplicate ThreadState registry change: ${change.threadId}`)
    }
    seen.add(change.threadId)
    const previous = registry[change.threadId]
    if (Object.is(previous, change.state)) continue
    if (change.state === undefined) delete registry[change.threadId]
    else registry[change.threadId] = change.state
    applied.push({ threadId: change.threadId, previous, state: change.state })
  }
  return applied
}
