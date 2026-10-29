import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { isVisibleTranscriptMessage } from "../../shared/checkpoint-transcript"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { extractVisibleText } from "./turn-completion-integrity"

export const OPENING_REPLY_REMINDER =
  "You have used tools for the current user message without a visible reply. Briefly tell the user what you are doing or what you actually found, using normal assistant text. Do not expose private reasoning or invent progress. If work remains, include the next needed tool call in the same response so execution continues; this update is not task completion. If the work is already done, give the actual result directly instead of an extra acknowledgement."

/** Inspect only the current visible user turn; internal recovery cues are not new requests. */
function needsOpeningReply(messages: readonly BaseMessage[]): boolean {
  let calls = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (HumanMessage.isInstance(message)) {
      if (!isVisibleTranscriptMessage("user", message.content)) continue
      return calls >= 2
    }
    if (!AIMessage.isInstance(message)) continue
    // Thinking blocks and providers' inline <think> text are not a user-facing reply.
    if (splitBotInlineReasoning(extractVisibleText(message.content)).body.trim()) return false
    calls += message.tool_calls?.length ?? 0
  }
  // Compaction may remove the boundary. Do not infer a new request from old tool activity.
  return false
}

/** Opt-in main-turn nudge, never a tool gate, extra model call or persisted chat message. */
export function createOpeningReplyReminderMiddleware(): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "openingReplyReminder",
    wrapModelCall: (request, handler) => {
      if (getHookAgentIdFromRequest(request) || !needsOpeningReply(request.messages))
        return handler(request)
      return handler({
        ...request,
        systemMessage: request.systemMessage
          ? request.systemMessage.concat(`\n\n${OPENING_REPLY_REMINDER}`)
          : new SystemMessage(OPENING_REPLY_REMINDER)
      })
    }
  })
}
