import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import {
  isInternalNotificationMessage,
  isVisibleTranscriptMessage,
  TURN_COMPLETION_GATE_MARKER_PREFIX
} from "../../shared/checkpoint-transcript"
import { BOT_TOOL_OPENING, isBotContinuationReceipt, isBotHandoffCall } from "../../shared/bots/turn-feedback"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { withoutBotToolNarration } from "./bot-turn-context"
import { extractVisibleText } from "./turn-completion-integrity"

export const OPENING_REPLY_REMINDER =
  "If this request needs an assignment, make the handoff now with no accompanying prose. The host acknowledges accepted work. If you already have the requested answer, give it directly."

export const ACKNOWLEDGED_REPLY_REMINDER =
  "The user already has an acknowledgement. Continue without another announcement. At handoff, put a material finding already established by a tool in the optional finding field. For a direct answer, decision or failure, reply normally."

/** One request-scoped view shared by the opening nudge and accepted-dispatch completion. */
export function currentBotReplyState(messages: readonly BaseMessage[]):
  | {
      requestMessageId?: string
      requestText: string
      opening: string
      hasEvidence: boolean
      toolCalls: number
      internalInput: boolean
    }
  | undefined {
  let toolCalls = 0, internalInput = false, hasEvidence = false, opening = ""
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    // A delivery-gate retry belongs to this request. Other host notifications
    // and newer user inputs still have to be processed by their own turn.
    if (HumanMessage.isInstance(message) && typeof message.content === "string" &&
        message.content.startsWith(TURN_COMPLETION_GATE_MARKER_PREFIX)) continue
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
        requestText: extractVisibleText(message.additional_kwargs.cmb_visible_user_message ?? message.content).split("\n\n<bot_runtime_context", 1)[0],
        opening,
        hasEvidence,
        toolCalls,
        internalInput
      }
    }
    if (ToolMessage.isInstance(message) && message.name && !isBotHandoffCall({ name: message.name }) &&
        message.name !== "bot_feature_update" && !isBotContinuationReceipt(message)) hasEvidence = true
    if (!AIMessage.isInstance(message) || !message.tool_calls?.length) continue
    if (!opening && !message.tool_calls.every(isBotHandoffCall) &&
        splitBotInlineReasoning(extractVisibleText(message.content)).body.trim()) opening = BOT_TOOL_OPENING
    toolCalls += message.tool_calls.length
  }
  // Compaction may remove the boundary. Never infer a new request from old tools.
  return undefined
}

/** Opt-in main-turn nudge, never a tool gate, extra model call or persisted chat message. */
export function createOpeningReplyReminderMiddleware(pendingHandoff?: () => string | undefined): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "openingReplyReminder",
    wrapModelCall: async (request, handler) => {
      if (getHookAgentIdFromRequest(request)) return handler(request)
      const state = currentBotReplyState(request.messages)
      const reminder = state?.opening
        ? ACKNOWLEDGED_REPLY_REMINDER
        : state && state.toolCalls >= 2
          ? OPENING_REPLY_REMINDER
          : undefined
      const response = await handler(reminder ? {
        ...request,
        // This opt-in Bot nudge is ephemeral. Keep the system and retained history
        // untouched; changes to acknowledgement state only affect the request tail.
        messages: [...request.messages, new HumanMessage({
          content: `<bot_reply_reminder>${reminder}</bot_reply_reminder>`,
          additional_kwargs: { cmb_internal_coordinator_notification: true }
        })]
      } : request)
      if (!AIMessage.isInstance(response)) return response
      // The delivery gate retries an answer while a required handoff has no receipt.
      // A draft claiming success at this point must not become a public chat message.
      if (!response.tool_calls?.length) {
        if (!pendingHandoff?.() || request.messages.findLast(ToolMessage.isInstance)?.status === "error") return response
        return new AIMessage({ ...response, content: "" })
      }
      return withoutBotToolNarration(response)
    }
  })
}
