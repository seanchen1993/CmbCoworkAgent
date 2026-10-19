import type { UserInputRequest } from "@/types"
import { botTaskGroupId, type BotTask } from "../../../shared/bots/contracts"

/** Several inbox receipts can share one member's Runtime; show its current activity once. */
export function botGroupActiveTasks(groupId: string, tasks: readonly BotTask[]): BotTask[] {
  const priority: Partial<Record<BotTask["state"], number>> = {
    queued: 1,
    running: 2,
    waiting_user: 3
  }
  const members = new Map<string, BotTask>()
  for (const task of tasks) {
    const rank = priority[task.state] ?? 0
    if (botTaskGroupId(task) !== groupId || !rank) continue
    const previous = members.get(task.botId)
    if (rank > (previous ? (priority[previous.state] ?? 0) : 0)) members.set(task.botId, task)
  }
  return [...members.values()]
}

/** A room may answer only an actual pending request owned by its live member task. */
export function botGroupQuestion(
  groupId: string,
  task: BotTask,
  request: UserInputRequest | null
): UserInputRequest | null {
  return request &&
    botTaskGroupId(task) === groupId &&
    (task.state === "running" || task.state === "waiting_user") &&
    task.threadId === `group-${groupId}-${task.botId}` &&
    request.threadId === task.threadId
    ? request
    : null
}
