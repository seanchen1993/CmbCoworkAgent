import { afterEach, describe, expect, it, vi } from "vitest"
import type { UserInputResponse } from "../types"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
import {
  requestUserInput,
  getPendingUserInputForThread,
  submitUserInputResponse,
  cancelUserInputsForThread
} from "./user-input"

const questions = [
  {
    id: "format",
    header: "格式",
    question: "选择格式",
    allowMultiple: true,
    options: [
      { label: "CSV", description: "数据" },
      { label: "JSON", description: "结构" }
    ]
  }
]
const threads: string[] = []
function pending(multiple = true, autoResolutionMs?: number) {
  const threadId = `multi-${threads.length}`
  threads.push(threadId)
  const result = requestUserInput({
    threadId,
    questions: questions.map((q) => ({ ...q, allowMultiple: multiple || undefined })),
    allowDeferredRenderer: true,
    autoResolutionMs,
    autoResolution: { type: "select_first" }
  })
  void result.catch(() => {})
  return { result, request: getPendingUserInputForThread(threadId)! }
}
const answer = {
  type: "options",
  questionId: "format",
  options: questions[0].options.map((option, optionIndex) => ({ optionIndex, ...option }))
}
afterEach(() => {
  for (const thread of threads) cancelUserInputsForThread(thread, "test cleanup")
  threads.length = 0
  vi.useRealTimers()
})

describe("Bot multiple choice on the existing pending-input lifecycle", () => {
  it("settles a real selection once, preserving both selected options", async () => {
    const { request, result } = pending()
    const response = {
      requestId: request.requestId,
      answers: { format: answer }
    } as UserInputResponse
    expect(submitUserInputResponse(response)).toBe(true)
    expect(await result).toMatchObject(response)
    expect(getPendingUserInputForThread(request.threadId)).toBeNull()
    expect(submitUserInputResponse(response)).toBe(false)
  })
  it("rejects forged and incomplete selections without consuming the pending request", () => {
    const { request } = pending()
    for (const bad of [
      null,
      { ...answer, options: [] },
      { ...answer, options: [answer.options[0], answer.options[0]] },
      { ...answer, questionId: "other" },
      { ...answer, options: [{ ...answer.options[0], optionIndex: 9 }] },
      { ...answer, options: [{ ...answer.options[0], label: "伪造" }] },
      { ...answer, options: [null] },
      { type: "option", questionId: "format", ...answer.options[0] }
    ]) {
      expect(
        submitUserInputResponse({
          requestId: request.requestId,
          answers: { format: bad }
        } as UserInputResponse)
      ).toBe(false)
      expect(getPendingUserInputForThread(request.threadId)?.requestId).toBe(request.requestId)
    }
    expect(submitUserInputResponse({ requestId: request.requestId, answers: {} })).toBe(false)
    expect(
      submitUserInputResponse({ requestId: request.requestId, ignored: true, answers: {} })
    ).toBe(true)
  })
  it("does not enable a multi answer for an ordinary single-choice request", () => {
    const { request } = pending(false)
    expect(
      submitUserInputResponse({
        requestId: request.requestId,
        answers: { format: answer }
      } as UserInputResponse)
    ).toBe(false)
    expect(
      submitUserInputResponse({
        requestId: request.requestId,
        answers: {
          format: {
            type: "option",
            questionId: "format",
            ...answer.options[0]
          }
        }
      })
    ).toBe(true)
  })
  it("keeps automatic choice distinct from manual multi submission", async () => {
    vi.useFakeTimers()
    const { result } = pending(true, 30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await result).toMatchObject({
      autoResolved: true,
      answers: {
        format: {
          type: "options",
          options: [answer.options[0]]
        }
      }
    })
  })
})
