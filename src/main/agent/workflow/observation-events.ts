/** Native observation runs after the original store changes and cannot alter execution. */
const listeners = new Set<(threadId: string, runId: string) => void>()

export function onWorkflowObservationChange(listener: (threadId: string, runId: string) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitWorkflowObservationChange(threadId: string, runId: string): void {
  for (const listener of listeners) {
    try {
      listener(threadId, runId)
    } catch {
      /* Observation cannot rewrite a native result. */
    }
  }
}
