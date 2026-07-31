import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  window: {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: vi.fn()
    }
  }
}))

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [state.window]
  }
}))

vi.mock("../app-attention-events", () => ({
  emitAppAttention: vi.fn()
}))

import {
  acknowledgeUserInputRequest,
  buildAutoResolvedUserInputResponse,
  cancelUserInputsForThread,
  DEFAULT_USER_INPUT_AUTO_RESOLUTION_MS,
  requestUserInput
} from "./user-input"

function question() {
  return {
    id: "design_type",
    header: "方案类型",
    question: "选择方案设计类型。",
    options: [
      { label: "流程图 (Recommended)", description: "按业务流程展示方案。" },
      { label: "用户故事地图", description: "按用户旅程组织需求。" }
    ]
  }
}

function requestedPayload() {
  const call = state.window.webContents.send.mock.calls.find(
    ([channel]) => typeof channel === "string" && channel.startsWith("userInput:request:")
  )
  return call?.[1] as { requestId: string; autoResolutionMs?: number }
}

afterEach(() => {
  state.window.webContents.send.mockClear()
  vi.useRealTimers()
})

describe("buildAutoResolvedUserInputResponse", () => {
  it("submits the explicitly marked recommended option for each question", () => {
    const response = buildAutoResolvedUserInputResponse({
      requestId: "request-1",
      questions: [
        {
          id: "design_type",
          header: "方案类型",
          question: "选择方案设计类型。",
          options: [
            { label: "用户故事地图", description: "按用户旅程组织需求。" },
            { label: "流程图 (Recommended)", description: "按业务流程展示方案。" }
          ]
        },
        {
          id: "scope",
          header: "范围",
          question: "选择范围。",
          options: [
            { label: "核心范围（推荐）", description: "优先交付核心流程。" },
            { label: "完整范围", description: "覆盖全部功能。" }
          ]
        }
      ]
    })

    expect(response.autoResolved).toBe(true)
    expect(response.answers).toEqual({
      design_type: {
        type: "option",
        questionId: "design_type",
        optionIndex: 1,
        label: "流程图 (Recommended)",
        description: "按业务流程展示方案。"
      },
      scope: {
        type: "option",
        questionId: "scope",
        optionIndex: 0,
        label: "核心范围（推荐）",
        description: "优先交付核心流程。"
      }
    })
    expect(response.submittedAt).toEqual(expect.any(String))
  })

  it("falls back to the first option when no option is explicitly marked", () => {
    const response = buildAutoResolvedUserInputResponse({
      requestId: "request-2",
      questions: [
        {
          id: "detail",
          header: "详细程度",
          question: "选择详细程度。",
          options: [
            { label: "标准", description: "提供必要细节。" },
            { label: "详细", description: "提供完整细节。" }
          ]
        }
      ]
    })

    expect(response.answers.detail).toMatchObject({
      type: "option",
      optionIndex: 0,
      label: "标准"
    })
  })

  it("automatically submits recommended answers after the default five minute timeout", async () => {
    vi.useFakeTimers()
    const responsePromise = requestUserInput({
      threadId: "default-timeout",
      questions: [question()],
      autoMode: true
    })
    const request = requestedPayload()
    expect(request.autoResolutionMs).toBe(DEFAULT_USER_INPUT_AUTO_RESOLUTION_MS)
    expect(acknowledgeUserInputRequest(request.requestId, "default-timeout")).toBe(true)

    await vi.advanceTimersByTimeAsync(DEFAULT_USER_INPUT_AUTO_RESOLUTION_MS)

    await expect(responsePromise).resolves.toMatchObject({
      autoResolved: true,
      answers: {
        design_type: {
          type: "option",
          optionIndex: 0,
          label: "流程图 (Recommended)"
        }
      }
    })
  })

  it("waits indefinitely when automatic resolution is explicitly disabled", async () => {
    vi.useFakeTimers()
    const responsePromise = requestUserInput({
      threadId: "manual-timeout",
      questions: [question()],
      autoResolutionMs: null
    })
    const request = requestedPayload()
    expect(request.autoResolutionMs).toBeUndefined()
    expect(acknowledgeUserInputRequest(request.requestId, "manual-timeout")).toBe(true)

    let settled = false
    void responsePromise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(DEFAULT_USER_INPUT_AUTO_RESOLUTION_MS)
    expect(settled).toBe(false)

    expect(cancelUserInputsForThread("manual-timeout", "test cleanup")).toBe(1)
    await expect(responsePromise).rejects.toThrow("test cleanup")
  })

  it("waits indefinitely by default outside Auto Mode", async () => {
    vi.useFakeTimers()
    const responsePromise = requestUserInput({
      threadId: "normal-default-timeout",
      questions: [question()]
    })
    const request = requestedPayload()
    expect(request.autoResolutionMs).toBeUndefined()
    expect(acknowledgeUserInputRequest(request.requestId, "normal-default-timeout")).toBe(true)

    let settled = false
    void responsePromise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(DEFAULT_USER_INPUT_AUTO_RESOLUTION_MS)
    expect(settled).toBe(false)

    expect(cancelUserInputsForThread("normal-default-timeout", "test cleanup")).toBe(1)
    await expect(responsePromise).rejects.toThrow("test cleanup")
  })
})
