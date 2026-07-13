import type { BrowserWindow } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import { retryStreamAfterDisconnect } from "./agent"

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
})
