import type { BotRun } from "../../../shared/bot-types"
import type { PendingBotRecovery } from "../../../shared/bot-recovery"
import type {
  BotShellJobRead,
  BotShellJobStop,
  BotShellJobView
} from "../../../shared/bot-shell-jobs"

export function matchesShellJobAddress(
  input: Omit<BotShellJobRead, "offset">,
  receipt: BotShellJobView
): boolean {
  return (
    receipt?.id === input.jobId &&
    receipt.address?.conversationId === input.conversationId &&
    receipt.address.runId === input.runId &&
    receipt.address.threadRootId === input.threadRootId
  )
}
export function verifiesShellStop(input: BotShellJobStop, receipt: BotShellJobView): boolean {
  return (
    matchesShellJobAddress(input, receipt) &&
    (receipt.dataEpoch === undefined || receipt.dataEpoch === input.dataEpoch) &&
    (receipt.revision === input.revision || receipt.revision === input.revision + 1) &&
    ["cancelling", "succeeded", "failed", "cancelled", "needs_review"].includes(receipt.status)
  )
}
export function verifiesBotRecovery(
  original: BotRun,
  input: PendingBotRecovery,
  receipt: BotRun
): boolean {
  return (
    verifiesBotRecoveryResult(input, receipt) &&
    receipt.botId === original.botId &&
    receipt.conversationId === original.conversationId &&
    receipt.messageId === original.messageId &&
    receipt.threadRootId === original.threadRootId
  )
}

/** The immutable original receipt is verified independently from the task's current status. */
export function verifiesBotRecoveryResult(input: PendingBotRecovery, receipt: BotRun): boolean {
  return (
    receipt?.id === input.id &&
    receipt.revision === input.revision + 1 &&
    receipt.status === (input.decision === "resume" ? "queued" : "cancelled")
  )
}
