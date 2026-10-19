import type { Message } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import { isBotRoutineSilent } from "../../../shared/bots/routine-silence"

/** Quiet delivery is a projection of a proven scheduled turn, never a transcript deletion. */
export function quietBotTurnMessageIds(
  messages: readonly Message[],
  origins: ReadonlyMap<string, BotMessageOrigin>
): ReadonlySet<string> {
  const hidden = new Set<string>()
  let start = -1
  const finish = (end: number) => {
    if (start < 0) return
    const origin = origins.get(messages[start].id)
    if (origin?.origin.kind !== "schedule" || origin.state !== "completed") return
    let lastAssistant: Message | undefined
    for (let i = start + 1; i < end; i++) {
      if (messages[i].role === "system") return
      if (messages[i].role === "assistant" && !messages[i].subagent_tool_call_id)
        lastAssistant = messages[i]
    }
    if (
      !lastAssistant ||
      lastAssistant.tool_calls?.length ||
      typeof lastAssistant.content !== "string" ||
      !isBotRoutineSilent(lastAssistant.content)
    )
      return
    for (let i = start; i < end; i++) hidden.add(messages[i].id)
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue
    finish(i)
    start = i
  }
  finish(messages.length)
  return hidden
}
