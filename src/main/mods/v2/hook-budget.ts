import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Native monotonic accounting. Receipts belong to this meter, never to guest request IDs. */
export class FunctionHookBudget {
  private started = false
  private closed = false
  private spent = 0
  private updatedAt = 0
  private readonly waits = new Set<symbol>()

  constructor(
    readonly ms: number,
    private readonly now: () => number = () => performance.now()
  ) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 10000)
      throw new ModFunctionError("MODS_HOOK_BUDGET_INVALID")
  }

  start(): void {
    if (this.closed || this.started) throw new ModFunctionError("MODS_STALE_INVOCATION")
    this.started = true
    this.updatedAt = this.now()
  }

  private settle(): void {
    if (this.closed) throw new ModFunctionError("MODS_STALE_INVOCATION")
    const now = this.now()
    if (this.started && !this.waits.size) this.spent += Math.max(0, now - this.updatedAt)
    this.updatedAt = now
  }

  snapshot(): { ms: number; remainingMs: number } {
    this.settle()
    return {
      ms: this.ms,
      remainingMs: this.ms === 0 ? Infinity : Math.max(0, this.ms - this.spent)
    }
  }

  assertRemaining(): void {
    if (this.snapshot().remainingMs <= 0) throw new ModFunctionError("MODS_HOOK_BUDGET_EXCEEDED")
  }

  beginFreeWait(): () => void {
    // Check synchronously before pausing: a new RPC cannot revive an exhausted frame.
    this.assertRemaining()
    const receipt = Symbol()
    this.waits.add(receipt)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      if (this.closed) return
      this.settle()
      this.waits.delete(receipt)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waits.clear()
  }
}

/** Clock waits consume own time; the admission ACK is outside guest code entirely. */
export function isFreeFunctionWait(method: string): boolean {
  return !["invoke.admitted", "clock.sleep", "clock.after", "clock.every"].includes(method)
}
