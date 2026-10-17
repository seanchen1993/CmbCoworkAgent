import { AIMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware
} from "./current-run-message-queue"

afterEach(() => clearCurrentRunMessageQueue("model-state"))

describe("optional primary model activity", () => {
  it("bounds activity to the pending model promise and keeps the original response", async () => {
    const states: boolean[] = []
    const middleware = createCurrentRunMessageQueueMiddleware("round", (active) =>
      states.push(active)
    )
    const wrap = middleware.wrapModelCall!
    const request = { runtime: { configurable: { thread_id: "model-state" } } } as Parameters<
      typeof wrap
    >[0]
    let finish!: (response: AIMessage) => void
    const response = new AIMessage("Actual reply")
    const pending = wrap(
      request,
      () =>
        new Promise<AIMessage>((resolve) => {
          finish = resolve
        })
    )
    expect(states).toEqual([true])
    finish(response)
    expect(await pending).toBe(response)
    expect(states).toEqual([true, false])
  })
  it("ends activity on failure without replacing or swallowing the original error", async () => {
    const changed = vi.fn()
    const wrap = createCurrentRunMessageQueueMiddleware("round", changed).wrapModelCall!
    const request = { runtime: { configurable: { thread_id: "model-state" } } } as Parameters<
      typeof wrap
    >[0]
    const error = new DOMException("Cancelled by the owning round", "AbortError")
    await expect(
      wrap(request, async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(changed.mock.calls).toEqual([[true], [false]])
  })
  it("preserves the ordinary handler path when no observer is configured", async () => {
    const wrap = createCurrentRunMessageQueueMiddleware("round").wrapModelCall!
    const request = { runtime: { configurable: { thread_id: "model-state" } } } as Parameters<
      typeof wrap
    >[0]
    const response = new AIMessage("Unchanged ordinary reply")
    const handler = vi.fn(async () => response)
    expect(await wrap(request, handler)).toBe(response)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(request)
  })
})
