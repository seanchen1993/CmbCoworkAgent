import { createHash } from "node:crypto"
import type { BotTask } from "../../shared/bots/contracts"

export type BotStoppedTaskContext =
  | {
      taskId: string
      state: "cancelled" | "interrupted"
      source: BotTask["origin"]["kind"]
      reference?: { kind: string; key: string; runStartedAt?: string }
      messagePreview: string
    }
  | {
      commandId: string
      state: "cancelled"
      source: "background_command"
      sourceTaskId: string | null
      commandPreview: string
    }

/** Only direct user input in the same conversation may join its active Runtime. */
export function canSteerBotTask(source: BotTask, incoming: BotTask): boolean {
  if (source.botId !== incoming.botId || source.threadId !== incoming.threadId) return false
  if (incoming.origin.kind === "user")
    return source.origin.kind === "user" || source.origin.kind === "introduction"
  return (
    source.origin.kind === "group" &&
    incoming.origin.kind === "group" &&
    source.origin.groupId === incoming.origin.groupId &&
    source.threadId === `group-${source.origin.groupId}-${source.botId}`
  )
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
