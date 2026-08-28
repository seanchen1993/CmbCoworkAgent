export type ReplacementSettlementOutcome = "settled" | "timed_out"

export class TimedOutPredecessorFence {
  private readonly pending = new Map<string, Set<Promise<void>>>()

  track(threadId: string, settled: Promise<void>): void {
    const entries = this.pending.get(threadId) ?? new Set<Promise<void>>()
    if (entries.has(settled)) return
    entries.add(settled)
    this.pending.set(threadId, entries)
    void settled.finally(() => {
      const current = this.pending.get(threadId)
      current?.delete(settled)
      if (current?.size === 0) this.pending.delete(threadId)
    })
  }

  hasPending(threadId: string): boolean {
    return (this.pending.get(threadId)?.size ?? 0) > 0
  }
}

export function canUseBoundedCheckpointRecovery(
  outcome: ReplacementSettlementOutcome,
  hasTimedOutPredecessor: boolean
): boolean {
  return outcome === "settled" && !hasTimedOutPredecessor
}
