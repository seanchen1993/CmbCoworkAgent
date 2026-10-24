import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { isWorkflowPlumbingTranscriptContent } from "../../shared/checkpoint-transcript"
import { isFreeformUserInputOption } from "../../shared/user-input-options"
import type { BotTask } from "../../shared/bots/contracts"
import {
  inspectFinalAssistantMessage,
  type TurnFinalDeliveryCheck
} from "../agent/turn-completion-integrity"

function isGettingStartedQuestion(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const args = input as Record<string, unknown>
  if ("autoResolutionMs" in args || !Array.isArray(args.questions) || args.questions.length !== 1)
    return false
  const question = args.questions[0]
  if (!question || typeof question !== "object" || !Array.isArray(question.options)) return false
  const options = question.options
  return (
    typeof question.id === "string" &&
    question.id.length > 0 &&
    typeof question.question === "string" &&
    question.question.trim().length > 0 &&
    options.length >= 3 &&
    options.length <= 5 &&
    // The real tool removes these labels before displaying the question.
    options.filter(
      (option) =>
        option &&
        typeof option.label === "string" &&
        option.label.trim() &&
        !isFreeformUserInputOption(option.label)
    ).length >= 3
  )
}

/** Enforce the existing first-choice protocol, using this introduction's actual receipts. */
export function createBotIntroductionDeliveryCheck(
  task: BotTask,
  stillRequired: () => boolean
): TurnFinalDeliveryCheck {
  return (messages) => {
    const currentReply = () => {
      const final = messages.at(-1)
      const defect =
        final && AIMessage.isInstance(final) ? inspectFinalAssistantMessage(final).defect : null
      // Undefined satisfies the explicit-delivery hook, including for an empty final.
      // After setup yields, retain the original nonempty-answer boundary for real work.
      return defect === "empty_response" || defect === "reasoning_only"
        ? "Provide a visible answer to the current user request. Do not resume the introduction or ask a getting-started question."
        : undefined
    }
    if (task.origin.kind !== "introduction" || !stillRequired()) return currentReply()
    const reminder =
      "The getting-started choice has not been shown. Do not repeat your greeting. Call request_user_input with one question and 3-5 concrete choices using your available capabilities, omit autoResolutionMs, and wait for the real user answer. Do not replace the choice widget with prose or assume an answer."
    let start = -1
    for (let i = messages.length - 1; i >= 0; i--)
      if (HumanMessage.isInstance(messages[i]) && messages[i].id === task.requestId) {
        start = i + 1
        break
      }
    if (start < 0) return reminder
    const calls = new Set<string>()
    let delivered = false
    for (let i = start; i < messages.length; i++) {
      const message = messages[i]
      // The original steer queue runs before this check. A real user turn ends setup;
      // completion-recovery cues are plumbing, not a new answer or authorization.
      if (HumanMessage.isInstance(message) && !isWorkflowPlumbingTranscriptContent(message.content))
        return currentReply()
      if (AIMessage.isInstance(message))
        for (const call of message.tool_calls ?? [])
          if (call.id) {
            if (call.name === "request_user_input" && isGettingStartedQuestion(call.args))
              calls.add(call.id)
            else calls.delete(call.id)
          }
      if (
        !ToolMessage.isInstance(message) ||
        !calls.has(message.tool_call_id) ||
        message.status === "error" ||
        typeof message.content !== "string"
      )
        continue
      try {
        const receipt = JSON.parse(message.content)
        if (
          (receipt?.status === "submitted" || receipt?.status === "ignored") &&
          typeof receipt.requestId === "string" &&
          receipt.requestId.trim() &&
          receipt.answers &&
          typeof receipt.answers === "object" &&
          !Array.isArray(receipt.answers)
        )
          delivered = true
      } catch {
        /* A malformed or unrelated tool result does not prove the choice was shown. */
      }
    }
    return delivered ? undefined : reminder
  }
}
