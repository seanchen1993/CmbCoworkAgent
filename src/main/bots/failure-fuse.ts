import {
  clearFailureFuseTurn,
  recordToolFailure,
  recordToolSuccess,
  type FailureFuseDecision,
  type FailureFuseInput
} from "../agent/failure-fuse"
import type { BotRuntimeRequest } from "./host"
import { currentFailureFusePolicy, type BotFailureFusePolicy } from "./failure-fuse-policy"

/** Reuse Cmb's transient retry feedback. These counters are not task budgets or
 * permission state; a new physical execution starts its own observation window. */
export function botFailureFuse(request: BotRuntimeRequest, configured?: BotFailureFusePolicy) {
  const { store, run, lease } = request
  const identity = { threadId: run.id, turnId: `${lease.owner}:${lease.fence}` }
  const policy = store.runFailureFusePolicy(lease, configured ?? currentFailureFusePolicy())
  return {
    failure: (input: Omit<FailureFuseInput, "threadId" | "turnId" | "mode">) => ({
      ...recordToolFailure({ ...input, ...identity, mode: policy.mode }),
      userNoticeEnabled: policy.userNoticeEnabled,
      modelFeedbackEnabled: policy.modelFeedbackEnabled
    }),
    success: (input: { toolName: string; toolArgs: Record<string, unknown> }) =>
      recordToolSuccess({ ...input, ...identity }),
    notice: (decision: FailureFuseDecision) => {
      // Error fingerprints can contain provider text or tool arguments. Keep
      // that data out of persistent user-visible activity and notifications.
      store.activity(lease, `同一工具已重复失败 ${decision.count} 次，需要调整执行方式`)
    },
    close: () => clearFailureFuseTurn(identity.threadId, identity.turnId)
  }
}
