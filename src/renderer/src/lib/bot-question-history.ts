import type { ToolCall, ToolResult } from "@/types"

type Answer = { text: string; additionalText?: string }
export interface BotQuestionHistory {
  status: "submitted" | "ignored" | "auto_resolved"
  questions: Array<{ id: string; question: string; answer?: Answer }>
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= max

/** Read-only receipt projection. A default option or timer is never a user answer. */
export function botQuestionHistory(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): BotQuestionHistory | null {
  if (tool.name !== "request_user_input" || result.is_error) return null
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
    const questions = tool.args.questions
    if (!answers || !Array.isArray(questions) || !questions.length || questions.length > 10)
      return null
    if (status === "ignored" && Object.keys(answers).length) return null
    const ids = new Set<string>()
    const projected: BotQuestionHistory["questions"] = []
    for (const value of questions) {
      const question = record(value)
      if (
        !question ||
        !text(question.id, 80) ||
        ids.has(question.id) ||
        !text(question.question, 500)
      )
        return null
      ids.add(question.id)
      const source = { id: question.id, question: question.question }
      const answer = record(answers[question.id])
      if (!answer) {
        if (status === "submitted" || answers[question.id] !== undefined) return null
        projected.push(source)
        continue
      }
      if (answer.questionId !== question.id) return null
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
    if (Object.keys(answers).some((id) => !ids.has(id))) return null
    return { status, questions: projected }
  } catch {
    // Preserve the ordinary inspectable tool record for unknown or malformed receipts.
    return null
  }
}
