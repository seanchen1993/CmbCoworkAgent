import type { ApprovalDecision } from "../types"

/** Cancellation tears down an approval waiter; it is not a new user rejection. */
export function notifyExplicitToolRejection(
  decision: ApprovalDecision,
  signal: AbortSignal | undefined,
  onRejected: ((reason: string) => void) | undefined
): void {
  if (
    !onRejected ||
    signal?.aborted ||
    ["approve", "approve_session", "approve_permanent"].includes(decision.type)
  )
    return
  onRejected("approval-rejected")
  signal?.throwIfAborted()
}
