import type { Message, ToolCall, ToolResult, UserInputRequest } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { botToolResultStatus } from "./bot-tool-result-status"

type Answer = { text: string; additionalText?: string }
export interface BotQuestionHistory {
  status: "submitted" | "ignored" | "auto_resolved" | "cancelled" | "interrupted"
  questions: Array<{ id: string; question: string; answer?: Answer }>
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= max

function questionSources(tool: ToolCall): BotQuestionHistory["questions"] | null {
  if (tool.name !== "request_user_input") return null
  const values = tool.args?.questions
  if (!Array.isArray(values) || !values.length || values.length > 10) return null
  const ids = new Set<string>()
  const questions: BotQuestionHistory["questions"] = []
  for (const value of values) {
    const question = record(value)
    if (
      !question ||
      !text(question.id, 80) ||
      ids.has(question.id) ||
      !text(question.question, 500)
    )
      return null
    ids.add(question.id)
    questions.push({ id: question.id, question: question.question })
  }
  return questions
}

/** A proven stopped turn can have no ToolMessage; never invent an answer or receipt. */
export function stoppedBotQuestionHistory(
  messages: readonly Message[],
  origins: ReadonlyMap<string, BotMessageOrigin>
): Map<string, BotQuestionHistory> {
  const stopped = new Map<string, BotQuestionHistory>()
  const seen = new Set<string>()
  const results = buildToolResultAssociations(messages)
  let state: BotMessageOrigin["state"] | undefined
  for (const message of messages) {
    if (message.role === "user" && !message.subagent_tool_call_id) {
      state = origins.get(message.id)?.state
      continue
    }
    if (message.role !== "assistant") continue
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      if (call.name !== "request_user_input" || !call.id) continue
      if (seen.has(call.id)) {
        stopped.delete(call.id)
        continue
      }
      seen.add(call.id)
      if (
        message.subagent_tool_call_id ||
        (state !== "cancelled" && state !== "interrupted") ||
        results.has(getWorkerToolUiKey(message.id, call.id, index))
      )
        continue
      const questions = questionSources(call)
      if (questions) stopped.set(call.id, { status: state, questions })
    }
  }
  return stopped
}

/** Only a loaded, unanswered call matching the actual pending request can fold behind its card. */
export function pendingBotQuestionCallId(
  messages: readonly Message[],
  request: UserInputRequest | null
): string | null {
  if (!request?.questions.length) return null
  const results = buildToolResultAssociations(messages)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const calls = message.tool_calls ?? []
    for (let toolIndex = calls.length - 1; toolIndex >= 0; toolIndex--) {
      const call = calls[toolIndex]
      if (call.name !== "request_user_input" || !call.id) continue
      const questions = call.args?.questions
      if (
        Array.isArray(questions) &&
        questions.length === request.questions.length &&
        questions.every((value, questionIndex) => {
          const question = record(value)
          const pending = request.questions[questionIndex]
          return question?.id === pending.id && question.question === pending.question
        })
      )
        return results.has(getWorkerToolUiKey(message.id, call.id, toolIndex)) ? null : call.id
    }
  }
  return null
}

/** Read-only receipt projection. A default option or timer is never a user answer. */
export function botQuestionHistory(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): BotQuestionHistory | null {
  const sources = questionSources(tool)
  if (!sources) return null
  if (botToolResultStatus(tool, result) === "interrupted")
    return { status: "interrupted", questions: sources }
  if (result.is_error) return null
  try {
    let content = result.content
    if (Array.isArray(content)) {
      if (!content.every((part) => part?.type === "text" && typeof part.text === "string"))
        return null
      content = content.map((part) => part.text).join("")
    }
    const receipt = record(typeof content === "string" ? JSON.parse(content) : content)
    const status = receipt?.status
    if (status !== "submitted" && status !== "ignored" && status !== "auto_resolved") return null
    const answers = record(receipt?.answers)
    const questions = sources
    if (!answers) return null
    if (status === "ignored" && Object.keys(answers).length) return null
    const projected: BotQuestionHistory["questions"] = []
    for (const source of questions) {
      const answer = record(answers[source.id])
      if (!answer) {
        if (status === "submitted" || answers[source.id] !== undefined) return null
        projected.push(source)
        continue
      }
      if (answer.questionId !== source.id) return null
      let shown: Answer
      if (answer.type === "other" && text(answer.text, 100_000)) {
        shown = { text: answer.text }
      } else if (
        answer.type === "option" &&
        text(answer.label, 80) &&
        Number.isInteger(answer.optionIndex) &&
        Number(answer.optionIndex) >= 0 &&
        (answer.additionalText === undefined || typeof answer.additionalText === "string")
      ) {
        // The runtime removes free-form options before asking; original indices can shift.
        // Display the actual submitted label without reconstructing option positions.
        shown = {
          text: answer.label,
          ...(answer.additionalText ? { additionalText: answer.additionalText } : {})
        }
      } else return null
      projected.push({ ...source, answer: shown })
    }
    if (Object.keys(answers).some((id) => !questions.some((question) => question.id === id)))
      return null
    return { status, questions: projected }
  } catch {
    // Preserve the ordinary inspectable tool record for unknown or malformed receipts.
    return null
  }
}
