import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { readFinishSignal } from "../agent/turn-completion-integrity"

/** A real delivery receipt cannot waive a provider's explicitly truncated final. */
export function botTruncationReminder(messages: readonly BaseMessage[]): string | undefined {
  const final = messages.at(-1)
  if (
    final && AIMessage.isInstance(final) &&
    ["length", "max_tokens", "max_output_tokens", "model_length", "content_filter_length"].includes(
      readFinishSignal(final) ?? ""
    )
  )
    return "The model response was truncated. Continue the unfinished response using existing results; do not repeat completed tools or deliveries."
  return undefined
}
