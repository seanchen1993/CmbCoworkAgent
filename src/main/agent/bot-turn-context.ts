import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { extractVisibleText } from "./turn-completion-integrity"

/** Supplied only by the local Bot host, never inferred from user text or thread metadata. */
export interface BotTurnContext {
  event: "user_request" | "introduction" | "task_result" | "task_result_review"
  text: string
}

/** Attach once to this new input so checkpoints retain it without changing earlier messages. */
export function appendBotTurnContext(
  message: HumanMessage | undefined,
  context: BotTurnContext | undefined
): HumanMessage | undefined {
  if (!message || !context) return message
  // The host's permission to inspect a result is separate from what the user asked for.
  const event = context.event === "task_result_review" ? "task_result" : context.event
  const contextText = `\n\n<bot_runtime_context event="${event}">\n${context.text}\n</bot_runtime_context>`
  return new HumanMessage({
    ...message,
    content:
      typeof message.content === "string"
        ? message.content + contextText
        : [...message.content, { type: "text", text: contextText }],
    additional_kwargs: {
      ...message.additional_kwargs,
      // Existing transcript projection also used by skill and coordinator context.
      cmb_coordinator_augmented_user_message: true,
      cmb_visible_user_message:
        message.additional_kwargs.cmb_visible_user_message ?? message.content
    }
  })
}

/** An assistant step is either a tool call or a public answer. Preserve separate reasoning and tool receipts. */
export function withoutBotToolNarration(message: AIMessage): AIMessage {
  if (!message.tool_calls?.length) return message
  const content = typeof message.content === "string" ? "" :
    message.content.filter(block => !extractVisibleText([block]))
  return new AIMessage({ ...message, content })
}

/** Keep schemas stable; automatic result events cannot execute even if a provider ignores none. */
export const BOT_REVIEW_TOOLS = new Set(["bot_work_result_read", "bot_work_result_select_files",
  "bot_work_result_keep_service", "bot_work_result_continue"])

export function createBotResultReportMiddleware(review = false) {
  return createMiddleware({
    name: "botResultReport",
    wrapModelCall: async (request, handler) => {
      const result = await handler(review ? request : { ...request, toolChoice: "none" })
      return AIMessage.isInstance(result) ? withoutBotToolNarration(result) : result
    },
    wrapToolCall: (request, handler) =>
      review && BOT_REVIEW_TOOLS.has(request.toolCall.name) ? handler(request) : new ToolMessage({
        name: request.toolCall.name,
        tool_call_id: request.toolCall.id!,
        status: "error",
        content: review
          ? "This call did not execute. Answer from the returned findings if sufficient. For a material gap, inspect this task's retained evidence with bot_work_result_read."
          : "This call did not execute. Answer from the supplied outcome and receipts. Identify any unresolved fact that affects the conclusion."
      })
  })
}
