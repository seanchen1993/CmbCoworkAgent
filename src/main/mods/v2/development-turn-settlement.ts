import type { ThreadIncarnation } from "../../services/thread-incarnation"

export interface DevelopmentTurnSettlement {
  threadId: string
  incarnation: ThreadIncarnation
  turnId: string
  outcome: "completed" | "failed" | "cancelled"
}
const listeners = new Set<(settlement: DevelopmentTurnSettlement) => void>()

/** Main-process physical finalization only; never exposed through the guest SDK or IPC. */
export function observeDevelopmentTurnSettlement(
  listener: (settlement: DevelopmentTurnSettlement) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishDevelopmentTurnSettlement(settlement: DevelopmentTurnSettlement): void {
  const captured = Object.freeze({
    ...settlement,
    incarnation: Object.freeze({ ...settlement.incarnation })
  })
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(captured)
      } catch {
        /* A deleted/revoked authoring scope must not change original turn settlement. */
      }
    }
  })
}
