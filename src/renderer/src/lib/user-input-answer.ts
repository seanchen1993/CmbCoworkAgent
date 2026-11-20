import type { UserInputAnswer, UserInputRequest } from "@/types"

export type UserInputDraftAnswer =
  | { type: "options"; optionIndices: number[] }
  | {
      type: "option"
      optionIndex: number
      additionalText?: string
      additionalTextOpen?: boolean
    }
  | { type: "other"; text: string }

/** Ephemeral answers belong to the pending inbox, not a virtualized card. */
export interface UserInputDraft {
  requestId: string
  answers: Record<string, UserInputDraftAnswer>
  activeIndex: number
}

export function emptyUserInputDraft(requestId: string): UserInputDraft {
  return { requestId, answers: {}, activeIndex: 0 }
}

export function pendingUserInputPatch(
  state: { userInputDraft?: UserInputDraft | null },
  request: UserInputRequest | null
) {
  return {
    pendingUserInput: request,
    userInputDraft:
      request && state.userInputDraft?.requestId === request.requestId ? state.userInputDraft : null
  }
}

export function userInputDraftPatch(
  state: { pendingUserInput: UserInputRequest | null; userInputDraft?: UserInputDraft | null },
  requestId: string,
  update: (draft: UserInputDraft) => UserInputDraft
): { userInputDraft?: UserInputDraft } {
  if (state.pendingUserInput?.requestId !== requestId) return {}
  const draft = state.userInputDraft
  return {
    userInputDraft: {
      ...update(draft?.requestId === requestId ? draft : emptyUserInputDraft(requestId)),
      requestId
    }
  }
}

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
    if (draft.type === "options") {
      if (
        !question.allowMultiple ||
        !draft.optionIndices.length ||
        new Set(draft.optionIndices).size !== draft.optionIndices.length ||
        draft.optionIndices.some((index) => !Number.isInteger(index) || !question.options[index])
      )
        return null
      answers[question.id] = {
        type: "options",
        questionId: question.id,
        options: [...draft.optionIndices]
          .sort((a, b) => a - b)
          .map((optionIndex) => ({
            optionIndex,
            ...question.options[optionIndex]
          }))
      }
      continue
    }
    if (question.allowMultiple) return null
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
