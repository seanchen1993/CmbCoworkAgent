import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import {
  isInternalNotificationMessage,
  isVisibleTranscriptMessage
} from "../../shared/checkpoint-transcript"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { extractVisibleText } from "./turn-completion-integrity"

export const OPENING_REPLY_REMINDER =
  "You have used tools for the current user message without a visible reply. Briefly tell the user what you are doing or what you actually found, using normal assistant text. Do not expose private reasoning or invent progress. If work remains, include the next needed tool call in the same response so execution continues; this update is not task completion. If the work is already done, give the actual result directly instead of an extra acknowledgement."

export const ACKNOWLEDGED_REPLY_REMINDER =
  "The current user request already has a visible acknowledgement. Continue the next action without another opening or handoff announcement. Reading a skill, deciding to delegate, or receiving a dispatch receipt is not a new user-facing update; do not summarize the skill's workflow. If dispatch now covers all remaining work, call it with finishTurn: true and no assistant text. Still deliver any new actual answer, important finding, needed decision or genuine failure. Do not omit substantive results."

/** One request-scoped view shared by the opening nudge and accepted-dispatch completion. */
export function currentBotReplyState(messages: readonly BaseMessage[]):
  | {
      requestMessageId?: string
      opening: string
      followup: string
      toolCalls: number
      internalInput: boolean
    }
  | undefined {
  let toolCalls = 0, internalInput = false
  const replies: string[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isInternalNotificationMessage(message)) {
      internalInput = true
      continue
    }
    if (HumanMessage.isInstance(message)) {
      if (!isVisibleTranscriptMessage("user", message.content)) {
        internalInput = true
        continue
      }
      return {
        requestMessageId: message.id,
        opening: replies.at(-1) ?? "",
        followup: replies.slice(0, -1).reverse().join("\n\n"),
        toolCalls,
        internalInput
      }
    }
    if (!AIMessage.isInstance(message)) continue
    const text = splitBotInlineReasoning(extractVisibleText(message.content)).body.trim()
    if (text) replies.push(text)
    toolCalls += message.tool_calls?.length ?? 0
  }
  // Compaction may remove the boundary. Never infer a new request from old tools.
  return undefined
}

/** Opt-in main-turn nudge, never a tool gate, extra model call or persisted chat message. */
export function createOpeningReplyReminderMiddleware(): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "openingReplyReminder",
    wrapModelCall: (request, handler) => {
      if (getHookAgentIdFromRequest(request)) return handler(request)
      const state = currentBotReplyState(request.messages)
      const reminder = state?.opening
        ? ACKNOWLEDGED_REPLY_REMINDER
        : state && state.toolCalls >= 2
          ? OPENING_REPLY_REMINDER
          : undefined
      if (!reminder) return handler(request)
      return handler({
        ...request,
        // This opt-in Bot nudge is ephemeral. Keep the system and retained history
        // untouched; changes to acknowledgement state only affect the request tail.
        messages: [...request.messages, new HumanMessage({
          content: `<bot_reply_reminder>${reminder}</bot_reply_reminder>`,
          additional_kwargs: { cmb_internal_coordinator_notification: true }
        })]
      })
    }
  })
}
