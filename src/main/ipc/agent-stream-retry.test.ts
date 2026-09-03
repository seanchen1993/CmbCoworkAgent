import type { BrowserWindow } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import { retryStreamAfterDisconnect } from "./agent"
import { isRetryableApiError } from "../agent/failover"

function fakeWindow(sent: unknown[]): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => sent.push(payload)
    }
  } as unknown as BrowserWindow
}

describe("retryStreamAfterDisconnect", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("retries the current model twice before returning its resumed stream", async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let resumeCalls = 0
    const resumedStream = async function* (): AsyncIterable<string> {
      yield "completed"
    }

    const resultPromise = retryStreamAfterDisconnect(
      new TypeError("terminated"),
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        if (resumeCalls === 1) throw new TypeError("terminated")
        return resumedStream()
      }
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise
    const chunks: string[] = []
    for await (const chunk of result.stream ?? []) chunks.push(chunk)

    expect(resumeCalls).toBe(2)
    expect(result.retries).toBe(2)
    expect(chunks).toEqual(["completed"])
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          data: expect.objectContaining({ type: "model_retry", attempt: 1 })
        }),
        expect.objectContaining({
          type: "custom",
          data: expect.objectContaining({ type: "model_retry", attempt: 2 })
        }),
        expect.objectContaining({
          type: "custom",
          data: { type: "model_retry_clear" }
        })
      ])
    )
  })

  it("resumes from the checkpoint when the model returned an empty response", async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let resumeCalls = 0
    const resumedStream = async function* (): AsyncIterable<string> {
      yield "completed"
    }

    const resultPromise = retryStreamAfterDisconnect(
      new Error("Received empty response from chat model call."),
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        return resumedStream()
      }
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise
    const chunks: string[] = []
    for await (const chunk of result.stream ?? []) chunks.push(chunk)

    // One resume, not a replay of the user's turn.
    expect(resumeCalls).toBe(1)
    expect(chunks).toEqual(["completed"])
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          data: expect.objectContaining({
            type: "model_retry",
            attempt: 1,
            reason: "模型返回空响应，正在重试当前模型"
          })
        })
      ])
    )
  })

  it("gives up after the retry budget so the caller can fail over to another model", async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let resumeCalls = 0
    const empty = new Error("Received empty response from chat model call.")

    const resultPromise = retryStreamAfterDisconnect(
      empty,
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        throw empty
      }
    )

    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(resumeCalls).toBe(2)
    expect(result.retries).toBe(2)
    expect(result.stream).toBeUndefined()
    // The error is handed back rather than thrown, which is what lets the
    // caller's `isRetryableApiError(error)` branch switch models.
    expect(result.error).toBe(empty)
    expect(isRetryableApiError(result.error)).toBe(true)
  })

  it("does not retry a cancelled turn", async () => {
    const sent: unknown[] = []
    let resumeCalls = 0
    const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" })

    const result = await retryStreamAfterDisconnect(
      cancelled,
      0,
      fakeWindow(sent),
      "agent:test",
      new AbortController().signal,
      "Mid-stream",
      "pinned-model",
      async () => {
        resumeCalls += 1
        throw cancelled
      }
    )

    expect(resumeCalls).toBe(0)
    expect(result.retries).toBe(0)
    expect(sent).toEqual([])
  })
})
