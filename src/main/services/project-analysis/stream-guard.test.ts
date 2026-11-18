import { AIMessageChunk } from "@langchain/core/messages"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { streamProjectModel, type ProjectAnalysisModel } from "./model-stream"
import { PROJECT_STREAM_IDLE_MS } from "./stream-guard"
import { createProjectRunReporter } from "./run-progress"

vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const complete: ProjectAnalysisModel["stream"] = async () =>
  (async function* () {
    yield new AIMessageChunk({ content: "完整结果", response_metadata: { finish_reason: "stop" } })
  })()
const run = (model: ProjectAnalysisModel, signal = new AbortController().signal) =>
  streamProjectModel(model, [], signal, createProjectRunReporter(), "生成报告")

describe("project stream inactivity and cancellation", () => {
  it.each(["connect", "read"])(
    "recovers a stalled %s with a fresh attempt signal",
    async (phase) => {
      let failedSignal!: AbortSignal
      let rejectLate!: (error: Error) => void
      const stalled = new Promise<never>((_resolve, reject) => {
        rejectLate = reject
      })
      const close = vi.fn(async () => ({ value: undefined, done: true as const }))
      const stream = vi.fn(complete).mockImplementationOnce(async (_messages, { signal }) => {
        failedSignal = signal
        if (phase === "connect") return stalled
        return { [Symbol.asyncIterator]: () => ({ next: () => stalled, return: close }) }
      })
      const parent = new AbortController()
      const result = run({ stream }, parent.signal)
      await vi.advanceTimersByTimeAsync(PROJECT_STREAM_IDLE_MS)
      expect((await result).content).toBe("完整结果")
      expect(stream).toHaveBeenCalledTimes(2)
      expect(failedSignal.aborted).toBe(true)
      expect(parent.signal.aborted).toBe(false)
      expect(stream.mock.calls[1][1].signal.aborted).toBe(false)
      if (phase === "read") expect(close).toHaveBeenCalledTimes(1)
      rejectLate(new Error("late socket failure"))
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(["connect", "read"])(
    "stops a stalled %s immediately even when the SDK ignores abort",
    async (phase) => {
      const stalled = new Promise<never>(() => undefined)
      const stream = vi.fn(async () =>
        phase === "connect" ? stalled : { [Symbol.asyncIterator]: () => ({ next: () => stalled }) }
      )
      const parent = new AbortController()
      const result = run({ stream }, parent.signal)
      const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" })
      await vi.advanceTimersByTimeAsync(0)
      parent.abort()
      await rejection
      expect(stream).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it("allows more than an hour of active streaming, including reasoning and tool-free fragments", async () => {
    const stream = vi.fn(async () =>
      (async function* () {
        for (let i = 0; i < 50; i++) {
          await new Promise((resolve) => setTimeout(resolve, PROJECT_STREAM_IDLE_MS / 2))
          yield new AIMessageChunk(
            i < 49
              ? {
                  content: "",
                  additional_kwargs: { reasoning: "hidden reasoning" }
                }
              : { content: "完整结果", response_metadata: { finish_reason: "stop" } }
          )
        }
      })()
    )
    const result = run({ stream })
    await vi.advanceTimersByTimeAsync((50 * PROJECT_STREAM_IDLE_MS) / 2)
    expect((await result).content).toBe("完整结果")
    expect(stream).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
