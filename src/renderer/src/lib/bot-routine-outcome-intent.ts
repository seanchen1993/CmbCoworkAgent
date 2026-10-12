import { botRoutineSaveOutcome } from "../../../shared/bot-routine-outcome"
import type { BotConversation, BotMessage, CoworkBot } from "../../../shared/bot-types"
import type { BotRoutineOpenIntent } from "./bot-routine-toggle"

/** Recheck the live view at the click boundary; old messages do not authorize navigation. */
export function routineOutcomeIntent(input: {
  message: BotMessage
  conversation: Pick<BotConversation, "id" | "members"> | undefined
  threadRootId?: string
  dataEpoch: string
  bots: readonly CoworkBot[]
  active: boolean
  capabilities?: readonly string[]
}): { botId: string; intent: BotRoutineOpenIntent } | null {
  const parsed = botRoutineSaveOutcome.safeParse(input.message.routineOutcome)
  if (!parsed.success || !input.active || !input.capabilities?.includes("routine-save-outcomes"))
    return null
  const outcome = parsed.data
  const bot = input.bots.find((item) => item.id === outcome.botId)
  if (
    !bot ||
    bot.hidden ||
    bot.deletedAt !== null ||
    outcome.dataEpoch !== input.dataEpoch ||
    !input.message.runId ||
    input.message.sender !== "system" ||
    input.message.botId !== outcome.botId ||
    input.message.conversationId !== input.conversation?.id ||
    !input.conversation.members.includes(outcome.botId) ||
    input.message.threadRootId !== input.threadRootId
  )
    return null
  return {
    botId: outcome.botId,
    intent: { id: outcome.id, dataEpoch: outcome.dataEpoch, mode: "view" }
  }
}
