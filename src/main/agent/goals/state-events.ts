const listeners = new Set<(threadId: string) => void>()

export function onGoalStateChanged(listener: (threadId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notify after durable mutation; listeners re-read state and never inherit a mutation lock. */
export function notifyGoalStateChanged(threadId: string): void {
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(threadId)
      } catch (error) {
        console.error("[Goal] State listener failed:", error)
      }
    }
  })
}
