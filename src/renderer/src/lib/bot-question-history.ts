import type { Message, ToolCall, ToolResult, UserInputRequest } from "@/types"
import type { BotMessageOrigin, BotGroupMessage } from "../../../shared/bots/contracts"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { botToolResultStatus } from "./bot-tool-result-status"
import { isFreeformUserInputOption } from "../../../shared/user-input-options"

type Answer = { text: string; additionalText?: string; optionIndex?: number }
type QuestionOptions = UserInputRequest["questions"][number]["options"]
export interface BotQuestionHistory {
  status: "submitted" | "ignored" | "auto_resolved" | "cancelled" | "interrupted"
  submittedAt?: number
  questions: Array<{ id: string; question: string; options?: QuestionOptions; answer?: Answer }>
}

/** Display receipts after the last loaded message preceding the actual answer.
 * Keep real message ordinals and Virtuoso rows intact, even with interleaved questions.
 */
export function botGroupQuestionReplies(messages: readonly BotGroupMessage[]) {
  const replies = messages.flatMap((source, sourceIndex) => {
    const history = source.question && botGroupQuestionHistory(source.question)
    return history?.status === "submitted" && history.submittedAt !== undefined
      ? [{ source, sourceIndex, history, createdAt: history.submittedAt }]
      : []
  })
  const byAnchor = new Map<string, typeof replies>()
  if (!replies.length) return byAnchor
  const timed = messages
    .map((message, index) => ({ time: message.createdAt, index }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
  replies.sort((a, b) => a.createdAt - b.createdAt || a.sourceIndex - b.sourceIndex)
  let cursor = 0,
    anchor = -1
  for (const reply of replies) {
    while (cursor < timed.length && timed[cursor].time <= reply.createdAt) {
      anchor = Math.max(anchor, timed[cursor++].index)
    }
    const id = messages[Math.max(anchor, reply.sourceIndex)].id
    const previous = byAnchor.get(id)
    if (previous) previous.push(reply)
    else byAnchor.set(id, [reply])
  }
  return byAnchor
}

export function botGroupQuestionHistory(
  question: NonNullable<BotGroupMessage["question"]>
): BotQuestionHistory | null {
  if (question.result)
    return botQuestionHistory(
      {
        id: question.request.requestId,
        name: "request_user_input",
        args: { questions: question.request.questions }
      },
      question.result
    )
  return question.state === "cancelled" || question.state === "interrupted"
    ? { status: question.state, questions: question.request.questions }
    : null
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= max

function historyOptions(value: unknown): QuestionOptions | undefined {
  if (!Array.isArray(value) || value.length > 6) return undefined
  const options: QuestionOptions = []
  for (const item of value) {
    const option = record(item)
    if (
      !option ||
      !text(option.label, 80) ||
      (option.description !== undefined &&
        (typeof option.description !== "string" || option.description.length > 240))
    )
      return undefined
    if (!isFreeformUserInputOption(option.label))
      options.push({
        label: option.label,
        description: (option.description as string | undefined) ?? ""
      })
  }
  return options
}

function questionSources(
  tool: ToolCall,
  showOptions = false
): BotQuestionHistory["questions"] | null {
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
    const options = showOptions ? historyOptions(question.options) : undefined
    questions.push({
      id: question.id,
      question: question.question,
      ...(options ? { options } : {})
    })
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

/** Child or ambiguous calls keep their direct answer form instead of using the main inbox. */
export function isMainBotQuestionCall(
  messages: readonly Message[],
  callId: string | null
): boolean {
  if (!callId) return false
  let matched = false
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const call of message.tool_calls ?? []) {
      if (call.id !== callId) continue
      if (matched || message.subagent_tool_call_id) return false
      matched = true
    }
  }
  return matched
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
    const questions = status === "ignored" ? (questionSources(tool, true) ?? sources) : sources
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
      } else if (answer.type === "options") {
        const rawQuestion = (tool.args?.questions as Record<string, unknown>[]).find(
          (q) => q.id === source.id
        )
        const options = historyOptions(rawQuestion?.options)
        if (
          rawQuestion?.allowMultiple !== true ||
          !options ||
          !Array.isArray(answer.options) ||
          !answer.options.length ||
          answer.options.length > options.length
        )
          return null
        const selected = answer.options.map(record)
        if (
          selected.some(
            (option) =>
              !option ||
              !Number.isInteger(option.optionIndex) ||
              options[Number(option.optionIndex)]?.label !== option.label ||
              options[Number(option.optionIndex)]?.description !== option.description
          ) ||
          new Set(selected.map((option) => option?.optionIndex)).size !== selected.length
        )
          return null
        shown = { text: selected.map((option) => option!.label).join("、") }
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
          ...(historyOptions(
            (tool.args?.questions as Record<string, unknown>[]).find((q) => q.id === source.id)
              ?.options
          )?.[Number(answer.optionIndex)]?.label === answer.label
            ? { optionIndex: Number(answer.optionIndex) }
            : {}),
          ...(answer.additionalText ? { additionalText: answer.additionalText } : {})
        }
      } else return null
      projected.push({ ...source, answer: shown })
    }
    if (Object.keys(answers).some((id) => !questions.some((question) => question.id === id)))
      return null
    const submittedAt =
      typeof receipt?.submittedAt === "string" ? Date.parse(receipt.submittedAt) : NaN
    return {
      status,
      questions: projected,
      ...(status === "submitted" && Number.isFinite(submittedAt) ? { submittedAt } : {})
    }
  } catch {
    // Preserve the ordinary inspectable tool record for unknown or malformed receipts.
    return null
  }
}
