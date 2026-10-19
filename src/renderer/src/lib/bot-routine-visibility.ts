import type { Message } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import { isBotRoutineSilent } from "../../../shared/bots/routine-silence"
import { botContinuationTaskId } from "../../../shared/bots/task-continuation"

/** Preserve invisible task boundaries even before source lookup or after history hydration. */
export function hiddenBotTaskMessageIds(
  messages: readonly Message[],
  origins: ReadonlyMap<string, BotMessageOrigin>
): ReadonlySet<string> {
  const hidden = new Set(quietBotTurnMessageIds(messages, origins))
  for (const message of messages)
    if (message.role === "user" && botContinuationTaskId(message.id)) hidden.add(message.id)
  return hidden
}

/** A continuation keeps its transcript ID while its original task supplies the latest state. */
export function mergeBotMessageOrigins(
  origins: readonly BotMessageOrigin[],
  tasks: readonly BotMessageOrigin[]
): ReadonlyMap<string, BotMessageOrigin> {
  const current = new Map(tasks.map((task) => [task.id, task]))
  return new Map(
    [
      ...origins.map((origin) => ({
        ...origin,
        state: current.get(origin.id)?.state ?? origin.state
      })),
      ...tasks
    ].map((origin) => [origin.requestId, origin])
  )
}

/** Quiet delivery is a projection of a proven scheduled turn, never a transcript deletion. */
export function quietBotTurnMessageIds(
  messages: readonly Message[],
  origins: ReadonlyMap<string, BotMessageOrigin>
): ReadonlySet<string> {
  const hidden = new Set<string>()
  const ranges: Array<{ start: number; end: number; taskId: string }> = []
  const quiet = new Set<string>()
  const blocked = new Set<string>()
  let start = -1
  const finish = (end: number) => {
    if (start < 0) return
    const origin = origins.get(messages[start].id)
    if (origin?.origin.kind !== "schedule") return
    ranges.push({ start, end, taskId: origin.id })
    let lastAssistant: Message | undefined
    for (let i = start + 1; i < end; i++) {
      if (messages[i].role === "system") blocked.add(origin.id)
      if (messages[i].role === "assistant" && !messages[i].subagent_tool_call_id)
        lastAssistant = messages[i]
    }
    if (
      origin.state !== "completed" ||
      !lastAssistant ||
      lastAssistant.tool_calls?.length ||
      typeof lastAssistant.content !== "string" ||
      !isBotRoutineSilent(lastAssistant.content)
    )
      quiet.delete(origin.id)
    else quiet.add(origin.id)
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue
    finish(i)
    start = i
  }
  finish(messages.length)
  for (const range of ranges) {
    if (!quiet.has(range.taskId) || blocked.has(range.taskId)) continue
    for (let i = range.start; i < range.end; i++) hidden.add(messages[i].id)
  }
  return hidden
}
