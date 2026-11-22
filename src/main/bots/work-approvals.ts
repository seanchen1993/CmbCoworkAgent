import { approvalDecisionBroker } from "../agent/approval-decision-broker"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import type { BotRunPort } from "./host"

/** Project only the approval the native conversation will show first. */
export const botWorkApprovals = {
  pendingApproval(task, requestIds) {
    const lease = getLocalThreadRunLease(task.threadId)
    if (lease?.owner !== "bot" || lease.runId !== task.id) return undefined
    const [head] = approvalDecisionBroker.list(task.threadId)
    return head?.runtimeThreadId === task.threadId && requestIds.has(head.request.id)
      ? head.request.id : undefined
  },
  subscribeApprovalChanges(listener) {
    const pending = approvalDecisionBroker.subscribePending(({ request }) => listener(request.id))
    // A different runtime's queue head can hide a later approval owned by this run.
    const removed = approvalDecisionBroker.subscribeRemoved(() => listener())
    return () => {
      pending()
      removed()
    }
  }
} satisfies Pick<BotRunPort, "pendingApproval" | "subscribeApprovalChanges">
