import { AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectAgentRunEvent } from "../../../shared/project-agent-run"
import {
  ProjectModelRequestError,
  streamProjectModel,
  type ProjectAnalysisModel
} from "./model-stream"
import { createProjectRunReporter } from "./run-progress"

const pause = vi.hoisted(() => vi.fn())
vi.mock("node:timers/promises", () => ({ setTimeout: pause }))
beforeEach(() => {
  pause.mockReset().mockResolvedValue(undefined)
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => vi.restoreAllMocks())
const httpError = (status: number, headers?: Headers) =>
  Object.assign(new Error(`HTTP ${status}`), { status, headers })
const successfulStream: ProjectAnalysisModel["stream"] = async () =>
  (async function* () {
    yield new AIMessageChunk("完整结果")
  })()
const run = (stream: typeof successfulStream, signal = new AbortController().signal) =>
  streamProjectModel({ stream }, [], signal, createProjectRunReporter(), "模型调用")

describe("isolated project model retries", () => {
  it("retries HTTP 433 over streaming only and reports each retry", async () => {
    const events: ProjectAgentRunEvent[] = []
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(httpError(433))
      .mockRejectedValueOnce(httpError(433))
    const messages = [new HumanMessage("检查全量项目")]
    const result = await streamProjectModel(
      { stream },
      messages,
      new AbortController().signal,
      createProjectRunReporter((event) => events.push(event)),
      "全量数据审阅 2/5"
    )
    expect(result.content).toBe("完整结果")
    expect(stream).toHaveBeenCalledTimes(3)
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1500, 3000])
    expect(stream.mock.calls.every(([sent]) => sent === messages)).toBe(true)
    expect(JSON.stringify(events)).toContain("自动重试 2/6")
    expect(JSON.stringify(events)).toContain("HTTP 433")
  })
  it.each([408, 429, 433, 500, 502, 503, 504])(
    "stops after six retries for HTTP %s, matching the pinned runtime budget",
    async (status) => {
      const stream = vi.fn(successfulStream).mockRejectedValue(httpError(status))
      const error = await run(stream).catch((error) => error)
      expect(error).toBeInstanceOf(ProjectModelRequestError)
      expect(error).toMatchObject({ status, retries: 6 })
      expect(stream).toHaveBeenCalledTimes(7)
      expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1500, 3000, 6000, 12000, 24000, 48000])
    }
  )
  it.each([400, 401, 403, 422])(
    "does not retry configuration/authentication errors (HTTP %s)",
    async (status) => {
      const stream = vi.fn(successfulStream).mockRejectedValue(httpError(status))
      await expect(run(stream)).rejects.toMatchObject({ status })
      expect(stream).toHaveBeenCalledTimes(1)
      expect(pause).not.toHaveBeenCalled()
    }
  )
  it("honors bounded Retry-After and can cancel during backoff", async () => {
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(httpError(433, new Headers({ "retry-after": "120" })))
    await run(stream)
    expect(pause.mock.calls[0][0]).toBe(120000)
    const controller = new AbortController()
    pause.mockImplementationOnce(async (_ms, _value, { signal }) => {
      controller.abort()
      signal.throwIfAborted()
    })
    stream.mockClear().mockRejectedValue(httpError(433))
    await expect(run(stream, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it("can recover on the sixth retry instead of exhausting the earlier three-retry budget", async () => {
    const stream = vi.fn(successfulStream)
    for (let i = 0; i < 6; i++) stream.mockRejectedValueOnce(httpError(433))
    expect((await run(stream)).content).toBe("完整结果")
    expect(stream).toHaveBeenCalledTimes(7)
    expect(pause).toHaveBeenCalledTimes(6)
  })
  it("varies backoff with jitter and caps an unreasonable gateway cooldown", async () => {
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.999)
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(httpError(433))
      .mockRejectedValueOnce(httpError(433))
      .mockRejectedValueOnce(httpError(433, new Headers({ "retry-after": "9999999" })))
    await run(stream)
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1000, 3998, 120000])
  })
  it("discards a broken partial stream and resets visible output before retry", async () => {
    const stream = vi.fn(successfulStream).mockImplementationOnce(async () =>
      (async function* () {
        yield new AIMessageChunk("未完成的旧片段")
        throw new Error("socket ECONNRESET")
      })()
    )
    const events: ProjectAgentRunEvent[] = []
    const result = await streamProjectModel(
      { stream },
      [],
      new AbortController().signal,
      createProjectRunReporter((event) => events.push(event)),
      "分析",
      true
    )
    expect(result.content).toBe("完整结果")
    expect(events.filter((event) => event.type === "text" && event.reset)).toHaveLength(2)
    expect(stream).toHaveBeenCalledTimes(2)
  })
})
