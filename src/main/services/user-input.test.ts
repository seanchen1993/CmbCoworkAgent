import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UserInputResponse } from "../types"

const mocks = vi.hoisted(() => ({ windows: [] as unknown[], send: vi.fn() }))
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
import { registerAgentStreamSink } from "../agent/agent-stream-sinks"
import {
  requestUserInput,
  summarizePendingUserInputForRuntimeThread,
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
  it("reports live parent/child questions, bounds descriptions and clears answered/cancelled requests", async () => {
    const root = "work-status"
    for (const id of [root, `${root}__child`, `${root}-sibling`]) {
      threads.push(id)
      void requestUserInput({ threadId: id, questions, allowDeferredRenderer: true }).catch(() => {})
    }
    expect(summarizePendingUserInputForRuntimeThread(root)).toEqual({ count: 2, questions: ["选择格式", "选择格式"] })
    const request = getPendingUserInputForThread(root)!
    expect(submitUserInputResponse({ requestId: request.requestId, answers: { format: answer } } as UserInputResponse)).toBe(true)
    expect(summarizePendingUserInputForRuntimeThread(root).count).toBe(1)
    cancelUserInputsForThread(`${root}__child`, "stopped")
    expect(summarizePendingUserInputForRuntimeThread(root)).toEqual({ count: 0, questions: [] })
    expect(summarizePendingUserInputForRuntimeThread(`${root}-sibling`).count).toBe(1)
    for (let i = 0; i < 6; i++) {
      const id = `${root}__${i}`
      threads.push(id)
      void requestUserInput({ threadId: id, questions: [{ ...questions[0], question: "a".repeat(1000) }], allowDeferredRenderer: true }).catch(() => {})
    }
    const summary = summarizePendingUserInputForRuntimeThread(root)
    expect(summary.count).toBe(6)
    expect(summary.questions).toHaveLength(3)
    expect(summary.questions.every(q => q.length === 500)).toBe(true)
  })
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

const httpQuestions = [
  {
    id: "confirm",
    header: "确认",
    question: "是否继续？",
    options: [{ label: "继续", description: "执行任务" }]
  }
]

describe("user input delivery lifetime", () => {
  let unsubscribe = () => {}

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.windows = []
    mocks.send.mockClear()
  })

  afterEach(() => {
    unsubscribe()
    mocks.windows = []
    cancelUserInputsForThread("thread-a", "Test cleanup")
    vi.useRealTimers()
  })

  it.each([false, true])(
    "keeps an HTTP question pending without desktop acknowledgement (window: %s)",
    async (withWindow) => {
      if (withWindow) {
        mocks.windows = [
          { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } }
        ]
      }
      unsubscribe = registerAgentStreamSink("thread-a", () => {})
      const result = requestUserInput({
        threadId: "thread-a",
        questions: httpQuestions,
        allowDeferredRenderer: false
      })
      await vi.advanceTimersByTimeAsync(6_000)
      const requestId = getPendingUserInputForThread("thread-a")!.requestId
      submitUserInputResponse({ requestId, answers: {} })
      expect((await result).requestId).toBe(requestId)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it("preserves desktop fail-fast behaviour without an HTTP sink", async () => {
    await expect(requestUserInput({ threadId: "thread-a", questions: httpQuestions })).rejects.toMatchObject({
      code: "no_renderer_window"
    })
    mocks.windows = [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } }
    ]
    const pending = requestUserInput({ threadId: "thread-a", questions: httpQuestions })
    const rejected = expect(pending).rejects.toMatchObject({ code: "request_not_acknowledged" })
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(getPendingUserInputForThread("thread-a")).toBeNull()
  })

  it("retains automatic resolution and rejects late answers", async () => {
    unsubscribe = registerAgentStreamSink("thread-a", () => {})
    const pending = requestUserInput({
      threadId: "thread-a",
      questions: httpQuestions,
      autoResolutionMs: 30_000,
      autoResolution: { type: "select_first" }
    })
    const requestId = getPendingUserInputForThread("thread-a")!.requestId
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({
      autoResolved: true,
      answers: { confirm: { type: "option", optionIndex: 0 } }
    })
    expect(submitUserInputResponse({ requestId, answers: {} })).toBe(false)
  })
})
