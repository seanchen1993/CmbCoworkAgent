import type { Message } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import { BOT_ROUTINE_SILENT, isBotRoutineSilent } from "../../../shared/bots/routine-silence"
import { splitBotInlineReasoning } from "../../../shared/bots/inline-reasoning"
import {
  botContinuationTaskId,
  isBotCommandNotificationMessageId
} from "../../../shared/bots/task-continuation"

/** Preserve invisible task boundaries even before source lookup or after history hydration. */
export function hiddenBotTaskMessageIds(
  messages: readonly Message[],
  origins: ReadonlyMap<string, BotMessageOrigin>
): ReadonlySet<string> {
  const hidden = new Set(quietBotTurnMessageIds(messages, origins))
  for (const message of messages)
    if (
      message.role === "user" &&
      (botContinuationTaskId(message.id) || isBotCommandNotificationMessageId(message.id))
    )
      hidden.add(message.id)
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

/** Quiet delivery projects proven no-news turns; it never deletes their transcripts. */
export function quietBotTurnMessageIds(
  messages: readonly Message[],
  origins: ReadonlyMap<string, BotMessageOrigin>
): ReadonlySet<string> {
  const hidden = new Set<string>()
  const ranges: Array<{ start: number; end: number; taskId: string }> = []
  const quiet = new Set<string>()
  const blocked = new Set<string>()
  const actionable = new Set<string>()
  let start = -1
  const finish = (end: number) => {
    if (start < 0) return
    const origin = origins.get(messages[start].id)
    if (
      origin?.origin.kind !== "schedule" &&
      !(
        origin?.origin.kind === "notification" &&
        origin.origin.notificationKind === "command" &&
        origin.origin.commandSucceeded === true
      )
    )
      return
    ranges.push({ start, end, taskId: origin.id })
    let lastAssistant: Message | undefined
    for (let i = start + 1; i < end; i++) {
      if (messages[i].role === "system") blocked.add(origin.id)
      if (
        messages[i].tool_calls?.some(
          (tool) =>
            tool.name === "bot_deliver_files" ||
            tool.name === "request_user_input" ||
            tool.name === "bot_request_browser_help" ||
            (tool.name === "bot_browser" && tool.args.action === "request_help")
        )
      ) {
        blocked.add(origin.id)
        actionable.add(origin.id)
      }
      if (messages[i].role === "assistant" && !messages[i].subagent_tool_call_id)
        lastAssistant = messages[i]
    }
    if (
      origin.origin.kind === "notification" &&
      ["queued", "running", "waiting_user"].includes(origin.state) &&
      lastAssistant &&
      !lastAssistant.tool_calls?.length &&
      typeof lastAssistant.content === "string"
    ) {
      const body = splitBotInlineReasoning(lastAssistant.content).body.trim()
      if (body && BOT_ROUTINE_SILENT.startsWith(body)) hidden.add(lastAssistant.id)
    }
    if (
      origin.state !== "completed" ||
      !lastAssistant ||
      lastAssistant.tool_calls?.length ||
      typeof lastAssistant.content !== "string" ||
      !isBotRoutineSilent(lastAssistant.content)
    )
      quiet.delete(origin.id)
    else {
      quiet.add(origin.id)
      // Keep an actionable file/question card even when its final reply is the control marker.
      if (origin.origin.kind === "notification" || actionable.has(origin.id))
        hidden.add(lastAssistant.id)
    }
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
