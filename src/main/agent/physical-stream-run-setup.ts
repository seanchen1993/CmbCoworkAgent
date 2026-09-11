export type PhysicalStreamRunSetupGuard = {
  isActive: () => boolean
  addCleanup: (cleanup: (wasActive: boolean, wasOwner: boolean) => void) => void
  abandon: () => void
  fail: (error: unknown) => void
  handoff: () => void
}

export type PhysicalStreamRunFailureDisposition = "stale" | "cancelled" | "error"

/**
 * Decide whether a failed physical run still owns its terminal side effects.
 *
 * An aborted run is no longer "active", but it still needs to persist its own
 * cancelled trace while it owns both the controller and queue lease. A run
 * superseded by a replacement has lost that lease and must not finalize into
 * the replacement lifecycle.
 */
export function classifyPhysicalStreamRunFailure({
  ownsLease,
  signalAborted,
  error
}: {
  ownsLease: boolean
  signalAborted: boolean
  error: unknown
}): PhysicalStreamRunFailureDisposition {
  if (!ownsLease) return "stale"
  if (signalAborted) return "cancelled"
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.includes("aborted") ||
      error.message.includes("Controller is already closed"))
  ) {
    return "cancelled"
  }
  return "error"
}

export function physicalStreamRunHasSuccessor({
  runToken,
  currentTurnRunToken,
  controllerReplaced
}: {
  runToken: string
  currentTurnRunToken: string | undefined
  controllerReplaced: boolean
}): boolean {
  return (
    controllerReplaced ||
    (currentTurnRunToken !== undefined && currentTurnRunToken !== runToken)
  )
}

export function restorePhysicalStreamRunPredecessorToken({
  abandonedRunToken,
  currentTurnRunToken,
  predecessorRunToken
}: {
  abandonedRunToken: string
  currentTurnRunToken: string
  predecessorRunToken: string
}): string {
  return currentTurnRunToken === abandonedRunToken
    ? predecessorRunToken
    : currentTurnRunToken
}

export function failPhysicalStreamRunBeforeSetupPublication({
  error,
  sendError,
  sendDone
}: {
  error: unknown
  sendError: (message: string) => void
  sendDone: () => void
}): void {
  sendError(error instanceof Error ? error.message : String(error))
  sendDone()
}

export function createPhysicalStreamRunSetupGuard({
  isActive,
  ownsLease = isActive,
  release,
  onActiveError
}: {
  isActive: () => boolean
  ownsLease?: () => boolean
  release: () => void
  onActiveError: (error: unknown) => void
}): PhysicalStreamRunSetupGuard {
  let closed = false
  const cleanups: Array<(wasActive: boolean, wasOwner: boolean) => void> = []
  const close = (error: { value: unknown } | null): void => {
    if (closed) return
    closed = true
    const wasActive = isActive()
    const wasOwner = ownsLease()
    release()
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup(wasActive, wasOwner)
      } catch (cleanupError) {
        console.warn("[Agent] Physical stream setup cleanup failed:", cleanupError)
      }
    }
    if (error && wasActive) onActiveError(error.value)
  }
  return {
    isActive,
    addCleanup: (cleanup) => {
      if (!closed) cleanups.push(cleanup)
    },
    abandon: () => close(null),
    fail: (error) => close({ value: error }),
    handoff: () => {
      if (closed) return
      closed = true
      cleanups.length = 0
    }
  }
}
