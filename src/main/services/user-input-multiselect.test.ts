import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: () => {} }
      }
    ]
  }
}))
vi.mock("../app-attention-events", () => ({ emitAppAttention: () => {} }))
import {
  requestUserInput,
  getPendingUserInputForThread,
  submitUserInputResponse,
  subscribeRemovedUserInput,
  cancelUserInputsForThread
} from "./user-input"
import type { UserInputResponse } from "../types"

const threadId = "multiselect-regression"
afterEach(() => cancelUserInputsForThread(threadId, "test cleanup"))
function open(multiSelect = true) {
  const pending = requestUserInput({
    threadId,
    questions: [
      {
        id: "choice",
        header: "Steps",
        question: "Choose steps",
        multiSelect,
        options: [
          { label: "Review", description: "Inspect code" },
          { label: "Test", description: "Run tests" }
        ]
      }
    ]
  })
  void pending.catch(() => {})
  const requestId = getPendingUserInputForThread(threadId)!.requestId
  const answer = (optionIndices: unknown, questionId = "choice", key = "choice") =>
    ({
      requestId,
      answers: {
        [key]: {
          type: "options",
          questionId,
          optionIndices,
          labels: ["untrusted label"],
          descriptions: ["untrusted description"]
        }
      }
    }) as UserInputResponse
  return { pending, requestId, answer }
}
it("invalid indices and foreign questions leave the same pending request and listeners intact", async () => {
  const f = open()
  const removed = vi.fn()
  const unsubscribe = subscribeRemovedUserInput(removed)
  try {
    for (const indices of [[], [0, 0], [2], [-1], [0.5], [null], new Array(1), "0"])
      expect(submitUserInputResponse(f.answer(indices))).toBe(false)
    expect(submitUserInputResponse(f.answer([0], "wrong"))).toBe(false)
    expect(submitUserInputResponse(f.answer([0], "wrong", "wrong"))).toBe(false)
    expect(getPendingUserInputForThread(threadId)?.requestId).toBe(f.requestId)
    expect(removed).not.toHaveBeenCalled()
    expect(submitUserInputResponse(f.answer([1, 0]))).toBe(true)
    const result = await f.pending
    expect(result.answers.choice).toEqual({
      type: "options",
      questionId: "choice",
      optionIndices: [0, 1],
      labels: ["Review", "Test"],
      descriptions: ["Inspect code", "Run tests"]
    })
    expect(removed).toHaveBeenCalledTimes(1)
    expect(getPendingUserInputForThread(threadId)).toBeNull()
  } finally {
    unsubscribe()
  }
})
it("a single-choice request refuses multi answers and still accepts its original answer", async () => {
  const f = open(false)
  expect(submitUserInputResponse(f.answer([0, 1]))).toBe(false)
  expect(getPendingUserInputForThread(threadId)?.requestId).toBe(f.requestId)
  expect(
    submitUserInputResponse({
      requestId: f.requestId,
      answers: {
        choice: {
          type: "option",
          questionId: "choice",
          optionIndex: 1,
          label: "Test",
          description: "Run tests",
          additionalText: "Keep original note"
        }
      }
    })
  ).toBe(true)
  expect((await f.pending).answers.choice).toMatchObject({
    type: "option",
    additionalText: "Keep original note"
  })
})

it("keeps Bot responses bound to the verified sender and their own multi-select format", async () => {
  const choices = [
    { label: "Review", description: "Inspect code" },
    { label: "Test", description: "Run tests" }
  ]
  const pending = requestUserInput({
    threadId,
    originalGroupSenderOnly: true,
    questions: [{ id: "choice", header: "Steps", question: "Choose steps", allowMultiple: true, options: choices }]
  })
  void pending.catch(() => {})
  const requestId = getPendingUserInputForThread(threadId)!.requestId
  const answer = {
    type: "options",
    questionId: "choice",
    options: [{ optionIndex: 1, ...choices[1] }, { optionIndex: 0, ...choices[0] }]
  } as const
  expect(submitUserInputResponse({
    requestId, answers: { choice: { ...answer, options: [...answer.options] } }
  })).toBe(false)
  expect(submitUserInputResponse({
    requestId,
    answers: { choice: { type: "options", questionId: "choice", optionIndices: [1], labels: [], descriptions: [] } }
  }, { verifiedGroupSender: true })).toBe(false)
  expect(submitUserInputResponse({
    requestId, answers: { choice: { ...answer, options: new Array(1) } }
  }, { verifiedGroupSender: true })).toBe(false)
  expect(getPendingUserInputForThread(threadId)?.requestId).toBe(requestId)
  expect(submitUserInputResponse({
    requestId, answers: { choice: { ...answer, options: [...answer.options] } }
  }, { verifiedGroupSender: true })).toBe(true)
  expect((await pending).answers.choice).toEqual(answer)
})
