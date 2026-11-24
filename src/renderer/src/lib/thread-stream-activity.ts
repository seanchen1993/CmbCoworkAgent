export function collectChangedStreamingThreadIds(
  previous: Readonly<Record<string, boolean>>,
  current: Readonly<Record<string, boolean>>
): string[] {
  if (previous === current) return []

  const changedIds: string[] = []
  for (const [threadId, isLoading] of Object.entries(current)) {
    if (isLoading && previous[threadId] !== true) changedIds.push(threadId)
  }
  for (const [threadId, wasLoading] of Object.entries(previous)) {
    // An idle entry may disappear when the renderer releases its cached session.
    if (wasLoading && current[threadId] !== true) changedIds.push(threadId)
  }
  return changedIds
}
