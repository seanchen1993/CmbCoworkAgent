import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ windows: [] as unknown[], send: vi.fn() }))
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))

import { registerAgentStreamSink } from "../agent/agent-stream-sinks"
import {
  getPendingUserInputForThread,
  requestUserInput,
  submitUserInputResponse,
  cancelUserInputsForThread
} from "./user-input"

const questions = [
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
        questions,
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
    await expect(requestUserInput({ threadId: "thread-a", questions })).rejects.toMatchObject({
      code: "no_renderer_window"
    })
    mocks.windows = [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } }
    ]
    const pending = requestUserInput({ threadId: "thread-a", questions })
    const rejected = expect(pending).rejects.toMatchObject({ code: "request_not_acknowledged" })
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(getPendingUserInputForThread("thread-a")).toBeNull()
  })

  it("retains automatic resolution and rejects late answers", async () => {
    unsubscribe = registerAgentStreamSink("thread-a", () => {})
    const pending = requestUserInput({
      threadId: "thread-a",
      questions,
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
