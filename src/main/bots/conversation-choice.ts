import type { UserInputQuestion } from "../types"
import { requestUserInput } from "../services/user-input"
import type { BotConversationToolSource } from "../../shared/bots/thread-history"

/** Only a submitted option on this desktop thread can grant the described operation. */
export async function conversationChoice(
  threadId: string, source: BotConversationToolSource, signal: AbortSignal,
  question: UserInputQuestion
): Promise<string | undefined> {
  source.onWaiting?.(true)
  try {
    const response = await requestUserInput({
      threadId, questions: [question], abortSignal: signal, allowDeferredRenderer: true, kind: "bot_conversation_action"
    })
    signal.throwIfAborted()
    if ("autoResolved" in response || response.ignored) return
    const answer = response.answers[question.id]
    if (answer?.type !== "option" || answer.questionId !== question.id ||
        !Number.isInteger(answer.optionIndex) || answer.additionalText) return
    const option = question.options[answer.optionIndex]
    return option && option.label === answer.label ? option.label : undefined
  } finally {
    source.onWaiting?.(false)
  }
}
