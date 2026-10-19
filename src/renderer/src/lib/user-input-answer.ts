import type { UserInputAnswer, UserInputRequest } from "@/types"

export type UserInputDraftAnswer =
  | {
      type: "option"
      optionIndex: number
      additionalText?: string
      additionalTextOpen?: boolean
    }
  | { type: "other"; text: string }

/** Shared by both presentations; only complete, explicitly supplied answers are submitted. */
export function userInputAnswers(
  questions: UserInputRequest["questions"],
  drafts: Readonly<Record<string, UserInputDraftAnswer>>,
  trimCustom = false
): Record<string, UserInputAnswer> | null {
  const answers: Record<string, UserInputAnswer> = {}
  for (const question of questions) {
    const draft = drafts[question.id]
    if (!draft) return null
    if (draft.type === "other") {
      const text = trimCustom ? draft.text.trim() : draft.text
      if (!text.length) return null
      answers[question.id] = { type: "other", questionId: question.id, text }
      continue
    }
    const option = question.options[draft.optionIndex]
    if (!option) return null
    const additionalText = draft.additionalText?.trim()
    answers[question.id] = {
      type: "option",
      questionId: question.id,
      optionIndex: draft.optionIndex,
      label: option.label,
      description: option.description,
      ...(additionalText ? { additionalText } : {})
    }
  }
  return answers
}
