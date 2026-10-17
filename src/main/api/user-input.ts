import { formatGmt8Timestamp } from "../../shared/gmt8-time"
import type { UserInputAnswer } from "../types"
import { getPendingUserInputForThread, submitUserInputResponse } from "../services/user-input"
import { ApiInputError, requireObject } from "./project-bridge"

function allowedKeys(value: Record<string, unknown>, keys: string[]): void {
  const unknownKey = Object.keys(value).find((key) => !keys.includes(key))
  if (unknownKey) {
    throw new ApiInputError(400, "invalid_request", `不支持字段 ${unknownKey}`)
  }
}

function invalidAnswer(message: string): never {
  throw new ApiInputError(422, "invalid_user_input_answer", message)
}

function requestNotFound(): never {
  throw new ApiInputError(404, "user_input_not_found", "指定会话下没有这个有效的待回答请求")
}

/** Validate the complete answer set before consuming the existing one-shot request. */
export function apiSubmitUserInputResponse(threadId: string, requestId: string, value: unknown) {
  const body = requireObject(value)
  allowedKeys(body, ["answers"])
  const inputAnswers = requireObject(body.answers)
  const request = getPendingUserInputForThread(threadId)
  if (!request || request.requestId !== requestId) requestNotFound()

  const questionIds = new Set(request.questions.map((question) => question.id))
  if (
    Object.keys(inputAnswers).length !== questionIds.size ||
    Object.keys(inputAnswers).some((id) => !questionIds.has(id))
  ) {
    invalidAnswer("必须提交本次所有问题的答案，且不能包含未知问题")
  }

  const answers: Record<string, UserInputAnswer> = {}
  for (const question of request.questions) {
    if (!Object.hasOwn(inputAnswers, question.id)) invalidAnswer(`缺少问题 ${question.id} 的答案`)
    const answer = requireObject(inputAnswers[question.id])
    if (answer.type === "option") {
      allowedKeys(answer, ["type", "optionIndex", "additionalText"])
      if (typeof answer.optionIndex !== "number") {
        throw new ApiInputError(400, "invalid_request", "optionIndex 必须是整数")
      }
      const option = question.options[answer.optionIndex]
      if (!Number.isInteger(answer.optionIndex) || !option) {
        invalidAnswer(`问题 ${question.id} 的选项下标无效`)
      }
      if (Object.hasOwn(answer, "additionalText") && typeof answer.additionalText !== "string") {
        throw new ApiInputError(400, "invalid_request", "additionalText 必须是字符串")
      }
      answers[question.id] = {
        type: "option",
        questionId: question.id,
        optionIndex: answer.optionIndex,
        label: option.label,
        description: option.description,
        ...(typeof answer.additionalText === "string"
          ? { additionalText: answer.additionalText }
          : {})
      }
    } else if (answer.type === "other") {
      allowedKeys(answer, ["type", "text"])
      if (typeof answer.text !== "string") {
        throw new ApiInputError(400, "invalid_request", "text 必须是字符串")
      }
      if (!answer.text.trim()) invalidAnswer(`问题 ${question.id} 的自由文本不能为空`)
      answers[question.id] = { type: "other", questionId: question.id, text: answer.text }
    } else {
      throw new ApiInputError(400, "invalid_request", "type 必须是 option 或 other")
    }
  }

  const response = { requestId, submittedAt: formatGmt8Timestamp(), answers }
  if (!submitUserInputResponse(response, { notifyRenderer: true })) requestNotFound()
  return { status: "submitted" as const, ...response }
}
