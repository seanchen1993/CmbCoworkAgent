import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"

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
  const contextText = `\n\n<bot_runtime_context event="${context.event}">\n${context.text}\n</bot_runtime_context>`
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

/** Keep schemas stable; automatic result events cannot execute even if a provider ignores none. */
export const BOT_REVIEW_TOOLS = new Set(["bot_work_result_read", "bot_work_result_select_files",
  "bot_work_result_keep_service", "bot_work_result_continue"])

export function createBotResultReportMiddleware(review = false) {
  return createMiddleware({
    name: "botResultReport",
    wrapModelCall: (request, handler) => handler(review ? request : { ...request, toolChoice: "none" }),
    wrapToolCall: (request, handler) =>
      review && BOT_REVIEW_TOOLS.has(request.toolCall.name) ? handler(request) : new ToolMessage({
        name: request.toolCall.name,
        tool_call_id: request.toolCall.id!,
        status: "error",
        content: review ? "Only the four scoped bot_work_result tools can run in a result review. This call did not execute." :
          "This task_result event cannot invoke tools. The call did not execute. Report only the supplied result, host status and receipts; do not retry or start work."
      })
  })
}
