import { createHash } from "node:crypto"
import type { BotTask } from "../../shared/bots/contracts"

export interface BotStoppedTaskContext {
  taskId: string
  state: "cancelled" | "interrupted"
  source: BotTask["origin"]["kind"]
  reference?: { kind: string; key: string; runStartedAt?: string }
  messagePreview: string
}

/** Workflow receipts need their instance fence; legacy receipts and coordinator claims stay unchanged. */
export function canDeferBotTask(task: Pick<BotTask, "origin">): boolean {
  return (
    ["group", "discussion", "bot", "schedule"].includes(task.origin.kind) ||
    (task.origin.kind === "notification" &&
      (task.origin.notificationKind === "command" ||
        (task.origin.notificationKind === "workflow" && Boolean(task.origin.runStartedAt))))
  )
}

/** Stable, hidden transcript identity; the original user message is never overwritten. */
export function botContinuationMessageId(taskId: string, checkpointId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !checkpointId.trim() || checkpointId.length > 200)
    throw new Error("Bot 续办标识无效")
  return `bot-continuation:${taskId}:${createHash("sha256").update(checkpointId).digest("hex")}`
}
