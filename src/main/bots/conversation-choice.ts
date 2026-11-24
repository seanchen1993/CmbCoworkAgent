import type { UserInputQuestion } from "../types"
import { requestUserInput } from "../services/user-input"
import type { BotConversationToolSource } from "../../shared/bots/thread-history"

/** Desktop conversation management stays local. An IM-native task can ask in its original chat. */
export async function conversationChoice(
  threadId: string, source: BotConversationToolSource, signal: AbortSignal,
  question: UserInputQuestion, surface: "desktop" | "im" = "desktop"
): Promise<string | undefined> {
  source.onWaiting?.(true)
  try {
    const response = await requestUserInput({
      threadId, questions: [question], abortSignal: signal, allowDeferredRenderer: true,
      ...(surface === "desktop" ? { kind: "bot_conversation_action" as const } : {})
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
