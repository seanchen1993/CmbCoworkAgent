/** Pending asynchronous title proposals only; no persistent cache or timestamps. */
const pending = new Map<string, Set<{ current: boolean }>>()

export function observeThreadTitle(threadId: string) {
  const state = { current: true }
  const observers = pending.get(threadId) ?? new Set<{ current: boolean }>()
  pending.set(threadId, observers)
  observers.add(state)
  return {
    isCurrent: () => state.current,
    close() {
      state.current = false
      observers.delete(state)
      if (pending.get(threadId) === observers && observers.size === 0) pending.delete(threadId)
    }
  }
}

/** Called only after a successful native title write, even if the text is unchanged. */
export function invalidateThreadTitleObservers(threadId: string): void {
  const observers = pending.get(threadId)
  if (!observers) return
  for (const observer of observers) observer.current = false
  pending.delete(threadId)
}
